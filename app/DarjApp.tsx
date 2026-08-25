'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as tus from 'tus-js-client';
import { localDelete, localGet, localPut, localStorageAvailable } from '@/lib/local-db';

type Screen = 'login' | 'filings' | 'prepare' | 'jaanch' | 'mohar' | 'sign' | 'rasid' | 'status' | 'recovery' | 'lineage' | 'evidence' | 'limitations' | 'demoControls';
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
type Attachment = { slot: string; filename: string; bytes: number; mime: string; sha256: string; verifiedAt: string };
type PackageRecord = { packageId: string; version: number; hash: string; sealedAt: string; canonicalPayload: string };
type SignatureRecord = { signatureId: string; packageId: string; provider: string; signedHash: string; signatureValue: string; signedAt: string };
type ReceiptRecord = { receiptId: string; custodyId: string; packageId: string; packageHash: string; receivedAt: string; replayed?: boolean };
type PaymentRecord = { paymentId: string; state: string; amountPaise: number; reconciliationReference: string; updatedAt: string };
type EventRecord = { seq: number; eventType: string; actor: string; detail: string; occurredAt: string };
type UploadSession = { uploadId: string; slot: string; filename: string; expectedBytes: number; confirmedOffset: number; clientSha256: string; fingerprint: string; state: string; updatedAt: string; expiresAt: string; uploadUrl: string };
type MasterState = { pinnedVersion: number; pinnedOffice: string; currentVersion: number; currentOffice: string; source: string; reviewState: string; detectedAt: string | null; reviewedAt: string | null };
type CorrectionState = { requestId: string; sourcePackageId: string; documentSlot: string; summary: string; state: string; childPackageId: string | null; createdAt: string; resolvedAt: string | null };
type LineageRecord = { parent: PackageRecord; child: PackageRecord; reason: string; changedPaths: string[]; createdAt: string };
type FeatureFlags = { resumableUploads: boolean; masterDrift: boolean; correctionLineage: boolean; recoveryCase: boolean };
type UploadProgress = { filename: string; offset: number; total: number; state: 'HASHING' | 'UPLOADING' | 'PAUSED' | 'ERROR' };
type CheckRecord = {
  code: string; stage: string; fieldPath: string | null; documentSlot: string | null;
  blocking: boolean; retryable: boolean; status: string; summary: string; detail: string;
  ruleVersion: string; expected?: string; actual?: string;
};
type AppState = {
  runId: string; caseId: string;
  draft: { version: number; form: FormShape; savedAt: string } | null;
  attachments: Attachment[]; package: PackageRecord | null; signature: SignatureRecord | null;
  packageCurrent: boolean; signatureValid: boolean;
  receipt: ReceiptRecord | null; payment: PaymentRecord | null;
  processingJob: { jobId: string; state: string; attemptCount: number } | null;
  processorPaused: boolean; events: EventRecord[];
  uploadPauseArmed: boolean; uploadSessions: UploadSession[]; master: MasterState | null;
  correction: CorrectionState | null; lineage: LineageRecord[]; features: FeatureFlags;
};
type DarjError = {
  code: string; stage: string; summary: string; detail: string; retryable: boolean; correlationId: string;
  serverDraft?: { version: number; form: FormShape; savedAt: string };
  changedPaths?: string[];
};
type LocalDraft = { runId?: string; version: number; form: FormShape; savedAt: string; focusedField?: string };
type DraftConflict = { local: FormShape; server: { version: number; form: FormShape; savedAt: string }; changedPaths: string[] };

const API = '/api/darj';

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
  const [uploadProgress, setUploadProgress] = useState<Record<string, UploadProgress>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeUploads = useRef(new Map<string, tus.Upload>());

  useEffect(() => {
    queueMicrotask(() => {
      setScreen(screenFromPath(window.location.pathname));
      setHydrated(true);
    });
  }, []);

  const refresh = useCallback(async () => {
    let response: Response;
    try { response = await fetch(API, { cache: 'no-store' }); }
    catch { return null; }
    if (!response.ok) {
      if (response.status === 401) {
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
      const ready = await localStorageAvailable();
      setStorageReady(ready);
      const local = ready ? await safeReadLocalDraft('DARJ-DEMO-AOC4-01') : null;
      setHasLocalRecovery(Boolean(local));
      const restored = await refresh();
      if (restored) setScreen(screenFromPath(window.location.pathname) === 'login' ? 'filings' : screenFromPath(window.location.pathname));
    })();
  }, [refresh]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

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
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
        setSessionExpired(true);
        setHasLocalRecovery(Boolean(await safeReadLocalDraft(state?.caseId ?? 'DARJ-DEMO-AOC4-01')));
        navigate('login');
      }
      throw Object.assign(new Error(payload.error?.summary ?? 'DARJ request failed'), { darj: payload.error, status: response.status });
    }
    setError(null);
    return payload;
  }

  async function login() {
    setBusy('login');
    try {
      const recovery = await safeReadLocalDraft('DARJ-DEMO-AOC4-01');
      const next = await post('login', { email: 'meet@darj.demo', password: 'darj2026' }) as unknown as AppState;
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
      navigate(recovery && sessionExpired ? 'prepare' : 'filings');
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
      setError({ code: 'DARJ_LOCAL_STORAGE_UNAVAILABLE', stage: 'DRAFT', summary: 'DARJ cannot confirm a recoverable local save.', detail: 'Further edits are blocked. Export the current demo draft before changing browser storage settings.', retryable: false, correlationId: 'DARJ-CORR-LOCAL' });
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
    setNotice('Approving demo payment…');
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
      setNotice('ACCEPTED. Demo processor outcome recorded.');
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
        master_drift: 'Demo company master changed. Sealing is blocked until Meet reviews the old and current addresses.',
        correction_request: 'Board report resubmission is now required. The original package remains unchanged.',
      };
      setNotice(messages[flag] ?? `${flag.replaceAll('_', ' ')} armed for this demo run`);
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
    setNotice('Hashing the selected demo PDF before upload…');
    try {
      if (!/^DARJ-[A-Za-z0-9._ -]+\.pdf$/u.test(file.name) || file.type !== 'application/pdf') throw new Error('Only demo PDF files with names starting DARJ are accepted.');
      if (file.size > 12 * 1024 * 1024) throw new Error('This file exceeds DARJ’s 12 MB demo limit.');
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
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => { if (!settled) { settled = true; callback(); } };
        const upload = new tus.Upload(file, {
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
    link.href = url; link.download = 'DARJ-demo-draft.json'; link.click();
    URL.revokeObjectURL(url);
  }

  async function importDraft(file: File) {
    if (!state) return;
    try {
      const parsed = JSON.parse(await file.text()) as { schema?: unknown; caseId?: unknown; form?: unknown };
      if (parsed.schema !== 'DARJ-DRAFT-1' || parsed.caseId !== state.caseId || !isValidImportedForm(parsed.form)) throw new Error('The selected JSON is not a valid DARJ demo draft export.');
      if (!window.confirm('Replace the working fields with this validated demo draft? A new immutable draft version will be created.')) return;
      setForm(parsed.form);
      await saveDraft(parsed.form, state.draft?.version ?? 17);
      setNotice('Validated demo draft imported as a new version');
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

  if (screen === 'evidence' || screen === 'limitations') return <PublicInformationScreen screen={screen} onNavigate={navigate} />;
  if (screen === 'login' || !state || !form) return <LoginScreen hydrated={hydrated} busy={busy === 'login'} onEnter={() => void login()} onLimitations={() => navigate('limitations')} error={error} sessionExpired={sessionExpired} hasLocalRecovery={hasLocalRecovery} storageReady={storageReady} />;

  return (
    <div className="app-shell">
      <Disclosure onOpen={() => navigate('limitations')} />
      <AppHeader screen={screen} state={state} onNavigate={navigate} onSignOut={() => void signOut()} signingOut={busy === 'logout'} />
      <main id="main-content" className="app-main">
        {notice && <div className="notice" role="status" aria-live="polite"><span className="status-mark progress" />{notice}</div>}
        {error && <ErrorPanel error={error} />}

        {screen === 'filings' && <FilingsScreen state={state} onPrepare={() => navigate(resumeScreen(state))} onRecovery={() => navigate('recovery')} />}
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
        {screen === 'lineage' && (state.features.correctionLineage ? <LineageScreen state={state} busy={busy} onCreate={() => void createCorrection()} onSign={() => { if (state.package?.packageId === state.correction?.childPackageId) navigate('mohar'); }} /> : <FilingsScreen state={state} onPrepare={() => navigate(resumeScreen(state))} onRecovery={() => navigate('recovery')} />)}
        {screen === 'demoControls' && <DemoControlsScreen state={state} busy={busy} onControl={(flag) => void runControl(flag)} onPause={() => void pauseProcessor()} onResume={() => void resumeProcessor()} onReset={() => void resetDemo()} onLineage={() => navigate('lineage')} />}
      </main>
      <footer className="app-footer">
        <span>DARJ / दर्ज. Independent MCA21 filing prototype.</span>
        <nav aria-label="Footer"><button onClick={() => navigate('evidence')}>Evidence</button><button onClick={() => navigate('limitations')}>Limitations</button>{state.features.correctionLineage && <button onClick={() => navigate('lineage')}>Package lineage</button>}<button onClick={() => void resetDemo()} disabled={busy === 'reset'}>Reset this demo run</button><button onClick={() => void signOut()} disabled={busy === 'logout'}>Sign out</button></nav>
      </footer>
    </div>
  );
}

function Disclosure({ onOpen }: { onOpen: () => void }) {
  return <button className="prototype-strip disclosure-button" onClick={onOpen}>INDEPENDENT PROTOTYPE FOR MCA21 FILINGS. DEMO DATA. NOT AFFILIATED WITH MCA.</button>;
}

function LoginScreen({ hydrated, busy, onEnter, onLimitations, error, sessionExpired, hasLocalRecovery, storageReady }: { hydrated: boolean; busy: boolean; onEnter: () => void; onLimitations: () => void; error: DarjError | null; sessionExpired: boolean; hasLocalRecovery: boolean; storageReady: boolean }) {
  return (
    <main className="login-shell">
      <button className="prototype-strip disclosure-button" onClick={onLimitations}>INDEPENDENT PROTOTYPE FOR MCA21 FILINGS. DEMO DATA. NOT AFFILIATED WITH MCA.</button>
      <header className="login-header">
        <Wordmark />
        <div className="login-header-meta" aria-label="Prototype context">
          <span>Filing reliability</span>
          <span>Round 1 build</span>
          <span>28 Aug 2026</span>
        </div>
      </header>

      <section className="login-hero" aria-labelledby="login-title">
        <div className="login-intro">
          <p className="eyebrow">AN INDEPENDENT PROTOTYPE FOR MCA21 STATUTORY FILINGS</p>
          <h1 id="login-title">A filing deadline should not depend on a <em>browser session surviving.</em></h1>
          <p className="login-deck">DARJ protects one AOC-4 demo filing from first draft to final outcome. Retries, payments and processor delays never blur what happened.</p>
          <blockquote>“One exact package. One durable receipt.”</blockquote>
        </div>

        <aside className="login-access" aria-label="Reviewer access">
          <div className="access-heading">
            <p className="register-folio">REVIEWER ACCESS / 00</p>
            <span className="access-status"><i /> Ready</span>
          </div>
          <h2>Open Meet’s filing</h2>
          <p className="access-copy">Enter an isolated MCA21 AOC-4 demo case. No OTP, installation or real data.</p>
          {sessionExpired && hasLocalRecovery && <div className="recovery-callout" role="status"><strong>Local work is safe</strong><p>Re-enter the demo to resume the same filing and last focused field.</p></div>}
          {!storageReady && <div className="error-panel" role="alert"><strong>Local storage is unavailable</strong><p>DARJ will not accept edits until browser storage is available. You may still inspect the public evidence and limitations pages.</p></div>}
          {error && <ErrorPanel error={error} />}
          <div className="login-form">
            <div className="credential-field">
              <label htmlFor="email">Demo email</label>
              <input id="email" value="meet@darj.demo" readOnly />
            </div>
            <div className="credential-field">
              <label htmlFor="password">Demo password</label>
              <input id="password" value="darj2026" readOnly />
            </div>
            <button type="button" onClick={onEnter} disabled={!hydrated || busy}>
              <span>{!hydrated || busy ? 'Preparing your filing room…' : 'Enter Meet’s filing'}</span>
              <span className="button-arrow" aria-hidden="true">↗</span>
            </button>
          </div>
          <p className="persona-note"><span>60-second path</span> Draft → Jaanch → Mohar → Rasid</p>
        </aside>
      </section>

      <section className="login-register" aria-label="Prototype principles">
        <div className="register-lead"><span>DARJ PRINCIPLES</span><strong>Clarity under failure</strong></div>
        <div className="register-row"><span>01 / Draft</span><strong>Saved before sync</strong><small>Your work survives the tab.</small></div>
        <div className="register-row"><span>02 / Submit</span><strong>Retry-safe</strong><small>A lost response cannot duplicate custody.</small></div>
        <div className="register-row"><span>03 / Rasid</span><strong>Custody, not acceptance</strong><small>Every state says exactly what it means.</small></div>
      </section>

      <div className="prototype-note"><strong>Independent by design.</strong><p>DARJ is an independent MCA21 filing prototype. It does not connect to MCA21 or represent MCA. Every record in this demo is generated for review.</p></div>
    </main>
  );
}

function AppHeader({ screen, state, onNavigate, onSignOut, signingOut }: { screen: Screen; state: AppState; onNavigate: (screen: Screen) => void; onSignOut: () => void; signingOut: boolean }) {
  return (
    <header className="app-header">
      <button className="brand-button" onClick={() => onNavigate('filings')} aria-label="DARJ filing register"><Wordmark compact /></button>
      <div className="header-context"><span className="mono">FOLIO 01</span><strong>Aster Components Private Limited</strong><span>MCA21 AOC-4 demo. FY 2025-26</span></div>
      <div className="header-state"><span className="status-mark durable" /><div><small>Current record</small><strong>{journeyLabel(state)}</strong></div></div>
      <div className="header-actions">{screen !== 'filings' && <button className="text-button filing-register-link" onClick={() => onNavigate('filings')}>Filing register</button>}<button className="text-button signout-button" onClick={onSignOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div>
    </header>
  );
}

function Wordmark({ compact = false }: { compact?: boolean }) {
  return <div className={`wordmark ${compact ? 'compact' : ''}`} aria-label="DARJ, दर्ज"><span>DARJ</span><span className="wordmark-divider" aria-hidden="true" /><span lang="hi">दर्ज</span></div>;
}

function FilingsScreen({ state, onPrepare, onRecovery }: { state: AppState; onPrepare: () => void; onRecovery: () => void }) {
  return (
    <section className="page-section register-page" aria-labelledby="filings-title">
      <div className="page-heading"><div><p className="eyebrow">MCA21 filing register</p><h1 id="filings-title">Two cases. One exact record at a time.</h1></div><p>Each browser session receives an isolated demo run. Nothing here is shared with another reviewer.</p></div>
      <div className="register-table" aria-label="MCA21 demo filing cases">
        <div className="register-table-head"><span>Folio</span><span>Company</span><span>Form / FY</span><span>Due state</span><span>Record state</span><span>Action</span></div>
        <div className="filing-row">
          <span data-label="Folio" className="mono">01 / A</span>
          <span data-label="Company"><strong>Aster Components Private Limited</strong><small>Demo company record 000117</small></span>
          <span data-label="Form / FY"><strong>AOC-4 prototype</strong><small>FY 2025-26</small></span>
          <span data-label="Due state"><strong>Due today</strong><small>28 Aug 2026 · 11:59 PM IST</small></span>
          <span data-label="Record state"><Status label={journeyLabel(state)} tone={state.receipt ? 'durable' : 'progress'} /><small>Draft v{state.draft?.version ?? 17} · {state.attachments.length} verified PDFs</small></span>
          <span data-label="Action"><button className="primary small" onClick={onPrepare}>{state.receipt ? 'View record' : 'Continue filing'} <span aria-hidden="true">→</span></button></span>
        </div>
        <div className="filing-row">
          <span data-label="Folio" className="mono">02 / B</span>
          <span data-label="Company"><strong>Aster Components Private Limited</strong><small>Recovery examples</small></span>
          <span data-label="Form / FY"><strong>AOC-4 prototype</strong><small>Deterministic recovery</small></span>
          <span data-label="Due state"><strong>Exploration case</strong><small>No statutory meaning</small></span>
          <span data-label="Record state"><Status label="RECOVERY READY" tone="progress" /><small>Retry, callback, queue</small></span>
          <span data-label="Action"><button className="secondary small" onClick={onRecovery}>Try recovery</button></span>
        </div>
      </div>
      <div className="register-legend"><strong>What the states mean</strong><span><i className="status-mark durable" /> Durable in DARJ</span><span><i className="status-mark progress" /> In progress</span><span><i className="status-mark attention" /> Needs attention</span></div>
    </section>
  );
}

function PrepareScreen({ state, form, saveState, busy, online, storageReady, conflict, uploadProgress, onChange, onJaanch, onResolveConflict, onUpload, onPauseUpload, onMasterReview, onExport, onImport, onFieldFocus }: {
  state: AppState; form: FormShape; saveState: string; busy: string; online: boolean; storageReady: boolean; conflict: DraftConflict | null;
  uploadProgress: Record<string, UploadProgress>;
  onChange: (field: keyof FormShape, value: string) => void; onJaanch: () => void; onResolveConflict: (choice: 'local' | 'server') => void;
  onUpload: (slot: string, file: File) => void; onPauseUpload: (slot: string) => void; onMasterReview: (choice: 'accept' | 'keep') => void;
  onExport: () => void; onImport: (file: File) => void; onFieldFocus: (fieldId: string) => void;
}) {
  return (
    <section className="prepare-grid" aria-labelledby="prepare-title">
      <aside className="section-index"><p className="eyebrow">Prepare</p><nav aria-label="Form sections"><a className="active" href="#company">01 Company</a><a href="#financials">02 Financials</a><a href="#governance">03 Governance</a><a href="#attachments">04 Attachments</a></nav></aside>
      <div className="form-column">
        <div className="page-heading compact-heading"><div><p className="eyebrow">Draft v{state.draft?.version ?? 17}</p><h1 id="prepare-title">Prepare AOC-4</h1></div><Status label={saveState} tone={saveState.includes('Offline') || saveState.includes('Conflict') ? 'attention' : saveState.includes('Syncing') ? 'progress' : 'durable'} /></div>
        <p className="scope-note">This is a limited DARJ prototype schema. It does not determine form applicability or legal compliance.</p>
        {!online && <div className="offline-panel" role="status"><strong>Offline · local editing remains available</strong><p>Jaanch, sealing, signing, submission, payment, and processing are paused until the connection returns.</p></div>}
        {!storageReady && <div className="error-panel" role="alert"><strong>Local storage unavailable. Edits blocked.</strong><p>DARJ cannot promise recovery, so it will not accept additional edits. Export the current demo draft before changing browser storage settings.</p><button className="secondary" onClick={onExport}>Export recovery JSON</button></div>}
        {conflict && <ConflictPanel conflict={conflict} busy={busy === 'conflict'} onResolve={onResolveConflict} />}
        <form onSubmit={(event) => event.preventDefault()}>
          <fieldset id="company" disabled={!storageReady}><legend><span>01</span> Company record</legend><div className="field full"><label htmlFor="field-office">Registered office</label><p id="office-help">Pinned from demo company master snapshot {state.master?.pinnedVersion ?? 7}.</p><input id="field-office" value={form.registeredOffice} onFocus={() => onFieldFocus('field-office')} onChange={(e) => onChange('registeredOffice', e.target.value)} aria-describedby="office-help" /></div><div className="field"><label htmlFor="field-fy">Financial year</label><p id="fy-help">Reporting period for this AOC-4 demo.</p><input id="field-fy" value={form.financialYear} onFocus={() => onFieldFocus('field-fy')} onChange={(e) => onChange('financialYear', e.target.value)} aria-describedby="fy-help" /></div><div className="field"><label htmlFor="field-agm">AGM date</label><p id="agm-help">Date used by the deterministic demo checks.</p><input id="field-agm" type="date" value={form.agmDate} onFocus={() => onFieldFocus('field-agm')} onChange={(e) => onChange('agmDate', e.target.value)} aria-describedby="agm-help" /></div></fieldset>
          {state.features.masterDrift && state.master && ['REVIEW_REQUIRED', 'PINNED_STOPPED'].includes(state.master.reviewState) && <MasterDriftPanel master={state.master} busy={busy === 'master'} onReview={onMasterReview} />}
          <fieldset id="financials" disabled={!storageReady}><legend><span>02</span> Financial summary</legend><div className="field"><label htmlFor="field-revenue">Revenue (₹)</label><p id="revenue-help">Whole rupees, without separators.</p><input id="field-revenue" inputMode="numeric" value={form.revenue} onFocus={() => onFieldFocus('field-revenue')} onChange={(e) => onChange('revenue', e.target.value)} aria-describedby="revenue-help" /></div><div className="field"><label htmlFor="field-expenses">Expenses (₹)</label><p id="expenses-help">Whole rupees, without separators.</p><input id="field-expenses" inputMode="numeric" value={form.expenses} onFocus={() => onFieldFocus('field-expenses')} onChange={(e) => onChange('expenses', e.target.value)} aria-describedby="expenses-help" /></div><div className="field"><label htmlFor="field-profit">Net profit (₹)</label><p id="profit-help">Whole rupees, without separators.</p><input id="field-profit" inputMode="numeric" value={form.netProfit} onFocus={() => onFieldFocus('field-profit')} onChange={(e) => onChange('netProfit', e.target.value)} aria-describedby="profit-help" /></div></fieldset>
          <fieldset id="governance" disabled={!storageReady}><legend><span>03</span> Governance</legend><div className="field"><label htmlFor="field-director">Director name</label><p id="director-help">Demo signatory shown on this filing.</p><input id="field-director" value={form.directorName} onFocus={() => onFieldFocus('field-director')} onChange={(e) => onChange('directorName', e.target.value)} aria-describedby="director-help" /></div><div className="field"><label htmlFor="field-boardMeetings">Board meetings</label><p id="meetings-help">Seeded with one deterministic issue for Jaanch.</p><input id="field-boardMeetings" inputMode="numeric" value={form.boardMeetings} onFocus={() => onFieldFocus('field-boardMeetings')} onChange={(e) => onChange('boardMeetings', e.target.value)} aria-describedby="meetings-help" /></div></fieldset>
          <fieldset id="attachments"><legend><span>04</span> Verified attachments</legend><div className="attachment-list">{state.attachments.map((item) => <AttachmentUploadRow key={item.slot} item={item} session={state.uploadSessions.find((session) => session.slot === item.slot && session.state === 'UPLOADING')} progress={uploadProgress[item.slot]} online={online} busy={busy} resumable={state.features.resumableUploads} onUpload={onUpload} onPause={onPauseUpload} />)}</div><p className="attachment-help">12 MB demo limit. Filename must start <code>DARJ-</code>. Resumable uploads use TUS with 6 MB server-confirmed chunks in R2. DARJ marks a file complete only after MIME, byte count and SHA-256 verification.</p></fieldset>
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
  return <section className="master-drift-panel" aria-labelledby="master-drift-title"><div className="issue-head"><code>DARJ_MASTER_DATA_DRIFT</code><Status label={stopped ? 'FILING STOPPED' : 'BLOCKS SEALING'} tone="attention" /></div><h2 id="master-drift-title">Registered office changed after this draft was saved.</h2><p>DARJ compared the pinned filing snapshot with the current demo company master. It will not replace this value silently.</p><dl><div><dt>Pinned snapshot {master.pinnedVersion}</dt><dd>{master.pinnedOffice}</dd></div><div><dt>Current snapshot {master.currentVersion}</dt><dd>{master.currentOffice}</dd></div><div><dt>Source</dt><dd>{master.source}</dd></div><div><dt>Detected</dt><dd>{formatTime(master.detectedAt)}</dd></div></dl>{stopped ? <p className="stopped-note"><strong>Meet kept the pinned value.</strong> This filing is stopped. Reset the demo run to begin again.</p> : <div className="conflict-actions"><button className="primary" disabled={busy} onClick={() => onReview('accept')}>Accept current snapshot and create new draft</button><button className="secondary" disabled={busy} onClick={() => onReview('keep')}>Keep pinned value and stop</button></div>}</section>;
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
      <div className="page-heading"><div><p className="eyebrow">Jaanch · जाँच</p><h1 id="jaanch-title">{total} checks · {passed.length} passed · {blocking.length} needs attention</h1></div><p>Deterministic rules. DARJ-RULES-1.1. Demo company master snapshot 7.</p></div>
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
  return <section className="page-section narrow-page" aria-labelledby="mohar-title"><div className="page-heading"><div><p className="eyebrow">Mohar · मुहर</p><h1 id="mohar-title">One immutable package is ready.</h1></div><Status label="SEALED" tone="durable" /></div><div className="package-index"><div className="package-title"><span className="custody-mark" aria-hidden="true">◇</span><div><small>Package</small><h2>{pkg.packageId} · v{pkg.version}</h2><p>Created {formatTime(pkg.sealedAt)}</p></div></div><dl><RecordDefinition label="Form data" value={`${Object.keys(state.draft?.form ?? {}).length} normalised fields`} /><RecordDefinition label="Attachments" value={`${state.attachments.length} server verified PDF manifests`} /><RecordDefinition label="Rule version" value="DARJ-RULES-1.1" /><RecordDefinition label="Master snapshot" value="Demo company master, version 7" /><RecordDefinition label="Hash standard" value="RFC 8785 semantics and SHA-256" /></dl><div className="hash-block"><span>Full package hash</span><code>{pkg.hash}</code><CopyButton value={pkg.hash} /></div></div><div className="boundary-note"><strong>Sealing boundary</strong><p>Further editing creates a new version. It cannot change this package or its hash.</p></div><div className="action-bar"><div><strong>Package stored append-only</strong><small>The server recomputed this hash from authoritative stored bytes.</small></div><button className="primary" onClick={onSign} disabled={busy === 'sign' || !online}>{busy === 'sign' ? 'Preparing demo signature…' : !online ? 'Reconnect to sign' : 'Continue to demo signing'} <span aria-hidden="true">→</span></button></div></section>;
}

function SignScreen({ state, busy, online, onSubmit, onEdit }: { state: AppState; busy: string; online: boolean; onSubmit: () => void; onEdit: () => void }) {
  const signature = state.signature;
  const pkg = state.package;
  if (!signature || !pkg) return null;
  return <section className="page-section narrow-page" aria-labelledby="sign-title"><div className="demo-banner">DEMO SIGNATURE. NOT A DIGITAL SIGNATURE CERTIFICATE.</div><div className="page-heading"><div><p className="eyebrow">Demo signing</p><h1 id="sign-title">The signature is bound to this package hash.</h1></div><Status label={state.signatureValid ? 'SIGNED · VERIFIED' : 'SIGNATURE INVALID'} tone={state.signatureValid ? 'durable' : 'attention'} /></div><div className="signature-register"><RecordDefinition label="Signer" value="Meet Vekaria, demo filer" /><RecordDefinition label="Provider" value={signature.provider} /><RecordDefinition label="Package" value={`${pkg.packageId} · v${pkg.version}`} /><RecordDefinition label="Signed hash" value={signature.signedHash} mono /><RecordDefinition label="Signature ID" value={signature.signatureId} mono /><RecordDefinition label="Verification" value={state.signatureValid ? 'Ed25519 verification passed' : 'Does not match the current package input'} /><RecordDefinition label="Signed at" value={formatTime(signature.signedAt)} /></div><div className="boundary-note"><strong>This is not a DSC</strong><p>Production filing may require valid, registered Digital Signature Certificates and India PKI/CCA trust infrastructure. DARJ does not reproduce or replace it.</p></div><div className="action-bar"><div><strong>Custody happens before payment</strong><small>Retrying the same exact package cannot create a second Rasid.</small></div><div className="button-group"><button className="secondary" onClick={onEdit}>Edit as new version</button><button className="primary" onClick={onSubmit} disabled={busy === 'submit' || !online || !state.signatureValid}>{busy === 'submit' ? 'Submitting safely…' : !online ? 'Reconnect to submit' : 'Submit exact package'} <span aria-hidden="true">→</span></button></div></div></section>;
}

function RasidScreen({ state, busy, online, onPay, onStatus }: { state: AppState; busy: string; online: boolean; onPay: () => void; onStatus: () => void }) {
  const receipt = state.receipt;
  if (!receipt) return null;
  const paid = state.payment?.state === 'PAID';
  return <section className="page-section receipt-page" aria-labelledby="rasid-title"><div className="page-heading"><div><p className="eyebrow">Rasid · रसीद</p><h1 id="rasid-title">The exact package is in DARJ custody.</h1></div><button className="secondary print-button" onClick={() => window.print()}>Print or save receipt</button></div><article className="receipt"><header><Wordmark compact /><div><span>{receipt.receiptId}</span><small>INDEPENDENT MCA21 FILING PROTOTYPE. DEMO DATA.</small></div></header><div className="receipt-hero"><div className="custody-mark" aria-hidden="true">✓</div><div><p>RECEIVED INTO DARJ CUSTODY</p><time dateTime={receipt.receivedAt}>{formatReceiptTime(receipt.receivedAt)}</time></div></div><dl><RecordDefinition label="Receipt" value={receipt.receiptId} mono /><RecordDefinition label="Package" value={`${receipt.packageId} · v${state.package?.version ?? 23}`} mono /><RecordDefinition label="Package hash" value={receipt.packageHash} mono /><RecordDefinition label="Form" value="MCA21 AOC-4 demo. FY 2025-26" /><RecordDefinition label="Company" value="Aster Components Private Limited" /></dl><p className="receipt-disclaimer">This receipt proves that this exact demo package entered DARJ custody at this time. It is not an MCA21 acknowledgement, legal acceptance or proof of statutory timeliness.</p></article><div className="state-separation"><div><span className="status-mark durable" /><div><small>Custody</small><strong>RECEIVED</strong><p>Immutable Rasid recorded.</p></div></div><div><span className={`status-mark ${paid ? 'durable' : 'progress'}`} /><div><small>Payment</small><strong>{paid ? 'PAID · RECONCILED' : 'PENDING'}</strong><p>{paid ? 'Demo approval recorded on the server.' : 'Separate demo payment intent.'}</p></div></div><div><span className="status-mark progress" /><div><small>Processing</small><strong>{state.processingJob?.state ?? (paid ? 'QUEUED' : 'WAITING FOR PAYMENT')}</strong><p>Receipt is not acceptance.</p></div></div></div>{!paid ? <div className="payment-panel"><div className="demo-banner">PAYMENT SIMULATION. NO MONEY OR PAYMENT DETAILS.</div><div className="payment-body"><div><p className="eyebrow">Demo fee</p><strong className="amount">₹6,000.00</strong><p>No card, UPI, bank, OTP or personal data is collected.</p></div><button className="primary" onClick={onPay} disabled={busy === 'payment' || !online}>{busy === 'payment' ? 'Reconciling…' : !online ? 'Reconnect to approve payment' : 'Approve simulated payment'} <span aria-hidden="true">→</span></button></div></div> : <div className="action-bar"><div><strong>Payment reconciled from the server</strong><small>PAID is not ACCEPTED. Processing remains separate.</small></div><button className="primary" onClick={onStatus}>Track processing <span aria-hidden="true">→</span></button></div>}</section>;
}

function StatusScreen({ state, accepted, busy, online, onPause, onResume }: { state: AppState; accepted: boolean; busy: string; online: boolean; onPause: () => void; onResume: () => void }) {
  const displayEvents = state.events.filter((event) => ['RECEIVED', 'PAID', 'PROCESSING_DELAYED', 'PROCESSING_RESUMED', 'PROCESSING', 'ACCEPTED'].includes(event.eventType));
  return <section className="page-section narrow-page" aria-labelledby="status-title"><div className="page-heading"><div><p className="eyebrow">Processing register</p><h1 id="status-title">{accepted ? 'ACCEPTED' : state.processorPaused ? 'PROCESSING DELAYED' : 'PAID · QUEUED'}</h1></div><Status label={accepted ? 'ACCEPTED' : state.processorPaused ? 'DELAYED' : 'QUEUED'} tone={accepted ? 'durable' : state.processorPaused ? 'attention' : 'progress'} /></div><p className="transport-note">Live status uses server events with an automatic 5-second polling fallback.</p>{state.processorPaused && <div className="delay-panel"><span className="status-mark attention" /><div><strong>Processing is delayed. Do not resubmit or pay again.</strong><p>The exact package remains RECEIVED and the demo payment remains PAID. The worker pause affects only processing.</p></div></div>}<ol className="event-register">{displayEvents.map((event) => <li key={event.seq} className={event.eventType.toLowerCase()}><span className={`event-icon ${eventTone(event.eventType)}`} aria-hidden="true">{eventGlyph(event.eventType)}</span><div><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time></div><p>{event.detail}</p><small>Actor: {event.actor}</small></div></li>)}</ol><div className="status-invariant"><strong>RECEIVED ≠ PAID ≠ PROCESSING ≠ ACCEPTED</strong><p>Each transition has its own durable event and meaning. Time passing alone never promotes custody into acceptance.</p></div>{!accepted && <div className="action-bar"><div><strong>{state.processorPaused ? 'The durable job can resume safely' : 'Demonstrate an outage before acceptance'}</strong><small>Job state: {state.processingJob?.state ?? 'Unavailable'} · attempt {state.processingJob?.attemptCount ?? 0}</small></div>{state.processorPaused ? <button className="primary" onClick={onResume} disabled={busy === 'processor' || !online}>{busy === 'processor' ? 'Resuming…' : !online ? 'Reconnect to resume' : 'Resume and finish processing'} <span aria-hidden="true">→</span></button> : <button className="secondary" onClick={onPause} disabled={busy === 'processor' || !online}>Pause processor</button>}</div>}</section>;
}

function RecoveryScreen({ state, onOpenMain }: { state: AppState; onOpenMain: () => void }) {
  const items: Array<{ folio: string; title: string; state: string; detail: string; tone: 'durable' | 'progress' | 'attention' }> = [
    { folio: 'R-01', title: 'Submission response loss', state: state.receipt ? 'RECOVERED' : 'READY', detail: 'The first response is lost after commit. DARJ reuses one persisted key and returns the same Rasid.', tone: state.receipt ? 'durable' : 'progress' },
    { folio: 'R-02', title: 'Payment callback loss', state: state.payment?.state === 'PAID' ? 'RECONCILED' : 'READY', detail: 'The server approves the demo payment while the browser misses the callback. Reload never asks for a second payment.', tone: state.payment?.state === 'PAID' ? 'durable' : 'progress' },
    { folio: 'R-03', title: 'Processor outage', state: state.processorPaused ? 'DELAYED' : 'READY', detail: 'Pausing job claims preserves custody and payment. No resubmission is needed.', tone: state.processorPaused ? 'attention' : 'progress' },
    { folio: 'R-04', title: 'Browser interruption', state: 'LOCAL FIRST', detail: 'A versioned local draft restores before network reconciliation and survives this demo session.', tone: 'durable' },
  ];
  if (state.features.recoveryCase && state.features.resumableUploads) items.push({ folio: 'R-05', title: 'Resumable attachment upload', state: state.uploadSessions.some((session) => session.state === 'UPLOADING') ? 'PAUSED' : 'READY', detail: 'TUS resumes from the R2-backed, server-confirmed offset after a tab reload. Completed chunks are not sent again.', tone: state.uploadSessions.some((session) => session.state === 'UPLOADING') ? 'attention' : 'progress' });
  if (state.features.recoveryCase && state.features.masterDrift) items.push({ folio: 'R-06', title: 'Company master drift', state: state.master?.reviewState === 'REVIEW_REQUIRED' ? 'REVIEW REQUIRED' : state.master?.reviewState === 'ACCEPTED' ? 'REVIEWED' : 'READY', detail: 'A registered-office change is shown old versus new and blocks sealing until Meet explicitly accepts it or stops.', tone: state.master?.reviewState === 'REVIEW_REQUIRED' ? 'attention' : state.master?.reviewState === 'ACCEPTED' ? 'durable' : 'progress' });
  if (state.features.recoveryCase && state.features.correctionLineage) items.push({ folio: 'R-07', title: 'Correction lineage', state: state.lineage.length ? 'V23 LINKED TO V24' : state.correction ? 'RESUBMISSION REQUIRED' : 'READY', detail: 'A board-report correction creates a linked v24 while the accepted v23 package and hash remain unchanged.', tone: state.lineage.length ? 'durable' : state.correction ? 'attention' : 'progress' });
  return <section className="page-section register-page" aria-labelledby="recovery-title"><div className="page-heading"><div><p className="eyebrow">Case B · Recovery examples</p><h1 id="recovery-title">Failure should be recoverable, not ambiguous.</h1></div><p>This register includes every enabled P0 and P1 recovery path. Each control is isolated to this demo run.</p></div><div className="recovery-list">{items.map((item) => <article key={item.folio}><span className="mono">{item.folio}</span><div><h2>{item.title}</h2><p>{item.detail}</p></div><Status label={item.state} tone={item.tone} /></article>)}</div><div className="action-bar"><div><strong>Run the full recovery path</strong><small>Use authenticated demo controls to arm uploads, master drift, callbacks, processing pauses and correction lineage.</small></div><button className="primary" onClick={onOpenMain}>Open Case A <span aria-hidden="true">→</span></button></div></section>;
}

function LineageScreen({ state, busy, onCreate, onSign }: { state: AppState; busy: string; onCreate: () => void; onSign: () => void }) {
  const correction = state.correction;
  return <section className="page-section narrow-page" aria-labelledby="lineage-title"><div className="page-heading"><div><p className="eyebrow">Package lineage</p><h1 id="lineage-title">Corrections preserve the original.</h1></div><p>Every child package points to its immutable parent. Changed paths are explicit and earlier hashes remain untouched.</p></div>{!correction && <div className="boundary-note"><strong>No correction requested</strong><p>Complete the accepted journey, then use Demo controls to return a board-report resubmission request.</p></div>}{correction?.state === 'REQUIRED' && <div className="correction-request"><div className="issue-head"><code>{correction.requestId}</code><Status label="RESUBMISSION REQUIRED" tone="attention" /></div><h2>{correction.summary}</h2><p>Source package: <code>{correction.sourcePackageId}</code>. DARJ will clone its filing data, replace only the board report and seal a linked v24.</p><button className="primary" disabled={busy === 'correction'} onClick={onCreate}>{busy === 'correction' ? 'Creating verified correction…' : 'Create corrected v24'} <span aria-hidden="true">→</span></button></div>}<div className="lineage-list">{state.lineage.map((record) => <article key={record.child.packageId}><div className="lineage-node"><small>Original package</small><strong>{record.parent.packageId} · v{record.parent.version}</strong><code>{shortHash(record.parent.hash)}</code><span>Immutable</span></div><div className="lineage-arrow" aria-hidden="true">→</div><div className="lineage-node current"><small>Correction package</small><strong>{record.child.packageId} · v{record.child.version}</strong><code>{shortHash(record.child.hash)}</code><span>Parent: {record.parent.packageId}</span></div><div className="lineage-change"><strong>One highlighted change</strong><p>{record.reason}</p><code>{record.changedPaths.join(', ')}</code></div></article>)}</div>{state.lineage.length > 0 && state.package?.packageId === correction?.childPackageId && !state.signatureValid && <div className="action-bar"><div><strong>v24 is sealed and linked to v23</strong><small>The corrected package now needs its own signature before resubmission.</small></div><button className="primary" onClick={onSign}>Open v24 Mohar <span aria-hidden="true">→</span></button></div>}</section>;
}

function DemoControlsScreen({ state, busy, onControl, onPause, onResume, onReset, onLineage }: { state: AppState; busy: string; onControl: (flag: string) => void; onPause: () => void; onResume: () => void; onReset: () => void; onLineage: () => void }) {
  const accepted = state.events.some((event) => event.eventType === 'ACCEPTED');
  return <section className="page-section narrow-page" aria-labelledby="controls-title"><div className="page-heading"><div><p className="eyebrow">Authenticated demo controls</p><h1 id="controls-title">Reproduce recovery paths deterministically.</h1></div><Status label="DEMO RUN ONLY" tone="attention" /></div><p className="scope-note">These controls apply only to this isolated demo run. Only enabled, tested P1 controls are shown.</p><div className="control-register"><div><span className="mono">01</span><div><strong>Submission response loss</strong><p>Commit custody, then lose the browser response once.</p></div><button className="secondary" onClick={() => onControl('submission')}>Arm</button></div><div><span className="mono">02</span><div><strong>Payment callback loss</strong><p>Approve once on the server, then reconcile after the browser misses the callback.</p></div><button className="secondary" onClick={() => onControl('payment')}>Arm</button></div><div><span className="mono">03</span><div><strong>Transaction rollback</strong><p>Fail before commit and prove that no custody record or Rasid exists.</p></div><button className="secondary" onClick={() => onControl('transaction_failure')}>Arm once</button></div><div><span className="mono">04</span><div><strong>Serialization retry</strong><p>Force one retry before the atomic custody batch converges.</p></div><button className="secondary" onClick={() => onControl('serialization_once')}>Arm once</button></div><div><span className="mono">05</span><div><strong>Session expiry</strong><p>Expire this session so the next request must re-authenticate and restore IndexedDB work.</p></div><button className="secondary" onClick={() => onControl('expire_session')}>Expire</button></div><div><span className="mono">06</span><div><strong>Durable processor</strong><p>Pause or resume job claims without changing custody or payment.</p></div>{state.processorPaused ? <button className="primary" onClick={onResume}>Resume</button> : <button className="secondary" onClick={onPause}>Pause</button>}</div>{state.features.recoveryCase && state.features.resumableUploads && <div><span className="mono">07</span><div><strong>Resumable upload interruption</strong><p>Pause after the next 6 MB chunk is safely stored, then reload and select the same PDF to resume.</p></div><button className="secondary" onClick={() => onControl('upload_pause')} disabled={state.uploadPauseArmed}>Arm pause</button></div>}{state.features.recoveryCase && state.features.masterDrift && <div><span className="mono">08</span><div><strong>Company master drift</strong><p>Change the current registered office after the draft pinned snapshot 7.</p></div><button className="secondary" onClick={() => onControl('master_drift')} disabled={state.master?.reviewState !== 'CURRENT'}>Change master</button></div>}{state.features.recoveryCase && state.features.correctionLineage && <div><span className="mono">09</span><div><strong>Board report resubmission</strong><p>Return the accepted package for one correction while preserving its original hash.</p></div>{state.correction ? <button className="secondary" onClick={onLineage}>View lineage</button> : <button className="secondary" onClick={() => onControl('correction_request')} disabled={!accepted}>Return package</button>}</div>}</div><div className="action-bar"><div><strong>Reset is limited to this run</strong><small>It aborts partial uploads and deletes and reseeds only this run’s D1 rows and R2 prefix.</small></div><button className="secondary" disabled={busy === 'reset'} onClick={onReset}>Reset this demo run</button></div></section>;
}

function PublicInformationScreen({ screen, onNavigate }: { screen: 'evidence' | 'limitations'; onNavigate: (screen: Screen) => void }) {
  return <div className="app-shell public-shell"><Disclosure onOpen={() => onNavigate('limitations')} /><header className="app-header"><button className="brand-button" onClick={() => onNavigate('login')} aria-label="DARJ login"><Wordmark compact /></button><div className="header-context"><span className="mono">PUBLIC RECORD</span><strong>{screen === 'evidence' ? 'Evidence' : 'Limitations'}</strong><span>Independent MCA21 filing prototype</span></div><button className="text-button" onClick={() => onNavigate('login')}>Demo login</button></header><main id="main-content" className="app-main">{screen === 'evidence' ? <EvidenceScreen /> : <LimitationsScreen />}</main><footer className="app-footer"><span>DARJ / दर्ज. Independent MCA21 filing prototype.</span><nav aria-label="Footer"><button onClick={() => onNavigate('evidence')}>Evidence</button><button onClick={() => onNavigate('limitations')}>Limitations</button><button onClick={() => onNavigate('login')}>Demo login</button></nav></footer></div>;
}

function EvidenceScreen() {
  const sources = [
    ['Builder brief', 'Challenge scope and judging criteria', 'https://buildwhatmovesindia.com/brief'],
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
    'DARJ is an independent prototype for MCA21 statutory filing workflows. It is not affiliated with MCA, does not connect to MCA21, and does not make real statutory filings.',
    'RECEIVED means this exact demo package is in DARJ custody. It is not an MCA21 acknowledgement, legal filing or acceptance.',
    'A DARJ receipt does not determine statutory timeliness. That is an authority and legal-policy question outside this prototype.',
    'DARJ does not replace a Digital Signature Certificate. The demo uses a test signing adapter. Production use would require the applicable MCA and India PKI/CCA trust infrastructure.',
    'DARJ does not decide legal compliance or give legal advice. Its rules check only deterministic fields and prototype conditions.',
    'MCA21 V3 already provides web forms, real-time validation, saved drafts, status tracking, helpdesk capabilities, MFA, STP for relevant forms, and an offline utility for selected annual forms.',
    'Every error code begins DARJ_. No official MCA error code is claimed or reproduced.',
    'All payments are simulated. DARJ collects no payment credentials, OTPs, Aadhaar, PAN, real CIN, or other sensitive personal data.',
    'One AOC-4 prototype schema is implemented. Form-agnostic expansion is an architectural direction, not a proven Round 1 feature.',
    'Reported MCA21 difficulties are attributed to the cited ICSI representations and are not presented as universal user outcomes.',
    'The Round 1 functional interface is in English. Devanagari is used only for the four product terms दर्ज, जाँच, मुहर and रसीद. A full Hindi or regional-language localisation has not been implemented.',
  ];
  return <section className="page-section narrow-page" aria-labelledby="limitations-title"><div className="page-heading"><div><p className="eyebrow">Prototype boundary</p><h1 id="limitations-title">What this prototype does not do</h1></div></div><ol className="limitations-list">{limitations.map((item, index) => <li key={item}><span className="mono">{String(index + 1).padStart(2, '0')}</span><p>{item}</p></li>)}</ol></section>;
}

function ErrorPanel({ error }: { error: DarjError }) {
  return <div className="error-panel" role="alert"><div><code>{error.code}</code><Status label={error.retryable ? 'RETRY SAFE' : 'ACTION REQUIRED'} tone="attention" /></div><strong>{error.summary}</strong><p>{error.detail}</p><small>Stage: {error.stage} · Correlation: {error.correlationId}</small></div>;
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
    login: '/login', filings: '/filings', prepare: `/filings/${caseId}/prepare`, jaanch: `/filings/${caseId}/jaanch`,
    mohar: `/filings/${caseId}/mohar`, sign: `/filings/${caseId}/sign`, rasid: `/filings/${caseId}/rasid/DARJ-RASID-8129`,
    status: `/filings/${caseId}/status`, lineage: `/filings/${caseId}/lineage`, recovery: '/recovery', evidence: '/evidence', limitations: '/limitations', demoControls: '/demo-controls',
  } satisfies Record<Screen, string>)[screen];
}
