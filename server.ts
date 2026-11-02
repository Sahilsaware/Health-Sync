import 'dotenv/config';
import crypto from 'crypto';
import express, {type NextFunction, type Request, type Response} from 'express';
import fs from 'fs';
import helmet from 'helmet';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';
import {WebSocketServer, WebSocket} from 'ws';
import {
  HealthSyncDatabase,
  type AuthenticatedUser,
  type ServerUserRole,
} from './src/server/db.ts';
import {
  buildServerClinicalFallbackSummary,
  generateClinicalTriageSummary,
} from './src/server/geminiService.ts';
import {
  dispatchEmergencySms,
  getConfiguredSmsGatewayStatus,
  maskPhoneNumber,
  parseInboundSmsWebhookToRecord,
  SmsAuthorizationError,
  verifyInboundSmsWebhookAuth,
} from './src/server/smsGateway.ts';
import {isAllowedVillageCode, type IncentiveEntry, type TriageRecord} from './src/types/triage.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AuthedRequest extends Request {
  authUser?: AuthenticatedUser;
  rawToken?: string;
}

class RecordAuthorizationError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = 'RecordAuthorizationError';
    this.statusCode = statusCode;
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

export const DEFAULT_DMO_PROVISIONING_SECRET = 'SWASTHYA-DMO-2026';
export const DEFAULT_ASHA_ENROLLMENT_SECRET = 'SWASTHYA-ASHA-2026';

function timingSafeVerifySecret(configuredRaw: string | undefined, providedCode: string, placeholder: string): boolean {
  const configured = configuredRaw?.trim() || '';
  if (!configured || configured.length < 12 || configured === placeholder) {
    return false;
  }
  if (!providedCode) return false;
  const expectedDigest = crypto.createHash('sha256').update(configured, 'utf8').digest();
  const actualDigest = crypto.createHash('sha256').update(providedCode, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, actualDigest);
}

function verifyDmoProvisioningSecret(providedCode: string): boolean {
  const customConfigured = process.env.DMO_PROVISIONING_SECRET?.trim() || '';
  if (customConfigured && customConfigured !== 'MY_DMO_PROVISIONING_SECRET') {
    return timingSafeVerifySecret(
      customConfigured,
      providedCode,
      'MY_DMO_PROVISIONING_SECRET'
    );
  }
  return timingSafeVerifySecret(
    DEFAULT_DMO_PROVISIONING_SECRET,
    String(providedCode || '').trim().toUpperCase(),
    'MY_DMO_PROVISIONING_SECRET'
  );
}

function verifyAshaEnrollmentSecret(providedCode: string): boolean {
  const customConfigured = process.env.ASHA_ENROLLMENT_SECRET?.trim() || '';
  if (customConfigured && customConfigured !== 'MY_ASHA_ENROLLMENT_SECRET') {
    return timingSafeVerifySecret(
      customConfigured,
      providedCode,
      'MY_ASHA_ENROLLMENT_SECRET'
    );
  }
  return timingSafeVerifySecret(
    DEFAULT_ASHA_ENROLLMENT_SECRET,
    String(providedCode || '').trim().toUpperCase(),
    'MY_ASHA_ENROLLMENT_SECRET'
  );
}

/**
 * Resolves Express `trust proxy` safely for the actual deployment environment:
 * - Honors explicit `TRUST_PROXY` env var (`false`, `true`, hop count `1`, `loopback`, or CIDR).
 * - Uses `1` (single trusted edge proxy hop) on Vercel, Cloud Run (`K_SERVICE`), or `NODE_ENV=production`
 *   so rate limiters see the true client IP without allowing leftmost `X-Forwarded-For` spoofing.
 * - Defaults to `false` on direct local connections so local callers cannot spoof `X-Forwarded-For`.
 */
export function resolveTrustProxySetting(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw !== undefined && raw !== '') {
    if (raw === 'true') return 1; // Cap boolean 'true' to 1 hop to prevent XFF spoofing
    if (raw === 'false') return false;
    const asNum = Number(raw);
    if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 10) return asNum;
    return raw;
  }
  if (process.env.VERCEL || process.env.K_SERVICE || process.env.NODE_ENV === 'production') {
    return 1;
  }
  return false;
}

function getTrustedClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function resolveFrameAncestors(): string[] {
  const custom = process.env.CSP_FRAME_ANCESTORS?.trim();
  if (custom) {
    return custom.split(/\s+/).filter(Boolean);
  }
  if (process.env.NODE_ENV !== 'production' && !process.env.VITEST) {
    return ["'self'", 'https://aistudio.google.com', 'https://*.google.com'];
  }
  return ["'self'"];
}

/**
 * Enforces Object-Level Authorization (BOLA / IDOR protection), village validation,
 * and field-level RBAC on triage records.
 */
function authorizeAndSanitizeRecordWrite(
  db: HealthSyncDatabase,
  user: AuthenticatedUser,
  incoming: TriageRecord
): {sanitized: TriageRecord; ownerIdentifier: string} {
  if (user.role === 'ASHA' && !user.isVerified) {
    throw new RecordAuthorizationError(
      'Forbidden: Unverified ASHA accounts cannot create or modify triage records.',
      403
    );
  }

  const cleanVillage = String(incoming.villageCode || user.villageCode || '').trim().toUpperCase();
  if (!isAllowedVillageCode(cleanVillage)) {
    throw new RecordAuthorizationError('Invalid clinic villageCode in triage record.', 400);
  }

  const cleanPatientName = String(incoming.patientName || '').trim();
  if (!cleanPatientName || cleanPatientName.length > 100) {
    throw new RecordAuthorizationError('Valid patientName (1-100 chars) is required.', 400);
  }

  const existing = db.getRecordWithOwner(incoming.id);

  if (existing) {
    if (user.role !== 'DMO') {
      if (!existing.ownerIdentifier || existing.ownerIdentifier !== user.identifier) {
        throw new RecordAuthorizationError(
          'Forbidden: You cannot modify or overwrite triage records belonging to another worker.'
        );
      }
      if (
        incoming.dispatchStatus &&
        incoming.dispatchStatus !== existing.record.dispatchStatus &&
        incoming.dispatchStatus === 'Dispatched'
      ) {
        throw new RecordAuthorizationError(
          'Forbidden: Only District Medical Officers (DMO) can authorize ambulance dispatch.'
        );
      }
      const sanitized: TriageRecord = {
        ...incoming,
        villageCode: cleanVillage,
        patientName: cleanPatientName,
        ashaWorker: `${user.displayName} (${user.identifier})`,
        dispatchStatus: existing.record.dispatchStatus,
        ambulanceUnit: existing.record.ambulanceUnit,
        etaMinutes: existing.record.etaMinutes,
      };
      return {sanitized, ownerIdentifier: existing.ownerIdentifier};
    }

    return {
      sanitized: {
        ...incoming,
        villageCode: cleanVillage,
        patientName: cleanPatientName,
      },
      ownerIdentifier: existing.ownerIdentifier,
    };
  }

  if (user.role !== 'DMO') {
    const sanitized: TriageRecord = {
      ...incoming,
      villageCode: cleanVillage,
      patientName: cleanPatientName,
      ashaWorker: `${user.displayName} (${user.identifier})`,
      dispatchStatus: 'Unassigned',
      ambulanceUnit: undefined,
      etaMinutes: undefined,
    };
    return {sanitized, ownerIdentifier: user.identifier};
  }

  return {
    sanitized: {
      ...incoming,
      villageCode: cleanVillage,
      patientName: cleanPatientName,
      dispatchStatus: incoming.dispatchStatus === 'Dispatched' ? 'Dispatched' : 'Unassigned',
    },
    ownerIdentifier: user.identifier,
  };
}

export interface HealthSyncServerOptions {
  heartbeatIntervalMs?: number;
  wsAuthTimeoutMs?: number;
}

export async function createHealthSyncServer(
  customDb?: HealthSyncDatabase,
  options?: HealthSyncServerOptions
) {
  const db = customDb ?? new HealthSyncDatabase();
  await db.hydrateRemoteIfConfigured();

  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 25_000;
  const wsAuthTimeoutMs = options?.wsAuthTimeoutMs ?? 5_000;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', resolveTrustProxySetting());

  const isDev = process.env.NODE_ENV !== 'production';
  const frameAncestors = resolveFrameAncestors();

  // Security Headers via Helmet (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'", 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:', 'mediastream:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          workerSrc: ["'self'", 'blob:'],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors,
        },
      },
      strictTransportSecurity: {
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: true,
      },
      frameguard: {
        action: 'sameorigin',
      },
      noSniff: true,
      referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
      },
      crossOriginOpenerPolicy: {policy: 'same-origin'},
      permittedCrossDomainPolicies: {permittedPolicies: 'none'},
    })
  );

  // Explicit Permissions-Policy restricting sensitive browser APIs strictly to same-origin
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()'
    );
    next();
  });

  app.use(express.json({limit: '256kb'}));
  app.use(express.urlencoded({extended: false, limit: '256kb'}));

  // Serve public PWA assets (/icon.svg, /pwa-192x192.png, etc.) reliably in dev & prod
  app.use(express.static(path.join(__dirname, 'public')));

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({noServer: true});
  const clients = new Map<WebSocket, AuthenticatedUser>();
  const trackedSockets = new Set<WebSocket>();
  const socketAlive = new WeakMap<WebSocket, boolean>();

  const broadcastJson = (payload: unknown, exclude?: WebSocket) => {
    const serialized = JSON.stringify(payload);
    for (const [client] of clients) {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  };

  const broadcastToDmoOfficers = (payload: unknown) => {
    const serialized = JSON.stringify(payload);
    for (const [client, clientUser] of clients) {
      if (client.readyState === WebSocket.OPEN && clientUser.role === 'DMO') {
        client.send(serialized);
      }
    }
  };

  const disconnectSocketsForUserId = (userId: string, reason = 'Session revoked') => {
    for (const [sock, user] of Array.from(clients.entries())) {
      if (user.id === userId) {
        clients.delete(sock);
        trackedSockets.delete(sock);
        try {
          sock.close(4001, reason);
        } catch {
          sock.terminate();
        }
      }
    }
  };

  /**
   * Scopes patient PHI WebSocket broadcasts strictly to authorized, verified recipients:
   * all connected DMO officers + the specific verified ASHA worker who owns the record.
   */
  const broadcastRecordEvent = (
    payload: unknown,
    ownerIdentifier: string,
    exclude?: WebSocket
  ) => {
    const serialized = JSON.stringify(payload);
    for (const [client, clientUser] of clients) {
      if (client === exclude || client.readyState !== WebSocket.OPEN) continue;
      if (clientUser.role === 'ASHA' && !clientUser.isVerified) continue;
      if (
        clientUser.role === 'DMO' ||
        (ownerIdentifier !== '' && clientUser.identifier === ownerIdentifier)
      ) {
        client.send(serialized);
      }
    }
  };

  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    const user = db.verifySessionToken(token);
    if (!user) {
      res.status(401).json({error: 'Unauthorized: Valid session token required.'});
      return;
    }
    req.authUser = user;
    req.rawToken = token ?? undefined;
    next();
  };

  const requireVerifiedUser = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      res.status(401).json({error: 'Unauthorized: Valid session token required.'});
      return;
    }
    if (req.authUser.role === 'ASHA' && !req.authUser.isVerified) {
      res.status(403).json({
        error:
          'Forbidden: ASHA account is pending verification. Submit a valid Clinic Enrollment Code or request District Medical Officer approval before accessing patient records or emergency alerts.',
      });
      return;
    }
    next();
  };

  // --- TIERED, PROXY-AWARE RATE LIMITERS (PERSISTED IN SQLITE BUCKETS) ---
  const AUTH_WINDOW_MS = 15 * 60 * 1000;
  const AUTH_MAX_FAILURES_PER_IP = 15;
  const REG_MAX_ATTEMPTS_PER_IP = 15;

  const authFailureGuard = (req: Request, res: Response, next: NextFunction) => {
    const ip = getTrustedClientIp(req);
    const check = db.peekRateLimitBucket(`auth_fail_ip:${ip}`, AUTH_MAX_FAILURES_PER_IP);
    if (check.blocked) {
      res.setHeader('Retry-After', String(check.retryAfterSeconds));
      res.status(429).json({error: 'Too many authentication attempts. Try again later.'});
      return;
    }
    next();
  };

  const registrationAbuseLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = getTrustedClientIp(req);
    // Counts BOTH successful and failed registration requests so attackers cannot mass-create accounts
    const regCheck = db.consumeRateLimitBucket(
      `reg_attempt_ip:${ip}`,
      REG_MAX_ATTEMPTS_PER_IP,
      AUTH_WINDOW_MS
    );
    if (!regCheck.allowed) {
      res.setHeader('Retry-After', String(regCheck.retryAfterSeconds));
      res.status(429).json({
        error: 'Too many authentication attempts or account registrations from this network. Try again later.',
      });
      return;
    }
    next();
  };

  const recordAuthFailure = (req: Request) => {
    const ip = getTrustedClientIp(req);
    db.consumeRateLimitBucket(`auth_fail_ip:${ip}`, AUTH_MAX_FAILURES_PER_IP, AUTH_WINDOW_MS);
  };

  const clearAuthFailuresForIp = (req: Request) => {
    const ip = getTrustedClientIp(req);
    db.resetRateLimitBucket(`auth_fail_ip:${ip}`);
  };

  const geminiRateLimiter = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const ip = getTrustedClientIp(req);
    const userId = req.authUser?.id || 'anon';
    const userBucket = db.consumeRateLimitBucket(`gemini_user:${userId}`, 10, 15 * 60 * 1000);
    const ipBucket = db.consumeRateLimitBucket(`gemini_ip:${ip}`, 15, 15 * 60 * 1000);
    if (!userBucket.allowed || !ipBucket.allowed) {
      const retryAfter = Math.max(userBucket.retryAfterSeconds, ipBucket.retryAfterSeconds);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Rate limit exceeded for AI clinical summaries. Please wait before requesting another summary.',
      });
      return;
    }
    next();
  };

  const smsSendRateLimiter = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const ip = getTrustedClientIp(req);
    const userId = req.authUser?.id || 'anon';
    const userShort = db.consumeRateLimitBucket(`sms_user_15m:${userId}`, 5, 15 * 60 * 1000);
    const ipShort = db.consumeRateLimitBucket(`sms_ip_15m:${ip}`, 8, 15 * 60 * 1000);
    const userDaily = db.consumeRateLimitBucket(`sms_user_24h:${userId}`, 15, 24 * 60 * 60 * 1000);
    if (!userShort.allowed || !ipShort.allowed || !userDaily.allowed) {
      const retryAfter = Math.max(
        userShort.retryAfterSeconds,
        ipShort.retryAfterSeconds,
        !userDaily.allowed ? userDaily.retryAfterSeconds : 0
      );
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Emergency SMS rate limit reached to prevent carrier abuse. Use native device GSM SMS if urgent.',
      });
      return;
    }
    next();
  };

  const safeRoute =
    (
      fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void> | void
    ) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        Promise.resolve(fn(req as AuthedRequest, res, next)).catch(next);
      } catch (err) {
        next(err);
      }
    };

  // --- PROTECTED HEALTH & AUTH STATUS ROUTES (NO SENSITIVE INFO LEAKAGE) ---
  app.get(
    '/api/health',
    safeRoute((req, res) => {
      const caller = db.verifySessionToken(extractBearerToken(req));
      if (caller?.role === 'DMO') {
        res.json({
          status: 'ok',
          connectedDevices: clients.size,
          persistenceMode: db.getPersistenceMode(),
          smsGateway: getConfiguredSmsGatewayStatus({includeSensitive: false}),
        });
        return;
      }
      // Public liveness check exposes zero device counts, gateway providers, or phone numbers
      res.json({status: 'ok'});
    })
  );

  app.get(
    '/api/auth/status',
    safeRoute((req, res) => {
      const caller = db.verifySessionToken(extractBearerToken(req));
      if (caller?.role === 'DMO') {
        const configuredDmoSecret =
          process.env.DMO_PROVISIONING_SECRET?.trim() || DEFAULT_DMO_PROVISIONING_SECRET;
        const configuredAshaSecret =
          process.env.ASHA_ENROLLMENT_SECRET?.trim() || DEFAULT_ASHA_ENROLLMENT_SECRET;
        res.json({
          status: 'ok',
          authRequired: true,
          minSecretLength: 8,
          dmoProvisioningEnabled:
            configuredDmoSecret.length >= 12 &&
            configuredDmoSecret !== 'MY_DMO_PROVISIONING_SECRET',
          ashaEnrollmentConfigured:
            configuredAshaSecret.length >= 12 &&
            configuredAshaSecret !== 'MY_ASHA_ENROLLMENT_SECRET',
          pendingAshaVerifications: db.listPendingAshaUsers().length,
          smsGateway: getConfiguredSmsGatewayStatus({includeSensitive: false}),
        });
        return;
      }
      res.json({
        status: 'ok',
        authRequired: true,
        minSecretLength: 8,
      });
    })
  );

  // --- AUTHENTICATION, VERIFICATION & SESSION SECURITY ROUTES ---
  app.post(
    '/api/auth/register',
    authFailureGuard,
    registrationAbuseLimiter,
    async (req, res) => {
      const ip = getTrustedClientIp(req);
      try {
        const {
          identifier,
          secret,
          role,
          displayName,
          villageCode,
          dmoProvisioningCode,
          ashaEnrollmentCode,
        } = req.body || {};

        if (role !== 'ASHA' && role !== 'DMO') {
          recordAuthFailure(req);
          res.status(400).json({error: 'Role must be ASHA or DMO.'});
          return;
        }

        const caller = db.verifySessionToken(extractBearerToken(req));
        const isAuthorizedByExistingDmo = caller?.role === 'DMO';

        if (role === 'DMO') {
          const headerSecret =
            typeof req.headers['x-dmo-provisioning-secret'] === 'string'
              ? req.headers['x-dmo-provisioning-secret'].trim()
              : '';
          const providedSecret = headerSecret || String(dmoProvisioningCode || '').trim();
          const isAuthorizedByProvisioningSecret = verifyDmoProvisioningSecret(providedSecret);

          if (!isAuthorizedByExistingDmo && !isAuthorizedByProvisioningSecret) {
            recordAuthFailure(req);
            db.appendAuditLog({
              actorId: String(identifier || 'unauthenticated').slice(0, 80),
              actorRole: 'UNAUTHENTICATED',
              action: 'DMO_REGISTRATION_DENIED',
              targetType: 'user',
              targetId: String(identifier || 'unknown').slice(0, 80),
              rawIp: ip,
            });
            res.status(403).json({
              error:
                'Forbidden: District Medical Officer (DMO) registration requires an authenticated DMO administrator or valid Hospital Authorization Code.',
            });
            return;
          }
        }

        // ASHA Verification Gate: Verified immediately ONLY if enrolled by a DMO or holding a valid Clinic Enrollment Code
        let ashaVerified = false;
        let verifiedBy: string | undefined;
        if (role === 'ASHA') {
          const headerEnrollment =
            typeof req.headers['x-asha-enrollment-code'] === 'string'
              ? req.headers['x-asha-enrollment-code'].trim()
              : '';
          const providedEnrollment = headerEnrollment || String(ashaEnrollmentCode || '').trim();

          if (isAuthorizedByExistingDmo) {
            ashaVerified = true;
            verifiedBy = caller!.identifier;
          } else if (providedEnrollment) {
            if (!verifyAshaEnrollmentSecret(providedEnrollment)) {
              recordAuthFailure(req);
              res.status(403).json({
                error: 'Invalid Clinic Enrollment Code for ASHA verification.',
              });
              return;
            }
            ashaVerified = true;
            verifiedBy = 'CLINIC_ENROLLMENT_CODE';
          }
        }

        const createdUser = await db.registerUser({
          identifier: String(identifier || ''),
          secret: String(secret || ''),
          role: role as ServerUserRole,
          displayName: String(displayName || ''),
          villageCode: villageCode !== undefined ? String(villageCode) : '',
          verified: role === 'DMO' ? true : ashaVerified,
          verifiedBy: role === 'DMO' ? caller?.identifier || 'DMO_PROVISIONING_SECRET' : verifiedBy,
        });

        const session = await db.authenticateUser(
          String(identifier || ''),
          String(secret || ''),
          role as ServerUserRole
        );

        db.appendAuditLog({
          actorId: createdUser.identifier,
          actorRole: createdUser.role,
          action: 'USER_REGISTERED',
          targetType: 'user',
          targetId: createdUser.id,
          rawIp: ip,
          metadata: {
            villageCode: createdUser.villageCode,
            isVerified: createdUser.isVerified,
          },
        });
        await db.flushDurableWrites();

        if (createdUser.role === 'ASHA') {
          broadcastToDmoOfficers({
            type: 'asha:roster_updated',
            worker: {
              id: createdUser.id,
              identifier: createdUser.identifier,
              displayName: createdUser.displayName,
              villageCode: createdUser.villageCode,
              isVerified: createdUser.isVerified,
              createdAtMs: Date.now(),
            },
          });
        }

        res.status(201).json(session);
      } catch (err) {
        recordAuthFailure(req);
        const msg = err instanceof Error ? err.message : 'Registration failed.';
        res.status(400).json({error: msg});
      }
    }
  );

  app.post('/api/auth/login', authFailureGuard, async (req, res) => {
    const ip = getTrustedClientIp(req);
    try {
      const {identifier, secret, role} = req.body || {};
      if (role !== 'ASHA' && role !== 'DMO') {
        recordAuthFailure(req);
        res.status(400).json({error: 'Role must be ASHA or DMO.'});
        return;
      }
      const session = await db.authenticateUser(
        String(identifier || ''),
        String(secret || ''),
        role as ServerUserRole
      );

      clearAuthFailuresForIp(req);
      db.appendAuditLog({
        actorId: session.user.identifier,
        actorRole: session.user.role,
        action: 'USER_LOGIN_SUCCESS',
        targetType: 'session',
        targetId: session.user.id,
        rawIp: ip,
      });
      await db.flushDurableWrites();

      res.json(session);
    } catch {
      recordAuthFailure(req);
      db.appendAuditLog({
        actorId: String(req.body?.identifier || 'unknown').slice(0, 80),
        actorRole: String(req.body?.role || 'UNKNOWN').slice(0, 16),
        action: 'USER_LOGIN_FAILED',
        targetType: 'user',
        targetId: String(req.body?.identifier || 'unknown').slice(0, 80),
        rawIp: ip,
      });
      // Always return uniform generic 401 message to prevent account enumeration
      res.status(401).json({error: 'Invalid credentials.'});
    }
  });

  app.get(
    '/api/auth/me',
    requireAuth,
    safeRoute((req: AuthedRequest, res) => {
      res.json({user: req.authUser});
    })
  );

  app.post(
    '/api/auth/rotate-session',
    requireAuth,
    safeRoute(async (req: AuthedRequest, res) => {
      const rotated = db.rotateSessionToken(req.rawToken);
      if (!rotated) {
        res.status(401).json({error: 'Session expired or invalid.'});
        return;
      }
      db.appendAuditLog({
        actorId: rotated.user.identifier,
        actorRole: rotated.user.role,
        action: 'SESSION_ROTATED',
        targetType: 'session',
        targetId: rotated.user.id,
        rawIp: getTrustedClientIp(req),
      });
      await db.flushDurableWrites();
      res.json({ok: true, ...rotated});
    })
  );

  app.post(
    '/api/auth/logout',
    requireAuth,
    safeRoute(async (req: AuthedRequest, res) => {
      db.revokeSessionToken(req.rawToken);
      db.appendAuditLog({
        actorId: req.authUser!.identifier,
        actorRole: req.authUser!.role,
        action: 'USER_LOGOUT',
        targetType: 'session',
        targetId: req.authUser!.id,
        rawIp: getTrustedClientIp(req),
      });
      await db.flushDurableWrites();
      res.json({ok: true});
    })
  );

  app.post(
    '/api/auth/logout-all',
    requireAuth,
    safeRoute(async (req: AuthedRequest, res) => {
      const revokedSessions = db.revokeAllUserSessions(req.authUser!.id);
      disconnectSocketsForUserId(req.authUser!.id, 'Logged out from all devices');
      db.appendAuditLog({
        actorId: req.authUser!.identifier,
        actorRole: req.authUser!.role,
        action: 'USER_LOGOUT_ALL_DEVICES',
        targetType: 'user',
        targetId: req.authUser!.id,
        rawIp: getTrustedClientIp(req),
        metadata: {revokedSessions},
      });
      await db.flushDurableWrites();
      res.json({ok: true, revokedSessions});
    })
  );

  // Self-verification for pending ASHA accounts holding a Clinic Enrollment Code
  app.post(
    '/api/auth/verify-asha',
    requireAuth,
    authFailureGuard,
    safeRoute(async (req: AuthedRequest, res) => {
      if (req.authUser?.role !== 'ASHA') {
        res.status(400).json({error: 'Only ASHA accounts use Clinic Enrollment verification.'});
        return;
      }
      const code = String(req.body?.ashaEnrollmentCode || '').trim();
      if (!verifyAshaEnrollmentSecret(code)) {
        recordAuthFailure(req);
        res.status(403).json({error: 'Invalid or unconfigured Clinic Enrollment Code.'});
        return;
      }

      const updatedUser = db.setAshaVerificationStatus(
        req.authUser.identifier,
        true,
        'CLINIC_ENROLLMENT_CODE'
      );
      if (!updatedUser) {
        res.status(404).json({error: 'ASHA account not found.'});
        return;
      }

      // Rotate session token immediately upon privilege/verification elevation
      const rotated = db.rotateSessionToken(req.rawToken);
      db.appendAuditLog({
        actorId: updatedUser.identifier,
        actorRole: 'ASHA',
        action: 'ASHA_ACCOUNT_VERIFIED_BY_CODE',
        targetType: 'user',
        targetId: updatedUser.id,
        rawIp: getTrustedClientIp(req),
      });
      await db.flushDurableWrites();

      broadcastToDmoOfficers({
        type: 'asha:roster_updated',
        worker: {
          id: updatedUser.id,
          identifier: updatedUser.identifier,
          displayName: updatedUser.displayName,
          villageCode: updatedUser.villageCode,
          isVerified: true,
          createdAtMs: Date.now(),
        },
      });

      res.json({
        ok: true,
        user: updatedUser,
        token: rotated?.token,
        expiresAtMs: rotated?.expiresAtMs,
      });
    })
  );

  // DMO Administrative ASHA Directory & Pending Verification Queue
  app.get(
    '/api/auth/asha/workers',
    requireAuth,
    safeRoute((req: AuthedRequest, res) => {
      if (req.authUser?.role !== 'DMO') {
        res.status(403).json({
          error: 'Forbidden: Only DMO officers can inspect registered ASHA workers.',
        });
        return;
      }
      const workers = db.listAshaWorkers();
      res.json({
        workers,
        pending: workers.filter((w) => !w.isVerified),
      });
    })
  );

  // DMO Administrative ASHA Verification Queue & Approval
  app.get(
    '/api/auth/asha/pending',
    requireAuth,
    safeRoute((req: AuthedRequest, res) => {
      if (req.authUser?.role !== 'DMO') {
        res.status(403).json({error: 'Forbidden: Only DMO officers can review pending ASHA accounts.'});
        return;
      }
      res.json({pending: db.listPendingAshaUsers()});
    })
  );

  app.post(
    '/api/auth/asha/:identifier/verify',
    requireAuth,
    safeRoute(async (req: AuthedRequest, res) => {
      if (req.authUser?.role !== 'DMO') {
        res.status(403).json({error: 'Forbidden: Only DMO officers can verify ASHA accounts.'});
        return;
      }
      const approve = req.body?.verified !== false;
      const updated = db.setAshaVerificationStatus(
        req.params.identifier,
        approve,
        req.authUser.identifier
      );
      if (!updated) {
        res.status(404).json({error: 'ASHA account not found.'});
        return;
      }
      if (!approve) {
        db.revokeAllUserSessions(updated.id);
        disconnectSocketsForUserId(updated.id, 'ASHA verification revoked by DMO');
      }
      db.appendAuditLog({
        actorId: req.authUser.identifier,
        actorRole: 'DMO',
        action: approve ? 'ASHA_APPROVED_BY_DMO' : 'ASHA_REVOKED_BY_DMO',
        targetType: 'user',
        targetId: updated.identifier,
        rawIp: getTrustedClientIp(req),
      });
      await db.flushDurableWrites();
      broadcastToDmoOfficers({
        type: 'asha:roster_updated',
        worker: {
          id: updated.id,
          identifier: updated.identifier,
          displayName: updated.displayName,
          villageCode: updated.villageCode,
          isVerified: updated.isVerified,
          createdAtMs: Date.now(),
        },
      });
      res.json({ok: true, user: updated});
    })
  );

  // --- TRIAGE RECORDS, CONSENT, INCENTIVES & SECURE DPDP ERASURE ---
  app.get(
    '/api/records',
    requireAuth,
    requireVerifiedUser,
    safeRoute((req: AuthedRequest, res) => {
      const rawSince = req.query.since ? Number(req.query.since) : undefined;
      const sinceMs =
        rawSince !== undefined && Number.isFinite(rawSince) && rawSince > 0 ? rawSince : undefined;
      res.json({records: db.listRecordsForUser(req.authUser!, 500, sinceMs)});
    })
  );

  app.post('/api/records', requireAuth, requireVerifiedUser, async (req: AuthedRequest, res) => {
    const {record, triggerEmergencySiren, incentive} = req.body || {};
    if (!record || typeof record.id !== 'string' || !record.id.trim() || !record.vitals) {
      res.status(400).json({error: 'Invalid triage record payload.'});
      return;
    }

    try {
      const {sanitized, ownerIdentifier} = authorizeAndSanitizeRecordWrite(
        db,
        req.authUser!,
        record as TriageRecord
      );

      // DPDP Section 9: Validate & persist verifiable parent/guardian consent for minors (< 18)
      db.validateAndPersistConsent(sanitized, req.authUser!.identifier);

      // Server-side incentive validation BEFORE or atomic with record save (never trust client IDs or amountInr)
      let savedIncentive: IncentiveEntry | undefined;
      if (incentive !== undefined && incentive !== null) {
        if (req.authUser!.role !== 'ASHA') {
          res.status(403).json({
            error: 'Forbidden: Only verified ASHA workers can submit field visit stipends.',
          });
          return;
        }
        savedIncentive = db.recordVerifiedTriageIncentive({
          record: sanitized,
          ownerUser: req.authUser!,
          clientSubmittedIncentive: incentive as Partial<IncentiveEntry>,
        });
      }

      const saved = db.upsertRecord(sanitized, ownerIdentifier);
      if (!savedIncentive && req.authUser!.role === 'ASHA') {
        savedIncentive = db.recordVerifiedTriageIncentive({
          record: saved,
          ownerUser: req.authUser!,
        });
      }

      const allowSiren = Boolean(triggerEmergencySiren) && saved.severity === 'emergency';

      db.appendAuditLog({
        actorId: req.authUser!.identifier,
        actorRole: req.authUser!.role,
        action: 'TRIAGE_RECORD_SAVED',
        targetType: 'triage_record',
        targetId: saved.id,
        rawIp: getTrustedClientIp(req),
        metadata: {
          severity: saved.severity,
          villageCode: saved.villageCode,
          isMinor: Number(saved.age) < 18,
          sirenTriggered: allowSiren,
        },
      });
      await db.flushDurableWrites();

      broadcastRecordEvent(
        {
          type: 'record:created',
          record: saved,
          triggerEmergencySiren: allowSiren,
        },
        ownerIdentifier
      );
      res.status(201).json({ok: true, record: saved, incentive: savedIncentive});
    } catch (err) {
      if (err instanceof RecordAuthorizationError) {
        res.status(err.statusCode).json({error: err.message});
        return;
      }
      const msg = err instanceof Error ? err.message : '';
      if (
        msg.includes('DPDP Section 9') ||
        msg.includes('Invalid stipend') ||
        msg.includes('Forbidden')
      ) {
        res.status(msg.startsWith('Forbidden') ? 403 : 400).json({error: msg});
        return;
      }
      console.warn('[HealthSync DB Warning] Failed to save triage record via POST /api/records:', err);
      res.status(500).json({error: 'Database error: Failed to persist triage record.'});
    }
  });

  app.patch('/api/records/:id/dispatch', requireAuth, async (req: AuthedRequest, res) => {
    if (req.authUser?.role !== 'DMO') {
      res.status(403).json({error: 'Forbidden: Only DMO officers can dispatch ambulances.'});
      return;
    }
    try {
      const existingWithOwner = db.getRecordWithOwner(req.params.id);
      if (!existingWithOwner) {
        res.status(404).json({error: 'Triage record not found.'});
        return;
      }
      const cleanUnit = String(req.body?.ambulanceUnit || '108-AMB-UP65')
        .replace(/[^\w-]/g, '')
        .slice(0, 32);
      const safeEta = Math.min(180, Math.max(1, Math.round(Number(req.body?.etaMinutes) || 11)));

      const updated: TriageRecord = {
        ...existingWithOwner.record,
        dispatchStatus: 'Dispatched',
        ambulanceUnit: cleanUnit || '108-AMB-UP65',
        etaMinutes: safeEta,
      };
      db.upsertRecord(updated, existingWithOwner.ownerIdentifier);
      db.appendAuditLog({
        actorId: req.authUser.identifier,
        actorRole: 'DMO',
        action: 'AMBULANCE_DISPATCHED',
        targetType: 'triage_record',
        targetId: updated.id,
        rawIp: getTrustedClientIp(req),
        metadata: {ambulanceUnit: updated.ambulanceUnit, etaMinutes: updated.etaMinutes},
      });
      await db.flushDurableWrites();

      broadcastRecordEvent(
        {type: 'record:updated', record: updated},
        existingWithOwner.ownerIdentifier
      );
      res.json({ok: true, record: updated});
    } catch (err) {
      console.warn('[HealthSync DB Warning] Failed to update dispatch status:', err);
      res.status(500).json({error: 'Database error: Failed to persist ambulance dispatch.'});
    }
  });

  // DPDP Section 8 / Section 12: Authorized Patient Data Deletion with Immutable Audit Trail
  app.delete('/api/records/:id', requireAuth, async (req: AuthedRequest, res) => {
    if (req.authUser?.role !== 'DMO') {
      res.status(403).json({
        error:
          'Forbidden: Only District Medical Officers (Data Fiduciary) can authorize permanent patient data erasure.',
      });
      return;
    }
    try {
      const reason = String(
        req.body?.reason || req.query?.reason || 'DPDP Section 8 patient erasure request'
      ).trim();
      const result = db.deleteRecordSecurely({
        recordId: req.params.id,
        actor: req.authUser,
        reason,
        rawIp: getTrustedClientIp(req),
      });
      if (!result.deleted) {
        res.status(404).json({error: 'Patient triage record not found.'});
        return;
      }
      await db.flushDurableWrites();
      broadcastJson({type: 'record:deleted', recordId: req.params.id});
      res.json({
        ok: true,
        deletedRecordId: req.params.id,
        patientId: result.patientId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to erase patient record.';
      res.status(400).json({error: msg});
    }
  });

  app.get(
    '/api/incentives',
    requireAuth,
    requireVerifiedUser,
    safeRoute((req: AuthedRequest, res) => {
      if (req.authUser?.role === 'DMO') {
        res.json({incentives: db.listIncentives()});
        return;
      }
      res.json({incentives: db.listIncentives(req.authUser!.identifier)});
    })
  );

  // --- DPDP COMPLIANCE: AUDIT LOGS & DATA BREACH REPORTING (DMO ONLY) ---
  app.get(
    '/api/compliance/audit-logs',
    requireAuth,
    safeRoute((req: AuthedRequest, res) => {
      if (req.authUser?.role !== 'DMO') {
        res.status(403).json({error: 'Forbidden: Only DMO officers can inspect security audit logs.'});
        return;
      }
      const limit = Number(req.query.limit) || 100;
      const integrity = db.verifyAuditChain();
      res.json({
        integrity,
        logs: db.listAuditLogs(limit),
      });
    })
  );

  app.post('/api/compliance/breach-report', requireAuth, async (req: AuthedRequest, res) => {
    if (req.authUser?.role !== 'DMO') {
      res.status(403).json({error: 'Forbidden: Only DMO officers can file DPDP data breach reports.'});
      return;
    }
    try {
      const {
        severity,
        incidentType,
        affectedRecordsEstimate,
        description,
        containmentActions,
        dpbNotified,
        affectedPrincipalsNotified,
      } = req.body || {};

      const allowedSeverities = ['low', 'medium', 'high', 'critical'] as const;
      const cleanSeverity = allowedSeverities.includes(severity) ? severity : 'high';

      const report = db.createBreachReport({
        reportedBy: req.authUser.identifier,
        severity: cleanSeverity,
        incidentType: String(incidentType || ''),
        affectedRecordsEstimate: Number(affectedRecordsEstimate) || 0,
        description: String(description || ''),
        containmentActions: String(containmentActions || ''),
        dpbNotified: Boolean(dpbNotified),
        affectedPrincipalsNotified: Boolean(affectedPrincipalsNotified),
      });

      db.appendAuditLog({
        actorId: req.authUser.identifier,
        actorRole: 'DMO',
        action: 'DPDP_BREACH_REPORT_FILED',
        targetType: 'breach_report',
        targetId: report.id,
        rawIp: getTrustedClientIp(req),
        metadata: {
          severity: report.severity,
          incidentType: report.incidentType,
          affectedRecordsEstimate: report.affectedRecordsEstimate,
        },
      });
      await db.flushDurableWrites();

      res.status(201).json({
        ok: true,
        report,
        statutoryObligations: {
          certInNotificationDeadlineHours: 6,
          dataProtectionBoardDeadlineHours: 72,
          affectedDataPrincipalsNotificationRequired: true,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to file breach report.';
      res.status(400).json({error: msg});
    }
  });

  app.get(
    '/api/compliance/breach-reports',
    requireAuth,
    safeRoute((req: AuthedRequest, res) => {
      if (req.authUser?.role !== 'DMO') {
        res.status(403).json({error: 'Forbidden: Only DMO officers can view breach reports.'});
        return;
      }
      res.json({reports: db.listBreachReports(50)});
    })
  );

  const attachOptionalAuth = (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    const verified = token ? db.verifySessionToken(token) : null;
    if (verified) {
      req.authUser = verified;
    }
    next();
  };

  // --- SERVER-SIDE GEMINI CLINICAL CO-PILOT (DPDP ANONYMIZED, SUPPORTS AUTHED & DEMO SESSIONS) ---
  const handleClinicalSummaryRequest = safeRoute(async (req: AuthedRequest, res: Response) => {
    const {
      patientName,
      age,
      vitals,
      symptoms,
      edgeAi,
      transcript,
      language,
      explicitAiConsent,
      lawfulBasis,
    } = req.body || {};

    if (!vitals || typeof vitals.systolic !== 'number') {
      res.status(400).json({error: 'Patient vitals are required for clinical summary.'});
      return;
    }

    const isMinor = age !== undefined && Number(age) < 18;
    // Only allow identifiable patientName when caller holds a verified session AND explicit adult consent
    const isVerifiedSession = Boolean(req.authUser && req.authUser.isVerified !== false);
    const verifiedConsent =
      isVerifiedSession && !isMinor && explicitAiConsent === true && Boolean(lawfulBasis);

    const summaryInput = {
      // Never pass identifiable patientName unless verified session + explicit adult consent exist
      patientName: verifiedConsent ? patientName : undefined,
      age,
      vitals,
      symptoms: Array.isArray(symptoms) ? symptoms : [],
      edgeAi,
      transcript,
      language,
      explicitAiConsent: verifiedConsent,
      lawfulBasis: verifiedConsent ? lawfulBasis : undefined,
    };

    try {
      db.appendAuditLog({
        actorId: req.authUser?.identifier || 'DEMO_OR_LOCAL_SESSION',
        actorRole: req.authUser?.role || 'DEMO',
        action: 'GEMINI_CLINICAL_SUMMARY_REQUESTED',
        targetType: 'ai_copilot',
        targetId: 'gemini-3.8-flash',
        rawIp: getTrustedClientIp(req),
        metadata: {
          authenticated: Boolean(req.authUser),
          anonymized: !verifiedConsent,
          isMinor,
        },
      });

      const summary = await generateClinicalTriageSummary(summaryInput);
      res.status(200).json({
        success: true,
        isDemoFallback: false,
        data: summary,
        ...summary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini clinical summary failed.';
      console.warn(
        `[HealthSync AI Fallback] Gemini unavailable (${msg}); returning built-in clinical protocol fallback.`
      );
      const fallback = buildServerClinicalFallbackSummary(summaryInput);
      res.status(200).json({
        success: true,
        isDemoFallback: true,
        data: fallback,
        ...fallback,
      });
    }
  });

  app.post(
    ['/api/gemini/clinical-summary', '/api/ai/care-summary', '/api/triage/summary'],
    attachOptionalAuth,
    geminiRateLimiter,
    handleClinicalSummaryRequest
  );

  // --- SECURED EMERGENCY SMS GATEWAY & AUTHENTICATED INBOUND WEBHOOK ---
  app.post(
    '/api/sms/send',
    requireAuth,
    requireVerifiedUser,
    smsSendRateLimiter,
    async (req: AuthedRequest, res) => {
      const {payloadText, recordId, toPhone} = req.body || {};
      if (!payloadText || typeof payloadText !== 'string') {
        res.status(400).json({error: 'SMS payloadText is required.'});
        return;
      }

      try {
        const cleanRecordId = typeof recordId === 'string' && recordId.trim() ? recordId.trim() : null;
        if (cleanRecordId) {
          const existing = db.getRecordWithOwner(cleanRecordId);
          if (!existing) {
            res.status(404).json({error: 'Referenced emergency triage record not found.'});
            return;
          }
          if (
            req.authUser!.role !== 'DMO' &&
            existing.ownerIdentifier !== req.authUser!.identifier
          ) {
            res.status(403).json({
              error: 'Forbidden: Cannot dispatch SMS for another worker’s triage record.',
            });
            return;
          }
          if (existing.record.severity !== 'emergency') {
            res.status(403).json({
              error: 'Forbidden: Carrier SMS dispatch is restricted to emergency records.',
            });
            return;
          }
          if (db.hasSentOutboundCarrierSmsForRecord(cleanRecordId)) {
            res.status(409).json({
              error: 'Duplicate SMS blocked: Emergency carrier SMS was already sent for this record.',
            });
            return;
          }
        }

        const outcome = await dispatchEmergencySms({
          db,
          payloadText,
          recordId: cleanRecordId,
          requestedToPhone: toPhone !== undefined ? String(toPhone) : undefined,
        });

        db.appendAuditLog({
          actorId: req.authUser!.identifier,
          actorRole: req.authUser!.role,
          action: 'EMERGENCY_SMS_DISPATCH',
          targetType: 'sms',
          targetId: cleanRecordId || 'adhoc-emergency-frame',
          rawIp: getTrustedClientIp(req),
          metadata: {
            provider: outcome.provider,
            sent: outcome.sent,
          },
        });
        await db.flushDurableWrites();

        res.json({
          success: true,
          isDemoFallback: !outcome.gatewayConfigured || !outcome.sent,
          data: outcome,
          ...outcome,
        });
      } catch (err) {
        if (err instanceof SmsAuthorizationError) {
          res.status(err.statusCode).json({error: err.message});
          return;
        }
        const msg = err instanceof Error ? err.message : 'SMS dispatch failed.';
        console.warn('[HealthSync SMS] Rejected or failed SMS request:', msg);
        res.status(400).json({error: msg});
      }
    }
  );

  app.get(
    '/api/sms/logs',
    requireAuth,
    safeRoute((req: AuthedRequest, res) => {
      if (req.authUser?.role !== 'DMO') {
        res.status(403).json({error: 'Forbidden: Only DMO officers can inspect district SMS logs.'});
        return;
      }
      const rawLogs = db.listSmsDispatches(30).map((item) => ({
        ...item,
        toPhone: item.toPhone.includes('•') ? item.toPhone : maskPhoneNumber(item.toPhone),
      }));
      res.json({
        logs: rawLogs,
        gateway: getConfiguredSmsGatewayStatus({includeSensitive: false}),
      });
    })
  );

  // Carrier inbound webhook requires Twilio HMAC-SHA1 or SMS_WEBHOOK_SECRET
  app.post('/api/sms/webhook', async (req, res) => {
    const webhookAuth = verifyInboundSmsWebhookAuth({
      headers: req.headers,
      protocol: req.protocol,
      host: req.get('host') || 'localhost',
      originalUrl: req.originalUrl,
      body: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>,
    });

    if (!webhookAuth.authorized) {
      res.status(401).json({error: webhookAuth.error || 'Unauthorized SMS webhook request.'});
      return;
    }

    try {
      const rawBody = String(req.body?.Body ?? req.body?.body ?? '').trim();
      const fromPhone = String(req.body?.From ?? req.body?.from ?? 'GSM-MODEM').trim();
      const providerMessageId =
        String(
          req.body?.MessageSid ??
            req.body?.SmsSid ??
            req.body?.MessageId ??
            req.body?.request_id ??
            ''
        ).trim() || null;
      if (!rawBody) {
        res.status(400).json({error: 'Empty inbound SMS body.'});
        return;
      }

      const record = parseInboundSmsWebhookToRecord(maskPhoneNumber(fromPhone), rawBody, {
        providerMessageId,
      });
      const existingRecord = db.getRecordWithOwner(record.id);

      if (existingRecord || db.hasSmsDispatchForRecord(record.id, 'inbound_webhook')) {
        res.type('text/xml').send('<Response></Response>');
        return;
      }

      db.upsertRecord(record, '');
      db.logSmsDispatch({
        recordId: record.id,
        toPhone: maskPhoneNumber(fromPhone),
        provider: 'inbound_webhook',
        status: 'received',
        providerMessageId,
        payloadText: rawBody,
        errorMessage: null,
      });
      db.appendAuditLog({
        actorId: 'CARRIER_SMS_WEBHOOK',
        actorRole: 'SYSTEM',
        action: 'INBOUND_SMS_TRIAGE_RECEIVED',
        targetType: 'triage_record',
        targetId: record.id,
        rawIp: getTrustedClientIp(req),
        metadata: {
          authMethod: webhookAuth.method,
          severity: record.severity,
        },
      });
      await db.flushDurableWrites();

      broadcastRecordEvent(
        {
          type: 'record:created',
          record,
          triggerEmergencySiren: record.severity === 'emergency',
        },
        ''
      );
      res.type('text/xml').send('<Response></Response>');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid SMS payload';
      res.status(400).json({error: msg});
    }
  });

  // Ensure any unknown /api/* route or malformed JSON payload always returns valid JSON (never HTML/plain text)
  app.use('/api', (_req, res) => {
    res.status(404).json({error: 'Requested API endpoint was not found.'});
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      const status =
        typeof (err as {status?: number})?.status === 'number'
          ? (err as {status: number}).status
          : 500;
      const msg =
        status >= 500
          ? 'Unexpected server error.'
          : err instanceof Error
          ? err.message
          : 'Invalid request.';
      console.warn(`[HealthSync API Boundary] ${req.method} ${req.path} -> HTTP ${status}:`, msg);
      if (!res.headersSent) {
        res.status(status).json({error: msg});
      }
      return;
    }
    next(err);
  });

  // --- AUTHENTICATED WEBSOCKET SERVER WITH VERIFIED-ASHA GATE & ZOMBIE REAPING ---
  const sendSafeJson = (sock: WebSocket, payload: unknown) => {
    if (sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(JSON.stringify(payload));
      } catch (err) {
        console.warn('[HealthSync WS] Failed to send frame:', err);
      }
    }
  };

  const activateAuthenticatedSocket = (ws: WebSocket, user: AuthenticatedUser) => {
    clients.set(ws, user);
    sendSafeJson(ws, {
      type: 'sync:init',
      records: db.listRecordsForUser(user),
      connectedPeers: clients.size,
    });
    broadcastJson({type: 'presence:count', connectedPeers: clients.size}, ws);
  };

  wss.on('connection', (ws: WebSocket, initialUser: AuthenticatedUser | null) => {
    trackedSockets.add(ws);
    socketAlive.set(ws, true);

    ws.on('pong', () => {
      socketAlive.set(ws, true);
    });

    let authedUser: AuthenticatedUser | null = initialUser ?? null;
    let authDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

    if (authedUser) {
      if (authedUser.role === 'ASHA' && !authedUser.isVerified) {
        sendSafeJson(ws, {
          type: 'auth:error',
          error: 'Forbidden: ASHA account is pending verification.',
        });
        ws.close(4003, 'ASHA verification required');
        return;
      }
      activateAuthenticatedSocket(ws, authedUser);
    } else {
      authDeadlineTimer = setTimeout(() => {
        if (!authedUser) {
          sendSafeJson(ws, {
            type: 'auth:error',
            error: 'Authentication timeout: No valid auth frame received.',
          });
          try {
            ws.close(4001, 'Authentication timeout');
          } catch {
            ws.terminate();
          }
        }
      }, wsAuthTimeoutMs);
      authDeadlineTimer.unref?.();
    }

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch (err) {
        console.warn('[HealthSync WS] Malformed JSON message received:', err);
        sendSafeJson(ws, {
          type: 'sync:error',
          recordId: null,
          error: 'Malformed WebSocket JSON payload.',
          retryable: false,
        });
        return;
      }

      if (!authedUser) {
        if (msg.type === 'auth' && typeof msg.token === 'string') {
          const verified = db.verifySessionToken(msg.token);
          if (!verified) {
            sendSafeJson(ws, {
              type: 'auth:error',
              error: 'Unauthorized: Invalid or expired session token.',
            });
            ws.close(4001, 'Unauthorized');
            return;
          }
          if (verified.role === 'ASHA' && !verified.isVerified) {
            sendSafeJson(ws, {
              type: 'auth:error',
              error: 'Forbidden: Unverified ASHA accounts cannot stream live hospital alerts.',
            });
            ws.close(4003, 'ASHA verification required');
            return;
          }
          if (authDeadlineTimer) {
            clearTimeout(authDeadlineTimer);
            authDeadlineTimer = null;
          }
          authedUser = verified;
          activateAuthenticatedSocket(ws, verified);
          return;
        }

        sendSafeJson(ws, {
          type: 'auth:error',
          error: 'Unauthorized: Authenticate first via { type: "auth", token }.',
        });
        ws.close(4001, 'Unauthorized');
        return;
      }

      // Re-verify active user verification status in case DMO revoked account mid-connection
      const freshSession =
        typeof msg.token === 'string' ? db.verifySessionToken(msg.token) : authedUser;
      if (!freshSession || (freshSession.role === 'ASHA' && !freshSession.isVerified)) {
        sendSafeJson(ws, {
          type: 'auth:error',
          error: 'Session expired or account verification revoked.',
        });
        ws.close(4001, 'Unauthorized');
        return;
      }

      const incomingRec = msg.record as TriageRecord | undefined;
      const incomingRecordId =
        incomingRec && typeof incomingRec.id === 'string' ? incomingRec.id : null;

      try {
        if (msg.type === 'record:created' && incomingRec?.id && incomingRec?.vitals) {
          const {sanitized, ownerIdentifier} = authorizeAndSanitizeRecordWrite(
            db,
            authedUser,
            incomingRec
          );
          db.validateAndPersistConsent(sanitized, authedUser.identifier);
          const saved = db.upsertRecord(sanitized, ownerIdentifier);
          if (authedUser.role === 'ASHA') {
            db.recordVerifiedTriageIncentive({record: saved, ownerUser: authedUser});
          }
          const allowSiren =
            Boolean(msg.triggerEmergencySiren) && saved.severity === 'emergency';

          db.appendAuditLog({
            actorId: authedUser.identifier,
            actorRole: authedUser.role,
            action: 'WS_TRIAGE_RECORD_SAVED',
            targetType: 'triage_record',
            targetId: saved.id,
            metadata: {severity: saved.severity, sirenTriggered: allowSiren},
          });

          sendSafeJson(ws, {
            type: 'sync:ack',
            recordId: saved.id,
            record: saved,
          });
          broadcastRecordEvent(
            {
              type: 'record:created',
              record: saved,
              triggerEmergencySiren: allowSiren,
            },
            ownerIdentifier,
            ws
          );
        } else if (msg.type === 'record:updated' && incomingRec?.id && incomingRec?.vitals) {
          if (authedUser.role !== 'DMO') {
            sendSafeJson(ws, {
              type: 'sync:error',
              recordId: incomingRecordId,
              error: 'Forbidden: Only DMO officers can update dispatch records.',
              retryable: false,
            });
            return;
          }
          const {sanitized, ownerIdentifier} = authorizeAndSanitizeRecordWrite(
            db,
            authedUser,
            incomingRec
          );
          const saved = db.upsertRecord(sanitized, ownerIdentifier);
          sendSafeJson(ws, {
            type: 'sync:ack',
            recordId: saved.id,
            record: saved,
          });
          broadcastRecordEvent({type: 'record:updated', record: saved}, ownerIdentifier, ws);
        }
      } catch (err) {
        if (err instanceof RecordAuthorizationError) {
          sendSafeJson(ws, {
            type: 'sync:error',
            recordId: incomingRecordId,
            error: err.message,
            retryable: false,
          });
          return;
        }
        const errMsg = err instanceof Error ? err.message : '';
        if (errMsg.includes('DPDP Section 9')) {
          sendSafeJson(ws, {
            type: 'sync:error',
            recordId: incomingRecordId,
            error: errMsg,
            retryable: false,
          });
          return;
        }
        console.warn(
          '[HealthSync WS Sync Warning] Database write failed during WebSocket sync:',
          err
        );
        sendSafeJson(ws, {
          type: 'sync:error',
          recordId: incomingRecordId,
          error: 'Database error: Failed to persist triage record.',
          retryable: true,
        });
      }
    });

    const cleanupSocket = () => {
      if (authDeadlineTimer) {
        clearTimeout(authDeadlineTimer);
        authDeadlineTimer = null;
      }
      trackedSockets.delete(ws);
      if (clients.delete(ws)) {
        broadcastJson({type: 'presence:count', connectedPeers: clients.size});
      }
    };

    ws.on('close', cleanupSocket);
    ws.on('error', (err) => {
      console.warn('[HealthSync WS] Socket transport closed with warning:', err);
      cleanupSocket();
    });
  });

  // Periodic ping/pong heartbeat to detect and reap dropped/zombie mobile sockets
  const heartbeatTimer = setInterval(() => {
    let prunedAuthedClient = false;
    for (const sock of Array.from(trackedSockets)) {
      if (socketAlive.get(sock) === false) {
        trackedSockets.delete(sock);
        if (clients.delete(sock)) {
          prunedAuthedClient = true;
        }
        try {
          sock.terminate();
        } catch {
          // Ignore termination error on dead socket
        }
        continue;
      }

      socketAlive.set(sock, false);
      if (sock.readyState === WebSocket.OPEN) {
        try {
          sock.ping();
        } catch {
          // Will be terminated on next sweep if broken
        }
      }
    }
    if (prunedAuthedClient) {
      broadcastJson({type: 'presence:count', connectedPeers: clients.size});
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  let heartbeatStopped = false;
  const stopWebSocketHeartbeat = () => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    clearInterval(heartbeatTimer);
    for (const sock of Array.from(trackedSockets)) {
      trackedSockets.delete(sock);
      try {
        sock.terminate();
      } catch {
        // Ignore
      }
    }
    clients.clear();
  };

  httpServer.on('close', stopWebSocketHeartbeat);
  wss.on('close', stopWebSocketHeartbeat);

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const parsedUrl = new URL(request.url || '/', 'http://localhost');
      if (parsedUrl.pathname === '/ws/triage') {
        if (parsedUrl.searchParams.has('token')) {
          socket.write(
            'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nSession tokens must not be passed in URL query parameters.\r\n'
          );
          socket.destroy();
          return;
        }

        const headerAuth =
          typeof request.headers.authorization === 'string' &&
          request.headers.authorization.startsWith('Bearer ')
            ? request.headers.authorization.slice(7).trim()
            : null;

        let initialUser: AuthenticatedUser | null = null;
        if (headerAuth) {
          initialUser = db.verifySessionToken(headerAuth);
          if (!initialUser) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
          if (initialUser.role === 'ASHA' && !initialUser.isVerified) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, initialUser);
        });
      }
    } catch (err) {
      console.warn('[HealthSync WS Upgrade Warning]:', err);
      socket.destroy();
    }
  });

  return {app, httpServer, db};
}

async function startServer() {
  const {app, httpServer} = await createHealthSyncServer();

  if (process.env.NODE_ENV !== 'production') {
    const {createServer: createViteServer} = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : {server: httpServer, path: '/__vite_hmr'},
        watch: hmrDisabled ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    const indexHtmlPath = path.join(distPath, 'index.html');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      if (fs.existsSync(indexHtmlPath)) {
        res.sendFile(indexHtmlPath);
      } else {
        res.status(503).send('Production bundle not built yet.');
      }
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`HealthSync Edge Server & SQLite Vault listening on http://0.0.0.0:${PORT}`);
  });
}

// Only auto-listen when executed as main entry point (not when imported by Vitest)
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  process.on('unhandledRejection', (reason) => {
    console.warn('[HealthSync Process Guard] Unhandled promise rejection intercepted:', reason);
  });
  startServer().catch((err) => {
    console.error('[HealthSync Fatal Startup Error]:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
