'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Screen = 'login' | 'filings' | 'prepare' | 'jaanch' | 'mohar' | 'sign' | 'rasid' | 'status' | 'recovery' | 'evidence' | 'limitations';
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
  receipt: ReceiptRecord | null; payment: PaymentRecord | null; processorPaused: boolean; events: EventRecord[];
};
type DarjError = { code: string; stage: string; summary: string; detail: string; retryable: boolean; correlationId: string };

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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(API, { cache: 'no-store' });
    if (!response.ok) return null;
    const next = await response.json() as AppState;
    setState(next);
    if (next.draft) {
      const local = await readLocalDraft(next.caseId);
      const chosen = local && local.version >= next.draft.version ? local.form : next.draft.form;
      setForm(chosen);
    }
    return next;
  }, []);

  useEffect(() => {
    void (async () => {
      const restored = await refresh();
      if (restored) setScreen('filings');
    })();
  }, [refresh]);

  useEffect(() => {
    const onPop = () => {
      const next = (window.location.hash.slice(1) || (state ? 'filings' : 'login')) as Screen;
      setScreen(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [state]);

  const navigate = (next: Screen) => {
    setError(null);
    setNotice('');
    setScreen(next);
    window.history.pushState({}, '', next === 'login' ? '/' : `#${next}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  async function post(action: string, data: Record<string, unknown> = {}) {
    const response = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...data }),
    });
    const payload = await response.json() as Record<string, unknown> & { error?: DarjError };
    if (!response.ok) {
      if (payload.error) setError(payload.error);
      throw Object.assign(new Error(payload.error?.summary ?? 'DARJ request failed'), { darj: payload.error, status: response.status });
    }
    setError(null);
    return payload;
  }

  async function login() {
    setBusy('login');
    try {
      const next = await post('login', { email: 'priya@darj.demo', password: 'darj2026' }) as unknown as AppState;
      setState(next);
      if (next.draft) {
        setForm(next.draft.form);
        await writeLocalDraft(next.caseId, next.draft.version, next.draft.form);
      }
      navigate('filings');
    } finally { setBusy(''); }
  }

  function changeField(field: keyof FormShape, value: string) {
    if (!form || !state?.draft) return;
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
      await writeLocalDraft(state.caseId, baseVersion, next);
      setSaveState('Saved locally · Syncing…');
      const result = await post('saveDraft', { form: next, baseVersion }) as { version?: number; savedAt?: string };
      const version = Number(result.version ?? baseVersion);
      await writeLocalDraft(state.caseId, version, next);
      setState((current) => current ? { ...current, draft: { version, form: next, savedAt: String(result.savedAt ?? new Date().toISOString()) } } : current);
      setSaveState('Saved locally · Synced');
    } catch (caught) {
      const typed = caught as { darj?: DarjError };
      setSaveState(typed.darj?.code === 'DARJ_DRAFT_VERSION_CONFLICT' ? 'Conflict · Review required' : 'Saved locally · Offline');
    }
  }

  async function runChecks() {
    setBusy('jaanch');
    try {
      const result = await post('jaanch') as { issues?: CheckRecord[] };
      setChecks(result.issues ?? []);
      navigate('jaanch');
    } finally { setBusy(''); }
  }

  async function createMohar() {
    setBusy('seal');
    try {
      const packageRecord = await post('seal') as unknown as PackageRecord;
      setState((current) => current ? { ...current, package: packageRecord } : current);
      navigate('mohar');
    } finally { setBusy(''); }
  }

  async function sign() {
    setBusy('sign');
    try {
      const signature = await post('sign') as unknown as SignatureRecord;
      setState((current) => current ? { ...current, signature } : current);
      navigate('sign');
    } finally { setBusy(''); }
  }

  async function submit() {
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
    setBusy('payment');
    setNotice('Approving synthetic payment…');
    try {
      try {
        await post('approvePayment');
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
      if (next.draft) await writeLocalDraft(next.caseId, next.draft.version, next.draft.form);
      navigate('filings');
    } finally { setBusy(''); }
  }

  const blocking = checks.filter((check) => check.blocking);
  const passed = checks.filter((check) => !check.blocking);
  const accepted = state?.events.some((event) => event.eventType === 'ACCEPTED') ?? false;

  if (screen === 'login' || !state || !form) return <LoginScreen busy={busy === 'login'} onEnter={() => void login()} error={error} />;

  return (
    <div className="app-shell">
      <Disclosure onOpen={() => navigate('limitations')} />
      <AppHeader screen={screen} state={state} onNavigate={navigate} />
      <main id="main-content" className="app-main">
        {notice && <div className="notice" role="status" aria-live="polite"><span className="status-mark progress" />{notice}</div>}
        {error && <ErrorPanel error={error} />}

        {screen === 'filings' && <FilingsScreen state={state} onPrepare={() => navigate(resumeScreen(state))} onRecovery={() => navigate('recovery')} />}
        {screen === 'prepare' && (
          <PrepareScreen state={state} form={form} saveState={saveState} busy={busy} onChange={changeField} onJaanch={() => void runChecks()} />
        )}
        {screen === 'jaanch' && (
          <JaanchScreen checks={checks} blocking={blocking} passed={passed} busy={busy} onGoToField={() => {
            navigate('prepare'); setTimeout(() => document.getElementById('field-boardMeetings')?.focus(), 80);
          }} onRerun={() => void runChecks()} onSeal={() => void createMohar()} />
        )}
        {screen === 'mohar' && <MoharScreen state={state} busy={busy} onSign={() => void sign()} />}
        {screen === 'sign' && <SignScreen state={state} busy={busy} onSubmit={() => void submit()} />}
        {screen === 'rasid' && <RasidScreen state={state} busy={busy} onPay={() => void approvePayment()} onStatus={() => navigate('status')} />}
        {screen === 'status' && <StatusScreen state={state} accepted={accepted} busy={busy} onPause={() => void pauseProcessor()} onResume={() => void resumeProcessor()} />}
        {screen === 'recovery' && <RecoveryScreen state={state} onOpenMain={() => navigate('prepare')} />}
        {screen === 'evidence' && <EvidenceScreen />}
        {screen === 'limitations' && <LimitationsScreen />}
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

function LoginScreen({ busy, onEnter, error }: { busy: boolean; onEnter: () => void; error: DarjError | null }) {
  return (
    <main className="login-shell">
      <div className="prototype-strip">INDEPENDENT PROTOTYPE · SYNTHETIC DATA · NOT AN MCA SERVICE</div>
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
            <button type="button" onClick={onEnter} disabled={busy}>
              <span>{busy ? 'Preparing your filing room…' : 'Enter Priya’s filing'}</span>
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
      <div className="register-table" role="table" aria-label="Synthetic filing cases">
        <div className="register-table-head" role="row"><span>Folio</span><span>Company</span><span>Form / FY</span><span>Due state</span><span>Record state</span><span>Action</span></div>
        <div className="filing-row" role="row">
          <span data-label="Folio" className="mono">01 / A</span>
          <span data-label="Company"><strong>SYN — Aster Components Private Limited</strong><small>SYN-CIN-000117</small></span>
          <span data-label="Form / FY"><strong>AOC-4 prototype</strong><small>FY 2025-26</small></span>
          <span data-label="Due state"><strong>Due today</strong><small>28 Aug 2026 · 11:59 PM IST</small></span>
          <span data-label="Record state"><Status label={journeyLabel(state)} tone={state.receipt ? 'durable' : 'progress'} /><small>Draft v{state.draft?.version ?? 17} · {state.attachments.length} verified PDFs</small></span>
          <span data-label="Action"><button className="primary small" onClick={onPrepare}>{state.receipt ? 'View record' : 'Continue filing'} <span aria-hidden="true">→</span></button></span>
        </div>
        <div className="filing-row" role="row">
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

function PrepareScreen({ state, form, saveState, busy, onChange, onJaanch }: { state: AppState; form: FormShape; saveState: string; busy: string; onChange: (field: keyof FormShape, value: string) => void; onJaanch: () => void }) {
  return (
    <section className="prepare-grid" aria-labelledby="prepare-title">
      <aside className="section-index"><p className="eyebrow">Prepare</p><nav aria-label="Form sections"><a className="active" href="#company">01 Company</a><a href="#financials">02 Financials</a><a href="#governance">03 Governance</a><a href="#attachments">04 Attachments</a></nav></aside>
      <div className="form-column">
        <div className="page-heading compact-heading"><div><p className="eyebrow">Draft v{state.draft?.version ?? 17}</p><h1 id="prepare-title">Prepare AOC-4</h1></div><Status label={saveState} tone={saveState.includes('Offline') || saveState.includes('Conflict') ? 'attention' : saveState.includes('Syncing') ? 'progress' : 'durable'} /></div>
        <p className="scope-note">This is a limited DARJ prototype schema. It does not determine form applicability or legal compliance.</p>
        <form onSubmit={(event) => event.preventDefault()}>
          <fieldset id="company"><legend><span>01</span> Company record</legend><div className="field full"><label htmlFor="field-office">Registered office</label><p id="office-help">Pinned from synthetic company-master snapshot 7.</p><input id="field-office" value={form.registeredOffice} onChange={(e) => onChange('registeredOffice', e.target.value)} aria-describedby="office-help" /></div><div className="field"><label htmlFor="field-fy">Financial year</label><input id="field-fy" value={form.financialYear} onChange={(e) => onChange('financialYear', e.target.value)} /></div><div className="field"><label htmlFor="field-agm">Synthetic AGM date</label><input id="field-agm" type="date" value={form.agmDate} onChange={(e) => onChange('agmDate', e.target.value)} /></div></fieldset>
          <fieldset id="financials"><legend><span>02</span> Financial summary</legend><div className="field"><label htmlFor="field-revenue">Revenue (₹)</label><input id="field-revenue" inputMode="numeric" value={form.revenue} onChange={(e) => onChange('revenue', e.target.value)} /></div><div className="field"><label htmlFor="field-expenses">Expenses (₹)</label><input id="field-expenses" inputMode="numeric" value={form.expenses} onChange={(e) => onChange('expenses', e.target.value)} /></div><div className="field"><label htmlFor="field-profit">Net profit (₹)</label><input id="field-profit" inputMode="numeric" value={form.netProfit} onChange={(e) => onChange('netProfit', e.target.value)} /></div></fieldset>
          <fieldset id="governance"><legend><span>03</span> Governance</legend><div className="field"><label htmlFor="field-director">Synthetic director label</label><input id="field-director" value={form.directorName} onChange={(e) => onChange('directorName', e.target.value)} /></div><div className="field"><label htmlFor="field-boardMeetings">Board meetings</label><p id="meetings-help">Seeded with one deterministic issue for Jaanch.</p><input id="field-boardMeetings" inputMode="numeric" value={form.boardMeetings} onChange={(e) => onChange('boardMeetings', e.target.value)} aria-describedby="meetings-help" /></div></fieldset>
          <fieldset id="attachments"><legend><span>04</span> Verified attachments</legend><div className="attachment-list">{state.attachments.map((item) => <div className="attachment-row" key={item.slot}><span className="file-mark" aria-hidden="true">PDF</span><div><strong>{labelSlot(item.slot)}</strong><small>{item.filename} · {item.bytes} bytes</small></div><Status label="SERVER VERIFIED" tone="durable" /><code title={item.sha256}>{shortHash(item.sha256)}</code></div>)}</div></fieldset>
        </form>
        <div className="action-bar"><div><strong>{saveState}</strong><small>Last server sync {formatTime(state.draft?.savedAt)}</small></div><button className="primary" onClick={onJaanch} disabled={busy === 'jaanch'}>{busy === 'jaanch' ? 'Running 43 checks…' : 'Run Jaanch · जाँच'} <span aria-hidden="true">→</span></button></div>
      </div>
      <aside className="record-strip"><p className="eyebrow">Record strip</p><RecordLine label="Case" value="SYN-CASE-AOC4-01" /><RecordLine label="Version" value={`v${state.draft?.version ?? 17}`} /><RecordLine label="Local" value="Saved" tone="durable" /><RecordLine label="Server" value="Synced" tone="durable" /><RecordLine label="Files" value={`${state.attachments.length} / 3 verified`} tone="durable" /><RecordLine label="Master" value="Snapshot 7" /></aside>
    </section>
  );
}

function JaanchScreen({ checks, blocking, passed, busy, onGoToField, onRerun, onSeal }: { checks: CheckRecord[]; blocking: CheckRecord[]; passed: CheckRecord[]; busy: string; onGoToField: () => void; onRerun: () => void; onSeal: () => void }) {
  const total = checks.length || 43;
  return (
    <section className="page-section narrow-page" aria-labelledby="jaanch-title">
      <div className="page-heading"><div><p className="eyebrow">Jaanch · जाँच</p><h1 id="jaanch-title">{total} checks · {passed.length} passed · {blocking.length} needs attention</h1></div><p>Deterministic rules only · DARJ-RULES-1.1 · synthetic master snapshot 7</p></div>
      {blocking.length > 0 ? <div className="check-group" role="alert" tabIndex={-1}><h2><span className="status-mark attention" /> Needs attention</h2>{blocking.map((issue) => <article className="issue-panel" key={issue.code}><div className="issue-head"><code>{issue.code}</code><Status label="BLOCKS SEALING" tone="attention" /></div><h3>{issue.summary}</h3><p>{issue.detail}</p><dl><div><dt>Expected</dt><dd>{issue.expected}</dd></div><div><dt>Actual</dt><dd>{issue.actual}</dd></div><div><dt>Location</dt><dd>Governance / Board meetings</dd></div><div><dt>Retry safety</dt><dd>Safe after correcting this field</dd></div></dl><button className="secondary" onClick={onGoToField}>Go to exact field <span aria-hidden="true">→</span></button></article>)}</div> : <div className="all-clear"><span className="custody-mark mini" aria-hidden="true">✓</span><div><p className="eyebrow">Ready to seal</p><h2>All 43 deterministic checks passed.</h2><p>Jaanch does not decide legal compliance or the sufficiency of narrative disclosures.</p></div></div>}
      <details className="passed-checks"><summary>Passed <span>{passed.length} checks</span></summary><div className="check-list">{passed.map((check) => <div key={check.code}><code>{check.code}</code><span>{check.summary}</span><Status label="PASSED" tone="durable" /></div>)}</div></details>
      <details className="passed-checks"><summary>Not applicable <span>0 checks</span></summary><p>No rule was classified as not applicable for this seeded case.</p></details>
      <div className="action-bar"><div><strong>{blocking.length ? 'One issue blocks sealing' : 'Rule result fixed to this draft version'}</strong><small>Editing after this run makes Jaanch stale.</small></div>{blocking.length ? <button className="secondary" onClick={onRerun} disabled={busy === 'jaanch'}>Rerun Jaanch</button> : <button className="primary" onClick={onSeal} disabled={busy === 'seal'}>{busy === 'seal' ? 'Creating immutable package…' : 'Create Mohar · मुहर'} <span aria-hidden="true">→</span></button>}</div>
    </section>
  );
}

function MoharScreen({ state, busy, onSign }: { state: AppState; busy: string; onSign: () => void }) {
  const pkg = state.package;
  if (!pkg) return null;
  return <section className="page-section narrow-page" aria-labelledby="mohar-title"><div className="page-heading"><div><p className="eyebrow">Mohar · मुहर</p><h1 id="mohar-title">One immutable package is ready.</h1></div><Status label="SEALED" tone="durable" /></div><div className="package-index"><div className="package-title"><span className="custody-mark" aria-hidden="true">◇</span><div><small>Package</small><h2>{pkg.packageId} · v{pkg.version}</h2><p>Created {formatTime(pkg.sealedAt)}</p></div></div><dl><RecordDefinition label="Form data" value={`${Object.keys(state.draft?.form ?? {}).length} normalised fields`} /><RecordDefinition label="Attachments" value={`${state.attachments.length} server-verified PDF manifests`} /><RecordDefinition label="Rule version" value="DARJ-RULES-1.1" /><RecordDefinition label="Master snapshot" value="Synthetic company master · v7" /><RecordDefinition label="Hash standard" value="RFC 8785 semantics · SHA-256" /></dl><div className="hash-block"><span>Full package hash</span><code>{pkg.hash}</code><CopyButton value={pkg.hash} /></div></div><div className="boundary-note"><strong>Sealing boundary</strong><p>Further editing creates a new version. It cannot change this package or its hash.</p></div><div className="action-bar"><div><strong>Package stored append-only</strong><small>The server recomputed this hash from authoritative data.</small></div><button className="primary" onClick={onSign} disabled={busy === 'sign'}>{busy === 'sign' ? 'Preparing synthetic signature…' : 'Continue to synthetic sign'} <span aria-hidden="true">→</span></button></div></section>;
}

function SignScreen({ state, busy, onSubmit }: { state: AppState; busy: string; onSubmit: () => void }) {
  const signature = state.signature;
  const pkg = state.package;
  if (!signature || !pkg) return null;
  return <section className="page-section narrow-page" aria-labelledby="sign-title"><div className="demo-banner">DEMO SIGNATURE · NOT A DIGITAL SIGNATURE CERTIFICATE</div><div className="page-heading"><div><p className="eyebrow">Synthetic sign</p><h1 id="sign-title">The signature is bound to this package hash.</h1></div><Status label="SIGNED" tone="durable" /></div><div className="signature-register"><RecordDefinition label="Signer label" value="Priya Shah · synthetic authorised filer" /><RecordDefinition label="Provider" value={signature.provider} /><RecordDefinition label="Package" value={`${pkg.packageId} · v${pkg.version}`} /><RecordDefinition label="Signed hash" value={signature.signedHash} mono /><RecordDefinition label="Signature ID" value={signature.signatureId} mono /><RecordDefinition label="Signed at" value={formatTime(signature.signedAt)} /></div><div className="boundary-note"><strong>This is not a DSC</strong><p>Production filing may require valid, registered Digital Signature Certificates and India PKI/CCA trust infrastructure. DARJ does not reproduce or replace it.</p></div><div className="action-bar"><div><strong>Custody happens before payment</strong><small>Retrying the same exact package cannot create a second Rasid.</small></div><button className="primary" onClick={onSubmit} disabled={busy === 'submit'}>{busy === 'submit' ? 'Submitting retry-safely…' : 'Submit exact package'} <span aria-hidden="true">→</span></button></div></section>;
}

function RasidScreen({ state, busy, onPay, onStatus }: { state: AppState; busy: string; onPay: () => void; onStatus: () => void }) {
  const receipt = state.receipt;
  if (!receipt) return null;
  const paid = state.payment?.state === 'PAID';
  return <section className="page-section receipt-page" aria-labelledby="rasid-title"><div className="page-heading"><div><p className="eyebrow">Rasid · रसीद</p><h1 id="rasid-title">The exact package is in DARJ custody.</h1></div><button className="secondary print-button" onClick={() => window.print()}>Print / save receipt</button></div><article className="receipt"><header><Wordmark compact /><div><span>RASID 8129</span><small>INDEPENDENT PROTOTYPE · SYNTHETIC DATA</small></div></header><div className="receipt-hero"><div className="custody-mark" aria-hidden="true">✓</div><div><p>RECEIVED INTO DARJ CUSTODY</p><time dateTime={receipt.receivedAt}>{formatReceiptTime(receipt.receivedAt)}</time></div></div><dl><RecordDefinition label="Receipt" value={receipt.receiptId} mono /><RecordDefinition label="Package" value={`${receipt.packageId} · v23`} mono /><RecordDefinition label="Package hash" value={receipt.packageHash} mono /><RecordDefinition label="Form" value="AOC-4 prototype · FY 2025-26" /><RecordDefinition label="Company" value="SYN — Aster Components Private Limited" /></dl><p className="receipt-disclaimer">This receipt proves this exact synthetic package entered DARJ custody at this time. It is not MCA acknowledgement, legal acceptance, or proof of statutory timeliness.</p></article><div className="state-separation"><div><span className="status-mark durable" /><div><small>Custody</small><strong>RECEIVED</strong><p>Immutable Rasid recorded.</p></div></div><div><span className={`status-mark ${paid ? 'durable' : 'progress'}`} /><div><small>Payment</small><strong>{paid ? 'PAID · RECONCILED' : 'PENDING'}</strong><p>{paid ? 'Synthetic approval recorded server-side.' : 'Separate synthetic payment intent.'}</p></div></div><div><span className="status-mark progress" /><div><small>Processing</small><strong>{paid ? 'QUEUED' : 'WAITING FOR PAYMENT'}</strong><p>Receipt is not acceptance.</p></div></div></div>{!paid ? <div className="payment-panel"><div className="demo-banner">PAYMENT SIMULATION · NO MONEY OR PAYMENT DETAILS</div><div className="payment-body"><div><p className="eyebrow">Synthetic fee</p><strong className="amount">₹6,000.00</strong><p>No card, UPI, bank, OTP, or personal data is collected.</p></div><button className="primary" onClick={onPay} disabled={busy === 'payment'}>{busy === 'payment' ? 'Reconciling…' : 'Approve simulated payment'} <span aria-hidden="true">→</span></button></div></div> : <div className="action-bar"><div><strong>Payment reconciled from the server</strong><small>PAID is not ACCEPTED. Processing remains separate.</small></div><button className="primary" onClick={onStatus}>Track processing <span aria-hidden="true">→</span></button></div>}</section>;
}

function StatusScreen({ state, accepted, busy, onPause, onResume }: { state: AppState; accepted: boolean; busy: string; onPause: () => void; onResume: () => void }) {
  const displayEvents = state.events.filter((event) => ['RECEIVED', 'PAID', 'PROCESSING_DELAYED', 'PROCESSING_RESUMED', 'PROCESSING', 'ACCEPTED'].includes(event.eventType));
  return <section className="page-section narrow-page" aria-labelledby="status-title"><div className="page-heading"><div><p className="eyebrow">Processing register</p><h1 id="status-title">{accepted ? 'ACCEPTED' : state.processorPaused ? 'PROCESSING DELAYED' : 'PAID · QUEUED'}</h1></div><Status label={accepted ? 'ACCEPTED' : state.processorPaused ? 'DELAYED' : 'QUEUED'} tone={accepted ? 'durable' : state.processorPaused ? 'attention' : 'progress'} /></div>{state.processorPaused && <div className="delay-panel"><span className="status-mark attention" /><div><strong>Processing is delayed. Do not resubmit or pay again.</strong><p>The exact package remains RECEIVED and the synthetic payment remains PAID. The worker pause affects only processing.</p></div></div>}<ol className="event-register">{displayEvents.map((event) => <li key={event.seq} className={event.eventType.toLowerCase()}><span className={`event-icon ${eventTone(event.eventType)}`} aria-hidden="true">{eventGlyph(event.eventType)}</span><div><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time></div><p>{event.detail}</p><small>Actor: {event.actor}</small></div></li>)}</ol><div className="status-invariant"><strong>RECEIVED ≠ PAID ≠ PROCESSING ≠ ACCEPTED</strong><p>Each transition has its own durable event and meaning. Time passing alone never promotes custody into acceptance.</p></div>{!accepted && <div className="action-bar"><div><strong>{state.processorPaused ? 'The queue can resume safely' : 'Demonstrate an outage before acceptance'}</strong><small>No action here can duplicate the package or receipt.</small></div>{state.processorPaused ? <button className="primary" onClick={onResume} disabled={busy === 'processor'}>{busy === 'processor' ? 'Resuming…' : 'Resume and finish processing'} <span aria-hidden="true">→</span></button> : <button className="secondary" onClick={onPause} disabled={busy === 'processor'}>Pause processor</button>}</div>}</section>;
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
  if (state.signature) return 'SIGNED';
  if (state.package) return 'SEALED';
  return 'EDITING · LOCALLY DURABLE';
}

function resumeScreen(state: AppState): Screen {
  if (state.events.some((event) => event.eventType === 'ACCEPTED') || state.payment?.state === 'PAID') return 'status';
  if (state.receipt) return 'rasid';
  if (state.signature) return 'sign';
  if (state.package) return 'mohar';
  return 'prepare';
}

function eventTone(type: string) { return type === 'PROCESSING_DELAYED' ? 'attention' : type === 'PROCESSING' || type === 'PROCESSING_RESUMED' ? 'progress' : 'durable'; }
function eventGlyph(type: string) { if (type === 'PROCESSING_DELAYED') return '!'; if (type === 'PROCESSING') return '↻'; if (type === 'ACCEPTED') return '✓'; if (type === 'PAID') return '₹'; return '◇'; }
function labelSlot(slot: string) { return ({ financialStatements: 'Financial statements', auditorReport: 'Auditor’s report', boardReport: 'Board report' } as Record<string, string>)[slot] ?? slot; }
function shortHash(hash: string) { return `${hash.slice(0, 9)}…${hash.slice(-7)}`; }
function formatTime(value?: string | null) { if (!value) return '—'; return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(value)) + ' IST'; }
function formatReceiptTime(value: string) { return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date(value)).toUpperCase() + ' IST'; }
function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function openLocalDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('darj-local-v1', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openLocalDb();
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction('records', 'readonly').objectStore('records').get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}

async function localPut(key: string, value: unknown) {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction('records', 'readwrite').objectStore('records').put(value, key);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

async function readLocalDraft(caseId: string) { return localGet<{ version: number; form: FormShape }>(`draft:${caseId}`); }
async function writeLocalDraft(caseId: string, version: number, form: FormShape) { return localPut(`draft:${caseId}`, { version, form, savedAt: new Date().toISOString() }); }
async function clearLocalDraft(caseId: string) {
  try { const db = await openLocalDb(); db.transaction('records', 'readwrite').objectStore('records').delete(`draft:${caseId}`); } catch { /* local recovery remains best effort */ }
}
async function getOrCreateIdempotencyKey(caseId: string) {
  const key = `idempotency:${caseId}`;
  const existing = await localGet<string>(key);
  if (existing) return existing;
  const next = crypto.randomUUID(); await localPut(key, next); return next;
}
