'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { localDelete, localGet, localPut, localStorageAvailable } from '@/lib/local-db';

type Screen = 'login' | 'filings' | 'prepare' | 'jaanch' | 'mohar' | 'sign' | 'rasid' | 'status' | 'recovery' | 'evidence' | 'limitations' | 'demoControls';
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        const local = await safeReadLocalDraft('SYN-CASE-AOC4-01');
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
      const local = ready ? await safeReadLocalDraft('SYN-CASE-AOC4-01') : null;
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
        setHasLocalRecovery(Boolean(await safeReadLocalDraft(state?.caseId ?? 'SYN-CASE-AOC4-01')));
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
      const recovery = await safeReadLocalDraft('SYN-CASE-AOC4-01');
      const next = await post('login', { email: 'priya@darj.demo', password: 'darj2026' }) as unknown as AppState;
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
      setError({ code: 'DARJ_LOCAL_STORAGE_UNAVAILABLE', stage: 'DRAFT', summary: 'DARJ cannot confirm a recoverable local save.', detail: 'Further edits are blocked. Export the current synthetic draft before changing browser storage settings.', retryable: false, correlationId: 'DARJ-CORR-LOCAL' });
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
    const idempotencyKey = await getOrCreateIdempotencyKey(state?.caseId ?? 'case');
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
    setNotice('Approving synthetic payment…');
    const idempotencyKey = await getOrCreateIdempotencyKey(`payment:${state?.caseId ?? 'case'}`);
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
      setNotice('ACCEPTED · synthetic processor outcome');
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

  async function uploadAttachment(slot: string, file: File) {
    if (!online || !state) return;
    setBusy(`upload:${slot}`);
    setNotice('Hashing the selected synthetic PDF before upload…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const clientSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const body = new FormData();
      body.set('slot', slot); body.set('file', file); body.set('clientSha256', clientSha256);
      const response = await fetch(API, { method: 'POST', headers: { 'X-DARJ-CSRF': readBrowserCookie('darj_csrf') ?? '' }, body });
      const payload = await response.json() as Attachment & { error?: DarjError };
      if (!response.ok) {
        if (payload.error) setError(payload.error);
        throw new Error(payload.error?.summary ?? 'Attachment upload failed');
      }
      setState((current) => current ? {
        ...current,
        attachments: [...current.attachments.filter((item) => item.slot !== slot), payload].sort((a, b) => a.slot.localeCompare(b.slot)),
        packageCurrent: false,
        signatureValid: false,
      } : current);
      setNotice(`${labelSlot(slot)} · server MIME, bytes, and SHA-256 verified`);
      setError(null);
    } finally { setBusy(''); }
  }

  function exportDraft() {
    if (!form || !state) return;
    const payload = JSON.stringify({ schema: 'DARJ-DRAFT-1', caseId: state.caseId, exportedAt: new Date().toISOString(), form }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'SYN-DARJ-draft.json'; link.click();
    URL.revokeObjectURL(url);
  }

  async function importDraft(file: File) {
    if (!state) return;
    try {
      const parsed = JSON.parse(await file.text()) as { schema?: unknown; caseId?: unknown; form?: unknown };
      if (parsed.schema !== 'DARJ-DRAFT-1' || parsed.caseId !== state.caseId || !isValidImportedForm(parsed.form)) throw new Error('The selected JSON is not a valid DARJ synthetic draft export.');
      if (!window.confirm('Replace the working fields with this validated synthetic draft? A new immutable draft version will be created.')) return;
      setForm(parsed.form);
      await saveDraft(parsed.form, state.draft?.version ?? 17);
      setNotice('Validated synthetic draft imported as a new version');
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
  const accepted = state?.events.some((event) => event.eventType === 'ACCEPTED') ?? false;

  if (screen === 'evidence' || screen === 'limitations') return <PublicInformationScreen screen={screen} onNavigate={navigate} />;
  if (screen === 'login' || !state || !form) return <LoginScreen hydrated={hydrated} busy={busy === 'login'} onEnter={() => void login()} onLimitations={() => navigate('limitations')} error={error} sessionExpired={sessionExpired} hasLocalRecovery={hasLocalRecovery} storageReady={storageReady} />;

  return (
    <div className="app-shell">
      <Disclosure onOpen={() => navigate('limitations')} />
      <AppHeader screen={screen} state={state} onNavigate={navigate} />
      <main id="main-content" className="app-main">
        {notice && <div className="notice" role="status" aria-live="polite"><span className="status-mark progress" />{notice}</div>}
        {error && <ErrorPanel error={error} />}

        {screen === 'filings' && <FilingsScreen state={state} onPrepare={() => navigate(resumeScreen(state))} onRecovery={() => navigate('recovery')} />}
        {screen === 'prepare' && (
          <PrepareScreen state={state} form={form} saveState={saveState} busy={busy} online={online} storageReady={storageReady} conflict={conflict}
            onChange={changeField} onJaanch={() => void runChecks()} onResolveConflict={(choice) => void resolveConflict(choice)}
            onUpload={(slot, file) => void uploadAttachment(slot, file)} onExport={exportDraft} onImport={(file) => void importDraft(file)} onFieldFocus={rememberFocusedField} />
        )}
        {screen === 'jaanch' && (
          <JaanchScreen checks={checks} blocking={blocking} passed={passed} busy={busy} onGoToField={() => {
            navigate('prepare'); setTimeout(() => document.getElementById('field-boardMeetings')?.focus(), 80);
          }} onRerun={() => void runChecks()} onSeal={() => void createMohar()} online={online} />
        )}
        {screen === 'mohar' && <MoharScreen state={state} busy={busy} online={online} onSign={() => void sign()} />}
        {screen === 'sign' && <SignScreen state={state} busy={busy} online={online} onSubmit={() => void submit()} onEdit={() => { navigate('prepare'); setNotice('Editing creates a new draft and invalidates this signature for the next package.'); }} />}
        {screen === 'rasid' && <RasidScreen state={state} busy={busy} online={online} onPay={() => void approvePayment()} onStatus={() => navigate('status')} />}
        {screen === 'status' && <StatusScreen state={state} accepted={accepted} busy={busy} online={online} onPause={() => void pauseProcessor()} onResume={() => void resumeProcessor()} />}
        {screen === 'recovery' && <RecoveryScreen state={state} onOpenMain={() => navigate('prepare')} />}
        {screen === 'demoControls' && <DemoControlsScreen state={state} busy={busy} onControl={(flag) => void post('setRecovery', { flag }).then(() => setNotice(`${flag.replaceAll('_', ' ')} armed for this demo run`))} onPause={() => void pauseProcessor()} onResume={() => void resumeProcessor()} onReset={() => void resetDemo()} />}
      </main>
      <footer className="app-footer">
        <span>DARJ / दर्ज · independent filing-reliability prototype</span>
        <nav aria-label="Footer"><button onClick={() => navigate('evidence')}>Evidence</button><button onClick={() => navigate('limitations')}>Limitations</button><button onClick={() => void resetDemo()} disabled={busy === 'reset'}>Reset this demo run</button></nav>
      </footer>
    </div>
  );
}

function Disclosure({ onOpen }: { onOpen: () => void }) {
  return <button className="prototype-strip disclosure-button" onClick={onOpen}>INDEPENDENT PROTOTYPE · SYNTHETIC DATA · NOT AN MCA SERVICE</button>;
}

function LoginScreen({ hydrated, busy, onEnter, onLimitations, error, sessionExpired, hasLocalRecovery, storageReady }: { hydrated: boolean; busy: boolean; onEnter: () => void; onLimitations: () => void; error: DarjError | null; sessionExpired: boolean; hasLocalRecovery: boolean; storageReady: boolean }) {
  return (
    <main className="login-shell">
      <button className="prototype-strip disclosure-button" onClick={onLimitations}>INDEPENDENT PROTOTYPE · SYNTHETIC DATA · NOT AN MCA SERVICE</button>
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
          <p className="eyebrow"><span>01</span> Statutory filing, rebuilt as a durable transaction</p>
          <h1 id="login-title">A filing deadline should not depend on a <em>browser session surviving.</em></h1>
          <p className="login-deck">DARJ protects one synthetic AOC-4 from first draft to final outcome—so retries, payments, and processor delays never blur what actually happened.</p>
          <blockquote>“One exact package. One durable receipt.”</blockquote>
        </div>

        <aside className="login-access" aria-label="Reviewer access">
          <div className="access-heading">
            <p className="register-folio">REVIEWER ACCESS / 00</p>
            <span className="access-status"><i /> Ready</span>
          </div>
          <h2>Open Priya’s filing</h2>
          <p className="access-copy">Enter an isolated filing room with a prepared synthetic case. No OTP, install, or real data.</p>
          {sessionExpired && hasLocalRecovery && <div className="recovery-callout" role="status"><strong>Local work is safe</strong><p>Re-enter the demo to resume the same filing and last focused field.</p></div>}
          {!storageReady && <div className="error-panel" role="alert"><strong>Local storage is unavailable</strong><p>DARJ will not accept edits until browser storage is available. You may still inspect the public evidence and limitations pages.</p></div>}
          {error && <ErrorPanel error={error} />}
          <div className="login-form">
            <div className="credential-field">
              <label htmlFor="email">Demo email</label>
              <input id="email" value="priya@darj.demo" readOnly />
            </div>
            <div className="credential-field">
              <label htmlFor="password">Demo password</label>
              <input id="password" value="darj2026" readOnly />
            </div>
            <button type="button" onClick={onEnter} disabled={!hydrated || busy}>
              <span>{!hydrated || busy ? 'Preparing your filing room…' : 'Enter Priya’s filing'}</span>
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

      <div className="prototype-note"><strong>Independent by design.</strong><p>DARJ does not connect to MCA21. Every company, filing, document, identifier, signature, payment, error, and receipt is synthetic.</p></div>
    </main>
  );
}

function AppHeader({ screen, state, onNavigate }: { screen: Screen; state: AppState; onNavigate: (screen: Screen) => void }) {
  return (
    <header className="app-header">
      <button className="brand-button" onClick={() => onNavigate('filings')} aria-label="DARJ filing register"><Wordmark compact /></button>
      <div className="header-context"><span className="mono">FOLIO 01</span><strong>SYN — Aster Components Private Limited</strong><span>AOC-4 prototype · FY 2025-26</span></div>
      <div className="header-state"><span className="status-mark durable" /><div><small>Current record</small><strong>{journeyLabel(state)}</strong></div></div>
      {screen !== 'filings' && <button className="text-button" onClick={() => onNavigate('filings')}>Filing register</button>}
    </header>
  );
}

function Wordmark({ compact = false }: { compact?: boolean }) {
  return <div className={`wordmark ${compact ? 'compact' : ''}`} aria-label="DARJ, दर्ज"><span>DARJ</span><span className="wordmark-divider" aria-hidden="true" /><span lang="hi">दर्ज</span></div>;
}

function FilingsScreen({ state, onPrepare, onRecovery }: { state: AppState; onPrepare: () => void; onRecovery: () => void }) {
  return (
    <section className="page-section register-page" aria-labelledby="filings-title">
      <div className="page-heading"><div><p className="eyebrow">Synthetic filing register</p><h1 id="filings-title">Two cases. One exact record at a time.</h1></div><p>Each browser session receives an isolated demo run. Nothing here is shared with another reviewer.</p></div>
      <div className="register-table" aria-label="Synthetic filing cases">
        <div className="register-table-head"><span>Folio</span><span>Company</span><span>Form / FY</span><span>Due state</span><span>Record state</span><span>Action</span></div>
        <div className="filing-row">
          <span data-label="Folio" className="mono">01 / A</span>
          <span data-label="Company"><strong>SYN — Aster Components Private Limited</strong><small>SYN-CIN-000117</small></span>
          <span data-label="Form / FY"><strong>AOC-4 prototype</strong><small>FY 2025-26</small></span>
          <span data-label="Due state"><strong>Due today</strong><small>28 Aug 2026 · 11:59 PM IST</small></span>
          <span data-label="Record state"><Status label={journeyLabel(state)} tone={state.receipt ? 'durable' : 'progress'} /><small>Draft v{state.draft?.version ?? 17} · {state.attachments.length} verified PDFs</small></span>
          <span data-label="Action"><button className="primary small" onClick={onPrepare}>{state.receipt ? 'View record' : 'Continue filing'} <span aria-hidden="true">→</span></button></span>
        </div>
        <div className="filing-row">
          <span data-label="Folio" className="mono">02 / B</span>
          <span data-label="Company"><strong>SYN — Aster Components Private Limited</strong><small>Recovery examples</small></span>
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

function PrepareScreen({ state, form, saveState, busy, online, storageReady, conflict, onChange, onJaanch, onResolveConflict, onUpload, onExport, onImport, onFieldFocus }: {
  state: AppState; form: FormShape; saveState: string; busy: string; online: boolean; storageReady: boolean; conflict: DraftConflict | null;
  onChange: (field: keyof FormShape, value: string) => void; onJaanch: () => void; onResolveConflict: (choice: 'local' | 'server') => void;
  onUpload: (slot: string, file: File) => void; onExport: () => void; onImport: (file: File) => void; onFieldFocus: (fieldId: string) => void;
}) {
  return (
    <section className="prepare-grid" aria-labelledby="prepare-title">
      <aside className="section-index"><p className="eyebrow">Prepare</p><nav aria-label="Form sections"><a className="active" href="#company">01 Company</a><a href="#financials">02 Financials</a><a href="#governance">03 Governance</a><a href="#attachments">04 Attachments</a></nav></aside>
      <div className="form-column">
        <div className="page-heading compact-heading"><div><p className="eyebrow">Draft v{state.draft?.version ?? 17}</p><h1 id="prepare-title">Prepare AOC-4</h1></div><Status label={saveState} tone={saveState.includes('Offline') || saveState.includes('Conflict') ? 'attention' : saveState.includes('Syncing') ? 'progress' : 'durable'} /></div>
        <p className="scope-note">This is a limited DARJ prototype schema. It does not determine form applicability or legal compliance.</p>
        {!online && <div className="offline-panel" role="status"><strong>Offline · local editing remains available</strong><p>Jaanch, sealing, signing, submission, payment, and processing are paused until the connection returns.</p></div>}
        {!storageReady && <div className="error-panel" role="alert"><strong>Local storage unavailable · edits blocked</strong><p>DARJ cannot promise recovery, so it will not accept additional edits. Export the current synthetic draft before changing browser storage settings.</p><button className="secondary" onClick={onExport}>Export recovery JSON</button></div>}
        {conflict && <ConflictPanel conflict={conflict} busy={busy === 'conflict'} onResolve={onResolveConflict} />}
        <form onSubmit={(event) => event.preventDefault()}>
          <fieldset id="company" disabled={!storageReady}><legend><span>01</span> Company record</legend><div className="field full"><label htmlFor="field-office">Registered office</label><p id="office-help">Pinned from synthetic company-master snapshot 7.</p><input id="field-office" value={form.registeredOffice} onFocus={() => onFieldFocus('field-office')} onChange={(e) => onChange('registeredOffice', e.target.value)} aria-describedby="office-help" /></div><div className="field"><label htmlFor="field-fy">Financial year</label><input id="field-fy" value={form.financialYear} onFocus={() => onFieldFocus('field-fy')} onChange={(e) => onChange('financialYear', e.target.value)} /></div><div className="field"><label htmlFor="field-agm">Synthetic AGM date</label><input id="field-agm" type="date" value={form.agmDate} onFocus={() => onFieldFocus('field-agm')} onChange={(e) => onChange('agmDate', e.target.value)} /></div></fieldset>
          <fieldset id="financials" disabled={!storageReady}><legend><span>02</span> Financial summary</legend><div className="field"><label htmlFor="field-revenue">Revenue (₹)</label><input id="field-revenue" inputMode="numeric" value={form.revenue} onFocus={() => onFieldFocus('field-revenue')} onChange={(e) => onChange('revenue', e.target.value)} /></div><div className="field"><label htmlFor="field-expenses">Expenses (₹)</label><input id="field-expenses" inputMode="numeric" value={form.expenses} onFocus={() => onFieldFocus('field-expenses')} onChange={(e) => onChange('expenses', e.target.value)} /></div><div className="field"><label htmlFor="field-profit">Net profit (₹)</label><input id="field-profit" inputMode="numeric" value={form.netProfit} onFocus={() => onFieldFocus('field-profit')} onChange={(e) => onChange('netProfit', e.target.value)} /></div></fieldset>
          <fieldset id="governance" disabled={!storageReady}><legend><span>03</span> Governance</legend><div className="field"><label htmlFor="field-director">Synthetic director label</label><input id="field-director" value={form.directorName} onFocus={() => onFieldFocus('field-director')} onChange={(e) => onChange('directorName', e.target.value)} /></div><div className="field"><label htmlFor="field-boardMeetings">Board meetings</label><p id="meetings-help">Seeded with one deterministic issue for Jaanch.</p><input id="field-boardMeetings" inputMode="numeric" value={form.boardMeetings} onFocus={() => onFieldFocus('field-boardMeetings')} onChange={(e) => onChange('boardMeetings', e.target.value)} aria-describedby="meetings-help" /></div></fieldset>
          <fieldset id="attachments"><legend><span>04</span> Verified attachments</legend><div className="attachment-list">{state.attachments.map((item) => <div className="attachment-row" key={item.slot}><span className="file-mark" aria-hidden="true">PDF</span><div><strong>{labelSlot(item.slot)}</strong><small>{item.filename} · {item.bytes} bytes</small></div><Status label="SERVER VERIFIED" tone="durable" /><code title={item.sha256}>{shortHash(item.sha256)}</code><label className={`secondary file-action ${!online ? 'disabled' : ''}`}>Replace<input type="file" accept="application/pdf,.pdf" disabled={!online || busy.startsWith('upload:')} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(item.slot, file); event.currentTarget.value = ''; }} /></label></div>)}</div><p className="attachment-help">P0 upload limit: 5 MB. Filename must start <code>SYN-</code>. DARJ verifies the PDF signature, byte count, and SHA-256 from stored R2 bytes.</p></fieldset>
        </form>
        <div className="draft-tools"><button className="secondary" onClick={onExport}>Export draft JSON</button><label className="secondary file-action">Import validated JSON<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ''; }} /></label></div>
        <div className="action-bar"><div><strong>{saveState}</strong><small>Last server sync {formatTime(state.draft?.savedAt)}</small></div><button className="primary" onClick={onJaanch} disabled={busy === 'jaanch' || !online || !storageReady || Boolean(conflict) || saveState !== 'Saved locally · Synced'}>{busy === 'jaanch' ? 'Running 43 checks…' : !online ? 'Reconnect to run Jaanch' : 'Run Jaanch · जाँच'} <span aria-hidden="true">→</span></button></div>
      </div>
      <aside className="record-strip"><p className="eyebrow">Record strip</p><RecordLine label="Case" value="SYN-CASE-AOC4-01" /><RecordLine label="Version" value={`v${state.draft?.version ?? 17}`} /><RecordLine label="Local" value={storageReady ? 'Saved' : 'Unavailable'} tone={storageReady ? 'durable' : undefined} /><RecordLine label="Server" value={online ? 'Synced' : 'Offline'} tone={online ? 'durable' : undefined} /><RecordLine label="Files" value={`${state.attachments.length} / 3 verified`} tone="durable" /><RecordLine label="Master" value="Snapshot 7" /></aside>
    </section>
  );
}

function ConflictPanel({ conflict, busy, onResolve }: { conflict: DraftConflict; busy: boolean; onResolve: (choice: 'local' | 'server') => void }) {
  const paths = conflict.changedPaths.length ? conflict.changedPaths : Object.keys(conflict.local).filter((key) => conflict.local[key as keyof FormShape] !== conflict.server.form[key as keyof FormShape]);
  return <section className="conflict-panel" aria-labelledby="conflict-title"><p className="eyebrow">Version conflict</p><h2 id="conflict-title">Choose which value becomes the next draft.</h2><p>No value has been overwritten. Server v{conflict.server.version} arrived after this local version.</p><div className="conflict-diff">{paths.map((path) => <div key={path}><strong>{fieldLabel(path)}</strong><span><small>Local</small>{conflict.local[path as keyof FormShape]}</span><span><small>Server</small>{conflict.server.form[path as keyof FormShape]}</span></div>)}</div><div className="conflict-actions"><button className="primary" disabled={busy} onClick={() => onResolve('local')}>Keep local as new version</button><button className="secondary" disabled={busy} onClick={() => onResolve('server')}>Use server version</button></div></section>;
}

function JaanchScreen({ checks, blocking, passed, busy, online, onGoToField, onRerun, onSeal }: { checks: CheckRecord[]; blocking: CheckRecord[]; passed: CheckRecord[]; busy: string; online: boolean; onGoToField: () => void; onRerun: () => void; onSeal: () => void }) {
  const total = checks.length || 43;
  return (
    <section className="page-section narrow-page" aria-labelledby="jaanch-title">
      <div className="page-heading"><div><p className="eyebrow">Jaanch · जाँच</p><h1 id="jaanch-title">{total} checks · {passed.length} passed · {blocking.length} needs attention</h1></div><p>Deterministic rules only · DARJ-RULES-1.1 · synthetic master snapshot 7</p></div>
      {blocking.length > 0 ? <div className="check-group" role="alert" tabIndex={-1}><h2><span className="status-mark attention" /> Needs attention</h2>{blocking.map((issue) => <article className="issue-panel" key={issue.code}><div className="issue-head"><code>{issue.code}</code><Status label="BLOCKS SEALING" tone="attention" /></div><h3>{issue.summary}</h3><p>{issue.detail}</p><dl><div><dt>Expected</dt><dd>{issue.expected}</dd></div><div><dt>Actual</dt><dd>{issue.actual}</dd></div><div><dt>Location</dt><dd>Governance / Board meetings</dd></div><div><dt>Retry safety</dt><dd>Safe after correcting this field</dd></div></dl><button className="secondary" onClick={onGoToField}>Go to exact field <span aria-hidden="true">→</span></button></article>)}</div> : <div className="all-clear"><span className="custody-mark mini" aria-hidden="true">✓</span><div><p className="eyebrow">Ready to seal</p><h2>All 43 deterministic checks passed.</h2><p>Jaanch does not decide legal compliance or the sufficiency of narrative disclosures.</p></div></div>}
      <details className="passed-checks"><summary>Passed <span>{passed.length} checks</span></summary><div className="check-list">{passed.map((check) => <div key={check.code}><code>{check.code}</code><span>{check.summary}</span><Status label="PASSED" tone="durable" /></div>)}</div></details>
      <details className="passed-checks"><summary>Not applicable <span>0 checks</span></summary><p>No rule was classified as not applicable for this seeded case.</p></details>
      <div className="action-bar"><div><strong>{blocking.length ? 'One issue blocks sealing' : 'Rule result fixed to this draft version'}</strong><small>Editing after this run makes Jaanch stale.</small></div>{blocking.length ? <button className="secondary" onClick={onRerun} disabled={busy === 'jaanch' || !online}>Rerun Jaanch</button> : <button className="primary" onClick={onSeal} disabled={busy === 'seal' || !online}>{busy === 'seal' ? 'Creating immutable package…' : !online ? 'Reconnect to create Mohar' : 'Create Mohar · मुहर'} <span aria-hidden="true">→</span></button>}</div>
    </section>
  );
}

function MoharScreen({ state, busy, online, onSign }: { state: AppState; busy: string; online: boolean; onSign: () => void }) {
  const pkg = state.package;
  if (!pkg) return null;
  return <section className="page-section narrow-page" aria-labelledby="mohar-title"><div className="page-heading"><div><p className="eyebrow">Mohar · मुहर</p><h1 id="mohar-title">One immutable package is ready.</h1></div><Status label="SEALED" tone="durable" /></div><div className="package-index"><div className="package-title"><span className="custody-mark" aria-hidden="true">◇</span><div><small>Package</small><h2>{pkg.packageId} · v{pkg.version}</h2><p>Created {formatTime(pkg.sealedAt)}</p></div></div><dl><RecordDefinition label="Form data" value={`${Object.keys(state.draft?.form ?? {}).length} normalised fields`} /><RecordDefinition label="Attachments" value={`${state.attachments.length} server-verified PDF manifests`} /><RecordDefinition label="Rule version" value="DARJ-RULES-1.1" /><RecordDefinition label="Master snapshot" value="Synthetic company master · v7" /><RecordDefinition label="Hash standard" value="RFC 8785 semantics · SHA-256" /></dl><div className="hash-block"><span>Full package hash</span><code>{pkg.hash}</code><CopyButton value={pkg.hash} /></div></div><div className="boundary-note"><strong>Sealing boundary</strong><p>Further editing creates a new version. It cannot change this package or its hash.</p></div><div className="action-bar"><div><strong>Package stored append-only</strong><small>The server recomputed this hash from authoritative stored bytes.</small></div><button className="primary" onClick={onSign} disabled={busy === 'sign' || !online}>{busy === 'sign' ? 'Preparing synthetic signature…' : !online ? 'Reconnect to sign' : 'Continue to synthetic sign'} <span aria-hidden="true">→</span></button></div></section>;
}

function SignScreen({ state, busy, online, onSubmit, onEdit }: { state: AppState; busy: string; online: boolean; onSubmit: () => void; onEdit: () => void }) {
  const signature = state.signature;
  const pkg = state.package;
  if (!signature || !pkg) return null;
  return <section className="page-section narrow-page" aria-labelledby="sign-title"><div className="demo-banner">DEMO SIGNATURE · NOT A DIGITAL SIGNATURE CERTIFICATE</div><div className="page-heading"><div><p className="eyebrow">Synthetic sign</p><h1 id="sign-title">The signature is bound to this package hash.</h1></div><Status label={state.signatureValid ? 'SIGNED · VERIFIED' : 'SIGNATURE INVALID'} tone={state.signatureValid ? 'durable' : 'attention'} /></div><div className="signature-register"><RecordDefinition label="Signer label" value="Priya Shah · synthetic authorised filer" /><RecordDefinition label="Provider" value={signature.provider} /><RecordDefinition label="Package" value={`${pkg.packageId} · v${pkg.version}`} /><RecordDefinition label="Signed hash" value={signature.signedHash} mono /><RecordDefinition label="Signature ID" value={signature.signatureId} mono /><RecordDefinition label="Verification" value={state.signatureValid ? 'Ed25519 verification passed' : 'Does not match the current package input'} /><RecordDefinition label="Signed at" value={formatTime(signature.signedAt)} /></div><div className="boundary-note"><strong>This is not a DSC</strong><p>Production filing may require valid, registered Digital Signature Certificates and India PKI/CCA trust infrastructure. DARJ does not reproduce or replace it.</p></div><div className="action-bar"><div><strong>Custody happens before payment</strong><small>Retrying the same exact package cannot create a second Rasid.</small></div><div className="button-group"><button className="secondary" onClick={onEdit}>Edit as new version</button><button className="primary" onClick={onSubmit} disabled={busy === 'submit' || !online || !state.signatureValid}>{busy === 'submit' ? 'Submitting retry-safely…' : !online ? 'Reconnect to submit' : 'Submit exact package'} <span aria-hidden="true">→</span></button></div></div></section>;
}

function RasidScreen({ state, busy, online, onPay, onStatus }: { state: AppState; busy: string; online: boolean; onPay: () => void; onStatus: () => void }) {
  const receipt = state.receipt;
  if (!receipt) return null;
  const paid = state.payment?.state === 'PAID';
  return <section className="page-section receipt-page" aria-labelledby="rasid-title"><div className="page-heading"><div><p className="eyebrow">Rasid · रसीद</p><h1 id="rasid-title">The exact package is in DARJ custody.</h1></div><button className="secondary print-button" onClick={() => window.print()}>Print / save receipt</button></div><article className="receipt"><header><Wordmark compact /><div><span>{receipt.receiptId}</span><small>INDEPENDENT PROTOTYPE · SYNTHETIC DATA</small></div></header><div className="receipt-hero"><div className="custody-mark" aria-hidden="true">✓</div><div><p>RECEIVED INTO DARJ CUSTODY</p><time dateTime={receipt.receivedAt}>{formatReceiptTime(receipt.receivedAt)}</time></div></div><dl><RecordDefinition label="Receipt" value={receipt.receiptId} mono /><RecordDefinition label="Package" value={`${receipt.packageId} · v${state.package?.version ?? 23}`} mono /><RecordDefinition label="Package hash" value={receipt.packageHash} mono /><RecordDefinition label="Form" value="AOC-4 prototype · FY 2025-26" /><RecordDefinition label="Company" value="SYN — Aster Components Private Limited" /></dl><p className="receipt-disclaimer">This receipt proves this exact synthetic package entered DARJ custody at this time. It is not MCA acknowledgement, legal acceptance, or proof of statutory timeliness.</p></article><div className="state-separation"><div><span className="status-mark durable" /><div><small>Custody</small><strong>RECEIVED</strong><p>Immutable Rasid recorded.</p></div></div><div><span className={`status-mark ${paid ? 'durable' : 'progress'}`} /><div><small>Payment</small><strong>{paid ? 'PAID · RECONCILED' : 'PENDING'}</strong><p>{paid ? 'Synthetic approval recorded server-side.' : 'Separate synthetic payment intent.'}</p></div></div><div><span className="status-mark progress" /><div><small>Processing</small><strong>{state.processingJob?.state ?? (paid ? 'QUEUED' : 'WAITING FOR PAYMENT')}</strong><p>Receipt is not acceptance.</p></div></div></div>{!paid ? <div className="payment-panel"><div className="demo-banner">PAYMENT SIMULATION · NO MONEY OR PAYMENT DETAILS</div><div className="payment-body"><div><p className="eyebrow">Synthetic fee</p><strong className="amount">₹6,000.00</strong><p>No card, UPI, bank, OTP, or personal data is collected.</p></div><button className="primary" onClick={onPay} disabled={busy === 'payment' || !online}>{busy === 'payment' ? 'Reconciling…' : !online ? 'Reconnect to approve payment' : 'Approve simulated payment'} <span aria-hidden="true">→</span></button></div></div> : <div className="action-bar"><div><strong>Payment reconciled from the server</strong><small>PAID is not ACCEPTED. Processing remains separate.</small></div><button className="primary" onClick={onStatus}>Track processing <span aria-hidden="true">→</span></button></div>}</section>;
}

function StatusScreen({ state, accepted, busy, online, onPause, onResume }: { state: AppState; accepted: boolean; busy: string; online: boolean; onPause: () => void; onResume: () => void }) {
  const displayEvents = state.events.filter((event) => ['RECEIVED', 'PAID', 'PROCESSING_DELAYED', 'PROCESSING_RESUMED', 'PROCESSING', 'ACCEPTED'].includes(event.eventType));
  return <section className="page-section narrow-page" aria-labelledby="status-title"><div className="page-heading"><div><p className="eyebrow">Processing register</p><h1 id="status-title">{accepted ? 'ACCEPTED' : state.processorPaused ? 'PROCESSING DELAYED' : 'PAID · QUEUED'}</h1></div><Status label={accepted ? 'ACCEPTED' : state.processorPaused ? 'DELAYED' : 'QUEUED'} tone={accepted ? 'durable' : state.processorPaused ? 'attention' : 'progress'} /></div><p className="transport-note">Live status uses server events with an automatic 5-second polling fallback.</p>{state.processorPaused && <div className="delay-panel"><span className="status-mark attention" /><div><strong>Processing is delayed. Do not resubmit or pay again.</strong><p>The exact package remains RECEIVED and the synthetic payment remains PAID. The worker pause affects only processing.</p></div></div>}<ol className="event-register">{displayEvents.map((event) => <li key={event.seq} className={event.eventType.toLowerCase()}><span className={`event-icon ${eventTone(event.eventType)}`} aria-hidden="true">{eventGlyph(event.eventType)}</span><div><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time></div><p>{event.detail}</p><small>Actor: {event.actor}</small></div></li>)}</ol><div className="status-invariant"><strong>RECEIVED ≠ PAID ≠ PROCESSING ≠ ACCEPTED</strong><p>Each transition has its own durable event and meaning. Time passing alone never promotes custody into acceptance.</p></div>{!accepted && <div className="action-bar"><div><strong>{state.processorPaused ? 'The durable job can resume safely' : 'Demonstrate an outage before acceptance'}</strong><small>Job state: {state.processingJob?.state ?? 'Unavailable'} · attempt {state.processingJob?.attemptCount ?? 0}</small></div>{state.processorPaused ? <button className="primary" onClick={onResume} disabled={busy === 'processor' || !online}>{busy === 'processor' ? 'Resuming…' : !online ? 'Reconnect to resume' : 'Resume and finish processing'} <span aria-hidden="true">→</span></button> : <button className="secondary" onClick={onPause} disabled={busy === 'processor' || !online}>Pause processor</button>}</div>}</section>;
}

function RecoveryScreen({ state, onOpenMain }: { state: AppState; onOpenMain: () => void }) {
  const items = [
    { folio: 'R-01', title: 'Submission response loss', state: state.receipt ? 'RECOVERED' : 'READY', detail: 'The first response is lost after commit. DARJ reuses one persisted key and returns the same Rasid.' },
    { folio: 'R-02', title: 'Payment callback loss', state: state.payment?.state === 'PAID' ? 'RECONCILED' : 'READY', detail: 'The server approves the synthetic payment while the browser misses the callback. Reload never asks for a second payment.' },
    { folio: 'R-03', title: 'Processor outage', state: state.processorPaused ? 'DELAYED' : 'READY', detail: 'Pausing job claims preserves custody and payment. No resubmission is needed.' },
    { folio: 'R-04', title: 'Browser interruption', state: 'LOCAL-FIRST', detail: 'A versioned local draft restores before network reconciliation and survives this demo session.' },
  ];
  return <section className="page-section register-page" aria-labelledby="recovery-title"><div className="page-heading"><div><p className="eyebrow">Case B · Recovery examples</p><h1 id="recovery-title">Failure should be recoverable, not ambiguous.</h1></div><p>Only implemented P0 recovery paths appear here. Disabled P1 features are omitted completely.</p></div><div className="recovery-list">{items.map((item) => <article key={item.folio}><span className="mono">{item.folio}</span><div><h2>{item.title}</h2><p>{item.detail}</p></div><Status label={item.state} tone={item.state === 'READY' ? 'progress' : 'durable'} /></article>)}</div><div className="action-bar"><div><strong>Run the full recovery path</strong><small>Case A begins with one Jaanch issue and deterministic response loss.</small></div><button className="primary" onClick={onOpenMain}>Open Case A <span aria-hidden="true">→</span></button></div></section>;
}

function DemoControlsScreen({ state, busy, onControl, onPause, onResume, onReset }: { state: AppState; busy: string; onControl: (flag: string) => void; onPause: () => void; onResume: () => void; onReset: () => void }) {
  return <section className="page-section narrow-page" aria-labelledby="controls-title"><div className="page-heading"><div><p className="eyebrow">Authenticated demo controls</p><h1 id="controls-title">Reproduce P0 recovery paths deterministically.</h1></div><Status label="SYNTHETIC RUN ONLY" tone="attention" /></div><p className="scope-note">These controls apply only to this isolated demo run. Disabled P1 controls do not exist here.</p><div className="control-register"><div><span className="mono">01</span><div><strong>Submission response loss</strong><p>Commit custody, then lose the browser response once.</p></div><button className="secondary" onClick={() => onControl('submission')}>Arm</button></div><div><span className="mono">02</span><div><strong>Payment callback loss</strong><p>Approve once server-side, then reconcile after the browser misses the callback.</p></div><button className="secondary" onClick={() => onControl('payment')}>Arm</button></div><div><span className="mono">03</span><div><strong>Transaction rollback</strong><p>Fail before commit and prove that no custody record or Rasid exists.</p></div><button className="secondary" onClick={() => onControl('transaction_failure')}>Arm once</button></div><div><span className="mono">04</span><div><strong>Serialization retry</strong><p>Force one retry before the atomic custody batch converges.</p></div><button className="secondary" onClick={() => onControl('serialization_once')}>Arm once</button></div><div><span className="mono">05</span><div><strong>Session expiry</strong><p>Expire this session so the next request must re-authenticate and restore IndexedDB work.</p></div><button className="secondary" onClick={() => onControl('expire_session')}>Expire</button></div><div><span className="mono">06</span><div><strong>Durable processor</strong><p>Pause or resume job claims without changing custody or payment.</p></div>{state.processorPaused ? <button className="primary" onClick={onResume}>Resume</button> : <button className="secondary" onClick={onPause}>Pause</button>}</div></div><div className="action-bar"><div><strong>Reset is run-scoped</strong><small>It deletes and reseeds only this run’s D1 rows and R2 prefix.</small></div><button className="secondary" disabled={busy === 'reset'} onClick={onReset}>Reset this demo run</button></div></section>;
}

function PublicInformationScreen({ screen, onNavigate }: { screen: 'evidence' | 'limitations'; onNavigate: (screen: Screen) => void }) {
  return <div className="app-shell public-shell"><Disclosure onOpen={() => onNavigate('limitations')} /><header className="app-header"><button className="brand-button" onClick={() => onNavigate('login')} aria-label="DARJ login"><Wordmark compact /></button><div className="header-context"><span className="mono">PUBLIC RECORD</span><strong>{screen === 'evidence' ? 'Evidence' : 'Limitations'}</strong><span>Independent prototype</span></div><button className="text-button" onClick={() => onNavigate('login')}>Demo login</button></header><main id="main-content" className="app-main">{screen === 'evidence' ? <EvidenceScreen /> : <LimitationsScreen />}</main><footer className="app-footer"><span>DARJ / दर्ज · independent filing-reliability prototype</span><nav aria-label="Footer"><button onClick={() => onNavigate('evidence')}>Evidence</button><button onClick={() => onNavigate('limitations')}>Limitations</button><button onClick={() => onNavigate('login')}>Demo login</button></nav></footer></div>;
}

function EvidenceScreen() {
  const sources = [
    ['Builder brief', 'Challenge scope and judging criteria', 'https://buildwhatmovesindia.com/brief'],
    ['MCA / PIB · 10 Feb 2026', 'Filing volume and helpdesk data', 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2226017&lang=1&reg=3'],
    ['Lok Sabha · Question 4954', 'AOC-4 and MGT-7/7A filing count', 'https://sansad.in/getFile/loksabhaquestions/annex/187/AU4954_vFAQV0.pdf?source=pqals'],
    ['MCA / PIB · 3 Feb 2025', 'Existing V3 capabilities, validation, status and MFA', 'https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=2099226&lang=2&reg=48'],
    ['ICSI · 6 May 2026', 'Stakeholder reports on drafts, uploads and generic errors', 'https://www.icsi.edu/media/webmodules/GCL/Functioning_of_MCA_21_V3_Portal_Issues_and_Challenges_faced_by_stakeholders.pdf'],
    ['ICSI · 12 Jun 2026', 'Reported data-centre incident and recovery difficulties', 'https://www.icsi.edu/media/webmodules/GCL/Request_for_relief_to_the_stakeholders_facing_practical_difficulties_due_to_fire_incidence_at_MCA_Data_Centre_site.pdf'],
    ['ICSI · 20 Dec 2025', 'Reported processing, SRN, upload and timeout issues', 'https://www.icsi.edu/media/webmodules/DCL/Functioning_of_MCA21_V3_Portal_Issues_and_Challenges_faced_by_stakeholders_20.12.2025.pdf'],
    ['RFC 8785', 'JSON Canonicalization Scheme', 'https://www.rfc-editor.org/rfc/rfc8785'],
    ['Controller of Certifying Authorities', 'India PKI and Certifying Authorities', 'https://cca.gov.in/ca_certificates.html'],
  ];
  return <section className="page-section narrow-page" aria-labelledby="evidence-title"><div className="page-heading"><div><p className="eyebrow">Source register</p><h1 id="evidence-title">Evidence, with attribution and limits.</h1></div><p>MCA21 V3 has substantial existing capability. Stakeholder representations also document specific reliability and recovery problems; neither fact cancels the other.</p></div><div className="evidence-list">{sources.map(([name, detail, url], index) => <a href={url} target="_blank" rel="noreferrer" key={name}><span className="mono">{String(index + 1).padStart(2, '0')}</span><div><strong>{name}</strong><p>{detail}</p></div><span aria-hidden="true">↗</span></a>)}</div><div className="boundary-note"><strong>Balanced claim</strong><p>These sources do not prove every MCA21 user experiences every reported issue, and DARJ does not claim that the entire portal is unreliable.</p></div></section>;
}

function LimitationsScreen() {
  const limitations = [
    'DARJ does not connect to MCA21 or any live government system. Nothing shown here is a real statutory filing.',
    'RECEIVED means this exact synthetic package is in DARJ custody. It is not MCA acknowledgement, legal filing, or acceptance.',
    'A DARJ receipt does not determine statutory timeliness. That is an authority and legal-policy question outside this prototype.',
    'DARJ does not replace a Digital Signature Certificate. The demo uses a synthetic signing adapter. Production use would require the applicable MCA and India PKI/CCA trust infrastructure.',
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
function formatTime(value?: string | null) { if (!value) return '—'; return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(value)) + ' IST'; }
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

function fieldLabel(path: string) {
  return ({ registeredOffice: 'Registered office', financialYear: 'Financial year', agmDate: 'Synthetic AGM date', boardMeetings: 'Board meetings', revenue: 'Revenue', expenses: 'Expenses', netProfit: 'Net profit', directorName: 'Synthetic director label' } as Record<string, string>)[path] ?? path;
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
  if (pathname === '/recovery') return 'recovery';
  if (pathname === '/filings') return 'filings';
  return 'login';
}

function pathForScreen(screen: Screen, caseId = 'SYN-CASE-AOC4-01') {
  return ({
    login: '/login', filings: '/filings', prepare: `/filings/${caseId}/prepare`, jaanch: `/filings/${caseId}/jaanch`,
    mohar: `/filings/${caseId}/mohar`, sign: `/filings/${caseId}/sign`, rasid: `/filings/${caseId}/rasid/SYN-RASID-8129`,
    status: `/filings/${caseId}/status`, recovery: '/recovery', evidence: '/evidence', limitations: '/limitations', demoControls: '/demo-controls',
  } satisfies Record<Screen, string>)[screen];
}
