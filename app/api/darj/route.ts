import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { canonicalize, sha256Hex } from '@/lib/canonical';
import { buildDarjReceiptPdf, buildTextPdf, MAX_DEMO_PDF_BYTES, sniffDemoPdf } from '@/lib/pdf';
import { containsRealLookingSensitiveIdentifier } from '@/lib/security';
import { signPackageHash, verifyPackageSignature } from '@/lib/demo-signature.server';
import { emptyStudioState, extractStudioState, validateStudioEvidence, type StudioRole, type StudioScenario, type StudioState } from '@/lib/guided-filing';

export const dynamic = 'force-dynamic';

const COOKIE_NAME = 'darj_demo_run';
const CSRF_COOKIE_NAME = 'darj_csrf';
const CASE_ID = 'DARJ-DEMO-AOC4-01';
const DEMO_EMAIL = 'meet@darj.demo';
const DEMO_PASSWORD = 'darj2026';
const TUS_UPLOAD_PATH = '/api/darj/uploads';
const ALLOWED_SLOTS = new Set(['financialStatements', 'auditorReport', 'boardReport']);
const FEATURE_DEFAULTS = {
  resumableUploads: true,
  masterDrift: true,
  correctionLineage: true,
  recoveryCase: true,
};

const STARTABLE_SERVICES = {
  'AOC-4': 'Financial statements',
  'MGT-7': 'Annual return',
  'DIR-3 KYC': 'Director KYC',
  'DIR-12': 'Director or key managerial change',
  'CHG-1': 'Create or modify a charge',
} as const;

function featureFlags() {
  const bindings = env as unknown as Record<string, unknown>;
  const enabled = (name: string, fallback: boolean) => bindings[name] === undefined ? fallback : String(bindings[name]).toLowerCase() !== 'false';
  return {
    resumableUploads: enabled('FEATURE_RESUMABLE_UPLOADS', FEATURE_DEFAULTS.resumableUploads),
    masterDrift: enabled('FEATURE_MASTER_DRIFT', FEATURE_DEFAULTS.masterDrift),
    correctionLineage: enabled('FEATURE_CORRECTION_LINEAGE', FEATURE_DEFAULTS.correctionLineage),
    recoveryCase: enabled('FEATURE_RECOVERY_CASE', FEATURE_DEFAULTS.recoveryCase),
  };
}

const INITIAL_FORM = {
  registeredOffice: '14, Demo Business Park, Ahmedabad, Gujarat 380015',
  financialYear: '2025-26',
  agmDate: '2026-07-29',
  boardMeetings: '3',
  revenue: '124800000',
  expenses: '118250000',
  netProfit: '6550000',
  directorName: 'Meet Vekaria',
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS demo_runs (
    run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    processor_paused INTEGER NOT NULL DEFAULT 0,
    lose_submission INTEGER NOT NULL DEFAULT 1,
    lose_payment INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS draft_snapshots (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, version INTEGER NOT NULL,
    base_version INTEGER, form_json TEXT NOT NULL, changed_paths TEXT NOT NULL,
    saved_at TEXT NOT NULL, PRIMARY KEY (run_id, case_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS service_drafts (
    run_id TEXT NOT NULL, filing_id TEXT NOT NULL, form_code TEXT NOT NULL,
    title TEXT NOT NULL, financial_year TEXT NOT NULL, applicant_name TEXT NOT NULL,
    note TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, filing_id)
  )`,
  `CREATE TABLE IF NOT EXISTS guided_filing_sessions (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id)
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, slot TEXT NOT NULL,
    filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL,
    mime TEXT NOT NULL, sha256 TEXT NOT NULL, verified_at TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS attachment_versions (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, slot TEXT NOT NULL, version INTEGER NOT NULL,
    filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL,
    mime TEXT NOT NULL, sha256 TEXT NOT NULL, verified_at TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id, slot, version)
  )`,
  `CREATE TABLE IF NOT EXISTS upload_sessions (
    run_id TEXT NOT NULL, upload_id TEXT NOT NULL, case_id TEXT NOT NULL, slot TEXT NOT NULL,
    filename TEXT NOT NULL, expected_bytes INTEGER NOT NULL, confirmed_offset INTEGER NOT NULL DEFAULT 0,
    client_sha256 TEXT NOT NULL, fingerprint TEXT NOT NULL, object_key TEXT NOT NULL,
    provider_upload_id TEXT, uploaded_parts_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY (run_id, upload_id), UNIQUE (upload_id)
  )`,
  `CREATE TABLE IF NOT EXISTS case_master_state (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, pinned_version INTEGER NOT NULL, pinned_office TEXT NOT NULL,
    current_version INTEGER NOT NULL, current_office TEXT NOT NULL, source TEXT NOT NULL, review_state TEXT NOT NULL,
    detected_at TEXT, reviewed_at TEXT, PRIMARY KEY (run_id, case_id)
  )`,
  `CREATE TABLE IF NOT EXISTS filing_packages (
    run_id TEXT NOT NULL, package_id TEXT NOT NULL, case_id TEXT NOT NULL,
    version INTEGER NOT NULL, canonical_payload TEXT NOT NULL, package_hash TEXT NOT NULL,
    rule_version TEXT NOT NULL, sealed_at TEXT NOT NULL,
    PRIMARY KEY (run_id, package_id), UNIQUE (run_id, case_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS synthetic_signatures (
    run_id TEXT NOT NULL, signature_id TEXT NOT NULL, package_id TEXT NOT NULL,
    provider TEXT NOT NULL, signed_hash TEXT NOT NULL, signature_value TEXT NOT NULL,
    signed_at TEXT NOT NULL, PRIMARY KEY (run_id, signature_id), UNIQUE (run_id, package_id)
  )`,
  `CREATE TABLE IF NOT EXISTS package_lineage (
    run_id TEXT NOT NULL, child_package_id TEXT NOT NULL, parent_package_id TEXT NOT NULL,
    reason TEXT NOT NULL, changed_paths_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, child_package_id), UNIQUE (run_id, parent_package_id, child_package_id)
  )`,
  `CREATE TABLE IF NOT EXISTS correction_requests (
    run_id TEXT NOT NULL, request_id TEXT NOT NULL, case_id TEXT NOT NULL, source_package_id TEXT NOT NULL,
    document_slot TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL, child_package_id TEXT,
    created_at TEXT NOT NULL, resolved_at TEXT,
    PRIMARY KEY (run_id, request_id), UNIQUE (run_id, source_package_id)
  )`,
  `CREATE TABLE IF NOT EXISTS custody_submissions (
    run_id TEXT NOT NULL, custody_id TEXT NOT NULL, package_id TEXT NOT NULL,
    canonical_payload TEXT NOT NULL, package_hash TEXT NOT NULL, received_at TEXT NOT NULL,
    PRIMARY KEY (run_id, custody_id), UNIQUE (run_id, package_id)
  )`,
  `CREATE TABLE IF NOT EXISTS receipts (
    run_id TEXT NOT NULL, receipt_id TEXT NOT NULL, custody_id TEXT NOT NULL,
    package_id TEXT NOT NULL, package_hash TEXT NOT NULL, received_at TEXT NOT NULL,
    PRIMARY KEY (run_id, receipt_id), UNIQUE (run_id, custody_id), UNIQUE (run_id, package_id),
    FOREIGN KEY (run_id, custody_id) REFERENCES custody_submissions(run_id, custody_id)
  )`,
  `CREATE TABLE IF NOT EXISTS submission_attempts (
    run_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    package_id TEXT NOT NULL, receipt_id TEXT, outcome TEXT NOT NULL, attempted_at TEXT NOT NULL,
    PRIMARY KEY (run_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS payment_intents (
    run_id TEXT NOT NULL, payment_id TEXT NOT NULL, custody_id TEXT NOT NULL,
    state TEXT NOT NULL, amount_paise INTEGER NOT NULL, reconciliation_reference TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (run_id, payment_id), UNIQUE (run_id, custody_id)
  )`,
  `CREATE TABLE IF NOT EXISTS payment_events (
    run_id TEXT NOT NULL, provider_event_id TEXT NOT NULL, payment_id TEXT NOT NULL,
    event_type TEXT NOT NULL, received_at TEXT NOT NULL,
    PRIMARY KEY (run_id, provider_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS payment_attempts (
    run_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payment_id TEXT NOT NULL,
    outcome TEXT NOT NULL, attempted_at TEXT NOT NULL,
    PRIMARY KEY (run_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS processing_jobs (
    run_id TEXT NOT NULL, job_id TEXT NOT NULL, custody_id TEXT NOT NULL,
    state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL, locked_at TEXT, last_error_code TEXT,
    PRIMARY KEY (run_id, job_id), UNIQUE (run_id, custody_id)
  )`,
  `CREATE TABLE IF NOT EXISTS case_events (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, seq INTEGER NOT NULL,
    event_type TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, occurred_at TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS fault_injections (
    run_id TEXT NOT NULL, flag TEXT NOT NULL, remaining INTEGER NOT NULL,
    PRIMARY KEY (run_id, flag)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key_hash TEXT PRIMARY KEY, window_start TEXT NOT NULL, request_count INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_latest ON draft_snapshots(run_id, case_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(run_id, case_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_state ON processing_jobs(run_id, state, available_at)`,
  `CREATE INDEX IF NOT EXISTS idx_upload_slot ON upload_sessions(run_id, case_id, slot, state)`,
  `CREATE INDEX IF NOT EXISTS idx_attachment_versions_slot ON attachment_versions(run_id, case_id, slot, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_service_drafts_run_updated ON service_drafts(run_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_guided_filing_updated ON guided_filing_sessions(run_id, updated_at DESC)`,
];

type FormDataShape = typeof INITIAL_FORM;
type JsonBody = Record<string, unknown>;
type DatabaseRow = Record<string, unknown>;
type AttachmentRow = { slot: string; version: number; filename: string; objectKey: string; bytes: number; mime: string; sha256: string; verifiedAt: string };
type SeedDocument = { slot: string; filename: string; objectKey: string; bytes: Uint8Array; hash: string };
type ValidationCheck = {
  code: string; stage: string; fieldPath: string | null; documentSlot: string | null;
  blocking: boolean; retryable: boolean; status: string; summary: string; detail: string;
  ruleVersion: string; expected?: string; actual?: string;
};

export async function GET(request: Request) {
  await initializeDatabase();
  const runId = readRunId(request);
  if (!runId) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Enter the DARJ workspace to continue.', false, 401);
  if (!(await getRun(runId))) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'This review session has expired. Your local draft is unchanged.', true, 401);
  const exportKind = new URL(request.url).searchParams.get('export');
  if (exportKind) return exportStudioArtifact(runId, exportKind);
  return securedJson(await getState(runId));
}

export async function POST(request: Request) {
  await initializeDatabase();
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const runId = await authorizeMutation(request, 'UPLOAD');
    if (runId instanceof NextResponse) return runId;
    return handleUpload(request, runId);
  }

  let body: JsonBody;
  try { body = (await request.json()) as JsonBody; }
  catch { return errorResponse('DARJ_UNKNOWN_RESPONSE', 'UNKNOWN', 'DARJ could not reliably interpret this response. No correction has been suggested. Your saved work is unchanged.', false, 400); }
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'login') return login(body, request);

  const runId = await authorizeMutation(request, action === 'saveDraft' ? 'DRAFT' : 'SUBMISSION');
  if (runId instanceof NextResponse) return runId;

  try {
    switch (action) {
      case 'saveDraft': return await saveDraft(runId, body);
      case 'startService': return await startService(runId, body);
      case 'openStudio': return await openStudio(runId, body);
      case 'updateStudio': return await updateStudio(runId, body);
      case 'jaanch': return await runJaanch(runId);
      case 'seal': return await sealPackage(runId);
      case 'sign': return await signPackage(runId);
      case 'submit': return await submitPackage(runId, body);
      case 'approvePayment': return await approvePayment(runId, body);
      case 'setProcessor': return await setProcessor(runId, body.processorPaused === true);
      case 'process': return await processPackage(runId);
      case 'logout': return logout(request);
      case 'reset': return await resetRun(runId);
      case 'setRecovery': return await setRecoveryFlag(runId, body);
      case 'acceptMaster': return await acceptMasterSnapshot(runId);
      case 'keepPinnedMaster': return await keepPinnedMaster(runId);
      case 'requestCorrection': return await requestCorrection(runId);
      case 'createCorrection': return await createCorrectionPackage(runId);
      case 'consumeUploadPause': return securedJson({ consumed: await consumeFault(runId, 'pause_upload') });
      default: return errorResponse('DARJ_UNKNOWN_RESPONSE', 'UNKNOWN', 'DARJ could not reliably interpret this response. No correction has been suggested. Your saved work is unchanged.', false, 400);
    }
  } catch (caught) { return domainError(caught); }
}

let databaseInitialization: Promise<void> | null = null;

async function initializeDatabase() {
  // Sites applies the packaged Drizzle migrations before the production worker is
  // published. Replaying every DDL statement on each request adds avoidable D1
  // round trips and lock contention. The fallback remains for an uninitialised
  // local development database and is cached for the lifetime of the worker.
  if (process.env.NODE_ENV === 'production') return;
  if (!databaseInitialization) {
    databaseInitialization = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)))
      .then(() => undefined)
      .catch((error: unknown) => {
        databaseInitialization = null;
        throw error;
      });
  }
  await databaseInitialization;
}

async function authorizeMutation(request: Request, stage: string): Promise<string | NextResponse> {
  const runId = readRunId(request);
  if (!runId || !(await getRun(runId))) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Re-enter the DARJ workspace. Your local draft is unchanged.', true, 401);
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin && requestOrigin !== new URL(request.url).origin) return errorResponse('DARJ_AUTH_REQUIRED', stage, 'The request origin could not be verified.', false, 403);
  const csrfHeader = request.headers.get('x-darj-csrf');
  const csrfCookie = readCookie(request, CSRF_COOKIE_NAME);
  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) return errorResponse('DARJ_AUTH_REQUIRED', stage, 'The secure request token is missing or expired. Re-enter the workspace.', false, 403);
  return runId;
}

async function login(body: JsonBody, request: Request) {
  const clientKey = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local';
  if (!(await consumeRateLimit(`login:${clientKey}`, 60, 60_000))) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Too many login attempts. Wait one minute and try again.', true, 429);
  if (body.email !== DEMO_EMAIL || body.password !== DEMO_PASSWORD) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Use the credentials shown on this page.', true, 401);
  const runId = `run-${crypto.randomUUID()}`;
  const csrfToken = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const seeded = await seedRun(runId, { createdAt: now.toISOString(), expiresAt: expires.toISOString() });
  const response = securedJson(initialState(runId, seeded.savedAt, seeded.attachments, seeded.studio));
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(runId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`);
  response.headers.append('Set-Cookie', `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; Max-Age=86400${secure}`);
  return response;
}

function logout(request: Request) {
  const response = securedJson({ signedOut: true });
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  response.headers.append('Set-Cookie', `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Strict; Max-Age=0${secure}`);
  return response;
}

async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const keyHash = await sha256Hex(new TextEncoder().encode(key));
  const now = new Date().toISOString();
  // Keep the rate-limit decision atomic and avoid a separate read before login.
  const row = await env.DB.prepare(`INSERT INTO rate_limits (key_hash, window_start, request_count) VALUES (?, ?, 1)
    ON CONFLICT(key_hash) DO UPDATE SET
      request_count = CASE WHEN (unixepoch(excluded.window_start) - unixepoch(rate_limits.window_start)) * 1000 < ? THEN rate_limits.request_count + 1 ELSE 1 END,
      window_start = CASE WHEN (unixepoch(excluded.window_start) - unixepoch(rate_limits.window_start)) * 1000 < ? THEN rate_limits.window_start ELSE excluded.window_start END
    RETURNING request_count`).bind(keyHash, now, windowMs, windowMs).first();
  return Number(row?.request_count ?? limit + 1) <= limit;
}

async function buildSeedDocuments(runId: string): Promise<SeedDocument[]> {
  const files = [
    ['financialStatements', 'DARJ-financial-statements.pdf', [
      'Audited financial statements',
      'DARJ_FIELD companyName=Aster Components Private Limited',
      'DARJ_FIELD cin=DARJ-CIN-000117',
      'DARJ_FIELD financialYear=2025-26',
      'DARJ_FIELD revenue=124800000',
      'DARJ_FIELD expenses=118250000',
      'DARJ_FIELD netProfit=6550000',
    ].join('\n')],
    ['auditorReport', 'DARJ-auditor-report.pdf', [
      'Independent auditor report',
      'DARJ_FIELD companyName=Aster Components Private Limited',
      'DARJ_FIELD financialYear=2025-26',
      'DARJ_FIELD auditorName=K R Shah and Company, Chartered Accountants',
    ].join('\n')],
    ['boardReport', 'DARJ-board-report.pdf', [
      'Board report and authorization',
      'DARJ_FIELD companyName=Aster Components Private Limited',
      'DARJ_FIELD financialYear=2025-26',
      'DARJ_FIELD agmDate=2026-07-29',
      'DARJ_FIELD boardMeetings=4',
      'DARJ_FIELD directorName=Meet Vekaria',
    ].join('\n')],
  ] as const;
  return Promise.all(files.map(async ([slot, filename, content]) => {
    const bytes = new TextEncoder().encode(`%PDF-1.4\n% DARJ fictional filing document\n1 0 obj<</Type/Catalog>>endobj\n${content}\n%%EOF`);
    return { slot, filename, objectKey: `demo/${runId}/${CASE_ID}/${slot}.pdf`, bytes, hash: await sha256Hex(bytes) };
  }));
}

async function seedRun(runId: string, run?: { createdAt: string; expiresAt: string }) {
  const savedAt = new Date().toISOString();
  const documents = await buildSeedDocuments(runId);
  const studio = emptyStudioState(savedAt);
  await env.DB.batch([
    ...(run ? [env.DB.prepare('INSERT INTO demo_runs (run_id, created_at, expires_at) VALUES (?, ?, ?)').bind(runId, run.createdAt, run.expiresAt)] : []),
    env.DB.prepare(`INSERT INTO draft_snapshots (run_id, case_id, version, base_version, form_json, changed_paths, saved_at) VALUES (?, ?, 17, 16, ?, ?, ?)`)
      .bind(runId, CASE_ID, JSON.stringify(INITIAL_FORM), JSON.stringify([]), savedAt),
    env.DB.prepare(`INSERT INTO case_master_state (run_id, case_id, pinned_version, pinned_office, current_version, current_office, source, review_state)
      VALUES (?, ?, 7, ?, 7, ?, 'Sample company master', 'CURRENT')`)
      .bind(runId, CASE_ID, INITIAL_FORM.registeredOffice, INITIAL_FORM.registeredOffice),
    env.DB.prepare(`INSERT INTO guided_filing_sessions (run_id, case_id, state_json, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(runId, CASE_ID, JSON.stringify(studio), savedAt),
    ...documents.map((document) => env.DB.prepare(`INSERT INTO attachments (run_id, case_id, slot, filename, object_key, bytes, mime, sha256, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)`)
      .bind(runId, CASE_ID, document.slot, document.filename, document.objectKey, document.bytes.byteLength, document.hash, savedAt)),
    ...documents.map((document) => env.DB.prepare(`INSERT INTO attachment_versions (run_id, case_id, slot, version, filename, object_key, bytes, mime, sha256, verified_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'application/pdf', ?, ?)`)
      .bind(runId, CASE_ID, document.slot, document.filename, document.objectKey, document.bytes.byteLength, document.hash, savedAt)),
  ]);
  return {
    savedAt, studio,
    attachments: documents.map((document) => ({ slot: document.slot, version: 1, filename: document.filename, objectKey: document.objectKey, bytes: document.bytes.byteLength, mime: 'application/pdf', sha256: document.hash, verifiedAt: savedAt })),
  };
}

function initialState(runId: string, savedAt: string, attachments: AttachmentRow[], studio = emptyStudioState(savedAt)) {
  return {
    runId, caseId: CASE_ID,
    draft: { version: 17, form: INITIAL_FORM, savedAt },
    attachments: attachments.map((attachment) => ({ slot: attachment.slot, version: attachment.version, filename: attachment.filename, bytes: attachment.bytes, mime: attachment.mime, sha256: attachment.sha256, verifiedAt: attachment.verifiedAt })),
    attachmentVersions: attachments.map((attachment) => ({ slot: attachment.slot, version: attachment.version, filename: attachment.filename, bytes: attachment.bytes, mime: attachment.mime, sha256: attachment.sha256, verifiedAt: attachment.verifiedAt, current: true })),
    package: null, packageCurrent: false,
    signature: null, signatureValid: false,
    receipt: null, payment: null, processingJob: null,
    processorPaused: false, uploadPauseArmed: false, uploadSessions: [],
    master: {
      pinnedVersion: 7, pinnedOffice: INITIAL_FORM.registeredOffice,
      currentVersion: 7, currentOffice: INITIAL_FORM.registeredOffice,
      source: 'Sample company master', reviewState: 'CURRENT', detectedAt: null, reviewedAt: null,
    },
    correction: null, lineage: [], features: featureFlags(), events: [], serviceDrafts: [], studio,
  };
}

async function saveDraft(runId: string, body: JsonBody) {
  const form = body.form as FormDataShape | undefined;
  const baseVersion = Number(body.baseVersion);
  if (!form || !isValidForm(form) || !Number.isInteger(baseVersion)) throw new Error('DARJ_DRAFT_VERSION_CONFLICT|The draft version or schema could not be verified.');
  if (containsRealLookingSensitiveIdentifier(form)) throw new Error('DARJ_DEMO_DATA_REQUIRED|Real-looking Aadhaar, PAN, or CIN patterns are rejected in this demo.');
  const latest = await latestDraft(runId);
  if (!latest || Number(latest.version) !== baseVersion) {
    const serverForm = latest ? JSON.parse(String(latest.form_json)) as FormDataShape : INITIAL_FORM;
    const changedPaths = Object.keys(form).filter((key) => form[key as keyof FormDataShape] !== serverForm[key as keyof FormDataShape]);
    return errorResponse('DARJ_DRAFT_VERSION_CONFLICT', 'DRAFT', 'A newer server draft exists. Compare the changed fields before continuing.', false, 409, {
      expected: { baseVersion }, actual: { serverVersion: Number(latest?.version ?? 0) }, fieldPath: changedPaths[0] ?? 'formData',
      serverDraft: { version: Number(latest?.version ?? 0), form: serverForm, savedAt: String(latest?.saved_at ?? '') }, changedPaths,
    });
  }
  const nextVersion = baseVersion + 1;
  const previousForm = JSON.parse(String(latest.form_json)) as FormDataShape;
  const changedPaths = Object.keys(form).filter((key) => form[key as keyof FormDataShape] !== previousForm[key as keyof FormDataShape]);
  const savedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO draft_snapshots (run_id, case_id, version, base_version, form_json, changed_paths, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(runId, CASE_ID, nextVersion, baseVersion, JSON.stringify(form), JSON.stringify(changedPaths), savedAt).run();
  if (changedPaths.length > 0 && await latestPackage(runId)) await appendUniqueEvent(runId, 'SIGNATURE_INVALID', 'DARJ', 'A later draft changed the package input. The prior test signature cannot sign the new version.');
  return securedJson({ version: nextVersion, savedAt, changedPaths });
}

async function startService(runId: string, body: JsonBody) {
  const formCode = typeof body.formCode === 'string' ? body.formCode.trim() : '';
  const title = STARTABLE_SERVICES[formCode as keyof typeof STARTABLE_SERVICES];
  const financialYear = typeof body.financialYear === 'string' ? body.financialYear.trim() : '';
  const applicantName = typeof body.applicantName === 'string' ? body.applicantName.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!title || !/^20\d{2}-\d{2}$/u.test(financialYear) || applicantName.length < 2 || applicantName.length > 80 || note.length > 300) {
    return errorResponse('DARJ_SERVICE_START_INVALID', 'DRAFT', 'Check the service, financial year and contact name before creating this filing.', true, 400);
  }
  if (containsRealLookingSensitiveIdentifier({ applicantName, note })) {
    return errorResponse('DARJ_DEMO_DATA_REQUIRED', 'DRAFT', 'Use generated review details rather than real PAN, Aadhaar or CIN values.', false, 400);
  }
  const filingId = `DARJ-${formCode.replaceAll(/[^A-Z0-9]+/gu, '-')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  const status = formCode === 'AOC-4' ? 'READY_FOR_AOC4' : 'INTAKE_SAVED';
  await env.DB.prepare(`INSERT INTO service_drafts (run_id, filing_id, form_code, title, financial_year, applicant_name, note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(runId, filingId, formCode, title, financialYear, applicantName, note, status, now, now).run();
  return securedJson({ filing: { filingId, formCode, title, financialYear, applicantName, note, status, createdAt: now, updatedAt: now } });
}

async function readStudioDocuments(runId: string) {
  const attachments = await getAttachments(runId);
  const seeded = await buildSeedDocuments(runId);
  const entries = await Promise.all(attachments.map(async (attachment) => {
    const object = await env.FILES.get(attachment.objectKey);
    if (!object) {
      const seed = seeded.find((item) => item.objectKey === attachment.objectKey);
      if (seed) {
        await env.FILES.put(seed.objectKey, seed.bytes, { httpMetadata: { contentType: 'application/pdf' } });
        return [attachment.slot, new TextDecoder().decode(seed.bytes)] as const;
      }
    }
    return [attachment.slot, object ? new TextDecoder().decode(await object.arrayBuffer()) : ''] as const;
  }));
  return Object.fromEntries(entries.filter(([, contents]) => contents)) as Record<string, string>;
}

async function getStudioState(runId: string): Promise<StudioState> {
  const row = await env.DB.prepare('SELECT state_json FROM guided_filing_sessions WHERE run_id = ? AND case_id = ?').bind(runId, CASE_ID).first();
  if (!row) return emptyStudioState(new Date().toISOString());
  try { return JSON.parse(String(row.state_json)) as StudioState; }
  catch { return emptyStudioState(new Date().toISOString()); }
}

async function saveStudioState(runId: string, studio: StudioState) {
  studio.updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO guided_filing_sessions (run_id, case_id, state_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id, case_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`)
    .bind(runId, CASE_ID, JSON.stringify(studio), studio.updatedAt).run();
}

async function openStudio(runId: string, body: JsonBody) {
  const scenario: StudioScenario = body.scenario === 'conflict' ? 'conflict' : 'clean';
  const now = new Date().toISOString();
  const studio = extractStudioState(scenario, now, await readStudioDocuments(runId));
  if (typeof body.serviceNeed === 'string') studio.serviceNeed = body.serviceNeed.trim().slice(0, 240);
  await Promise.all([
    saveStudioState(runId, studio),
    appendUniqueEvent(runId, 'DOCUMENT_EXTRACTION_STARTED', 'Meet, company preparer', `Opened the ${scenario} guided AOC-4 document package.`),
  ]);
  return securedJson({ studio });
}

function addStudioTimeline(studio: StudioState, id: string, label: string, detail: string, actor: string) {
  const event = { id, label, detail, actor, occurredAt: new Date().toISOString(), packageVersion: 'Draft v17' };
  studio.timeline = [...studio.timeline.filter((item) => item.id !== id), event];
}

async function updateStudio(runId: string, body: JsonBody) {
  const studio = await getStudioState(runId);
  const operation = typeof body.operation === 'string' ? body.operation : '';
  if (operation === 'setRole') {
    const allowed: StudioRole[] = ['Company preparer', 'CA/CS/CMA reviewer', 'Authorized signatory'];
    if (!allowed.includes(body.role as StudioRole)) throw new Error('DARJ_STUDIO_UPDATE_INVALID|Choose one of the available review roles.');
    studio.activeRole = body.role as StudioRole;
  } else if (operation === 'setNeed') {
    studio.serviceNeed = typeof body.value === 'string' ? body.value.trim().slice(0, 240) : '';
    studio.stage = 'GUIDE';
  } else if (operation === 'advance') {
    const allowed = new Set(['GUIDE', 'DOCUMENTS', 'EXTRACTED', 'REVIEW']);
    if (!allowed.has(String(body.stage))) throw new Error('DARJ_STUDIO_UPDATE_INVALID|That guided filing stage is unavailable.');
    studio.stage = body.stage as StudioState['stage'];
  } else if (operation === 'answer') {
    const key = typeof body.key === 'string' ? body.key.slice(0, 60) : '';
    const value = typeof body.value === 'string' ? body.value.trim().slice(0, 240) : '';
    if (!key || !value) throw new Error('DARJ_STUDIO_UPDATE_INVALID|Choose an answer before continuing.');
    studio.answers[key] = value;
    if (key === 'agmResolution') {
      studio.evidence = studio.evidence.map((field) => field.id === 'agmDate' ? {
        ...field,
        value: value === 'authorization' ? '2026-07-31' : '2026-07-29',
        confidence: 'MEDIUM',
        ruleStatus: 'REVIEW',
        decision: 'PENDING',
        reviewerComment: `Company preparer selected the ${value === 'authorization' ? 'authorization record' : 'Board’s Report'} date.`,
      } : field);
      addStudioTimeline(studio, 'conflict-resolved', 'Conflict resolved', 'The AGM date was selected explicitly and remains flagged for professional confirmation.', 'Meet, company preparer');
    }
  } else if (operation === 'review') {
    const fieldId = typeof body.fieldId === 'string' ? body.fieldId : '';
    const decision = body.decision === 'edit' ? 'EDITED' : body.decision === 'clarify' ? 'CLARIFICATION' : 'ACCEPTED';
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 300) : '';
    let found = false;
    studio.evidence = studio.evidence.map((field) => {
      if (field.id !== fieldId) return field;
      found = true;
      const proposed = decision === 'EDITED' && typeof body.value === 'string' ? body.value.trim().slice(0, 120) : field.value;
      if (!proposed && decision !== 'CLARIFICATION') throw new Error('DARJ_STUDIO_UPDATE_INVALID|Resolve the source conflict before accepting this field.');
      return {
        ...field,
        value: proposed,
        edited: decision === 'EDITED',
        decision,
        reviewerComment: comment,
        confidence: decision === 'CLARIFICATION' ? field.confidence : decision === 'EDITED' ? 'MEDIUM' : field.confidence === 'CONFLICTING' ? 'MEDIUM' : field.confidence,
        ruleStatus: decision === 'CLARIFICATION' ? 'REVIEW' : 'PASSED',
      };
    });
    if (!found) throw new Error('DARJ_STUDIO_UPDATE_INVALID|That extracted field could not be found.');
    studio.stage = 'REVIEW';
    addStudioTimeline(studio, 'review-progress', 'Professional review in progress', 'Source-linked fields now contain explicit reviewer decisions.', studio.activeRole);
  } else if (operation === 'completeReview') {
    studio.validations = validateStudioEvidence(studio.evidence);
    if (studio.validations.some((check) => check.state === 'BLOCKING')) throw new Error('DARJ_STUDIO_BLOCKED|Resolve every blocking issue before completing professional review.');
    if (!studio.evidence.some((field) => field.decision === 'ACCEPTED' || field.decision === 'EDITED')) throw new Error('DARJ_STUDIO_BLOCKED|Record at least one professional review decision before sealing.');
    studio.stage = 'READY';
    addStudioTimeline(studio, 'review-complete', 'Professional review completed', 'The reviewed evidence set is ready to become a versioned DARJ draft.', studio.activeRole);
  } else {
    throw new Error('DARJ_STUDIO_UPDATE_INVALID|That Guided Filing Studio operation is unavailable.');
  }
  studio.validations = validateStudioEvidence(studio.evidence);
  await saveStudioState(runId, studio);
  return securedJson({ studio });
}

async function exportStudioArtifact(runId: string, kind: string) {
  const [studio, draft, attachments, packageRow, payment, processingJob] = await Promise.all([getStudioState(runId), latestDraft(runId), getAttachments(runId), latestPackage(runId), getPayment(runId), getProcessingJob(runId)]);
  const form = draft ? JSON.parse(String(draft.form_json)) as FormDataShape : INITIAL_FORM;
  const manifest = attachmentManifest(attachments);
  const previewPackage = { schema: 'DARJ-AOC4-PACKAGE-2.0', caseId: CASE_ID, form, evidence: studio.evidence, attachments: manifest, review: studio.timeline, rulePack: 'DARJ-AOC4-RULES-2.0' };
  const previewChecksum = await sha256Hex(new TextEncoder().encode(canonicalize(previewPackage)));
  if (kind === 'receipt') {
    const receipt = packageRow ? await getReceiptForPackage(runId, String(packageRow.package_id)) : null;
    if (!receipt || !packageRow) return errorResponse('DARJ_RECEIPT_NOT_READY', 'SUBMISSION', 'The custody receipt is available after the exact package has been submitted.', true, 409);
    const receivedAt = new Date(receipt.receivedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' });
    const bytes = buildDarjReceiptPdf({
      receiptId: receipt.receiptId,
      srn: receipt.srn,
      custodyId: receipt.custodyId,
      packageId: receipt.packageId,
      packageVersion: Number(packageRow.version),
      packageHash: receipt.packageHash,
      receivedAt: `${receivedAt} IST`,
      company: 'Aster Components Private Limited',
      financialYear: form.financialYear,
      paymentState: payment?.state ?? 'PENDING',
      paymentReference: payment?.reconciliationReference ?? '',
      amount: payment ? `INR ${(payment.amountPaise / 100).toFixed(2)}` : 'Illustrative fee pending',
      processingState: processingJob?.state ?? 'WAITING',
    });
    return secureDownload(bytes, 'application/pdf', `${receipt.receiptId}.pdf`);
  }
  if (kind === 'preview' || kind === 'evidence') {
    const lines = kind === 'preview' ? [
      'Synthetic AOC-4 preview - not an official MCA form or filing receipt',
      `Company: Aster Components Private Limited`,
      `Fictional CIN: DARJ-CIN-000117`,
      `Financial year: ${form.financialYear}`,
      `AGM date: ${form.agmDate}`,
      `Revenue: INR ${form.revenue}`,
      `Expenses: INR ${form.expenses}`,
      `Net profit: INR ${form.netProfit}`,
      `Verified attachments: ${attachments.length}`,
      `Preview checksum: ${previewChecksum}`,
      'Professional certification and actual MCA submission are outside this prototype.',
    ] : studio.evidence.flatMap((field) => [
      `${field.label}: ${field.value || 'UNRESOLVED'} [${field.confidence}]`,
      `Source: ${field.sourceDocument}, page ${field.page ?? '-'}, ${field.section}`,
      `Evidence: ${field.evidence}`,
    ]);
    const bytes = buildTextPdf(kind === 'preview' ? 'DARJ AOC-4 filing preview' : 'DARJ field and source evidence report', lines);
    return secureDownload(bytes, 'application/pdf', kind === 'preview' ? 'DARJ-synthetic-AOC4-preview.pdf' : 'DARJ-field-source-evidence.pdf');
  }
  const payload = kind === 'manifest' ? { schema: 'DARJ-ATTACHMENT-MANIFEST-1', caseId: CASE_ID, attachments: manifest, checksum: previewChecksum }
    : kind === 'validation' ? { schema: 'DARJ-VALIDATION-REPORT-1', rulePack: 'DARJ-AOC4-RULES-2.0', checks: studio.validations }
      : kind === 'review' ? { schema: 'DARJ-REVIEW-HISTORY-1', role: studio.activeRole, evidenceDecisions: studio.evidence.map(({ id, label, decision, edited, reviewerComment }) => ({ id, label, decision, edited, reviewerComment })), timeline: studio.timeline }
        : { ...previewPackage, packageId: packageRow ? String(packageRow.package_id) : null, sealedPackageHash: packageRow ? String(packageRow.package_hash) : null, previewChecksum };
  return secureDownload(new TextEncoder().encode(JSON.stringify(payload, null, 2)), 'application/json; charset=utf-8', `DARJ-${kind === 'package' ? 'machine-readable-package' : kind}-report.json`);
}

function secureDownload(bytes: Uint8Array, contentType: string, filename: string) {
  const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  return new Response(body as ArrayBuffer, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isValidForm(value: FormDataShape): boolean { return Object.keys(INITIAL_FORM).every((key) => typeof value[key as keyof FormDataShape] === 'string'); }

async function runJaanch(runId: string) {
  const [draft, master] = await Promise.all([latestDraft(runId), getMasterStateRow(runId)]);
  if (!draft) throw new Error('DARJ_JAANCH_FAILED|No durable draft was found.');
  return securedJson({ ruleVersion: 'DARJ-RULES-1.1', masterSnapshotVersion: Number(master?.pinned_version ?? 7), master: toMasterState(master), issues: buildChecks(JSON.parse(String(draft.form_json)) as FormDataShape, master) });
}

function buildChecks(form: FormDataShape, master?: DatabaseRow | null): ValidationCheck[] {
  const checks: ValidationCheck[] = Array.from({ length: 43 }, (_, index) => ({
    code: `DARJ_CHECK_${String(index + 1).padStart(2, '0')}`, stage: 'JAANCH', fieldPath: null, documentSlot: null, blocking: false,
    retryable: false, status: 'PASSED', summary: 'Deterministic filing condition passed.', detail: 'Checked against the saved draft and verified attachment manifest.', ruleVersion: 'DARJ-RULES-1.1',
  }));
  if (Number(form.boardMeetings) < 4) checks[16] = {
    ...checks[16], code: 'DARJ_BOARD_MEETING_COUNT', fieldPath: 'boardMeetings', blocking: true, retryable: true, status: 'NEEDS_ATTENTION',
    summary: 'The board meeting count is below this case’s expected value.',
    detail: 'Update the count to 4 for this deterministic review case. This is a DARJ prototype rule, not legal advice.', expected: '4', actual: form.boardMeetings,
  };
  if (master && ['REVIEW_REQUIRED', 'PINNED_STOPPED'].includes(String(master.review_state))) checks[22] = {
    ...checks[22], code: 'DARJ_MASTER_DATA_DRIFT', fieldPath: 'registeredOffice', blocking: true, retryable: true, status: 'NEEDS_ATTENTION',
    summary: 'The MCA21 sample company master changed after this draft was saved.',
    detail: String(master.review_state) === 'PINNED_STOPPED' ? 'Meet chose to keep the pinned address, so this filing is stopped. Reset the review workspace to start again.' : 'Review the old and current registered office values. DARJ will never replace the pinned value silently.',
    expected: String(master.current_office), actual: String(master.pinned_office),
  };
  return checks;
}

async function sealPackage(runId: string) {
  const [draft, master, attachments, existing] = await Promise.all([
    latestDraft(runId),
    getMasterStateRow(runId),
    verifyAttachments(runId),
    latestPackage(runId),
  ]);
  if (!draft) throw new Error('DARJ_JAANCH_FAILED|No durable draft was found.');
  const form = JSON.parse(String(draft.form_json)) as FormDataShape;
  if (buildChecks(form, master).some((issue) => issue.blocking)) throw new Error('DARJ_JAANCH_FAILED|One blocking Jaanch issue still needs attention.');
  if (existing && packageInputsMatch(existing, form, attachments)) return securedJson(toPackage(existing));
  const version = existing ? Number(existing.version) + 1 : 23;
  const packageId = `DARJ-PKG-${String(version).padStart(6, '0')}`;
  const canonicalPayload = canonicalize({
    hashVersion: 1, packageId, caseId: CASE_ID, packageVersion: version, formType: 'AOC-4', financialYear: '2025-26',
    formSchemaVersion: 'DARJ-AOC4-1.0', ruleVersion: 'DARJ-RULES-1.1', masterSnapshotVersion: Number(master?.pinned_version ?? 7), formData: form, attachments: attachmentManifest(attachments),
  });
  const hash = await sha256Hex(new TextEncoder().encode(canonicalPayload));
  const sealedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO filing_packages (run_id, package_id, case_id, version, canonical_payload, package_hash, rule_version, sealed_at) VALUES (?, ?, ?, ?, ?, ?, 'DARJ-RULES-1.1', ?)`)
    .bind(runId, packageId, CASE_ID, version, canonicalPayload, hash, sealedAt).run();
  await appendEvent(runId, 'SEALED', 'DARJ', `Mohar v${version} created for one immutable canonical package.`);
  return securedJson({ packageId, version, hash, sealedAt, canonicalPayload });
}

async function signPackage(runId: string) {
  const packageRow = await latestPackage(runId);
  if (!packageRow || !(await isPackageCurrent(runId, packageRow))) throw new Error('DARJ_PACKAGE_HASH_MISMATCH|Create a current Mohar before signing.');
  const existing = await env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? AND package_id = ?').bind(runId, packageRow.package_id).first();
  if (existing) return securedJson(toSignature(existing));
  const signedAt = new Date().toISOString();
  const signatureId = `DARJ-SIG-${String(packageRow.version).padStart(6, '0')}`;
  const signatureValue = await signPackageHash(String(packageRow.package_hash));
  await env.DB.prepare(`INSERT INTO synthetic_signatures (run_id, signature_id, package_id, provider, signed_hash, signature_value, signed_at) VALUES (?, ?, ?, 'DARJ_DEMO_ED25519', ?, ?, ?)`)
    .bind(runId, signatureId, packageRow.package_id, packageRow.package_hash, signatureValue, signedAt).run();
  await appendEvent(runId, 'SIGNED', 'Meet, test signer', 'Verified Ed25519 test signature bound to the server confirmed package hash.');
  return securedJson({ signatureId, packageId: String(packageRow.package_id), provider: 'DARJ_DEMO_ED25519', signedHash: String(packageRow.package_hash), signatureValue, signedAt, verified: true });
}

async function submitPackage(runId: string, body: JsonBody) {
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!idempotencyKey) throw new Error('DARJ_NOT_RECEIVED|A persisted idempotency key is required. Retrying is safe.');
  const packageRow = await latestPackage(runId);
  if (!packageRow || !(await isPackageCurrent(runId, packageRow))) throw new Error('DARJ_PACKAGE_HASH_MISMATCH|The sealed package no longer matches the latest draft and attachments.');
  const signature = await env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? AND package_id = ?').bind(runId, packageRow.package_id).first();
  if (!signature || signature.provider !== 'DARJ_DEMO_ED25519' || signature.signed_hash !== packageRow.package_hash || !(await verifyPackageSignature(String(packageRow.package_hash), String(signature.signature_value)))) throw new Error('DARJ_SIGNATURE_INVALID|The package signature could not be verified.');
  await verifyAttachments(runId);
  const requestedHash = typeof body.packageHash === 'string' ? body.packageHash : String(packageRow.package_hash);
  const requestedSignature = typeof body.signatureId === 'string' ? body.signatureId : String(signature.signature_id);
  const packageId = String(packageRow.package_id);
  const fingerprint = await sha256Hex(new TextEncoder().encode(canonicalize({ authenticatedUserId: 'DARJ-USER-MEET', demoRunId: runId, packageId, packageHash: requestedHash, signatureId: requestedSignature })));
  if (requestedHash !== packageRow.package_hash || requestedSignature !== signature.signature_id) throw new Error('DARJ_PACKAGE_HASH_MISMATCH|The requested package or signature does not match the sealed server record.');
  const replay = await submissionReplay(runId, idempotencyKey, fingerprint, packageId);
  if (replay) return securedJson({ ...replay, replayed: true });
  if (await consumeFault(runId, 'transaction_failure')) throw new Error('DARJ_NOT_RECEIVED|The custody transaction was rolled back before commit. No Rasid exists; retrying the same key is safe.');

  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    if (attemptNumber === 1 && await consumeFault(runId, 'serialization_once')) continue;
    const existingReceipt = await getReceiptForPackage(runId, packageId);
    if (existingReceipt) {
      await insertReplayAttempt(runId, idempotencyKey, fingerprint, packageId, existingReceipt.receiptId);
      return securedJson({ ...existingReceipt, replayed: true });
    }
    const receivedAt = new Date().toISOString();
    const custodyId = `DARJ-CUSTODY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const receiptId = `DARJ-RASID-${packageRow.version === 23 ? '8129' : String(packageRow.version).padStart(4, '0')}`;
    const paymentId = `DARJ-PAY-${packageRow.version === 23 ? '4418' : String(packageRow.version).padStart(4, '0')}`;
    const jobId = `DARJ-JOB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO custody_submissions (run_id, custody_id, package_id, canonical_payload, package_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(runId, custodyId, packageId, packageRow.canonical_payload, packageRow.package_hash, receivedAt),
        env.DB.prepare(`INSERT INTO receipts (run_id, receipt_id, custody_id, package_id, package_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(runId, receiptId, custodyId, packageId, packageRow.package_hash, receivedAt),
        env.DB.prepare(`INSERT INTO payment_intents (run_id, payment_id, custody_id, state, amount_paise, reconciliation_reference, updated_at) VALUES (?, ?, ?, 'PENDING', 600000, ?, ?)`).bind(runId, paymentId, custodyId, `DARJ-RECON-${runId.slice(-8)}`, receivedAt),
        env.DB.prepare(`INSERT INTO processing_jobs (run_id, job_id, custody_id, state, attempt_count, available_at) VALUES (?, ?, ?, 'WAITING_FOR_PAYMENT', 0, ?)`).bind(runId, jobId, custodyId, receivedAt),
        env.DB.prepare(`INSERT INTO submission_attempts (run_id, idempotency_key, request_fingerprint, package_id, receipt_id, outcome, attempted_at) VALUES (?, ?, ?, ?, ?, 'RECEIPT_CREATED', ?)`).bind(runId, idempotencyKey, fingerprint, packageId, receiptId, receivedAt),
      ]);
      await appendEvent(runId, 'RECEIVED', 'DARJ custody gateway', 'Exact sample package committed to custody. No MCA21 filing has occurred.');
      const run = await getRun(runId);
      if (Number(run?.lose_submission) === 1) {
        await env.DB.prepare('UPDATE demo_runs SET lose_submission = 0 WHERE run_id = ?').bind(runId).run();
        return errorResponse('DARJ_SUBMISSION_RETRY_SAFE', 'SUBMISSION', 'The response was lost after custody committed. Retrying the same request is safe.', true, 503);
      }
      return securedJson({ receiptId, srn: sampleSrnForReceipt(receiptId), custodyId, packageId, packageHash: String(packageRow.package_hash), receivedAt, replayed: false });
    } catch {
      const converged = await submissionReplay(runId, idempotencyKey, fingerprint, packageId);
      if (converged) return securedJson({ ...converged, replayed: true });
      if (attemptNumber === 3) throw new Error('DARJ_SUBMISSION_RETRY_SAFE|The database could not serialize this submission after three attempts. Retry the same persisted key.');
    }
  }
  throw new Error('DARJ_SUBMISSION_RETRY_SAFE|The submission did not reach a confirmed custody outcome. Retry the same persisted key.');
}

async function submissionReplay(runId: string, key: string, fingerprint: string, packageId: string) {
  const attempt = await env.DB.prepare('SELECT * FROM submission_attempts WHERE run_id = ? AND idempotency_key = ?').bind(runId, key).first();
  if (attempt) {
    if (attempt.request_fingerprint !== fingerprint) throw new Error('DARJ_IDEMPOTENCY_KEY_REUSED|This retry key belongs to a different request. No second receipt was created.');
    return getReceiptForPackage(runId, packageId);
  }
  return null;
}

async function insertReplayAttempt(runId: string, key: string, fingerprint: string, packageId: string, receiptId: string) {
  try {
    await env.DB.prepare(`INSERT INTO submission_attempts (run_id, idempotency_key, request_fingerprint, package_id, receipt_id, outcome, attempted_at) VALUES (?, ?, ?, ?, ?, 'RECEIPT_REPLAYED', ?)`).bind(runId, key, fingerprint, packageId, receiptId, new Date().toISOString()).run();
  } catch {
    const attempt = await env.DB.prepare('SELECT request_fingerprint FROM submission_attempts WHERE run_id = ? AND idempotency_key = ?').bind(runId, key).first();
    if (attempt?.request_fingerprint !== fingerprint) throw new Error('DARJ_IDEMPOTENCY_KEY_REUSED|This retry key belongs to a different request. No second receipt was created.');
  }
}

async function approvePayment(runId: string, body: JsonBody) {
  const payment = await getPayment(runId);
  if (!payment) throw new Error('DARJ_PAYMENT_RECONCILING|No payment intent was found.');
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!idempotencyKey) throw new Error('DARJ_PAYMENT_RECONCILING|A persisted payment retry key is required.');
  const existingAttempt = await env.DB.prepare('SELECT * FROM payment_attempts WHERE run_id = ? AND idempotency_key = ?').bind(runId, idempotencyKey).first();
  if (payment.state !== 'PAID') {
    const now = new Date().toISOString();
    const providerEventId = `DARJ-PROVIDER-${(await sha256Hex(new TextEncoder().encode(`${runId}:${payment.paymentId}`))).slice(0, 16)}`;
    const job = await getProcessingJob(runId);
    await env.DB.batch([
      env.DB.prepare('UPDATE payment_intents SET state = ?, updated_at = ? WHERE run_id = ? AND payment_id = ?').bind('PAID', now, runId, payment.paymentId),
      env.DB.prepare('INSERT OR IGNORE INTO payment_events (run_id, provider_event_id, payment_id, event_type, received_at) VALUES (?, ?, ?, ?, ?)').bind(runId, providerEventId, payment.paymentId, 'APPROVED', now),
      env.DB.prepare(`INSERT OR IGNORE INTO payment_attempts (run_id, idempotency_key, payment_id, outcome, attempted_at) VALUES (?, ?, ?, 'PAID', ?)`).bind(runId, idempotencyKey, payment.paymentId, now),
      env.DB.prepare(`UPDATE processing_jobs SET state = 'QUEUED', available_at = ? WHERE run_id = ? AND job_id = ?`).bind(now, runId, job?.jobId ?? ''),
    ]);
    await appendUniqueEvent(runId, 'PAID', 'Demo payment simulator', 'Sample fee approved and recorded separately from custody.');
  } else if (!existingAttempt) {
    await env.DB.prepare(`INSERT OR IGNORE INTO payment_attempts (run_id, idempotency_key, payment_id, outcome, attempted_at) VALUES (?, ?, ?, 'PAID_REPLAYED', ?)`).bind(runId, idempotencyKey, payment.paymentId, new Date().toISOString()).run();
  }
  const run = await getRun(runId);
  if (Number(run?.lose_payment) === 1) {
    await env.DB.prepare('UPDATE demo_runs SET lose_payment = 0 WHERE run_id = ?').bind(runId).run();
    return errorResponse('DARJ_PAYMENT_RECONCILING', 'PAYMENT', 'Approval was recorded but the browser callback was lost. Reload to reconcile; do not pay again.', true, 503);
  }
  return securedJson(await getPayment(runId));
}

async function setProcessor(runId: string, paused: boolean) {
  if (!(await consumeRateLimit(`controls:${runId}`, 30, 60_000))) return errorResponse('DARJ_PROCESSING_DELAYED', 'PROCESSING', 'Recovery controls are temporarily rate limited.', true, 429);
  await env.DB.prepare('UPDATE demo_runs SET processor_paused = ? WHERE run_id = ?').bind(paused ? 1 : 0, runId).run();
  const job = await getProcessingJob(runId);
  if (job && job.state !== 'ACCEPTED') await env.DB.prepare('UPDATE processing_jobs SET state = ?, last_error_code = ? WHERE run_id = ? AND job_id = ?').bind(paused ? 'DELAYED' : 'QUEUED', paused ? 'DARJ_PROCESSING_DELAYED' : null, runId, job.jobId).run();
  if (paused) await appendUniqueEvent(runId, 'PROCESSING_DELAYED', 'Review processor', 'Processor paused. Custody and payment remain recorded; no resubmission is needed.');
  else await appendUniqueEvent(runId, 'PROCESSING_RESUMED', 'Review processor', 'Processor resumed from the durable queue.');
  return securedJson({ processorPaused: paused });
}

async function processPackage(runId: string) {
  const run = await getRun(runId);
  const payment = await getPayment(runId);
  const job = await getProcessingJob(runId);
  if (!payment || payment.state !== 'PAID') throw new Error('DARJ_PAYMENT_RECONCILING|Processing waits for a reconciled payment state.');
  if (!job) throw new Error('DARJ_PROCESSING_DELAYED|The durable processing job could not be found.');
  if (job.state === 'ACCEPTED') return securedJson({ processingState: 'ACCEPTED' });
  if (Number(run?.processor_paused) === 1) return securedJson({ processingState: 'DELAYED' });
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE processing_jobs SET state = 'RUNNING', attempt_count = attempt_count + 1, locked_at = ?, last_error_code = NULL WHERE run_id = ? AND job_id = ?`).bind(now, runId, job.jobId).run();
  await appendUniqueEvent(runId, 'PROCESSING', 'DARJ processor', 'Deterministic processing checks started.');
  await env.DB.prepare(`UPDATE processing_jobs SET state = 'ACCEPTED', locked_at = NULL WHERE run_id = ? AND job_id = ?`).bind(runId, job.jobId).run();
  await appendUniqueEvent(runId, 'ACCEPTED', 'DARJ processor', 'Sample package accepted by the review processor. This is not MCA21 acceptance.');
  return securedJson({ processingState: 'ACCEPTED' });
}

async function simulateMasterDrift(runId: string) {
  if (!featureFlags().masterDrift) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'MASTER_DATA', 'Master-data drift is disabled for this build.', false, 404);
  const master = await getMasterStateRow(runId);
  if (!master) throw new Error('DARJ_JAANCH_FAILED|The pinned company master snapshot could not be found.');
  if (Number(master.current_version) === Number(master.pinned_version)) {
    const detectedAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE case_master_state SET current_version = 8, current_office = ?, review_state = 'REVIEW_REQUIRED', detected_at = ?, reviewed_at = NULL WHERE run_id = ? AND case_id = ?`)
      .bind('27, Riverfront Commerce Centre, Ahmedabad, Gujarat 380009', detectedAt, runId, CASE_ID).run();
    await appendUniqueEvent(runId, 'MASTER_DRIFT_DETECTED', 'DARJ company master monitor', 'Registered office changed in the sample company master after the draft pinned snapshot 7. Sealing is blocked until Meet reviews it.');
  }
  return securedJson(await getState(runId));
}

async function acceptMasterSnapshot(runId: string) {
  if (!featureFlags().masterDrift) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'MASTER_DATA', 'Master-data drift is disabled for this build.', false, 404);
  const master = await getMasterStateRow(runId);
  if (!master || String(master.review_state) !== 'REVIEW_REQUIRED') throw new Error('DARJ_JAANCH_FAILED|There is no company master change waiting for review.');
  const draft = await latestDraft(runId);
  if (!draft) throw new Error('DARJ_DRAFT_VERSION_CONFLICT|No durable draft was found.');
  const previous = JSON.parse(String(draft.form_json)) as FormDataShape;
  const form = { ...previous, registeredOffice: String(master.current_office) };
  const version = Number(draft.version) + 1;
  const reviewedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO draft_snapshots (run_id, case_id, version, base_version, form_json, changed_paths, saved_at) VALUES (?, ?, ?, ?, ?, '["registeredOffice"]', ?)`)
      .bind(runId, CASE_ID, version, Number(draft.version), JSON.stringify(form), reviewedAt),
    env.DB.prepare(`UPDATE case_master_state SET pinned_version = current_version, pinned_office = current_office, review_state = 'ACCEPTED', reviewed_at = ? WHERE run_id = ? AND case_id = ?`)
      .bind(reviewedAt, runId, CASE_ID),
  ]);
  await appendEvent(runId, 'MASTER_DRIFT_ACCEPTED', 'Meet, test signer', `Reviewed the registered-office change and pinned sample company master snapshot ${master.current_version}. A new draft version was created and affected Jaanch rules must rerun.`);
  return securedJson(await getState(runId));
}

async function keepPinnedMaster(runId: string) {
  if (!featureFlags().masterDrift) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'MASTER_DATA', 'Master-data drift is disabled for this build.', false, 404);
  const master = await getMasterStateRow(runId);
  if (!master || String(master.review_state) !== 'REVIEW_REQUIRED') throw new Error('DARJ_JAANCH_FAILED|There is no company master change waiting for review.');
  const reviewedAt = new Date().toISOString();
  await env.DB.prepare(`UPDATE case_master_state SET review_state = 'PINNED_STOPPED', reviewed_at = ? WHERE run_id = ? AND case_id = ?`).bind(reviewedAt, runId, CASE_ID).run();
  await appendEvent(runId, 'MASTER_DRIFT_DECLINED', 'Meet, test signer', 'Kept the pinned registered office. This filing is stopped and cannot be sealed.');
  return securedJson(await getState(runId));
}

async function requestCorrection(runId: string) {
  if (!featureFlags().correctionLineage) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'CORRECTION', 'Correction lineage is disabled for this build.', false, 404);
  const accepted = await env.DB.prepare(`SELECT 1 AS found FROM case_events WHERE run_id = ? AND case_id = ? AND event_type = 'ACCEPTED' LIMIT 1`).bind(runId, CASE_ID).first();
  const source = await latestPackage(runId);
  const sourceReceipt = source ? await getReceiptForPackage(runId, String(source.package_id)) : null;
  if (!accepted || !source || !sourceReceipt) throw new Error('DARJ_PROCESSING_DELAYED|Complete the accepted v23 journey before returning a resubmission request.');
  const existing = await env.DB.prepare('SELECT * FROM correction_requests WHERE run_id = ? AND source_package_id = ?').bind(runId, source.package_id).first();
  if (!existing) {
    const now = new Date().toISOString();
    const requestId = `DARJ-CORR-REQ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await env.DB.prepare(`INSERT INTO correction_requests (run_id, request_id, case_id, source_package_id, document_slot, summary, state, created_at)
      VALUES (?, ?, ?, ?, 'boardReport', 'Return resubmission required for board report.', 'REQUIRED', ?)`)
      .bind(runId, requestId, CASE_ID, source.package_id, now).run();
    await appendEvent(runId, 'RESUBMISSION_REQUIRED', 'DARJ review processor', 'Return resubmission required for board report. Original package remains immutable.');
  }
  return securedJson(await getState(runId));
}

async function createCorrectionPackage(runId: string) {
  if (!featureFlags().correctionLineage) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'CORRECTION', 'Correction lineage is disabled for this build.', false, 404);
  const request = await env.DB.prepare(`SELECT * FROM correction_requests WHERE run_id = ? AND state = 'REQUIRED' ORDER BY created_at DESC LIMIT 1`).bind(runId).first();
  if (!request) {
    const completed = await env.DB.prepare(`SELECT child_package_id FROM correction_requests WHERE run_id = ? AND state = 'COMPLETED' ORDER BY created_at DESC LIMIT 1`).bind(runId).first();
    if (completed) return securedJson(await getState(runId));
    throw new Error('DARJ_PROCESSING_DELAYED|No resubmission request is ready for correction.');
  }
  const source = await env.DB.prepare('SELECT * FROM filing_packages WHERE run_id = ? AND package_id = ?').bind(runId, request.source_package_id).first();
  const draft = await latestDraft(runId);
  if (!source || !draft) throw new Error('DARJ_PACKAGE_HASH_MISMATCH|The original package or draft could not be verified.');

  const correctedBytes = new TextEncoder().encode('%PDF-1.4\n% DARJ corrected board report for lineage demo\n1 0 obj<</Type/Catalog>>endobj\n% Correction: board report resubmission\n%%EOF');
  const correctedHash = await sha256Hex(correctedBytes);
  const objectKey = `demo/${runId}/${CASE_ID}/boardReport-correction-${crypto.randomUUID()}.pdf`;
  await env.FILES.put(objectKey, correctedBytes, { httpMetadata: { contentType: 'application/pdf', contentDisposition: 'attachment; filename="DARJ-corrected-board-report.pdf"' } });
  const now = new Date().toISOString();
  const draftVersion = Number(draft.version) + 1;
  const form = JSON.parse(String(draft.form_json)) as FormDataShape;
  await env.DB.batch([
    env.DB.prepare(`UPDATE attachments SET filename = 'DARJ-corrected-board-report.pdf', object_key = ?, bytes = ?, mime = 'application/pdf', sha256 = ?, verified_at = ? WHERE run_id = ? AND case_id = ? AND slot = 'boardReport'`)
      .bind(objectKey, correctedBytes.byteLength, correctedHash, now, runId, CASE_ID),
    env.DB.prepare(`INSERT INTO draft_snapshots (run_id, case_id, version, base_version, form_json, changed_paths, saved_at) VALUES (?, ?, ?, ?, ?, '["attachments.boardReport"]', ?)`)
      .bind(runId, CASE_ID, draftVersion, Number(draft.version), JSON.stringify(form), now),
  ]);
  const attachments = await verifyAttachments(runId);
  const version = Number(source.version) + 1;
  const packageId = `DARJ-PKG-${String(version).padStart(6, '0')}`;
  const master = await getMasterStateRow(runId);
  const canonicalPayload = canonicalize({
    hashVersion: 1, packageId, caseId: CASE_ID, packageVersion: version, formType: 'AOC-4', financialYear: '2025-26',
    formSchemaVersion: 'DARJ-AOC4-1.0', ruleVersion: 'DARJ-RULES-1.1', masterSnapshotVersion: Number(master?.pinned_version ?? 7),
    correctionOf: String(source.package_id), correctionReason: String(request.summary), formData: form, attachments: attachmentManifest(attachments),
  });
  const packageHash = await sha256Hex(new TextEncoder().encode(canonicalPayload));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO filing_packages (run_id, package_id, case_id, version, canonical_payload, package_hash, rule_version, sealed_at) VALUES (?, ?, ?, ?, ?, ?, 'DARJ-RULES-1.1', ?)`)
      .bind(runId, packageId, CASE_ID, version, canonicalPayload, packageHash, now),
    env.DB.prepare(`INSERT INTO package_lineage (run_id, child_package_id, parent_package_id, reason, changed_paths_json, created_at) VALUES (?, ?, ?, ?, '["attachments.boardReport"]', ?)`)
      .bind(runId, packageId, source.package_id, request.summary, now),
    env.DB.prepare(`UPDATE correction_requests SET state = 'COMPLETED', child_package_id = ?, resolved_at = ? WHERE run_id = ? AND request_id = ?`)
      .bind(packageId, now, runId, request.request_id),
  ]);
  await appendEvent(runId, 'CORRECTION_SEALED', 'Meet, test signer', `Created ${packageId} v${version} from immutable ${source.package_id} v${source.version}. Only the board report attachment changed.`);
  return securedJson(await getState(runId));
}

async function setRecoveryFlag(runId: string, body: JsonBody) {
  if (!(await consumeRateLimit(`controls:${runId}`, 30, 60_000))) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'DEMO_CONTROL', 'Recovery controls are temporarily rate limited.', true, 429);
  const flag = body.flag;
  if (flag === 'submission') await env.DB.prepare('UPDATE demo_runs SET lose_submission = 1 WHERE run_id = ?').bind(runId).run();
  else if (flag === 'payment') await env.DB.prepare('UPDATE demo_runs SET lose_payment = 1 WHERE run_id = ?').bind(runId).run();
  else if (flag === 'expire_session') await env.DB.prepare('UPDATE demo_runs SET expires_at = ? WHERE run_id = ?').bind(new Date(Date.now() - 1_000).toISOString(), runId).run();
  else if (flag === 'upload_pause') await env.DB.prepare(`INSERT INTO fault_injections (run_id, flag, remaining) VALUES (?, 'pause_upload', 1) ON CONFLICT(run_id, flag) DO UPDATE SET remaining = 1`).bind(runId).run();
  else if (flag === 'master_drift') return simulateMasterDrift(runId);
  else if (flag === 'correction_request') return requestCorrection(runId);
  else if (flag === 'transaction_failure' || flag === 'serialization_once') await env.DB.prepare(`INSERT INTO fault_injections (run_id, flag, remaining) VALUES (?, ?, 1) ON CONFLICT(run_id, flag) DO UPDATE SET remaining = 1`).bind(runId, flag).run();
  else return errorResponse('DARJ_UNKNOWN_RESPONSE', 'DEMO_CONTROL', 'That demo control is not available in this build.', false, 400);
  return securedJson({ ok: true });
}

async function consumeFault(runId: string, flag: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT remaining FROM fault_injections WHERE run_id = ? AND flag = ?').bind(runId, flag).first();
  if (!row || Number(row.remaining) < 1) return false;
  await env.DB.prepare('UPDATE fault_injections SET remaining = remaining - 1 WHERE run_id = ? AND flag = ?').bind(runId, flag).run();
  return true;
}

async function resetRun(runId: string) {
  if (!(await consumeRateLimit(`controls:${runId}`, 30, 60_000))) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'DEMO_CONTROL', 'Recovery controls are temporarily rate limited.', true, 429);
  const partials = await env.DB.prepare(`SELECT object_key, provider_upload_id FROM upload_sessions WHERE run_id = ? AND state = 'UPLOADING'`).bind(runId).all();
  for (const partial of partials.results) {
    if (partial.provider_upload_id) {
      try { await env.FILES.resumeMultipartUpload(String(partial.object_key), String(partial.provider_upload_id)).abort(); } catch { /* An already expired provider session is safe to ignore during reset. */ }
    }
  }
  const prefix = `demo/${runId}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.FILES.list({ prefix, cursor });
    if (listed.objects.length) await env.FILES.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const tables = ['fault_injections', 'case_events', 'processing_jobs', 'payment_attempts', 'payment_events', 'payment_intents', 'submission_attempts', 'receipts', 'custody_submissions', 'synthetic_signatures', 'package_lineage', 'correction_requests', 'filing_packages', 'upload_sessions', 'attachment_versions', 'attachments', 'case_master_state', 'draft_snapshots', 'service_drafts', 'guided_filing_sessions'];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE run_id = ?`).bind(runId)));
  await env.DB.prepare('UPDATE demo_runs SET processor_paused = 0, lose_submission = 1, lose_payment = 1 WHERE run_id = ?').bind(runId).run();
  await seedRun(runId);
  return securedJson(await getState(runId));
}

async function handleUpload(request: Request, runId: string) {
  const form = await request.formData();
  const file = form.get('file');
  const slot = String(form.get('slot') ?? '');
  const clientSha256 = String(form.get('clientSha256') ?? '');
  if (!(file instanceof File)) return errorResponse('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', 'UPLOAD', 'Choose a sample PDF to continue.', true, 400);
  if (!ALLOWED_SLOTS.has(slot)) return errorResponse('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', 'UPLOAD', 'Choose one of the three sample attachment slots.', false, 400);
  if (!/^DARJ-[A-Za-z0-9._ -]+\.pdf$/u.test(file.name) || file.type !== 'application/pdf') return errorResponse('DARJ_ATTACHMENT_TYPE_UNSUPPORTED', 'UPLOAD', 'Only sample PDF files with names starting DARJ are accepted.', true, 415);
  if (file.size > MAX_DEMO_PDF_BYTES) return errorResponse('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', 'UPLOAD', 'This file exceeds DARJ’s 12 MB review limit.', true, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffDemoPdf(bytes)) return errorResponse('DARJ_ATTACHMENT_TYPE_UNSUPPORTED', 'UPLOAD', 'The stored bytes are not a complete PDF document.', true, 415);
  const hash = await sha256Hex(bytes);
  if (!/^[a-f0-9]{64}$/u.test(clientSha256) || clientSha256 !== hash) return errorResponse('DARJ_ATTACHMENT_HASH_MISMATCH', 'UPLOAD', 'The stored file does not match the file selected in the browser.', true, 409, { expected: { sha256: clientSha256 }, actual: { sha256: hash }, documentSlot: slot });
  const objectKey = `demo/${runId}/${CASE_ID}/${slot}-${crypto.randomUUID()}.pdf`;
  await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: 'application/pdf', contentDisposition: `attachment; filename="${file.name.replaceAll('"', '')}"` } });
  const now = new Date().toISOString();
  const currentVersion = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM attachment_versions WHERE run_id = ? AND case_id = ? AND slot = ?').bind(runId, CASE_ID, slot).first();
  const version = Number(currentVersion?.version ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO attachment_versions (run_id, case_id, slot, version, filename, object_key, bytes, mime, sha256, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)`)
      .bind(runId, CASE_ID, slot, version, file.name, objectKey, bytes.byteLength, hash, now),
    env.DB.prepare(`INSERT INTO attachments (run_id, case_id, slot, filename, object_key, bytes, mime, sha256, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?) ON CONFLICT(run_id, case_id, slot) DO UPDATE SET filename=excluded.filename, object_key=excluded.object_key, bytes=excluded.bytes, mime=excluded.mime, sha256=excluded.sha256, verified_at=excluded.verified_at`)
      .bind(runId, CASE_ID, slot, file.name, objectKey, bytes.byteLength, hash, now),
  ]);
  return securedJson({ slot, version, filename: file.name, bytes: bytes.byteLength, mime: 'application/pdf', sha256: hash, verifiedAt: now });
}

async function verifyAttachments(runId: string): Promise<AttachmentRow[]> {
  const attachments = await getAttachments(runId);
  if (attachments.length !== 3) throw new Error('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE|All three sample PDF slots must be complete before sealing.');
  const seeded = await buildSeedDocuments(runId);
  await Promise.all(attachments.map(async (attachment) => {
    const object = await env.FILES.get(attachment.objectKey);
    let bytes: Uint8Array;
    if (object) {
      bytes = new Uint8Array(await object.arrayBuffer());
    } else {
      const seed = seeded.find((document) => document.objectKey === attachment.objectKey && document.filename === attachment.filename && document.hash === attachment.sha256 && document.bytes.byteLength === attachment.bytes);
      if (!seed) throw new Error('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE|A stored attachment is unavailable. Upload it again; form values are unchanged.');
      bytes = seed.bytes;
      await env.FILES.put(seed.objectKey, bytes, { httpMetadata: { contentType: 'application/pdf' } });
    }
    const serverHash = await sha256Hex(bytes);
    if (!sniffDemoPdf(bytes) || bytes.byteLength !== attachment.bytes || serverHash !== attachment.sha256) throw new Error('DARJ_ATTACHMENT_HASH_MISMATCH|A stored attachment failed authoritative server verification.');
  }));
  return attachments;
}

function attachmentManifest(attachments: AttachmentRow[]) { return attachments.map((item) => ({ slot: item.slot, bytes: item.bytes, mime: item.mime, sha256: item.sha256 })).sort((a, b) => a.slot.localeCompare(b.slot)); }

function packageInputsMatch(row: DatabaseRow, form: FormDataShape, attachments: AttachmentRow[]): boolean {
  try {
    const payload = JSON.parse(String(row.canonical_payload)) as { formData?: unknown; attachments?: unknown };
    return canonicalize(payload.formData) === canonicalize(form) && canonicalize(payload.attachments) === canonicalize(attachmentManifest(attachments));
  } catch { return false; }
}

async function isPackageCurrent(runId: string, row: DatabaseRow): Promise<boolean> {
  const draft = await latestDraft(runId);
  if (!draft) return false;
  return packageInputsMatch(row, JSON.parse(String(draft.form_json)) as FormDataShape, await getAttachments(runId));
}

async function getState(runId: string) {
  const features = featureFlags();
  const [draft, packageRow, run, uploadSessions, master, pauseUpload, correction, lineage, attachments, attachmentVersions, payment, processingJob, events, serviceDrafts, studio] = await Promise.all([
    latestDraft(runId),
    latestPackage(runId),
    getRun(runId),
    features.resumableUploads ? getUploadSessions(runId) : Promise.resolve([]),
    features.masterDrift ? getMasterStateRow(runId) : Promise.resolve(null),
    env.DB.prepare(`SELECT remaining FROM fault_injections WHERE run_id = ? AND flag = 'pause_upload'`).bind(runId).first(),
    features.correctionLineage ? getCorrectionState(runId) : Promise.resolve(null),
    features.correctionLineage ? getLineage(runId) : Promise.resolve([]),
    getAttachments(runId),
    getAttachmentVersions(runId),
    getPayment(runId),
    getProcessingJob(runId),
    getEvents(runId),
    getServiceDrafts(runId),
    getStudioState(runId),
  ]);
  const packageCurrent = Boolean(packageRow && draft && packageInputsMatch(packageRow, JSON.parse(String(draft.form_json)) as FormDataShape, attachments));
  const [signature, receipt] = await Promise.all([
    packageRow ? env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? AND package_id = ?').bind(runId, packageRow.package_id).first() : Promise.resolve(null),
    packageRow ? getReceiptForPackage(runId, String(packageRow.package_id)) : Promise.resolve(null),
  ]);
  const signatureValid = Boolean(signature && packageCurrent && signature.provider === 'DARJ_DEMO_ED25519' && signature.signed_hash === packageRow?.package_hash && await verifyPackageSignature(String(packageRow?.package_hash), String(signature.signature_value)));
  return {
    runId, caseId: CASE_ID,
    draft: draft ? { version: Number(draft.version), form: JSON.parse(String(draft.form_json)) as FormDataShape, savedAt: String(draft.saved_at) } : null,
    attachments: attachments.map((attachment) => ({ slot: attachment.slot, version: attachment.version, filename: attachment.filename, bytes: attachment.bytes, mime: attachment.mime, sha256: attachment.sha256, verifiedAt: attachment.verifiedAt })),
    attachmentVersions,
    package: packageRow ? toPackage(packageRow) : null, packageCurrent,
    signature: signature ? toSignature(signature) : null, signatureValid,
    receipt, payment, processingJob,
    processorPaused: Number(run?.processor_paused) === 1,
    uploadPauseArmed: Number(pauseUpload?.remaining ?? 0) > 0,
    uploadSessions,
    master: toMasterState(master),
    correction,
    lineage,
    features,
    events,
    serviceDrafts,
    studio,
  };
}

async function getServiceDrafts(runId: string) {
  const result = await env.DB.prepare(`SELECT filing_id, form_code, title, financial_year, applicant_name, note, status, created_at, updated_at
    FROM service_drafts WHERE run_id = ? ORDER BY updated_at DESC`).bind(runId).all();
  return result.results.map((row) => ({
    filingId: String(row.filing_id), formCode: String(row.form_code), title: String(row.title), financialYear: String(row.financial_year),
    applicantName: String(row.applicant_name), note: String(row.note), status: String(row.status), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }));
}

async function latestDraft(runId: string) { return env.DB.prepare('SELECT * FROM draft_snapshots WHERE run_id = ? AND case_id = ? ORDER BY version DESC LIMIT 1').bind(runId, CASE_ID).first(); }
async function latestPackage(runId: string) { return env.DB.prepare('SELECT * FROM filing_packages WHERE run_id = ? AND case_id = ? ORDER BY version DESC LIMIT 1').bind(runId, CASE_ID).first(); }
async function getRun(runId: string) { return env.DB.prepare('SELECT * FROM demo_runs WHERE run_id = ? AND expires_at > ?').bind(runId, new Date().toISOString()).first(); }

async function getUploadSessions(runId: string) {
  const result = await env.DB.prepare(`SELECT upload_id, slot, filename, expected_bytes, confirmed_offset, client_sha256, fingerprint, state, updated_at, expires_at
    FROM upload_sessions WHERE run_id = ? AND case_id = ? ORDER BY updated_at DESC`).bind(runId, CASE_ID).all();
  const seen = new Set<string>();
  return result.results.filter((row) => {
    const slot = String(row.slot);
    if (seen.has(slot)) return false;
    seen.add(slot); return true;
  }).map((row) => ({ uploadId: String(row.upload_id), slot: String(row.slot), filename: String(row.filename), expectedBytes: Number(row.expected_bytes), confirmedOffset: Number(row.confirmed_offset), clientSha256: String(row.client_sha256), fingerprint: String(row.fingerprint), state: String(row.state), updatedAt: String(row.updated_at), expiresAt: String(row.expires_at), uploadUrl: `${TUS_UPLOAD_PATH}/${row.upload_id}` }));
}

async function getMasterStateRow(runId: string) { return env.DB.prepare('SELECT * FROM case_master_state WHERE run_id = ? AND case_id = ?').bind(runId, CASE_ID).first(); }

function toMasterState(row: DatabaseRow | null) {
  return row ? {
    pinnedVersion: Number(row.pinned_version), pinnedOffice: String(row.pinned_office), currentVersion: Number(row.current_version), currentOffice: String(row.current_office),
    source: String(row.source), reviewState: String(row.review_state), detectedAt: row.detected_at ? String(row.detected_at) : null, reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  } : null;
}

async function getCorrectionState(runId: string) {
  const row = await env.DB.prepare('SELECT * FROM correction_requests WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').bind(runId).first();
  return row ? { requestId: String(row.request_id), sourcePackageId: String(row.source_package_id), documentSlot: String(row.document_slot), summary: String(row.summary), state: String(row.state), childPackageId: row.child_package_id ? String(row.child_package_id) : null, createdAt: String(row.created_at), resolvedAt: row.resolved_at ? String(row.resolved_at) : null } : null;
}

async function getLineage(runId: string) {
  const result = await env.DB.prepare(`SELECT l.child_package_id, l.parent_package_id, l.reason, l.changed_paths_json, l.created_at,
    child.version AS child_version, child.package_hash AS child_hash, child.sealed_at AS child_sealed_at,
    parent.version AS parent_version, parent.package_hash AS parent_hash, parent.sealed_at AS parent_sealed_at
    FROM package_lineage l
    JOIN filing_packages child ON child.run_id = l.run_id AND child.package_id = l.child_package_id
    JOIN filing_packages parent ON parent.run_id = l.run_id AND parent.package_id = l.parent_package_id
    WHERE l.run_id = ? ORDER BY l.created_at`).bind(runId).all();
  return result.results.map((row) => ({
    parent: { packageId: String(row.parent_package_id), version: Number(row.parent_version), hash: String(row.parent_hash), sealedAt: String(row.parent_sealed_at) },
    child: { packageId: String(row.child_package_id), version: Number(row.child_version), hash: String(row.child_hash), sealedAt: String(row.child_sealed_at) },
    reason: String(row.reason), changedPaths: JSON.parse(String(row.changed_paths_json)) as string[], createdAt: String(row.created_at),
  }));
}

async function getAttachments(runId: string): Promise<AttachmentRow[]> {
  const result = await env.DB.prepare(`SELECT a.slot, a.filename, a.object_key, a.bytes, a.mime, a.sha256, a.verified_at,
    COALESCE((SELECT MAX(v.version) FROM attachment_versions v WHERE v.run_id = a.run_id AND v.case_id = a.case_id AND v.slot = a.slot), 1) AS version
    FROM attachments a WHERE a.run_id = ? AND a.case_id = ? ORDER BY a.slot`).bind(runId, CASE_ID).all();
  return result.results.map((row) => ({ slot: String(row.slot), version: Number(row.version), filename: String(row.filename), objectKey: String(row.object_key), bytes: Number(row.bytes), mime: String(row.mime), sha256: String(row.sha256), verifiedAt: String(row.verified_at) }));
}

async function getAttachmentVersions(runId: string) {
  const result = await env.DB.prepare(`SELECT v.slot, v.version, v.filename, v.bytes, v.mime, v.sha256, v.verified_at,
    CASE WHEN a.object_key = v.object_key THEN 1 ELSE 0 END AS current
    FROM attachment_versions v LEFT JOIN attachments a ON a.run_id = v.run_id AND a.case_id = v.case_id AND a.slot = v.slot
    WHERE v.run_id = ? AND v.case_id = ? ORDER BY v.slot, v.version DESC`).bind(runId, CASE_ID).all();
  return result.results.map((row) => ({ slot: String(row.slot), version: Number(row.version), filename: String(row.filename), bytes: Number(row.bytes), mime: String(row.mime), sha256: String(row.sha256), verifiedAt: String(row.verified_at), current: Number(row.current) === 1 }));
}

async function getReceiptForPackage(runId: string, packageId: string) {
  const row = await env.DB.prepare('SELECT * FROM receipts WHERE run_id = ? AND package_id = ?').bind(runId, packageId).first();
  return row ? { receiptId: String(row.receipt_id), srn: sampleSrnForReceipt(String(row.receipt_id)), custodyId: String(row.custody_id), packageId: String(row.package_id), packageHash: String(row.package_hash), receivedAt: String(row.received_at) } : null;
}

function sampleSrnForReceipt(receiptId: string) {
  return `DARJ-SRN-AOC4-${receiptId.split('-').at(-1) ?? '0000'}`;
}

async function getPayment(runId: string) {
  const row = await env.DB.prepare('SELECT * FROM payment_intents WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1').bind(runId).first();
  return row ? { paymentId: String(row.payment_id), state: String(row.state), amountPaise: Number(row.amount_paise), reconciliationReference: String(row.reconciliation_reference), updatedAt: String(row.updated_at) } : null;
}

async function getProcessingJob(runId: string) {
  const row = await env.DB.prepare('SELECT * FROM processing_jobs WHERE run_id = ? ORDER BY available_at DESC LIMIT 1').bind(runId).first();
  return row ? { jobId: String(row.job_id), custodyId: String(row.custody_id), state: String(row.state), attemptCount: Number(row.attempt_count), availableAt: String(row.available_at), lockedAt: row.locked_at ? String(row.locked_at) : null, lastErrorCode: row.last_error_code ? String(row.last_error_code) : null } : null;
}

async function getEvents(runId: string) {
  const result = await env.DB.prepare('SELECT * FROM case_events WHERE run_id = ? AND case_id = ? ORDER BY seq').bind(runId, CASE_ID).all();
  return result.results.map((row) => ({ seq: Number(row.seq), eventType: String(row.event_type), actor: String(row.actor), detail: String(row.detail), occurredAt: String(row.occurred_at) }));
}

async function appendEvent(runId: string, eventType: string, actor: string, detail: string) {
  await env.DB.prepare(`INSERT INTO case_events (run_id, case_id, seq, event_type, actor, detail, occurred_at) SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ? FROM case_events WHERE run_id = ? AND case_id = ?`)
    .bind(runId, CASE_ID, eventType, actor, detail, new Date().toISOString(), runId, CASE_ID).run();
}

async function appendUniqueEvent(runId: string, eventType: string, actor: string, detail: string) {
  const existing = await env.DB.prepare('SELECT 1 AS found FROM case_events WHERE run_id = ? AND case_id = ? AND event_type = ? LIMIT 1').bind(runId, CASE_ID, eventType).first();
  if (!existing) await appendEvent(runId, eventType, actor, detail);
}

function readRunId(request: Request) { return readCookie(request, COOKIE_NAME); }
function readCookie(request: Request, name: string) {
  const cookie = request.headers.get('cookie') ?? '';
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

function toPackage(row: DatabaseRow) { return { packageId: String(row.package_id), version: Number(row.version), hash: String(row.package_hash), sealedAt: String(row.sealed_at), canonicalPayload: String(row.canonical_payload) }; }
function toSignature(row: DatabaseRow) { return { signatureId: String(row.signature_id), packageId: String(row.package_id), provider: String(row.provider), signedHash: String(row.signed_hash), signatureValue: String(row.signature_value), signedAt: String(row.signed_at), verified: true }; }

function domainError(caught: unknown) {
  const message = caught instanceof Error ? caught.message : 'Unknown server error';
  if (!message.startsWith('DARJ_')) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'UNKNOWN', 'DARJ could not reliably interpret this response. No correction has been suggested. Your saved work is unchanged.', false, 500);
  const [code, summary] = message.split('|');
  const retryable = !['DARJ_IDEMPOTENCY_KEY_REUSED', 'DARJ_PACKAGE_HASH_MISMATCH', 'DARJ_SIGNATURE_INVALID', 'DARJ_DEMO_DATA_REQUIRED', 'DARJ_JAANCH_FAILED'].includes(code);
  const stage = code.includes('DRAFT') || code.includes('DEMO_DATA') ? 'DRAFT' : code.includes('JAANCH') ? 'JAANCH' : code.includes('PAYMENT') ? 'PAYMENT' : code.includes('PROCESSING') ? 'PROCESSING' : 'SUBMISSION';
  const status = code === 'DARJ_SUBMISSION_RETRY_SAFE' ? 503 : code === 'DARJ_AUTH_REQUIRED' ? 401 : 409;
  return errorResponse(code, stage, summary ?? 'The requested operation could not be completed.', retryable, status);
}

function securedJson(value: unknown, init?: ResponseInit) {
  const response = NextResponse.json(value, init);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

function errorResponse(code: string, stage: string, summary: string, retryable: boolean, status: number, extra: Record<string, unknown> = {}) {
  return securedJson({ error: {
    code, stage, fieldPath: null, documentSlot: null, blocking: status >= 400, retryable, summary,
    detail: code === 'DARJ_UNKNOWN_RESPONSE' ? 'No correction has been suggested. Your saved work is unchanged.' : retryable ? 'Your saved work is unchanged. Retrying is safe with the same persisted key.' : 'Your saved work is unchanged.',
    correlationId: `DARJ-CORR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, ...extra,
  } }, { status });
}
