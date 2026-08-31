'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Upload } from 'tus-js-client';
import { localDelete, localGet, localPut, localStorageAvailable } from '@/lib/local-db';
import type { ServiceCategory, ServiceItem } from '@/lib/service-catalog';
import { STUDIO_DOCUMENTS, type StudioRole, type StudioScenario, type StudioState } from '@/lib/guided-filing';

type Screen = 'login' | 'reviewer' | 'filings' | 'studio' | 'newFiling' | 'services' | 'company' | 'documents' | 'payments' | 'guidance' | 'about' | 'prepare' | 'jaanch' | 'mohar' | 'sign' | 'rasid' | 'status' | 'recovery' | 'lineage' | 'evidence' | 'limitations' | 'demoControls';
type Theme = 'light' | 'dark';
type FormShape = {
  registeredOffice: string;
  financialYear: string;
  agmDate: string;
  boardMeetings: string;
  revenue: string;
  expenses: string;
  netProfit: string;
  directorName: string;
};
type Attachment = { slot: string; version: number; filename: string; bytes: number; mime: string; sha256: string; verifiedAt: string };
type AttachmentVersion = Attachment & { current: boolean };
type PackageRecord = { packageId: string; version: number; hash: string; sealedAt: string; canonicalPayload: string };
type SignatureRecord = { signatureId: string; packageId: string; provider: string; signedHash: string; signatureValue: string; signedAt: string };
type ReceiptRecord = { receiptId: string; srn: string; custodyId: string; packageId: string; packageHash: string; receivedAt: string; replayed?: boolean };
type PaymentRecord = { paymentId: string; state: string; amountPaise: number; reconciliationReference: string; updatedAt: string };
type EventRecord = { seq: number; eventType: string; actor: string; detail: string; occurredAt: string };
type UploadSession = { uploadId: string; slot: string; filename: string; expectedBytes: number; confirmedOffset: number; clientSha256: string; fingerprint: string; state: string; updatedAt: string; expiresAt: string; uploadUrl: string };
type MasterState = { pinnedVersion: number; pinnedOffice: string; currentVersion: number; currentOffice: string; source: string; reviewState: string; detectedAt: string | null; reviewedAt: string | null };
type CorrectionState = { requestId: string; sourcePackageId: string; documentSlot: string; summary: string; state: string; childPackageId: string | null; createdAt: string; resolvedAt: string | null };
type LineageRecord = { parent: PackageRecord; child: PackageRecord; reason: string; changedPaths: string[]; createdAt: string };
type FeatureFlags = { resumableUploads: boolean; masterDrift: boolean; correctionLineage: boolean; recoveryCase: boolean };
type ServiceDraft = { filingId: string; formCode: string; title: string; financialYear: string; applicantName: string; note: string; status: string; createdAt: string; updatedAt: string };
type UploadProgress = { filename: string; offset: number; total: number; state: 'HASHING' | 'UPLOADING' | 'PAUSED' | 'ERROR' };
type CheckRecord = {
  code: string; stage: string; fieldPath: string | null; documentSlot: string | null;
  blocking: boolean; retryable: boolean; status: string; summary: string; detail: string;
  ruleVersion: string; expected?: string; actual?: string;
};
type AppState = {
  runId: string; caseId: string;
  draft: { version: number; form: FormShape; savedAt: string } | null;
  attachments: Attachment[]; attachmentVersions: AttachmentVersion[]; package: PackageRecord | null; signature: SignatureRecord | null;
  packageCurrent: boolean; signatureValid: boolean;
  receipt: ReceiptRecord | null; payment: PaymentRecord | null;
  processingJob: { jobId: string; state: string; attemptCount: number } | null;
  processorPaused: boolean; events: EventRecord[];
  uploadPauseArmed: boolean; uploadSessions: UploadSession[]; master: MasterState | null;
  correction: CorrectionState | null; lineage: LineageRecord[]; features: FeatureFlags; serviceDrafts: ServiceDraft[];
  studio: StudioState;
};
type DarjError = {
  code: string; stage: string; summary: string; detail: string; retryable: boolean; correlationId: string;
  serverDraft?: { version: number; form: FormShape; savedAt: string };
  changedPaths?: string[];
};
type LocalDraft = { runId?: string; version: number; form: FormShape; savedAt: string; focusedField?: string };
type DraftConflict = { local: FormShape; server: { version: number; form: FormShape; savedAt: string }; changedPaths: string[] };
type CatalogService = ServiceItem & { categoryId: string; categoryName: string };

const EMPTY_SERVICE_CATEGORIES: ServiceCategory[] = [];
const EMPTY_CATALOGUE_SERVICES: CatalogService[] = [];

const API = '/api/darj';
const SESSION_HINT = 'darj-session-active';
const THEME_CHOICE = 'darj-theme-choice';
const PREPARE_SECTION_IDS = ['company', 'financials', 'governance', 'attachments'] as const;

function setSessionHint(active: boolean) {
  try {
    if (active) window.localStorage.setItem(SESSION_HINT, 'true');
    else window.localStorage.removeItem(SESSION_HINT);
  } catch {
    // The server session remains authoritative when browser storage is unavailable.
  }
}

export default function DarjApp() {
  const [screen, setScreen] = useState<Screen>('login');
  const [state, setState] = useState<AppState | null>(null);
  const [form, setForm] = useState<FormShape | null>(null);
  const [checks, setChecks] = useState<CheckRecord[]>([]);
  const [saveState, setSaveState] = useState('Saved locally · Synced');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<DarjError | null>(null);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [online, setOnline] = useState(true);
  const [storageReady, setStorageReady] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [hasLocalRecovery, setHasLocalRecovery] = useState(false);
  const [restoredLocalNeedsSync, setRestoredLocalNeedsSync] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [restoringWorkspace, setRestoringWorkspace] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, UploadProgress>>({});
  const [serviceQuery, setServiceQuery] = useState('');
  const [serviceCategory, setServiceCategory] = useState('all');
  const [selectedServiceKey, setSelectedServiceKey] = useState('annual:AOC-4');
  const [theme, setTheme] = useState<Theme>('light');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeUploads = useRef(new Map<string, Upload>());
  const reviewerAutoStarted = useRef(false);

  useEffect(() => {
    queueMicrotask(() => {
      setScreen(screenFromPath(window.location.pathname));
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_CHOICE);
      if (saved === 'dark') queueMicrotask(() => setTheme('dark'));
      // Remove the legacy value because it may have been written automatically
      // from the operating-system colour preference in an earlier release.
      window.localStorage.removeItem('darj-theme');
    } catch {
      // Light remains the default when browser preference storage is unavailable.
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === 'light' ? 'dark' : 'light';
      try { window.localStorage.setItem(THEME_CHOICE, next); }
      catch { /* The current page still changes theme when storage is unavailable. */ }
      return next;
    });
  };

  const refresh = useCallback(async () => {
    let response: Response;
    try { response = await fetch(API, { cache: 'no-store' }); }
    catch { return null; }
    if (!response.ok) {
      if (response.status === 401) {
        setSessionHint(false);
        const local = await safeReadLocalDraft('DARJ-DEMO-AOC4-01');
        setHasLocalRecovery(Boolean(local));
        setSessionExpired(Boolean(local));
        setScreen('login');
      }
      return null;
    }
    const next = await response.json() as AppState;
    setState(next);
    if (next.draft) {
      const local = await safeReadLocalDraft(next.caseId);
      const chosen = local && local.runId === next.runId && local.version >= next.draft.version ? local.form : next.draft.form;
      setForm(chosen);
      setRestoredLocalNeedsSync(Boolean(local && local.runId === next.runId && JSON.stringify(local.form) !== JSON.stringify(next.draft.form)));
    }
    return next;
  }, []);

  useEffect(() => {
    void (async () => {
      const initialScreen = screenFromPath(window.location.pathname);
      const publicScreen = initialScreen === 'reviewer' || initialScreen === 'evidence' || initialScreen === 'limitations' || initialScreen === 'services' || initialScreen === 'login';
      if (!publicScreen) setRestoringWorkspace(true);
      const ready = await localStorageAvailable();
      setStorageReady(ready);
      const local = ready ? await safeReadLocalDraft('DARJ-DEMO-AOC4-01') : null;
      setHasLocalRecovery(Boolean(local));
      // Public pages never restore a private workspace or call the session API.
      // A stale browser hint must not delay the homepage or cause a failed GET.
      if (publicScreen) return;
      try {
        const restored = await refresh();
        if (restored) setScreen(screenFromPath(window.location.pathname));
      } finally {
        setRestoringWorkspace(false);
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (!hydrated || state || busy === 'login' || reviewerAutoStarted.current) return;
    const reviewer = readReviewerScenario();
    if (!reviewer || screen === 'reviewer' || screen === 'evidence' || screen === 'limitations') return;
    reviewerAutoStarted.current = true;
    void login();
    // Login is intentionally triggered once when a reviewer opens a scenario deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, screen, state, busy]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  useEffect(() => {
    if (!error) return;
    requestAnimationFrame(() => document.getElementById('darj-error')?.focus());
  }, [error]);

  useEffect(() => {
    if (!online || !state?.draft || !form || !saveState.includes('Offline')) return;
    const timer = setTimeout(() => { void saveDraft(form, state.draft?.version ?? 17); }, 250);
    return () => clearTimeout(timer);
    // saveDraft is intentionally triggered only by the offline-to-online state transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, online, saveState, state?.draft?.version]);

  useEffect(() => {
    const onPop = () => {
      setScreen(screenFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (next: Screen) => {
    setError(null);
    setNotice('');
    setScreen(next);
    window.history.pushState({}, '', pathForScreen(next, state?.caseId));
    // Finish route positioning immediately so a subsequent in-page anchor is not
    // pulled back to the top by an earlier smooth-scroll animation.
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  async function post(action: string, data: Record<string, unknown> = {}) {
    let response: Response;
    try {
      response = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DARJ-CSRF': readBrowserCookie('darj_csrf') ?? '' },
        body: JSON.stringify({ action, ...data }),
      });
    } catch {
      const offlineError: DarjError = { code: 'DARJ_NETWORK_UNAVAILABLE', stage: 'NETWORK', summary: 'DARJ is offline.', detail: 'Local draft saving remains available. Sealing, signing, submission, payment, and processing controls are paused.', retryable: true, correlationId: 'DARJ-CORR-LOCAL' };
      setError(offlineError);
      throw Object.assign(new Error(offlineError.summary), { darj: offlineError, status: 0 });
    }
    const payload = await response.json() as Record<string, unknown> & { error?: DarjError };
    if (!response.ok) {
      if (payload.error) setError(payload.error);
      if (response.status === 401) {
        setSessionHint(false);
        setSessionExpired(true);
        setHasLocalRecovery(Boolean(await safeReadLocalDraft(state?.caseId ?? 'DARJ-DEMO-AOC4-01')));
        navigate('login');
      }
      throw Object.assign(new Error(payload.error?.summary ?? 'DARJ request failed'), { darj: payload.error, status: response.status });
    }
    setError(null);
    return payload;
  }

  async function login(destination: Screen = 'filings') {
    setBusy('login');
    setRestoringWorkspace(true);
    try {
      const recovery = await safeReadLocalDraft('DARJ-DEMO-AOC4-01');
      const next = await post('login', { email: 'meet@darj.demo', password: 'darj2026' }) as unknown as AppState;
      setSessionHint(true);
      setState(next);
      if (next.draft) {
        if (recovery && sessionExpired && isValidImportedForm(recovery.form)) {
          setForm(recovery.form);
          const synced = await post('saveDraft', { form: recovery.form, baseVersion: next.draft.version }) as { version?: number; savedAt?: string };
          const version = Number(synced.version ?? next.draft.version + 1);
          const savedAt = String(synced.savedAt ?? new Date().toISOString());
          const recoveredState = { ...next, draft: { version, form: recovery.form, savedAt } };
          setState(recoveredState);
          try {
            await writeLocalDraft(next.caseId, next.runId, version, recovery.form, recovery.focusedField);
          } catch {
            setStorageReady(false);
          }
          setNotice('Session restored · local work resumed on the same filing');
          setTimeout(() => document.getElementById(recovery.focusedField ?? '')?.focus(), 120);
        } else {
          setForm(next.draft.form);
          try {
            await writeLocalDraft(next.caseId, next.runId, next.draft.version, next.draft.form);
          } catch {
            setStorageReady(false);
          }
        }
      }
      setSessionExpired(false);
      const reviewer = readReviewerScenario();
      if (reviewer) {
        if (reviewer === 'documents') {
          const prepared = await post('openStudio', { scenario: 'clean', serviceNeed: 'File annual financial statements from company documents' }) as { studio: StudioState };
          setState({ ...next, studio: prepared.studio });
        }
        const destination = reviewerDestination(reviewer);
        setScreen(destination);
        setNotice(reviewerNotice(reviewer));
        window.history.replaceState({}, '', reviewerPath(reviewer, next.caseId));
        window.scrollTo({ top: 0 });
      } else {
        navigate(recovery && sessionExpired ? 'prepare' : destination);
      }
    } finally { setBusy(''); setRestoringWorkspace(false); }
  }

  async function startService(formCode: string, financialYear: string, applicantName: string, note: string) {
    setBusy('start-service');
    try {
      const result = await post('startService', { formCode, financialYear, applicantName, note }) as { filing?: ServiceDraft };
      await refresh();
      navigate('filings');
      setNotice(result.filing?.formCode === 'AOC-4' ? 'AOC-4 filing created. Continue in the filing room when you are ready.' : `${result.filing?.formCode ?? formCode} intake saved. Your details are durable and ready for the next guided step.`);
    } finally { setBusy(''); }
  }

  async function openStudio(scenario: StudioScenario = 'clean', serviceNeed = '') {
    setBusy('studio-open');
    try {
      const result = await post('openStudio', { scenario, serviceNeed }) as { studio: StudioState };
      setState((current) => current ? { ...current, studio: result.studio } : current);
      navigate('studio');
      setNotice(scenario === 'conflict' ? 'Conflict package opened. The AGM date must be resolved before sealing.' : 'Prepared AOC-4 package opened with source-linked evidence.');
    } finally { setBusy(''); }
  }

  async function updateStudio(operation: string, data: Record<string, unknown> = {}) {
    setBusy(`studio-${operation}`);
    try {
      const result = await post('updateStudio', { operation, ...data }) as { studio: StudioState };
      setState((current) => current ? { ...current, studio: result.studio } : current);
      if (operation === 'review') setNotice('Professional review decision saved to this evidence field.');
      if (operation === 'completeReview') setNotice('Professional review completed. The evidence set is ready to become a durable draft.');
    } catch {
      // post() has already surfaced the structured error in the focused message.
    } finally { setBusy(''); }
  }

  async function applyStudioDraft() {
    if (!state?.studio || !state.draft || !form) return;
    const extracted = Object.fromEntries(state.studio.evidence.filter((field) => field.formField && field.value).map((field) => [field.formField, field.value]));
    const next = { ...form, ...extracted } as FormShape;
    setBusy('studio-apply');
    try {
      await saveDraft(next, state.draft.version);
      setForm(next);
      navigate('prepare');
      setNotice('Reviewed evidence applied to a new durable draft version. Run Jaanch before sealing.');
    } finally { setBusy(''); }
  }

  function changeField(field: keyof FormShape, value: string) {
    if (!form || !state?.draft || !storageReady) return;
    const next = { ...form, [field]: value };
    setForm(next);
    setSaveState('Saving locally…');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveDraft(next, state.draft?.version ?? 17);
    }, 350);
  }

  async function saveDraft(next: FormShape, baseVersion: number) {
    if (!state) return;
    try {
      await writeLocalDraft(state.caseId, state.runId, baseVersion, next, document.activeElement?.id);
    } catch {
      setStorageReady(false);
      setSaveState('Local storage unavailable · Edits blocked');
      setError({ code: 'DARJ_LOCAL_STORAGE_UNAVAILABLE', stage: 'DRAFT', summary: 'DARJ cannot confirm a recoverable local save.', detail: 'Further edits are blocked. Export the current draft before changing browser storage settings.', retryable: false, correlationId: 'DARJ-CORR-LOCAL' });
      return;
    }
    try {
      setSaveState('Saved locally · Syncing…');
      if (!navigator.onLine) { setSaveState('Saved locally · Offline'); return; }
      const result = await post('saveDraft', { form: next, baseVersion }) as { version?: number; savedAt?: string };
      const version = Number(result.version ?? baseVersion);
      await writeLocalDraft(state.caseId, state.runId, version, next, document.activeElement?.id);
      setState((current) => current ? { ...current, draft: { version, form: next, savedAt: String(result.savedAt ?? new Date().toISOString()) }, packageCurrent: false, signatureValid: false } : current);
      setConflict(null);
      setSaveState('Saved locally · Synced');
    } catch (caught) {
      const typed = caught as { darj?: DarjError };
      if (typed.darj?.code === 'DARJ_DRAFT_VERSION_CONFLICT' && typed.darj.serverDraft) {
        setConflict({ local: next, server: typed.darj.serverDraft, changedPaths: typed.darj.changedPaths ?? [] });
        setSaveState('Conflict · Review required');
      } else if (typed.darj?.code === 'DARJ_NETWORK_UNAVAILABLE') setSaveState('Saved locally · Offline');
      else if (!storageReady) setSaveState('Local storage unavailable · Edits blocked');
    }
  }

  async function resolveConflict(choice: 'local' | 'server') {
    if (!conflict || !state) return;
    setBusy('conflict');
    try {
      if (choice === 'server') {
        setForm(conflict.server.form);
        setState((current) => current ? { ...current, draft: conflict.server } : current);
        await writeLocalDraft(state.caseId, state.runId, conflict.server.version, conflict.server.form);
      } else {
        const result = await post('saveDraft', { form: conflict.local, baseVersion: conflict.server.version }) as { version?: number; savedAt?: string };
        const version = Number(result.version ?? conflict.server.version + 1);
        const savedAt = String(result.savedAt ?? new Date().toISOString());
        setForm(conflict.local);
        setState((current) => current ? { ...current, draft: { version, form: conflict.local, savedAt }, packageCurrent: false, signatureValid: false } : current);
        await writeLocalDraft(state.caseId, state.runId, version, conflict.local);
      }
      setConflict(null); setError(null); setSaveState('Saved locally · Synced');
    } finally { setBusy(''); }
  }

  async function runChecks() {
    if (!online) { setNotice('Jaanch needs the server. Your local draft remains saved.'); return; }
    setBusy('jaanch');
    try {
      const result = await post('jaanch') as { issues?: CheckRecord[] };
      setChecks(result.issues ?? []);
      navigate('jaanch');
      setTimeout(() => document.querySelector<HTMLElement>('.check-group')?.focus(), 80);
    } finally { setBusy(''); }
  }

  async function createMohar() {
    if (!online) return;
    setBusy('seal');
    try {
      const packageRecord = await post('seal') as unknown as PackageRecord;
      setState((current) => current ? { ...current, package: packageRecord, packageCurrent: true, signature: null, signatureValid: false } : current);
      navigate('mohar');
    } finally { setBusy(''); }
  }

  async function sign() {
    if (!online) return;
    setBusy('sign');
    try {
      const signature = await post('sign') as unknown as SignatureRecord;
      setState((current) => current ? { ...current, signature, signatureValid: true } : current);
      navigate('sign');
    } finally { setBusy(''); }
  }

  async function submit() {
    if (!online) return;
    setBusy('submit');
    setNotice('Submitting with a persisted retry key…');
    const idempotencyKey = await getOrCreateIdempotencyKey(`${state?.caseId ?? 'case'}:${state?.package?.packageId ?? 'package'}`);
    try {
      let receipt: ReceiptRecord;
      try {
        receipt = await post('submit', { idempotencyKey }) as unknown as ReceiptRecord;
      } catch (first) {
        const typed = first as { darj?: DarjError };
        if (typed.darj?.code !== 'DARJ_SUBMISSION_RETRY_SAFE') throw first;
        setNotice('Response lost after commit · Retrying safely with the same key…');
        receipt = await post('submit', { idempotencyKey }) as unknown as ReceiptRecord;
        receipt.replayed = true;
      }
      setState((current) => current ? { ...current, receipt } : current);
      navigate('rasid');
      await refresh();
      setNotice(receipt.replayed ? 'Response-loss replay verified · same package · same Rasid · no duplicate' : 'Package received into DARJ custody');
    } finally { setBusy(''); }
  }

  async function approvePayment() {
    if (!online) return;
    setBusy('payment');
    setNotice('Reconciling sample payment…');
    const idempotencyKey = await getOrCreateIdempotencyKey(`payment:${state?.caseId ?? 'case'}:${state?.payment?.paymentId ?? 'payment'}`);
    try {
      try {
        await post('approvePayment', { idempotencyKey });
      } catch (first) {
        const typed = first as { darj?: DarjError };
        if (typed.darj?.code !== 'DARJ_PAYMENT_RECONCILING') throw first;
        setNotice('Browser callback lost · Reconciling from the durable server record…');
        await wait(650);
      }
      const next = await refresh();
      if (next?.payment?.state === 'PAID') {
        setError(null);
        setNotice('PAID · reconciled from server · no second payment requested');
      }
    } finally { setBusy(''); }
  }

  async function pauseProcessor() {
    setBusy('processor');
    try {
      await post('setProcessor', { processorPaused: true });
      await refresh();
      setNotice('PROCESSING DELAYED · package and payment remain recorded');
    } finally { setBusy(''); }
  }

  async function resumeProcessor() {
    setBusy('processor');
    try {
      await post('setProcessor', { processorPaused: false });
      setNotice('Processor resumed from the durable queue…');
      await wait(450);
      await post('process');
      await refresh();
      setNotice('ACCEPTED. Processor outcome recorded.');
    } finally { setBusy(''); }
  }

  async function resetDemo() {
    setBusy('reset');
    try {
      const next = await post('reset') as unknown as AppState;
      setState(next);
      setForm(next.draft?.form ?? null);
      setChecks([]);
      await clearLocalDraft(next.caseId);
      if (next.draft) await writeLocalDraft(next.caseId, next.runId, next.draft.version, next.draft.form);
      navigate('filings');
    } finally { setBusy(''); }
  }

  async function signOut() {
    setBusy('logout');
    try {
      for (const upload of activeUploads.current.values()) await upload.abort();
      activeUploads.current.clear();
      await post('logout');
      setSessionHint(false);
      setState(null); setForm(null); setChecks([]); setConflict(null); setSessionExpired(false);
      setScreen('login');
      window.history.pushState({}, '', '/login');
      window.scrollTo({ top: 0 });
    } finally { setBusy(''); }
  }

  async function reviewMaster(choice: 'accept' | 'keep') {
    setBusy('master');
    try {
      const next = await post(choice === 'accept' ? 'acceptMaster' : 'keepPinnedMaster') as unknown as AppState;
      setState(next);
      if (next.draft) {
        setForm(next.draft.form);
        await writeLocalDraft(next.caseId, next.runId, next.draft.version, next.draft.form);
      }
      setChecks([]);
      setNotice(choice === 'accept' ? `Reviewed and pinned master snapshot ${next.master?.pinnedVersion}. Run Jaanch again.` : 'Pinned address kept. This filing is stopped and cannot be sealed.');
    } finally { setBusy(''); }
  }

  async function runControl(flag: string) {
    setBusy(`control:${flag}`);
    try {
      await post('setRecovery', { flag });
      const next = await refresh();
      if (next?.draft) setForm(next.draft.form);
      const messages: Record<string, string> = {
        upload_pause: 'Resumable upload will pause after the next server-confirmed chunk.',
        master_drift: 'Company master changed. Sealing is blocked until Meet reviews the old and current addresses.',
        correction_request: 'Board report resubmission is now required. The original package remains unchanged.',
      };
      setNotice(messages[flag] ?? `${flag.replaceAll('_', ' ')} armed for this review run`);
    } finally { setBusy(''); }
  }

  async function createCorrection() {
    setBusy('correction');
    try {
      const next = await post('createCorrection') as unknown as AppState;
      setState(next);
      if (next.draft) {
        setForm(next.draft.form);
        await writeLocalDraft(next.caseId, next.runId, next.draft.version, next.draft.form);
      }
      setChecks([]);
      navigate('lineage');
      setNotice('Corrected v24 created from v23. The original package remains immutable and linked.');
    } finally { setBusy(''); }
  }

  async function uploadAttachment(slot: string, file: File) {
    if (!online || !state) return;
    setBusy(`upload:${slot}`);
    setNotice('Hashing the selected sample PDF before upload…');
    try {
      if (!/^DARJ-[A-Za-z0-9._ -]+\.pdf$/u.test(file.name) || file.type !== 'application/pdf') throw new Error('Only sample PDF files with names starting DARJ are accepted.');
      if (file.size > 12 * 1024 * 1024) throw new Error('This file exceeds DARJ’s 12 MB review limit.');
      setUploadProgress((current) => ({ ...current, [slot]: { filename: file.name, offset: 0, total: file.size, state: 'HASHING' } }));
      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const clientSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const existingAttachment = state.attachments.find((item) => item.slot === slot && item.sha256 === clientSha256 && item.bytes === file.size);
      if (existingAttachment) {
        setUploadProgress((current) => { const next = { ...current }; delete next[slot]; return next; });
        setNotice(`${labelSlot(slot)} already has these server-verified bytes. No duplicate was created.`);
        return;
      }
      if (!state.features.resumableUploads) {
        const body = new FormData();
        body.set('slot', slot); body.set('file', file); body.set('clientSha256', clientSha256);
        const response = await fetch(API, { method: 'POST', headers: { 'X-DARJ-CSRF': readBrowserCookie('darj_csrf') ?? '' }, body });
        const payload = await response.json() as Attachment & { error?: DarjError };
        if (!response.ok) throw new Error(payload.error?.summary ?? 'Attachment upload failed.');
        const next = await refresh();
        if (next) setState(next);
        setUploadProgress((current) => { const nextProgress = { ...current }; delete nextProgress[slot]; return nextProgress; });
        setNotice(`${labelSlot(slot)} · server MIME, bytes and SHA-256 verified`);
        return;
      }
      const fingerprint = `darj:${state.runId}:${state.caseId}:${slot}:${file.name}:${file.size}:${clientSha256}`;
      const serverSession = state.uploadSessions.find((session) => session.slot === slot && session.fingerprint === fingerprint && session.state === 'UPLOADING');
      const initialOffset = serverSession?.confirmedOffset ?? 0;
      setUploadProgress((current) => ({ ...current, [slot]: { filename: file.name, offset: initialOffset, total: file.size, state: 'UPLOADING' } }));
      const { Upload: TusUpload } = await import('tus-js-client');
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => { if (!settled) { settled = true; callback(); } };
        const upload = new TusUpload(file, {
          endpoint: '/api/darj/uploads',
          uploadUrl: serverSession?.uploadUrl ?? null,
          chunkSize: 6 * 1024 * 1024,
          retryDelays: [0, 750, 2_000],
          headers: { 'X-DARJ-CSRF': readBrowserCookie('darj_csrf') ?? '' },
          metadata: { slot, filename: file.name, filetype: file.type, sha256: clientSha256, fingerprint },
          fingerprint: async () => fingerprint,
          urlStorage: new IndexedDbTusUrlStorage(),
          storeFingerprintForResuming: true,
          removeFingerprintOnSuccess: true,
          onUploadUrlAvailable: () => {
            void localPut(`upload:${state.runId}:${slot}`, { fingerprint, uploadUrl: upload.url, filename: file.name, expectedBytes: file.size, confirmedOffset: initialOffset, clientSha256 });
          },
          onChunkComplete: (_chunkSize, bytesAccepted, bytesTotal) => {
            setUploadProgress((current) => ({ ...current, [slot]: { filename: file.name, offset: bytesAccepted, total: bytesTotal, state: 'UPLOADING' } }));
            void localPut(`upload:${state.runId}:${slot}`, { fingerprint, uploadUrl: upload.url, filename: file.name, expectedBytes: bytesTotal, confirmedOffset: bytesAccepted, clientSha256 });
            if (state.uploadPauseArmed && bytesAccepted < bytesTotal) {
              void upload.abort().then(async () => {
                activeUploads.current.delete(slot);
                setUploadProgress((current) => ({ ...current, [slot]: { filename: file.name, offset: bytesAccepted, total: bytesTotal, state: 'PAUSED' } }));
                await post('consumeUploadPause');
                await refresh();
                setNotice(`Upload paused · ${formatBytes(bytesAccepted)} of ${formatBytes(bytesTotal)} safely stored`);
                finish(resolve);
              });
            }
          },
          onSuccess: () => {
            void (async () => {
              activeUploads.current.delete(slot);
              await localDelete(`upload:${state.runId}:${slot}`);
              const next = await refresh();
              if (next) setState(next);
              setUploadProgress((current) => { const nextProgress = { ...current }; delete nextProgress[slot]; return nextProgress; });
              setNotice(`${labelSlot(slot)} · TUS complete · durable R2 object, MIME, bytes and SHA-256 verified`);
              setError(null);
              finish(resolve);
            })();
          },
          onError: (caught) => {
            activeUploads.current.delete(slot);
            setUploadProgress((current) => ({ ...current, [slot]: { filename: file.name, offset: current[slot]?.offset ?? initialOffset, total: file.size, state: 'ERROR' } }));
            setError({ code: 'DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', stage: 'UPLOAD', summary: 'The resumable upload is paused.', detail: 'Select the same file to resume from the server-confirmed offset. Completed chunks will not be sent again.', retryable: true, correlationId: 'DARJ-CORR-UPLOAD' });
            finish(() => reject(caught));
          },
        });
        activeUploads.current.set(slot, upload);
        upload.start();
      });
    } catch (caught) {
      if (!(caught instanceof Error && caught.message.includes('resumable upload is paused'))) {
        const summary = caught instanceof Error ? caught.message : 'Attachment upload failed.';
        setError((current) => current?.stage === 'UPLOAD' ? current : { code: 'DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', stage: 'UPLOAD', summary, detail: 'No completed attachment was changed.', retryable: true, correlationId: 'DARJ-CORR-UPLOAD' });
      }
    } finally { setBusy(''); }
  }

  async function pauseUpload(slot: string) {
    const upload = activeUploads.current.get(slot);
    if (!upload) return;
    await upload.abort();
    activeUploads.current.delete(slot);
    setUploadProgress((current) => current[slot] ? { ...current, [slot]: { ...current[slot], state: 'PAUSED' } } : current);
    const progress = uploadProgress[slot];
    setNotice(progress ? `Upload paused · ${formatBytes(progress.offset)} of ${formatBytes(progress.total)} safely stored` : 'Upload paused at the last server-confirmed offset.');
  }

  function exportDraft() {
    if (!form || !state) return;
    const payload = JSON.stringify({ schema: 'DARJ-DRAFT-1', caseId: state.caseId, exportedAt: new Date().toISOString(), form }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'DARJ-sample-draft.json'; link.click();
    URL.revokeObjectURL(url);
  }

  async function importDraft(file: File) {
    if (!state) return;
    try {
      const parsed = JSON.parse(await file.text()) as { schema?: unknown; caseId?: unknown; form?: unknown };
      if (parsed.schema !== 'DARJ-DRAFT-1' || parsed.caseId !== state.caseId || !isValidImportedForm(parsed.form)) throw new Error('The selected JSON is not a valid DARJ draft export.');
      if (!window.confirm('Replace the working fields with this validated draft? A new immutable draft version will be created.')) return;
      setForm(parsed.form);
      await saveDraft(parsed.form, state.draft?.version ?? 17);
      setNotice('Validated draft imported as a new version');
    } catch (caught) {
      const summary = caught instanceof Error ? caught.message : 'The draft import could not be validated.';
      setError({ code: 'DARJ_DRAFT_IMPORT_INVALID', stage: 'DRAFT', summary, detail: 'No field was overwritten.', retryable: false, correlationId: 'DARJ-CORR-LOCAL' });
    }
  }

  function rememberFocusedField(fieldId: string) {
    if (!state?.draft || !form) return;
    void writeLocalDraft(state.caseId, state.runId, state.draft.version, form, fieldId).catch(() => setStorageReady(false));
  }

  const streamRunId = state?.runId;
  const streamAfter = state?.events.at(-1)?.seq ?? 0;

  useEffect(() => {
    if (screen !== 'status' || !streamRunId) return;
    let polling: ReturnType<typeof setInterval> | null = null;
    const stream = new EventSource(`/api/darj/events/stream?after=${streamAfter}`);
    stream.onmessage = () => { void refresh(); };
    stream.onerror = () => {
      stream.close();
      if (!polling) polling = setInterval(() => { void refresh(); }, 5_000);
    };
    return () => { stream.close(); if (polling) clearInterval(polling); };
  }, [refresh, screen, streamAfter, streamRunId]);

  useEffect(() => {
    if (!restoredLocalNeedsSync || !online || !state?.draft || !form) return;
    const restoredForm = form;
    const restoredVersion = state.draft.version;
    queueMicrotask(() => {
      setRestoredLocalNeedsSync(false);
      void saveDraft(restoredForm, restoredVersion);
    });
    // saveDraft deliberately runs once for an IndexedDB snapshot restored ahead of the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredLocalNeedsSync, online, state?.draft?.version]);

  const blocking = checks.filter((check) => check.blocking);
  const passed = checks.filter((check) => !check.blocking);
  const accepted = state?.processingJob?.state === 'ACCEPTED';

  if (!hydrated || (restoringWorkspace && !state)) return <WorkspaceRestoringScreen theme={theme} />;
  if (screen === 'reviewer') return <ReviewerScreen theme={theme} onTheme={toggleTheme} onNavigate={navigate} />;
  if (screen === 'evidence' || screen === 'limitations') return <PublicInformationScreen screen={screen} theme={theme} onTheme={toggleTheme} onNavigate={navigate} />;
  if (screen === 'services' && (!state || !form)) return <PublicServicesScreen theme={theme} onTheme={toggleTheme} query={serviceQuery} category={serviceCategory} selectedKey={selectedServiceKey} onQuery={setServiceQuery} onCategory={setServiceCategory} onSelect={setSelectedServiceKey} onHome={() => navigate('login')} onReviewer={() => navigate('reviewer')} onLimitations={() => navigate('limitations')} onEnter={() => void login()} />;
  if (screen === 'login' || !state || !form) return <LoginScreen theme={theme} onTheme={toggleTheme} hydrated={hydrated} busy={busy === 'login'} onEnter={() => void login()} onStudio={() => void login('studio')} onBrowse={(query = '') => { setServiceQuery(query); navigate('services'); }} onReviewer={() => navigate('reviewer')} onEvidence={() => navigate('evidence')} onLimitations={() => navigate('limitations')} error={error} sessionExpired={sessionExpired} hasLocalRecovery={hasLocalRecovery} storageReady={storageReady} />;

  return (
    <div className="app-shell">
      <Disclosure onOpen={() => navigate('limitations')} />
      <AppHeader screen={screen} state={state} theme={theme} onTheme={toggleTheme} serviceQuery={serviceQuery} onServiceQuery={setServiceQuery} onNavigate={navigate} onSignOut={() => void signOut()} signingOut={busy === 'logout'} />
      <div className="platform-frame">
        <PlatformNav screen={screen} onNavigate={navigate} />
        <main id="main-content" className="app-main">
          {notice && <div className="notice" role="status" aria-live="polite"><span className="status-mark progress" />{notice}</div>}
          {error && <ErrorPanel error={error} toast onDismiss={() => setError(null)} />}

          {screen === 'filings' && <FilingsScreen state={state} onPrepare={() => navigate(resumeScreen(state))} onStudio={() => navigate('studio')} onRecovery={() => navigate('recovery')} onNavigate={navigate} />}
          {screen === 'studio' && <GuidedFilingStudio state={state} busy={busy} onOpen={(scenario, need) => void openStudio(scenario, need)} onUpdate={(operation, data) => void updateStudio(operation, data)} onApply={() => void applyStudioDraft()} onPrepare={() => navigate('prepare')} onBrowse={(query) => { setServiceQuery(query); navigate('services'); }} />}
          {screen === 'newFiling' && <NewFilingScreen busy={busy === 'start-service'} onStart={(formCode, financialYear, applicantName, note) => void startService(formCode, financialYear, applicantName, note)} />}
          {screen === 'services' && <ServiceDirectoryScreen query={serviceQuery} category={serviceCategory} selectedKey={selectedServiceKey} onQuery={setServiceQuery} onCategory={setServiceCategory} onSelect={setSelectedServiceKey} onOpenWorking={() => navigate('studio')} onStart={() => navigate('newFiling')} />}
          {screen === 'company' && <CompanyScreen state={state} onPrepare={() => navigate(resumeScreen(state))} onDocuments={() => navigate('documents')} />}
          {screen === 'documents' && <DocumentsScreen state={state} onPrepare={() => navigate('prepare')} />}
          {screen === 'payments' && <PaymentsScreen state={state} onReceipt={() => navigate(state.receipt ? 'rasid' : resumeScreen(state))} />}
          {screen === 'guidance' && <GuidanceScreen onNavigate={navigate} />}
          {screen === 'about' && <AboutScreen onNavigate={navigate} />}
          {screen === 'prepare' && (
            <PrepareScreen state={state} form={form} saveState={saveState} busy={busy} online={online} storageReady={storageReady} conflict={conflict}
              onChange={changeField} onJaanch={() => void runChecks()} onResolveConflict={(choice) => void resolveConflict(choice)}
              uploadProgress={uploadProgress} onUpload={(slot, file) => void uploadAttachment(slot, file)} onPauseUpload={(slot) => void pauseUpload(slot)}
              onMasterReview={(choice) => void reviewMaster(choice)} onExport={exportDraft} onImport={(file) => void importDraft(file)} onFieldFocus={rememberFocusedField} />
          )}
          {screen === 'jaanch' && (
            <JaanchScreen checks={checks} blocking={blocking} passed={passed} busy={busy} onGoToField={(fieldPath) => {
              navigate('prepare'); setTimeout(() => document.getElementById(fieldPath === 'registeredOffice' ? 'field-office' : 'field-boardMeetings')?.focus(), 80);
            }} onRerun={() => void runChecks()} onSeal={() => void createMohar()} online={online} />
          )}
          {screen === 'mohar' && <MoharScreen state={state} busy={busy} online={online} onSign={() => void sign()} />}
          {screen === 'sign' && <SignScreen state={state} busy={busy} online={online} onSubmit={() => void submit()} onEdit={() => { navigate('prepare'); setNotice('Editing creates a new draft and invalidates this signature for the next package.'); }} />}
          {screen === 'rasid' && <RasidScreen state={state} busy={busy} online={online} onPay={() => void approvePayment()} onStatus={() => navigate('status')} />}
          {screen === 'status' && <StatusScreen state={state} accepted={accepted} busy={busy} online={online} onPause={() => void pauseProcessor()} onResume={() => void resumeProcessor()} />}
          {screen === 'recovery' && <RecoveryScreen state={state} onOpenMain={() => navigate('prepare')} />}
          {screen === 'lineage' && (state.features.correctionLineage ? <LineageScreen state={state} busy={busy} onCreate={() => void createCorrection()} onSign={() => { if (state.package?.packageId === state.correction?.childPackageId) navigate('mohar'); }} /> : <FilingsScreen state={state} onPrepare={() => navigate(resumeScreen(state))} onStudio={() => navigate('studio')} onRecovery={() => navigate('recovery')} onNavigate={navigate} />)}
          {screen === 'demoControls' && <DemoControlsScreen state={state} busy={busy} onControl={(flag) => void runControl(flag)} onPause={() => void pauseProcessor()} onResume={() => void resumeProcessor()} onReset={() => void resetDemo()} onLineage={() => navigate('lineage')} />}
        </main>
      </div>
      <footer className="registry-footer app-footer">
        <div><Wordmark compact /><p>Independent MCA21 filing workspace for one fictional company.</p></div>
        <nav aria-label="Workspace footer"><button onClick={() => navigate('reviewer')}>Reviewer Guide</button><button onClick={() => navigate('evidence')}>Evidence</button><button onClick={() => navigate('limitations')}>Limitations</button>{state.features.correctionLineage && <button onClick={() => navigate('lineage')}>Package lineage</button>}<button onClick={() => void resetDemo()} disabled={busy === 'reset'}>Reset workspace</button><button onClick={() => void signOut()} disabled={busy === 'logout'}>Sign Out</button></nav>
        <p>Synthetic data · Not affiliated with the Ministry of Corporate Affairs.</p>
      </footer>
    </div>
  );
}

function WorkspaceRestoringScreen({ theme }: { theme: Theme }) {
  return <main className="workspace-restoring" data-theme={theme} aria-busy="true" aria-live="polite"><div className="india-rule" aria-hidden="true"><span /><span /><span /></div><div className="restoring-mast"><RegistryBrand /><span className="status"><i className="status-mark progress" />Restoring secure workspace</span></div><div className="restoring-body"><span className="restoring-line" /><span className="restoring-line short" /><p>Opening the saved filing record…</p></div></main>;
}

function Disclosure({ onOpen }: { onOpen: () => void }) {
  return <button className="prototype-strip disclosure-button" onClick={onOpen}>Synthetic data · Independent prototype · Not affiliated with the Ministry of Corporate Affairs</button>;
}

function ThemeToggle({ theme, onTheme, ready = true }: { theme: Theme; onTheme: () => void; ready?: boolean }) {
  const mode = theme === 'light' ? 'Dark mode' : 'Light mode';
  return <button type="button" className="theme-toggle" onClick={onTheme} disabled={!ready} aria-label={`Accessibility · ${mode}`} aria-pressed={theme === 'dark'}>Accessibility · {mode}</button>;
}

function RegistryBrand({ compact = false }: { compact?: boolean }) {
  return <div className={`registry-title-block ${compact ? 'compact' : ''}`}><span className="registry-monogram" aria-hidden="true">21</span><span className="registry-title-copy"><strong>MCA21 Corporate Services</strong><small>DARJ / <span lang="hi">दर्ज</span> · Independent Redesign Concept</small></span></div>;
}

const HOME_ACTIONS = [
  ['Prepare an MCA filing from documents', 'AOC-4', 'working'],
  ['Register a company', 'company incorporation', 'catalogue'],
  ['Register an LLP', 'LLP incorporation', 'catalogue'],
  ['Update director details', 'DIR-3 KYC', 'catalogue'],
  ['View company master data', 'company master data', 'catalogue'],
  ['Track a transaction', 'track transaction', 'catalogue'],
  ['Access public documents', 'certified copy', 'catalogue'],
  ['Calculate filing fees', 'fee enquiry', 'catalogue'],
] as const;

const HOME_SERVICE_GROUPS = [
  ['Company registration and name reservation', 'SPICe+ · RUN', 'company incorporation', 'Service catalogue'],
  ['LLP registration and services', 'FiLLiP · RUN-LLP', 'LLP incorporation', 'Service catalogue'],
  ['Annual company filings', 'AOC-4 · MGT-7', 'AOC-4', 'Working demo'],
  ['Directors, DIN and DSC', 'DIR-3 KYC · DIR-12', 'director', 'Service catalogue'],
  ['Charges and company changes', 'CHG-1 · INC-22', 'charge company change', 'Service catalogue'],
  ['Company and LLP master data', 'Public registry information', 'master data', 'Service catalogue'],
  ['Public documents and certified copies', 'Inspection · certified copy', 'public documents', 'Service catalogue'],
  ['Fees, payments and transaction tracking', 'Fee enquiry · status', 'payment tracking', 'Service catalogue'],
] as const;

const SEARCH_SUGGESTIONS = ['AOC-4', 'MGT-7', 'DIR-3 KYC', 'Company master data', 'Track transaction'] as const;

function LoginScreen({ theme, onTheme, hydrated, busy, onEnter, onStudio, onBrowse, onReviewer, onEvidence, onLimitations, error, sessionExpired, hasLocalRecovery, storageReady }: { theme: Theme; onTheme: () => void; hydrated: boolean; busy: boolean; onEnter: () => void; onStudio: () => void; onBrowse: (query?: string) => void; onReviewer: () => void; onEvidence: () => void; onLimitations: () => void; error: DarjError | null; sessionExpired: boolean; hasLocalRecovery: boolean; storageReady: boolean }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [registryQuery, setRegistryQuery] = useState('');
  const [registrySearched, setRegistrySearched] = useState(false);
  const [languageNote, setLanguageNote] = useState(false);
  const enterLabel = !hydrated || busy ? 'Preparing workspace…' : 'Open sample company workspace';
  return (
    <main className="registry-home" id="main-content">
      <div className="india-rule" aria-hidden="true"><span /><span /><span /></div>
      <button className="registry-disclaimer" onClick={onLimitations}>Synthetic data · Independent prototype · Not affiliated with the Ministry of Corporate Affairs</button>
      <header className="registry-identity-header">
        <h1 className="registry-brand-heading"><RegistryBrand /></h1>
        <nav className="registry-utilities" aria-label="Public utilities">
          <button onClick={() => setLanguageNote((current) => !current)}>English / हिंदी</button>
          <ThemeToggle theme={theme} onTheme={onTheme} ready={hydrated} />
          <button onClick={onEvidence}>Help</button>
          <button onClick={onReviewer}>Reviewer Guide</button>
          <button className="utility-signin" onClick={onEnter} disabled={!hydrated || busy}>Sign In</button>
        </nav>
      </header>
      <section className="operational-notice" aria-label="Environment status"><span className="status-mark durable" /><strong>Document guided AOC-4 journey ready</strong><span>Open the prepared sample to inspect extraction evidence, review decisions and retry safe submission.</span></section>
      {languageNote && <div className="registry-language-note" role="status">This review build uses English interface copy with Hindi identity labelling. Full Hindi localisation is outside the current scope.</div>}

      <section className="command-centre" aria-labelledby="login-title">
        <div className="command-main">
          <p className="eyebrow">CORPORATE FILING SERVICES</p>
          <h2 id="login-title">File company forms, view records and track transactions</h2>
          <form className="command-search" role="search" onSubmit={(event) => { event.preventDefault(); onBrowse(searchQuery); }}>
            <label htmlFor="public-service-search">Search services, forms, companies or transaction references</label>
            <span aria-hidden="true">⌕</span>
            <input id="public-service-search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search services, forms, companies or transaction references" />
            <button type="submit">Search</button>
          </form>
          <div className="search-suggestions" aria-label="Suggested searches"><span>Try</span>{SEARCH_SUGGESTIONS.map((suggestion) => <button key={suggestion} onClick={() => onBrowse(suggestion)}>{suggestion}</button>)}</div>
          <div className="quick-actions" aria-label="Popular services">{HOME_ACTIONS.map(([label, query, availability], index) => <button key={label} className={index === 0 ? 'working featured-action' : ''} disabled={busy} onClick={availability === 'working' ? onStudio : () => onBrowse(query)}><span className="mono">{index === 0 ? 'NEW' : String(index + 1).padStart(2, '0')}</span><span className="quick-action-copy"><strong>{label}</strong>{index === 0 && <small>Source linked AOC-4 preparation</small>}</span><span aria-hidden="true">→</span></button>)}</div>
        </div>
        <aside className="review-access" aria-labelledby="review-access-title">
          <div className="review-access-head"><span className="status-mark durable" /><span>Synthetic environment</span></div>
          <h2 id="review-access-title">Reviewer access</h2>
          <dl><div><dt>Sample user</dt><dd>Meet Vekaria</dd></div><div><dt>Fictional company</dt><dd>Aster Components Private Limited</dd></div><div><dt>In progress</dt><dd>AOC-4 · Draft 17</dd></div></dl>
          <button className="primary" type="button" onClick={onEnter} disabled={!hydrated || busy}>{enterLabel} <span aria-hidden="true">→</span></button>
          <button className="review-browse" type="button" onClick={() => onBrowse()}>Browse without signing in</button>
          <small>No OTP or personal information required.</small>
        </aside>
      </section>

      <section className="registry-stats" aria-label="Synthetic platform data">
        <article><strong>{STARTABLE_SERVICES.length} working filing journeys</strong><span>Demo data · 1 end to end and 4 guided intakes</span></article>
        <article><strong>1 sample company</strong><span>Synthetic environment · clearly fictional</span></article>
        <article><strong>3 verified documents</strong><span>Demo data · seeded PDF records</span></article>
        <article><strong><i className="status-mark durable" />All demo systems operational</strong><span>Synthetic environment · ready to review</span></article>
      </section>

      {(sessionExpired && hasLocalRecovery) && <div className="recovery-callout registry-alert" role="status"><strong>Your local work is safe.</strong><p>Open the sample company workspace to resume the filing and last focused field.</p></div>}
      {!storageReady && <div className="error-panel registry-alert" role="alert"><strong>Local storage is unavailable</strong><p>Edits are paused until browser storage is available. Public services and guidance remain accessible.</p></div>}
      {error && <div className="registry-alert"><ErrorPanel error={error} /></div>}

      <section className="home-section public-services" aria-labelledby="public-services-title"><div className="home-section-heading"><div><p className="eyebrow">SERVICES</p><h2 id="public-services-title">What do you need to do?</h2></div><p>Find common corporate registry tasks by purpose. Capability labels show what works in this independent environment.</p></div><div className="public-service-grid">{HOME_SERVICE_GROUPS.map(([title, detail, query, label], index) => <button key={title} onClick={label === 'Working demo' ? onEnter : () => onBrowse(query)}><span className="mono">{String(index + 1).padStart(2, '0')}</span><h3>{title}</h3><p>{detail}</p><strong className={label === 'Working demo' ? 'working-label' : ''}>{label} <span aria-hidden="true">→</span></strong></button>)}</div></section>

      <section className="home-section company-snapshot" aria-labelledby="sample-company-title"><div className="company-summary"><p className="eyebrow">FICTIONAL SAMPLE COMPANY</p><h2 id="sample-company-title">Aster Components Private Limited</h2><p className="company-cin">CIN (fictional) · DARJ-CIN-000117</p><dl><div><dt>Status</dt><dd><span className="status-mark durable" />Active in sample data</dd></div><div><dt>Registered office</dt><dd>Ahmedabad, Gujarat</dd></div><div><dt>Next compliance deadline</dt><dd>30 September 2026 · illustrative</dd></div></dl><button className="primary" onClick={onEnter}>Open company workspace <span aria-hidden="true">→</span></button></div><div className="company-progress"><div><span>AOC-4 draft progress</span><strong>Draft 17 · 3 of 3 documents ready</strong><div className="progress-rule" role="progressbar" aria-label="AOC-4 sample filing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={75}><i /></div></div><div><span>Verified attachments</span><strong>Financial statements · Auditor report · Board report</strong></div><div><span>Latest filing activity</span><strong>Company master snapshot 7 pinned for provenance</strong></div></div></section>

      <section className="home-section home-information-grid"><div className="notices-panel"><div className="home-section-heading compact"><div><p className="eyebrow">NOTICES</p><h2>Service updates</h2></div></div><div className="notice-list"><button onClick={onEnter}><span>26 AUG 2026</span><strong>Annual filing demonstration available</strong><small>Open the seeded AOC-4 workspace.</small></button><button onClick={onReviewer}><span>26 AUG 2026</span><strong>Synthetic payment-failure recovery scenario</strong><small>See callback reconciliation without duplicate payment.</small></button><button onClick={onEvidence}><span>26 AUG 2026</span><strong>New document verification and receipt trail</strong><small>Review hashes, custody and event evidence.</small></button></div></div><div className="public-registry-panel"><p className="eyebrow">PUBLIC REGISTRY SEARCH</p><h2>Preview a company record</h2><p>This search returns fictional data only. It does not query MCA21.</p><form onSubmit={(event) => { event.preventDefault(); setRegistrySearched(true); }}><label htmlFor="registry-preview-search">Company name or fictional CIN</label><div><input id="registry-preview-search" value={registryQuery} onChange={(event) => { setRegistryQuery(event.target.value); setRegistrySearched(false); }} placeholder="Try Aster Components" /><button type="submit">Find company</button></div></form>{registrySearched && <button className="registry-result" onClick={onEnter}><span className="status-mark durable" /><span><strong>Aster Components Private Limited</strong><small>DARJ-CIN-000117 · Ahmedabad · Fictional record</small></span><span aria-hidden="true">→</span></button>}</div></section>

      <footer className="registry-footer"><div><Wordmark compact /><p>Independent redesign concept for exploring reliable MCA21 statutory filing journeys.</p></div><nav aria-label="Homepage footer"><button onClick={onReviewer}>Reviewer Guide</button><button onClick={onEvidence}>Evidence</button><button onClick={onLimitations}>Limitations and data source</button></nav><p>DARJ does not connect to MCA21 or make statutory filings.</p></footer>
    </main>
  );
}

function PublicServicesScreen({ theme, onTheme, query, category, selectedKey, onQuery, onCategory, onSelect, onHome, onReviewer, onLimitations, onEnter }: { theme: Theme; onTheme: () => void; query: string; category: string; selectedKey: string; onQuery: (value: string) => void; onCategory: (value: string) => void; onSelect: (key: string) => void; onHome: () => void; onReviewer: () => void; onLimitations: () => void; onEnter: () => void }) {
  return <main className="public-directory-shell" id="main-content"><div className="india-rule" aria-hidden="true"><span /><span /><span /></div><button className="registry-disclaimer public-directory-disclaimer" onClick={onLimitations}>Synthetic data · Independent prototype · Not affiliated with the Ministry of Corporate Affairs</button><header className="registry-identity-header public-directory-header"><button className="registry-brand-button" onClick={onHome} aria-label="MCA21 Corporate Services home"><RegistryBrand /></button><nav className="registry-utilities" aria-label="Public directory navigation"><button onClick={onHome}>Home</button><button onClick={onReviewer}>Reviewer Guide</button><ThemeToggle theme={theme} onTheme={onTheme} /><button className="utility-signin" onClick={onEnter}>Sign In</button></nav></header><ServiceDirectoryScreen query={query} category={category} selectedKey={selectedKey} onQuery={onQuery} onCategory={onCategory} onSelect={onSelect} onOpenWorking={onEnter} onStart={onEnter} /><footer className="registry-footer"><div><Wordmark compact /><p>Browse the service map without signing in. Working journeys use only synthetic sample data.</p></div><nav><button onClick={onHome}>Home</button><button onClick={onReviewer}>Reviewer Guide</button><button onClick={onLimitations}>Limitations</button></nav><p>DARJ does not connect to MCA21 or make statutory filings.</p></footer></main>;
}

function AppHeader({ screen, state, theme, onTheme, serviceQuery, onServiceQuery, onNavigate, onSignOut, signingOut }: { screen: Screen; state: AppState; theme: Theme; onTheme: () => void; serviceQuery: string; onServiceQuery: (value: string) => void; onNavigate: (screen: Screen) => void; onSignOut: () => void; signingOut: boolean }) {
  return (
    <header className="app-header">
      <button className="registry-brand-button internal-brand" onClick={() => onNavigate('filings')} aria-label="MCA21 Corporate Services filing register"><RegistryBrand compact /></button>
      <div className="header-context"><span className="mono">ASTER / 01</span><strong>Aster Components Private Limited</strong><span>Company workspace</span></div>
      <form className="header-search" role="search" onSubmit={(event) => { event.preventDefault(); onNavigate('services'); }}><label htmlFor="global-service-search">Search services and forms</label><span aria-hidden="true">⌕</span><input id="global-service-search" value={serviceQuery} onChange={(event) => onServiceQuery(event.target.value)} placeholder="Search forms, services, tasks" /></form>
      <div className="header-state"><span className="status-mark durable" /><div><small>Current record</small><strong>{journeyLabel(state)}</strong></div></div>
      <div className="header-actions"><ThemeToggle theme={theme} onTheme={onTheme} /><button className="header-utility" onClick={() => onNavigate('reviewer')}>Reviewer Guide</button>{screen !== 'filings' && <button className="header-utility filing-register-link" onClick={() => onNavigate('filings')}>Filing register</button>}<button className="header-utility signout-button" onClick={onSignOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign Out'}</button></div>
    </header>
  );
}

function PlatformNav({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Screen) => void }) {
  const items: Array<{ screen: Screen; label: string; index: string }> = [
    { screen: 'filings', label: 'Overview', index: '01' },
    { screen: 'studio', label: 'Guided filing', index: '02' },
    { screen: 'newFiling', label: 'New filing', index: '03' },
    { screen: 'company', label: 'Company', index: '04' },
    { screen: 'documents', label: 'Documents', index: '05' },
    { screen: 'payments', label: 'Payments', index: '06' },
    { screen: 'guidance', label: 'Guidance', index: '07' },
    { screen: 'about', label: 'About DARJ', index: '08' },
  ];
  const filingScreens: Screen[] = ['prepare', 'jaanch', 'mohar', 'sign', 'rasid', 'status', 'recovery', 'lineage', 'demoControls'];
  return <aside className="platform-nav" aria-label="DARJ workspace"><p className="platform-nav-label">Workspace</p><nav>{items.map((item) => <button key={item.screen} className={screen === item.screen || (item.screen === 'filings' && filingScreens.includes(screen)) ? 'active' : ''} onClick={() => onNavigate(item.screen)}><span>{item.index}</span>{item.label}</button>)}</nav><div className="platform-nav-foot"><strong>Independent workspace</strong><span>Sample records.</span></div></aside>;
}

function Wordmark({ compact = false }: { compact?: boolean }) {
  return <div className={`wordmark ${compact ? 'compact' : ''}`} aria-label="DARJ, दर्ज"><span>DARJ</span><span className="wordmark-divider" aria-hidden="true" /><span lang="hi">दर्ज</span></div>;
}

function FilingsScreen({ state, onPrepare, onStudio, onRecovery, onNavigate }: { state: AppState; onPrepare: () => void; onStudio: () => void; onRecovery: () => void; onNavigate: (screen: Screen) => void }) {
  const count = 1 + state.serviceDrafts.length;
  return (
    <section className="page-section dashboard-page" aria-labelledby="filings-title">
      <div className="dashboard-intro"><div><p className="eyebrow">MCA21 filing workspace</p><h1 id="filings-title">Good afternoon, Meet.</h1><p>Your company workspace keeps each filing, its evidence and its outcome in one traceable record.</p></div><div className="dashboard-actions"><button className="primary dashboard-start" onClick={onStudio}>Prepare from documents <span aria-hidden="true">→</span></button><button className="secondary" onClick={() => onNavigate('newFiling')}>Start a new filing</button></div></div>
      <div className="dashboard-grid">
        <article className="priority-card"><div className="priority-head"><div><p className="eyebrow">Priority / AOC-4</p><h2>Annual financial filing</h2></div><span className="due-chip">Due scenario</span></div><div className="priority-progress" aria-label="Filing progress"><span className="done">Draft</span><span className={state.package ? 'done' : 'current'}>Jaanch</span><span className={state.receipt ? 'done' : ''}>Mohar</span><span className={state.receipt ? 'done' : ''}>Rasid</span></div><dl><div><dt>Entity</dt><dd>Aster Components Private Limited</dd></div><div><dt>Financial year</dt><dd>2025–26</dd></div><div><dt>Current record</dt><dd>{journeyLabel(state)}</dd></div><div><dt>Evidence</dt><dd>{state.attachments.length} verified PDFs</dd></div></dl><button className="primary" onClick={onPrepare}>{state.receipt ? 'Open durable record' : 'Continue the filing room'} <span aria-hidden="true">→</span></button></article>
        <aside className="filing-passport"><div className="passport-head"><span>FILING PASSPORT</span><strong>ACPL / 2025–26</strong></div><div className="passport-mark">A</div><dl><div><dt>Master snapshot</dt><dd>{state.master?.pinnedVersion ?? 7}</dd></div><div><dt>Draft version</dt><dd>v{state.draft?.version ?? 17}</dd></div><div><dt>Verified files</dt><dd>{state.attachments.length} / 3</dd></div><div><dt>Custody state</dt><dd>{state.receipt ? 'RECEIVED' : 'NOT SUBMITTED'}</dd></div></dl><small>One portable view of data provenance, attachments, checks and custody.</small></aside>
      </div>
      <div className="workspace-section-heading"><div><p className="eyebrow">Your work</p><h2>{count} {count === 1 ? 'filing is' : 'filings are'} in this workspace.</h2></div><div className="section-actions"><button className="text-button" onClick={onRecovery}>Recovery register</button><button className="text-button" onClick={() => onNavigate('reviewer')}>Reviewer guide</button><button className="text-button" onClick={() => onNavigate('services')}>All MCA services</button></div></div>
      <div className="register-table" aria-label="MCA21 filing records">
        <div className="register-table-head"><span>Folio</span><span>Company</span><span>Form / FY</span><span>Due state</span><span>Record state</span><span>Action</span></div>
        <div className="filing-row">
          <span data-label="Folio" className="mono">01 / A</span>
          <span data-label="Company"><strong>Aster Components Private Limited</strong><small>Company record 000117</small></span>
          <span data-label="Form / FY"><strong>AOC-4</strong><small>FY 2025-26</small></span>
          <span data-label="Due state"><strong>Needs attention</strong><small>Annual financial filing</small></span>
          <span data-label="Record state"><Status label={journeyLabel(state)} tone={state.receipt ? 'durable' : 'progress'} /><small>Draft v{state.draft?.version ?? 17} · {state.attachments.length} verified PDFs</small></span>
          <span data-label="Action"><button className="primary small" onClick={onPrepare}>{state.receipt ? 'View record' : 'Continue filing'} <span aria-hidden="true">→</span></button></span>
        </div>
        {state.serviceDrafts.map((filing, index) => <div className="filing-row" key={filing.filingId}><span data-label="Folio" className="mono">{String(index + 2).padStart(2, '0')} / N</span><span data-label="Company"><strong>Aster Components Private Limited</strong><small>{filing.applicantName}</small></span><span data-label="Form / FY"><strong>{filing.formCode}</strong><small>FY {filing.financialYear}</small></span><span data-label="Due state"><strong>New intake</strong><small>{filing.title}</small></span><span data-label="Record state"><Status label={filing.status === 'READY_FOR_AOC4' ? 'READY TO PREPARE' : 'INTAKE SAVED'} tone="progress" /><small>Updated {formatTime(filing.updatedAt)}</small></span><span data-label="Action"><button className="secondary small" onClick={() => filing.formCode === 'AOC-4' ? onPrepare() : onNavigate('newFiling')}>{filing.formCode === 'AOC-4' ? 'Prepare AOC-4' : 'View intake'}</button></span></div>)}
      </div>
      <div className="dashboard-lower"><section><div className="workspace-section-heading compact"><div><p className="eyebrow">Service shortcuts</p><h2>Common company filings</h2></div></div><div className="calendar-list"><div><time>AOC</time><span><strong>AOC-4</strong><small>Financial statements</small></span><button className="text-button" onClick={() => onNavigate('newFiling')}>Start</button></div><div><time>MGT</time><span><strong>MGT-7</strong><small>Annual return</small></span><button className="text-button" onClick={() => onNavigate('newFiling')}>Start</button></div><div><time>DIR</time><span><strong>DIR-3 KYC</strong><small>Director KYC</small></span><button className="text-button" onClick={() => onNavigate('newFiling')}>Start</button></div></div></section><section><div className="workspace-section-heading compact"><div><p className="eyebrow">Recent activity</p><h2>What changed</h2></div></div><ol className="activity-list"><li><span>01</span><div><strong>Draft restored and synchronised</strong><small>Version {state.draft?.version ?? 17} · browser and server</small></div></li><li><span>02</span><div><strong>{state.attachments.length} attachments verified</strong><small>MIME, bytes and SHA-256 confirmed</small></div></li><li><span>03</span><div><strong>Company master pinned</strong><small>Snapshot {state.master?.pinnedVersion ?? 7} retained for provenance</small></div></li></ol></section></div>
      <div className="reviewer-prompt"><div><p className="eyebrow">SHORT ON TIME?</p><strong>Review every recovery path in about five minutes.</strong><p>Five direct links open the exact state worth seeing.</p></div><button className="secondary" onClick={() => onNavigate('reviewer')}>Open reviewer guide <span aria-hidden="true">→</span></button></div>
      <div className="register-legend"><strong>State language</strong><span><i className="status-mark durable" /> Durable in DARJ</span><span><i className="status-mark progress" /> Reference or in progress</span><span><i className="status-mark attention" /> Needs attention</span></div>
    </section>
  );
}

function ServiceDirectoryScreen({ query, category, selectedKey, onQuery, onCategory, onSelect, onOpenWorking, onStart }: { query: string; category: string; selectedKey: string; onQuery: (value: string) => void; onCategory: (value: string) => void; onSelect: (key: string) => void; onOpenWorking: () => void; onStart: () => void }) {
  const [catalogue, setCatalogue] = useState<{ serviceCategories: ServiceCategory[]; allServices: CatalogService[] } | null>(null);
  useEffect(() => {
    let active = true;
    void import('@/lib/service-catalog').then((module) => { if (active) setCatalogue({ serviceCategories: module.serviceCategories, allServices: module.allServices }); });
    return () => { active = false; };
  }, []);
  const categories = catalogue?.serviceCategories ?? EMPTY_SERVICE_CATEGORIES;
  const catalogueServices = catalogue?.allServices ?? EMPTY_CATALOGUE_SERVICES;
  const normalized = query.trim().toLowerCase();
  const filtered = useMemo(() => catalogueServices.filter((service) => {
    const inCategory = category === 'all' || service.categoryId === category;
    const matches = !normalized || [service.code, service.title, service.summary, service.categoryName, service.entity].some((value) => value.toLowerCase().includes(normalized));
    return inCategory && matches;
  }), [catalogueServices, category, normalized]);
  const selected = catalogueServices.find((service) => `${service.categoryId}:${service.code}` === selectedKey) ?? catalogueServices[0];
  const showOverview = category === 'all' && !normalized;
  return <section className="page-section service-directory" aria-labelledby="services-title">
    <div className="directory-hero"><div><p className="eyebrow">MCA SERVICE CATALOGUE</p><h1 id="services-title">Find an MCA form or service</h1><p>Browse {catalogueServices.length || 143} MCA forms and services in {categories.length || 15} plain language categories. Five common services include a guided intake. AOC-4 includes the complete filing journey.</p><div className="directory-hero-actions"><button className="primary" onClick={onStart}>Start a new filing <span aria-hidden="true">→</span></button></div></div><div className="directory-stat"><strong>{catalogueServices.length || 143}</strong><span>forms and services mapped</span><small>Based on MCA navigation, help material and service groupings</small></div></div>
    <div className="directory-tools"><label className="directory-search"><span>Search the catalogue</span><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Try ‘change director’, ‘annual return’ or ‘certified copy’" /></label><label className="directory-filter"><span>Show category</span><select value={category} onChange={(event) => onCategory(event.target.value)}><option value="all">All {categories.length || 15} categories</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.services.length}</option>)}</select></label></div>
    <div className="catalogue-layout">
      <div className="catalogue-results">
        {!catalogue ? <div className="catalogue-loading"><span className="status-mark progress" /><div><strong>Opening the service map…</strong><p>The catalogue is loaded separately so the login and filing journey remain fast.</p></div></div> : showOverview ? <div className="category-grid">{categories.map((item, index) => <article key={item.id}><div className="category-card-head"><span className="mono">{String(index + 1).padStart(2, '0')}</span><small>{item.kicker}</small></div><h2>{item.name}</h2><p>{item.description}</p><ul>{item.services.slice(0, 3).map((service) => <li key={service.code}><code>{service.code}</code><span>{service.title}</span></li>)}</ul><button className="secondary" onClick={() => onCategory(item.id)}>Explore {item.services.length} services</button></article>)}</div> : <><div className="results-heading"><strong>{filtered.length} matching services</strong><button className="text-button" onClick={() => { onQuery(''); onCategory('all'); }}>Clear filters</button></div><div className="service-results">{filtered.map((service) => { const key = `${service.categoryId}:${service.code}`; return <button key={key} className={selectedKey === key ? 'selected' : ''} onClick={() => onSelect(key)}><span className="service-code">{service.code}</span><span><strong>{service.title}</strong><small>{service.summary}</small></span><span className={`availability ${service.availability}`}>{service.availability === 'working' ? 'Complete journey' : 'Reference brief'}</span></button>; })}</div></>}
      </div>
      {selected ? <aside className="service-brief" aria-live="polite"><div className="service-brief-top"><span className={`availability ${selected.availability}`}>{selected.availability === 'working' ? 'Complete workflow' : 'Catalogue reference'}</span><code>{selected.code}</code></div><p className="eyebrow">{selected.categoryName}</p><h2>{selected.title}</h2><p>{selected.summary}</p><dl><div><dt>For</dt><dd>{selected.entity}</dd></div><div><dt>Access</dt><dd>{selected.access}</dd></div><div><dt>What works here</dt><dd>{selected.availability === 'working' ? 'Complete DARJ draft-to-outcome journey' : 'Service discovery and plain-language brief only'}</dd></div></dl>{selected.availability === 'working' ? <button className="primary" onClick={onOpenWorking}>Open AOC-4 filing room <span aria-hidden="true">→</span></button> : <div className="catalogue-boundary"><strong>Capability boundary</strong><p>This entry is a service brief, not an implemented submission flow. Its label makes that boundary clear.</p></div>}<small className="service-source">Reference architecture only. Confirm current legal applicability, fees and form versions on the official MCA service before real use.</small></aside> : <aside className="service-brief catalogue-placeholder" aria-live="polite"><span className="availability reference">Loading reference</span><p className="eyebrow">Service map</p><h2>Plain-language service briefs</h2><p>The service map opens as a separate lightweight module.</p></aside>}
    </div>
  </section>;
}

const STARTABLE_SERVICES = [
  { code: 'AOC-4', title: 'Financial statements', summary: 'Prepare the annual financial filing and continue through Jaanch, Mohar and Rasid.', availability: 'Complete journey' },
  { code: 'MGT-7', title: 'Annual return', summary: 'Save the company, financial year and filing context for the annual return.', availability: 'Guided intake' },
  { code: 'DIR-3 KYC', title: 'Director KYC', summary: 'Begin a director KYC intake without entering real personal identifiers.', availability: 'Guided intake' },
  { code: 'DIR-12', title: 'Director or key managerial change', summary: 'Record the change context and keep it ready for a guided filing workflow.', availability: 'Guided intake' },
  { code: 'CHG-1', title: 'Create or modify a charge', summary: 'Start an intake for charge creation or modification and preserve the work.', availability: 'Guided intake' },
] as const;

function NewFilingScreen({ busy, onStart }: { busy: boolean; onStart: (formCode: string, financialYear: string, applicantName: string, note: string) => void }) {
  const [formCode, setFormCode] = useState('AOC-4');
  const [financialYear, setFinancialYear] = useState('2025-26');
  const [applicantName, setApplicantName] = useState('Meet Vekaria');
  const [note, setNote] = useState('');
  const selected = STARTABLE_SERVICES.find((service) => service.code === formCode) ?? STARTABLE_SERVICES[0];
  return <section className="page-section new-filing-page" aria-labelledby="new-filing-title"><div className="page-heading"><div><p className="eyebrow">New MCA21 filing</p><h1 id="new-filing-title">What do you need to file?</h1></div><p>Choose a service, confirm a few details and save the intake. You can return to it from the filing register.</p></div><div className="service-start-grid" role="radiogroup" aria-label="Available services">{STARTABLE_SERVICES.map((service) => <button type="button" role="radio" aria-checked={formCode === service.code} className={formCode === service.code ? 'selected' : ''} key={service.code} onClick={() => setFormCode(service.code)}><span className="service-code">{service.code}</span><span><strong>{service.title}</strong><small>{service.summary}</small></span><em>{service.availability}</em></button>)}</div><div className="intake-layout"><form className="intake-form" onSubmit={(event) => { event.preventDefault(); onStart(formCode, financialYear, applicantName, note); }}><div className="intake-heading"><div><p className="eyebrow">Selected service</p><h2>{selected.code} · {selected.title}</h2></div><Status label={selected.availability.toUpperCase()} tone={selected.code === 'AOC-4' ? 'durable' : 'progress'} /></div><div className="aligned-field-grid"><label><span>Financial year</span><input value={financialYear} onChange={(event) => setFinancialYear(event.target.value)} pattern="20[0-9]{2}-[0-9]{2}" placeholder="2025-26" required /></label><label><span>Applicant name</span><input value={applicantName} onChange={(event) => setApplicantName(event.target.value)} minLength={2} maxLength={80} required /></label><label className="full"><span>Note <small>optional</small></span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Add a short reminder for this filing" rows={3} /></label></div><div className="intake-submit"><p>{selected.code === 'AOC-4' ? 'This service continues into the complete filing room.' : 'This saves a durable intake. The full statutory submission workflow for this service is not implemented.'}</p><button className="primary" type="submit" disabled={busy}>{busy ? 'Saving filing…' : 'Create filing'} <span aria-hidden="true">→</span></button></div></form><aside className="intake-assurance"><p className="eyebrow">BEFORE YOU START</p><h2>Use sample details only.</h2><ul><li>Do not enter a real CIN, DIN, PAN, Aadhaar or payment information.</li><li>Your intake is stored in this isolated review session.</li><li>A clear capability label shows what is and is not implemented.</li></ul></aside></div></section>;
}

function ReviewerScreen({ theme, onTheme, onNavigate }: { theme: Theme; onTheme: () => void; onNavigate: (screen: Screen) => void }) {
  const caseId = 'DARJ-DEMO-AOC4-01';
  const paths = [
    ['Recover a draft after the tab is killed', `/filings/${caseId}/prepare?review=kill-tab`, 'Local draft recovery'],
    ['Retry a submission whose response was lost', '/recovery?review=lost-response', 'Same package, same receipt'],
    ['Reload after a payment callback never arrives', '/recovery?review=lost-callback', 'Server-side reconciliation'],
    ['Watch a paused processor hold custody', '/recovery?review=paused', 'No resubmission needed'],
    ['Correct a filing without rebuilding it', `/filings/${caseId}/lineage?review=lineage`, 'Linked package lineage'],
  ];
  return <main className="reviewer-shell"><div className="india-rule" aria-hidden="true"><span /><span /><span /></div><button className="registry-disclaimer" onClick={() => onNavigate('limitations')}>Synthetic data · Independent prototype · Not affiliated with the Ministry of Corporate Affairs</button><header className="registry-identity-header reviewer-header"><button className="registry-brand-button" onClick={() => onNavigate('login')} aria-label="MCA21 Corporate Services home"><RegistryBrand /></button><nav className="registry-utilities" aria-label="Reviewer guide navigation"><button onClick={() => onNavigate('login')}>Home</button><button onClick={() => onNavigate('evidence')}>Evidence</button><ThemeToggle theme={theme} onTheme={onTheme} /><button className="utility-signin" onClick={() => onNavigate('login')}>Sign In</button></nav></header><section className="reviewer-page" aria-labelledby="reviewer-title"><div className="reviewer-intro"><p className="eyebrow">REVIEWER GUIDE</p><h1 id="reviewer-title">One guided filing and five recovery proofs</h1><p>Start with the document journey, then use the direct links to inspect each reliability state. DARJ opens an isolated sample workspace for every path.</p></div><a className="reviewer-feature" href={`/filings/${caseId}/studio?review=documents`}><span className="mono">START HERE · WORKING JOURNEY</span><span><strong>Prepare AOC-4 from documents</strong><small>Inspect source linked extraction, record a professional review and create a durable draft.</small></span><span aria-hidden="true">→</span></a><div className="reviewer-links" aria-label="Reliability review paths">{paths.map(([title, path, proof], index) => <a href={path} key={path}><span className="mono">{String(index + 1).padStart(2, '0')}</span><strong>{title}</strong><small>{proof}</small><span aria-hidden="true">→</span></a>)}</div><div className="reviewer-boundary"><strong>Independent review environment</strong><p>Sample data only. DARJ does not connect to MCA21, make a statutory filing or collect sensitive identifiers.</p></div></section><footer className="registry-footer"><div><Wordmark compact /><p>A guided document journey and five direct reliability paths.</p></div><nav aria-label="Reviewer footer"><button onClick={() => onNavigate('login')}>Home</button><button onClick={() => onNavigate('evidence')}>Evidence</button><button onClick={() => onNavigate('limitations')}>Limitations</button></nav><p>DARJ does not connect to MCA21 or make statutory filings.</p></footer></main>;
}

function CompanyScreen({ state, onPrepare, onDocuments }: { state: AppState; onPrepare: () => void; onDocuments: () => void }) {
  return <section className="page-section company-page" aria-labelledby="company-title"><div className="entity-mast"><div><p className="eyebrow">Company workspace</p><h1 id="company-title">Aster Components<br />Private Limited</h1><p>One trusted company context for filings, people, documents, payments and provenance.</p></div><div className="entity-monogram" aria-hidden="true">AC</div></div><div className="entity-status-row"><div><span>Company record</span><strong>000117</strong></div><div><span>Entity type</span><strong>Private company</strong></div><div><span>Master snapshot</span><strong>v{state.master?.pinnedVersion ?? 7}</strong></div><div><span>Workspace state</span><Status label="ACTIVE" tone="durable" /></div></div><div className="company-grid"><section className="company-panel"><div className="panel-heading"><div><p className="eyebrow">Company profile</p><h2>Registry snapshot</h2></div><span className="source-chip">Pinned source</span></div><dl className="profile-grid"><div><dt>Registered office</dt><dd>{state.master?.pinnedOffice ?? '23 Industrial Estate, Pune, Maharashtra'}</dd></div><div><dt>Financial year</dt><dd>1 April – 31 March</dd></div><div><dt>Company status</dt><dd>Active · sample</dd></div><div><dt>Authorised filer</dt><dd>Meet Vekaria · reviewer role</dd></div></dl></section><section className="company-panel"><div className="panel-heading"><div><p className="eyebrow">People & signing</p><h2>Authorised roles</h2></div></div><div className="people-list"><div><span className="person-mark">MV</span><span><strong>Meet Vekaria</strong><small>Authorised filer · active session</small></span><Status label="VERIFIED ROLE" tone="durable" /></div><div><span className="person-mark light">AD</span><span><strong>Ananya Desai</strong><small>Director · sample record</small></span><Status label="REFERENCE" tone="progress" /></div></div></section><section className="company-panel wide"><div className="panel-heading"><div><p className="eyebrow">Compliance position</p><h2>What needs action</h2></div><button className="text-button" onClick={onPrepare}>Open filing room</button></div><div className="obligation-board"><article><span className="obligation-number">01</span><div><strong>AOC-4 · FY 2025–26</strong><p>Working DARJ reliability journey with {state.attachments.length} verified attachments.</p></div><Status label={journeyLabel(state)} tone={state.receipt ? 'durable' : 'attention'} /></article><article><span className="obligation-number">02</span><div><strong>MGT-7 · Annual return</strong><p>A guided intake can be saved; the full submission workflow is not implemented.</p></div><Status label="GUIDED INTAKE" tone="progress" /></article></div></section><section className="company-panel"><div className="panel-heading"><div><p className="eyebrow">Data provenance</p><h2>Master drift guard</h2></div></div><p className="panel-copy">DARJ pins a company snapshot to the filing and shows old-versus-current values before sealing. It never silently changes a draft.</p><div className="provenance-line"><span>Snapshot {state.master?.pinnedVersion ?? 7}</span><span>→</span><strong>{state.master?.reviewState ?? 'CURRENT'}</strong></div></section><section className="company-panel"><div className="panel-heading"><div><p className="eyebrow">Document vault</p><h2>{state.attachments.length} verified records</h2></div></div><p className="panel-copy">Every completed attachment records filename, MIME, byte count, checksum and verification time.</p><button className="secondary" onClick={onDocuments}>Open document vault</button></section></div></section>;
}

function DocumentsScreen({ state, onPrepare }: { state: AppState; onPrepare: () => void }) {
  return <section className="page-section documents-page" aria-labelledby="documents-title"><div className="page-heading"><div><p className="eyebrow">Company document vault</p><h1 id="documents-title">Evidence, not a loose upload folder.</h1></div><p>These files belong to this review workspace. DARJ records provenance and verification boundaries for every filing attachment.</p></div><div className="document-summary"><div><strong>{state.attachments.length}</strong><span>server-verified PDFs</span></div><div><strong>{state.uploadSessions.filter((item) => item.state === 'UPLOADING').length}</strong><span>resumable sessions</span></div><div><strong>12 MB</strong><span>per-file review limit</span></div><div><strong>SHA-256</strong><span>client and server match</span></div></div><div className="document-table"><div className="document-table-head"><span>Document</span><span>Filing use</span><span>Size</span><span>Fingerprint</span><span>State</span></div>{state.attachments.map((item) => <article key={item.slot}><span><i className="file-mark">PDF</i><span><strong>{item.filename}</strong><small>{labelSlot(item.slot)}</small></span></span><span><strong>AOC-4 / FY 2025–26</strong><small>Package input</small></span><span className="mono">{formatBytes(item.bytes)}</span><code title={item.sha256}>{shortHash(item.sha256)}</code><Status label="SERVER VERIFIED" tone="durable" /></article>)}</div><div className="document-guides"><article><span className="mono">01</span><h2>Resumable by protocol</h2><p>TUS tracks a server-confirmed offset and R2-compatible multipart parts. Reloading does not resend completed chunks.</p></article><article><span className="mono">02</span><h2>Complete means verified</h2><p>A filename or progress bar is not completion. MIME, PDF bytes, EOF, size and hash must agree.</p></article><article><span className="mono">03</span><h2>Bound into Mohar</h2><p>Sealing records the exact attachment manifest so later replacement creates a new package boundary.</p></article></div><div className="action-bar"><div><strong>Manage filing attachments in context</strong><small>Replacement and upload recovery stay inside the AOC-4 filing room.</small></div><button className="primary" onClick={onPrepare}>Open attachments <span aria-hidden="true">→</span></button></div></section>;
}

function PaymentsScreen({ state, onReceipt }: { state: AppState; onReceipt: () => void }) {
  const [copies, setCopies] = useState(1);
  const estimated = 6000 + Math.max(0, copies - 1) * 100;
  return <section className="page-section payments-workspace" aria-labelledby="payments-title"><div className="page-heading"><div><p className="eyebrow">Payments & reconciliation</p><h1 id="payments-title">Money state stays separate from filing state.</h1></div><p>No real money, bank, card, UPI, OTP or payment data is used. This screen demonstrates clear status and recovery language.</p></div><div className="payments-grid"><section className="payment-ledger"><div className="panel-heading"><div><p className="eyebrow">Current transaction</p><h2>AOC-4 illustrative fee</h2></div><Status label={state.payment?.state ?? 'NOT CREATED'} tone={state.payment?.state === 'PAID' ? 'durable' : 'progress'} /></div><strong className="ledger-amount">₹6,000.00</strong><dl><div><dt>Custody</dt><dd>{state.receipt ? 'RECEIVED' : 'NOT SUBMITTED'}</dd></div><div><dt>Payment</dt><dd>{state.payment?.state ?? 'NOT STARTED'}</dd></div><div><dt>Processing</dt><dd>{state.processingJob?.state ?? 'NOT STARTED'}</dd></div><div><dt>Reconciliation ref.</dt><dd className="mono">{state.payment?.reconciliationReference ?? '—'}</dd></div></dl><button className="primary" onClick={onReceipt}>{state.receipt ? 'Open Rasid and payment' : 'Continue filing first'} <span aria-hidden="true">→</span></button></section><section className="fee-preview"><p className="eyebrow">Illustrative fee preview</p><h2>See the cost before starting</h2><p>This calculator is a design example, not an official fee computation.</p><label><span>Service</span><select><option>AOC-4 · illustrative base fee</option></select></label><label><span>Illustrative document copies</span><input type="number" min="1" max="10" value={copies} onChange={(event) => setCopies(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} /></label><div className="estimate-total"><span>Illustrative total</span><strong>₹{estimated.toLocaleString('en-IN')}.00</strong></div><small>Always confirm current fees and additional-fee rules on the official service before real use.</small></section></div><div className="state-model"><article><span className="status-mark durable" /><div><small>Custody</small><strong>Did DARJ receive the exact package?</strong><p>Proved by Rasid and package hash.</p></div></article><article><span className="status-mark progress" /><div><small>Payment</small><strong>Was the simulated fee approved?</strong><p>Reconciled from server state after callback loss.</p></div></article><article><span className="status-mark attention" /><div><small>Processing</small><strong>What is the downstream outcome?</strong><p>Delay never asks the user to pay or submit again.</p></div></article></div></section>;
}

function GuidanceScreen({ onNavigate }: { onNavigate: (screen: Screen) => void }) {
  const guides = [
    ['Choose the right service', 'Search by plain-language task, entity, form code or service category.', 'services'],
    ['Prepare an annual filing', 'See how local-first drafts, verified attachments and deterministic Jaanch work.', 'prepare'],
    ['Understand a Rasid', 'Learn why custody, payment, processing and acceptance are separate states.', 'evidence'],
    ['Recover from interruption', 'Try upload pause, response loss, callback loss, master drift and processor delay.', 'recovery'],
  ] as Array<[string, string, Screen]>;
  return <section className="page-section guidance-page" aria-labelledby="guidance-title"><div className="guidance-hero"><p className="eyebrow">Guidance centre</p><h1 id="guidance-title">Plain answers before a deadline.</h1><p>Help is organised around what a person is trying to finish—not internal portal terminology.</p></div><div className="guide-grid">{guides.map(([title, detail, screen], index) => <button key={title} onClick={() => onNavigate(screen)}><span className="mono">{String(index + 1).padStart(2, '0')}</span><h2>{title}</h2><p>{detail}</p><strong>Open guide →</strong></button>)}</div><div className="help-register"><div><span className="mono">A</span><div><strong>Filing and form guidance</strong><p>Catalogue coverage, data requirements and honest implementation labels.</p></div></div><div><span className="mono">B</span><div><strong>Upload and browser recovery</strong><p>What remains safe locally, what needs the server and how resumable uploads continue.</p></div></div><div><span className="mono">C</span><div><strong>Payments and status</strong><p>How to interpret custody, payment, queue and acceptance without dangerous assumptions.</p></div></div><div><span className="mono">D</span><div><strong>Limitations and escalation</strong><p>What DARJ does not decide, where this workspace stops and which official source must be checked.</p></div></div></div><div className="boundary-note"><strong>No compliance chatbot theatre</strong><p>DARJ uses deterministic, explainable checks in the working flow. It does not invent legal advice or claim that a conversational answer determines statutory applicability.</p></div></section>;
}

function AboutScreen({ onNavigate }: { onNavigate: (screen: Screen) => void }) {
  return <section className="page-section about-page" aria-labelledby="about-title"><div className="about-mast"><div><p className="eyebrow">About DARJ / दर्ज</p><h1 id="about-title">A reliable filing layer, designed independently.</h1></div><p>DARJ asks one product question: what if a statutory filing behaved like a reliable transaction instead of a fragile browser session?</p></div><div className="about-principles"><article><span>01</span><h2>Save before sync</h2><p>Draft recovery begins locally, then reconciles explicit versions with the server.</p></article><article><span>02</span><h2>Seal an exact package</h2><p>Fields and verified files become one immutable, canonical package hash.</p></article><article><span>03</span><h2>Make retries harmless</h2><p>Idempotency and atomic custody prevent duplicate receipts after lost responses.</p></article><article><span>04</span><h2>Name every state</h2><p>Received, paid, processing and accepted never blur into one vague “submitted” label.</p></article></div><div className="about-split"><section><p className="eyebrow">What this platform covers</p><h2>A complete service map around one complete journey.</h2><p>The platform shell maps company, LLP, director, charge, annual, approval, foreign-company, Nidhi, master-data, document, payment, grievance, investor, DSC, information and help categories. That breadth improves discovery; it does not create fake functionality.</p><button className="primary" onClick={() => onNavigate('services')}>Explore the service map <span aria-hidden="true">→</span></button></section><section className="independence-card"><span className="mono">INDEPENDENCE RECORD / 01</span><h2>Not an MCA service.</h2><ul><li>No live MCA integration or private API access</li><li>No government logo, endorsement or partnership claim</li><li>No real company, DIN, PAN, Aadhaar, OTP or payment data</li><li>No legal-compliance determination</li><li>Working and mocked boundaries shown in product</li></ul><button className="secondary" onClick={() => onNavigate('limitations')}>Read all limitations</button></section></div><div className="mca-context"><div><p className="eyebrow">MCA context</p><h2>Designed for the public-service landscape, not presented as the Ministry.</h2></div><p>The official MCA surface spans policy information, Acts and rules, offices and affiliated bodies, registry master data, company and LLP filings, directors and DSC, payments, documents, grievances, IEPF, data and help. DARJ reorganises those categories for discovery while preserving its independent identity.</p></div></section>;
}

type StudioServiceMatch = { code: string; title: string; detail: string; availability: 'working' | 'catalogue'; query: string };

function matchStudioService(value: string): StudioServiceMatch {
  const query = value.trim();
  const need = query.toLowerCase();
  if (/aoc|financial statement|annual account|balance sheet/u.test(need)) return { code: 'AOC-4', title: 'Filing of financial statements', detail: 'The complete document guided journey is available in this build.', availability: 'working', query: 'AOC-4' };
  if (/mgt|annual return/u.test(need)) return { code: 'MGT-7', title: 'Annual return', detail: 'A durable guided intake is available. Full document automation is limited to AOC-4.', availability: 'catalogue', query: 'MGT-7' };
  if (/director|din|kyc/u.test(need)) return { code: 'DIR-3 KYC', title: 'Director KYC', detail: 'A durable guided intake is available in the filing catalogue.', availability: 'catalogue', query: 'DIR-3 KYC' };
  if (/charge|lender|security interest/u.test(need)) return { code: 'CHG-1', title: 'Create or modify a charge', detail: 'The service catalogue contains the guided intake and related charge services.', availability: 'catalogue', query: 'CHG-1' };
  if (/incorporat|register.*company|new company|name reserv/u.test(need)) return { code: 'SPICe+', title: 'Company incorporation and name reservation', detail: 'The catalogue maps the relevant registration services and capability boundaries.', availability: 'catalogue', query: 'company incorporation' };
  if (/llp/u.test(need)) return { code: 'FiLLiP', title: 'LLP incorporation and services', detail: 'The catalogue maps LLP registration and related services.', availability: 'catalogue', query: 'LLP incorporation' };
  return { code: 'CATALOGUE', title: 'Search the complete MCA service map', detail: 'No exact working journey matched this description. The service catalogue will keep your words as the search.', availability: 'catalogue', query };
}

function GuidedFilingStudio({ state, busy, onOpen, onUpdate, onApply, onPrepare, onBrowse }: {
  state: AppState;
  busy: string;
  onOpen: (scenario: StudioScenario, serviceNeed?: string) => void;
  onUpdate: (operation: string, data?: Record<string, unknown>) => void;
  onApply: () => void;
  onPrepare: () => void;
  onBrowse: (query: string) => void;
}) {
  const studio = state.studio;
  const [scenario, setScenario] = useState<StudioScenario>('clean');
  const [serviceNeed, setServiceNeed] = useState('File annual financial statements for my company');
  const [filter, setFilter] = useState<'all' | 'unresolved' | 'low' | 'edited'>('all');
  const [selectedField, setSelectedField] = useState('financialYear');
  const [editValue, setEditValue] = useState('');
  const [comment, setComment] = useState('');
  const [evidenceMode, setEvidenceMode] = useState(true);
  const [finderSubmitted, setFinderSubmitted] = useState('');
  const evidence = studio.evidence;
  const visibleEvidence = evidence.filter((field) => filter === 'all' || (filter === 'unresolved' && (!field.value || field.confidence === 'CONFLICTING')) || (filter === 'low' && ['LOW', 'MEDIUM', 'CONFLICTING'].includes(field.confidence)) || (filter === 'edited' && field.edited));
  const selected = evidence.find((field) => field.id === selectedField) ?? visibleEvidence[0] ?? evidence[0];
  const blocking = studio.validations.filter((check) => check.state === 'BLOCKING').length;
  const review = studio.validations.filter((check) => check.state === 'REVIEW').length;
  const studioBusy = busy.startsWith('studio');
  const timeline = [
    ...studio.timeline,
    ...state.events.filter((event) => ['SEALED', 'SIGNED', 'RECEIVED', 'PAID', 'ACCEPTED'].includes(event.eventType)).map((event) => ({ id: `case-${event.seq}`, label: event.eventType.replaceAll('_', ' '), detail: event.detail, actor: event.actor, occurredAt: event.occurredAt, packageVersion: state.package ? `Package v${state.package.version}` : `Draft v${state.draft?.version ?? 17}` })),
  ];
  const hasExtraction = evidence.length > 0;
  const finderMatch = finderSubmitted && finderSubmitted === serviceNeed.trim() ? matchStudioService(finderSubmitted) : null;

  return <section className={`page-section studio-page ${evidenceMode ? 'evidence-mode' : ''}`} aria-labelledby="studio-title">
    <div className="studio-heading"><div><p className="eyebrow">DARJ Guided Filing Studio</p><h1 id="studio-title">Documents to a reviewed AOC-4 package</h1><p>Upload once, verify every extracted value, record professional decisions, then continue through DARJ’s retry-safe filing journey.</p></div><div className="studio-boundary"><span className="status-mark attention" /><div><strong>Filing assistance, not legal advice</strong><p>Actual MCA submission, DSC signing and professional certification remain outside this independent prototype.</p></div></div></div>

    <ol className="studio-steps" aria-label="Guided filing stages">
      {['Entry', 'Guide', 'Documents', 'Extraction', 'Professional review', 'Seal and submit'].map((label, index) => <li key={label} className={(hasExtraction && index < 4) || studio.stage === 'READY' || (studio.stage === 'REVIEW' && index === 4) ? 'done' : index === 0 ? 'current' : ''}><span>{String(index + 1).padStart(2, '0')}</span>{label}</li>)}
    </ol>

    <section className="studio-entry" aria-labelledby="studio-entry-title"><div className="studio-section-head"><div><p className="eyebrow">Filing entry</p><h2 id="studio-entry-title">Start with the task or the documents you already have</h2></div>{hasExtraction && <Status label={`${studio.scenario.toUpperCase()} PACKAGE · ${studio.stage}`} tone={blocking ? 'attention' : studio.stage === 'READY' ? 'durable' : 'progress'} />}</div>
      <div className="entry-options">
        <article className="selected"><span className="mono">AOC-4</span><h3>File financial statements</h3><p>The complete automated journey in this build.</p><button className="primary" disabled={studioBusy} onClick={() => onOpen(scenario)}>Prepare AOC-4 <span aria-hidden="true">→</span></button></article>
        <article><span className="mono">SERVICE FINDER</span><h3>Describe what you need</h3><label htmlFor="service-need">Plain language filing need</label><textarea id="service-need" value={serviceNeed} onChange={(event) => setServiceNeed(event.target.value)} aria-describedby="service-finder-help" /><small id="service-finder-help" className="control-help">Use a task such as file annual accounts, complete director KYC or register an LLP.</small><button className="secondary" disabled={studioBusy || serviceNeed.trim().length < 8} onClick={() => { const value = serviceNeed.trim(); setFinderSubmitted(value); onUpdate('setNeed', { value }); }}>{busy === 'studio-setNeed' ? 'Matching service…' : 'Find the filing'}</button>{finderMatch && <div className="service-finder-result" role="status" aria-live="polite"><span className="mono">MATCHED SERVICE</span><strong>{finderMatch.code} · {finderMatch.title}</strong><p>{finderMatch.detail}</p>{finderMatch.availability === 'working' ? <button className="primary small" disabled={studioBusy} onClick={() => onOpen('clean', finderSubmitted)}>Prepare matched AOC-4</button> : <button className="secondary small" onClick={() => onBrowse(finderMatch.query)}>Open in service catalogue</button>}</div>}</article>
        <article><span className="mono">RESUME</span><h3>Continue a saved package</h3><p>{hasExtraction ? `Last saved ${formatTime(studio.updatedAt)} at ${studio.stage.toLowerCase().replaceAll('_', ' ')}.` : 'No document package has been prepared in this review run yet.'}</p><button className="secondary" disabled={!hasExtraction} onClick={() => document.getElementById('studio-evidence')?.scrollIntoView({ behavior: 'smooth' })}>Resume package</button></article>
      </div>
      <div className="scenario-switch" aria-label="Prepared review scenarios"><div><strong>Demo accelerator</strong><p>Open a prepared package without waiting for uploads or extraction.</p></div><label><input type="radio" name="studio-scenario" checked={scenario === 'clean'} onChange={() => setScenario('clean')} /> Clean documents</label><label><input type="radio" name="studio-scenario" checked={scenario === 'conflict'} onChange={() => setScenario('conflict')} /> Conflicting AGM date</label><button className="secondary" disabled={studioBusy} onClick={() => onOpen(scenario)}>Open prepared package</button></div>
    </section>

    {hasExtraction && <>
      <section className="studio-guide" aria-labelledby="studio-guide-title"><div><p className="eyebrow">Filing Guide</p><h2 id="studio-guide-title">Questions only where the documents leave doubt</h2><p>The guide determined <strong>{studio.variant}</strong>. Answers are saved to this filing run and can be changed.</p></div>{studio.evidence.find((field) => field.id === 'agmDate')?.confidence === 'CONFLICTING' ? <div className="guide-question"><strong>I found different AGM dates in the Board’s Report and authorization record. Which record should be used?</strong><p>The selected date will still require professional confirmation before sealing.</p><div><button className="secondary" disabled={studioBusy} onClick={() => onUpdate('answer', { key: 'agmResolution', value: 'board' })}>Use Board’s Report · 29 Jul</button><button className="secondary" disabled={studioBusy} onClick={() => onUpdate('answer', { key: 'agmResolution', value: 'authorization' })}>Use authorization record · 31 Jul</button></div></div> : <div className="guide-clear"><span className="status-mark durable" /><div><strong>No unanswered filing questions</strong><p>The supplied records contain the fields required by this limited AOC-4 schema.</p></div></div>}</section>

      <section className="studio-documents" aria-labelledby="studio-documents-title"><div className="studio-section-head"><div><p className="eyebrow">Resumable document intake</p><h2 id="studio-documents-title">Files remain traceable when they are replaced</h2></div><button className="secondary" onClick={onPrepare}>Manage uploads</button></div><div className="document-register">{STUDIO_DOCUMENTS.map((document, index) => { const attachment = state.attachments.find((item) => item.slot === document.slot); const upload = state.uploadSessions.find((item) => item.slot === document.slot && item.state === 'UPLOADING'); const retainedVersions = state.attachmentVersions.filter((item) => item.slot === document.slot).length; return <article key={document.slot}><span className="mono">{String(index + 1).padStart(2, '0')}</span><div><strong>{document.label}</strong><small>{document.classification} · {document.required ? 'Required for this case' : 'When applicable'}</small></div><div><Status label={attachment ? 'EXTRACTED' : document.required ? 'MISSING' : 'NOT REQUIRED'} tone={attachment ? 'durable' : document.required ? 'attention' : 'progress'} /><small>{attachment ? `${attachment.filename} · ${formatBytes(attachment.bytes)}` : 'Checklist adapts to the filing variant'}</small></div><div><code>{attachment ? shortHash(attachment.sha256) : 'No fingerprint'}</code><small>{attachment ? `Virus scan passed · version ${attachment.version} · ${retainedVersions} retained` : upload ? `Recovery offset ${formatBytes(upload.confirmedOffset)}` : 'No file stored'}</small></div></article>; })}</div><p className="attachment-help">The three supplied PDFs are byte-counted, MIME checked and SHA-256 verified. Replacements use the existing TUS and R2 recovery path and retain every prior fingerprint. This checklist is contextual, not a universal statement of AOC-4 requirements.</p></section>

      <section id="studio-evidence" className="studio-evidence" aria-labelledby="studio-evidence-title"><div className="studio-section-head"><div><p className="eyebrow">Evidence-backed extraction</p><h2 id="studio-evidence-title">No source evidence means no silent autofill</h2></div><div className="evidence-mode-control"><button className={`secondary evidence-toggle ${evidenceMode ? 'active' : ''}`} aria-pressed={evidenceMode} aria-describedby="evidence-mode-help" onClick={() => setEvidenceMode((current) => !current)}>Evidence Mode {evidenceMode ? 'on' : 'off'}</button><small id="evidence-mode-help">Shows the source, page, excerpt, confidence and rule result behind each value.</small></div></div>
        <div className="evidence-toolbar"><label>Review role<select value={studio.activeRole} disabled={studioBusy} onChange={(event) => onUpdate('setRole', { role: event.target.value as StudioRole })}><option>Company preparer</option><option>CA/CS/CMA reviewer</option><option>Authorized signatory</option></select></label><div role="group" aria-label="Evidence filters">{(['all', 'unresolved', 'low', 'edited'] as const).map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'low' ? 'Low confidence' : item[0].toUpperCase() + item.slice(1)}</button>)}</div><span><strong>{blocking}</strong> blocking · <strong>{review}</strong> review</span></div>
        <div className="evidence-workspace"><div className="field-register">{visibleEvidence.map((field) => <button key={field.id} className={selected?.id === field.id ? 'selected' : ''} onClick={() => { setSelectedField(field.id); setEditValue(field.value); setComment(field.reviewerComment); }}><span><strong>{field.label}</strong><small>{field.value || 'Unresolved'}</small></span><Status label={field.confidence} tone={field.confidence === 'CONFLICTING' || field.confidence === 'LOW' ? 'attention' : field.confidence === 'MEDIUM' ? 'progress' : 'durable'} /></button>)}</div>{selected && <article className="source-evidence"><div className="source-head"><div><p className="eyebrow">Supporting evidence</p><h3>{selected.sourceDocument}</h3></div><Status label={selected.ruleStatus} tone={selected.ruleStatus === 'BLOCKED' ? 'attention' : selected.ruleStatus === 'REVIEW' ? 'progress' : 'durable'} /></div>{evidenceMode ? <><dl><div><dt>Page</dt><dd>{selected.page ?? 'Not found'}</dd></div><div><dt>Section</dt><dd>{selected.section}</dd></div><div><dt>Extracted</dt><dd>{formatTime(selected.extractedAt)}</dd></div><div><dt>Previous</dt><dd>{selected.previousValue || 'No prior value'}</dd></div></dl><blockquote>{selected.evidence}</blockquote></> : <div className="evidence-hidden-note" role="status"><strong>Evidence details are hidden</strong><p>Turn on Evidence Mode to inspect the source page, excerpt and previous value.</p></div>}{selected.decision !== 'PENDING' && <div className="review-decision" role="status"><Status label={selected.decision} tone={selected.decision === 'CLARIFICATION' ? 'attention' : 'durable'} /><span>This decision is stored with the field and reviewer role.</span></div>}<label>Edit value<input value={editValue} onChange={(event) => setEditValue(event.target.value)} placeholder={selected.value || 'Enter a resolved value'} /></label><label>Reviewer comment<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Explain the decision or clarification needed" /></label><p className="review-action-help">Accept records the extracted value. Edit records your replacement. Clarification keeps the field open.</p><div className="review-actions"><button className="primary" title="Record the current extracted value as reviewed" disabled={!selected.value || studioBusy} onClick={() => onUpdate('review', { fieldId: selected.id, decision: 'accept', comment })}>Accept extraction</button><button className="secondary" title="Replace the value and preserve the original in history" disabled={!editValue.trim() || studioBusy} onClick={() => onUpdate('review', { fieldId: selected.id, decision: 'edit', value: editValue, comment })}>Save edited value</button><button className="secondary" title="Keep this field open and ask the preparer for more information" disabled={studioBusy} onClick={() => onUpdate('review', { fieldId: selected.id, decision: 'clarify', comment: comment || 'Clarification requested from the company preparer.' })}>Request clarification</button></div></article>}</div>
      </section>

      <section className="studio-validation" aria-labelledby="studio-validation-title"><div className="studio-section-head"><div><p className="eyebrow">Deterministic validation</p><h2 id="studio-validation-title">Rules decide readiness, not the extraction model</h2></div><Status label={blocking ? `${blocking} BLOCKING` : review ? `${review} REVIEW` : 'READY TO SEAL'} tone={blocking ? 'attention' : review ? 'progress' : 'durable'} /></div><div className="validation-register">{studio.validations.map((check) => <article key={check.id}><Status label={check.state} tone={check.state === 'BLOCKING' ? 'attention' : check.state === 'REVIEW' ? 'progress' : 'durable'} /><div><strong>{check.label}</strong><p>{check.detail}</p><code>{check.ruleVersion}</code></div></article>)}</div><div className="action-bar"><div><strong>{studio.stage === 'READY' ? 'Professional review is recorded' : 'Complete review before creating the draft'}</strong><small>{studio.stage === 'READY' ? 'The responsible professional remains accountable for certification and approval.' : 'Available after one accepted or edited field and after every blocking issue is resolved.'}</small></div>{studio.stage === 'READY' ? <button className="primary" disabled={busy === 'studio-apply'} onClick={onApply}>Create reviewed draft <span aria-hidden="true">→</span></button> : <button className="primary" disabled={blocking > 0 || studioBusy} onClick={() => onUpdate('completeReview')}>{busy === 'studio-completeReview' ? 'Recording review…' : 'Complete professional review'}</button>}</div></section>

      <section className="studio-package" aria-labelledby="studio-package-title"><div className="studio-section-head"><div><p className="eyebrow">Downloadable filing package</p><h2 id="studio-package-title">Inspect every part before sealing</h2></div><span className="mono">{state.package?.hash ? shortHash(state.package.hash) : 'Preview checksum generated on download'}</span></div><div className="download-grid"><a href={`${API}?export=preview`}>Draft form PDF<small>Clearly labelled preview</small></a><a href={`${API}?export=evidence`}>Evidence report PDF<small>Field, source and excerpt</small></a><a href={`${API}?export=manifest`}>Attachment manifest<small>Hashes and MIME</small></a><a href={`${API}?export=validation`}>Validation report<small>Versioned rule results</small></a><a href={`${API}?export=review`}>Review history<small>Roles and decisions</small></a><a href={`${API}?export=package`}>Package JSON<small>Machine-readable record</small></a></div></section>

      <section className="studio-timeline" aria-labelledby="studio-timeline-title"><div className="studio-section-head"><div><p className="eyebrow">Filing evidence timeline</p><h2 id="studio-timeline-title">One record from documents to outcome</h2></div></div><ol>{timeline.map((event) => <li key={event.id}><time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time><span /><div><strong>{event.label}</strong><p>{event.detail}</p><small>{event.actor} · {event.packageVersion}</small></div></li>)}</ol><div className="boundary-note"><strong>Submission boundary</strong><p>DARJ seals an exact package, simulates DSC readiness and submits only through a mocked MCA adapter. A lost response is retried with the same idempotency key, producing one Rasid and one durable custody record.</p></div></section>
    </>}
  </section>;
}

function PrepareScreen({ state, form, saveState, busy, online, storageReady, conflict, uploadProgress, onChange, onJaanch, onResolveConflict, onUpload, onPauseUpload, onMasterReview, onExport, onImport, onFieldFocus }: {
  state: AppState; form: FormShape; saveState: string; busy: string; online: boolean; storageReady: boolean; conflict: DraftConflict | null;
  uploadProgress: Record<string, UploadProgress>;
  onChange: (field: keyof FormShape, value: string) => void; onJaanch: () => void; onResolveConflict: (choice: 'local' | 'server') => void;
  onUpload: (slot: string, file: File) => void; onPauseUpload: (slot: string) => void; onMasterReview: (choice: 'accept' | 'keep') => void;
  onExport: () => void; onImport: (file: File) => void; onFieldFocus: (fieldId: string) => void;
}) {
  const [activeSection, setActiveSection] = useState<(typeof PREPARE_SECTION_IDS)[number]>('company');
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let current: (typeof PREPARE_SECTION_IDS)[number] = 'company';
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const id of PREPARE_SECTION_IDS) {
          const element = document.getElementById(id);
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          if (rect.bottom <= 190) continue;
          const distance = Math.abs(rect.top - 190);
          if (distance < nearestDistance) {
            current = id;
            nearestDistance = distance;
          }
        }
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = 'attachments';
        setActiveSection(current);
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, []);
  return (
    <section className="prepare-grid" aria-labelledby="prepare-title">
      <aside className="section-index"><p className="eyebrow">Prepare</p><nav aria-label="Form sections">{PREPARE_SECTION_IDS.map((id, index) => <a key={id} className={activeSection === id ? 'active' : ''} aria-current={activeSection === id ? 'location' : undefined} href={`#${id}`} onClick={() => setActiveSection(id)}>{String(index + 1).padStart(2, '0')} {id === 'company' ? 'Company' : id === 'financials' ? 'Financials' : id === 'governance' ? 'Governance' : 'Attachments'}</a>)}</nav></aside>
      <div className="form-column">
        <div className="page-heading compact-heading"><div><p className="eyebrow">Draft v{state.draft?.version ?? 17}</p><h1 id="prepare-title">Prepare AOC-4</h1></div><Status label={saveState} tone={saveState.includes('Offline') || saveState.includes('Conflict') ? 'attention' : saveState.includes('Syncing') ? 'progress' : 'durable'} /></div>
        <p className="scope-note">This is a limited DARJ filing schema. It does not determine form applicability or legal compliance.</p>
        {state.signature && !state.signatureValid && <div className="notice signature-warning" role="status"><strong>SIGNATURE INVALID · NEW VERSION REQUIRED</strong><span>The filing inputs changed after signing. Run Jaanch and create a new Mohar before submitting.</span></div>}
        {!online && <div className="offline-panel" role="status"><strong>Offline · local editing remains available</strong><p>Jaanch, sealing, signing, submission, payment, and processing are paused until the connection returns.</p></div>}
        {!storageReady && <div className="error-panel" role="alert"><strong>Local storage unavailable. Edits blocked.</strong><p>DARJ cannot promise recovery, so it will not accept additional edits. Export the current draft before changing browser storage settings.</p><button className="secondary" onClick={onExport}>Export recovery JSON</button></div>}
        {conflict && <ConflictPanel conflict={conflict} busy={busy === 'conflict'} onResolve={onResolveConflict} />}
        <form onSubmit={(event) => event.preventDefault()}>
          <fieldset id="company" disabled={!storageReady}><legend><span>01</span> Company record</legend><div className="field full"><label htmlFor="field-office">Registered office</label><p id="office-help">Pinned from the company master snapshot {state.master?.pinnedVersion ?? 7}.</p><input id="field-office" value={form.registeredOffice} onFocus={() => onFieldFocus('field-office')} onChange={(e) => onChange('registeredOffice', e.target.value)} aria-describedby="office-help" /></div><div className="field"><label htmlFor="field-fy">Financial year</label><p id="fy-help">Reporting period for this AOC-4.</p><input id="field-fy" value={form.financialYear} onFocus={() => onFieldFocus('field-fy')} onChange={(e) => onChange('financialYear', e.target.value)} aria-describedby="fy-help" /></div><div className="field"><label htmlFor="field-agm">AGM date</label><p id="agm-help">Date used by the deterministic filing checks.</p><input id="field-agm" type="date" value={form.agmDate} onFocus={() => onFieldFocus('field-agm')} onChange={(e) => onChange('agmDate', e.target.value)} aria-describedby="agm-help" /></div></fieldset>
          {state.features.masterDrift && state.master && ['REVIEW_REQUIRED', 'PINNED_STOPPED'].includes(state.master.reviewState) && <MasterDriftPanel master={state.master} busy={busy === 'master'} onReview={onMasterReview} />}
          <fieldset id="financials" disabled={!storageReady}><legend><span>02</span> Financial summary</legend><div className="field"><label htmlFor="field-revenue">Revenue (₹)</label><p id="revenue-help">Whole rupees, without separators.</p><input id="field-revenue" inputMode="numeric" value={form.revenue} onFocus={() => onFieldFocus('field-revenue')} onChange={(e) => onChange('revenue', e.target.value)} aria-describedby="revenue-help" /></div><div className="field"><label htmlFor="field-expenses">Expenses (₹)</label><p id="expenses-help">Whole rupees, without separators.</p><input id="field-expenses" inputMode="numeric" value={form.expenses} onFocus={() => onFieldFocus('field-expenses')} onChange={(e) => onChange('expenses', e.target.value)} aria-describedby="expenses-help" /></div><div className="field"><label htmlFor="field-profit">Net profit (₹)</label><p id="profit-help">Whole rupees, without separators.</p><input id="field-profit" inputMode="numeric" value={form.netProfit} onFocus={() => onFieldFocus('field-profit')} onChange={(e) => onChange('netProfit', e.target.value)} aria-describedby="profit-help" /></div></fieldset>
          <fieldset id="governance" disabled={!storageReady}><legend><span>03</span> Governance</legend><div className="field"><label htmlFor="field-director">Director name</label><p id="director-help">Sample signatory shown on this filing.</p><input id="field-director" value={form.directorName} onFocus={() => onFieldFocus('field-director')} onChange={(e) => onChange('directorName', e.target.value)} aria-describedby="director-help" /></div><div className="field"><label htmlFor="field-boardMeetings">Board meetings</label><p id="meetings-help">Seeded with one deterministic issue for Jaanch.</p><input id="field-boardMeetings" inputMode="numeric" value={form.boardMeetings} onFocus={() => onFieldFocus('field-boardMeetings')} onChange={(e) => onChange('boardMeetings', e.target.value)} aria-describedby="meetings-help" /></div></fieldset>
          <fieldset id="attachments"><legend><span>04</span> Verified attachments</legend><div className="attachment-list">{state.attachments.map((item) => <AttachmentUploadRow key={item.slot} item={item} session={state.uploadSessions.find((session) => session.slot === item.slot && session.state === 'UPLOADING')} progress={uploadProgress[item.slot]} online={online} busy={busy} resumable={state.features.resumableUploads} onUpload={onUpload} onPause={onPauseUpload} />)}</div><p className="attachment-help">12 MB review limit. Filename must start <code>DARJ-</code>. Resumable uploads use TUS with 6 MB server-confirmed chunks in R2. DARJ marks a file complete only after MIME, byte count and SHA-256 verification.</p></fieldset>
        </form>
        <div className="draft-tools"><button className="secondary" onClick={onExport}>Export draft JSON</button><label className="secondary file-action">Import validated JSON<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ''; }} /></label></div>
        <div className="action-bar"><div><strong>{saveState}</strong><small>Last server sync {formatTime(state.draft?.savedAt)}</small></div><button className="primary" onClick={onJaanch} disabled={busy === 'jaanch' || !online || !storageReady || Boolean(conflict) || saveState !== 'Saved locally · Synced'}>{busy === 'jaanch' ? 'Running 43 checks…' : !online ? 'Reconnect to run Jaanch' : 'Run Jaanch · जाँच'} <span aria-hidden="true">→</span></button></div>
      </div>
      <aside className="record-strip"><p className="eyebrow">Record strip</p><RecordLine label="Case" value="DARJ-DEMO-AOC4-01" /><RecordLine label="Version" value={`v${state.draft?.version ?? 17}`} /><RecordLine label="Local" value={storageReady ? 'Saved' : 'Unavailable'} tone={storageReady ? 'durable' : undefined} /><RecordLine label="Server" value={online ? 'Synced' : 'Offline'} tone={online ? 'durable' : undefined} /><RecordLine label="Files" value={`${state.attachments.length} / 3 verified`} tone="durable" /><RecordLine label="Master" value={`Snapshot ${state.master?.pinnedVersion ?? 7}`} /></aside>
    </section>
  );
}

function ConflictPanel({ conflict, busy, onResolve }: { conflict: DraftConflict; busy: boolean; onResolve: (choice: 'local' | 'server') => void }) {
  const paths = conflict.changedPaths.length ? conflict.changedPaths : Object.keys(conflict.local).filter((key) => conflict.local[key as keyof FormShape] !== conflict.server.form[key as keyof FormShape]);
  return <section className="conflict-panel" aria-labelledby="conflict-title"><p className="eyebrow">Version conflict</p><h2 id="conflict-title">Choose which value becomes the next draft.</h2><p>No value has been overwritten. Server v{conflict.server.version} arrived after this local version.</p><div className="conflict-diff">{paths.map((path) => <div key={path}><strong>{fieldLabel(path)}</strong><span><small>Local</small>{conflict.local[path as keyof FormShape]}</span><span><small>Server</small>{conflict.server.form[path as keyof FormShape]}</span></div>)}</div><div className="conflict-actions"><button className="primary" disabled={busy} onClick={() => onResolve('local')}>Keep local as new version</button><button className="secondary" disabled={busy} onClick={() => onResolve('server')}>Use server version</button></div></section>;
}

function MasterDriftPanel({ master, busy, onReview }: { master: MasterState; busy: boolean; onReview: (choice: 'accept' | 'keep') => void }) {
  const stopped = master.reviewState === 'PINNED_STOPPED';
  return <section className="master-drift-panel" aria-labelledby="master-drift-title"><div className="issue-head"><code>DARJ_MASTER_DATA_DRIFT</code><Status label={stopped ? 'FILING STOPPED' : 'BLOCKS SEALING'} tone="attention" /></div><h2 id="master-drift-title">Registered office changed after this draft was saved.</h2><p>DARJ compared the pinned filing snapshot with the current sample company master. It will not replace this value silently.</p><dl><div><dt>Pinned snapshot {master.pinnedVersion}</dt><dd>{master.pinnedOffice}</dd></div><div><dt>Current snapshot {master.currentVersion}</dt><dd>{master.currentOffice}</dd></div><div><dt>Source</dt><dd>{master.source}</dd></div><div><dt>Detected</dt><dd>{formatTime(master.detectedAt)}</dd></div></dl>{stopped ? <p className="stopped-note"><strong>Meet kept the pinned value.</strong> This filing is stopped. Reset the review workspace to begin again.</p> : <div className="conflict-actions"><button className="primary" disabled={busy} onClick={() => onReview('accept')}>Accept current snapshot and create new draft</button><button className="secondary" disabled={busy} onClick={() => onReview('keep')}>Keep pinned value and stop</button></div>}</section>;
}

function AttachmentUploadRow({ item, session, progress, online, busy, resumable, onUpload, onPause }: { item: Attachment; session?: UploadSession; progress?: UploadProgress; online: boolean; busy: string; resumable: boolean; onUpload: (slot: string, file: File) => void; onPause: (slot: string) => void }) {
  const offset = progress?.offset ?? session?.confirmedOffset ?? 0;
  const total = progress?.total ?? session?.expectedBytes ?? 0;
  const partial = Boolean((progress && progress.state !== 'ERROR') || (session && session.confirmedOffset < session.expectedBytes));
  const isUploading = progress?.state === 'UPLOADING' || progress?.state === 'HASHING';
  const paused = progress?.state === 'PAUSED' || progress?.state === 'ERROR' || Boolean(session && !isUploading);
  return <div className="attachment-row"><span className="file-mark" aria-hidden="true">PDF</span><div className="attachment-name"><strong>{labelSlot(item.slot)}</strong><small>{partial ? `${progress?.filename ?? session?.filename} · ${formatBytes(offset)} of ${formatBytes(total)} safely stored` : `${item.filename} · ${formatBytes(item.bytes)}`}</small>{partial && <progress max={total || 1} value={offset} aria-label={`${labelSlot(item.slot)} upload progress`} />}</div><Status label={partial ? isUploading ? 'UPLOADING' : 'UPLOAD PAUSED' : 'SERVER VERIFIED'} tone={partial ? isUploading ? 'progress' : 'attention' : 'durable'} /><code title={item.sha256}>{shortHash(item.sha256)}</code><div className="attachment-actions">{resumable && isUploading && <button type="button" className="secondary" onClick={() => onPause(item.slot)}>Pause</button>}<label className={`secondary file-action ${!online ? 'disabled' : ''}`}>{paused ? 'Select same file to resume' : 'Replace'}<input type="file" accept="application/pdf,.pdf" disabled={!online || (busy.startsWith('upload:') && !paused)} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(item.slot, file); event.currentTarget.value = ''; }} /></label></div></div>;
}

function JaanchScreen({ checks, blocking, passed, busy, online, onGoToField, onRerun, onSeal }: { checks: CheckRecord[]; blocking: CheckRecord[]; passed: CheckRecord[]; busy: string; online: boolean; onGoToField: (fieldPath: string | null) => void; onRerun: () => void; onSeal: () => void }) {
  const total = checks.length || 43;
  return (
    <section className="page-section narrow-page" aria-labelledby="jaanch-title">
      <div className="page-heading"><div><p className="eyebrow">Jaanch · जाँच</p><h1 id="jaanch-title">{total} checks · {passed.length} passed · {blocking.length} needs attention</h1></div><p>Deterministic rules. DARJ-RULES-1.1. Company master snapshot 7.</p></div>
      {blocking.length > 0 ? <div className="check-group" role="alert" tabIndex={-1}><h2><span className="status-mark attention" /> Needs attention</h2>{blocking.map((issue) => <article className="issue-panel" key={issue.code}><div className="issue-head"><code>{issue.code}</code><Status label="BLOCKS SEALING" tone="attention" /></div><h3>{issue.summary}</h3><p>{issue.detail}</p><dl><div><dt>Expected</dt><dd>{issue.expected}</dd></div><div><dt>Actual</dt><dd>{issue.actual}</dd></div><div><dt>Location</dt><dd>{issue.fieldPath === 'registeredOffice' ? 'Company record / Registered office' : 'Governance / Board meetings'}</dd></div><div><dt>Retry safety</dt><dd>Safe after explicit review or correction</dd></div></dl><button className="secondary" onClick={() => onGoToField(issue.fieldPath)}>Go to exact field <span aria-hidden="true">→</span></button></article>)}</div> : <div className="all-clear"><span className="custody-mark mini" aria-hidden="true">✓</span><div><p className="eyebrow">Ready to seal</p><h2>All 43 deterministic checks passed.</h2><p>Jaanch does not decide legal compliance or the sufficiency of narrative disclosures.</p></div></div>}
      <details className="passed-checks"><summary>Passed <span>{passed.length} checks</span></summary><div className="check-list">{passed.map((check) => <div key={check.code}><code>{check.code}</code><span>{check.summary}</span><Status label="PASSED" tone="durable" /></div>)}</div></details>
      <details className="passed-checks"><summary>Not applicable <span>0 checks</span></summary><p>No rule was classified as not applicable for this seeded case.</p></details>
      <div className="action-bar"><div><strong>{blocking.length ? 'One issue blocks sealing' : 'Rule result fixed to this draft version'}</strong><small>Editing after this run makes Jaanch stale.</small></div>{blocking.length ? <button className="secondary" onClick={onRerun} disabled={busy === 'jaanch' || !online}>Rerun Jaanch</button> : <button className="primary" onClick={onSeal} disabled={busy === 'seal' || !online}>{busy === 'seal' ? 'Creating immutable package…' : !online ? 'Reconnect to create Mohar' : 'Create Mohar · मुहर'} <span aria-hidden="true">→</span></button>}</div>
    </section>
  );
}

function MoharScreen({ state, busy, online, onSign }: { state: AppState; busy: string; online: boolean; onSign: () => void }) {
  const pkg = state.package;
  if (!pkg) return null;
  return <section className="page-section narrow-page" aria-labelledby="mohar-title"><div className="page-heading"><div><p className="eyebrow">Mohar · मुहर</p><h1 id="mohar-title">One immutable package is ready.</h1></div><Status label="SEALED" tone="durable" /></div><div className="package-index"><div className="package-title"><span className="custody-mark" aria-hidden="true">◇</span><div><small>Package</small><h2>{pkg.packageId} · v{pkg.version}</h2><p>Created {formatTime(pkg.sealedAt)}</p></div></div><dl><RecordDefinition label="Form data" value={`${Object.keys(state.draft?.form ?? {}).length} normalised fields`} /><RecordDefinition label="Attachments" value={`${state.attachments.length} server verified PDF manifests`} /><RecordDefinition label="Rule version" value="DARJ-RULES-1.1" /><RecordDefinition label="Master snapshot" value="Company master, version 7" /><RecordDefinition label="Hash standard" value="RFC 8785 semantics and SHA-256" /></dl><div className="hash-block"><span>Full package hash</span><code>{pkg.hash}</code><CopyButton value={pkg.hash} /></div></div><div className="boundary-note"><strong>Sealing boundary</strong><p>Further editing creates a new version. It cannot change this package or its hash.</p></div><div className="action-bar"><div><strong>Package stored append-only</strong><small>The server recomputed this hash from authoritative stored bytes.</small></div><button className="primary" onClick={onSign} disabled={busy === 'sign' || !online}>{busy === 'sign' ? 'Preparing test signature…' : !online ? 'Reconnect to sign' : 'Continue to test signing'} <span aria-hidden="true">→</span></button></div></section>;
}

function SignScreen({ state, busy, online, onSubmit, onEdit }: { state: AppState; busy: string; online: boolean; onSubmit: () => void; onEdit: () => void }) {
  const signature = state.signature;
  const pkg = state.package;
  if (!signature || !pkg) return null;
  return <section className="page-section narrow-page" aria-labelledby="sign-title"><div className="demo-banner">TEST SIGNATURE · NOT A DIGITAL SIGNATURE CERTIFICATE</div><div className="page-heading"><div><p className="eyebrow">Test signing</p><h1 id="sign-title">The signature is bound to this package hash.</h1></div><Status label={state.signatureValid ? 'SIGNED · VERIFIED' : 'SIGNATURE INVALID'} tone={state.signatureValid ? 'durable' : 'attention'} /></div><div className="signature-register"><RecordDefinition label="Signer" value="Meet Vekaria, test signer" /><RecordDefinition label="Provider" value={signature.provider} /><RecordDefinition label="Package" value={`${pkg.packageId} · v${pkg.version}`} /><RecordDefinition label="Signed hash" value={signature.signedHash} mono /><RecordDefinition label="Signature ID" value={signature.signatureId} mono /><RecordDefinition label="Verification" value={state.signatureValid ? 'Ed25519 verification passed' : 'Does not match the current package input'} /><RecordDefinition label="Signed at" value={formatTime(signature.signedAt)} /></div><div className="boundary-note"><strong>This is not a DSC</strong><p>Production filing may require valid, registered Digital Signature Certificates and India PKI/CCA trust infrastructure. DARJ does not reproduce or replace it.</p></div><div className="action-bar"><div><strong>Custody happens before payment</strong><small>Retrying the same exact package cannot create a second Rasid.</small></div><div className="button-group"><button className="secondary" onClick={onEdit}>Edit as new version</button><button className="primary" onClick={onSubmit} disabled={busy === 'submit' || !online || !state.signatureValid}>{busy === 'submit' ? 'Submitting safely…' : !online ? 'Reconnect to submit' : 'Submit exact package'} <span aria-hidden="true">→</span></button></div></div></section>;
}

function RasidScreen({ state, busy, online, onPay, onStatus }: { state: AppState; busy: string; online: boolean; onPay: () => void; onStatus: () => void }) {
  const receipt = state.receipt;
  if (!receipt) return null;
  const paid = state.payment?.state === 'PAID';
  return <section className="page-section receipt-page" aria-labelledby="rasid-title"><div className="page-heading"><div><p className="eyebrow">Rasid · रसीद</p><h1 id="rasid-title">The exact package is in DARJ custody.</h1></div><a className="secondary receipt-download" href={`${API}?export=receipt`}>Download receipt PDF</a></div><article className="receipt"><header><Wordmark compact /><div><span>{receipt.receiptId}</span><small>INDEPENDENT MCA21 FILING WORKSPACE · SAMPLE DATA</small></div></header><div className="receipt-hero"><div className="custody-mark" aria-hidden="true">✓</div><div><p>RECEIVED INTO DARJ CUSTODY</p><time dateTime={receipt.receivedAt}>{formatReceiptTime(receipt.receivedAt)}</time></div></div><dl><RecordDefinition label="Receipt" value={receipt.receiptId} mono /><RecordDefinition label="Sample SRN" value={receipt.srn} mono /><RecordDefinition label="Package" value={`${receipt.packageId} · v${state.package?.version ?? 23}`} mono /><RecordDefinition label="Package hash" value={receipt.packageHash} mono /><RecordDefinition label="Form" value="MCA21 AOC-4 · FY 2025-26" /><RecordDefinition label="Company" value="Aster Components Private Limited" /></dl><p className="receipt-disclaimer">This receipt proves that this exact sample package entered DARJ custody at this time. The SRN is generated by the mocked adapter. Neither is an MCA21 acknowledgement, legal acceptance or proof of statutory timeliness.</p></article><div className="state-separation"><div><span className="status-mark durable" /><div><small>Custody</small><strong>RECEIVED</strong><p>Immutable Rasid recorded.</p></div></div><div><span className={`status-mark ${paid ? 'durable' : 'progress'}`} /><div><small>Payment</small><strong>{paid ? 'PAID · RECONCILED' : 'PENDING'}</strong><p>{paid ? 'Sample approval recorded on the server.' : 'Separate payment simulation.'}</p></div></div><div><span className="status-mark progress" /><div><small>Processing</small><strong>{state.processingJob?.state ?? (paid ? 'QUEUED' : 'WAITING FOR PAYMENT')}</strong><p>Receipt is not acceptance.</p></div></div></div>{!paid ? <div className="payment-panel"><div className="demo-banner">PAYMENT SIMULATION. NO MONEY OR PAYMENT DETAILS.</div><div className="payment-body"><div><p className="eyebrow">Illustrative fee</p><strong className="amount">₹6,000.00</strong><p>No card, UPI, bank, OTP or personal data is collected.</p></div><button className="primary" onClick={onPay} disabled={busy === 'payment' || !online}>{busy === 'payment' ? 'Reconciling…' : !online ? 'Reconnect to approve payment' : 'Approve simulated payment'} <span aria-hidden="true">→</span></button></div></div> : <div className="action-bar"><div><strong>Payment reconciled from the server</strong><small>PAID is not ACCEPTED. Processing remains separate.</small></div><button className="primary" onClick={onStatus}>Track processing <span aria-hidden="true">→</span></button></div>}</section>;
}

function StatusScreen({ state, accepted, busy, online, onPause, onResume }: { state: AppState; accepted: boolean; busy: string; online: boolean; onPause: () => void; onResume: () => void }) {
  const displayEvents = state.events.filter((event) => ['RECEIVED', 'PAID', 'PROCESSING_DELAYED', 'PROCESSING_RESUMED', 'PROCESSING', 'ACCEPTED'].includes(event.eventType));
  return <section className="page-section narrow-page" aria-labelledby="status-title"><div className="page-heading"><div><p className="eyebrow">Processing register</p><h1 id="status-title">{accepted ? 'ACCEPTED' : state.processorPaused ? 'PROCESSING DELAYED' : 'PAID · QUEUED'}</h1></div><Status label={accepted ? 'ACCEPTED' : state.processorPaused ? 'DELAYED' : 'QUEUED'} tone={accepted ? 'durable' : state.processorPaused ? 'attention' : 'progress'} /></div><p className="transport-note">Live status uses server events with an automatic 5-second polling fallback.</p>{state.processorPaused && <div className="delay-panel"><span className="status-mark attention" /><div><strong>Processing is delayed. Do not resubmit or pay again.</strong><p>The exact package remains RECEIVED and the sample payment remains PAID. The worker pause affects only processing.</p></div></div>}<ol className="event-register">{displayEvents.map((event) => <li key={event.seq} className={event.eventType.toLowerCase()}><span className={`event-icon ${eventTone(event.eventType)}`} aria-hidden="true">{eventGlyph(event.eventType)}</span><div><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time></div><p>{event.detail}</p><small>Actor: {event.actor}</small></div></li>)}</ol><div className="status-invariant"><strong>RECEIVED ≠ PAID ≠ PROCESSING ≠ ACCEPTED</strong><p>Each transition has its own durable event and meaning. Time passing alone never promotes custody into acceptance.</p></div>{!accepted && <div className="action-bar"><div><strong>{state.processorPaused ? 'The durable job can resume safely' : 'Demonstrate an outage before acceptance'}</strong><small>Job state: {state.processingJob?.state ?? 'Unavailable'} · attempt {state.processingJob?.attemptCount ?? 0}</small></div>{state.processorPaused ? <button className="primary" onClick={onResume} disabled={busy === 'processor' || !online}>{busy === 'processor' ? 'Resuming…' : !online ? 'Reconnect to resume' : 'Resume and finish processing'} <span aria-hidden="true">→</span></button> : <button className="secondary" onClick={onPause} disabled={busy === 'processor' || !online}>Pause processor</button>}</div>}</section>;
}

function RecoveryScreen({ state, onOpenMain }: { state: AppState; onOpenMain: () => void }) {
  const reviewer = readReviewerScenario();
  const items: Array<{ folio: string; reviewer?: ReviewerScenario; title: string; state: string; detail: string; tone: 'durable' | 'progress' | 'attention' }> = [
    { folio: 'R-01', reviewer: 'lost-response', title: 'Submission response loss', state: state.receipt ? 'RECOVERED' : 'READY', detail: 'The first response is lost after commit. DARJ reuses one persisted key and returns the same Rasid.', tone: state.receipt ? 'durable' : 'progress' },
    { folio: 'R-02', reviewer: 'lost-callback', title: 'Payment callback loss', state: state.payment?.state === 'PAID' ? 'RECONCILED' : 'READY', detail: 'The server approves the sample payment while the browser misses the callback. Reload never asks for a second payment.', tone: state.payment?.state === 'PAID' ? 'durable' : 'progress' },
    { folio: 'R-03', reviewer: 'paused', title: 'Processor outage', state: state.processorPaused ? 'DELAYED' : 'READY', detail: 'Pausing job claims preserves custody and payment. No resubmission is needed.', tone: state.processorPaused ? 'attention' : 'progress' },
    { folio: 'R-04', reviewer: 'kill-tab', title: 'Browser interruption', state: 'LOCAL FIRST', detail: 'A versioned local draft restores before network reconciliation and survives this review session.', tone: 'durable' },
  ];
  if (state.features.recoveryCase && state.features.resumableUploads) items.push({ folio: 'R-05', title: 'Resumable attachment upload', state: state.uploadSessions.some((session) => session.state === 'UPLOADING') ? 'PAUSED' : 'READY', detail: 'TUS resumes from the R2-backed, server-confirmed offset after a tab reload. Completed chunks are not sent again.', tone: state.uploadSessions.some((session) => session.state === 'UPLOADING') ? 'attention' : 'progress' });
  if (state.features.recoveryCase && state.features.masterDrift) items.push({ folio: 'R-06', title: 'Company master drift', state: state.master?.reviewState === 'REVIEW_REQUIRED' ? 'REVIEW REQUIRED' : state.master?.reviewState === 'ACCEPTED' ? 'REVIEWED' : 'READY', detail: 'A registered-office change is shown old versus new and blocks sealing until Meet explicitly accepts it or stops.', tone: state.master?.reviewState === 'REVIEW_REQUIRED' ? 'attention' : state.master?.reviewState === 'ACCEPTED' ? 'durable' : 'progress' });
  if (state.features.recoveryCase && state.features.correctionLineage) items.push({ folio: 'R-07', reviewer: 'lineage', title: 'Correction lineage', state: state.lineage.length ? 'V23 LINKED TO V24' : state.correction ? 'RESUBMISSION REQUIRED' : 'READY', detail: 'A board-report correction creates a linked v24 while the accepted v23 package and hash remain unchanged.', tone: state.lineage.length ? 'durable' : state.correction ? 'attention' : 'progress' });
  return <section className="page-section register-page" aria-labelledby="recovery-title"><div className="page-heading"><div><p className="eyebrow">Recovery register</p><h1 id="recovery-title">Failure should be recoverable, not ambiguous.</h1></div><p>This register includes every enabled P0 and P1 recovery path. Each control is isolated to this review session.</p></div><div className="recovery-list">{items.map((item) => <article key={item.folio} className={reviewer === item.reviewer ? 'reviewer-highlight' : ''}><span className="mono">{item.folio}</span><div><h2>{item.title}</h2><p>{item.detail}</p></div><Status label={reviewer === item.reviewer ? 'REVIEW THIS' : item.state} tone={reviewer === item.reviewer ? 'attention' : item.tone} /></article>)}</div><div className="action-bar"><div><strong>Run the full recovery path</strong><small>Use authenticated review controls to arm uploads, master drift, callbacks, processing pauses and correction lineage.</small></div><button className="primary" onClick={onOpenMain}>Open AOC-4 <span aria-hidden="true">→</span></button></div></section>;
}

function LineageScreen({ state, busy, onCreate, onSign }: { state: AppState; busy: string; onCreate: () => void; onSign: () => void }) {
  const correction = state.correction;
  return <section className="page-section narrow-page" aria-labelledby="lineage-title"><div className="page-heading"><div><p className="eyebrow">Package lineage</p><h1 id="lineage-title">Corrections preserve the original.</h1></div><p>Every child package points to its immutable parent. Changed paths are explicit and earlier hashes remain untouched.</p></div>{!correction && <div className="boundary-note"><strong>No correction requested</strong><p>Complete the accepted journey, then use recovery controls to return a board-report resubmission request.</p></div>}{correction?.state === 'REQUIRED' && <div className="correction-request"><div className="issue-head"><code>{correction.requestId}</code><Status label="RESUBMISSION REQUIRED" tone="attention" /></div><h2>{correction.summary}</h2><p>Source package: <code>{correction.sourcePackageId}</code>. DARJ will clone its filing data, replace only the board report and seal a linked v24.</p><button className="primary" disabled={busy === 'correction'} onClick={onCreate}>{busy === 'correction' ? 'Creating verified correction…' : 'Create corrected v24'} <span aria-hidden="true">→</span></button></div>}<div className="lineage-list">{state.lineage.map((record) => <article key={record.child.packageId}><div className="lineage-node"><small>Original package</small><strong>{record.parent.packageId} · v{record.parent.version}</strong><code>{shortHash(record.parent.hash)}</code><span>Immutable</span></div><div className="lineage-arrow" aria-hidden="true">→</div><div className="lineage-node current"><small>Correction package</small><strong>{record.child.packageId} · v{record.child.version}</strong><code>{shortHash(record.child.hash)}</code><span>Parent: {record.parent.packageId}</span></div><div className="lineage-change"><strong>One highlighted change</strong><p>{record.reason}</p><code>{record.changedPaths.join(', ')}</code></div></article>)}</div>{state.lineage.length > 0 && state.package?.packageId === correction?.childPackageId && !state.signatureValid && <div className="action-bar"><div><strong>v24 is sealed and linked to v23</strong><small>The corrected package now needs its own signature before resubmission.</small></div><button className="primary" onClick={onSign}>Open v24 Mohar <span aria-hidden="true">→</span></button></div>}</section>;
}

function DemoControlsScreen({ state, busy, onControl, onPause, onResume, onReset, onLineage }: { state: AppState; busy: string; onControl: (flag: string) => void; onPause: () => void; onResume: () => void; onReset: () => void; onLineage: () => void }) {
  const accepted = state.events.some((event) => event.eventType === 'ACCEPTED');
  return <section className="page-section narrow-page" aria-labelledby="controls-title"><div className="page-heading"><div><p className="eyebrow">Authenticated recovery controls</p><h1 id="controls-title">Reproduce recovery paths deterministically.</h1></div><Status label="REVIEW RUN ONLY" tone="attention" /></div><p className="scope-note">These controls apply only to this isolated review run. Only enabled, tested P1 controls are shown.</p><div className="control-register"><div><span className="mono">01</span><div><strong>Submission response loss</strong><p>Commit custody, then lose the browser response once.</p></div><button className="secondary" onClick={() => onControl('submission')}>Arm</button></div><div><span className="mono">02</span><div><strong>Payment callback loss</strong><p>Approve once on the server, then reconcile after the browser misses the callback.</p></div><button className="secondary" onClick={() => onControl('payment')}>Arm</button></div><div><span className="mono">03</span><div><strong>Transaction rollback</strong><p>Fail before commit and prove that no custody record or Rasid exists.</p></div><button className="secondary" onClick={() => onControl('transaction_failure')}>Arm once</button></div><div><span className="mono">04</span><div><strong>Serialization retry</strong><p>Force one retry before the atomic custody batch converges.</p></div><button className="secondary" onClick={() => onControl('serialization_once')}>Arm once</button></div><div><span className="mono">05</span><div><strong>Session expiry</strong><p>Expire this session so the next request must re-authenticate and restore IndexedDB work.</p></div><button className="secondary" onClick={() => onControl('expire_session')}>Expire</button></div><div><span className="mono">06</span><div><strong>Durable processor</strong><p>Pause or resume job claims without changing custody or payment.</p></div>{state.processorPaused ? <button className="primary" onClick={onResume}>Resume</button> : <button className="secondary" onClick={onPause}>Pause</button>}</div>{state.features.recoveryCase && state.features.resumableUploads && <div><span className="mono">07</span><div><strong>Resumable upload interruption</strong><p>Pause after the next 6 MB chunk is safely stored, then reload and select the same PDF to resume.</p></div><button className="secondary" onClick={() => onControl('upload_pause')} disabled={state.uploadPauseArmed}>Arm pause</button></div>}{state.features.recoveryCase && state.features.masterDrift && <div><span className="mono">08</span><div><strong>Company master drift</strong><p>Change the current registered office after the draft pinned snapshot 7.</p></div><button className="secondary" onClick={() => onControl('master_drift')} disabled={state.master?.reviewState !== 'CURRENT'}>Change master</button></div>}{state.features.recoveryCase && state.features.correctionLineage && <div><span className="mono">09</span><div><strong>Board report resubmission</strong><p>Return the accepted package for one correction while preserving its original hash.</p></div>{state.correction ? <button className="secondary" onClick={onLineage}>View lineage</button> : <button className="secondary" onClick={() => onControl('correction_request')} disabled={!accepted}>Return package</button>}</div>}</div><div className="action-bar"><div><strong>Reset is limited to this run</strong><small>It aborts partial uploads and deletes and reseeds only this run’s D1 rows and R2 prefix.</small></div><button className="secondary" disabled={busy === 'reset'} onClick={onReset}>Reset review workspace</button></div></section>;
}

function PublicInformationScreen({ screen, theme, onTheme, onNavigate }: { screen: 'evidence' | 'limitations'; theme: Theme; onTheme: () => void; onNavigate: (screen: Screen) => void }) {
  return <div className="public-shell"><div className="india-rule" aria-hidden="true"><span /><span /><span /></div><button className="registry-disclaimer" onClick={() => onNavigate('limitations')}>Synthetic data · Independent prototype · Not affiliated with the Ministry of Corporate Affairs</button><header className="registry-identity-header"><button className="registry-brand-button" onClick={() => onNavigate('login')} aria-label="MCA21 Corporate Services home"><RegistryBrand /></button><nav className="registry-utilities" aria-label="Public information navigation"><button onClick={() => onNavigate('login')}>Home</button><button onClick={() => onNavigate('reviewer')}>Reviewer Guide</button><ThemeToggle theme={theme} onTheme={onTheme} /><button className="utility-signin" onClick={() => onNavigate('login')}>Sign In</button></nav></header><main id="main-content" className="app-main">{screen === 'evidence' ? <EvidenceScreen /> : <LimitationsScreen />}</main><footer className="registry-footer"><div><Wordmark compact /><p>{screen === 'evidence' ? 'Sources and technical standards behind the filing reliability model.' : 'Product boundaries, data sources and non-affiliation record.'}</p></div><nav aria-label="Public information footer"><button onClick={() => onNavigate('reviewer')}>Reviewer Guide</button><button onClick={() => onNavigate('evidence')}>Evidence</button><button onClick={() => onNavigate('limitations')}>Limitations</button><button onClick={() => onNavigate('login')}>Home</button></nav><p>DARJ does not connect to MCA21 or make statutory filings.</p></footer></div>;
}

function EvidenceScreen() {
  const sources = [
    ['Builder brief', 'Challenge scope and judging criteria', 'https://buildwhatmovesindia.com/brief'],
    ['MCA current sitemap', 'Current official information and service category structure', 'https://www.mca.gov.in/content/mca/global/en/sitemap.html'],
    ['MCA website FAQs', 'Official homepage cards, frequently used services and access guidance', 'https://www.mca.gov.in/content/dam/mca/documents/WebsiteFAQ.pdf'],
    ['MCA and PIB, 10 Feb 2026', 'MCA filing volumes and helpdesk data', 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2226017&lang=1&reg=3'],
    ['Lok Sabha Question 4954', 'MCA AOC-4 and MGT-7/7A filing counts', 'https://sansad.in/getFile/loksabhaquestions/annex/187/AU4954_vFAQV0.pdf?source=pqals'],
    ['MCA and PIB, 3 Feb 2025', 'Existing MCA21 V3 capabilities, validation, status and MFA', 'https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=2099226&lang=2&reg=48'],
    ['ICSI representation to MCA, 6 May 2026', 'Reported MCA21 draft, upload and generic error problems', 'https://www.icsi.edu/media/webmodules/GCL/Functioning_of_MCA_21_V3_Portal_Issues_and_Challenges_faced_by_stakeholders.pdf'],
    ['ICSI representation to MCA, 12 Jun 2026', 'Reported MCA data centre incident and recovery difficulties', 'https://www.icsi.edu/media/webmodules/GCL/Request_for_relief_to_the_stakeholders_facing_practical_difficulties_due_to_fire_incidence_at_MCA_Data_Centre_site.pdf'],
    ['ICSI representation to MCA, 20 Dec 2025', 'Reported MCA21 processing, SRN, upload and timeout problems', 'https://www.icsi.edu/media/webmodules/DCL/Functioning_of_MCA21_V3_Portal_Issues_and_Challenges_faced_by_stakeholders_20.12.2025.pdf'],
    ['RFC 8785', 'JSON Canonicalization Scheme', 'https://www.rfc-editor.org/rfc/rfc8785'],
    ['Controller of Certifying Authorities', 'India PKI and Certifying Authorities', 'https://cca.gov.in/ca_certificates.html'],
  ];
  return <section className="page-section narrow-page" aria-labelledby="evidence-title"><div className="page-heading"><div><p className="eyebrow">MCA21 evidence register</p><h1 id="evidence-title">Why MCA21 filing reliability matters</h1></div><p>MCA and PIB releases establish filing volumes, dates and existing MCA21 V3 capability. ICSI representations to MCA document reported problems with drafts, uploads, SRNs, timeouts and recovery.</p></div><div className="evidence-list">{sources.map(([name, detail, url], index) => <a href={url} target="_blank" rel="noreferrer" key={name}><span className="mono">{String(index + 1).padStart(2, '0')}</span><div><strong>{name}</strong><p>{detail}</p></div><span aria-hidden="true">↗</span></a>)}</div><div className="boundary-note"><strong>Balanced claim</strong><p>MCA21 V3 has substantial existing capability. The cited stakeholder representations document specific reliability and recovery problems, but they do not prove that every MCA21 user experiences every reported issue.</p></div></section>;
}

function LimitationsScreen() {
  const limitations = [
    'DARJ is an independent workspace for MCA21 statutory filing workflows. It is not affiliated with MCA, does not connect to MCA21, and does not make real statutory filings.',
    'RECEIVED means this exact sample package is in DARJ custody. It is not an MCA21 acknowledgement, legal filing or acceptance.',
    'A DARJ receipt does not determine statutory timeliness. That is an authority and legal-policy question outside this build.',
    'DARJ does not replace a Digital Signature Certificate. The workspace uses a test signing adapter. Production use would require the applicable MCA and India PKI/CCA trust infrastructure.',
    'DARJ does not decide legal compliance or give legal advice. Its rules check only deterministic fields and deterministic conditions.',
    'MCA21 V3 already provides web forms, real-time validation, saved drafts, status tracking, helpdesk capabilities, MFA, STP for relevant forms, and an offline utility for selected annual forms.',
    'Every error code begins DARJ_. No official MCA error code is claimed or reproduced.',
    'All payments are simulated. DARJ collects no payment credentials, OTPs, Aadhaar, PAN, real CIN, or other sensitive personal data.',
    'AOC-4 is implemented end to end. MGT-7, DIR-3 KYC, DIR-12 and CHG-1 support durable guided intake; the wider service directory is a reference catalogue.',
    'Reported MCA21 difficulties are attributed to the cited ICSI representations and are not presented as universal user outcomes.',
    'The current functional interface is in English. Devanagari is used only for the four product terms दर्ज, जाँच, मुहर and रसीद. A full Hindi or regional-language localisation has not been implemented.',
  ];
  return <section className="page-section narrow-page" aria-labelledby="limitations-title"><div className="page-heading"><div><p className="eyebrow">Product boundary</p><h1 id="limitations-title">What this workspace does not do</h1></div></div><ol className="limitations-list">{limitations.map((item, index) => <li key={item}><span className="mono">{String(index + 1).padStart(2, '0')}</span><p>{item}</p></li>)}</ol></section>;
}

function ErrorPanel({ error, toast = false, onDismiss }: { error: DarjError; toast?: boolean; onDismiss?: () => void }) {
  return <div id="darj-error" className={`error-panel ${toast ? 'error-toast' : ''}`} role="alert" aria-live="assertive" tabIndex={-1}><div><code>{error.code}</code><span className="error-panel-actions"><Status label={error.retryable ? 'RETRY SAFE' : 'ACTION REQUIRED'} tone="attention" />{onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss message">×</button>}</span></div><strong>{error.summary}</strong><p>{error.detail}</p><small>Stage: {error.stage} · Correlation: {error.correlationId}</small></div>;
}

function Status({ label, tone }: { label: string; tone: 'durable' | 'progress' | 'attention' }) {
  return <span className={`status ${tone}`}><i className={`status-mark ${tone}`} />{label}</span>;
}

function RecordLine({ label, value, tone }: { label: string; value: string; tone?: 'durable' }) {
  return <div className="record-line"><span>{label}</span><strong>{tone && <i className="status-mark durable" />}{value}</strong></div>;
}

function RecordDefinition({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : ''}>{value}</dd></div>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="text-button" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{copied ? 'Copied' : 'Copy full hash'}</button>;
}

function journeyLabel(state: AppState) {
  if (state.correction?.state === 'REQUIRED') return 'RESUBMISSION REQUIRED';
  if (state.lineage.length && state.package?.packageId === state.correction?.childPackageId) {
    if (state.processingJob?.state === 'ACCEPTED') return 'CORRECTED V24 · ACCEPTED';
    if (state.payment?.state === 'PAID') return 'CORRECTED V24 · PAID · QUEUED';
    if (state.receipt) return 'CORRECTED V24 · RECEIVED';
    if (state.signatureValid) return 'CORRECTED V24 · SIGNED';
    return 'CORRECTED V24 · SIGNATURE REQUIRED';
  }
  if (state.events.some((event) => event.eventType === 'ACCEPTED')) return 'ACCEPTED';
  if (state.processorPaused) return 'PROCESSING DELAYED';
  if (state.payment?.state === 'PAID') return 'PAID · QUEUED';
  if (state.receipt) return 'RECEIVED · PAYMENT PENDING';
  if (state.signature && !state.signatureValid) return 'SIGNATURE INVALID · NEW VERSION REQUIRED';
  if (state.signature) return 'SIGNED';
  if (state.package) return 'SEALED';
  return 'EDITING · LOCALLY DURABLE';
}

function resumeScreen(state: AppState): Screen {
  if (state.correction?.state === 'REQUIRED') return 'lineage';
  if (state.correction?.state === 'COMPLETED' && state.package?.packageId === state.correction.childPackageId) {
    if (state.processingJob?.state === 'ACCEPTED' || state.payment?.state === 'PAID') return 'status';
    if (state.receipt) return 'rasid';
    if (state.signatureValid) return 'sign';
    return 'lineage';
  }
  if (state.events.some((event) => event.eventType === 'ACCEPTED') || state.payment?.state === 'PAID') return 'status';
  if (state.receipt) return 'rasid';
  if (state.signature && state.signatureValid) return 'sign';
  if (state.package && state.packageCurrent) return 'mohar';
  return 'prepare';
}

function eventTone(type: string) { return type === 'PROCESSING_DELAYED' ? 'attention' : type === 'PROCESSING' || type === 'PROCESSING_RESUMED' ? 'progress' : 'durable'; }
function eventGlyph(type: string) { if (type === 'PROCESSING_DELAYED') return '!'; if (type === 'PROCESSING') return '↻'; if (type === 'ACCEPTED') return '✓'; if (type === 'PAID') return '₹'; return '◇'; }
function labelSlot(slot: string) { return ({ financialStatements: 'Financial statements', auditorReport: 'Auditor’s report', boardReport: 'Board report' } as Record<string, string>)[slot] ?? slot; }
function shortHash(hash: string) { return `${hash.slice(0, 9)}…${hash.slice(-7)}`; }
function formatTime(value?: string | null) { if (!value) return 'Not available'; return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(value)) + ' IST'; }
function formatBytes(bytes: number) { if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${bytes} bytes`; }
function formatReceiptTime(value: string) { return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date(value)).toUpperCase() + ' IST'; }
function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function safeReadLocalDraft(caseId: string): Promise<LocalDraft | null> {
  try { return await localGet<LocalDraft>(`draft:${caseId}`); }
  catch { return null; }
}

async function writeLocalDraft(caseId: string, runId: string, version: number, form: FormShape, focusedField?: string) {
  return localPut(`draft:${caseId}`, { runId, version, form, savedAt: new Date().toISOString(), focusedField } satisfies LocalDraft);
}

async function clearLocalDraft(caseId: string) {
  await Promise.all([
    localDelete(`draft:${caseId}`),
    localDelete(`idempotency:${caseId}`),
    localDelete(`idempotency:payment:${caseId}`),
  ]).catch(() => undefined);
}

async function getOrCreateIdempotencyKey(caseId: string) {
  const key = `idempotency:${caseId}`;
  const existing = await localGet<string>(key);
  if (existing) return existing;
  const next = crypto.randomUUID(); await localPut(key, next); return next;
}

function isValidImportedForm(value: unknown): value is FormShape {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['registeredOffice', 'financialYear', 'agmDate', 'boardMeetings', 'revenue', 'expenses', 'netProfit', 'directorName'].every((key) => typeof record[key] === 'string');
}

function readBrowserCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const part = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

type TusStoredUpload = { size: number | null; metadata: Record<string, string>; creationTime: string; urlStorageKey: string; uploadUrl: string | null; parallelUploadUrls: string[] | null; fingerprint: string };

class IndexedDbTusUrlStorage {
  private readonly key = 'tus:url-storage';
  async findAllUploads() { return (await localGet<TusStoredUpload[]>(this.key)) ?? []; }
  async findUploadsByFingerprint(fingerprint: string) { return (await this.findAllUploads()).filter((upload) => upload.fingerprint === fingerprint); }
  async removeUpload(urlStorageKey: string) { await localPut(this.key, (await this.findAllUploads()).filter((upload) => upload.urlStorageKey !== urlStorageKey)); }
  async addUpload(fingerprint: string, upload: Omit<TusStoredUpload, 'fingerprint'>) {
    const urlStorageKey = upload.urlStorageKey || `tus:${crypto.randomUUID()}`;
    const uploads = (await this.findAllUploads()).filter((entry) => entry.urlStorageKey !== urlStorageKey);
    uploads.push({ ...upload, urlStorageKey, fingerprint });
    await localPut(this.key, uploads);
    return urlStorageKey;
  }
}

function fieldLabel(path: string) {
  return ({ registeredOffice: 'Registered office', financialYear: 'Financial year', agmDate: 'AGM date', boardMeetings: 'Board meetings', revenue: 'Revenue', expenses: 'Expenses', netProfit: 'Net profit', directorName: 'Director name' } as Record<string, string>)[path] ?? path;
}

function screenFromPath(pathname: string): Screen {
  if (pathname === '/reviewer') return 'reviewer';
  if (pathname === '/filings/new') return 'newFiling';
  if (pathname.includes('/studio')) return 'studio';
  if (pathname === '/services') return 'services';
  if (pathname === '/company') return 'company';
  if (pathname === '/documents') return 'documents';
  if (pathname === '/payments') return 'payments';
  if (pathname === '/guidance') return 'guidance';
  if (pathname === '/about') return 'about';
  if (pathname === '/evidence') return 'evidence';
  if (pathname === '/limitations') return 'limitations';
  if (pathname === '/demo-controls') return 'demoControls';
  if (pathname.includes('/prepare')) return 'prepare';
  if (pathname.includes('/jaanch')) return 'jaanch';
  if (pathname.includes('/mohar')) return 'mohar';
  if (pathname.includes('/sign')) return 'sign';
  if (pathname.includes('/rasid/')) return 'rasid';
  if (pathname.includes('/status')) return 'status';
  if (pathname.includes('/lineage')) return 'lineage';
  if (pathname === '/recovery') return 'recovery';
  if (pathname === '/filings') return 'filings';
  return 'login';
}

function pathForScreen(screen: Screen, caseId = 'DARJ-DEMO-AOC4-01') {
  return ({
    login: '/login', reviewer: '/reviewer', filings: '/filings', studio: `/filings/${caseId}/studio`, newFiling: '/filings/new', services: '/services', company: '/company', documents: '/documents', payments: '/payments', guidance: '/guidance', about: '/about', prepare: `/filings/${caseId}/prepare`, jaanch: `/filings/${caseId}/jaanch`,
    mohar: `/filings/${caseId}/mohar`, sign: `/filings/${caseId}/sign`, rasid: `/filings/${caseId}/rasid/DARJ-RASID-8129`,
    status: `/filings/${caseId}/status`, lineage: `/filings/${caseId}/lineage`, recovery: '/recovery', evidence: '/evidence', limitations: '/limitations', demoControls: '/demo-controls',
  } satisfies Record<Screen, string>)[screen];
}

type ReviewerScenario = 'documents' | 'kill-tab' | 'lost-response' | 'lost-callback' | 'paused' | 'lineage';

function readReviewerScenario(): ReviewerScenario | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('review');
  return value === 'documents' || value === 'kill-tab' || value === 'lost-response' || value === 'lost-callback' || value === 'paused' || value === 'lineage' ? value : null;
}

function reviewerDestination(scenario: ReviewerScenario): Screen {
  if (scenario === 'documents') return 'studio';
  if (scenario === 'kill-tab') return 'prepare';
  if (scenario === 'lineage') return 'lineage';
  return 'recovery';
}

function reviewerPath(scenario: ReviewerScenario, caseId: string) {
  if (scenario === 'documents') return `/filings/${caseId}/studio?review=${scenario}`;
  if (scenario === 'kill-tab') return `/filings/${caseId}/prepare?review=${scenario}`;
  if (scenario === 'lineage') return `/filings/${caseId}/lineage?review=${scenario}`;
  return `/recovery?review=${scenario}`;
}

function reviewerNotice(scenario: ReviewerScenario) {
  return ({
    documents: 'Start here · Open a prepared AOC-4 package, inspect source evidence and record a professional review decision.',
    'kill-tab': 'Reviewer path 1 of 5 · Edit a field, close the tab and reopen this address to see local-first recovery.',
    'lost-response': 'Reviewer path 2 of 5 · Submission response-loss recovery is highlighted below.',
    'lost-callback': 'Reviewer path 3 of 5 · Payment callback reconciliation is highlighted below.',
    paused: 'Reviewer path 4 of 5 · Durable processor custody is highlighted below.',
    lineage: 'Reviewer path 5 of 5 · Correction lineage preserves the original package and hash.',
  } satisfies Record<ReviewerScenario, string>)[scenario];
}
