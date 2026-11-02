import React, {useEffect, useState} from 'react';
import {
  AlertCircle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  HeartHandshake,
  Lock,
  ShieldCheck,
  Smartphone,
  UserPlus,
} from 'lucide-react';
import {NetworkState, SUB_CENTER_DIRECTORY} from '../types/triage';
import {
  DEFAULT_OFFLINE_ASHA_ENROLLMENT_CODE,
  DEFAULT_OFFLINE_DMO_AUTH_CODE,
  hasOfflineLoginVerifier,
  saveOfflineLoginVerifier,
  validateClientPasscode,
  verifyOfflineAshaEnrollmentCode,
  verifyOfflineDmoAuthorizationCode,
  verifyOfflineLogin,
} from '../utils/cryptoVault';
import {isBackendUnavailableResponse, safeReadJson} from '../utils/safeFetchJson';
import {sirenEngine} from '../utils/sirenAudio';

export interface AuthenticatedSessionPayload {
  token: string;
  user: {
    identifier: string;
    role: 'ASHA' | 'DMO';
    displayName: string;
    villageCode: string;
    isVerified?: boolean;
  };
  vaultKey: CryptoKey;
  salt: Uint8Array;
}

interface LoginPageProps {
  networkState: NetworkState;
  onAuthenticated: (session: AuthenticatedSessionPayload) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({networkState, onAuthenticated}) => {
  const [authMode, setAuthMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');
  const [activeRole, setActiveRole] = useState<'ASHA' | 'DMO'>('ASHA');

  const [identifier, setIdentifier] = useState<string>('');
  const [secret, setSecret] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [villageCode, setVillageCode] = useState<string>('VIL-204');
  const [dmoProvisioningCode, setDmoProvisioningCode] = useState<string>('');
  const [ashaEnrollmentCode, setAshaEnrollmentCode] = useState<string>(
    DEFAULT_OFFLINE_ASHA_ENROLLMENT_CODE
  );
  const [showSecret, setShowSecret] = useState<boolean>(false);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (networkState === 'offline') return;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 6000);
    fetch('/api/auth/status', {signal: controller.signal})
      .then(async (r) => {
        if (!r.ok) return null;
        await safeReadJson<{status?: string}>(r);
        return null;
      })
      .catch(() => {
        // Offline / unreachable status probe ignored gracefully
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [networkState]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    const cleanId = identifier.trim();
    if (!cleanId) {
      setAuthError(
        activeRole === 'ASHA'
          ? 'Please enter your Health Worker ID.'
          : 'Please enter your official hospital email address.'
      );
      return;
    }

    if (authMode === 'REGISTER') {
      const policy = validateClientPasscode(secret);
      if (!policy.valid) {
        setAuthError(policy.error || 'Please enter a stronger passcode (8+ characters with letters & numbers).');
        return;
      }
    } else if (secret.length < 8) {
      setAuthError('Passcodes and passwords must be at least 8 characters long.');
      return;
    }

    if (authMode === 'REGISTER' && activeRole === 'DMO' && !dmoProvisioningCode.trim()) {
      setAuthError(
        'Medical Officer registration requires an official Hospital Authorization Code from District Health Administration.'
      );
      return;
    }

    setSubmitting(true);
    sirenEngine.unlock();

    try {
      const provisionLocalAshaAccount = async () => {
        const normalizedId = cleanId.toUpperCase();
        const trimmedEnrollment = ashaEnrollmentCode.trim();
        let verifiedByCode = false;
        if (trimmedEnrollment) {
          verifiedByCode = await verifyOfflineAshaEnrollmentCode(trimmedEnrollment);
          if (!verifiedByCode) {
            throw new Error('Invalid Clinic Enrollment Code for ASHA verification.');
          }
        }

        if (await hasOfflineLoginVerifier(normalizedId, 'ASHA')) {
          try {
            const existingSession = await verifyOfflineLogin({
              identifier: normalizedId,
              role: 'ASHA',
              secret,
            });
            onAuthenticated({
              token: 'OFFLINE_LOCAL_SESSION',
              user: {
                ...existingSession.user,
                isVerified: verifiedByCode || existingSession.user.isVerified || false,
              },
              vaultKey: existingSession.vaultKey,
              salt: existingSession.salt,
            });
            return;
          } catch {
            throw new Error(
              `Account "${normalizedId}" is already created on this device. Switch to "Sign In" above.`
            );
          }
        }

        const effectiveName = displayName.trim() || `ASHA Worker (${normalizedId})`;
        const effectiveVillage = villageCode.trim() || 'VIL-204';
        const {vaultKey, salt} = await saveOfflineLoginVerifier({
          identifier: normalizedId,
          role: 'ASHA',
          displayName: effectiveName,
          villageCode: effectiveVillage,
          secret,
          isVerified: verifiedByCode,
        });
        onAuthenticated({
          token: 'OFFLINE_LOCAL_SESSION',
          user: {
            identifier: normalizedId,
            role: 'ASHA',
            displayName: effectiveName,
            villageCode: effectiveVillage,
            isVerified: verifiedByCode,
          },
          vaultKey,
          salt,
        });
      };

      const provisionLocalDmoAccount = async () => {
        const normalizedEmail = cleanId.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
          throw new Error('Please enter a valid official hospital email address.');
        }
        const cleanName = displayName.trim();
        if (cleanName.length < 2 || cleanName.length > 80) {
          throw new Error('Full display name is required (2 to 80 characters).');
        }

        const isAuthorized = await verifyOfflineDmoAuthorizationCode(dmoProvisioningCode);
        if (!isAuthorized) {
          throw new Error(
            'Invalid Hospital Authorization Code. Enter the authorized District 24 code to create a Medical Officer account.'
          );
        }

        if (await hasOfflineLoginVerifier(normalizedEmail, 'DMO')) {
          try {
            const existingSession = await verifyOfflineLogin({
              identifier: normalizedEmail,
              role: 'DMO',
              secret,
            });
            onAuthenticated({
              token: 'OFFLINE_LOCAL_SESSION',
              user: {
                ...existingSession.user,
                isVerified: true,
              },
              vaultKey: existingSession.vaultKey,
              salt: existingSession.salt,
            });
            return;
          } catch {
            throw new Error(
              `Account "${normalizedEmail}" is already created on this device. Switch to "Sign In" above.`
            );
          }
        }

        const effectiveVillage = villageCode.trim() || 'VIL-204';
        const {vaultKey, salt} = await saveOfflineLoginVerifier({
          identifier: normalizedEmail,
          role: 'DMO',
          displayName: cleanName,
          villageCode: effectiveVillage,
          secret,
          isVerified: true,
        });
        onAuthenticated({
          token: 'OFFLINE_LOCAL_SESSION',
          user: {
            identifier: normalizedEmail,
            role: 'DMO',
            displayName: cleanName,
            villageCode: effectiveVillage,
            isVerified: true,
          },
          vaultKey,
          salt,
        });
      };

      const signInWithLocalVerifier = async () => {
        if (!(await hasOfflineLoginVerifier(cleanId, activeRole))) {
          throw new Error(
            activeRole === 'ASHA'
              ? `No saved account found for "${cleanId.toUpperCase()}" on this device while the server is unavailable. Switch to "Create Account" above to set up your Health Worker profile.`
              : `No saved Medical Officer account found for "${cleanId.toLowerCase()}" on this device. Switch to "Create Account" above to authorize and set up your Medical Officer profile.`
          );
        }
        const offlineSession = await verifyOfflineLogin({
          identifier: cleanId,
          role: activeRole,
          secret,
        });
        onAuthenticated({
          token: 'OFFLINE_LOCAL_SESSION',
          user: {
            ...offlineSession.user,
            isVerified: activeRole === 'DMO' ? true : offlineSession.user.isVerified,
          },
          vaultKey: offlineSession.vaultKey,
          salt: offlineSession.salt,
        });
      };

      if (networkState === 'offline') {
        if (authMode === 'REGISTER') {
          if (activeRole === 'ASHA') {
            await provisionLocalAshaAccount();
            return;
          }
          await provisionLocalDmoAccount();
          return;
        }
        await signInWithLocalVerifier();
        return;
      }

      const endpoint = authMode === 'REGISTER' ? '/api/auth/register' : '/api/auth/login';
      let resp: Response;
      try {
        resp = await fetch(endpoint, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            identifier: cleanId,
            secret,
            role: activeRole,
            displayName: displayName.trim(),
            villageCode: villageCode.trim() || 'VIL-204',
            ...(authMode === 'REGISTER' && activeRole === 'DMO'
              ? {dmoProvisioningCode: dmoProvisioningCode.trim()}
              : {}),
            ...(authMode === 'REGISTER' && activeRole === 'ASHA' && ashaEnrollmentCode.trim()
              ? {ashaEnrollmentCode: ashaEnrollmentCode.trim()}
              : {}),
          }),
        });
      } catch {
        // Network transport unreachable: fall back to encrypted local device verifier where authorized
        if (authMode === 'REGISTER') {
          if (activeRole === 'ASHA') {
            await provisionLocalAshaAccount();
            return;
          }
          await provisionLocalDmoAccount();
          return;
        }
        await signInWithLocalVerifier();
        return;
      }

      const parsed = await safeReadJson<{
        error?: string;
        token?: string;
        user?: {
          identifier: string;
          role: 'ASHA' | 'DMO';
          displayName: string;
          villageCode: string;
          isVerified?: boolean;
        };
      }>(resp);

      // Handle static-host 404 ("The page could not be found"), cross-site iframe proxy HTML, or gateway 502/503/504 gracefully
      if (isBackendUnavailableResponse(resp, parsed)) {
        if (authMode === 'REGISTER') {
          if (activeRole === 'ASHA') {
            await provisionLocalAshaAccount();
            return;
          }
          await provisionLocalDmoAccount();
          return;
        }
        await signInWithLocalVerifier();
        return;
      }

      const data = parsed?.data || {};
      if (!resp.ok || !data?.token || !data?.user) {
        if (
          authMode === 'LOGIN' &&
          resp.status === 401 &&
          (await hasOfflineLoginVerifier(cleanId, activeRole))
        ) {
          const verifiedLocal = await verifyOfflineLogin({
            identifier: cleanId,
            role: activeRole,
            secret,
          });
          try {
            const syncRegResp = await fetch('/api/auth/register', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({
                identifier: verifiedLocal.user.identifier,
                secret,
                role: activeRole,
                displayName: verifiedLocal.user.displayName,
                villageCode: verifiedLocal.user.villageCode,
                ...(activeRole === 'DMO'
                  ? {dmoProvisioningCode: DEFAULT_OFFLINE_DMO_AUTH_CODE}
                  : verifiedLocal.user.isVerified !== false
                  ? {ashaEnrollmentCode: DEFAULT_OFFLINE_ASHA_ENROLLMENT_CODE}
                  : {}),
              }),
            });
            const syncParsed = await safeReadJson<{
              token?: string;
              user?: {
                identifier: string;
                role: 'ASHA' | 'DMO';
                displayName: string;
                villageCode: string;
                isVerified?: boolean;
              };
            }>(syncRegResp);
            if (
              syncRegResp.ok &&
              syncParsed.isJson &&
              syncParsed.data?.token &&
              syncParsed.data?.user
            ) {
              onAuthenticated({
                token: syncParsed.data.token,
                user: syncParsed.data.user,
                vaultKey: verifiedLocal.vaultKey,
                salt: verifiedLocal.salt,
              });
              return;
            }
          } catch (syncErr) {
            console.warn(
              '[SwasthyaSetu Auth] Auto-registration sync skipped; continuing with local vault session:',
              syncErr
            );
          }
          onAuthenticated({
            token: 'OFFLINE_LOCAL_SESSION',
            user: {
              ...verifiedLocal.user,
              isVerified: activeRole === 'DMO' ? true : Boolean(verifiedLocal.user.isVerified),
            },
            vaultKey: verifiedLocal.vaultKey,
            salt: verifiedLocal.salt,
          });
          return;
        }
        throw new Error(data?.error || 'Could not sign in. Please check your ID and passcode.');
      }

      const safeUser = {
        identifier: data.user?.identifier || cleanId,
        role: data.user?.role || activeRole,
        displayName: data.user?.displayName || displayName.trim() || cleanId,
        villageCode: data.user?.villageCode || villageCode.trim() || 'VIL-204',
        isVerified: data.user?.isVerified,
      };

      const {vaultKey, salt} = await saveOfflineLoginVerifier({
        identifier: safeUser.identifier,
        role: safeUser.role,
        displayName: safeUser.displayName,
        villageCode: safeUser.villageCode,
        secret,
        isVerified: safeUser.isVerified,
      });

      onAuthenticated({
        token: data.token,
        user: safeUser,
        vaultKey,
        salt,
      });
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to sign in right now.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 items-center px-4 py-8 sm:px-6 lg:py-12">
      <div className="grid w-full grid-cols-1 gap-8 lg:grid-cols-12 lg:gap-12 items-start">
        {/* Left Column: Calm, Welcoming Overview */}
        <div id="care-features" className="lg:col-span-6 lg:pt-4 space-y-6">
          <div className="space-y-3">
            <p className="text-sm font-semibold text-teal-700">
              Community &amp; Hospital Care Coordination
            </p>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-4xl leading-tight text-balance">
              Simple, reliable health checkups for rural communities and district hospitals.
            </h1>
            <p className="text-base leading-relaxed text-slate-600 max-w-xl">
              Record vital signs in plain language, get clear guidance on when a patient needs a
              doctor, and keep records safe even when mobile internet is unavailable.
            </p>
          </div>

          <div className="space-y-4 border-t border-slate-200 pt-6">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                <HeartHandshake className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Clear Health Guidance in Everyday Language
                </h2>
                <p className="mt-0.5 text-sm text-slate-600">
                  Blood pressure, oxygen, and temperature readings are explained simply so workers
                  and families know what steps to take next.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Works Smoothly Without Internet
                </h2>
                <p className="mt-0.5 text-sm text-slate-600">
                  Save patient visits during village rounds offline, sync automatically later, or
                  send a compact urgent text message (SMS) over basic mobile signal.
                </p>
              </div>
            </div>

            <div id="privacy-notice" className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Private &amp; Encrypted Patient Information
                </h2>
                <p className="mt-0.5 text-sm text-slate-600">
                  Patient records are encrypted per worker on shared devices and in the hospital
                  database, and health IDs remain masked on screen until needed.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Clean, Accessible Sign In / Create Account Card */}
        <div id="sign-in-card" className="lg:col-span-6 w-full max-w-md mx-auto lg:max-w-none">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xs">
            <div className="space-y-1">
              <h2 className="text-xl font-bold text-slate-900">
                {authMode === 'REGISTER' ? 'Create Your Account' : 'Sign In to SwasthyaSetu'}
              </h2>
              <p className="text-sm text-slate-600">
                Choose your role below to open your care workspace.
              </p>
            </div>

            {/* Sign In vs Create Account Tabs */}
            <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('LOGIN');
                  setAuthError(null);
                }}
                className={`min-h-[42px] rounded-lg px-3 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  authMode === 'LOGIN'
                    ? 'bg-white text-slate-900 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('REGISTER');
                  setAuthError(null);
                }}
                className={`min-h-[42px] rounded-lg px-3 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  authMode === 'REGISTER'
                    ? 'bg-white text-slate-900 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Create Account
              </button>
            </div>

            {/* Role Selection */}
            <div className="mt-5">
              <span className="mb-2 block text-xs font-semibold text-slate-700">Your Role</span>
              <div
                role="tablist"
                aria-label="Select Role"
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeRole === 'ASHA'}
                  onClick={() => {
                    setActiveRole('ASHA');
                    setIdentifier('');
                    setSecret('');
                    setDmoProvisioningCode('');
                    setAshaEnrollmentCode(DEFAULT_OFFLINE_ASHA_ENROLLMENT_CODE);
                    setAuthError(null);
                  }}
                  className={`flex min-h-[48px] items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-colors cursor-pointer ${
                    activeRole === 'ASHA'
                      ? 'border-teal-700 bg-teal-50/70 font-semibold text-teal-950'
                      : 'border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Smartphone
                    className={`h-4 w-4 shrink-0 ${
                      activeRole === 'ASHA' ? 'text-teal-700' : 'text-slate-500'
                    }`}
                  />
                  <span className="truncate">Health Worker (ASHA)</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeRole === 'DMO'}
                  onClick={() => {
                    setActiveRole('DMO');
                    setIdentifier('');
                    setSecret('');
                    setDmoProvisioningCode('');
                    setAshaEnrollmentCode('');
                    setAuthError(null);
                  }}
                  className={`flex min-h-[48px] items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-colors cursor-pointer ${
                    activeRole === 'DMO'
                      ? 'border-teal-700 bg-teal-50/70 font-semibold text-teal-950'
                      : 'border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Building2
                    className={`h-4 w-4 shrink-0 ${
                      activeRole === 'DMO' ? 'text-teal-700' : 'text-slate-500'
                    }`}
                  />
                  <span className="truncate">Medical Officer (DMO)</span>
                </button>
              </div>
            </div>

            {authError && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-800"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-5 space-y-4" autoComplete="off">
              <div>
                <label
                  htmlFor="auth-identifier-input"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  {activeRole === 'ASHA' ? 'Health Worker ID' : 'Official Hospital Email'}
                </label>
                <input
                  id="auth-identifier-input"
                  type={activeRole === 'DMO' ? 'email' : 'text'}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder={
                    activeRole === 'ASHA' ? 'e.g. ASHA-8842-UP' : 'e.g. doctor@district24.gov.in'
                  }
                  required
                  className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                />
              </div>

              {authMode === 'REGISTER' && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="auth-name-input"
                      className="mb-1.5 block text-sm font-medium text-slate-800"
                    >
                      Your Full Name
                    </label>
                    <input
                      id="auth-name-input"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder={activeRole === 'ASHA' ? 'e.g. Sunita Devi' : 'e.g. Dr. R. Verma'}
                      required
                      className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="auth-village-input"
                      className="mb-1.5 block text-sm font-medium text-slate-800"
                    >
                      Assigned Clinic
                    </label>
                    <select
                      id="auth-village-input"
                      value={villageCode}
                      onChange={(e) => setVillageCode(e.target.value)}
                      className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-teal-700 focus:outline-none"
                    >
                      {SUB_CENTER_DIRECTORY.map((center) => (
                        <option key={center.code} value={center.code}>
                          {center.name.replace(' Health Sub-Center', '')} ({center.code})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {authMode === 'REGISTER' && activeRole === 'ASHA' && (
                <div>
                  <label
                    htmlFor="auth-asha-code-input"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Clinic Enrollment Code{' '}
                    <span className="font-normal text-slate-500">(Optional)</span>
                  </label>
                  <input
                    id="auth-asha-code-input"
                    type="password"
                    value={ashaEnrollmentCode}
                    onChange={(e) => setAshaEnrollmentCode(e.target.value)}
                    placeholder="Enter clinic code for instant verification (or request DMO approval)"
                    className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Unverified accounts remain pending until verified by a Clinic Enrollment Code or
                    District Medical Officer.
                  </p>
                </div>
              )}

              {authMode === 'REGISTER' && activeRole === 'DMO' && (
                <div>
                  <label
                    htmlFor="auth-dmo-code-input"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Hospital Authorization Code
                  </label>
                  <input
                    id="auth-dmo-code-input"
                    type="password"
                    value={dmoProvisioningCode}
                    onChange={(e) => setDmoProvisioningCode(e.target.value)}
                    placeholder="Issued by District Health Administration"
                    required
                    className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Required to verify official Medical Officer privileges before account creation.
                  </p>
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-secret-input"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  {activeRole === 'ASHA' ? 'Security Passcode' : 'Account Password'}
                </label>
                <div className="relative">
                  <input
                    id="auth-secret-input"
                    type={showSecret ? 'text' : 'password'}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="At least 8 characters (letters & numbers)"
                    required
                    minLength={8}
                    className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white pl-3.5 pr-12 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((prev) => !prev)}
                    aria-label={showSecret ? 'Hide password' : 'Show password'}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 cursor-pointer"
                  >
                    {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap cursor-pointer"
              >
                {authMode === 'REGISTER' ? (
                  <>
                    <UserPlus className="h-4 w-4 shrink-0" />
                    <span>
                      {submitting
                        ? 'Creating Account...'
                        : activeRole === 'ASHA'
                        ? 'Create Health Worker Account'
                        : 'Authorize & Create Officer Account'}
                    </span>
                  </>
                ) : (
                  <>
                    <Lock className="h-4 w-4 shrink-0" />
                    <span>
                      {submitting
                        ? 'Signing In...'
                        : activeRole === 'ASHA'
                        ? 'Sign In as Health Worker'
                        : 'Sign In as Medical Officer'}
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0" />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
