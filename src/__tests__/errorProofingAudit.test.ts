import {AddressInfo} from 'net';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {createHealthSyncServer} from '../../server';
import {
  GlobalErrorBoundary,
  sanitizeBrowserStorageForRecovery,
} from '../components/GlobalErrorBoundary';
import {HealthSyncDatabase} from '../server/db';
import {evaluateTriage, evaluateVitalStatus} from '../types/triage';
import {
  DEFAULT_OFFLINE_ASHA_ENROLLMENT_CODE,
  DEFAULT_OFFLINE_DMO_AUTH_CODE,
  hasOfflineLoginVerifier,
  saveOfflineLoginVerifier,
  verifyOfflineDmoAuthorizationCode,
  verifyOfflineLogin,
} from '../utils/cryptoVault';
import {
  dispatchRecordInDistrictRelay,
  DISTRICT_RELAY_VAULT_KEY,
  loadEncryptedDistrictRelay,
  setWorkerVerifiedInDistrictRelay,
  upsertRecordsInDistrictRelay,
  upsertWorkerInDistrictRelay,
} from '../utils/realtimeSync';
import {
  safeFetchWithFallback,
  safeParseJson,
  safeReadLocalStorage,
  safeReadSessionStorage,
} from '../utils/safeFetchJson';
import {sirenEngine} from '../utils/sirenAudio';
import {
  createBrowserSpeechRecognition,
  isBrowserSpeechRecognitionSupported,
  parseClinicalTranscript,
} from '../utils/speechEngine';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  public get length(): number {
    return this.store.size;
  }

  public clear(): void {
    this.store.clear();
  }

  public getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  public key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  public removeItem(key: string): void {
    this.store.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe('Codebase Error-Proofing & Stabilization Audit', () => {
  it('safely parses corrupt JSON in localStorage/sessionStorage and protects cryptoVault', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prevWindow = (globalThis as {window?: unknown}).window;
    const prevLocalStorage = (globalThis as {localStorage?: Storage}).localStorage;
    const prevSessionStorage = (globalThis as {sessionStorage?: Storage}).sessionStorage;

    const mockLocal = new MemoryStorage();
    const mockSession = new MemoryStorage();

    try {
      Object.defineProperty(globalThis, 'localStorage', {
        value: mockLocal,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: mockSession,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'window', {
        value: {
          localStorage: mockLocal,
          sessionStorage: mockSession,
        },
        configurable: true,
        writable: true,
      });

      mockLocal.setItem('healthsync_corrupt_arr', '{corrupt-json');
      mockLocal.setItem('healthsync_offline_verifiers_v2', 'not-valid-json{{{');
      mockLocal.setItem('healthsync_valid_vault', JSON.stringify({cipher: 'AES-256-GCM-OK'}));
      mockSession.setItem('healthsync_active_session_v1', '{broken-session');

      expect(safeParseJson('{corrupt', [] as string[])).toEqual([]);
      expect(safeParseJson('[1,2,3]', {} as Record<string, unknown>)).toEqual({});
      expect(safeReadLocalStorage('healthsync_corrupt_arr', [] as string[])).toEqual([]);
      expect(
        safeReadSessionStorage('healthsync_active_session_v1', {} as Record<string, unknown>)
      ).toEqual({});

      // cryptoVault should never crash on corrupted verifier JSON
      await expect(hasOfflineLoginVerifier('ASHA-8842-UP', 'ASHA')).resolves.toBe(false);

      // Recovery sanitizer removes strictly corrupted healthsync_* entries while preserving valid vaults
      sanitizeBrowserStorageForRecovery();
      expect(mockLocal.getItem('healthsync_corrupt_arr')).toBeNull();
      expect(mockLocal.getItem('healthsync_offline_verifiers_v2')).toBeNull();
      expect(mockLocal.getItem('healthsync_valid_vault')).toBe(
        JSON.stringify({cipher: 'AES-256-GCM-OK'})
      );
      expect(mockSession.getItem('healthsync_active_session_v1')).toBeNull();
    } finally {
      warnSpy.mockRestore();
      if (prevWindow === undefined) {
        delete (globalThis as {window?: unknown}).window;
      } else {
        Object.defineProperty(globalThis, 'window', {
          value: prevWindow,
          configurable: true,
          writable: true,
        });
      }
      if (prevLocalStorage === undefined) {
        delete (globalThis as {localStorage?: Storage}).localStorage;
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          value: prevLocalStorage,
          configurable: true,
          writable: true,
        });
      }
      if (prevSessionStorage === undefined) {
        delete (globalThis as {sessionStorage?: Storage}).sessionStorage;
      } else {
        Object.defineProperty(globalThis, 'sessionStorage', {
          value: prevSessionStorage,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  it('evaluates triage and vital statuses defensively when inputs are undefined or partial', () => {
    const fallbackResult = evaluateTriage(undefined, undefined, undefined);
    expect(fallbackResult.severity).toBe('routine');
    expect(fallbackResult.scoreCode).toBe('TR1');
    expect(Array.isArray(fallbackResult.triggers)).toBe(true);

    expect(evaluateVitalStatus('systolic', Number.NaN)).toBe('emergency');
    expect(evaluateVitalStatus('systolic', 120)).toBe('routine');
    expect(evaluateVitalStatus('spo2', 88)).toBe('emergency');
  });

  it('guards SpeechRecognition, transcript parsing, and Web Audio autoplay restrictions', () => {
    expect(parseClinicalTranscript(null)).toEqual({
      vitalsPatch: {},
      detectedSymptoms: [],
      badges: [],
      isEmergencyFirstAidQuery: false,
    });
    expect(parseClinicalTranscript(undefined).detectedSymptoms).toEqual([]);

    // In Node without window SpeechRecognition, availability check returns false cleanly
    expect(isBrowserSpeechRecognitionSupported()).toBe(false);
    expect(createBrowserSpeechRecognition('hi-IN')).toBeNull();

    // Siren engine should never throw when invoked without user gesture in browser-like window
    const prevWindow = (globalThis as {window?: unknown}).window;
    const listeners = new Map<string, EventListener>();
    let audioCtxCreatedCount = 0;

    class MockBrowserAudioContext {
      public state = 'suspended';
      public currentTime = 0;
      public destination = {};
      constructor() {
        audioCtxCreatedCount += 1;
      }
      public resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      public createOscillator() {
        return {
          type: 'triangle',
          frequency: {
            setValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {},
          },
          connect: () => {},
          start: () => {},
          stop: () => {},
          disconnect: () => {},
          onended: null,
        };
      }
      public createGain() {
        return {
          gain: {
            setValueAtTime: () => {},
            linearRampToValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {},
          },
          connect: () => {},
          disconnect: () => {},
        };
      }
    }

    try {
      Object.defineProperty(globalThis, 'window', {
        value: {
          AudioContext: MockBrowserAudioContext,
          addEventListener: (type: string, cb: EventListener) => {
            listeners.set(type, cb);
          },
          removeEventListener: (type: string) => {
            listeners.delete(type);
          },
          setInterval: () => 1,
          clearInterval: () => {},
        },
        configurable: true,
        writable: true,
      });

      sirenEngine.stopSiren();
      // Calling startLoopingSiren before user gesture queues cleanly without throwing
      expect(() => sirenEngine.startLoopingSiren()).not.toThrow();
      // Explicit user-gesture test burst unlocks AudioContext cleanly
      expect(() => sirenEngine.playTestSirenBurst()).not.toThrow();
      expect(audioCtxCreatedCount).toBeGreaterThanOrEqual(1);
      sirenEngine.stopSiren();
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as {window?: unknown}).window;
      } else {
        Object.defineProperty(globalThis, 'window', {
          value: prevWindow,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  it('transitions GlobalErrorBoundary to safe recovery UI with Reset & Reload button on crash', () => {
    const derived = GlobalErrorBoundary.getDerivedStateFromError(
      new Error('Simulated render crash')
    );
    expect(derived.hasError).toBe(true);
    expect(derived.errorMessage).toContain('Simulated render crash');

    const boundaryInstance = new GlobalErrorBoundary({children: React.createElement('div')});
    boundaryInstance.state = derived;
    const html = renderToStaticMarkup(boundaryInstance.render() as React.ReactElement);
    expect(html).toContain('SwasthyaSetu Safe Recovery');
    expect(html).toContain('Reset &amp; Reload App');
  });

  it('returns structured { success: true, isDemoFallback: true, data } on backend and client fetch fallbacks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prevGemKey = process.env.GEMINI_API_KEY;
    const prevTwilioSid = process.env.TWILIO_ACCOUNT_SID;
    const prevFast2Sms = process.env.FAST2SMS_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.FAST2SMS_API_KEY;

    const memDb = new HealthSyncDatabase(':memory:', 'audit-test-master-secret-32-chars!!');
    const {httpServer} = await createHealthSyncServer(memDb);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Care summary endpoint without GEMINI_API_KEY returns HTTP 200 structured fallback
      const careRes = await fetch(`${baseUrl}/api/ai/care-summary`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          age: 61,
          vitals: {systolic: 168, diastolic: 104, spo2: 91, temperature: 101.2, heartRate: 112},
          symptoms: ['Chest Pain', 'Breathlessness'],
        }),
      });
      expect(careRes.status).toBe(200);
      const careBody = (await careRes.json()) as {
        success: boolean;
        isDemoFallback: boolean;
        handoffSummary: string;
        data: {handoffSummary: string; stabilizationSteps: string[]};
      };
      expect(careBody.success).toBe(true);
      expect(careBody.isDemoFallback).toBe(true);
      expect(careBody.data.handoffSummary).toContain('168/104');
      expect(careBody.data.stabilizationSteps.length).toBeGreaterThan(0);

      // 2. safeFetchWithFallback handles unreachable port cleanly with console.warn
      const unreachable = await safeFetchWithFallback(
        'http://127.0.0.1:9/api/unreachable',
        {method: 'GET'},
        {status: 'offline-safe'},
        400
      );
      expect(unreachable.success).toBe(true);
      expect(unreachable.isDemoFallback).toBe(true);
      expect(unreachable.data).toEqual({status: 'offline-safe'});
    } finally {
      warnSpy.mockRestore();
      if (prevGemKey !== undefined) process.env.GEMINI_API_KEY = prevGemKey;
      if (prevTwilioSid !== undefined) process.env.TWILIO_ACCOUNT_SID = prevTwilioSid;
      if (prevFast2Sms !== undefined) process.env.FAST2SMS_API_KEY = prevFast2Sms;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      memDb.close();
    }
  });

  it('authorizes Medical Officer (DMO) registration with SWASTHYA-DMO-2026 both on server and when backend is unavailable', async () => {
    const prevDmoSecret = process.env.DMO_PROVISIONING_SECRET;
    const prevLocalStorage = (globalThis as {localStorage?: Storage}).localStorage;
    delete process.env.DMO_PROVISIONING_SECRET;

    const mockLocal = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocal,
      configurable: true,
      writable: true,
    });

    const memDb = new HealthSyncDatabase(':memory:', 'dmo-auth-code-test-secret-32-chars!!');
    const {httpServer} = await createHealthSyncServer(memDb);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Wrong Hospital Authorization Code is still rejected with 403
      const wrongRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          identifier: 'doctor@district.gov.in',
          secret: 'DoctorSafe#2026',
          role: 'DMO',
          displayName: 'Gr',
          villageCode: 'VIL-204',
          dmoProvisioningCode: 'INVALID-CODE-000',
        }),
      });
      expect(wrongRes.status).toBe(403);

      // 2. Default District 24 Hospital Authorization Code succeeds (201) when env var is unset
      const validRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          identifier: 'doctor@district.gov.in',
          secret: 'DoctorSafe#2026',
          role: 'DMO',
          displayName: 'Gr',
          villageCode: 'VIL-204',
          dmoProvisioningCode: DEFAULT_OFFLINE_DMO_AUTH_CODE.toLowerCase(),
        }),
      });
      expect(validRes.status).toBe(201);
      const session = (await validRes.json()) as {
        token: string;
        user: {identifier: string; role: string; displayName: string; isVerified: boolean};
      };
      expect(session.user.identifier).toBe('doctor@district.gov.in');
      expect(session.user.role).toBe('DMO');
      expect(session.user.displayName).toBe('Gr');
      expect(session.user.isVerified).toBe(true);

      // 3. Offline / backend-unavailable local DMO verifier flow
      await expect(verifyOfflineDmoAuthorizationCode('wrong-code')).resolves.toBe(false);
      await expect(verifyOfflineDmoAuthorizationCode('swasthya-dmo-2026')).resolves.toBe(true);

      await saveOfflineLoginVerifier({
        identifier: 'doctor@district.gov.in',
        role: 'DMO',
        displayName: 'Gr',
        villageCode: 'VIL-204',
        secret: 'DoctorSafe#2026',
        isVerified: true,
      });

      const localDmo = await verifyOfflineLogin({
        identifier: 'doctor@district.gov.in',
        role: 'DMO',
        secret: 'DoctorSafe#2026',
      });
      expect(localDmo.user.role).toBe('DMO');
      expect(localDmo.user.displayName).toBe('Gr');
      expect(localDmo.user.isVerified).toBe(true);
    } finally {
      if (prevDmoSecret !== undefined) process.env.DMO_PROVISIONING_SECRET = prevDmoSecret;
      if (prevLocalStorage === undefined) {
        delete (globalThis as {localStorage?: Storage}).localStorage;
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          value: prevLocalStorage,
          configurable: true,
          writable: true,
        });
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      memDb.close();
    }
  });

  it('connects ASHA workers and triage checkups to DMO dashboard across both live server (/api/auth/asha/workers + WS) and Encrypted District Relay', async () => {
    const prevDmoSecret = process.env.DMO_PROVISIONING_SECRET;
    const prevAshaSecret = process.env.ASHA_ENROLLMENT_SECRET;
    const prevLocalStorage = (globalThis as {localStorage?: Storage}).localStorage;
    delete process.env.DMO_PROVISIONING_SECRET;
    delete process.env.ASHA_ENROLLMENT_SECRET;

    const mockLocal = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocal,
      configurable: true,
      writable: true,
    });

    const {WebSocket: WsClient} = await import('ws');
    const memDb = new HealthSyncDatabase(':memory:', 'dmo-asha-connect-test-key-32-chars!!');
    const {httpServer} = await createHealthSyncServer(memDb);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws/triage`;

    try {
      // 1. Register DMO officer and open authenticated WebSocket
      const dmoReg = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          identifier: 'dmo.command@district.gov.in',
          secret: 'CommandSafe#2026',
          role: 'DMO',
          displayName: 'Dr. Meera Nair',
          villageCode: 'VIL-204',
          dmoProvisioningCode: DEFAULT_OFFLINE_DMO_AUTH_CODE,
        }),
      });
      expect(dmoReg.status).toBe(201);
      const {token: dmoToken} = (await dmoReg.json()) as {token: string};

      const receivedRosterUpdates: Array<{identifier: string; isVerified: boolean}> = [];
      const dmoWs = new WsClient(wsUrl);
      await new Promise<void>((resolve) => {
        dmoWs.on('open', () => {
          dmoWs.send(JSON.stringify({type: 'auth', token: dmoToken}));
        });
        dmoWs.on('message', (raw) => {
          const parsed = JSON.parse(String(raw)) as {
            type?: string;
            worker?: {identifier: string; isVerified: boolean};
          };
          if (parsed.type === 'sync:init') resolve();
          if (parsed.type === 'asha:roster_updated' && parsed.worker) {
            receivedRosterUpdates.push(parsed.worker);
          }
        });
      });

      // 2. Register verified ASHA worker using default Clinic Enrollment Code
      const ashaReg = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          identifier: 'ASHA-7701',
          secret: 'SunitaField#2026',
          role: 'ASHA',
          displayName: 'Sunita Devi',
          villageCode: 'VIL-204',
          ashaEnrollmentCode: DEFAULT_OFFLINE_ASHA_ENROLLMENT_CODE,
        }),
      });
      expect(ashaReg.status).toBe(201);
      const ashaSession = (await ashaReg.json()) as {
        token: string;
        user: {identifier: string; isVerified: boolean};
      };
      expect(ashaSession.user.isVerified).toBe(true);

      // DMO worker directory immediately lists ASHA-7701 as connected & verified
      const workersRes = await fetch(`${baseUrl}/api/auth/asha/workers`, {
        headers: {Authorization: `Bearer ${dmoToken}`},
      });
      expect(workersRes.status).toBe(200);
      const workersBody = (await workersRes.json()) as {
        workers: Array<{identifier: string; displayName: string; isVerified: boolean}>;
      };
      expect(
        workersBody.workers.some(
          (w) => w.identifier === 'ASHA-7701' && w.displayName === 'Sunita Devi' && w.isVerified
        )
      ).toBe(true);

      await new Promise((r) => setTimeout(r, 40));
      expect(
        receivedRosterUpdates.some((w) => w.identifier === 'ASHA-7701' && w.isVerified)
      ).toBe(true);
      dmoWs.close();

      // 3. Verify Encrypted District Relay connects same-device mobile ASHA <-> DMO in OFFLINE_LOCAL_SESSION
      //    with ZERO plaintext PHI or worker names in localStorage!
      await upsertWorkerInDistrictRelay({
        identifier: 'ASHA-LOCAL-99',
        displayName: 'Kavita Verma',
        villageCode: 'VIL-108',
        isVerified: false,
      });
      await setWorkerVerifiedInDistrictRelay('ASHA-LOCAL-99', true, 'dmo.command@district.gov.in');
      await upsertRecordsInDistrictRelay([
        {
          id: 'rec-local-bridge-1',
          patientId: 'PT9901',
          abhaId: '91-8888-7777-6666',
          patientName: 'Savitri Devi',
          age: 54,
          gender: 'F',
          villageCode: 'VIL-108',
          villageName: 'Khajuri Sub-Center',
          ashaWorker: 'Kavita Verma (ASHA-LOCAL-99)',
          vitals: {systolic: 170, diastolic: 106, spo2: 88, temperature: 101.4, heartRate: 114},
          symptoms: ['Severe Chest Pain'],
          severity: 'emergency',
          clinicalNotes: 'Urgent hypoxia referral from local session',
          channel: 'Data',
          syncStatus: 'Queued Offline',
          binarySmsPayload: 'HS#A9901#BP170/106#SPO288#RED',
          timestamp: '10:30 AM',
          createdAtMs: Date.now(),
          dispatchStatus: 'Unassigned',
        },
      ]);

      const rawRelayEnvelope = mockLocal.getItem(DISTRICT_RELAY_VAULT_KEY) || '';
      expect(rawRelayEnvelope.length).toBeGreaterThan(30);
      expect(rawRelayEnvelope).not.toContain('Savitri Devi');
      expect(rawRelayEnvelope).not.toContain('91-8888-7777-6666');
      expect(rawRelayEnvelope).not.toContain('Kavita Verma');

      // DMO dispatches ambulance in offline/local relay -> ASHA & DMO both read updated dispatch status
      const dispatched = await dispatchRecordInDistrictRelay('rec-local-bridge-1', '108-AMB-UP65', 11);
      expect(dispatched?.dispatchStatus).toBe('Dispatched');

      const relayLoadedByDmo = await loadEncryptedDistrictRelay();
      expect(relayLoadedByDmo.workers.some((w) => w.identifier === 'ASHA-LOCAL-99' && w.isVerified)).toBe(true);
      expect(relayLoadedByDmo.records.length).toBe(1);
      expect(relayLoadedByDmo.records[0].patientName).toBe('Savitri Devi');
      expect(relayLoadedByDmo.records[0].dispatchStatus).toBe('Dispatched');
      expect(relayLoadedByDmo.records[0].ambulanceUnit).toBe('108-AMB-UP65');
    } finally {
      if (prevDmoSecret !== undefined) process.env.DMO_PROVISIONING_SECRET = prevDmoSecret;
      if (prevAshaSecret !== undefined) process.env.ASHA_ENROLLMENT_SECRET = prevAshaSecret;
      if (prevLocalStorage === undefined) {
        delete (globalThis as {localStorage?: Storage}).localStorage;
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          value: prevLocalStorage,
          configurable: true,
          writable: true,
        });
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      memDb.close();
    }
  });
});

