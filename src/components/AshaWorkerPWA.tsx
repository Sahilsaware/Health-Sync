import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  HeartPulse,
  Mic,
  Minus,
  Plus,
  Save,
  Search,
  Send,
  Stethoscope,
  X,
} from 'lucide-react';
import {
  EdgeAiDiagnostics,
  evaluateTriage,
  evaluateVitalStatus,
  IncentiveEntry,
  maskHealthId,
  NetworkState,
  SeverityLevel,
  SUB_CENTER_DIRECTORY,
  SymptomKey,
  TriageRecord,
  VitalsSnapshot,
} from '../types/triage';
import {encodeVitalsToSMS, formatCompactSmsTag} from '../utils/binarySmsCodec';
import {verifyOfflineAshaEnrollmentCode} from '../utils/cryptoVault';
import {safeReadJson} from '../utils/safeFetchJson';
import {useVirtualWindow} from '../utils/virtualWindow';
import {EdgeAiDiagnosticsPanel} from './EdgeAiDiagnosticsPanel';
import {AshaSaheliModal} from './AshaSaheliModal';
import {IncentiveLedgerModal} from './IncentiveLedgerModal';
import {AshaNavTab} from './TopRoleToolbar';

interface AshaWorkerPWAProps {
  ashaId: string;
  ashaDisplayName: string;
  villageCode: string;
  sessionToken: string;
  isAshaVerified?: boolean;
  onAshaVerified?: (newToken?: string) => void;
  networkState: NetworkState;
  records: TriageRecord[];
  incentives: IncentiveEntry[];
  pendingOfflineCount: number;
  isLoadingRecords?: boolean;
  activeTab: AshaNavTab;
  onSelectTab: (tab: AshaNavTab) => void;
  onSaveRecord: (record: TriageRecord, isEmergencySms: boolean) => void;
}

const SYMPTOM_OPTIONS: Array<{key: SymptomKey; label: string; helper: string}> = [
  {key: 'Fever', label: 'Fever or chills', helper: 'Warm forehead or shivering'},
  {key: 'High BP', label: 'Known high BP', helper: 'Past history or headache'},
  {key: 'Severe Chest Pain', label: 'Chest pain or pressure', helper: 'Urgent warning sign'},
  {key: 'Dizziness', label: 'Dizziness or weakness', helper: 'Lightheaded when standing'},
  {key: 'Cough', label: 'Persistent cough', helper: 'Lasting more than 3 days'},
  {key: 'Bleeding', label: 'Unusual bleeding', helper: 'Urgent warning sign'},
];

function StatusBadgeText({severity}: {severity: SeverityLevel}) {
  if (severity === 'emergency') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700">
        <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
        <span>Urgent Care Needed</span>
      </span>
    );
  }
  if (severity === 'moderate') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
        <span>Needs Doctor Review</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
      <span>Normal</span>
    </span>
  );
}

export const AshaWorkerPWA: React.FC<AshaWorkerPWAProps> = ({
  ashaId,
  ashaDisplayName,
  villageCode,
  sessionToken,
  isAshaVerified = true,
  onAshaVerified,
  networkState,
  records = [],
  incentives = [],
  pendingOfflineCount,
  isLoadingRecords = false,
  activeTab,
  onSelectTab,
  onSaveRecord,
}) => {
  const safeRecords = Array.isArray(records) ? records : [];
  const safeIncentives = Array.isArray(incentives) ? incentives : [];
  // Patient Details (clean empty initial name — never pre-filled with fake patient data)
  const [patientName, setPatientName] = useState('');
  const [patientAge, setPatientAge] = useState<string>('35');
  const [patientGender, setPatientGender] = useState<'F' | 'M' | 'O'>('F');
  const [abhaNumber, setAbhaNumber] = useState<string>('');
  const [clinicalNoteInput, setClinicalNoteInput] = useState<string>('');

  // DPDP Section 9 Guardian Consent (for minor patients age < 18) & Adult AI Consent
  const [guardianName, setGuardianName] = useState<string>('');
  const [guardianRelationship, setGuardianRelationship] = useState<
    'Mother' | 'Father' | 'Legal Guardian'
  >('Mother');
  const [guardianConsentConfirmed, setGuardianConsentConfirmed] = useState<boolean>(false);
  const [explicitAiConsent, setExplicitAiConsent] = useState<boolean>(false);

  // ASHA Clinic Enrollment Verification state (when account is pending verification)
  const [enrollmentCodeInput, setEnrollmentCodeInput] = useState<string>('');
  const [verifyingCode, setVerifyingCode] = useState<boolean>(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Standard baseline starting values for convenient adjustment
  const [vitals, setVitals] = useState<VitalsSnapshot>({
    systolic: 120,
    diastolic: 80,
    spo2: 98,
    temperature: 98.6,
    heartRate: 76,
  });
  const [vitalDrafts, setVitalDrafts] = useState<Partial<Record<keyof VitalsSnapshot, string>>>({});
  const [hbDraft, setHbDraft] = useState<string>('');
  const [symptoms, setSymptoms] = useState<SymptomKey[]>([]);
  const [edgeAi, setEdgeAi] = useState<EdgeAiDiagnostics>({
    anemiaSuspected: false,
    respiratoryRiskHigh: false,
  });

  const [showOptionalScreening, setShowOptionalScreening] = useState(false);
  const [eyeScannerModalOpen, setEyeScannerModalOpen] = useState(false);
  const [lastVoiceTranscript, setLastVoiceTranscript] = useState('');
  const [saheliModalOpen, setSaheliModalOpen] = useState(false);
  const [smsModalOpen, setSmsModalOpen] = useState(false);
  const [smsDraft, setSmsDraft] = useState<{
    record: TriageRecord;
    bitPackedSms: string;
    compactTag: string;
    nativeUri: string;
    saved: boolean;
  } | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [sendingGatewaySms, setSendingGatewaySms] = useState(false);
  const [smsGatewayFeedback, setSmsGatewayFeedback] = useState<{
    sent: boolean;
    message: string;
    nativeUri: string;
  } | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);

  // Saved Records Filter & Privacy State
  const [recordSearch, setRecordSearch] = useState('');
  const [revealHealthIds, setRevealHealthIds] = useState(false);

  const isMountedRef = useRef<boolean>(true);
  const feedbackTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof edgeAi.estimatedHb === 'number' && Number.isFinite(edgeAi.estimatedHb)) {
      setHbDraft(edgeAi.estimatedHb.toFixed(1));
    } else if (edgeAi.estimatedHb === undefined) {
      setHbDraft('');
    }
  }, [edgeAi.estimatedHb]);

  const clinicMeta = useMemo(
    () =>
      SUB_CENTER_DIRECTORY.find((c) => c.code === villageCode) || {
        code: villageCode,
        name: `${villageCode} Health Clinic`,
      },
    [villageCode]
  );

  const totalIncentiveInr = useMemo(
    () => safeIncentives.reduce((sum, item) => sum + (Number(item?.amountInr) || 0), 0),
    [safeIncentives]
  );

  const triage = useMemo(
    () => evaluateTriage(vitals, symptoms, edgeAi),
    [vitals, symptoms, edgeAi]
  );

  const nextPatientId = useMemo(() => {
    let maxNum = 1000;
    for (const r of safeRecords) {
      const digits = String(r?.patientId || '').replace(/\D/g, '');
      const n = digits ? Number(digits) : 0;
      if (Number.isSafeInteger(n) && n > maxNum && n < 9_000_000) {
        maxNum = n;
      }
    }
    return `PT${maxNum + 1}`;
  }, [safeRecords]);

  const bitPacked28CharSms = useMemo(() => {
    try {
      return encodeVitalsToSMS({
        patientId: nextPatientId || 'PT1001',
        ashaId: ashaId || 'ASHA-8842',
        villageCode: villageCode || 'VIL-204',
        vitals,
        symptoms: symptoms || [],
        edgeAi,
        severity: triage?.severity || 'routine',
      });
    } catch (err) {
      console.warn('[SwasthyaSetu SMS] Fallback shorthand tag used for SMS encoding:', err);
      return formatCompactSmsTag({
        patientId: 'PT1001',
        ashaId: ashaId || '8842',
        villageCode: 'VIL-204',
        vitals,
        symptoms: symptoms || [],
        edgeAi,
        severity: triage?.severity || 'routine',
      });
    }
  }, [nextPatientId, ashaId, villageCode, vitals, symptoms, edgeAi, triage?.severity]);

  const compactSmsTag = useMemo(() => {
    try {
      return formatCompactSmsTag({
        patientId: nextPatientId || 'PT1001',
        ashaId: ashaId || '8842',
        villageCode: villageCode || 'VIL-204',
        vitals,
        symptoms: symptoms || [],
        edgeAi,
        severity: triage?.severity || 'routine',
      });
    } catch {
      return `HS#A8842#BP${vitals?.systolic ?? 120}/${vitals?.diastolic ?? 80}#SPO2${vitals?.spo2 ?? 98}#RED`;
    }
  }, [nextPatientId, ashaId, villageCode, vitals, symptoms, edgeAi, triage?.severity]);

  const defaultNativeSmsUri = useMemo(
    () => `sms:+9118001801104?body=${encodeURIComponent(bitPacked28CharSms)}`,
    [bitPacked28CharSms]
  );

  const filteredRecords = useMemo(() => {
    const q = recordSearch.trim().toLowerCase();
    if (!q) return safeRecords;
    return safeRecords.filter(
      (r) =>
        String(r?.patientName || '').toLowerCase().includes(q) ||
        String(r?.patientId || '').toLowerCase().includes(q) ||
        String(r?.villageCode || '').toLowerCase().includes(q)
    );
  }, [safeRecords, recordSearch]);

  const savedRecordsVirtual = useVirtualWindow<HTMLDivElement, HTMLDivElement>({
    count: filteredRecords.length,
    itemHeight: 96,
    viewportHeight: 560,
    overscan: 6,
    resetKey: `${recordSearch}|${activeTab}`,
  });

  const applyVoiceEntities = (
    vitalsPatch: Partial<VitalsSnapshot>,
    detectedSymptoms: SymptomKey[],
    transcript: string
  ) => {
    setLastVoiceTranscript(transcript);
    if (Object.keys(vitalsPatch).length > 0) {
      setVitalDrafts({});
      setVitals((prev) => ({
        ...prev,
        ...vitalsPatch,
      }));
    }
    if (detectedSymptoms.length > 0) {
      setSymptoms((prev) => Array.from(new Set([...prev, ...detectedSymptoms])));
    }
  };

  const toggleSymptom = (sym: SymptomKey) => {
    setSymptoms((prev) =>
      prev.includes(sym) ? prev.filter((item) => item !== sym) : [...prev, sym]
    );
  };

  const handleVitalInputChange = (
    field: keyof VitalsSnapshot,
    raw: string,
    min: number,
    max: number,
    decimals = 0
  ) => {
    setVitalDrafts((prev) => ({...prev, [field]: raw}));
    const trimmed = raw.trim();
    if (!trimmed) return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    if (parsed >= min && parsed <= max) {
      const rounded = decimals > 0 ? Number(parsed.toFixed(decimals)) : Math.round(parsed);
      setVitals((prev) => ({...prev, [field]: rounded}));
    }
  };

  const handleVitalInputBlur = (
    field: keyof VitalsSnapshot,
    min: number,
    max: number,
    decimals = 0
  ) => {
    const raw = vitalDrafts[field];
    if (raw !== undefined) {
      const parsed = Number(raw.trim());
      if (raw.trim() !== '' && Number.isFinite(parsed)) {
        const clamped = Math.min(max, Math.max(min, parsed));
        const finalVal = decimals > 0 ? Number(clamped.toFixed(decimals)) : Math.round(clamped);
        setVitals((prev) => ({...prev, [field]: finalVal}));
      }
      setVitalDrafts((prev) => {
        const next = {...prev};
        delete next[field];
        return next;
      });
    }
  };

  const adjustVital = (
    field: keyof VitalsSnapshot,
    delta: number,
    min: number,
    max: number,
    decimals = 0
  ) => {
    setVitalDrafts((prev) => {
      const next = {...prev};
      delete next[field];
      return next;
    });
    setVitals((prev) => {
      const nextRaw = Math.min(max, Math.max(min, prev[field] + delta));
      const nextVal = decimals > 0 ? Number(nextRaw.toFixed(decimals)) : Math.round(nextRaw);
      return {...prev, [field]: nextVal};
    });
  };

  const handleHbInputChange = (raw: string) => {
    setHbDraft(raw);
    const trimmed = raw.trim();
    if (!trimmed) {
      setEdgeAi((prev) => ({
        ...prev,
        anemiaSuspected: false,
        estimatedHb: undefined,
        conjunctivaMetrics: undefined,
      }));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    if (parsed >= 3.0 && parsed <= 20.0) {
      const rounded = Number(parsed.toFixed(1));
      setEdgeAi((prev) => ({
        ...prev,
        estimatedHb: rounded,
        anemiaSuspected: rounded < 10.0,
      }));
    }
  };

  const handleHbInputBlur = () => {
    const trimmed = hbDraft.trim();
    if (!trimmed) {
      setHbDraft('');
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setHbDraft(
        typeof edgeAi.estimatedHb === 'number' ? edgeAi.estimatedHb.toFixed(1) : ''
      );
      return;
    }
    const clamped = Number(Math.min(20.0, Math.max(3.5, parsed)).toFixed(1));
    setHbDraft(clamped.toFixed(1));
    setEdgeAi((prev) => ({
      ...prev,
      estimatedHb: clamped,
      anemiaSuspected: clamped < 10.0,
    }));
  };

  const isMinorPatient = useMemo(() => {
    const num = Number(patientAge);
    return Number.isFinite(num) && num > 0 && num < 18;
  }, [patientAge]);

  const handleSubmitEnrollmentCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyError(null);
    const trimmedCode = enrollmentCodeInput.trim();
    if (!trimmedCode) {
      setVerifyError('Please enter your Clinic Enrollment Code.');
      return;
    }
    setVerifyingCode(true);
    try {
      if (networkState === 'offline' || sessionToken === 'OFFLINE_LOCAL_SESSION') {
        const validLocal = await verifyOfflineAshaEnrollmentCode(trimmedCode);
        if (!validLocal) {
          setVerifyError('Invalid Clinic Enrollment Code.');
          return;
        }
        setEnrollmentCodeInput('');
        setFeedbackNotice(
          'Your Health Worker account is now verified and connected to the District 24 Medical Officer dashboard.'
        );
        onAshaVerified?.();
        return;
      }

      const resp = await fetch('/api/auth/verify-asha', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ashaEnrollmentCode: trimmedCode}),
      });
      const parsed = await safeReadJson<{ok?: boolean; token?: string; error?: string}>(resp);
      if (!resp.ok || !parsed.isJson || !parsed.data?.ok) {
        if (!parsed.isJson || resp.status >= 500 || resp.status === 404) {
          const validLocal = await verifyOfflineAshaEnrollmentCode(trimmedCode);
          if (validLocal) {
            setEnrollmentCodeInput('');
            setFeedbackNotice(
              'Your Health Worker account is now verified and connected to the District 24 Medical Officer dashboard.'
            );
            onAshaVerified?.();
            return;
          }
        }
        setVerifyError(parsed.data?.error || 'Could not verify Clinic Enrollment Code.');
        return;
      }
      setEnrollmentCodeInput('');
      setFeedbackNotice(
        'Your Health Worker account is now verified for hospital sync and emergency alerts.'
      );
      onAshaVerified?.(parsed.data.token);
    } catch {
      const validLocal = await verifyOfflineAshaEnrollmentCode(trimmedCode);
      if (validLocal) {
        setEnrollmentCodeInput('');
        setFeedbackNotice(
          'Your Health Worker account is now verified and connected to the District 24 Medical Officer dashboard.'
        );
        onAshaVerified?.();
        return;
      }
      setVerifyError('Could not reach the hospital server to verify your enrollment code.');
    } finally {
      if (isMountedRef.current) {
        setVerifyingCode(false);
      }
    }
  };

  const resetFormForNextPatient = () => {
    setPatientName('');
    setPatientAge('35');
    setPatientGender('F');
    setAbhaNumber('');
    setClinicalNoteInput('');
    setGuardianName('');
    setGuardianRelationship('Mother');
    setGuardianConsentConfirmed(false);
    setExplicitAiConsent(false);
    setVitalDrafts({});
    setHbDraft('');
    setVitals({
      systolic: 120,
      diastolic: 80,
      spo2: 98,
      temperature: 98.6,
      heartRate: 76,
    });
    setSymptoms([]);
    setEdgeAi({anemiaSuspected: false, respiratoryRiskHigh: false});
    setLastVoiceTranscript('');
    setFormError(null);
  };

  const validatePatientAndConsent = (): boolean => {
    if (!patientName.trim()) {
      setFormError('Please enter the patient’s name before saving this checkup.');
      return false;
    }
    const parsedAge = Number(patientAge);
    if (!Number.isFinite(parsedAge) || parsedAge < 0 || parsedAge > 120) {
      setFormError('Please enter a valid patient age between 0 and 120.');
      return false;
    }
    if (parsedAge < 18) {
      if (!guardianName.trim() || guardianName.trim().length < 2) {
        setFormError(
          'DPDP Section 9 Requirement: For patients under 18 years old, please enter the Parent or Legal Guardian’s full name.'
        );
        return false;
      }
      if (!guardianConsentConfirmed) {
        setFormError(
          'DPDP Section 9 Requirement: Please confirm verifiable Parent or Legal Guardian consent before saving a minor’s health record.'
        );
        return false;
      }
    }
    return true;
  };

  const buildRecord = (isEmergencySms: boolean): TriageRecord => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const parsedAge = Math.min(115, Math.max(0, Math.round(Number(patientAge) || 35)));
    const isMinor = parsedAge < 18;
    const safeVitals: VitalsSnapshot = {
      systolic: Math.min(260, Math.max(50, Math.round(Number(vitals.systolic) || 120))),
      diastolic: Math.min(170, Math.max(35, Math.round(Number(vitals.diastolic) || 80))),
      spo2: Math.min(100, Math.max(50, Math.round(Number(vitals.spo2) || 98))),
      temperature: Number(
        Math.min(109, Math.max(93, Number(vitals.temperature) || 98.6)).toFixed(1)
      ),
      heartRate: Math.min(220, Math.max(35, Math.round(Number(vitals.heartRate) || 76))),
    };
    const uniqueSuffix =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);

    return {
      id: `rec-${Date.now()}-${uniqueSuffix}`,
      patientId: nextPatientId,
      abhaId: abhaNumber.trim() || 'Not provided',
      patientName: patientName.trim(),
      age: parsedAge,
      gender: patientGender,
      villageCode,
      villageName: clinicMeta.name,
      ashaWorker: `${ashaDisplayName} (${ashaId})`,
      vitals: safeVitals,
      symptoms: [...symptoms],
      edgeAi: {...edgeAi},
      severity: triage.severity,
      clinicalNotes:
        clinicalNoteInput.trim() ||
        (lastVoiceTranscript ? `Voice note: "${lastVoiceTranscript}"` : triage.protocolEn),
      channel: isEmergencySms ? 'Emergency SMS' : 'Data',
      syncStatus: isEmergencySms
        ? 'SMS Delivered'
        : networkState === 'offline' || !isAshaVerified
        ? 'Queued Offline'
        : 'Synced',
      binarySmsPayload: bitPacked28CharSms,
      timestamp: timeStr,
      createdAtMs: Date.now(),
      dispatchStatus: 'Unassigned',
      patientConsent: {
        isMinor,
        guardianName: isMinor ? guardianName.trim() : undefined,
        guardianRelationship: isMinor ? guardianRelationship : undefined,
        verifiableGuardianConsent: isMinor ? guardianConsentConfirmed : true,
        consentGranted: isMinor ? guardianConsentConfirmed : true,
        consentTimestampMs: Date.now(),
        lawfulBasis:
          triage.severity === 'emergency'
            ? 'medical_emergency_vital_interest'
            : 'explicit_consent',
        aiProcessingConsent: !isMinor && explicitAiConsent,
      },
    };
  };

  const openEmergencySmsModal = () => {
    setFormError(null);
    if (!validatePatientAndConsent()) {
      return;
    }
    const snapshotRecord = buildRecord(true);
    setSmsGatewayFeedback(null);
    setCopiedPayload(false);
    setSmsDraft({
      record: snapshotRecord,
      bitPackedSms: bitPacked28CharSms,
      compactTag: compactSmsTag,
      nativeUri: defaultNativeSmsUri,
      saved: false,
    });
    setSmsModalOpen(true);
  };

  const ensureSmsDraftRecordSaved = () => {
    if (!smsDraft) return null;
    if (!smsDraft.saved) {
      onSaveRecord(smsDraft.record, true);
      setSmsDraft((prev) => (prev ? {...prev, saved: true} : null));
      resetFormForNextPatient();
    }
    return smsDraft;
  };

  const handlePrimarySaveClick = () => {
    setFormError(null);
    if (!validatePatientAndConsent()) {
      return;
    }

    if (networkState === 'offline' && triage.severity === 'emergency') {
      openEmergencySmsModal();
      return;
    }

    const record = buildRecord(false);
    onSaveRecord(record, false);

    if (networkState === 'offline' || sessionToken === 'OFFLINE_LOCAL_SESSION') {
      setFeedbackNotice(
        `Saved privately on this device for ${record.patientName}. It will sync automatically when connected to the hospital server.`
      );
    } else if (!isAshaVerified) {
      setFeedbackNotice(
        `Saved privately on this device for ${record.patientName}. Verify your account above to sync with the hospital dashboard.`
      );
    } else if (triage.severity === 'emergency') {
      setFeedbackNotice(
        `Urgent checkup saved for ${record.patientName} and shared immediately with the hospital doctor.`
      );
    } else {
      setFeedbackNotice(`Checkup saved for ${record.patientName}.`);
    }

    resetFormForNextPatient();
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      if (isMountedRef.current) {
        setFeedbackNotice(null);
      }
    }, 6000);
  };

  const handleConfirmSendEmergencySms = async () => {
    const activeDraft = ensureSmsDraftRecordSaved();
    if (!activeDraft) {
      setSmsModalOpen(false);
      return;
    }

    if (networkState === 'offline' || sessionToken === 'OFFLINE_LOCAL_SESSION') {
      setSmsGatewayFeedback({
        sent: false,
        message:
          'Checkup saved on this device. Because internet is offline, tap "Open Phone Text Message App" below to send the urgent code over basic cellular signal.',
        nativeUri: activeDraft.nativeUri,
      });
      return;
    }

    setSendingGatewaySms(true);
    try {
      const resp = await fetch('/api/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          payloadText: activeDraft.bitPackedSms,
          recordId: activeDraft.record.id,
        }),
      });
      const parsed = await safeReadJson<{
        sent?: boolean;
        statusMessage?: string;
        nativeSmsUri?: string;
        error?: string;
        data?: {
          sent?: boolean;
          statusMessage?: string;
          nativeSmsUri?: string;
        };
      }>(resp);
      if (!isMountedRef.current) return;
      if (!resp.ok || !parsed.isJson || !parsed.data) {
        console.warn('[SwasthyaSetu SMS] Gateway send returned fallback status:', resp.status);
        setSmsGatewayFeedback({
          sent: false,
          message:
            parsed.data?.error ||
            'Could not reach server SMS service. Tap "Open Phone Text Message App" below to send directly from your phone.',
          nativeUri: activeDraft.nativeUri,
        });
        return;
      }
      const rawData = parsed.data;
      const resolved = rawData.data ?? rawData;
      setSmsGatewayFeedback({
        sent: Boolean(resolved.sent),
        message: resolved.statusMessage || 'Urgent SMS request processed.',
        nativeUri: resolved.nativeSmsUri || activeDraft.nativeUri,
      });
    } catch (err) {
      console.warn('[SwasthyaSetu SMS] Network fallback to phone SMS app:', err);
      if (!isMountedRef.current) return;
      setSmsGatewayFeedback({
        sent: false,
        message:
          'Could not reach server SMS service. Tap "Open Phone Text Message App" below to send directly from your phone.',
        nativeUri: activeDraft.nativeUri,
      });
    } finally {
      if (isMountedRef.current) {
        setSendingGatewaySms(false);
      }
    }
  };

  const systolicStatus = evaluateVitalStatus('systolic', vitals.systolic);
  const diastolicStatus = evaluateVitalStatus('diastolic', vitals.diastolic);
  const spo2Status = evaluateVitalStatus('spo2', vitals.spo2);
  const tempStatus = evaluateVitalStatus('temperature', vitals.temperature);
  const pulseStatus = evaluateVitalStatus('heartRate', vitals.heartRate);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-24 sm:px-6 md:pb-10">
      {/* Workspace Header */}
      <div className="mb-6 flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-medium text-slate-500">
            {clinicMeta.name} · {ashaDisplayName} ({ashaId})
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            {activeTab === 'checkup'
              ? 'Patient Health Checkup'
              : activeTab === 'records'
              ? 'Saved Patient Checkups'
              : activeTab === 'assistant'
              ? 'Voice Input & Care Helper'
              : 'Completed Visits & Stipend'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {activeTab === 'checkup' && (
            <button
              type="button"
              onClick={() => setSaheliModalOpen(true)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              <Mic className="h-4 w-4 text-teal-700 shrink-0" />
              <span>Fill by Voice</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onSelectTab('activity')}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap cursor-pointer tabular-nums"
          >
            <Award className="h-4 w-4 text-teal-700 shrink-0" />
            <span>Stipend Log: ₹{totalIncentiveInr}</span>
          </button>
        </div>
      </div>

      {/* Pending ASHA Account Verification Banner */}
      {!isAshaVerified && (
        <div
          role="status"
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-950 space-y-3"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div>
              <p className="font-semibold">Account Pending Hospital Verification</p>
              <p className="mt-0.5 text-xs text-amber-900">
                Your checkups are encrypted safely on this device, but hospital sync, stipend
                credits, and emergency SMS alerts remain paused until a District Medical Officer
                approves your ID or you enter a valid Clinic Enrollment Code below.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmitEnrollmentCode} className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={enrollmentCodeInput}
              onChange={(e) => setEnrollmentCodeInput(e.target.value)}
              placeholder="Enter Clinic Enrollment Code"
              className="min-h-[40px] flex-1 min-w-[200px] rounded-xl border border-amber-300 bg-white px-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
            />
            <button
              type="submit"
              disabled={verifyingCode}
              className="min-h-[40px] rounded-xl bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60 cursor-pointer"
            >
              {verifyingCode ? 'Verifying...' : 'Verify Account'}
            </button>
          </form>
          {verifyError && <p className="text-xs font-medium text-red-700">{verifyError}</p>}
        </div>
      )}

      {/* Feedback Banner */}
      {feedbackNotice && (
        <div
          role="status"
          className="mb-6 flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
        >
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
            <span>{feedbackNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedbackNotice(null)}
            aria-label="Dismiss message"
            className="text-emerald-800 hover:text-emerald-950 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* TAB 1: NEW PATIENT CHECKUP */}
      {activeTab === 'checkup' && (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 items-start">
          {/* Left 7 Columns: Simple, Clear Form */}
          <div className="lg:col-span-7 space-y-6">
            {formError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
              >
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                <span>{formError}</span>
              </div>
            )}

            {lastVoiceTranscript && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-xs text-teal-950">
                <span>
                  <strong className="font-semibold">Filled from voice:</strong> “{lastVoiceTranscript}”
                </span>
                <button
                  type="button"
                  onClick={() => setLastVoiceTranscript('')}
                  className="text-xs font-semibold text-teal-800 hover:underline shrink-0 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Section 1: Basic Patient Information */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">1. Patient Details</h2>
                <p className="text-xs text-slate-600">
                  Enter the patient&apos;s name and age. Health ID is optional and kept private.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
                <div className="sm:col-span-7">
                  <label
                    htmlFor="pt-name-input"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Patient Full Name <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="pt-name-input"
                    type="text"
                    value={patientName}
                    onChange={(e) => {
                      setPatientName(e.target.value);
                      if (formError) setFormError(null);
                    }}
                    placeholder="e.g. Sunita Kumari"
                    className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor="pt-age-input"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Age
                  </label>
                  <input
                    id="pt-age-input"
                    type="number"
                    min={1}
                    max={115}
                    value={patientAge}
                    onChange={(e) => setPatientAge(e.target.value)}
                    className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-semibold text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-3">
                  <label
                    htmlFor="pt-gender-select"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    Gender
                  </label>
                  <select
                    id="pt-gender-select"
                    value={patientGender}
                    onChange={(e) => setPatientGender(e.target.value as 'F' | 'M' | 'O')}
                    className="min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-teal-700 focus:outline-none"
                  >
                    <option value="F">Female</option>
                    <option value="M">Male</option>
                    <option value="O">Other</option>
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="pt-abha-input"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  ABHA Health ID <span className="font-normal text-slate-500">(Optional)</span>
                </label>
                <input
                  id="pt-abha-input"
                  type="text"
                  value={abhaNumber}
                  onChange={(e) => setAbhaNumber(e.target.value)}
                  placeholder="e.g. 91-0000-0000-0000"
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3.5 font-mono text-sm text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                />
              </div>

              {isMinorPatient ? (
                <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                  <div>
                    <p className="text-xs font-semibold text-amber-950">
                      Parent / Legal Guardian Consent Required (DPDP Act Section 9)
                    </p>
                    <p className="mt-0.5 text-xs text-amber-900">
                      Patients under 18 years require verifiable parent or legal guardian consent
                      before health data is stored. AI summaries always anonymize minor identifiers.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                    <div className="sm:col-span-8">
                      <label
                        htmlFor="guardian-name-input"
                        className="mb-1 block text-xs font-medium text-slate-800"
                      >
                        Parent / Guardian Full Name <span className="text-red-600">*</span>
                      </label>
                      <input
                        id="guardian-name-input"
                        type="text"
                        value={guardianName}
                        onChange={(e) => {
                          setGuardianName(e.target.value);
                          if (formError) setFormError(null);
                        }}
                        placeholder="e.g. Ramesh Kumar"
                        className="min-h-[42px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                      />
                    </div>

                    <div className="sm:col-span-4">
                      <label
                        htmlFor="guardian-rel-select"
                        className="mb-1 block text-xs font-medium text-slate-800"
                      >
                        Relationship
                      </label>
                      <select
                        id="guardian-rel-select"
                        value={guardianRelationship}
                        onChange={(e) =>
                          setGuardianRelationship(
                            e.target.value as 'Mother' | 'Father' | 'Legal Guardian'
                          )
                        }
                        className="min-h-[42px] w-full rounded-xl border border-slate-300 bg-white px-2.5 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                      >
                        <option value="Mother">Mother</option>
                        <option value="Father">Father</option>
                        <option value="Legal Guardian">Legal Guardian</option>
                      </select>
                    </div>
                  </div>

                  <label className="flex cursor-pointer items-start gap-2.5 pt-1 text-xs text-slate-800">
                    <input
                      type="checkbox"
                      checked={guardianConsentConfirmed}
                      onChange={(e) => {
                        setGuardianConsentConfirmed(e.target.checked);
                        if (formError) setFormError(null);
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-teal-700"
                    />
                    <span>
                      I have verified the parent/legal guardian&apos;s identity and obtained
                      explicit consent to record and share this minor&apos;s checkup with the
                      hospital doctor.
                    </span>
                  </label>
                </div>
              ) : (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={explicitAiConsent}
                    onChange={(e) => setExplicitAiConsent(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-teal-700"
                  />
                  <span>
                    Patient explicitly consents to include their name if an optional AI Care Summary
                    is requested (otherwise AI summaries use anonymized vitals only).
                  </span>
                </label>
              )}
            </section>

            {/* Section 2: Vital Signs in Plain Language */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
              <div>
                <h2 className="text-base font-bold text-slate-900">2. Vital Signs</h2>
                <p className="text-xs text-slate-600">
                  Type numbers directly or tap the minus and plus buttons to adjust.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* Systolic BP */}
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="vital-sys"
                      className="text-sm font-semibold text-slate-900"
                    >
                      BP — Top (Systolic)
                    </label>
                    <StatusBadgeText severity={systolicStatus} />
                  </div>
                  <p className="text-xs text-slate-500">Normal range: 90–120 mmHg</p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => adjustVital('systolic', -2, 50, 260)}
                      aria-label="Decrease systolic blood pressure"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <input
                      id="vital-sys"
                      type="number"
                      min={50}
                      max={260}
                      value={vitalDrafts.systolic ?? String(vitals.systolic)}
                      onChange={(e) => handleVitalInputChange('systolic', e.target.value, 50, 260)}
                      onBlur={() => handleVitalInputBlur('systolic', 50, 260)}
                      className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-center font-mono text-lg font-semibold text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => adjustVital('systolic', 2, 50, 260)}
                      aria-label="Increase systolic blood pressure"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Diastolic BP */}
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="vital-dia"
                      className="text-sm font-semibold text-slate-900"
                    >
                      BP — Bottom (Diastolic)
                    </label>
                    <StatusBadgeText severity={diastolicStatus} />
                  </div>
                  <p className="text-xs text-slate-500">Normal range: 60–80 mmHg</p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => adjustVital('diastolic', -2, 35, 170)}
                      aria-label="Decrease diastolic blood pressure"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <input
                      id="vital-dia"
                      type="number"
                      min={35}
                      max={170}
                      value={vitalDrafts.diastolic ?? String(vitals.diastolic)}
                      onChange={(e) => handleVitalInputChange('diastolic', e.target.value, 35, 170)}
                      onBlur={() => handleVitalInputBlur('diastolic', 35, 170)}
                      className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-center font-mono text-lg font-semibold text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => adjustVital('diastolic', 2, 35, 170)}
                      aria-label="Increase diastolic blood pressure"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Blood Oxygen SpO2 */}
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="vital-spo2"
                      className="text-sm font-semibold text-slate-900"
                    >
                      Blood Oxygen (SpO₂ %)
                    </label>
                    <StatusBadgeText severity={spo2Status} />
                  </div>
                  <p className="text-xs text-slate-500">Normal range: 95–100%</p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => adjustVital('spo2', -1, 50, 100)}
                      aria-label="Decrease blood oxygen"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <input
                      id="vital-spo2"
                      type="number"
                      min={50}
                      max={100}
                      value={vitalDrafts.spo2 ?? String(vitals.spo2)}
                      onChange={(e) => handleVitalInputChange('spo2', e.target.value, 50, 100)}
                      onBlur={() => handleVitalInputBlur('spo2', 50, 100)}
                      className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-center font-mono text-lg font-semibold text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => adjustVital('spo2', 1, 50, 100)}
                      aria-label="Increase blood oxygen"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Body Temperature */}
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="vital-temp"
                      className="text-sm font-semibold text-slate-900"
                    >
                      Temperature (°F)
                    </label>
                    <StatusBadgeText severity={tempStatus} />
                  </div>
                  <p className="text-xs text-slate-500">Normal range: 97.0–99.5°F</p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => adjustVital('temperature', -0.2, 93, 109, 1)}
                      aria-label="Decrease body temperature"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <input
                      id="vital-temp"
                      type="number"
                      step="0.1"
                      min={93}
                      max={109}
                      value={vitalDrafts.temperature ?? String(vitals.temperature)}
                      onChange={(e) =>
                        handleVitalInputChange('temperature', e.target.value, 93, 109, 1)
                      }
                      onBlur={() => handleVitalInputBlur('temperature', 93, 109, 1)}
                      className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-center font-mono text-lg font-semibold text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => adjustVital('temperature', 0.2, 93, 109, 1)}
                      aria-label="Increase body temperature"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Pulse Rate */}
              <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <label htmlFor="vital-hr" className="text-sm font-semibold text-slate-900">
                      Pulse (Heartbeats per minute)
                    </label>
                    <StatusBadgeText severity={pulseStatus} />
                  </div>
                  <p className="text-xs text-slate-500">Normal resting range: 60–100 bpm</p>
                </div>

                <div className="flex items-center gap-2 sm:w-52">
                  <button
                    type="button"
                    onClick={() => adjustVital('heartRate', -2, 35, 220)}
                    aria-label="Decrease pulse"
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <input
                    id="vital-hr"
                    type="number"
                    min={35}
                    max={220}
                    value={vitalDrafts.heartRate ?? String(vitals.heartRate)}
                    onChange={(e) => handleVitalInputChange('heartRate', e.target.value, 35, 220)}
                    onBlur={() => handleVitalInputBlur('heartRate', 35, 220)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-center font-mono text-base font-semibold text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => adjustVital('heartRate', 2, 35, 220)}
                    aria-label="Increase pulse"
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Estimated Hemoglobin (g/dL) — Auto-populated from Anemia Eye Scanner or manual entry */}
              <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="vital-hb" className="text-sm font-semibold text-slate-900">
                      Estimated Hemoglobin (g/dL)
                    </label>
                    {edgeAi.estimatedHb !== undefined && edgeAi.estimatedHb < 7.0 ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                        <span>Severe Anemia Risk</span>
                      </span>
                    ) : (edgeAi.estimatedHb !== undefined && edgeAi.estimatedHb < 10.0) ||
                      edgeAi.anemiaSuspected ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700" />
                        <span>Anemia Risk</span>
                      </span>
                    ) : edgeAi.estimatedHb !== undefined ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
                        <span>Normal</span>
                      </span>
                    ) : (
                      <span className="text-xs font-normal text-slate-500">(Optional / Eye Scan)</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    Normal: &ge; 10.0 g/dL · Auto-fills from Anemia Eye Scanner
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    id="vital-hb"
                    type="number"
                    step="0.1"
                    min={3.5}
                    max={20}
                    value={hbDraft}
                    onChange={(e) => handleHbInputChange(e.target.value)}
                    onBlur={handleHbInputBlur}
                    placeholder="—"
                    aria-label="Estimated Hemoglobin in g/dL"
                    className="min-h-[44px] w-24 rounded-xl border border-slate-300 bg-white px-3 text-center font-mono text-base font-semibold text-slate-900 tabular-nums placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setEyeScannerModalOpen(true)}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-teal-200 bg-teal-50 px-3.5 py-2 text-xs font-semibold text-teal-900 hover:bg-teal-100 whitespace-nowrap cursor-pointer"
                  >
                    <Eye className="h-4 w-4 shrink-0 text-teal-700" />
                    <span>Scan Eyelid</span>
                  </button>
                </div>
              </div>
            </section>

            {/* Section 3: Symptoms */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">3. Current Symptoms</h2>
                <p className="text-xs text-slate-600">
                  Select any symptoms the patient is experiencing today.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {SYMPTOM_OPTIONS.map((opt) => {
                  const checked = symptoms.includes(opt.key);
                  return (
                    <label
                      key={opt.key}
                      className={`flex min-h-[52px] cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                        checked
                          ? 'border-teal-700 bg-teal-50/60 text-slate-900'
                          : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSymptom(opt.key)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-teal-700"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{opt.label}</span>
                        <span className="block text-xs text-slate-500">{opt.helper}</span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <div>
                <label
                  htmlFor="pt-notes-input"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  Short Care Note <span className="font-normal text-slate-500">(Optional)</span>
                </label>
                <textarea
                  id="pt-notes-input"
                  rows={2}
                  value={clinicalNoteInput}
                  onChange={(e) => setClinicalNoteInput(e.target.value)}
                  placeholder="Any helpful context for the doctor (e.g. pregnant 7 months, taking BP medicine)..."
                  className="w-full rounded-xl border border-slate-300 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                />
              </div>
            </section>

            {/* Section 4: Anemia Eye Scanner & Cough Check */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
              <button
                type="button"
                onClick={() => setShowOptionalScreening((prev) => !prev)}
                aria-expanded={showOptionalScreening}
                className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left cursor-pointer"
              >
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    4. Anemia Eye Scanner &amp; Cough Check
                  </h2>
                  <p className="text-xs text-slate-600">
                    {edgeAi.estimatedHb !== undefined
                      ? `Est. Hb ${edgeAi.estimatedHb.toFixed(1)} g/dL (${
                          edgeAi.estimatedHb < 10.0 ? 'Anemia Risk Flagged' : 'Normal Range'
                        }) — tap to review or rescan`
                      : edgeAi.anemiaSuspected || edgeAi.respiratoryRiskHigh
                      ? 'Observation recorded — tap to review or reset'
                      : 'Open to estimate Hemoglobin (g/dL) from lower eyelid or check cough pitch'}
                  </p>
                </div>
                {showOptionalScreening ? (
                  <ChevronUp className="h-5 w-5 shrink-0 text-slate-500" />
                ) : (
                  <ChevronDown className="h-5 w-5 shrink-0 text-slate-500" />
                )}
              </button>

              {showOptionalScreening && (
                <div className="mt-4 border-t border-slate-200 pt-4">
                  <EdgeAiDiagnosticsPanel diagnostics={edgeAi} onChange={setEdgeAi} />
                </div>
              )}
            </section>
          </div>

          {/* Right 5 Columns: Live Plain-Language Health Summary & Save Actions */}
          <div className="lg:col-span-5 lg:sticky lg:top-20 space-y-4">
            <section
              className={`rounded-2xl border p-5 sm:p-6 space-y-4 ${
                triage.severity === 'emergency'
                  ? 'border-red-200 bg-red-50/70'
                  : triage.severity === 'moderate'
                  ? 'border-amber-200 bg-amber-50/70'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-slate-600">Health Assessment</p>
                  <div className="mt-1 flex items-center gap-2">
                    {triage.severity === 'emergency' ? (
                      <>
                        <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
                        <h2 className="text-lg font-bold text-red-900">Urgent Care Needed</h2>
                      </>
                    ) : triage.severity === 'moderate' ? (
                      <>
                        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-700" />
                        <h2 className="text-lg font-bold text-amber-950">Needs Doctor Review</h2>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-700" />
                        <h2 className="text-lg font-bold text-slate-900">Within Normal Range</h2>
                      </>
                    )}
                  </div>
                </div>

                <div className="text-right font-mono text-xs text-slate-600 tabular-nums space-y-1">
                  <span className="block">
                    {vitals.systolic}/{vitals.diastolic} · {vitals.spo2}%
                  </span>
                  {edgeAi.estimatedHb !== undefined && (
                    <span
                      className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-bold ${
                        edgeAi.estimatedHb < 7.0
                          ? 'bg-red-100 text-red-900'
                          : edgeAi.estimatedHb < 10.0
                          ? 'bg-amber-100 text-amber-950'
                          : 'bg-emerald-100 text-emerald-900'
                      }`}
                    >
                      Hb {edgeAi.estimatedHb.toFixed(1)} g/dL
                      {edgeAi.estimatedHb < 10.0 ? ' · Anemia Risk' : ''}
                    </span>
                  )}
                </div>
              </div>

              <p className="text-sm leading-relaxed text-slate-700">{triage.protocolEn}</p>

              {/* Plain-Language Reasons */}
              <div className="border-t border-slate-200/80 pt-3.5">
                <p className="mb-2 text-xs font-semibold text-slate-700">What we noticed:</p>
                <ul className="space-y-1.5 text-xs text-slate-700">
                  {(triage?.triggers || []).map((reason, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span aria-hidden="true" className="text-slate-400">
                        •
                      </span>
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {triage.severity === 'emergency' && networkState === 'offline' && (
                <div className="rounded-xl border border-red-200 bg-white p-3.5 text-xs leading-relaxed text-red-900">
                  <strong>Offline Urgent Care:</strong> Because internet is off, tapping below will
                  save this checkup and open a compact emergency text message (SMS) you can send to
                  the hospital over basic mobile signal.
                </div>
              )}

              {/* Primary Action Buttons (48px touch targets) */}
              <div className="space-y-2.5 pt-2">
                <button
                  type="button"
                  onClick={handlePrimarySaveClick}
                  className={`flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white transition-colors whitespace-nowrap cursor-pointer ${
                    triage.severity === 'emergency'
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-teal-700 hover:bg-teal-800'
                  }`}
                >
                  <Save className="h-4 w-4 shrink-0" />
                  <span>
                    {triage.severity === 'emergency' && networkState === 'offline'
                      ? 'Save & Prepare Urgent SMS'
                      : 'Save Patient Checkup'}
                  </span>
                </button>

                {triage.severity === 'emergency' && networkState !== 'offline' && (
                  <button
                    type="button"
                    onClick={openEmergencySmsModal}
                    className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl border border-red-300 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 whitespace-nowrap cursor-pointer"
                  >
                    <Send className="h-4 w-4 shrink-0" />
                    <span>Also Send Backup Text Message (SMS)</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={resetFormForNextPatient}
                  className="flex min-h-[42px] w-full items-center justify-center rounded-xl text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                >
                  Reset Form
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* TAB 2: SAVED PATIENT RECORDS */}
      {activeTab === 'records' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="search"
                value={recordSearch}
                onChange={(e) => setRecordSearch(e.target.value)}
                placeholder="Search by patient name or ID..."
                className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRevealHealthIds((prev) => !prev)}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                {revealHealthIds ? (
                  <>
                    <EyeOff className="h-3.5 w-3.5 text-slate-500" />
                    <span>Mask Health IDs</span>
                  </>
                ) : (
                  <>
                    <Eye className="h-3.5 w-3.5 text-slate-500" />
                    <span>Show Health IDs</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => onSelectTab('checkup')}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 whitespace-nowrap cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>New Checkup</span>
              </button>
            </div>
          </div>

          {isLoadingRecords ? (
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-6">
              <div className="h-14 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-14 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-14 animate-pulse rounded-xl bg-slate-100" />
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
                <ClipboardList className="h-6 w-6" />
              </div>
              <h2 className="mt-3 text-base font-semibold text-slate-900">
                {safeRecords.length === 0
                  ? 'No patient checkups saved yet'
                  : 'No matching patient records'}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-slate-600">
                {safeRecords.length === 0
                  ? 'Start a patient checkup to record blood pressure, oxygen, and symptoms safely on this device.'
                  : 'Try clearing your search filter to see all saved checkups.'}
              </p>
              {safeRecords.length === 0 && (
                <button
                  type="button"
                  onClick={() => onSelectTab('checkup')}
                  className="mt-5 min-h-[44px] rounded-xl bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 cursor-pointer"
                >
                  Start First Checkup
                </button>
              )}
            </div>
          ) : (
            <div
              ref={savedRecordsVirtual.containerRef}
              onScroll={savedRecordsVirtual.handleScroll}
              className="custom-scrollbar max-h-[560px] overflow-y-auto rounded-2xl border border-slate-200 bg-white"
            >
              <div ref={savedRecordsVirtual.topSpacerRef} aria-hidden="true" />
              <div className="divide-y divide-slate-200">
                {filteredRecords
                  .slice(savedRecordsVirtual.startIndex, savedRecordsVirtual.endIndex)
                  .map((rec, idx) => (
                    <div
                      key={rec?.id || `rec-${idx}`}
                      className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-slate-900">
                            {rec?.patientName || 'Unnamed Patient'}
                          </h3>
                          <span className="text-xs text-slate-500">
                            · {rec?.age ?? 35} yrs · {rec?.patientId || 'PT0000'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 tabular-nums">
                          BP {rec?.vitals?.systolic ?? 120}/{rec?.vitals?.diastolic ?? 80} mmHg ·
                          Oxygen {rec?.vitals?.spo2 ?? 98}% · Temp {rec?.vitals?.temperature ?? 98.6}
                          °F · Pulse {rec?.vitals?.heartRate ?? 76} bpm
                          {typeof rec?.edgeAi?.estimatedHb === 'number'
                            ? ` · Hb ${rec.edgeAi.estimatedHb.toFixed(1)} g/dL`
                            : ''}
                        </p>
                        <p className="text-xs text-slate-500">
                          {rec?.timestamp || 'Just now'} · {rec?.syncStatus || 'Queued Offline'} ·
                          Health ID:{' '}
                          <span className="font-mono">
                            {revealHealthIds
                              ? rec?.abhaId || 'Not provided'
                              : maskHealthId(rec?.abhaId || 'Not provided')}
                          </span>
                          {rec?.dispatchStatus === 'Dispatched'
                            ? ` · Ambulance on the way (${rec?.etaMinutes ?? 11} min)`
                            : ''}
                        </p>
                      </div>

                      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
                        <StatusBadgeText severity={rec?.severity || 'routine'} />
                      </div>
                    </div>
                  ))}
              </div>
              <div ref={savedRecordsVirtual.bottomSpacerRef} aria-hidden="true" />
            </div>
          )}
        </div>
      )}

      {/* TAB 3: VOICE HELPER (INLINE) */}
      {activeTab === 'assistant' && (
        <div className="max-w-3xl">
          <AshaSaheliModal
            open={true}
            inline={true}
            onClose={() => onSelectTab('checkup')}
            sessionToken={sessionToken}
            networkState={networkState}
            currentVitals={vitals}
            currentSymptoms={symptoms}
            currentEdgeAi={edgeAi}
            patientName={patientName}
            patientAge={Number(patientAge) || 35}
            explicitAiConsent={!isMinorPatient && explicitAiConsent}
            onApplyVoiceEntities={applyVoiceEntities}
          />
        </div>
      )}

      {/* TAB 4: ACTIVITY & STIPEND LOG (INLINE) */}
      {activeTab === 'activity' && (
        <div className="max-w-3xl">
          <IncentiveLedgerModal
            open={true}
            inline={true}
            workerName={ashaDisplayName}
            onClose={() => onSelectTab('checkup')}
            onStartCheckup={() => onSelectTab('checkup')}
            entries={incentives}
          />
        </div>
      )}

      {/* MOBILE BOTTOM NAVIGATION BAR (< md, natural thumb zone) */}
      <nav
        aria-label="Mobile Navigation"
        className="fixed bottom-0 left-0 right-0 z-30 grid h-16 grid-cols-4 items-center border-t border-slate-200 bg-white/95 backdrop-blur-md pb-safe md:hidden"
      >
        <button
          type="button"
          onClick={() => onSelectTab('checkup')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'checkup' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <HeartPulse className="h-5 w-5" />
          <span className="text-[11px] whitespace-nowrap">Checkup</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('records')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'records' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <ClipboardList className="h-5 w-5" />
          <span className="text-[11px] whitespace-nowrap">
            Records{pendingOfflineCount > 0 ? ` (${pendingOfflineCount})` : ''}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('assistant')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'assistant' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <Stethoscope className="h-5 w-5" />
          <span className="text-[11px] whitespace-nowrap">Voice</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTab('activity')}
          className={`flex h-full flex-col items-center justify-center gap-0.5 cursor-pointer ${
            activeTab === 'activity' ? 'text-teal-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <Award className="h-5 w-5" />
          <span className="text-[11px] whitespace-nowrap">Visits</span>
        </button>
      </nav>

      {/* Voice Helper Modal (when opened from Checkup button) */}
      <AshaSaheliModal
        open={saheliModalOpen}
        onClose={() => setSaheliModalOpen(false)}
        sessionToken={sessionToken}
        networkState={networkState}
        currentVitals={vitals}
        currentSymptoms={symptoms}
        currentEdgeAi={edgeAi}
        patientName={patientName}
        patientAge={Number(patientAge) || 35}
        explicitAiConsent={!isMinorPatient && explicitAiConsent}
        onApplyVoiceEntities={applyVoiceEntities}
      />

      {/* Anemia Eye Scanner / Hemoglobin Estimator Modal */}
      {eyeScannerModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="eye-scanner-modal-title"
        >
          <div className="custom-scrollbar max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                  <Eye className="h-5 w-5 shrink-0" />
                </div>
                <div>
                  <h3 id="eye-scanner-modal-title" className="text-base font-bold text-slate-900">
                    Anemia Eye Scanner &amp; Hemoglobin Estimator
                  </h3>
                  <p className="text-xs text-slate-600">
                    Auto-fills Estimated Hemoglobin (g/dL) into the patient checkup form
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEyeScannerModalOpen(false)}
                className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                aria-label="Close Anemia Eye Scanner"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <EdgeAiDiagnosticsPanel diagnostics={edgeAi} onChange={setEdgeAi} />

              <div className="flex justify-end border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setEyeScannerModalOpen(false)}
                  className="min-h-[42px] rounded-xl bg-teal-700 px-5 py-2 text-sm font-semibold text-white hover:bg-teal-800 cursor-pointer"
                >
                  Apply &amp; Return to Checkup
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Emergency Text Message (SMS) Modal */}
      {smsModalOpen && smsDraft && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sms-modal-title"
        >
          <div className="custom-scrollbar max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-50 text-red-600">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                </div>
                <div>
                  <h3 id="sms-modal-title" className="text-base font-bold text-slate-900">
                    Send Urgent Text Alert (SMS)
                  </h3>
                  <p className="text-xs text-slate-600">
                    {smsDraft.record.patientName} ({smsDraft.record.patientId}) · Reaches hospital
                    without internet
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSmsModalOpen(false);
                  setSmsDraft(null);
                }}
                className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                aria-label="Close SMS dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs text-slate-600">
                  <span className="font-semibold text-slate-800">Compact SMS Code</span>
                  <span className="font-mono tabular-nums">
                    {smsDraft.bitPackedSms.length} chars
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 font-mono text-sm font-semibold text-slate-900">
                  <span className="truncate">{smsDraft.bitPackedSms}</span>
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        void navigator.clipboard?.writeText?.(smsDraft.bitPackedSms)?.catch(() => {
                          // Ignore clipboard permission denial inside sandboxed iframes
                        });
                      } catch {
                        // Ignore synchronous clipboard errors
                      }
                      setCopiedPayload(true);
                      if (copyTimerRef.current !== null) {
                        window.clearTimeout(copyTimerRef.current);
                      }
                      copyTimerRef.current = window.setTimeout(() => {
                        copyTimerRef.current = null;
                        if (isMountedRef.current) {
                          setCopiedPayload(false);
                        }
                      }, 2000);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-sans text-xs font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>{copiedPayload ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-700">
                <p className="font-semibold text-slate-800">Readable Summary Format</p>
                <p className="mt-1 font-mono text-slate-900 break-all">{smsDraft.compactTag}</p>
              </div>

              {smsGatewayFeedback && (
                <div
                  className={`rounded-xl border p-3.5 text-xs leading-relaxed ${
                    smsGatewayFeedback.sent
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                      : 'border-amber-200 bg-amber-50 text-amber-950'
                  }`}
                >
                  {smsGatewayFeedback.message}
                </div>
              )}

              <div className="space-y-2.5">
                <button
                  type="button"
                  disabled={sendingGatewaySms}
                  onClick={handleConfirmSendEmergencySms}
                  className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60 cursor-pointer"
                >
                  <Send className="h-4 w-4" />
                  <span>
                    {sendingGatewaySms ? 'Sending Urgent SMS...' : 'Send via Hospital SMS Service'}
                  </span>
                </button>

                <a
                  href={smsGatewayFeedback?.nativeUri || smsDraft.nativeUri}
                  onClick={() => {
                    ensureSmsDraftRecordSaved();
                  }}
                  className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50"
                >
                  <ExternalLink className="h-4 w-4 text-teal-700" />
                  <span>Open Phone Text Message App</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
