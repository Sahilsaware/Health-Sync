import {IncentiveEntry, TriageRecord} from '../types/triage';
import {
  base64ToBytes,
  bytesToBase64,
  decryptVaultData,
  DEFAULT_OFFLINE_DMO_AUTH_CODE,
  EncryptedVaultEnvelope,
  encryptVaultData,
  generateRandomSalt,
  isEncryptedVaultEnvelope,
} from './cryptoVault';
import {safeReadJson} from './safeFetchJson';

export const LEGACY_SINGLETON_VAULT_KEY = 'healthsync_aes_gcm_vault_v1';
export const SCOPED_VAULT_KEY_PREFIX = 'healthsync_aes_gcm_vault_v2_';
export const DISTRICT_RELAY_VAULT_KEY = 'healthsync_district_relay_vault_v1';
const DISTRICT_RELAY_IDB_SLOT = 'district_relay_v1';
const LEGACY_PLAINTEXT_KEYS = [
  'healthsync_records',
  'healthsync_edge_v4_records',
  'healthsync_edge_v5_records',
];
const BROADCAST_CHANNEL_NAME = 'healthsync_edge_realtime_bus';
const IDB_NAME = 'healthsync_encrypted_idb_v1';
const IDB_STORE = 'encrypted_vault_envelopes';

export interface AshaWorkerRosterEntry {
  id: string;
  identifier: string;
  displayName: string;
  villageCode: string;
  isVerified: boolean;
  verifiedBy?: string | null;
  verifiedAtMs?: number | null;
  createdAtMs: number;
  lastActiveAtMs?: number;
}

export interface DistrictRelayState {
  records: TriageRecord[];
  workers: AshaWorkerRosterEntry[];
}

/**
 * Produces an injective, collision-free per-account vault scope identifier from (role, identifier).
 * Prevents shared-device data destruction when multiple ASHA workers or DMOs share a tablet/phone.
 */
export function buildUserVaultScope(role: 'ASHA' | 'DMO', identifier: string): string {
  const normalized = `${role}:${identifier.trim().toUpperCase()}`;
  const bytes = new TextEncoder().encode(normalized);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `${role}_${hex}`;
}

export function getScopedVaultStorageKey(userScope: string): string {
  if (!userScope || !userScope.trim()) {
    throw new Error('User vault scope is required to access encrypted local storage.');
  }
  return `${SCOPED_VAULT_KEY_PREFIX}${userScope.trim()}`;
}

export function getScopedVaultIdbSlot(userScope: string): string {
  if (!userScope || !userScope.trim()) {
    throw new Error('User vault scope is required to access encrypted IndexedDB slot.');
  }
  return `vault_v2_${userScope.trim()}`;
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

export type RealtimeEventMessage =
  | {
      type: 'record:created';
      record: TriageRecord;
      triggerEmergencySiren: boolean;
    }
  | {
      type: 'record:updated';
      record: TriageRecord;
    }
  | {
      type: 'record:deleted';
      recordId: string;
    }
  | {
      type: 'sync:init';
      records: TriageRecord[];
      connectedPeers: number;
    }
  | {
      type: 'sync:ack';
      recordId: string;
      record: TriageRecord;
    }
  | {
      type: 'sync:error';
      recordId: string | null;
      error: string;
      retryable: boolean;
    }
  | {
      type: 'auth:error';
      error: string;
    }
  | {
      type: 'presence:count';
      connectedPeers: number;
    }
  | {
      type: 'asha:roster_updated';
      worker: AshaWorkerRosterEntry;
    };

/**
 * Purges any legacy unencrypted localStorage keys & legacy IndexedDB databases
 * so zero plaintext PHI ever lingers in browser storage.
 */
export function purgeLegacyPlaintextStorage(): void {
  const storage = getLocalStorage();
  if (storage) {
    try {
      for (const key of LEGACY_PLAINTEXT_KEYS) {
        storage.removeItem(key);
      }
    } catch {
      // Ignore storage errors
    }
  }
  try {
    if (typeof window !== 'undefined' && 'indexedDB' in window) {
      window.indexedDB.deleteDatabase('healthsync_edge_idb');
      window.indexedDB.deleteDatabase('healthsync_os_v32');
    }
  } catch {
    // Ignore IndexedDB errors
  }
}

// REQUIRED FIX: Global queue to prevent IDB transaction race conditions
let idbWriteQueue: Promise<void> = Promise.resolve();

function saveEncryptedEnvelopeToIndexedDB(userScope: string, envelope: EncryptedVaultEnvelope): void {
  if (typeof window === 'undefined' || !('indexedDB' in window) || !userScope) return;

  idbWriteQueue = idbWriteQueue.then(
    () =>
      new Promise<void>((resolve) => {
        try {
          const slotKey = getScopedVaultIdbSlot(userScope);
          const request = window.indexedDB.open(IDB_NAME, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
              db.createObjectStore(IDB_STORE, {keyPath: 'slot'});
            }
          };
          request.onsuccess = () => {
            try {
              const db = request.result;
              const tx = db.transaction(IDB_STORE, 'readwrite');
              tx.objectStore(IDB_STORE).put({slot: slotKey, ...envelope});
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                resolve();
              };
            } catch {
              resolve();
            }
          };
          request.onerror = () => resolve();
        } catch {
          resolve(); // Do not block queue on sandbox restriction
        }
      })
  );
}

function loadEncryptedEnvelopeFromIndexedDB(userScope: string): Promise<EncryptedVaultEnvelope | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window) || !userScope) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const slotKey = getScopedVaultIdbSlot(userScope);
      const request = window.indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, {keyPath: 'slot'});
        }
      };
      request.onsuccess = () => {
        try {
          const db = request.result;
          const tx = db.transaction(IDB_STORE, 'readonly');
          const getReq = tx.objectStore(IDB_STORE).get(slotKey);
          getReq.onsuccess = () => {
            const val = getReq.result;
            db.close();
            resolve(isEncryptedVaultEnvelope(val) ? val : null);
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Encrypts records with Web Crypto AES-256-GCM BEFORE writing to the user's isolated
 * localStorage key and IndexedDB slot. Never touches any other user's vault on a shared device.
 */
export async function persistEncryptedRecords(
  vaultKey: CryptoKey | null,
  salt: Uint8Array | null,
  records: TriageRecord[],
  userScope: string
): Promise<void> {
  const storage = getLocalStorage();
  if (!vaultKey || !salt || !userScope || !userScope.trim()) return;
  try {
    const scopedKey = getScopedVaultStorageKey(userScope);
    const envelope = await encryptVaultData(vaultKey, salt, records);
    if (storage) {
      storage.setItem(scopedKey, JSON.stringify(envelope));
    }
    saveEncryptedEnvelopeToIndexedDB(userScope, envelope);
  } catch {
    // Ignore quota or encryption errors
  }
}

/**
 * Reads and verifies the AES-256-GCM encrypted vault for a specific `userScope`.
 * - Isolated per user so Worker B logging in on a shared tablet never reads or overwrites Worker A's vault.
 * - Safely migrates a legacy v1 vault ONLY if `vaultKey` cryptographically authenticates it;
 *   if decryption fails (belonging to a different user), legacy v1 is left untouched for its owner.
 */
export async function loadEncryptedRecords(
  vaultKey: CryptoKey,
  fallback: TriageRecord[],
  userScope: string
): Promise<TriageRecord[]> {
  if (!userScope || !userScope.trim()) return fallback;
  const storage = getLocalStorage();
  const scopedKey = getScopedVaultStorageKey(userScope);

  // 1. Check the user's isolated v2 localStorage vault
  if (storage) {
    try {
      const raw = storage.getItem(scopedKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isEncryptedVaultEnvelope(parsed)) {
          const decrypted = await decryptVaultData<TriageRecord[]>(vaultKey, parsed);
          return Array.isArray(decrypted) ? decrypted : fallback;
        }
      }
    } catch {
      return fallback;
    }
  }

  // 2. Fallback to the user's isolated v2 IndexedDB vault slot
  const idbEnvelope = await loadEncryptedEnvelopeFromIndexedDB(userScope);
  if (idbEnvelope) {
    try {
      const decrypted = await decryptVaultData<TriageRecord[]>(vaultKey, idbEnvelope);
      if (Array.isArray(decrypted)) {
        if (storage) {
          try {
            storage.setItem(scopedKey, JSON.stringify(idbEnvelope));
          } catch {
            // Ignore quota errors
          }
        }
        return decrypted;
      }
    } catch {
      return fallback;
    }
  }

  // 3. Non-destructive legacy singleton migration: ONLY migrate if THIS user's key decrypts it!
  if (storage) {
    try {
      const legacyRaw = storage.getItem(LEGACY_SINGLETON_VAULT_KEY);
      if (legacyRaw) {
        const legacyParsed = JSON.parse(legacyRaw);
        if (isEncryptedVaultEnvelope(legacyParsed)) {
          const migrated = await decryptVaultData<TriageRecord[]>(vaultKey, legacyParsed);
          if (Array.isArray(migrated)) {
            storage.setItem(scopedKey, legacyRaw);
            saveEncryptedEnvelopeToIndexedDB(userScope, legacyParsed);
            storage.removeItem(LEGACY_SINGLETON_VAULT_KEY);
            return migrated;
          }
        }
      }
    } catch {
      // Legacy vault belongs to a different user on this shared device — leave it completely intact!
    }
  }

  return fallback;
}

let cachedDistrictRelayKeyBySalt = new Map<string, CryptoKey>();
let relayMutationQueue: Promise<DistrictRelayState> = Promise.resolve({records: [], workers: []});

async function deriveDistrictRelayAesKey(salt: Uint8Array): Promise<CryptoKey> {
  const saltB64 = bytesToBase64(salt);
  const cached = cachedDistrictRelayKeyBySalt.get(saltB64);
  if (cached) return cached;

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API unavailable for District Relay encryption.');
  }
  const rawMaterial = new TextEncoder().encode(
    `healthsync-district-relay-v1|${DEFAULT_OFFLINE_DMO_AUTH_CODE}`
  );
  const baseKey = await subtle.importKey('raw', rawMaterial, 'PBKDF2', false, ['deriveKey']);
  const derived = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
  cachedDistrictRelayKeyBySalt.set(saltB64, derived);
  return derived;
}

async function readRawDistrictRelayState(): Promise<{
  state: DistrictRelayState;
  salt: Uint8Array | null;
}> {
  const empty: DistrictRelayState = {records: [], workers: []};
  const storage = getLocalStorage();

  if (storage) {
    try {
      const raw = storage.getItem(DISTRICT_RELAY_VAULT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isEncryptedVaultEnvelope(parsed)) {
          const salt = base64ToBytes(parsed.saltB64);
          const key = await deriveDistrictRelayAesKey(salt);
          const dec = await decryptVaultData<DistrictRelayState>(key, parsed);
          return {
            state: {
              records: Array.isArray(dec?.records) ? dec.records : [],
              workers: Array.isArray(dec?.workers) ? dec.workers : [],
            },
            salt,
          };
        }
      }
    } catch {
      // Fall through to IndexedDB or fresh salt
    }
  }

  const idbEnv = await loadEncryptedEnvelopeFromIndexedDB(DISTRICT_RELAY_IDB_SLOT);
  if (idbEnv) {
    try {
      const salt = base64ToBytes(idbEnv.saltB64);
      const key = await deriveDistrictRelayAesKey(salt);
      const dec = await decryptVaultData<DistrictRelayState>(key, idbEnv);
      return {
        state: {
          records: Array.isArray(dec?.records) ? dec.records : [],
          workers: Array.isArray(dec?.workers) ? dec.workers : [],
        },
        salt,
      };
    } catch {
      return {state: empty, salt: null};
    }
  }

  return {state: empty, salt: null};
}

async function mutateDistrictRelay(
  mutator: (prev: DistrictRelayState) => DistrictRelayState
): Promise<DistrictRelayState> {
  const nextOp = relayMutationQueue
    .catch(() => ({records: [], workers: []}))
    .then(async () => {
      const {state, salt: existingSalt} = await readRawDistrictRelayState();
      const updated = mutator(state);
      const salt = existingSalt ?? generateRandomSalt(16);
      const key = await deriveDistrictRelayAesKey(salt);
      const rawEnv = await encryptVaultData(key, salt, updated);
      const env: EncryptedVaultEnvelope = {...rawEnv, kdf: 'PBKDF2-SHA256-100K'};
      const storage = getLocalStorage();
      if (storage) {
        try {
          storage.setItem(DISTRICT_RELAY_VAULT_KEY, JSON.stringify(env));
        } catch {
          // Ignore quota errors
        }
      }
      saveEncryptedEnvelopeToIndexedDB(DISTRICT_RELAY_IDB_SLOT, env);
      return updated;
    });
  relayMutationQueue = nextOp;
  return nextOp;
}

export async function loadEncryptedDistrictRelay(): Promise<DistrictRelayState> {
  try {
    const {state} = await readRawDistrictRelayState();
    return state;
  } catch {
    return {records: [], workers: []};
  }
}

export async function upsertWorkerInDistrictRelay(
  worker: Omit<AshaWorkerRosterEntry, 'id' | 'createdAtMs'> & {
    id?: string;
    createdAtMs?: number;
  }
): Promise<AshaWorkerRosterEntry | null> {
  try {
    const normId = String(worker.identifier || '').trim().toUpperCase();
    if (!normId) return null;
    const now = Date.now();
    let savedEntry: AshaWorkerRosterEntry | null = null;
    await mutateDistrictRelay((prev) => {
      const existing = prev.workers.find((w) => w.identifier.toUpperCase() === normId);
      const merged: AshaWorkerRosterEntry = {
        id: existing?.id || worker.id || `asha-${normId}`,
        identifier: normId,
        displayName: worker.displayName || existing?.displayName || normId,
        villageCode: worker.villageCode || existing?.villageCode || 'VIL-204',
        isVerified: Boolean(worker.isVerified || existing?.isVerified),
        verifiedBy: worker.verifiedBy ?? existing?.verifiedBy ?? null,
        verifiedAtMs: worker.verifiedAtMs ?? existing?.verifiedAtMs ?? null,
        createdAtMs: existing?.createdAtMs || worker.createdAtMs || now,
        lastActiveAtMs: now,
      };
      savedEntry = merged;
      const others = prev.workers.filter((w) => w.identifier.toUpperCase() !== normId);
      return {
        records: prev.records,
        workers: [merged, ...others],
      };
    });
    return savedEntry;
  } catch {
    return null;
  }
}

export async function setWorkerVerifiedInDistrictRelay(
  identifier: string,
  verified: boolean,
  verifiedBy: string
): Promise<AshaWorkerRosterEntry | null> {
  try {
    const normId = String(identifier || '').trim().toUpperCase();
    if (!normId) return null;
    const now = Date.now();
    let updatedEntry: AshaWorkerRosterEntry | null = null;
    await mutateDistrictRelay((prev) => {
      const existing = prev.workers.find((w) => w.identifier.toUpperCase() === normId);
      const nextWorker: AshaWorkerRosterEntry = existing
        ? {
            ...existing,
            isVerified: verified,
            verifiedBy,
            verifiedAtMs: verified ? now : null,
            lastActiveAtMs: now,
          }
        : {
            id: `asha-${normId}`,
            identifier: normId,
            displayName: normId,
            villageCode: 'VIL-204',
            isVerified: verified,
            verifiedBy,
            verifiedAtMs: verified ? now : null,
            createdAtMs: now,
            lastActiveAtMs: now,
          };
      updatedEntry = nextWorker;
      const others = prev.workers.filter((w) => w.identifier.toUpperCase() !== normId);
      return {
        records: prev.records,
        workers: [nextWorker, ...others],
      };
    });
    return updatedEntry;
  } catch {
    return null;
  }
}

export async function upsertRecordsInDistrictRelay(recordsToUpsert: TriageRecord[]): Promise<void> {
  if (!Array.isArray(recordsToUpsert) || recordsToUpsert.length === 0) return;
  try {
    await mutateDistrictRelay((prev) => {
      const byId = new Map<string, TriageRecord>();
      for (const r of prev.records || []) {
        if (r?.id) byId.set(r.id, r);
      }
      for (const r of recordsToUpsert) {
        if (r?.id) byId.set(r.id, r);
      }
      const sorted = Array.from(byId.values()).sort(
        (a, b) => (Number(b?.createdAtMs) || 0) - (Number(a?.createdAtMs) || 0)
      );
      return {
        records: sorted.slice(0, 500),
        workers: prev.workers,
      };
    });
  } catch {
    // Ignore storage errors
  }
}

export async function dispatchRecordInDistrictRelay(
  recordId: string,
  ambulanceUnit = '108-AMB-UP65',
  etaMinutes = 11
): Promise<TriageRecord | null> {
  if (!recordId) return null;
  try {
    let updatedRec: TriageRecord | null = null;
    await mutateDistrictRelay((prev) => {
      const nextRecords = (prev.records || []).map((rec) => {
        if (rec?.id !== recordId) return rec;
        const patched: TriageRecord = {
          ...rec,
          dispatchStatus: 'Dispatched',
          ambulanceUnit,
          etaMinutes,
        };
        updatedRec = patched;
        return patched;
      });
      return {
        records: nextRecords,
        workers: prev.workers,
      };
    });
    return updatedRec;
  } catch {
    return null;
  }
}

export async function removeRecordFromDistrictRelay(recordId: string): Promise<void> {
  if (!recordId) return;
  try {
    await mutateDistrictRelay((prev) => ({
      records: (prev.records || []).filter((r) => r?.id !== recordId),
      workers: prev.workers,
    }));
  } catch {
    // Ignore
  }
}

export function broadcastLocalRealtimeEvent(event: RealtimeEventMessage): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
  try {
    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.postMessage(event);
    channel.close();
  } catch {
    // Ignore BroadcastChannel errors
  }
}

/**
 * Authenticated Multi-Device & Multi-Tab Real-Time Transport
 */
export class HealthSyncRealtimeClient {
  private ws: WebSocket | null = null;
  private bc: BroadcastChannel | null = null;
  private reconnectTimer: number | null = null;
  private httpPollTimer: number | null = null;
  private lastDeltaSyncMs = 0;
  private reconnectAttempts = 0;
  private destroyed = false;
  private sessionToken: string;
  private onMessageCallback: (msg: RealtimeEventMessage) => void;

  constructor(sessionToken: string, onMessage: (msg: RealtimeEventMessage) => void) {
    this.sessionToken = sessionToken;
    this.onMessageCallback = onMessage;

    if (typeof window !== 'undefined') {
      if ('BroadcastChannel' in window) {
        try {
          this.bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
          this.bc.onmessage = (ev) => {
            if (ev?.data && typeof ev.data.type === 'string') {
              this.onMessageCallback(ev.data as RealtimeEventMessage);
            }
          };
        } catch {
          this.bc = null;
        }
      }

      if (this.sessionToken && this.sessionToken !== 'OFFLINE_LOCAL_SESSION') {
        this.connectWebSocket();
      }
    }
  }

  public updateSessionToken(newToken: string): void {
    if (!newToken || this.destroyed) return;
    this.sessionToken = newToken;
  }

  private startServerlessHttpDeltaPolling(): void {
    if (
      this.destroyed ||
      this.httpPollTimer !== null ||
      typeof window === 'undefined' ||
      !this.sessionToken ||
      this.sessionToken === 'OFFLINE_LOCAL_SESSION'
    ) {
      return;
    }
    this.httpPollTimer = window.setInterval(async () => {
      if (
        this.destroyed ||
        !this.sessionToken ||
        this.sessionToken === 'OFFLINE_LOCAL_SESSION' ||
        (typeof navigator !== 'undefined' && !navigator.onLine)
      ) {
        return;
      }
      try {
        const sinceParam = this.lastDeltaSyncMs > 0 ? `?since=${this.lastDeltaSyncMs}` : '';
        const resp = await fetch(`/api/records${sinceParam}`, {
          headers: {Authorization: `Bearer ${this.sessionToken}`},
        });
        if (!resp.ok) return;
        const parsed = await safeReadJson<{records?: TriageRecord[]}>(resp);
        if (parsed.isJson && Array.isArray(parsed.data?.records) && parsed.data.records.length > 0) {
          this.lastDeltaSyncMs = Date.now() - 2_000;
          this.onMessageCallback({
            type: 'sync:init',
            records: parsed.data.records,
            connectedPeers: 1,
          });
        }
      } catch {
        // Ignore transient offline errors during delta polling
      }
    }, 15_000);
  }

  private stopServerlessHttpDeltaPolling(): void {
    if (this.httpPollTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.httpPollTimer);
      this.httpPollTimer = null;
    }
  }

  private connectWebSocket() {
    if (
      this.destroyed ||
      typeof window === 'undefined' ||
      !this.sessionToken ||
      this.sessionToken === 'OFFLINE_LOCAL_SESSION'
    ) {
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // SECURITY FIX: Never place session tokens in the WebSocket URL query string.
      // Authenticate post-upgrade over an in-band WebSocket frame.
      const wsUrl = `${protocol}//${window.location.host}/ws/triage`;
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.destroyed || socket.readyState !== WebSocket.OPEN) return;
        this.stopServerlessHttpDeltaPolling();
        socket.send(
          JSON.stringify({
            type: 'auth',
            token: this.sessionToken,
          })
        );
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as RealtimeEventMessage;
          if (parsed.type === 'sync:init') {
            this.reconnectAttempts = 0;
            this.lastDeltaSyncMs = Date.now() - 2_000;
          }
          this.onMessageCallback(parsed);
        } catch (err) {
          console.warn('[HealthSync WS] Ignored malformed JSON frame from server:', err);
        }
      };

      socket.onerror = () => {
        // Handled cleanly in onclose with HTTP delta-sync fallback
      };

      socket.onclose = (event) => {
        if (this.destroyed || event.code === 4001 || event.code === 4003) {
          return;
        }
        if (this.reconnectAttempts < 8) {
          const delayMs = Math.min(30_000, 3_000 * 2 ** this.reconnectAttempts);
          this.reconnectAttempts += 1;
          if (this.reconnectAttempts >= 2) {
            // Fall back to authenticated HTTP delta-sync on serverless runtimes without persistent WebSockets
            this.startServerlessHttpDeltaPolling();
          }
          this.reconnectTimer = window.setTimeout(() => {
            this.connectWebSocket();
          }, delayMs);
        } else {
          this.startServerlessHttpDeltaPolling();
        }
      };
    } catch (err) {
      console.warn('[HealthSync WS] WebSocket unavailable; using HTTP delta polling:', err);
      this.startServerlessHttpDeltaPolling();
    }
  }

   public async publishRecordCreated(
    record: TriageRecord,
    triggerEmergencySiren: boolean,
    incentive?: IncentiveEntry
  ): Promise<{
    ok: boolean;
    record?: TriageRecord;
    incentive?: IncentiveEntry;
    error?: string;
    retryable?: boolean;
  }> {
    const payload: RealtimeEventMessage = {
      type: 'record:created',
      record,
      triggerEmergencySiren,
    };

    try {
      this.bc?.postMessage(payload);
    } catch {
      // Ignore BroadcastChannel cloning issues
    }

    if (!this.sessionToken || this.sessionToken === 'OFFLINE_LOCAL_SESSION') {
      const offlineMsg = 'Offline local session: record queued locally until server sign-in.';
      this.onMessageCallback({
        type: 'sync:error',
        recordId: record.id,
        error: offlineMsg,
        retryable: true,
      });
      return {ok: false, error: offlineMsg, retryable: true};
    }

    try {
      const resp = await fetch('/api/records', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify({record, triggerEmergencySiren, incentive}),
      });

      const parsed = await safeReadJson<{
        ok?: boolean;
        record?: TriageRecord;
        incentive?: IncentiveEntry;
        error?: string;
      }>(resp);

      if (!parsed.isJson) {
        const unavailableMsg =
          'Server sync endpoint unavailable on this connection; record safely queued offline.';
        this.onMessageCallback({
          type: 'sync:error',
          recordId: record.id,
          error: unavailableMsg,
          retryable: true,
        });
        return {ok: false, error: unavailableMsg, retryable: true};
      }

      const body = parsed.data || {};
      if (!resp.ok) {
        const errMsg = body.error || `Server rejected triage sync (HTTP ${resp.status}).`;
        const retryable = resp.status >= 500 || resp.status === 429;
        console.warn('[HealthSync Sync Notice] Record sync deferred:', errMsg);
        this.onMessageCallback({
          type: 'sync:error',
          recordId: record.id,
          error: errMsg,
          retryable,
        });
        return {ok: false, error: errMsg, retryable};
      }

      const savedRecord: TriageRecord = body.record ?? {
        ...record,
        syncStatus: record.channel === 'Emergency SMS' ? 'SMS Delivered' : 'Synced',
      };
      this.onMessageCallback({
        type: 'sync:ack',
        recordId: savedRecord.id,
        record: savedRecord,
      });
      return {ok: true, record: savedRecord, incentive: body.incentive};
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Network error while syncing triage record.';
      console.warn('[HealthSync Sync Notice] Network unavailable; record queued locally:', errMsg);
      this.onMessageCallback({
        type: 'sync:error',
        recordId: record.id,
        error: errMsg,
        retryable: true,
      });
      return {ok: false, error: errMsg, retryable: true};
    }
  }

  public async publishRecordDispatched(
    recordId: string,
    ambulanceUnit = '108-AMB-UP65',
    etaMinutes = 11,
    fallbackRecord?: TriageRecord
  ): Promise<TriageRecord | null> {
    const relayUpdated = await dispatchRecordInDistrictRelay(recordId, ambulanceUnit, etaMinutes);
    const localPatched =
      relayUpdated ??
      (fallbackRecord
        ? {
            ...fallbackRecord,
            dispatchStatus: 'Dispatched' as const,
            ambulanceUnit,
            etaMinutes,
          }
        : null);

    if (!this.sessionToken || this.sessionToken === 'OFFLINE_LOCAL_SESSION') {
      if (localPatched) {
        try {
          this.bc?.postMessage({type: 'record:updated', record: localPatched});
        } catch {
          // Ignore
        }
      }
      return localPatched;
    }
    try {
      const resp = await fetch(`/api/records/${encodeURIComponent(recordId)}/dispatch`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify({ambulanceUnit, etaMinutes}),
      });
      if (!resp.ok) {
        if (localPatched) {
          try {
            this.bc?.postMessage({type: 'record:updated', record: localPatched});
          } catch {
            // Ignore
          }
        }
        return localPatched;
      }
      const parsed = await safeReadJson<{record?: TriageRecord}>(resp);
      if (parsed.isJson && parsed.data?.record) {
        void upsertRecordsInDistrictRelay([parsed.data.record]);
        this.bc?.postMessage({type: 'record:updated', record: parsed.data.record});
        return parsed.data.record;
      }
      return localPatched;
    } catch {
      if (localPatched) {
        try {
          this.bc?.postMessage({type: 'record:updated', record: localPatched});
        } catch {
          // Ignore
        }
      }
      return localPatched;
    }
  }

  public destroy() {
    this.destroyed = true;
    this.stopServerlessHttpDeltaPolling();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }
    try {
      this.bc?.close();
    } catch {
      // Ignore
    }
    try {
      this.ws?.close();
    } catch {
      // Ignore
    }
  }
}
