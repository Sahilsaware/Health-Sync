import React, {useEffect, useMemo, useState} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Ambulance,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Eye,
  EyeOff,
  FileText,
  Info,
  LayoutDashboard,
  Loader2,
  MapPin,
  MessageSquare,
  Search,
  Trash2,
  UserCheck,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  maskHealthId,
  SeverityLevel,
  SUB_CENTER_DIRECTORY,
  TriageRecord,
} from '../types/triage';
import {
  buildFhirBundleFromDecoded,
  decodeSMSPayload,
  encodeVitalsToSMS,
} from '../utils/binarySmsCodec';
import {useIsDesktopViewport, useVirtualWindow} from '../utils/virtualWindow';
import {
  CareSummaryResult,
  fetchCareSummaryWithFallback,
} from '../utils/clinicalSummaryClient';
import {
  AshaWorkerRosterEntry,
  broadcastLocalRealtimeEvent,
  loadEncryptedDistrictRelay,
  setWorkerVerifiedInDistrictRelay,
} from '../utils/realtimeSync';
import {safeReadJson} from '../utils/safeFetchJson';
import {DmoNavTab} from './TopRoleToolbar';

type ClinicalBriefResult = CareSummaryResult;

interface SmsLogItem {
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

interface SmsGatewayInfo {
  provider: 'twilio' | 'fast2sms' | 'unconfigured';
  configured: boolean;
  dmoEmergencyPhone?: string;
}

interface PendingAshaUserItem {
  id: string;
  identifier: string;
  displayName: string;
  villageCode: string;
  createdAtMs: number;
}

interface DistrictCommandDashboardProps {
  dmoEmail: string;
  dmoDisplayName?: string;
  sessionToken: string;
  records: TriageRecord[];
  ashaWorkers?: AshaWorkerRosterEntry[];
  isLoadingRecords?: boolean;
  activeTab: DmoNavTab;
  onSelectTab: (tab: DmoNavTab) => void;
  sirenActive: boolean;
  sirenMuted: boolean;
  onTriggerTestSiren: () => void;
  onToggleMuteSiren: () => void;
  onDispatchAmbulance: (recordId: string) => void;
  onDeleteRecord?: (recordId: string) => Promise<void> | void;
  onWorkerApproved?: (worker: AshaWorkerRosterEntry) => void;
}

function HealthStatusLabel({severity}: {severity: SeverityLevel}) {
  if (severity === 'emergency') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 whitespace-nowrap">
        <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
        <span>Urgent Care Needed</span>
      </span>
    );
  }
  if (severity === 'moderate') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800 whitespace-nowrap">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
        <span>Needs Doctor Review</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
      <span>Normal</span>
    </span>
  );
}

export const DistrictCommandDashboard: React.FC<DistrictCommandDashboardProps> = ({
  dmoEmail,
  dmoDisplayName,
  sessionToken,
  records = [],
  ashaWorkers = [],
  isLoadingRecords = false,
  activeTab,
  onSelectTab,
  sirenActive,
  sirenMuted,
  onTriggerTestSiren,
  onToggleMuteSiren,
  onDispatchAmbulance,
  onDeleteRecord,
  onWorkerApproved,
}) => {
  const safeRecords = Array.isArray(records) ? records : [];
  const [selectedVillage, setSelectedVillage] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | SeverityLevel>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [revealHealthIds, setRevealHealthIds] = useState(false);

  const [rawSmsInput, setRawSmsInput] = useState('');
  const [decodedQuery, setDecodedQuery] = useState('');
  const [showFhirJson, setShowFhirJson] = useState(false);

  // Server-side Gemini clinical handoff brief per triage record
  const [briefLoadingId, setBriefLoadingId] = useState<string | null>(null);
  const [briefsByRecord, setBriefsByRecord] = useState<Record<string, ClinicalBriefResult>>({});
  const [briefErrorByRecord, setBriefErrorByRecord] = useState<Record<string, string>>({});

  // Real SMS Gateway status, audit logs, and connected ASHA worker directory
  const [smsGateway, setSmsGateway] = useState<SmsGatewayInfo | null>(null);
  const [smsLogs, setSmsLogs] = useState<SmsLogItem[]>([]);
  const [serverWorkers, setServerWorkers] = useState<AshaWorkerRosterEntry[]>([]);
  const [relayWorkers, setRelayWorkers] = useState<AshaWorkerRosterEntry[]>([]);
  const [pendingAshaUsers, setPendingAshaUsers] = useState<PendingAshaUserItem[]>([]);
  const [approvingAshaId, setApprovingAshaId] = useState<string | null>(null);
  const [confirmEraseId, setConfirmEraseId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadEncryptedDistrictRelay()
      .then((relay) => {
        if (!cancelled && Array.isArray(relay.workers)) {
          setRelayWorkers(relay.workers);
        }
      })
      .catch(() => {});

    if (!sessionToken || sessionToken === 'OFFLINE_LOCAL_SESSION') {
      return () => {
        cancelled = true;
      };
    }

    const fetchDmoResources = () => {
      Promise.all([
        fetch('/api/sms/logs', {
          headers: {Authorization: `Bearer ${sessionToken}`},
        }).catch((err) => {
          console.warn('[SwasthyaSetu DMO] /api/sms/logs unavailable:', err);
          return null;
        }),
        fetch('/api/auth/asha/workers', {
          headers: {Authorization: `Bearer ${sessionToken}`},
        }).catch((err) => {
          console.warn('[SwasthyaSetu DMO] /api/auth/asha/workers unavailable:', err);
          return null;
        }),
        fetch('/api/auth/asha/pending', {
          headers: {Authorization: `Bearer ${sessionToken}`},
        }).catch((err) => {
          console.warn('[SwasthyaSetu DMO] /api/auth/asha/pending unavailable:', err);
          return null;
        }),
      ])
        .then(async ([smsRes, workersRes, pendingRes]) => {
          if (!cancelled && smsRes?.ok) {
            const parsedSms = await safeReadJson<{logs?: SmsLogItem[]; gateway?: SmsGatewayInfo}>(
              smsRes
            );
            if (parsedSms.isJson && parsedSms.data) {
              if (Array.isArray(parsedSms.data.logs)) setSmsLogs(parsedSms.data.logs);
              if (parsedSms.data.gateway) setSmsGateway(parsedSms.data.gateway);
            }
          }
          if (!cancelled && workersRes?.ok) {
            const parsedWorkers = await safeReadJson<{
              workers?: AshaWorkerRosterEntry[];
              pending?: PendingAshaUserItem[];
            }>(workersRes);
            if (parsedWorkers.isJson && parsedWorkers.data) {
              if (Array.isArray(parsedWorkers.data.workers)) {
                setServerWorkers(parsedWorkers.data.workers);
              }
              if (Array.isArray(parsedWorkers.data.pending)) {
                setPendingAshaUsers(parsedWorkers.data.pending);
              }
            }
          } else if (!cancelled && pendingRes?.ok) {
            const parsedPending = await safeReadJson<{pending?: PendingAshaUserItem[]}>(pendingRes);
            if (parsedPending.isJson && Array.isArray(parsedPending.data?.pending)) {
              setPendingAshaUsers(parsedPending.data.pending);
            }
          }
        })
        .catch(() => {});
    };

    fetchDmoResources();
    const pollTimer = window.setInterval(fetchDmoResources, 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, [sessionToken, safeRecords.length, ashaWorkers.length]);

  const combinedAshaWorkers = useMemo(() => {
    const byId = new Map<
      string,
      AshaWorkerRosterEntry & {checkupCount: number; urgentCount: number; lastTimestamp?: string}
    >();

    const upsertWorker = (w: Partial<AshaWorkerRosterEntry> & {identifier: string}) => {
      const normId = String(w.identifier || '').trim().toUpperCase();
      if (!normId) return;
      const prev = byId.get(normId);
      byId.set(normId, {
        id: w.id || prev?.id || `asha-${normId}`,
        identifier: normId,
        displayName: w.displayName || prev?.displayName || normId,
        villageCode: w.villageCode || prev?.villageCode || 'VIL-204',
        isVerified:
          typeof w.isVerified === 'boolean'
            ? Boolean(w.isVerified || prev?.isVerified)
            : prev?.isVerified ?? true,
        verifiedBy: w.verifiedBy ?? prev?.verifiedBy ?? null,
        verifiedAtMs: w.verifiedAtMs ?? prev?.verifiedAtMs ?? null,
        createdAtMs: w.createdAtMs || prev?.createdAtMs || Date.now(),
        lastActiveAtMs: Math.max(w.lastActiveAtMs || 0, prev?.lastActiveAtMs || 0),
        checkupCount: prev?.checkupCount || 0,
        urgentCount: prev?.urgentCount || 0,
        lastTimestamp: prev?.lastTimestamp,
      });
    };

    for (const w of relayWorkers || []) {
      if (w?.identifier) upsertWorker(w);
    }
    for (const w of ashaWorkers || []) {
      if (w?.identifier) upsertWorker(w);
    }
    for (const p of pendingAshaUsers || []) {
      if (p?.identifier) {
        upsertWorker({
          id: p.id,
          identifier: p.identifier,
          displayName: p.displayName,
          villageCode: p.villageCode,
          isVerified: false,
          createdAtMs: p.createdAtMs,
        });
      }
    }
    for (const w of serverWorkers || []) {
      if (w?.identifier) {
        const normId = w.identifier.trim().toUpperCase();
        const prev = byId.get(normId);
        byId.set(normId, {
          id: w.id,
          identifier: normId,
          displayName: w.displayName || prev?.displayName || normId,
          villageCode: w.villageCode || prev?.villageCode || 'VIL-204',
          isVerified: w.isVerified,
          verifiedBy: w.verifiedBy ?? prev?.verifiedBy ?? null,
          verifiedAtMs: w.verifiedAtMs ?? prev?.verifiedAtMs ?? null,
          createdAtMs: w.createdAtMs || prev?.createdAtMs || Date.now(),
          lastActiveAtMs: Math.max(w.lastActiveAtMs || 0, prev?.lastActiveAtMs || 0),
          checkupCount: prev?.checkupCount || 0,
          urgentCount: prev?.urgentCount || 0,
          lastTimestamp: prev?.lastTimestamp,
        });
      }
    }

    // Also discover ASHA workers directly from submitted triage records
    for (const rec of safeRecords) {
      if (!rec?.ashaWorker) continue;
      const match = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(String(rec.ashaWorker).trim());
      const extractedId = (match ? match[2] : rec.ashaWorker).trim().toUpperCase();
      const extractedName = (match ? match[1] : rec.ashaWorker).trim();
      if (!extractedId) continue;

      if (!byId.has(extractedId)) {
        upsertWorker({
          identifier: extractedId,
          displayName: extractedName,
          villageCode: rec.villageCode || 'VIL-204',
          isVerified: true,
          createdAtMs: Number(rec.createdAtMs) || Date.now(),
          lastActiveAtMs: Number(rec.createdAtMs) || Date.now(),
        });
      }
      const entry = byId.get(extractedId);
      if (entry) {
        entry.checkupCount += 1;
        if (rec.severity === 'emergency') {
          entry.urgentCount += 1;
        }
        if ((Number(rec.createdAtMs) || 0) >= (entry.lastActiveAtMs || 0)) {
          entry.lastActiveAtMs = Number(rec.createdAtMs) || entry.lastActiveAtMs;
          entry.lastTimestamp = rec.timestamp;
        }
      }
    }

    return Array.from(byId.values()).sort((a, b) => {
      if (a.isVerified !== b.isVerified) return a.isVerified ? 1 : -1;
      if (b.checkupCount !== a.checkupCount) return b.checkupCount - a.checkupCount;
      return (b.createdAtMs || 0) - (a.createdAtMs || 0);
    });
  }, [relayWorkers, ashaWorkers, pendingAshaUsers, serverWorkers, safeRecords]);

  const effectivePendingWorkers = useMemo(
    () => combinedAshaWorkers.filter((w) => !w.isVerified),
    [combinedAshaWorkers]
  );

  const handleApproveAshaWorker = async (identifier: string) => {
    if (!sessionToken) return;
    const normId = identifier.trim().toUpperCase();
    setApprovingAshaId(normId);
    try {
      const relayApproved = await setWorkerVerifiedInDistrictRelay(
        normId,
        true,
        dmoEmail || 'DMO_DASHBOARD'
      );
      if (relayApproved) {
        setRelayWorkers((prev) => [
          relayApproved,
          ...prev.filter((w) => w.identifier.toUpperCase() !== normId),
        ]);
        broadcastLocalRealtimeEvent({
          type: 'asha:roster_updated',
          worker: relayApproved,
        });
        onWorkerApproved?.(relayApproved);
      }

      if (sessionToken !== 'OFFLINE_LOCAL_SESSION') {
        const resp = await fetch(`/api/auth/asha/${encodeURIComponent(normId)}/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({verified: true}),
        });
        if (resp.ok) {
          setPendingAshaUsers((prev) =>
            prev.filter((u) => u.identifier.toUpperCase() !== normId)
          );
          setServerWorkers((prev) =>
            prev.map((w) =>
              w.identifier.toUpperCase() === normId ? {...w, isVerified: true} : w
            )
          );
        }
      } else {
        setPendingAshaUsers((prev) =>
          prev.filter((u) => u.identifier.toUpperCase() !== normId)
        );
      }
    } catch {
      // Ignore transient network errors; local District Relay approval already persisted
    } finally {
      setApprovingAshaId(null);
    }
  };

  const handleRequestGeminiBrief = async (rec: TriageRecord) => {
    setBriefLoadingId(rec.id);
    setBriefErrorByRecord((prev) => {
      const next = {...prev};
      delete next[rec.id];
      return next;
    });

    try {
      const allowName =
        Boolean(rec.patientConsent?.aiProcessingConsent) && Number(rec.age) >= 18;
      const summary = await fetchCareSummaryWithFallback({
        sessionToken,
        patientName: allowName ? rec.patientName : undefined,
        age: rec.age,
        vitals: rec.vitals,
        symptoms: rec.symptoms,
        edgeAi: rec.edgeAi,
        transcript: rec.clinicalNotes,
        language: 'en',
        explicitAiConsent: allowName,
      });
      setBriefsByRecord((prev) => ({...prev, [rec.id]: summary}));
    } finally {
      setBriefLoadingId(null);
    }
  };

  const decodedResult = useMemo(() => {
    if (!decodedQuery.trim()) return null;
    try {
      return decodeSMSPayload(decodedQuery);
    } catch (err) {
      console.warn('[SwasthyaSetu SMS] Failed to decode SMS payload:', err);
      return null;
    }
  }, [decodedQuery]);

  const fhirBundleJson = useMemo(() => {
    if (!decodedResult || !decodedResult.valid) return '';
    try {
      return JSON.stringify(buildFhirBundleFromDecoded(decodedResult), null, 2);
    } catch {
      return '';
    }
  }, [decodedResult]);

  // Single-pass O(N) memoized KPI & clinic aggregation (prevents repeated array scans on large histories)
  const {
    totalCheckups,
    urgentCount,
    unassignedUrgentCount,
    moderateRiskCount,
    pendingOfflineSyncs,
    villageCounts,
  } = useMemo(() => {
    let urgent = 0;
    let unassignedUrgent = 0;
    let moderate = 0;
    let pendingSync = 0;
    const byVillage = new Map<string, {total: number; urgent: number}>();

    for (let i = 0; i < safeRecords.length; i++) {
      const r = safeRecords[i];
      if (!r) continue;
      if (r.severity === 'emergency') {
        urgent += 1;
        if (r.dispatchStatus !== 'Dispatched') {
          unassignedUrgent += 1;
        }
      } else if (r.severity === 'moderate') {
        moderate += 1;
      }
      if (r.syncStatus === 'Queued Offline') {
        pendingSync += 1;
      }

      const vCode = r.villageCode || 'VIL-204';
      const prev = byVillage.get(vCode);
      if (prev) {
        prev.total += 1;
        if (r.severity === 'emergency') prev.urgent += 1;
      } else {
        byVillage.set(vCode, {
          total: 1,
          urgent: r.severity === 'emergency' ? 1 : 0,
        });
      }
    }

    return {
      totalCheckups: safeRecords.length,
      urgentCount: urgent,
      unassignedUrgentCount: unassignedUrgent,
      moderateRiskCount: moderate,
      pendingOfflineSyncs: pendingSync,
      villageCounts: byVillage,
    };
  }, [safeRecords]);

  // Filtered Patient Records
  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const out: TriageRecord[] = [];
    for (let i = 0; i < safeRecords.length; i++) {
      const r = safeRecords[i];
      if (!r) continue;
      if (selectedVillage !== 'ALL' && r.villageCode !== selectedVillage) continue;
      if (statusFilter !== 'ALL' && r.severity !== statusFilter) continue;
      if (
        q &&
        !String(r.patientName || '').toLowerCase().includes(q) &&
        !String(r.patientId || '').toLowerCase().includes(q) &&
        !String(r.villageCode || '').toLowerCase().includes(q) &&
        !String(r.ashaWorker || '').toLowerCase().includes(q)
      ) {
        continue;
      }
      out.push(r);
    }
    return out.sort((a, b) => (Number(b?.createdAtMs) || 0) - (Number(a?.createdAtMs) || 0));
  }, [safeRecords, selectedVillage, statusFilter, searchQuery]);

  // Priority Referrals Queue (Urgent & Needs Doctor Review)
  const priorityQueue = useMemo(() => {
    const out: TriageRecord[] = [];
    for (let i = 0; i < safeRecords.length; i++) {
      const r = safeRecords[i];
      if (!r) continue;
      if (r.severity === 'emergency' || r.severity === 'moderate') {
        out.push(r);
      }
    }
    return out.sort((a, b) => {
      const aRed = a?.severity === 'emergency' ? 1 : 0;
      const bRed = b?.severity === 'emergency' ? 1 : 0;
      if (aRed !== bRed) return bRed - aRed;
      return (Number(b?.createdAtMs) || 0) - (Number(a?.createdAtMs) || 0);
    });
  }, [safeRecords]);

  const isDesktop = useIsDesktopViewport(768);

  const recordsVirtual = useVirtualWindow<HTMLDivElement, HTMLElement>({
    count: filteredRecords.length,
    itemHeight: isDesktop ? 64 : 112,
    viewportHeight: 580,
    overscan: 6,
    resetKey: `${selectedVillage}|${statusFilter}|${searchQuery}|${isDesktop ? 'desktop' : 'mobile'}`,
  });

  const urgentVirtual = useVirtualWindow<HTMLDivElement, HTMLDivElement>({
    count: priorityQueue.length,
    itemHeight: 220,
    viewportHeight: 640,
    overscan: 4,
    resetKey: activeTab,
  });

  const exampleEncodedSms = useMemo(() => {
    if (safeRecords[0]?.binarySmsPayload) {
      return safeRecords[0].binarySmsPayload;
    }
    try {
      return encodeVitalsToSMS({
        patientId: 'PT1001',
        villageCode: 'VIL-204',
        vitals: {systolic: 162, diastolic: 100, spo2: 89, temperature: 101.2, heartRate: 110},
        symptoms: ['Fever', 'High BP'],
        severity: 'emergency',
      });
    } catch {
      return 'HS#A8842#BP160/100#SPO288#RED';
    }
  }, [safeRecords]);

  const openSmsDecoderWith = (payload: string) => {
    setRawSmsInput(payload);
    setDecodedQuery(payload);
    onSelectTab('sms');
  };

  const renderUrgentReferralList = (limit?: number) => {
    const isBoundedPreview = typeof limit === 'number';
    const items = isBoundedPreview
      ? priorityQueue.slice(0, limit)
      : priorityQueue.slice(urgentVirtual.startIndex, urgentVirtual.endIndex);

    if (isLoadingRecords) {
      return (
        <div className="space-y-3">
          <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
        </div>
      );
    }

    if (priorityQueue.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50/70 px-6 py-10 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-600" />
          <h3 className="mt-2.5 text-sm font-semibold text-slate-900">
            No urgent patient referrals right now
          </h3>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-600">
            Patients needing urgent care or same-day doctor review will appear here automatically as
            community health workers submit checkups.
          </p>
        </div>
      );
    }

    const cardsMarkup = (
      <div className="space-y-3">
        {items.map((rec) => {
          const isUrgent = rec.severity === 'emergency';
          const isDispatched = rec.dispatchStatus === 'Dispatched';
          const brief = briefsByRecord[rec.id];
          const briefError = briefErrorByRecord[rec.id];
          const isLoadingBrief = briefLoadingId === rec.id;

          return (
            <div
              key={rec.id}
              className={`rounded-xl border p-4 sm:p-5 space-y-3 ${
                isUrgent && !isDispatched
                  ? 'border-red-200 bg-red-50/40'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <HealthStatusLabel severity={rec?.severity || 'routine'} />
                    <span className="text-xs text-slate-500">
                      · {rec?.villageName || 'Rural Sub-Center'} ({rec?.villageCode || 'VIL-204'}) ·{' '}
                      {rec?.timestamp || 'Just now'}
                    </span>
                  </div>
                  <h3 className="mt-1.5 text-base font-bold text-slate-900">
                    {rec?.patientName || 'Unnamed Patient'}{' '}
                    <span className="text-sm font-normal text-slate-600">
                      ({rec?.age ?? 35} yrs,{' '}
                      {rec?.gender === 'F' ? 'Female' : rec?.gender === 'M' ? 'Male' : 'Other'})
                    </span>
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Recorded by {rec?.ashaWorker || 'ASHA Worker'} · Health ID:{' '}
                    <span className="font-mono">
                      {revealHealthIds
                        ? rec?.abhaId || 'Not provided'
                        : maskHealthId(rec?.abhaId || 'Not provided')}
                    </span>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRequestGeminiBrief(rec)}
                    disabled={isLoadingBrief}
                    className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                  >
                    {isLoadingBrief ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-700" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-teal-700" />
                    )}
                    <span>Care Summary</span>
                  </button>

                  {isDispatched ? (
                    <span className="inline-flex min-h-[38px] items-center gap-1.5 px-2 text-xs font-semibold text-emerald-700 whitespace-nowrap tabular-nums">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>Ambulance Sent ({rec?.etaMinutes ?? 11} min ETA)</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDispatchAmbulance(rec.id)}
                      className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white transition-colors whitespace-nowrap cursor-pointer ${
                        isUrgent ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-700 hover:bg-teal-800'
                      }`}
                    >
                      <Ambulance className="h-3.5 w-3.5 shrink-0" />
                      <span>Assign Ambulance</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Plain-language Vital Signs */}
              <div className="grid grid-cols-2 gap-3 border-t border-slate-200/80 pt-3 text-xs sm:grid-cols-4">
                <div>
                  <span className="block text-slate-500">Blood Pressure</span>
                  <strong className="font-mono text-sm text-slate-900 tabular-nums">
                    {rec?.vitals?.systolic ?? 120}/{rec?.vitals?.diastolic ?? 80} mmHg
                  </strong>
                </div>
                <div>
                  <span className="block text-slate-500">Blood Oxygen</span>
                  <strong
                    className={`font-mono text-sm tabular-nums ${
                      (rec?.vitals?.spo2 ?? 98) < 90 ? 'text-red-700' : 'text-slate-900'
                    }`}
                  >
                    {rec?.vitals?.spo2 ?? 98}%
                  </strong>
                </div>
                <div>
                  <span className="block text-slate-500">Temperature</span>
                  <strong className="font-mono text-sm text-slate-900 tabular-nums">
                    {rec?.vitals?.temperature ?? 98.6}°F
                  </strong>
                </div>
                <div>
                  <span className="block text-slate-500">Pulse Rate</span>
                  <strong className="font-mono text-sm text-slate-900 tabular-nums">
                    {rec?.vitals?.heartRate ?? 76} bpm
                  </strong>
                </div>
              </div>

              {(rec?.symptoms || []).length > 0 && (
                <p className="text-xs text-slate-700">
                  <strong className="font-semibold text-slate-900">Symptoms:</strong>{' '}
                  {(rec?.symptoms || []).join(', ')}
                </p>
              )}

              {(rec?.edgeAi?.anemiaSuspected || rec?.edgeAi?.respiratoryRiskHigh) && (
                <p className="text-xs text-amber-900">
                  <strong className="font-semibold">Field Observation (Confirm at Clinic):</strong>{' '}
                  {rec?.edgeAi?.anemiaSuspected ? 'Pale lower eyelid noticed. ' : ''}
                  {rec?.edgeAi?.respiratoryRiskHigh ? 'High-pitched cough sample recorded.' : ''}
                </p>
              )}

              {brief && (
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-800">
                  <p className="font-semibold text-slate-900">Care Summary (Decision Support)</p>
                  <p className="leading-relaxed">{brief?.handoffSummary}</p>
                  {(brief?.stabilizationSteps || []).length > 0 && (
                    <ul className="list-disc pl-4 space-y-0.5 text-slate-700">
                      {(brief?.stabilizationSteps || []).map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ul>
                  )}
                  <p className="border-t border-slate-200 pt-2 text-[11px] text-slate-500">
                    {brief?.disclaimer}
                  </p>
                </div>
              )}

              {briefError && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {briefError}
                </p>
              )}
            </div>
          );
        })}
      </div>
    );

    if (isBoundedPreview) {
      return cardsMarkup;
    }

    return (
      <div
        ref={urgentVirtual.containerRef}
        onScroll={urgentVirtual.handleScroll}
        className="custom-scrollbar max-h-[640px] overflow-y-auto pr-1"
      >
        <div ref={urgentVirtual.topSpacerRef} aria-hidden="true" />
        {cardsMarkup}
        <div ref={urgentVirtual.bottomSpacerRef} aria-hidden="true" />
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-24 sm:px-6 md:pb-10 space-y-6">
      {/* Calm Dashboard Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-center">
        <div>
          <p className="text-xs font-medium text-slate-500">
            District 24 Hospital Care Coordination · {dmoDisplayName || dmoEmail}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            Hospital Care Dashboard
          </h1>
        </div>

        {/* Calm Audio Alert & Privacy Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => setRevealHealthIds((prev) => !prev)}
            className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {revealHealthIds ? (
              <>
                <EyeOff className="h-4 w-4 text-slate-500" />
                <span>Mask Health IDs</span>
              </>
            ) : (
              <>
                <Eye className="h-4 w-4 text-slate-500" />
                <span>Show Health IDs</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onToggleMuteSiren}
            className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {sirenMuted ? (
              <>
                <VolumeX className="h-4 w-4 text-amber-700 shrink-0" />
                <span>Sound Muted</span>
              </>
            ) : (
              <>
                <Volume2 className="h-4 w-4 text-teal-700 shrink-0" />
                <span>Alert Sound On</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onTriggerTestSiren}
            className={`inline-flex min-h-[42px] items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              sirenActive
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Bell className="h-4 w-4 shrink-0" />
            <span>{sirenActive ? 'Silence Active Chime' : 'Test Alert Chime'}</span>
          </button>
        </div>
      </div>

      {/* Top 4 Summary Cards — Most Important Information First */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <p className="text-xs font-medium text-slate-600">Patients Checked</p>
          <p className="mt-1.5 text-2xl font-bold text-slate-900 tabular-nums">{totalCheckups}</p>
          <p className="mt-1 text-xs text-slate-500">Saved in hospital database</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-600">Urgent Care Needed</p>
            <AlertCircle
              className={`h-4 w-4 shrink-0 ${
                urgentCount > 0 ? 'text-red-600' : 'text-slate-400'
              }`}
            />
          </div>
          <p
            className={`mt-1.5 text-2xl font-bold tabular-nums ${
              urgentCount > 0 ? 'text-red-700' : 'text-slate-900'
            }`}
          >
            {urgentCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {unassignedUrgentCount > 0
              ? `${unassignedUrgentCount} waiting for ambulance`
              : 'All urgent cases assigned'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-600">Needs Doctor Review</p>
            <AlertTriangle
              className={`h-4 w-4 shrink-0 ${
                moderateRiskCount > 0 ? 'text-amber-600' : 'text-slate-400'
              }`}
            />
          </div>
          <p className="mt-1.5 text-2xl font-bold text-slate-900 tabular-nums">
            {moderateRiskCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">Same-day clinic follow-up</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-600">Connected ASHA Workers</p>
            <Users className="h-4 w-4 shrink-0 text-teal-700" />
          </div>
          <p className="mt-1.5 text-2xl font-bold text-slate-900 tabular-nums">
            {combinedAshaWorkers.filter((w) => w.isVerified).length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {effectivePendingWorkers.length > 0
              ? `${effectivePendingWorkers.length} pending verification`
              : pendingOfflineSyncs > 0
              ? `${pendingOfflineSyncs} checkups queued`
              : 'Synced with field clinics'}
          </p>
        </div>
      </div>

      {/* Clinical Decision-Support Notice */}
      <div
        role="note"
        className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-xs leading-relaxed text-slate-600"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
        <p>
          <strong className="font-semibold text-slate-900">Clinical Guidance Note:</strong> Field
          camera checks, cough sound observations, and AI Care Summaries support triage handoff and
          do not replace physical examination or standard laboratory diagnostics.
        </p>
      </div>

      {/* Pending ASHA Health Worker Verification Queue (Shown when unverified registrations exist) */}
      {effectivePendingWorkers.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                Pending Health Worker Verifications ({effectivePendingWorkers.length})
              </h2>
              <p className="text-xs text-slate-600">
                Approve verified ASHA clinic workers to connect their triage checkups and emergency
                alerts directly to this dashboard.
              </p>
            </div>
          </div>
          <div className="divide-y divide-amber-200/70">
            {effectivePendingWorkers.map((worker) => (
              <div
                key={worker.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0 text-xs"
              >
                <div>
                  <span className="font-semibold text-slate-900">{worker.displayName}</span>{' '}
                  <span className="font-mono text-slate-600">({worker.identifier})</span> ·{' '}
                  <span className="text-slate-600">{worker.villageCode}</span>
                </div>
                <button
                  type="button"
                  disabled={approvingAshaId === worker.identifier}
                  onClick={() => handleApproveAshaWorker(worker.identifier)}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                >
                  <UserCheck className="h-3.5 w-3.5" />
                  <span>
                    {approvingAshaId === worker.identifier ? 'Approving...' : 'Approve & Connect'}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* VIEW 1: OVERVIEW (Urgent Queue + Clinic Coverage Summary) */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
          {/* Urgent & Priority Referrals (7 cols) */}
          <section className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900">Priority Patient Referrals</h2>
                <p className="text-xs text-slate-600">
                  Patients needing urgent ambulance care or same-day doctor review
                </p>
              </div>
              {priorityQueue.length > 4 && (
                <button
                  type="button"
                  onClick={() => onSelectTab('urgent')}
                  className="text-xs font-semibold text-teal-700 hover:underline whitespace-nowrap cursor-pointer"
                >
                  View all ({priorityQueue.length})
                </button>
              )}
            </div>

            {renderUrgentReferralList(4)}
          </section>

          {/* Rural Clinic Coverage Summary (5 cols) */}
          <section className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">Rural Clinic Activity</h2>
              <p className="text-xs text-slate-600">
                Select a sub-center clinic to view its patient records
              </p>
            </div>

            <div className="divide-y divide-slate-200">
              {SUB_CENTER_DIRECTORY.map((vil) => {
                const vilStats = villageCounts.get(vil.code) ?? {total: 0, urgent: 0};
                const barPercent =
                  totalCheckups > 0
                    ? Math.min(100, Math.round((vilStats.total / totalCheckups) * 100))
                    : 0;

                return (
                  <button
                    key={vil.code}
                    type="button"
                    onClick={() => {
                      setSelectedVillage(vil.code);
                      onSelectTab('records');
                    }}
                    className="w-full py-4 first:pt-1 last:pb-1 text-left transition-colors hover:bg-slate-50/80 rounded-lg px-2 -mx-2 cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{vil.name}</p>
                        <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                          <MapPin className="mr-1 inline h-3.5 w-3.5 text-slate-400" />
                          {vil.block} · {vil.phcDistanceKm} km from hospital
                        </p>
                      </div>
                      <div className="text-right tabular-nums">
                        <span className="text-sm font-bold text-slate-900">
                          {vilStats.total}{' '}
                          <span className="text-xs font-normal text-slate-500">checked</span>
                        </span>
                        {vilStats.urgent > 0 && (
                          <p className="text-xs font-semibold text-red-700">{vilStats.urgent} urgent</p>
                        )}
                      </div>
                    </div>

                    {/* Simple, meaningful proportion bar */}
                    <svg
                      viewBox="0 0 100 6"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                    >
                      <rect
                        x={0}
                        y={0}
                        width={barPercent}
                        height={6}
                        rx={3}
                        className={vilStats.urgent > 0 ? 'fill-red-500' : 'fill-teal-600'}
                      />
                    </svg>
                  </button>
                );
              })}
            </div>

            <div className="border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedVillage('ALL');
                  onSelectTab('records');
                }}
                className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 cursor-pointer"
              >
                Browse All Patient Records ({totalCheckups})
              </button>
            </div>
          </section>
        </div>
      )}

      {/* VIEW 2: URGENT REFERRALS FULL VIEW */}
      {activeTab === 'urgent' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Urgent &amp; Doctor-Review Referrals ({priorityQueue.length})
            </h2>
            <p className="text-xs text-slate-600">
              Assign 108 ambulance transport or review AI Care Summaries before patient arrival
            </p>
          </div>
          {renderUrgentReferralList()}
        </section>
      )}

      {/* VIEW 3: ALL PATIENT RECORDS */}
      {activeTab === 'records' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">Patient Checkup Directory</h2>
              <p className="text-xs text-slate-600">
                Showing {filteredRecords.length} of {safeRecords.length} recorded patient visits
              </p>
            </div>

            {/* Search & Filters */}
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search patient or ID..."
                  className="min-h-[40px] w-full sm:w-56 rounded-xl border border-slate-300 bg-white pl-9 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <select
                value={selectedVillage}
                onChange={(e) => setSelectedVillage(e.target.value)}
                aria-label="Filter by Clinic"
                className="min-h-[40px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 focus:border-teal-700 focus:outline-none"
              >
                <option value="ALL">All Clinics</option>
                {SUB_CENTER_DIRECTORY.map((vil) => (
                  <option key={vil.code} value={vil.code}>
                    {vil.name.replace(' Health Sub-Center', '')} ({vil.code})
                  </option>
                ))}
              </select>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'ALL' | SeverityLevel)}
                aria-label="Filter by Health Status"
                className="min-h-[40px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 focus:border-teal-700 focus:outline-none"
              >
                <option value="ALL">All Statuses</option>
                <option value="emergency">Urgent Care Needed</option>
                <option value="moderate">Needs Doctor Review</option>
                <option value="routine">Normal</option>
              </select>
            </div>
          </div>

          {isLoadingRecords ? (
            <div className="space-y-3 py-4">
              <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50/70 px-6 py-12 text-center">
              <ClipboardList className="h-8 w-8 text-slate-400" />
              <h3 className="mt-2.5 text-sm font-semibold text-slate-900">
                {safeRecords.length === 0
                  ? 'No patient checkups recorded yet'
                  : 'No records match your current filters'}
              </h3>
              <p className="mt-1 max-w-sm text-xs text-slate-600">
                {safeRecords.length === 0
                  ? 'When health workers save patient checkups or send urgent SMS alerts, they will appear here automatically.'
                  : 'Try resetting the clinic or status filter above.'}
              </p>
              {safeRecords.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedVillage('ALL');
                    setStatusFilter('ALL');
                    setSearchQuery('');
                  }}
                  className="mt-4 min-h-[38px] rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                >
                  Clear Filters
                </button>
              )}
            </div>
          ) : !isDesktop ? (
            /* Virtualized Mobile Card List (< md) — mounts only visible cards to prevent DOM freeze */
            <div
              ref={recordsVirtual.containerRef}
              onScroll={recordsVirtual.handleScroll}
              className="custom-scrollbar max-h-[580px] overflow-y-auto pr-1"
            >
              <div
                ref={recordsVirtual.topSpacerRef as React.RefObject<HTMLDivElement>}
                aria-hidden="true"
              />
              <div className="divide-y divide-slate-200">
                {filteredRecords
                  .slice(recordsVirtual.startIndex, recordsVirtual.endIndex)
                  .map((rec, idx) => (
                    <div key={rec?.id || `mrec-${idx}`} className="py-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">
                            {rec?.patientName || 'Unnamed Patient'}
                          </p>
                          <p className="text-xs text-slate-500">
                            {rec?.patientId || 'PT0000'} · {rec?.villageCode || 'VIL-204'} ·{' '}
                            {rec?.timestamp || 'Just now'}
                          </p>
                        </div>
                        <HealthStatusLabel severity={rec?.severity || 'routine'} />
                      </div>
                      <p className="text-xs text-slate-700 tabular-nums">
                        BP {rec?.vitals?.systolic ?? 120}/{rec?.vitals?.diastolic ?? 80} mmHg ·
                        Oxygen {rec?.vitals?.spo2 ?? 98}% · Temp {rec?.vitals?.temperature ?? 98.6}°F
                      </p>
                      <div className="flex items-center justify-between pt-1 text-xs text-slate-500">
                        <span>{rec?.syncStatus || 'Synced'}</span>
                        <button
                          type="button"
                          onClick={() =>
                            openSmsDecoderWith(rec?.binarySmsPayload || exampleEncodedSms)
                          }
                          className="font-semibold text-teal-700 hover:underline cursor-pointer"
                        >
                          Inspect SMS Code
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
              <div
                ref={recordsVirtual.bottomSpacerRef as React.RefObject<HTMLDivElement>}
                aria-hidden="true"
              />
            </div>
          ) : (
            /* Virtualized Desktop Tabular Data Table (md+) — mounts only visible rows (~20 max) */
            <div
              ref={recordsVirtual.containerRef}
              onScroll={recordsVirtual.handleScroll}
              className="custom-scrollbar max-h-[580px] overflow-auto rounded-xl border border-slate-200"
            >
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600">
                  <tr className="border-b border-slate-200">
                    <th className="px-4 py-3 font-semibold">Patient</th>
                    <th className="px-3 py-3 font-semibold">Health ID</th>
                    <th className="px-3 py-3 font-semibold">Clinic</th>
                    <th className="px-3 py-3 font-semibold">Status</th>
                    <th className="px-3 py-3 text-right font-semibold">BP (mmHg)</th>
                    <th className="px-3 py-3 text-right font-semibold">Oxygen</th>
                    <th className="px-3 py-3 text-right font-semibold">Temp</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  <tr
                    ref={recordsVirtual.topSpacerRef as React.RefObject<HTMLTableRowElement>}
                    aria-hidden="true"
                    className="border-0"
                  >
                    <td colSpan={8} className="p-0 border-0" />
                  </tr>
                  {filteredRecords
                    .slice(recordsVirtual.startIndex, recordsVirtual.endIndex)
                    .map((rec, idx) => (
                      <tr key={rec?.id || `drec-${idx}`} className="hover:bg-slate-50/80">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900">
                            {rec?.patientName || 'Unnamed Patient'}
                          </div>
                          <div className="text-slate-500">
                            {rec?.patientId || 'PT0000'} · {rec?.age ?? 35}y ·{' '}
                            {rec?.timestamp || 'Just now'}
                          </div>
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-600 tabular-nums">
                          {revealHealthIds
                            ? rec?.abhaId || 'Not provided'
                            : maskHealthId(rec?.abhaId || 'Not provided')}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {rec?.villageCode || 'VIL-204'}
                        </td>
                        <td className="px-3 py-3">
                          <HealthStatusLabel severity={rec?.severity || 'routine'} />
                        </td>
                        <td className="px-3 py-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                          {rec?.vitals?.systolic ?? 120}/{rec?.vitals?.diastolic ?? 80}
                        </td>
                        <td
                          className={`px-3 py-3 text-right font-mono font-semibold tabular-nums ${
                            (rec?.vitals?.spo2 ?? 98) < 90 ? 'text-red-700' : 'text-slate-900'
                          }`}
                        >
                          {rec?.vitals?.spo2 ?? 98}%
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-slate-800 tabular-nums">
                          {rec?.vitals?.temperature ?? 98.6}°F
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center justify-end gap-2.5">
                            <button
                              type="button"
                              onClick={() =>
                                openSmsDecoderWith(rec?.binarySmsPayload || exampleEncodedSms)
                              }
                              className="text-xs font-semibold text-teal-700 hover:underline whitespace-nowrap cursor-pointer"
                            >
                              View SMS
                            </button>
                            {onDeleteRecord &&
                              (confirmEraseId === rec.id ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConfirmEraseId(null);
                                    void onDeleteRecord(rec.id);
                                  }}
                                  className="text-xs font-semibold text-red-700 hover:underline whitespace-nowrap cursor-pointer"
                                >
                                  Confirm Erase
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmEraseId(rec.id)}
                                  aria-label={`Erase record for ${rec?.patientName || 'patient'}`}
                                  className="inline-flex items-center text-slate-400 hover:text-red-600 cursor-pointer"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  <tr
                    ref={recordsVirtual.bottomSpacerRef as React.RefObject<HTMLTableRowElement>}
                    aria-hidden="true"
                    className="border-0"
                  >
                    <td colSpan={8} className="p-0 border-0" />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* VIEW 4: OFFLINE SMS DECODER & HEALTH RECORD INTEROPERABILITY */}
      {activeTab === 'sms' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
          <section className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Offline Emergency Text Message (SMS) Reader
              </h2>
              <p className="mt-0.5 text-xs text-slate-600">
                Paste a compact SMS code sent from a rural phone without internet to view the
                patient&apos;s vital signs in plain language.
              </p>
            </div>

            <div className="space-y-3">
              <label htmlFor="sms-decode-input" className="block text-sm font-medium text-slate-800">
                Emergency SMS Text
              </label>
              <textarea
                id="sms-decode-input"
                rows={2}
                value={rawSmsInput}
                onChange={(e) => setRawSmsInput(e.target.value)}
                placeholder="Paste SMS starting with HS# (for example HS#A8842#BP160/100#SPO288#RED)"
                className="w-full rounded-xl border border-slate-300 bg-white p-3 font-mono text-sm text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
              />

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500">Sample formats:</span>
                <button
                  type="button"
                  onClick={() => {
                    const s = 'HS#A8842#BP160/100#SPO288#RED';
                    setRawSmsInput(s);
                    setDecodedQuery(s);
                  }}
                  className="min-h-[34px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-700 hover:bg-slate-100 cursor-pointer"
                >
                  HS#A8842#BP160/100#SPO288#RED
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRawSmsInput(exampleEncodedSms);
                    setDecodedQuery(exampleEncodedSms);
                  }}
                  className="min-h-[34px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-700 hover:bg-slate-100 cursor-pointer"
                >
                  {exampleEncodedSms}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setDecodedQuery(rawSmsInput)}
                className="flex min-h-[46px] w-full items-center justify-center rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 cursor-pointer"
              >
                Read Patient Vital Signs from SMS
              </button>
            </div>

            {decodedResult && (
              <div className="pt-2">
                {decodedResult.valid ? (
                  <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <HealthStatusLabel severity={decodedResult.severity} />
                      <span className="text-xs text-slate-500 tabular-nums">
                        {decodedResult.ashaId} · {decodedResult.villageCode} ·{' '}
                        {decodedResult.patientId}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 text-xs sm:grid-cols-3">
                      <div>
                        <span className="block text-slate-500">Blood Pressure</span>
                        <strong className="font-mono text-sm text-slate-900 tabular-nums">
                          {decodedResult?.vitals?.systolic ?? 120}/
                          {decodedResult?.vitals?.diastolic ?? 80} mmHg
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Blood Oxygen</span>
                        <strong className="font-mono text-sm text-slate-900 tabular-nums">
                          {decodedResult?.vitals?.spo2 ?? 98}%
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Temperature</span>
                        <strong className="font-mono text-sm text-slate-900 tabular-nums">
                          {decodedResult?.vitals?.temperature ?? 98.6}°F
                        </strong>
                      </div>
                    </div>

                    {(decodedResult?.symptoms || []).length > 0 && (
                      <p className="text-xs text-slate-700">
                        <strong className="font-semibold text-slate-900">Symptoms:</strong>{' '}
                        {(decodedResult?.symptoms || []).join(', ')}
                      </p>
                    )}

                    <div className="border-t border-slate-200 pt-3">
                      <button
                        type="button"
                        onClick={() => setShowFhirJson((prev) => !prev)}
                        className="flex w-full items-center justify-between text-xs font-semibold text-teal-700 cursor-pointer"
                      >
                        <span>Standard HL7 FHIR Health Record JSON</span>
                        {showFhirJson ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                      {showFhirJson && (
                        <pre className="custom-scrollbar mt-2 max-h-52 overflow-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-slate-800">
                          {fhirBundleJson}
                        </pre>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs text-red-900"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                    <span>{decodedResult.error ?? 'Could not read that SMS code.'}</span>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* SMS Gateway Activity Log (5 cols) */}
          <section className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">Hospital SMS Activity</h2>
              <p className="mt-0.5 text-xs text-slate-600">
                {smsGateway?.configured
                  ? `Connected carrier service: ${smsGateway.provider.toUpperCase()}`
                  : 'Incoming /api/sms/webhook and phone SMS app links are active'}
              </p>
            </div>

            {smsLogs.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-6 text-center text-xs text-slate-600">
                No incoming or outgoing emergency text messages have been logged yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {smsLogs.slice(0, 8).map((log) => (
                  <div key={log.id} className="py-3 first:pt-0 last:pb-0 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{log.toPhone}</span>
                      <span className="text-slate-500">{log.status}</span>
                    </div>
                    <p className="font-mono text-[11px] text-slate-600 truncate">
                      {log.payloadText}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* VIEW 4: CONNECTED ASHA HEALTH WORKERS DIRECTORY */}
      {activeTab === 'workers' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                ASHA Health Workers ({combinedAshaWorkers.length})
              </h2>
              <p className="text-xs text-slate-600">
                Review connected community health workers, approve new clinic enrollments, or filter
                submitted patient checkups by worker.
              </p>
            </div>
          </div>

          {combinedAshaWorkers.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50/70 px-6 py-12 text-center">
              <Users className="h-8 w-8 text-slate-400" />
              <h3 className="mt-2.5 text-sm font-semibold text-slate-900">
                No ASHA health workers registered yet
              </h3>
              <p className="mt-1 max-w-sm text-xs text-slate-600">
                Once community health workers create an ASHA account or submit field checkups, their
                clinic assignment and checkups connect here automatically.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {combinedAshaWorkers.map((worker) => {
                const clinic = SUB_CENTER_DIRECTORY.find((c) => c.code === worker.villageCode);
                return (
                  <div
                    key={worker.id}
                    className="flex flex-col gap-3 py-4 first:pt-1 last:pb-1 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-slate-900">
                          {worker.displayName}
                        </span>
                        <span className="font-mono text-xs text-slate-600">
                          ({worker.identifier})
                        </span>
                        {worker.isVerified ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>Connected</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            <span>Pending Approval</span>
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 tabular-nums">
                        {clinic ? clinic.name : 'Rural Sub-Center'} ({worker.villageCode}) ·{' '}
                        {worker.checkupCount} checkups submitted
                        {worker.urgentCount > 0 ? ` · ${worker.urgentCount} urgent` : ''}
                        {worker.lastTimestamp ? ` · Last checkup ${worker.lastTimestamp}` : ''}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {!worker.isVerified && (
                        <button
                          type="button"
                          disabled={approvingAshaId === worker.identifier}
                          onClick={() => handleApproveAshaWorker(worker.identifier)}
                          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
                        >
                          <UserCheck className="h-3.5 w-3.5" />
                          <span>
                            {approvingAshaId === worker.identifier
                              ? 'Approving...'
                              : 'Approve & Connect'}
                          </span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedVillage('ALL');
                          setStatusFilter('ALL');
                          setSearchQuery(worker.identifier);
                          onSelectTab('records');
                        }}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                      >
                        <ClipboardList className="h-3.5 w-3.5 text-teal-700" />
                        <span>View Checkups ({worker.checkupCount})</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* MOBILE BOTTOM NAVIGATION BAR (< md) */}
      <nav
        aria-label="Dashboard Mobile Navigation"
        className="fixed bottom-0 left-0 right-0 z-30 grid h-16 grid-cols-5 items-center border-t border-slate-200 bg-white/95 backdrop-blur-md pb-safe md:hidden"
      >
        <button
          type="button"
          onClick={() => onSelectTab('overview')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'overview' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <LayoutDashboard className="h-5 w-5" />
          <span className="text-[10px] whitespace-nowrap">Overview</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('urgent')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'urgent' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <AlertCircle className="h-5 w-5" />
          <span className="text-[10px] whitespace-nowrap">
            Urgent{urgentCount > 0 ? ` (${urgentCount})` : ''}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('records')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'records' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <ClipboardList className="h-5 w-5" />
          <span className="text-[10px] whitespace-nowrap">Records</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('workers')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'workers' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <Users className="h-5 w-5" />
          <span className="text-[10px] whitespace-nowrap">
            ASHA{effectivePendingWorkers.length > 0 ? ` (${effectivePendingWorkers.length})` : ''}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('sms')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'sms' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <MessageSquare className="h-5 w-5" />
          <span className="text-[10px] whitespace-nowrap">SMS</span>
        </button>
      </nav>
    </div>
  );
};
