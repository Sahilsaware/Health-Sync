import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isAllowedVillageCode,
  type IncentiveEntry,
  type PatientConsentMetadata,
  type TriageRecord,
} from '../types/triage.ts';
import {
  assertServerlessPersistenceSafety,
  isRemoteDurableStoreConfigured,
  isServerlessRuntime,
  TursoDurableReplicator,
} from './durableRemoteStore.ts';

export type ServerUserRole = 'ASHA' | 'DMO';

export interface AuthenticatedUser {
  id: string;
  identifier: string;
  role: ServerUserRole;
  displayName: string;
  villageCode: string;
  isVerified: boolean;
}

export interface SmsDispatchLog {
  id: string;
  recordId: string | null;
  toPhone: string;
  provider: string;
  status: string;
  providerMessageId: string | null;
  payloadText: string;
  errorMessage: string | null;
  createdAtMs: number;
}

export interface AuditLogEntry {
  seq: number;
  id: string;
  timestampMs: number;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  ipHash: string;
  metadata: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

export interface SecurityBreachReport {
  id: string;
  reportedBy: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  incidentType: string;
  affectedRecordsEstimate: number;
  description: string;
  containmentActions: string;
  dpbNotified: boolean;
  affectedPrincipalsNotified: boolean;
  status: 'open' | 'investigating' | 'notified_dpb' | 'resolved';
  createdAtMs: number;
}

export class VaultConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultConfigurationError';
  }
}

const WEAK_COMMON_SECRETS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  '00000000',
  '11111111',
  'password',
  'password1',
  'password123',
  'qwertyui',
  'qwerty123',
  'asha1234',
  'admin123',
  'welcome1',
  'healthsync',
  'swasthyasetu',
]);

export function validateStrongPasscode(secret: string, identifier?: string): void {
  if (typeof secret !== 'string' || secret.length < 8) {
    throw new Error('Security passcode must be at least 8 characters long.');
  }
  if (secret.length > 128) {
    throw new Error('Security passcode must not exceed 128 characters.');
  }
  const lower = secret.toLowerCase();
  if (WEAK_COMMON_SECRETS.has(lower) || /^(.)\1{5,}$/.test(secret)) {
    throw new Error(
      'Passcode is too predictable. Choose a non-sequential combination of letters and numbers.'
    );
  }
  if (identifier && identifier.trim().length >= 4) {
    const cleanId = identifier.trim().toLowerCase();
    if (lower.includes(cleanId)) {
      throw new Error('Security passcode must not contain your account ID or email.');
    }
  }
  const hasLetter = /[a-zA-Z]/.test(secret);
  const hasDigit = /\d/.test(secret);
  const hasSymbol = /[^a-zA-Z0-9\s]/.test(secret);
  const categories = Number(hasLetter) + Number(hasDigit) + Number(hasSymbol);
  if (categories < 2 && secret.length < 12) {
    throw new Error(
      'Security passcode must include both letters and numbers (or be a 12+ character passphrase).'
    );
  }
}

export function validateRegistrationFields(params: {
  identifier: string;
  role: ServerUserRole;
  displayName: string;
  villageCode: string;
}): {normalizedId: string; cleanName: string; cleanVillage: string} {
  const rawId = String(params.identifier || '').trim();
  if (!rawId) {
    throw new Error('Account identifier is required.');
  }

  let normalizedId: string;
  if (params.role === 'ASHA') {
    normalizedId = rawId.toUpperCase();
    if (!/^ASHA-[A-Z0-9-]{3,28}$/.test(normalizedId)) {
      throw new Error(
        'Invalid Health Worker ID format. Expected format like ASHA-8842-UP (letters, digits, hyphens).'
      );
    }
  } else if (params.role === 'DMO') {
    normalizedId = rawId.toLowerCase();
    if (
      normalizedId.length > 120 ||
      !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedId)
    ) {
      throw new Error('Invalid official Medical Officer email address.');
    }
  } else {
    throw new Error('Role must be ASHA or DMO.');
  }

  const cleanName = String(params.displayName || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanName.length < 2 || cleanName.length > 80) {
    throw new Error('Full display name is required (2 to 80 characters).');
  }
  if (!/^[\p{L}\p{M}\s.'-]+$/u.test(cleanName)) {
    throw new Error(
      'Display name may only contain letters, spaces, periods, apostrophes, and hyphens.'
    );
  }

  const rawVillage = String(params.villageCode || '').trim().toUpperCase();
  let cleanVillage: string;
  if (params.role === 'DMO') {
    cleanVillage = rawVillage || 'DISTRICT-24';
    if (cleanVillage !== 'DISTRICT-24' && !isAllowedVillageCode(cleanVillage)) {
      throw new Error('Invalid district or clinic code for Medical Officer.');
    }
  } else {
    cleanVillage = rawVillage;
    if (!cleanVillage || !isAllowedVillageCode(cleanVillage)) {
      throw new Error('Invalid or unrecognized clinic villageCode.');
    }
  }

  return {normalizedId, cleanName, cleanVillage};
}

function resolveWritableDbPath(requestedPath: string): string {
  if (requestedPath === ':memory:') {
    return ':memory:';
  }
  assertServerlessPersistenceSafety(requestedPath);

  if (isServerlessRuntime()) {
    // Only reached when durable remote store (TURSO_DATABASE_URL) or explicit CI override is active
    const cacheDir = path.join(os.tmpdir(), 'healthsync-durable-cache');
    fs.mkdirSync(cacheDir, {recursive: true});
    return path.join(cacheDir, path.basename(requestedPath) || 'healthsync.sqlite');
  }

  const dir = path.dirname(requestedPath);
  try {
    fs.mkdirSync(dir, {recursive: true});
    fs.accessSync(dir, fs.constants.W_OK);
    return requestedPath;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      const fallbackDir = path.join(os.tmpdir(), 'healthsync-data');
      fs.mkdirSync(fallbackDir, {recursive: true});
      return path.join(fallbackDir, path.basename(requestedPath) || 'healthsync.sqlite');
    }
    throw err;
  }
}

function databaseAlreadyHasEncryptedState(db: Database.Database): boolean {
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vault_metadata', 'triage_records', 'consent_records', 'security_breach_reports')"
      )
      .all() as Array<{name: string}>;
    const names = new Set(tables.map((t) => t.name));
    if (names.has('vault_metadata')) {
      const fp = db
        .prepare("SELECT value FROM vault_metadata WHERE key = 'key_fingerprint'")
        .get() as {value: string} | undefined;
      if (fp?.value) return true;
    }
    if (names.has('triage_records')) {
      const cnt = (db.prepare('SELECT COUNT(*) as cnt FROM triage_records').get() as {cnt: number})
        .cnt;
      if (cnt > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

const CORE_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS vault_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('ASHA', 'DMO')),
  display_name TEXT NOT NULL,
  village_code TEXT NOT NULL DEFAULT 'VIL-204',
  secret_salt TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  is_verified INTEGER NOT NULL DEFAULT 0,
  verified_by TEXT,
  verified_at_ms INTEGER,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_active_at_ms INTEGER NOT NULL DEFAULT 0,
  rotated_from_hash TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS triage_records (
  id TEXT PRIMARY KEY,
  owner_identifier TEXT NOT NULL DEFAULT '',
  patient_id TEXT NOT NULL,
  village_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  sync_status TEXT NOT NULL,
  dispatch_status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  encrypted_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL,
  is_minor INTEGER NOT NULL,
  guardian_name_encrypted TEXT,
  guardian_relationship TEXT,
  verifiable_consent INTEGER NOT NULL,
  lawful_basis TEXT NOT NULL,
  ai_processing_consent INTEGER NOT NULL DEFAULT 0,
  recorded_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incentive_entries (
  id TEXT PRIMARY KEY,
  user_identifier TEXT NOT NULL,
  record_id TEXT,
  task_title TEXT NOT NULL,
  program_code TEXT NOT NULL,
  patient_ref TEXT NOT NULL,
  amount_inr INTEGER NOT NULL,
  timestamp_label TEXT NOT NULL,
  abdm_verified INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_dispatches (
  id TEXT PRIMARY KEY,
  record_id TEXT,
  to_phone TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  payload_text TEXT NOT NULL,
  error_message TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS security_breach_reports (
  id TEXT PRIMARY KEY,
  reported_by TEXT NOT NULL,
  severity TEXT NOT NULL,
  incident_type TEXT NOT NULL,
  affected_records_estimate INTEGER NOT NULL,
  description_encrypted TEXT NOT NULL,
  containment_actions TEXT NOT NULL,
  dpb_notified INTEGER NOT NULL DEFAULT 0,
  affected_principals_notified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  timestamp_ms INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at_ms INTEGER NOT NULL
)
`.trim();

export class HealthSyncDatabase {
  private db: Database.Database;
  private masterKey: Buffer;
  private auditHmacKey: Buffer;
  private dummySaltHex: string;
  private dummyHashBuffer: Buffer;
  private replicator: TursoDurableReplicator | null;

  constructor(
    dbPath = process.env.SQLITE_DB_PATH || './data/healthsync.sqlite',
    explicitKey?: string
  ) {
    const effectivePath = resolveWritableDbPath(dbPath);
    // Open SQLite file directly — never silently fall back to :memory: when a persistent path was requested
    this.db = new Database(effectivePath);

    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    } catch {
      // Ignore WAL pragma if filesystem mount does not support shared memory
    }
    this.db.pragma('foreign_keys = ON');

    const hasPreExistingEncryptedData = databaseAlreadyHasEncryptedState(this.db);
    this.masterKey = this.resolveAndValidateMasterKey(
      effectivePath,
      explicitKey,
      hasPreExistingEncryptedData
    );
    this.auditHmacKey = crypto
      .createHmac('sha256', this.masterKey)
      .update('healthsync-dpdp-audit-chain-key-v1')
      .digest();
    this.dummySaltHex = crypto
      .createHmac('sha256', this.masterKey)
      .update('healthsync-constant-time-dummy-salt-v1')
      .digest('hex')
      .slice(0, 32);
    this.dummyHashBuffer = crypto
      .createHmac('sha512', this.masterKey)
      .update('healthsync-constant-time-dummy-hash-v1')
      .digest();

    this.replicator =
      effectivePath === ':memory:' ? null : TursoDurableReplicator.fromEnv();

    this.initSchema();
    this.verifyAndCommitMasterKeyFingerprint();
  }

  public async hydrateRemoteIfConfigured(): Promise<void> {
    if (!this.replicator) return;
    await this.replicator.hydrateIntoLocalSqlite(this.db, CORE_SCHEMA_DDL);
    this.verifyAndCommitMasterKeyFingerprint();
  }

  public async flushDurableWrites(): Promise<void> {
    if (!this.replicator) return;
    await this.replicator.flush();
  }

  public getPersistenceMode(): 'turso-remote-durable' | 'sqlite-persistent' | 'memory' {
    if (this.replicator || isRemoteDurableStoreConfigured()) return 'turso-remote-durable';
    if (this.db.memory) return 'memory';
    return 'sqlite-persistent';
  }

  private resolveAndValidateMasterKey(
    effectivePath: string,
    explicitKey: string | undefined,
    hasPreExistingEncryptedData: boolean
  ): Buffer {
    if (explicitKey !== undefined) {
      const cleanExplicit = explicitKey.trim();
      if (!cleanExplicit) {
        throw new VaultConfigurationError('Explicit vault encryption key must not be empty.');
      }
      return crypto.createHash('sha256').update(cleanExplicit, 'utf8').digest();
    }

    const rawEnvKey = process.env.VAULT_ENCRYPTION_KEY?.trim() || '';
    const isEnvPlaceholder = rawEnvKey === 'MY_VAULT_ENCRYPTION_KEY';
    const strictKeyRequired =
      effectivePath !== ':memory:' &&
      (isServerlessRuntime() ||
        isRemoteDurableStoreConfigured() ||
        process.env.REQUIRE_VAULT_KEY === 'true');

    if (rawEnvKey && !isEnvPlaceholder) {
      if (rawEnvKey.length < 32) {
        throw new VaultConfigurationError(
          'VAULT_ENCRYPTION_KEY is too short: must be at least 32 characters of high-entropy secret material.'
        );
      }
      return crypto.createHash('sha256').update(rawEnvKey, 'utf8').digest();
    }

    if (strictKeyRequired) {
      throw new VaultConfigurationError(
        'Startup Security Error: VAULT_ENCRYPTION_KEY (minimum 32 characters) must be configured when REQUIRE_VAULT_KEY=true, on serverless runtimes, or with remote Turso persistence.'
      );
    }

    if (effectivePath === ':memory:') {
      return crypto.createHash('sha256').update('healthsync-ephemeral-test-key').digest();
    }

    const dir = path.dirname(effectivePath);
    fs.mkdirSync(dir, {recursive: true});
    const keyFile = path.join(dir, '.vault_key');

    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new VaultConfigurationError(
          `Corrupted local key file at ${keyFile}. Refusing to overwrite or generate a new key.`
        );
      }
      return Buffer.from(hex, 'hex');
    }

    // CRITICAL: Never silently generate a new encryption key if encrypted data already exists!
    if (hasPreExistingEncryptedData) {
      throw new VaultConfigurationError(
        'Existing encrypted database records detected, but VAULT_ENCRYPTION_KEY (and local .vault_key) is missing. Refusing to generate a new encryption key so existing patient records are never rendered permanently unreadable.'
      );
    }

    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[HealthSync Security Notice] VAULT_ENCRYPTION_KEY is not configured; persisted a co-located 256-bit .vault_key alongside SQLite. Configure VAULT_ENCRYPTION_KEY (>= 32 chars) in environment secrets to preserve PHI across container replacements.'
      );
    }

    const generated = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, generated.toString('hex'), {mode: 0o600});
    return generated;
  }

  private computeMasterKeyFingerprint(): string {
    return crypto
      .createHmac('sha256', this.masterKey)
      .update('healthsync-vault-key-commitment-v1')
      .digest('hex');
  }

  private verifyAndCommitMasterKeyFingerprint(): void {
    const expectedFingerprint = this.computeMasterKeyFingerprint();
    const existingRow = this.db
      .prepare("SELECT value FROM vault_metadata WHERE key = 'key_fingerprint'")
      .get() as {value: string} | undefined;

    if (existingRow) {
      const storedBuf = Buffer.from(existingRow.value, 'hex');
      const expectedBuf = Buffer.from(expectedFingerprint, 'hex');
      if (
        storedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(storedBuf, expectedBuf)
      ) {
        throw new VaultConfigurationError(
          'VAULT_ENCRYPTION_KEY mismatch: The configured encryption key does not match the key used to encrypt existing database records. Refusing to start to prevent PHI data corruption.'
        );
      }
    } else {
      // If pre-existing records exist from before vault_metadata migration, verify key can decrypt one before committing fingerprint
      const sampleRow = this.db
        .prepare('SELECT encrypted_payload FROM triage_records LIMIT 1')
        .get() as {encrypted_payload: string} | undefined;
      if (sampleRow) {
        try {
          this.decryptPhi<unknown>(sampleRow.encrypted_payload);
        } catch {
          throw new VaultConfigurationError(
            'VAULT_ENCRYPTION_KEY mismatch: Cannot decrypt pre-existing triage_records in database. Restore the original VAULT_ENCRYPTION_KEY.'
          );
        }
      }
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO vault_metadata (key, value, updated_at_ms) VALUES ('key_fingerprint', ?, ?)"
        )
        .run(expectedFingerprint, now);
      this.replicator?.enqueueWrite(
        "INSERT OR IGNORE INTO vault_metadata (key, value, updated_at_ms) VALUES ('key_fingerprint', ?, ?)",
        [expectedFingerprint, now]
      );
    }
  }

  private ensureColumnExists(tableName: string, columnName: string, definitionSql: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{name: string}>;
    if (!cols.some((c) => c.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
    }
  }

  private initSchema() {
    this.db.exec(CORE_SCHEMA_DDL);

    // Safe, non-destructive idempotent migrations for pre-existing databases (preserves 100% of existing rows)
    this.ensureColumnExists('triage_records', 'owner_identifier', "TEXT NOT NULL DEFAULT ''");
    // Pre-existing users in upgraded DBs retain verified status (DEFAULT 1) while new registrations explicitly write 0 or 1
    this.ensureColumnExists('users', 'is_verified', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumnExists('users', 'verified_by', 'TEXT');
    this.ensureColumnExists('users', 'verified_at_ms', 'INTEGER');
    this.ensureColumnExists('users', 'failed_login_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumnExists('users', 'locked_until_ms', 'INTEGER NOT NULL DEFAULT 0');

    this.ensureColumnExists('sessions', 'last_active_at_ms', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumnExists('sessions', 'rotated_from_hash', 'TEXT');

    this.ensureColumnExists('incentive_entries', 'record_id', 'TEXT');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_triage_created ON triage_records(created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_triage_owner ON triage_records(owner_identifier);
      CREATE INDEX IF NOT EXISTS idx_triage_patient ON triage_records(patient_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_incentive_user_record
        ON incentive_entries(user_identifier, record_id)
        WHERE record_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp_ms DESC);

      CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
      BEFORE UPDATE ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'Security Violation: Tamper-resistant audit_logs are append-only and immutable.');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
      BEFORE DELETE ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'Security Violation: Tamper-resistant audit_logs cannot be deleted.');
      END;
    `);
  }

  public hashIpAddress(rawIp: string | undefined): string {
    const clean = (rawIp || 'unknown').trim();
    return crypto
      .createHmac('sha256', this.auditHmacKey)
      .update(`ip:${clean}`)
      .digest('hex')
      .slice(0, 24);
  }

  public encryptPhi(data: unknown): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  public decryptPhi<T>(envelope: string): T {
    const parts = envelope.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Malformed AES-256-GCM envelope');
    }
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const ciphertext = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  }

  public getRawEncryptedRecordBlob(id: string): string | null {
    const row = this.db
      .prepare('SELECT encrypted_payload FROM triage_records WHERE id = ?')
      .get(id) as {encrypted_payload: string} | undefined;
    return row ? row.encrypted_payload : null;
  }

  private normalizeIdentifier(identifier: string, role: ServerUserRole): string {
    const trimmed = identifier.trim();
    return role === 'DMO' ? trimmed.toLowerCase() : trimmed.toUpperCase();
  }

  private hashSecretAsync(secret: string, saltHex: string): Promise<Buffer> {
    const saltBuffer = Buffer.from(saltHex, 'hex');
    return new Promise((resolve, reject) => {
      crypto.scrypt(secret, saltBuffer, 64, (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      });
    });
  }

  // --- PERSISTENT RATE LIMITING BUCKETS ---
  public consumeRateLimitBucket(
    bucketKey: string,
    maxCount: number,
    windowMs: number
  ): {allowed: boolean; remaining: number; retryAfterSeconds: number} {
    const now = Date.now();
    // Prune expired buckets opportunistically
    this.db.prepare('DELETE FROM rate_limit_buckets WHERE reset_at_ms <= ?').run(now);

    const existing = this.db
      .prepare('SELECT count, reset_at_ms FROM rate_limit_buckets WHERE bucket_key = ?')
      .get(bucketKey) as {count: number; reset_at_ms: number} | undefined;

    if (!existing || existing.reset_at_ms <= now) {
      const resetAt = now + windowMs;
      this.db
        .prepare(
          'INSERT OR REPLACE INTO rate_limit_buckets (bucket_key, count, reset_at_ms) VALUES (?, 1, ?)'
        )
        .run(bucketKey, resetAt);
      return {
        allowed: 1 <= maxCount,
        remaining: Math.max(0, maxCount - 1),
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      };
    }

    if (existing.count >= maxCount) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.reset_at_ms - now) / 1000)),
      };
    }

    const nextCount = existing.count + 1;
    this.db
      .prepare('UPDATE rate_limit_buckets SET count = ? WHERE bucket_key = ?')
      .run(nextCount, bucketKey);
    return {
      allowed: true,
      remaining: Math.max(0, maxCount - nextCount),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.reset_at_ms - now) / 1000)),
    };
  }

  public peekRateLimitBucket(
    bucketKey: string,
    maxCount: number
  ): {blocked: boolean; retryAfterSeconds: number} {
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT count, reset_at_ms FROM rate_limit_buckets WHERE bucket_key = ?')
      .get(bucketKey) as {count: number; reset_at_ms: number} | undefined;
    if (existing && existing.reset_at_ms > now && existing.count >= maxCount) {
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.reset_at_ms - now) / 1000)),
      };
    }
    return {blocked: false, retryAfterSeconds: 0};
  }

  public resetRateLimitBucket(bucketKey: string): void {
    this.db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').run(bucketKey);
  }

  // --- TAMPER-RESISTANT HASH-CHAINED AUDIT LOGGING ---
  public appendAuditLog(params: {
    actorId: string;
    actorRole: string;
    action: string;
    targetType: string;
    targetId: string;
    rawIp?: string;
    metadata?: Record<string, unknown>;
  }): AuditLogEntry {
    const id = `aud-${crypto.randomUUID()}`;
    const timestampMs = Date.now();
    const ipHash = this.hashIpAddress(params.rawIp);
    const metadataObj = params.metadata ?? {};
    const metadataJson = JSON.stringify(metadataObj);

    const tx = this.db.transaction(() => {
      const lastRow = this.db
        .prepare('SELECT entry_hash FROM audit_logs ORDER BY seq DESC LIMIT 1')
        .get() as {entry_hash: string} | undefined;
      const prevHash = lastRow ? lastRow.entry_hash : '0'.repeat(64);
      const canonical = [
        prevHash,
        String(timestampMs),
        params.actorId,
        params.actorRole,
        params.action,
        params.targetType,
        params.targetId,
        ipHash,
        metadataJson,
      ].join('|');
      const entryHash = crypto
        .createHmac('sha256', this.auditHmacKey)
        .update(canonical, 'utf8')
        .digest('hex');

      const info = this.db
        .prepare(
          `INSERT INTO audit_logs (
            id, timestamp_ms, actor_id, actor_role, action, target_type, target_id, ip_hash, metadata_json, prev_hash, entry_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          timestampMs,
          params.actorId,
          params.actorRole,
          params.action,
          params.targetType,
          params.targetId,
          ipHash,
          metadataJson,
          prevHash,
          entryHash
        );

      this.replicator?.enqueueWrite(
        `INSERT OR IGNORE INTO audit_logs (
          id, timestamp_ms, actor_id, actor_role, action, target_type, target_id, ip_hash, metadata_json, prev_hash, entry_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          timestampMs,
          params.actorId,
          params.actorRole,
          params.action,
          params.targetType,
          params.targetId,
          ipHash,
          metadataJson,
          prevHash,
          entryHash,
        ]
      );

      return {
        seq: Number(info.lastInsertRowid),
        id,
        timestampMs,
        actorId: params.actorId,
        actorRole: params.actorRole,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        ipHash,
        metadata: metadataObj,
        prevHash,
        entryHash,
      };
    });

    return tx();
  }

  public verifyAuditChain(): {valid: boolean; checkedEntries: number; brokenAtSeq?: number} {
    const rows = this.db
      .prepare(
        `SELECT seq, timestamp_ms, actor_id, actor_role, action, target_type, target_id, ip_hash, metadata_json, prev_hash, entry_hash
         FROM audit_logs ORDER BY seq ASC`
      )
      .all() as Array<{
      seq: number;
      timestamp_ms: number;
      actor_id: string;
      actor_role: string;
      action: string;
      target_type: string;
      target_id: string;
      ip_hash: string;
      metadata_json: string;
      prev_hash: string;
      entry_hash: string;
    }>;

    let expectedPrev = '0'.repeat(64);
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return {valid: false, checkedEntries: rows.length, brokenAtSeq: row.seq};
      }
      const canonical = [
        row.prev_hash,
        String(row.timestamp_ms),
        row.actor_id,
        row.actor_role,
        row.action,
        row.target_type,
        row.target_id,
        row.ip_hash,
        row.metadata_json,
      ].join('|');
      const recomputed = crypto
        .createHmac('sha256', this.auditHmacKey)
        .update(canonical, 'utf8')
        .digest('hex');

      const a = Buffer.from(recomputed, 'hex');
      const b = Buffer.from(row.entry_hash, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return {valid: false, checkedEntries: rows.length, brokenAtSeq: row.seq};
      }
      expectedPrev = row.entry_hash;
    }

    return {valid: true, checkedEntries: rows.length};
  }

  public listAuditLogs(limit = 100): AuditLogEntry[] {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT seq, id, timestamp_ms, actor_id, actor_role, action, target_type, target_id, ip_hash, metadata_json, prev_hash, entry_hash
         FROM audit_logs ORDER BY seq DESC LIMIT ?`
      )
      .all(safeLimit) as Array<{
      seq: number;
      id: string;
      timestamp_ms: number;
      actor_id: string;
      actor_role: string;
      action: string;
      target_type: string;
      target_id: string;
      ip_hash: string;
      metadata_json: string;
      prev_hash: string;
      entry_hash: string;
    }>;

    return rows.map((r) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      return {
        seq: r.seq,
        id: r.id,
        timestampMs: r.timestamp_ms,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        ipHash: r.ip_hash,
        metadata,
        prevHash: r.prev_hash,
        entryHash: r.entry_hash,
      };
    });
  }

  // --- USER REGISTRATION, VERIFICATION & CONSTANT-TIME AUTHENTICATION ---
  public countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM users').get() as {cnt: number};
    return row.cnt;
  }

  public async registerUser(params: {
    identifier: string;
    secret: string;
    role: ServerUserRole;
    displayName: string;
    villageCode?: string;
    verified?: boolean;
    verifiedBy?: string;
  }): Promise<AuthenticatedUser> {
    const {normalizedId, cleanName, cleanVillage} = validateRegistrationFields({
      identifier: params.identifier,
      role: params.role,
      displayName: params.displayName,
      villageCode: params.villageCode ?? 'VIL-204',
    });

    validateStrongPasscode(params.secret, normalizedId);

    // Always run scrypt BEFORE checking existing user so duplicate-account checks are constant-time
    const saltHex = crypto.randomBytes(16).toString('hex');
    const derivedKey = await this.hashSecretAsync(params.secret, saltHex);
    const hashHex = derivedKey.toString('hex');

    const existing = this.db
      .prepare('SELECT id FROM users WHERE identifier = ?')
      .get(normalizedId);
    if (existing) {
      throw new Error('Registration could not be completed for the provided credentials.');
    }

    const id = `usr-${crypto.randomUUID()}`;
    const isVerified = params.role === 'DMO' ? true : Boolean(params.verified);
    const now = Date.now();
    const verifiedBy = isVerified ? params.verifiedBy || 'SYSTEM_ENROLLMENT' : null;
    const verifiedAtMs = isVerified ? now : null;

    try {
      this.db
        .prepare(
          `INSERT INTO users (
            id, identifier, role, display_name, village_code, secret_salt, secret_hash,
            is_verified, verified_by, verified_at_ms, failed_login_count, locked_until_ms, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
        )
        .run(
          id,
          normalizedId,
          params.role,
          cleanName,
          cleanVillage,
          saltHex,
          hashHex,
          isVerified ? 1 : 0,
          verifiedBy,
          verifiedAtMs,
          now
        );

      this.replicator?.enqueueWrite(
        `INSERT INTO users (
          id, identifier, role, display_name, village_code, secret_salt, secret_hash,
          is_verified, verified_by, verified_at_ms, failed_login_count, locked_until_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        [
          id,
          normalizedId,
          params.role,
          cleanName,
          cleanVillage,
          saltHex,
          hashHex,
          isVerified ? 1 : 0,
          verifiedBy,
          verifiedAtMs,
          now,
        ]
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new Error('Registration could not be completed for the provided credentials.');
      }
      throw err;
    }

    return {
      id,
      identifier: normalizedId,
      role: params.role,
      displayName: cleanName,
      villageCode: cleanVillage,
      isVerified,
    };
  }

  public setAshaVerificationStatus(
    identifier: string,
    verified: boolean,
    verifiedBy: string
  ): AuthenticatedUser | null {
    const normalizedId = identifier.trim().toUpperCase();
    const row = this.db
      .prepare(
        'SELECT id, identifier, role, display_name, village_code FROM users WHERE identifier = ? AND role = ?'
      )
      .get(normalizedId, 'ASHA') as
      | {
          id: string;
          identifier: string;
          role: ServerUserRole;
          display_name: string;
          village_code: string;
        }
      | undefined;

    if (!row) return null;
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE users SET is_verified = ?, verified_by = ?, verified_at_ms = ? WHERE id = ?'
      )
      .run(verified ? 1 : 0, verifiedBy, verified ? now : null, row.id);

    this.replicator?.enqueueWrite(
      'UPDATE users SET is_verified = ?, verified_by = ?, verified_at_ms = ? WHERE id = ?',
      [verified ? 1 : 0, verifiedBy, verified ? now : null, row.id]
    );

    return {
      id: row.id,
      identifier: row.identifier,
      role: row.role,
      displayName: row.display_name,
      villageCode: row.village_code,
      isVerified: verified,
    };
  }

  public listPendingAshaUsers(): Array<{
    id: string;
    identifier: string;
    displayName: string;
    villageCode: string;
    createdAtMs: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, identifier, display_name, village_code, created_at_ms
         FROM users
         WHERE role = 'ASHA' AND is_verified = 0
         ORDER BY created_at_ms DESC`
      )
      .all() as Array<{
      id: string;
      identifier: string;
      display_name: string;
      village_code: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      displayName: r.display_name,
      villageCode: r.village_code,
      createdAtMs: r.created_at_ms,
    }));
  }

  public listAshaWorkers(): Array<{
    id: string;
    identifier: string;
    displayName: string;
    villageCode: string;
    isVerified: boolean;
    verifiedBy: string | null;
    verifiedAtMs: number | null;
    createdAtMs: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, identifier, display_name, village_code, is_verified, verified_by, verified_at_ms, created_at_ms
         FROM users
         WHERE role = 'ASHA'
         ORDER BY is_verified ASC, created_at_ms DESC`
      )
      .all() as Array<{
      id: string;
      identifier: string;
      display_name: string;
      village_code: string;
      is_verified: number;
      verified_by: string | null;
      verified_at_ms: number | null;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      displayName: r.display_name,
      villageCode: r.village_code,
      isVerified: Boolean(r.is_verified),
      verifiedBy: r.verified_by ?? null,
      verifiedAtMs: r.verified_at_ms ?? null,
      createdAtMs: r.created_at_ms,
    }));
  }

  private resolveSessionTtlMs(role: ServerUserRole): number {
    const envMinutes = Number(process.env.SESSION_TTL_MINUTES);
    if (Number.isFinite(envMinutes) && envMinutes >= 5 && envMinutes <= 1440) {
      return Math.floor(envMinutes * 60 * 1000);
    }
    // Shift-scoped session lifetime: 8h for DMO hospital officers, 12h for ASHA field workers
    return role === 'DMO' ? 8 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  }

  private resolveSessionIdleMaxMs(role: ServerUserRole): number {
    return role === 'DMO' ? 2 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  }

  private issueSessionForUserRow(
    userId: string,
    role: ServerUserRole,
    rotatedFromHash: string | null = null
  ): {rawToken: string; expiresAtMs: number} {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const now = Date.now();
    const expiresAtMs = now + this.resolveSessionTtlMs(role);

    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at_ms, created_at_ms, last_active_at_ms, rotated_from_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(tokenHash, userId, expiresAtMs, now, now, rotatedFromHash);

    this.replicator?.enqueueWrite(
      `INSERT INTO sessions (token_hash, user_id, expires_at_ms, created_at_ms, last_active_at_ms, rotated_from_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tokenHash, userId, expiresAtMs, now, now, rotatedFromHash]
    );

    return {rawToken, expiresAtMs};
  }

  /**
   * Constant-time authentication with per-account brute-force lockout:
   * Always executes scrypt + crypto.timingSafeEqual even when account does not exist or is locked,
   * preventing timing-based account enumeration.
   */
  public async authenticateUser(
    identifier: string,
    secret: string,
    expectedRole: ServerUserRole
  ): Promise<{token: string; user: AuthenticatedUser; expiresAtMs: number}> {
    const normalizedId = this.normalizeIdentifier(identifier || '', expectedRole);
    const row = this.db
      .prepare(
        `SELECT id, identifier, role, display_name, village_code, secret_salt, secret_hash,
                is_verified, failed_login_count, locked_until_ms
         FROM users WHERE identifier = ? AND role = ?`
      )
      .get(normalizedId, expectedRole) as
      | {
          id: string;
          identifier: string;
          role: ServerUserRole;
          display_name: string;
          village_code: string;
          secret_salt: string;
          secret_hash: string;
          is_verified: number;
          failed_login_count: number;
          locked_until_ms: number;
        }
      | undefined;

    const effectiveSaltHex = row ? row.secret_salt : this.dummySaltHex;
    const candidateHash = await this.hashSecretAsync(String(secret || ''), effectiveSaltHex);
    const targetHash = row ? Buffer.from(row.secret_hash, 'hex') : this.dummyHashBuffer;
    const compareTarget =
      targetHash.length === candidateHash.length ? targetHash : this.dummyHashBuffer;
    const hashesEqual = crypto.timingSafeEqual(candidateHash, compareTarget);

    const now = Date.now();
    const isLocked = Boolean(row && row.locked_until_ms > now);

    if (!row || isLocked || !hashesEqual) {
      if (row && !isLocked) {
        const nextFailures = (row.failed_login_count || 0) + 1;
        const lockUntil = nextFailures >= 8 ? now + 15 * 60 * 1000 : 0;
        this.db
          .prepare('UPDATE users SET failed_login_count = ?, locked_until_ms = ? WHERE id = ?')
          .run(nextFailures, lockUntil, row.id);
        this.replicator?.enqueueWrite(
          'UPDATE users SET failed_login_count = ?, locked_until_ms = ? WHERE id = ?',
          [nextFailures, lockUntil, row.id]
        );
      }
      throw new Error('Invalid credentials.');
    }

    if (row.failed_login_count > 0 || row.locked_until_ms > 0) {
      this.db
        .prepare('UPDATE users SET failed_login_count = 0, locked_until_ms = 0 WHERE id = ?')
        .run(row.id);
      this.replicator?.enqueueWrite(
        'UPDATE users SET failed_login_count = 0, locked_until_ms = 0 WHERE id = ?',
        [row.id]
      );
    }

    // Prune expired sessions for this user
    this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at_ms <= ?')
      .run(row.id, now);

    const {rawToken, expiresAtMs} = this.issueSessionForUserRow(row.id, row.role);

    return {
      token: rawToken,
      expiresAtMs,
      user: {
        id: row.id,
        identifier: row.identifier,
        role: row.role,
        displayName: row.display_name,
        villageCode: row.village_code,
        isVerified: Boolean(row.is_verified),
      },
    };
  }

  public verifySessionToken(rawToken: string | undefined | null): AuthenticatedUser | null {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    const row = this.db
      .prepare(
        `SELECT s.expires_at_ms, s.created_at_ms, s.last_active_at_ms,
                u.id, u.identifier, u.role, u.display_name, u.village_code, u.is_verified
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash) as
      | {
          expires_at_ms: number;
          created_at_ms: number;
          last_active_at_ms: number;
          id: string;
          identifier: string;
          role: ServerUserRole;
          display_name: string;
          village_code: string;
          is_verified: number;
        }
      | undefined;

    if (!row) return null;

    const now = Date.now();
    const lastActive = row.last_active_at_ms || row.created_at_ms;
    const idleLimit = this.resolveSessionIdleMaxMs(row.role);

    if (row.expires_at_ms < now || now - lastActive > idleLimit) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      this.replicator?.enqueueWrite('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
      return null;
    }

    // Update last_active_at_ms throttled to once per 60s to avoid write amplification
    if (now - lastActive >= 60_000) {
      this.db
        .prepare('UPDATE sessions SET last_active_at_ms = ? WHERE token_hash = ?')
        .run(now, tokenHash);
    }

    return {
      id: row.id,
      identifier: row.identifier,
      role: row.role,
      displayName: row.display_name,
      villageCode: row.village_code,
      isVerified: Boolean(row.is_verified),
    };
  }

  public rotateSessionToken(
    rawToken: string | undefined | null
  ): {token: string; expiresAtMs: number; user: AuthenticatedUser} | null {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const user = this.verifySessionToken(rawToken);
    if (!user) return null;

    const oldHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(oldHash);
      this.replicator?.enqueueWrite('DELETE FROM sessions WHERE token_hash = ?', [oldHash]);
      return this.issueSessionForUserRow(user.id, user.role, oldHash);
    });

    const {rawToken: nextToken, expiresAtMs} = tx();
    return {
      token: nextToken,
      expiresAtMs,
      user,
    };
  }

  public revokeSessionToken(rawToken: string | undefined | null): void {
    if (!rawToken) return;
    const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    this.replicator?.enqueueWrite('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  public revokeAllUserSessions(userId: string): number {
    const info = this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.replicator?.enqueueWrite('DELETE FROM sessions WHERE user_id = ?', [userId]);
    return info.changes;
  }

  // --- DPDP SECTION 9 CONSENT CAPTURE & VALIDATION ---
  public validateAndPersistConsent(record: TriageRecord, recordedBy: string): void {
    const ageNum = Number(record.age);
    const isMinor = Number.isFinite(ageNum) && ageNum < 18;
    const consent: Partial<PatientConsentMetadata> = record.patientConsent ?? {};

    if (isMinor) {
      const guardianName = String(consent.guardianName || '').trim();
      const guardianRelationship = String(consent.guardianRelationship || '').trim();
      if (
        !consent.verifiableGuardianConsent ||
        guardianName.length < 2 ||
        guardianName.length > 80 ||
        !['Mother', 'Father', 'Legal Guardian'].includes(guardianRelationship)
      ) {
        throw new Error(
          'DPDP Section 9 Compliance Error: Verifiable parent or legal guardian consent (name, relationship, and consent confirmation) is required before processing personal health data of a minor (under 18 years).'
        );
      }
    }

    const encryptedGuardian =
      consent.guardianName && consent.guardianName.trim()
        ? this.encryptPhi({guardianName: consent.guardianName.trim()})
        : null;

    const id = `cns-${crypto
      .createHash('sha256')
      .update(`consent:${record.id}`)
      .digest('hex')
      .slice(0, 24)}`;
    const lawfulBasis =
      consent.lawfulBasis === 'medical_emergency_vital_interest'
        ? 'medical_emergency_vital_interest'
        : 'explicit_consent';
    const verifiable = isMinor
      ? consent.verifiableGuardianConsent
        ? 1
        : 0
      : consent.consentGranted !== false
      ? 1
      : 0;
    const aiConsent = !isMinor && consent.aiProcessingConsent === true ? 1 : 0;
    const now = consent.consentTimestampMs || Date.now();

    this.db
      .prepare(
        `INSERT INTO consent_records (
          id, record_id, patient_id, is_minor, guardian_name_encrypted, guardian_relationship,
          verifiable_consent, lawful_basis, ai_processing_consent, recorded_by, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          is_minor = excluded.is_minor,
          guardian_name_encrypted = excluded.guardian_name_encrypted,
          guardian_relationship = excluded.guardian_relationship,
          verifiable_consent = excluded.verifiable_consent,
          lawful_basis = excluded.lawful_basis,
          ai_processing_consent = excluded.ai_processing_consent`
      )
      .run(
        id,
        record.id,
        record.patientId,
        isMinor ? 1 : 0,
        encryptedGuardian,
        consent.guardianRelationship || null,
        verifiable,
        lawfulBasis,
        aiConsent,
        recordedBy,
        now
      );

    this.replicator?.enqueueWrite(
      `INSERT OR REPLACE INTO consent_records (
        id, record_id, patient_id, is_minor, guardian_name_encrypted, guardian_relationship,
        verifiable_consent, lawful_basis, ai_processing_consent, recorded_by, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.id,
        record.patientId,
        isMinor ? 1 : 0,
        encryptedGuardian,
        consent.guardianRelationship || null,
        verifiable,
        lawfulBasis,
        aiConsent,
        recordedBy,
        now,
      ]
    );
  }

  // --- TRIAGE RECORDS & DPDP SECTION 8 SECURE ERASURE ---
  public upsertRecord(record: TriageRecord, ownerIdentifier = ''): TriageRecord {
    const encryptedPayload = this.encryptPhi(record);
    const cleanOwner = ownerIdentifier.trim();
    const createdAt = record.createdAtMs || Date.now();

    this.db
      .prepare(
        `INSERT INTO triage_records (
          id, owner_identifier, patient_id, village_code, severity, sync_status, dispatch_status, created_at_ms, encrypted_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          owner_identifier = CASE
            WHEN triage_records.owner_identifier != '' THEN triage_records.owner_identifier
            ELSE excluded.owner_identifier
          END,
          patient_id = excluded.patient_id,
          village_code = excluded.village_code,
          severity = excluded.severity,
          sync_status = excluded.sync_status,
          dispatch_status = excluded.dispatch_status,
          created_at_ms = excluded.created_at_ms,
          encrypted_payload = excluded.encrypted_payload`
      )
      .run(
        record.id,
        cleanOwner,
        record.patientId,
        record.villageCode,
        record.severity,
        record.syncStatus,
        record.dispatchStatus,
        createdAt,
        encryptedPayload
      );

    this.replicator?.enqueueWrite(
      `INSERT OR REPLACE INTO triage_records (
        id, owner_identifier, patient_id, village_code, severity, sync_status, dispatch_status, created_at_ms, encrypted_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        cleanOwner,
        record.patientId,
        record.villageCode,
        record.severity,
        record.syncStatus,
        record.dispatchStatus,
        createdAt,
        encryptedPayload,
      ]
    );

    return record;
  }

  public deleteRecordSecurely(params: {
    recordId: string;
    actor: AuthenticatedUser;
    reason: string;
    rawIp?: string;
  }): {deleted: boolean; patientId: string | null} {
    if (params.actor.role !== 'DMO') {
      throw new Error('Forbidden: Only District Medical Officers (Data Fiduciary) may execute patient data erasure.');
    }
    const cleanReason = String(params.reason || '').trim();
    if (cleanReason.length < 5) {
      throw new Error('Deletion reason (minimum 5 characters) is required for DPDP Section 8 audit compliance.');
    }

    const existing = this.db
      .prepare('SELECT patient_id FROM triage_records WHERE id = ?')
      .get(params.recordId) as {patient_id: string} | undefined;
    if (!existing) {
      return {deleted: false, patientId: null};
    }

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM consent_records WHERE record_id = ?').run(params.recordId);
      this.db.prepare('DELETE FROM triage_records WHERE id = ?').run(params.recordId);
      // Redact any identifiable patient_ref in incentive_entries while preserving worker accounting totals
      this.db
        .prepare(
          "UPDATE incentive_entries SET patient_ref = ? WHERE record_id = ? OR patient_ref LIKE ?"
        )
        .run(
          `${existing.patient_id} · [ERASED DPDP SEC.8]`,
          params.recordId,
          `${existing.patient_id} ·%`
        );

      this.replicator?.enqueueWrite('DELETE FROM consent_records WHERE record_id = ?', [
        params.recordId,
      ]);
      this.replicator?.enqueueWrite('DELETE FROM triage_records WHERE id = ?', [params.recordId]);
      this.replicator?.enqueueWrite(
        "UPDATE incentive_entries SET patient_ref = ? WHERE record_id = ?",
        [`${existing.patient_id} · [ERASED DPDP SEC.8]`, params.recordId]
      );

      this.appendAuditLog({
        actorId: params.actor.identifier,
        actorRole: params.actor.role,
        action: 'DPDP_PATIENT_RECORD_ERASED',
        targetType: 'triage_record',
        targetId: params.recordId,
        rawIp: params.rawIp,
        metadata: {
          patientId: existing.patient_id,
          reason: cleanReason,
        },
      });
    });

    tx();
    return {deleted: true, patientId: existing.patient_id};
  }

  public getRecordById(id: string): TriageRecord | null {
    const row = this.db
      .prepare('SELECT encrypted_payload FROM triage_records WHERE id = ?')
      .get(id) as {encrypted_payload: string} | undefined;
    if (!row) return null;
    return this.decryptPhi<TriageRecord>(row.encrypted_payload);
  }

  public getRecordWithOwner(id: string): {record: TriageRecord; ownerIdentifier: string} | null {
    const row = this.db
      .prepare('SELECT owner_identifier, encrypted_payload FROM triage_records WHERE id = ?')
      .get(id) as {owner_identifier: string; encrypted_payload: string} | undefined;
    if (!row) return null;
    return {
      record: this.decryptPhi<TriageRecord>(row.encrypted_payload),
      ownerIdentifier: row.owner_identifier || '',
    };
  }

  public listRecords(limit = 500, sinceMs?: number): TriageRecord[] {
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const rows =
      typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs > 0
        ? (this.db
            .prepare(
              'SELECT encrypted_payload FROM triage_records WHERE created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT ?'
            )
            .all(Math.floor(sinceMs), safeLimit) as Array<{encrypted_payload: string}>)
        : (this.db
            .prepare(
              'SELECT encrypted_payload FROM triage_records ORDER BY created_at_ms DESC LIMIT ?'
            )
            .all(safeLimit) as Array<{encrypted_payload: string}>);

    const out: TriageRecord[] = [];
    for (const row of rows) {
      try {
        out.push(this.decryptPhi<TriageRecord>(row.encrypted_payload));
      } catch (err) {
        console.error('[HealthSync DB] Corrupted or undecryptable triage record skipped:', err);
      }
    }
    return out;
  }

  public listRecordsForUser(user: AuthenticatedUser, limit = 500, sinceMs?: number): TriageRecord[] {
    if (user.role === 'DMO') {
      return this.listRecords(limit, sinceMs);
    }
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const rows =
      typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs > 0
        ? (this.db
            .prepare(
              'SELECT encrypted_payload FROM triage_records WHERE owner_identifier = ? AND created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT ?'
            )
            .all(user.identifier, Math.floor(sinceMs), safeLimit) as Array<{
            encrypted_payload: string;
          }>)
        : (this.db
            .prepare(
              'SELECT encrypted_payload FROM triage_records WHERE owner_identifier = ? ORDER BY created_at_ms DESC LIMIT ?'
            )
            .all(user.identifier, safeLimit) as Array<{encrypted_payload: string}>);

    const out: TriageRecord[] = [];
    for (const row of rows) {
      try {
        out.push(this.decryptPhi<TriageRecord>(row.encrypted_payload));
      } catch (err) {
        console.error(
          '[HealthSync DB] Corrupted or undecryptable user triage record skipped:',
          err
        );
      }
    }
    return out;
  }

  // --- INCENTIVE SECURITY (SERVER-GENERATED IDS, STRICT AMOUNT VALIDATION & OWNERSHIP) ---
  public static computeExpectedNhmIncentive(record: TriageRecord): {
    amountInr: number;
    programCode: string;
    taskTitle: string;
  } {
    const isHighRisk = record.severity === 'emergency' || record.severity === 'moderate';
    return {
      amountInr: isHighRisk ? 50 : 20,
      programCode: isHighRisk ? 'NHM-HRP-50' : 'NPCDCS-20',
      taskTitle: isHighRisk
        ? 'Priority Referral & Health Stabilization'
        : 'Community Vital Signs Checkup',
    };
  }

  public recordVerifiedTriageIncentive(params: {
    record: TriageRecord;
    ownerUser: AuthenticatedUser;
    clientSubmittedIncentive?: Partial<IncentiveEntry> | null;
  }): IncentiveEntry {
    if (params.ownerUser.role !== 'ASHA' || !params.ownerUser.isVerified) {
      throw new Error('Forbidden: Only verified ASHA workers can accrue NHM visit stipends.');
    }

    const expected = HealthSyncDatabase.computeExpectedNhmIncentive(params.record);

    // Validate client-supplied amountInr strictly if provided (never trust client-inflated amounts)
    if (
      params.clientSubmittedIncentive &&
      params.clientSubmittedIncentive.amountInr !== undefined
    ) {
      const submittedAmount = Number(params.clientSubmittedIncentive.amountInr);
      if (!Number.isInteger(submittedAmount) || submittedAmount !== expected.amountInr) {
        throw new Error(
          `Invalid stipend amountInr (${params.clientSubmittedIncentive.amountInr}): Server NHM tariff requires ₹${expected.amountInr} for ${params.record.severity} checkups.`
        );
      }
    }

    const normalizedUser = params.ownerUser.identifier.toUpperCase();
    // Never trust client-provided incentive IDs — compute deterministic server ID from (owner, record.id)
    const serverIncentiveId = `inc-${crypto
      .createHash('sha256')
      .update(`${normalizedUser}:${params.record.id}`)
      .digest('hex')
      .slice(0, 20)}`;

    const existing = this.db
      .prepare('SELECT user_identifier FROM incentive_entries WHERE id = ?')
      .get(serverIncentiveId) as {user_identifier: string} | undefined;
    if (existing && existing.user_identifier !== normalizedUser) {
      throw new Error('Forbidden: Cannot overwrite an incentive record owned by another user.');
    }

    const entry: IncentiveEntry = {
      id: serverIncentiveId,
      taskTitle: expected.taskTitle,
      programCode: expected.programCode,
      patientRef: `${params.record.patientId} · Masked Patient`,
      amountInr: expected.amountInr,
      timestamp: String(params.record.timestamp || 'Just now'),
      abdmVerified: true,
    };

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO incentive_entries (
          id, user_identifier, record_id, task_title, program_code, patient_ref, amount_inr, timestamp_label, abdm_verified, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_title = excluded.task_title,
          program_code = excluded.program_code,
          amount_inr = excluded.amount_inr,
          timestamp_label = excluded.timestamp_label`
      )
      .run(
        entry.id,
        normalizedUser,
        params.record.id,
        entry.taskTitle,
        entry.programCode,
        entry.patientRef,
        entry.amountInr,
        entry.timestamp,
        1,
        now
      );

    this.replicator?.enqueueWrite(
      `INSERT OR REPLACE INTO incentive_entries (
        id, user_identifier, record_id, task_title, program_code, patient_ref, amount_inr, timestamp_label, abdm_verified, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        normalizedUser,
        params.record.id,
        entry.taskTitle,
        entry.programCode,
        entry.patientRef,
        entry.amountInr,
        entry.timestamp,
        1,
        now,
      ]
    );

    return entry;
  }

  public insertIncentive(entry: IncentiveEntry, userIdentifier: string): IncentiveEntry {
    const cleanUser = userIdentifier.trim().toUpperCase();
    if (!cleanUser) {
      throw new Error('User identifier is required for incentive entry.');
    }
    const amount = Number(entry.amountInr);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 500) {
      throw new Error('Invalid incentive amountInr: Must be a positive NHM tariff integer (<= 500).');
    }

    const cleanId =
      cleanUser === 'SEED'
        ? String(entry.id)
        : `inc-${crypto
            .createHash('sha256')
            .update(`${cleanUser}:${String(entry.id)}`)
            .digest('hex')
            .slice(0, 20)}`;

    const existing = this.db
      .prepare('SELECT user_identifier FROM incentive_entries WHERE id = ?')
      .get(cleanId) as {user_identifier: string} | undefined;
    if (existing && existing.user_identifier !== cleanUser) {
      throw new Error('Forbidden: Cannot modify another user’s incentive record.');
    }

    const normalized: IncentiveEntry = {
      id: cleanId,
      taskTitle: String(entry.taskTitle || 'Community Vital Signs Checkup').slice(0, 120),
      programCode: String(entry.programCode || 'NPCDCS-20').slice(0, 40),
      patientRef: String(entry.patientRef || 'PT-RECORD').slice(0, 80),
      amountInr: amount,
      timestamp: String(entry.timestamp || 'Just now').slice(0, 40),
      abdmVerified: Boolean(entry.abdmVerified ?? true),
    };
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO incentive_entries (
          id, user_identifier, task_title, program_code, patient_ref, amount_inr, timestamp_label, abdm_verified, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_title = excluded.task_title,
          program_code = excluded.program_code,
          amount_inr = excluded.amount_inr,
          timestamp_label = excluded.timestamp_label`
      )
      .run(
        normalized.id,
        cleanUser,
        normalized.taskTitle,
        normalized.programCode,
        normalized.patientRef,
        normalized.amountInr,
        normalized.timestamp,
        normalized.abdmVerified ? 1 : 0,
        now
      );

    return normalized;
  }

  public listIncentives(userIdentifier?: string): IncentiveEntry[] {
    const rows = userIdentifier
      ? (this.db
          .prepare(
            `SELECT id, task_title, program_code, patient_ref, amount_inr, timestamp_label, abdm_verified
             FROM incentive_entries
             WHERE user_identifier = ? OR user_identifier = 'SEED'
             ORDER BY created_at_ms DESC`
          )
          .all(userIdentifier.toUpperCase()) as Array<{
          id: string;
          task_title: string;
          program_code: string;
          patient_ref: string;
          amount_inr: number;
          timestamp_label: string;
          abdm_verified: number;
        }>)
      : (this.db
          .prepare(
            `SELECT id, task_title, program_code, patient_ref, amount_inr, timestamp_label, abdm_verified
             FROM incentive_entries
             ORDER BY created_at_ms DESC`
          )
          .all() as Array<{
          id: string;
          task_title: string;
          program_code: string;
          patient_ref: string;
          amount_inr: number;
          timestamp_label: string;
          abdm_verified: number;
        }>);

    return rows.map((r) => ({
      id: r.id,
      taskTitle: r.task_title,
      programCode: r.program_code,
      patientRef: r.patient_ref,
      amountInr: r.amount_inr,
      timestamp: r.timestamp_label,
      abdmVerified: Boolean(r.abdm_verified),
    }));
  }

  public seedInitialDataIfEmpty(
    seedRecords: TriageRecord[],
    seedIncentives: IncentiveEntry[]
  ): void {
    const recCount = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM triage_records').get() as {cnt: number}
    ).cnt;
    if (recCount === 0 && seedRecords.length > 0) {
      const tx = this.db.transaction(() => {
        for (const rec of seedRecords) {
          this.upsertRecord(rec);
        }
      });
      tx();
    }

    const incCount = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM incentive_entries').get() as {cnt: number}
    ).cnt;
    if (incCount === 0 && seedIncentives.length > 0) {
      const tx = this.db.transaction(() => {
        for (const inc of seedIncentives) {
          this.insertIncentive(inc, 'SEED');
        }
      });
      tx();
    }
  }

  // --- DPDP SECTION 8(6) DATA BREACH REPORTING ---
  public createBreachReport(params: {
    reportedBy: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    incidentType: string;
    affectedRecordsEstimate: number;
    description: string;
    containmentActions: string;
    dpbNotified?: boolean;
    affectedPrincipalsNotified?: boolean;
  }): SecurityBreachReport {
    const cleanType = String(params.incidentType || '').trim();
    const cleanDesc = String(params.description || '').trim();
    const cleanContainment = String(params.containmentActions || '').trim();

    if (cleanType.length < 3 || cleanDesc.length < 10) {
      throw new Error(
        'Breach report requires a valid incidentType and detailed description (minimum 10 characters).'
      );
    }

    const id = `brch-${crypto.randomUUID()}`;
    const createdAtMs = Date.now();
    const encryptedDescription = this.encryptPhi({description: cleanDesc});
    const safeEstimate = Math.max(0, Math.floor(Number(params.affectedRecordsEstimate) || 0));
    const status = params.dpbNotified ? 'notified_dpb' : 'investigating';

    this.db
      .prepare(
        `INSERT INTO security_breach_reports (
          id, reported_by, severity, incident_type, affected_records_estimate,
          description_encrypted, containment_actions, dpb_notified, affected_principals_notified, status, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.reportedBy,
        params.severity,
        cleanType.slice(0, 120),
        safeEstimate,
        encryptedDescription,
        cleanContainment.slice(0, 600) || 'Session revocation and credential audit initiated.',
        params.dpbNotified ? 1 : 0,
        params.affectedPrincipalsNotified ? 1 : 0,
        status,
        createdAtMs
      );

    this.replicator?.enqueueWrite(
      `INSERT INTO security_breach_reports (
        id, reported_by, severity, incident_type, affected_records_estimate,
        description_encrypted, containment_actions, dpb_notified, affected_principals_notified, status, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.reportedBy,
        params.severity,
        cleanType.slice(0, 120),
        safeEstimate,
        encryptedDescription,
        cleanContainment.slice(0, 600) || 'Session revocation and credential audit initiated.',
        params.dpbNotified ? 1 : 0,
        params.affectedPrincipalsNotified ? 1 : 0,
        status,
        createdAtMs,
      ]
    );

    return {
      id,
      reportedBy: params.reportedBy,
      severity: params.severity,
      incidentType: cleanType.slice(0, 120),
      affectedRecordsEstimate: safeEstimate,
      description: cleanDesc,
      containmentActions:
        cleanContainment.slice(0, 600) || 'Session revocation and credential audit initiated.',
      dpbNotified: Boolean(params.dpbNotified),
      affectedPrincipalsNotified: Boolean(params.affectedPrincipalsNotified),
      status,
      createdAtMs,
    };
  }

  public listBreachReports(limit = 50): SecurityBreachReport[] {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT id, reported_by, severity, incident_type, affected_records_estimate,
                description_encrypted, containment_actions, dpb_notified, affected_principals_notified, status, created_at_ms
         FROM security_breach_reports
         ORDER BY created_at_ms DESC LIMIT ?`
      )
      .all(safeLimit) as Array<{
      id: string;
      reported_by: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      incident_type: string;
      affected_records_estimate: number;
      description_encrypted: string;
      containment_actions: string;
      dpb_notified: number;
      affected_principals_notified: number;
      status: 'open' | 'investigating' | 'notified_dpb' | 'resolved';
      created_at_ms: number;
    }>;

    return rows.map((r) => {
      let desc = '[Encrypted Incident Description]';
      try {
        desc = this.decryptPhi<{description: string}>(r.description_encrypted).description;
      } catch {
        // Keep masked fallback
      }
      return {
        id: r.id,
        reportedBy: r.reported_by,
        severity: r.severity,
        incidentType: r.incident_type,
        affectedRecordsEstimate: r.affected_records_estimate,
        description: desc,
        containmentActions: r.containment_actions,
        dpbNotified: Boolean(r.dpb_notified),
        affectedPrincipalsNotified: Boolean(r.affected_principals_notified),
        status: r.status,
        createdAtMs: r.created_at_ms,
      };
    });
  }

  // --- SMS DISPATCH LOGS & SPEND TRACKING ---
  public logSmsDispatch(entry: Omit<SmsDispatchLog, 'id' | 'createdAtMs'>): SmsDispatchLog {
    const full: SmsDispatchLog = {
      id: `sms-${crypto.randomUUID()}`,
      createdAtMs: Date.now(),
      ...entry,
    };
    this.db
      .prepare(
        `INSERT INTO sms_dispatches (
          id, record_id, to_phone, provider, status, provider_message_id, payload_text, error_message, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        full.id,
        full.recordId,
        full.toPhone,
        full.provider,
        full.status,
        full.providerMessageId,
        full.payloadText,
        full.errorMessage,
        full.createdAtMs
      );

    this.replicator?.enqueueWrite(
      `INSERT INTO sms_dispatches (
        id, record_id, to_phone, provider, status, provider_message_id, payload_text, error_message, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        full.id,
        full.recordId,
        full.toPhone,
        full.provider,
        full.status,
        full.providerMessageId,
        full.payloadText,
        full.errorMessage,
        full.createdAtMs,
      ]
    );
    return full;
  }

  public hasSmsDispatchForRecord(recordId: string, provider = 'inbound_webhook'): boolean {
    const row = this.db
      .prepare('SELECT id FROM sms_dispatches WHERE record_id = ? AND provider = ? LIMIT 1')
      .get(recordId, provider) as {id: string} | undefined;
    return Boolean(row);
  }

  public hasSentOutboundCarrierSmsForRecord(recordId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM sms_dispatches WHERE record_id = ? AND provider != 'inbound_webhook' AND status IN ('sent', 'queued_no_credentials') LIMIT 1"
      )
      .get(recordId) as {id: string} | undefined;
    return Boolean(row);
  }

  public countRecentOutboundSms(windowMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - windowMs;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM sms_dispatches WHERE provider != 'inbound_webhook' AND created_at_ms >= ?"
      )
      .get(cutoff) as {cnt: number};
    return row.cnt;
  }

  public listSmsDispatches(limit = 50): SmsDispatchLog[] {
    const rows = this.db
      .prepare(
        `SELECT id, record_id, to_phone, provider, status, provider_message_id, payload_text, error_message, created_at_ms
         FROM sms_dispatches
         ORDER BY created_at_ms DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: string;
      record_id: string | null;
      to_phone: string;
      provider: string;
      status: string;
      provider_message_id: string | null;
      payload_text: string;
      error_message: string | null;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      recordId: r.record_id,
      toPhone: r.to_phone,
      provider: r.provider,
      status: r.status,
      providerMessageId: r.provider_message_id,
      payloadText: r.payload_text,
      errorMessage: r.error_message,
      createdAtMs: r.created_at_ms,
    }));
  }

  public close(): void {
    this.db.close();
  }
}
