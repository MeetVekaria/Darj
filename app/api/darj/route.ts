import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { canonicalize, sha256Hex } from '@/lib/canonical';
import { MAX_SYNTHETIC_PDF_BYTES, sniffSyntheticPdf } from '@/lib/pdf';
import { containsRealLookingSensitiveIdentifier } from '@/lib/security';
import { signPackageHash, verifyPackageSignature } from '@/lib/synthetic-signature.server';

export const dynamic = 'force-dynamic';

const COOKIE_NAME = 'darj_demo_run';
const CSRF_COOKIE_NAME = 'darj_csrf';
const CASE_ID = 'SYN-CASE-AOC4-01';
const DEMO_EMAIL = 'priya@darj.demo';
const DEMO_PASSWORD = 'darj2026';
const ALLOWED_SLOTS = new Set(['financialStatements', 'auditorReport', 'boardReport']);

const INITIAL_FORM = {
  registeredOffice: '14, Synthetic Estate, Ahmedabad, Gujarat 380015',
  financialYear: '2025-26',
  agmDate: '2026-07-29',
  boardMeetings: '3',
  revenue: '124800000',
  expenses: '118250000',
  netProfit: '6550000',
  directorName: 'SYN — Kavya Mehta',
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
  `CREATE TABLE IF NOT EXISTS attachments (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, slot TEXT NOT NULL,
    filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL,
    mime TEXT NOT NULL, sha256 TEXT NOT NULL, verified_at TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id, slot)
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
];

type FormDataShape = typeof INITIAL_FORM;
type JsonBody = Record<string, unknown>;
type DatabaseRow = Record<string, unknown>;
type AttachmentRow = { slot: string; filename: string; objectKey: string; bytes: number; mime: string; sha256: string; verifiedAt: string };
type ValidationCheck = {
  code: string; stage: string; fieldPath: string | null; documentSlot: string | null;
  blocking: boolean; retryable: boolean; status: string; summary: string; detail: string;
  ruleVersion: string; expected?: string; actual?: string;
};

export async function GET(request: Request) {
  await initializeDatabase();
  const runId = readRunId(request);
  if (!runId) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Enter the synthetic demo to continue.', false, 401);
  if (!(await getRun(runId))) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'This demo session has expired. Your local draft is unchanged.', true, 401);
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
      case 'jaanch': return await runJaanch(runId);
      case 'seal': return await sealPackage(runId);
      case 'sign': return await signPackage(runId);
      case 'submit': return await submitPackage(runId, body);
      case 'approvePayment': return await approvePayment(runId, body);
      case 'setProcessor': return await setProcessor(runId, body.processorPaused === true);
      case 'process': return await processPackage(runId);
      case 'reset': return await resetRun(runId);
      case 'setRecovery': return await setRecoveryFlag(runId, body);
      default: return errorResponse('DARJ_UNKNOWN_RESPONSE', 'UNKNOWN', 'DARJ could not reliably interpret this response. No correction has been suggested. Your saved work is unchanged.', false, 400);
    }
  } catch (caught) { return domainError(caught); }
}

async function initializeDatabase() { await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))); }

async function authorizeMutation(request: Request, stage: string): Promise<string | NextResponse> {
  const runId = readRunId(request);
  if (!runId || !(await getRun(runId))) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Re-enter the synthetic demo. Your local draft is unchanged.', true, 401);
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin && requestOrigin !== new URL(request.url).origin) return errorResponse('DARJ_AUTH_REQUIRED', stage, 'The request origin could not be verified.', false, 403);
  const csrfHeader = request.headers.get('x-darj-csrf');
  const csrfCookie = readCookie(request, CSRF_COOKIE_NAME);
  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) return errorResponse('DARJ_AUTH_REQUIRED', stage, 'The secure demo request token is missing or expired. Re-enter the demo.', false, 403);
  return runId;
}

async function login(body: JsonBody, request: Request) {
  const clientKey = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local';
  if (!(await consumeRateLimit(`login:${clientKey}`, 60, 60_000))) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Too many demo login attempts. Wait one minute and try again.', true, 429);
  if (body.email !== DEMO_EMAIL || body.password !== DEMO_PASSWORD) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Use the published synthetic demo credentials shown on this page.', true, 401);
  const runId = `run-${crypto.randomUUID()}`;
  const csrfToken = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await env.DB.prepare('INSERT INTO demo_runs (run_id, created_at, expires_at) VALUES (?, ?, ?)').bind(runId, now.toISOString(), expires.toISOString()).run();
  await seedRun(runId);
  const response = securedJson(await getState(runId));
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(runId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`);
  response.headers.append('Set-Cookie', `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; Max-Age=86400${secure}`);
  return response;
}

async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const keyHash = await sha256Hex(new TextEncoder().encode(key));
  const now = Date.now();
  const row = await env.DB.prepare('SELECT window_start, request_count FROM rate_limits WHERE key_hash = ?').bind(keyHash).first();
  const windowStart = row ? Date.parse(String(row.window_start)) : 0;
  if (row && now - windowStart < windowMs) {
    if (Number(row.request_count) >= limit) return false;
    await env.DB.prepare('UPDATE rate_limits SET request_count = request_count + 1 WHERE key_hash = ?').bind(keyHash).run();
    return true;
  }
  await env.DB.prepare(`INSERT INTO rate_limits (key_hash, window_start, request_count) VALUES (?, ?, 1) ON CONFLICT(key_hash) DO UPDATE SET window_start = excluded.window_start, request_count = 1`).bind(keyHash, new Date(now).toISOString()).run();
  return true;
}

async function seedRun(runId: string) {
  const savedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO draft_snapshots (run_id, case_id, version, base_version, form_json, changed_paths, saved_at) VALUES (?, ?, 17, 16, ?, ?, ?)`)
    .bind(runId, CASE_ID, JSON.stringify(INITIAL_FORM), JSON.stringify([]), savedAt).run();
  const files = [
    ['financialStatements', 'SYN-financial-statements.pdf', 'Synthetic financial statements'],
    ['auditorReport', 'SYN-auditor-report.pdf', 'Synthetic auditor report'],
    ['boardReport', 'SYN-board-report.pdf', 'Synthetic board report'],
  ] as const;
  for (const [slot, filename, title] of files) {
    const bytes = new TextEncoder().encode(`%PDF-1.4\n% DARJ synthetic document\n1 0 obj<</Type/Catalog>>endobj\n% ${title}\n%%EOF`);
    const objectKey = `demo/${runId}/${CASE_ID}/${slot}.pdf`;
    await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: 'application/pdf' } });
    const hash = await sha256Hex(bytes);
    await env.DB.prepare(`INSERT INTO attachments (run_id, case_id, slot, filename, object_key, bytes, mime, sha256, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)`)
      .bind(runId, CASE_ID, slot, filename, objectKey, bytes.byteLength, hash, savedAt).run();
  }
}

async function saveDraft(runId: string, body: JsonBody) {
  const form = body.form as FormDataShape | undefined;
  const baseVersion = Number(body.baseVersion);
  if (!form || !isValidForm(form) || !Number.isInteger(baseVersion)) throw new Error('DARJ_DRAFT_VERSION_CONFLICT|The draft version or schema could not be verified.');
  if (containsRealLookingSensitiveIdentifier(form)) throw new Error('DARJ_SYNTHETIC_DATA_REQUIRED|Real-looking Aadhaar, PAN, or CIN patterns are rejected in this synthetic prototype.');
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
  if (changedPaths.length > 0 && await latestPackage(runId)) await appendUniqueEvent(runId, 'SIGNATURE_INVALID', 'DARJ', 'A later draft changed the package input. The prior synthetic signature cannot sign the new version.');
  return securedJson({ version: nextVersion, savedAt, changedPaths });
}

function isValidForm(value: FormDataShape): boolean { return Object.keys(INITIAL_FORM).every((key) => typeof value[key as keyof FormDataShape] === 'string'); }

async function runJaanch(runId: string) {
  const draft = await latestDraft(runId);
  if (!draft) throw new Error('DARJ_JAANCH_FAILED|No durable draft was found.');
  return securedJson({ ruleVersion: 'DARJ-RULES-1.1', masterSnapshotVersion: 7, issues: buildChecks(JSON.parse(String(draft.form_json)) as FormDataShape) });
}

function buildChecks(form: FormDataShape): ValidationCheck[] {
  const checks: ValidationCheck[] = Array.from({ length: 43 }, (_, index) => ({
    code: `DARJ_CHECK_${String(index + 1).padStart(2, '0')}`, stage: 'JAANCH', fieldPath: null, documentSlot: null, blocking: false,
    retryable: false, status: 'PASSED', summary: 'Deterministic prototype condition passed.', detail: 'Checked against the saved draft and verified attachment manifest.', ruleVersion: 'DARJ-RULES-1.1',
  }));
  if (Number(form.boardMeetings) < 4) checks[16] = {
    ...checks[16], code: 'DARJ_BOARD_MEETING_COUNT', fieldPath: 'boardMeetings', blocking: true, retryable: true, status: 'NEEDS_ATTENTION',
    summary: 'The synthetic board-meeting count is below this case’s expected value.',
    detail: 'Update the count to 4 for this deterministic demo case. This is a DARJ prototype rule, not legal advice.', expected: '4', actual: form.boardMeetings,
  };
  return checks;
}

async function sealPackage(runId: string) {
  const draft = await latestDraft(runId);
  if (!draft) throw new Error('DARJ_JAANCH_FAILED|No durable draft was found.');
  const form = JSON.parse(String(draft.form_json)) as FormDataShape;
  if (buildChecks(form).some((issue) => issue.blocking)) throw new Error('DARJ_JAANCH_FAILED|One blocking Jaanch issue still needs attention.');
  const attachments = await verifyAttachments(runId);
  const existing = await latestPackage(runId);
  if (existing && packageInputsMatch(existing, form, attachments)) return securedJson(toPackage(existing));
  const version = existing ? Number(existing.version) + 1 : 23;
  const packageId = `SYN-PKG-${String(version).padStart(6, '0')}`;
  const canonicalPayload = canonicalize({
    hashVersion: 1, packageId, caseId: CASE_ID, packageVersion: version, formType: 'AOC-4 prototype', financialYear: '2025-26',
    formSchemaVersion: 'DARJ-AOC4-1.0', ruleVersion: 'DARJ-RULES-1.1', masterSnapshotVersion: 7, formData: form, attachments: attachmentManifest(attachments),
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
  const signatureId = `SYN-SIG-${String(packageRow.version).padStart(6, '0')}`;
  const signatureValue = await signPackageHash(String(packageRow.package_hash));
  await env.DB.prepare(`INSERT INTO synthetic_signatures (run_id, signature_id, package_id, provider, signed_hash, signature_value, signed_at) VALUES (?, ?, ?, 'SYNTHETIC_ED25519', ?, ?, ?)`)
    .bind(runId, signatureId, packageRow.package_id, packageRow.package_hash, signatureValue, signedAt).run();
  await appendEvent(runId, 'SIGNED', 'Priya · synthetic signer', 'Verified Ed25519 demo signature bound to the server-confirmed package hash.');
  return securedJson({ signatureId, packageId: String(packageRow.package_id), provider: 'SYNTHETIC_ED25519', signedHash: String(packageRow.package_hash), signatureValue, signedAt, verified: true });
}

async function submitPackage(runId: string, body: JsonBody) {
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!idempotencyKey) throw new Error('DARJ_NOT_RECEIVED|A persisted idempotency key is required. Retrying is safe.');
  const packageRow = await latestPackage(runId);
  if (!packageRow || !(await isPackageCurrent(runId, packageRow))) throw new Error('DARJ_PACKAGE_HASH_MISMATCH|The sealed package no longer matches the latest draft and attachments.');
  const signature = await env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? AND package_id = ?').bind(runId, packageRow.package_id).first();
  if (!signature || signature.provider !== 'SYNTHETIC_ED25519' || signature.signed_hash !== packageRow.package_hash || !(await verifyPackageSignature(String(packageRow.package_hash), String(signature.signature_value)))) throw new Error('DARJ_SIGNATURE_INVALID|The package signature could not be verified.');
  await verifyAttachments(runId);
  const requestedHash = typeof body.packageHash === 'string' ? body.packageHash : String(packageRow.package_hash);
  const requestedSignature = typeof body.signatureId === 'string' ? body.signatureId : String(signature.signature_id);
  const packageId = String(packageRow.package_id);
  const fingerprint = await sha256Hex(new TextEncoder().encode(canonicalize({ authenticatedUserId: 'SYN-USER-PRIYA', demoRunId: runId, packageId, packageHash: requestedHash, signatureId: requestedSignature })));
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
    const custodyId = `SYN-CUSTODY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const receiptId = `SYN-RASID-${packageRow.version === 23 ? '8129' : String(packageRow.version).padStart(4, '0')}`;
    const paymentId = `SYN-PAY-${packageRow.version === 23 ? '4418' : String(packageRow.version).padStart(4, '0')}`;
    const jobId = `SYN-JOB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO custody_submissions (run_id, custody_id, package_id, canonical_payload, package_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(runId, custodyId, packageId, packageRow.canonical_payload, packageRow.package_hash, receivedAt),
        env.DB.prepare(`INSERT INTO receipts (run_id, receipt_id, custody_id, package_id, package_hash, received_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(runId, receiptId, custodyId, packageId, packageRow.package_hash, receivedAt),
        env.DB.prepare(`INSERT INTO payment_intents (run_id, payment_id, custody_id, state, amount_paise, reconciliation_reference, updated_at) VALUES (?, ?, ?, 'PENDING', 600000, ?, ?)`).bind(runId, paymentId, custodyId, `SYN-RECON-${runId.slice(-8)}`, receivedAt),
        env.DB.prepare(`INSERT INTO processing_jobs (run_id, job_id, custody_id, state, attempt_count, available_at) VALUES (?, ?, ?, 'WAITING_FOR_PAYMENT', 0, ?)`).bind(runId, jobId, custodyId, receivedAt),
        env.DB.prepare(`INSERT INTO submission_attempts (run_id, idempotency_key, request_fingerprint, package_id, receipt_id, outcome, attempted_at) VALUES (?, ?, ?, ?, ?, 'RECEIPT_CREATED', ?)`).bind(runId, idempotencyKey, fingerprint, packageId, receiptId, receivedAt),
      ]);
      await appendEvent(runId, 'RECEIVED', 'DARJ custody gateway', 'Exact synthetic package committed to custody. This is not MCA acceptance.');
      const run = await getRun(runId);
      if (Number(run?.lose_submission) === 1) {
        await env.DB.prepare('UPDATE demo_runs SET lose_submission = 0 WHERE run_id = ?').bind(runId).run();
        return errorResponse('DARJ_SUBMISSION_RETRY_SAFE', 'SUBMISSION', 'The response was lost after custody committed. Retrying the same request is safe.', true, 503);
      }
      return securedJson({ receiptId, custodyId, packageId, packageHash: String(packageRow.package_hash), receivedAt, replayed: false });
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
    const providerEventId = `SYN-PROVIDER-${(await sha256Hex(new TextEncoder().encode(`${runId}:${payment.paymentId}`))).slice(0, 16)}`;
    const job = await getProcessingJob(runId);
    await env.DB.batch([
      env.DB.prepare('UPDATE payment_intents SET state = ?, updated_at = ? WHERE run_id = ? AND payment_id = ?').bind('PAID', now, runId, payment.paymentId),
      env.DB.prepare('INSERT OR IGNORE INTO payment_events (run_id, provider_event_id, payment_id, event_type, received_at) VALUES (?, ?, ?, ?, ?)').bind(runId, providerEventId, payment.paymentId, 'APPROVED', now),
      env.DB.prepare(`INSERT OR IGNORE INTO payment_attempts (run_id, idempotency_key, payment_id, outcome, attempted_at) VALUES (?, ?, ?, 'PAID', ?)`).bind(runId, idempotencyKey, payment.paymentId, now),
      env.DB.prepare(`UPDATE processing_jobs SET state = 'QUEUED', available_at = ? WHERE run_id = ? AND job_id = ?`).bind(now, runId, job?.jobId ?? ''),
    ]);
    await appendUniqueEvent(runId, 'PAID', 'Synthetic payment simulator', 'Synthetic fee approved and recorded separately from custody.');
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
  if (!(await consumeRateLimit(`controls:${runId}`, 30, 60_000))) return errorResponse('DARJ_PROCESSING_DELAYED', 'PROCESSING', 'Demo controls are temporarily rate limited.', true, 429);
  await env.DB.prepare('UPDATE demo_runs SET processor_paused = ? WHERE run_id = ?').bind(paused ? 1 : 0, runId).run();
  const job = await getProcessingJob(runId);
  if (job && job.state !== 'ACCEPTED') await env.DB.prepare('UPDATE processing_jobs SET state = ?, last_error_code = ? WHERE run_id = ? AND job_id = ?').bind(paused ? 'DELAYED' : 'QUEUED', paused ? 'DARJ_PROCESSING_DELAYED' : null, runId, job.jobId).run();
  if (paused) await appendUniqueEvent(runId, 'PROCESSING_DELAYED', 'Demo processor', 'Processor paused. Custody and payment remain recorded; no resubmission is needed.');
  else await appendUniqueEvent(runId, 'PROCESSING_RESUMED', 'Demo processor', 'Processor resumed from the durable queue.');
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
  await appendUniqueEvent(runId, 'ACCEPTED', 'DARJ processor', 'Synthetic package accepted by the prototype processor. This is not MCA acceptance.');
  return securedJson({ processingState: 'ACCEPTED' });
}

async function setRecoveryFlag(runId: string, body: JsonBody) {
  if (!(await consumeRateLimit(`controls:${runId}`, 30, 60_000))) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'DEMO_CONTROL', 'Demo controls are temporarily rate limited.', true, 429);
  const flag = body.flag;
  if (flag === 'submission') await env.DB.prepare('UPDATE demo_runs SET lose_submission = 1 WHERE run_id = ?').bind(runId).run();
  else if (flag === 'payment') await env.DB.prepare('UPDATE demo_runs SET lose_payment = 1 WHERE run_id = ?').bind(runId).run();
  else if (flag === 'expire_session') await env.DB.prepare('UPDATE demo_runs SET expires_at = ? WHERE run_id = ?').bind(new Date(Date.now() - 1_000).toISOString(), runId).run();
  else if (flag === 'transaction_failure' || flag === 'serialization_once') await env.DB.prepare(`INSERT INTO fault_injections (run_id, flag, remaining) VALUES (?, ?, 1) ON CONFLICT(run_id, flag) DO UPDATE SET remaining = 1`).bind(runId, flag).run();
  else return errorResponse('DARJ_UNKNOWN_RESPONSE', 'DEMO_CONTROL', 'That synthetic control is not available in P0.', false, 400);
  return securedJson({ ok: true });
}

async function consumeFault(runId: string, flag: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT remaining FROM fault_injections WHERE run_id = ? AND flag = ?').bind(runId, flag).first();
  if (!row || Number(row.remaining) < 1) return false;
  await env.DB.prepare('UPDATE fault_injections SET remaining = remaining - 1 WHERE run_id = ? AND flag = ?').bind(runId, flag).run();
  return true;
}

async function resetRun(runId: string) {
  if (!(await consumeRateLimit(`controls:${runId}`, 30, 60_000))) return errorResponse('DARJ_UNKNOWN_RESPONSE', 'DEMO_CONTROL', 'Demo controls are temporarily rate limited.', true, 429);
  const prefix = `demo/${runId}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.FILES.list({ prefix, cursor });
    if (listed.objects.length) await env.FILES.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const tables = ['fault_injections', 'case_events', 'processing_jobs', 'payment_attempts', 'payment_events', 'payment_intents', 'submission_attempts', 'receipts', 'custody_submissions', 'synthetic_signatures', 'filing_packages', 'attachments', 'draft_snapshots'];
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
  if (!(file instanceof File)) return errorResponse('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', 'UPLOAD', 'Choose a synthetic PDF to continue.', true, 400);
  if (!ALLOWED_SLOTS.has(slot)) return errorResponse('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', 'UPLOAD', 'Choose one of the three synthetic attachment slots.', false, 400);
  if (!file.name.startsWith('SYN-') || file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) return errorResponse('DARJ_ATTACHMENT_TYPE_UNSUPPORTED', 'UPLOAD', 'Only clearly named synthetic PDF files are accepted in this prototype.', true, 415);
  if (file.size > MAX_SYNTHETIC_PDF_BYTES) return errorResponse('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', 'UPLOAD', 'This file exceeds DARJ’s 5 MB synthetic-demo limit.', true, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffSyntheticPdf(bytes)) return errorResponse('DARJ_ATTACHMENT_TYPE_UNSUPPORTED', 'UPLOAD', 'The stored bytes are not a complete PDF document.', true, 415);
  const hash = await sha256Hex(bytes);
  if (!/^[a-f0-9]{64}$/u.test(clientSha256) || clientSha256 !== hash) return errorResponse('DARJ_ATTACHMENT_HASH_MISMATCH', 'UPLOAD', 'The stored file does not match the file selected in the browser.', true, 409, { expected: { sha256: clientSha256 }, actual: { sha256: hash }, documentSlot: slot });
  const objectKey = `demo/${runId}/${CASE_ID}/${slot}-${crypto.randomUUID()}.pdf`;
  await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: 'application/pdf', contentDisposition: `attachment; filename="${file.name.replaceAll('"', '')}"` } });
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO attachments (run_id, case_id, slot, filename, object_key, bytes, mime, sha256, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?) ON CONFLICT(run_id, case_id, slot) DO UPDATE SET filename=excluded.filename, object_key=excluded.object_key, bytes=excluded.bytes, mime=excluded.mime, sha256=excluded.sha256, verified_at=excluded.verified_at`)
    .bind(runId, CASE_ID, slot, file.name, objectKey, bytes.byteLength, hash, now).run();
  return securedJson({ slot, filename: file.name, bytes: bytes.byteLength, mime: 'application/pdf', sha256: hash, verifiedAt: now });
}

async function verifyAttachments(runId: string): Promise<AttachmentRow[]> {
  const attachments = await getAttachments(runId);
  if (attachments.length !== 3) throw new Error('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE|All three synthetic PDF slots must be complete before sealing.');
  for (const attachment of attachments) {
    const object = await env.FILES.get(attachment.objectKey);
    if (!object) throw new Error('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE|A stored attachment is unavailable. Upload it again; form values are unchanged.');
    const bytes = new Uint8Array(await object.arrayBuffer());
    const serverHash = await sha256Hex(bytes);
    if (!sniffSyntheticPdf(bytes) || bytes.byteLength !== attachment.bytes || serverHash !== attachment.sha256) throw new Error('DARJ_ATTACHMENT_HASH_MISMATCH|A stored attachment failed authoritative server verification.');
  }
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
  const draft = await latestDraft(runId);
  const packageRow = await latestPackage(runId);
  const packageCurrent = packageRow ? await isPackageCurrent(runId, packageRow) : false;
  const signature = packageRow ? await env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? AND package_id = ?').bind(runId, packageRow.package_id).first() : null;
  const signatureValid = Boolean(signature && packageCurrent && signature.provider === 'SYNTHETIC_ED25519' && signature.signed_hash === packageRow?.package_hash && await verifyPackageSignature(String(packageRow?.package_hash), String(signature.signature_value)));
  const receipt = packageRow ? await getReceiptForPackage(runId, String(packageRow.package_id)) : null;
  const payment = await getPayment(runId);
  const run = await getRun(runId);
  return {
    runId, caseId: CASE_ID,
    draft: draft ? { version: Number(draft.version), form: JSON.parse(String(draft.form_json)) as FormDataShape, savedAt: String(draft.saved_at) } : null,
    attachments: (await getAttachments(runId)).map((attachment) => ({ slot: attachment.slot, filename: attachment.filename, bytes: attachment.bytes, mime: attachment.mime, sha256: attachment.sha256, verifiedAt: attachment.verifiedAt })),
    package: packageRow ? toPackage(packageRow) : null, packageCurrent,
    signature: signature ? toSignature(signature) : null, signatureValid,
    receipt, payment, processingJob: await getProcessingJob(runId),
    processorPaused: Number(run?.processor_paused) === 1,
    events: await getEvents(runId),
  };
}

async function latestDraft(runId: string) { return env.DB.prepare('SELECT * FROM draft_snapshots WHERE run_id = ? AND case_id = ? ORDER BY version DESC LIMIT 1').bind(runId, CASE_ID).first(); }
async function latestPackage(runId: string) { return env.DB.prepare('SELECT * FROM filing_packages WHERE run_id = ? AND case_id = ? ORDER BY version DESC LIMIT 1').bind(runId, CASE_ID).first(); }
async function getRun(runId: string) { return env.DB.prepare('SELECT * FROM demo_runs WHERE run_id = ? AND expires_at > ?').bind(runId, new Date().toISOString()).first(); }

async function getAttachments(runId: string): Promise<AttachmentRow[]> {
  const result = await env.DB.prepare('SELECT slot, filename, object_key, bytes, mime, sha256, verified_at FROM attachments WHERE run_id = ? AND case_id = ? ORDER BY slot').bind(runId, CASE_ID).all();
  return result.results.map((row) => ({ slot: String(row.slot), filename: String(row.filename), objectKey: String(row.object_key), bytes: Number(row.bytes), mime: String(row.mime), sha256: String(row.sha256), verifiedAt: String(row.verified_at) }));
}

async function getReceiptForPackage(runId: string, packageId: string) {
  const row = await env.DB.prepare('SELECT * FROM receipts WHERE run_id = ? AND package_id = ?').bind(runId, packageId).first();
  return row ? { receiptId: String(row.receipt_id), custodyId: String(row.custody_id), packageId: String(row.package_id), packageHash: String(row.package_hash), receivedAt: String(row.received_at) } : null;
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
  const retryable = !['DARJ_IDEMPOTENCY_KEY_REUSED', 'DARJ_PACKAGE_HASH_MISMATCH', 'DARJ_SIGNATURE_INVALID', 'DARJ_SYNTHETIC_DATA_REQUIRED', 'DARJ_JAANCH_FAILED'].includes(code);
  const stage = code.includes('DRAFT') || code.includes('SYNTHETIC_DATA') ? 'DRAFT' : code.includes('JAANCH') ? 'JAANCH' : code.includes('PAYMENT') ? 'PAYMENT' : code.includes('PROCESSING') ? 'PROCESSING' : 'SUBMISSION';
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
