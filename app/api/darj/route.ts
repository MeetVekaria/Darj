import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { canonicalize, sha256Hex } from '@/lib/canonical';
import { containsRealLookingSensitiveIdentifier } from '@/lib/security';

export const dynamic = 'force-dynamic';

const COOKIE_NAME = 'darj_demo_run';
const CASE_ID = 'SYN-CASE-AOC4-01';
const PACKAGE_ID = 'SYN-PKG-000023';
const DEMO_EMAIL = 'priya@darj.demo';
const DEMO_PASSWORD = 'darj2026';

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
    PRIMARY KEY (run_id, receipt_id), UNIQUE (run_id, custody_id), UNIQUE (run_id, package_id)
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
  `CREATE TABLE IF NOT EXISTS case_events (
    run_id TEXT NOT NULL, case_id TEXT NOT NULL, seq INTEGER NOT NULL,
    event_type TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, occurred_at TEXT NOT NULL,
    PRIMARY KEY (run_id, case_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_latest ON draft_snapshots(run_id, case_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(run_id, case_id, seq)`,
];

type FormDataShape = typeof INITIAL_FORM;
type JsonBody = Record<string, unknown>;
type ValidationCheck = {
  code: string; stage: string; fieldPath: string | null; documentSlot: string | null;
  blocking: boolean; retryable: boolean; status: string; summary: string; detail: string;
  ruleVersion: string; expected?: string; actual?: string;
};

export async function GET(request: Request) {
  await initializeDatabase();
  const runId = readRunId(request);
  if (!runId) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Enter the synthetic demo to continue.', false, 401);
  const run = await getRun(runId);
  if (!run) return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'This demo session has expired. Your local draft is unchanged.', true, 401);
  return NextResponse.json(await getState(runId));
}

export async function POST(request: Request) {
  await initializeDatabase();
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) return handleUpload(request);

  const body = (await request.json()) as JsonBody;
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'login') return login(body, request);

  const runId = readRunId(request);
  if (!runId || !(await getRun(runId))) {
    return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Re-enter the synthetic demo. Your local draft is unchanged.', true, 401);
  }

  try {
    switch (action) {
      case 'saveDraft': return await saveDraft(runId, body);
      case 'jaanch': return await runJaanch(runId);
      case 'seal': return await sealPackage(runId);
      case 'sign': return await signPackage(runId);
      case 'submit': return await submitPackage(runId, body);
      case 'approvePayment': return await approvePayment(runId);
      case 'setProcessor': return await setProcessor(runId, body.processorPaused === true);
      case 'process': return await processPackage(runId);
      case 'reset': return await resetRun(runId);
      case 'setRecovery': return await setRecoveryFlag(runId, body);
      default: return errorResponse('DARJ_UNKNOWN_RESPONSE', 'UNKNOWN', 'DARJ could not reliably interpret this response. No correction has been suggested. Your saved work is unchanged.', false, 400);
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Unknown server error';
    if (message.startsWith('DARJ_')) {
      const [code, summary] = message.split('|');
      const retryable = !['DARJ_IDEMPOTENCY_KEY_REUSED', 'DARJ_PACKAGE_HASH_MISMATCH', 'DARJ_SIGNATURE_INVALID', 'DARJ_SYNTHETIC_DATA_REQUIRED', 'DARJ_JAANCH_FAILED'].includes(code);
      const stage = code.includes('DRAFT') || code.includes('SYNTHETIC_DATA') ? 'DRAFT' : code.includes('JAANCH') ? 'JAANCH' : 'SUBMISSION';
      return errorResponse(code, stage, summary ?? 'The requested operation could not be completed.', retryable, 409);
    }
    return errorResponse('DARJ_UNKNOWN_RESPONSE', 'UNKNOWN', 'DARJ could not reliably interpret this response. No correction has been suggested. Your saved work is unchanged.', false, 500);
  }
}

async function initializeDatabase() {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
}

async function login(body: JsonBody, request: Request) {
  if (body.email !== DEMO_EMAIL || body.password !== DEMO_PASSWORD) {
    return errorResponse('DARJ_AUTH_REQUIRED', 'LOGIN', 'Use the published synthetic demo credentials shown on this page.', true, 401);
  }
  const runId = `run-${crypto.randomUUID()}`;
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await env.DB.prepare(
    'INSERT INTO demo_runs (run_id, created_at, expires_at) VALUES (?, ?, ?)',
  ).bind(runId, now.toISOString(), expires.toISOString()).run();
  await seedRun(runId);
  const response = NextResponse.json(await getState(runId));
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${runId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`,
  );
  return response;
}

async function seedRun(runId: string) {
  const savedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO draft_snapshots
      (run_id, case_id, version, base_version, form_json, changed_paths, saved_at)
      VALUES (?, ?, 17, 16, ?, ?, ?)`,
  ).bind(runId, CASE_ID, JSON.stringify(INITIAL_FORM), JSON.stringify([]), savedAt).run();

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
    await env.DB.prepare(
      `INSERT INTO attachments
       (run_id, case_id, slot, filename, object_key, bytes, mime, sha256, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)`,
    ).bind(runId, CASE_ID, slot, filename, objectKey, bytes.byteLength, hash, savedAt).run();
  }
}

async function saveDraft(runId: string, body: JsonBody) {
  const form = body.form as FormDataShape | undefined;
  const baseVersion = Number(body.baseVersion);
  if (!form || !Number.isInteger(baseVersion)) throw new Error('DARJ_DRAFT_VERSION_CONFLICT|The draft version could not be verified.');
  if (containsRealLookingSensitiveIdentifier(form)) {
    throw new Error('DARJ_SYNTHETIC_DATA_REQUIRED|Real-looking Aadhaar, PAN, or CIN patterns are rejected in this synthetic prototype.');
  }
  const latest = await latestDraft(runId);
  if (!latest || Number(latest.version) !== baseVersion) {
    return errorResponse('DARJ_DRAFT_VERSION_CONFLICT', 'DRAFT', 'A newer server draft exists. Compare the changed field before continuing.', false, 409, {
      expected: { baseVersion }, actual: { serverVersion: Number(latest?.version ?? 0) }, fieldPath: 'formData',
    });
  }
  const nextVersion = baseVersion + 1;
  const changedPaths = Object.keys(form).filter((key) => form[key as keyof FormDataShape] !== INITIAL_FORM[key as keyof FormDataShape]);
  const savedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO draft_snapshots
      (run_id, case_id, version, base_version, form_json, changed_paths, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(runId, CASE_ID, nextVersion, baseVersion, JSON.stringify(form), JSON.stringify(changedPaths), savedAt).run();
  return NextResponse.json({ version: nextVersion, savedAt });
}

async function runJaanch(runId: string) {
  const draft = await latestDraft(runId);
  if (!draft) throw new Error('DARJ_JAANCH_FAILED|No durable draft was found.');
  const form = JSON.parse(String(draft.form_json)) as FormDataShape;
  const issues = buildChecks(form);
  return NextResponse.json({ ruleVersion: 'DARJ-RULES-1.1', masterSnapshotVersion: 7, issues });
}

function buildChecks(form: FormDataShape) {
  const checks: ValidationCheck[] = Array.from({ length: 43 }, (_, index) => ({
    code: `DARJ_CHECK_${String(index + 1).padStart(2, '0')}`,
    stage: 'JAANCH', fieldPath: null, documentSlot: null, blocking: false,
    retryable: false, status: 'PASSED', summary: 'Deterministic prototype condition passed.',
    detail: 'Checked against the saved draft and verified attachment manifest.',
    ruleVersion: 'DARJ-RULES-1.1',
  }));
  if (Number(form.boardMeetings) < 4) {
    checks[16] = {
      ...checks[16], code: 'DARJ_BOARD_MEETING_COUNT', fieldPath: 'boardMeetings',
      blocking: true, retryable: true, status: 'NEEDS_ATTENTION',
      summary: 'The synthetic board-meeting count is below this case’s expected value.',
      detail: 'Update the count to 4 for this deterministic demo case. This is a DARJ prototype rule, not legal advice.',
      expected: '4', actual: form.boardMeetings,
    };
  }
  return checks;
}

async function sealPackage(runId: string) {
  const draft = await latestDraft(runId);
  if (!draft) throw new Error('DARJ_JAANCH_FAILED|No durable draft was found.');
  const form = JSON.parse(String(draft.form_json)) as FormDataShape;
  const issues = buildChecks(form);
  if (issues.some((issue) => issue.blocking)) throw new Error('DARJ_JAANCH_FAILED|One blocking Jaanch issue still needs attention.');
  const existing = await env.DB.prepare('SELECT * FROM filing_packages WHERE run_id = ? AND package_id = ?').bind(runId, PACKAGE_ID).first();
  if (existing) return NextResponse.json(toPackage(existing));
  const attachments = await getAttachments(runId);
  const canonicalObject = {
    hashVersion: 1, packageId: PACKAGE_ID, caseId: CASE_ID, packageVersion: 23,
    formType: 'AOC-4 prototype', financialYear: '2025-26', formSchemaVersion: 'DARJ-AOC4-1.0',
    ruleVersion: 'DARJ-RULES-1.1', masterSnapshotVersion: 7, formData: form,
    attachments: attachments.map((item) => ({ slot: item.slot, bytes: item.bytes, mime: item.mime, sha256: item.sha256 })).sort((a, b) => a.slot.localeCompare(b.slot)),
  };
  const canonicalPayload = canonicalize(canonicalObject);
  const hash = await sha256Hex(new TextEncoder().encode(canonicalPayload));
  const sealedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO filing_packages
      (run_id, package_id, case_id, version, canonical_payload, package_hash, rule_version, sealed_at)
      VALUES (?, ?, ?, 23, ?, ?, 'DARJ-RULES-1.1', ?)`,
  ).bind(runId, PACKAGE_ID, CASE_ID, canonicalPayload, hash, sealedAt).run();
  await appendEvent(runId, 'SEALED', 'DARJ', 'Mohar created for one immutable canonical package.');
  return NextResponse.json({ packageId: PACKAGE_ID, version: 23, hash, sealedAt, canonicalPayload });
}

async function signPackage(runId: string) {
  const packageRow = await env.DB.prepare('SELECT * FROM filing_packages WHERE run_id = ? AND package_id = ?').bind(runId, PACKAGE_ID).first();
  if (!packageRow) throw new Error('DARJ_PACKAGE_HASH_MISMATCH|Create a Mohar before signing.');
  const existing = await env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? AND package_id = ?').bind(runId, PACKAGE_ID).first();
  if (existing) return NextResponse.json(toSignature(existing));
  const signedAt = new Date().toISOString();
  const signatureId = 'SYN-SIG-000023';
  const signatureValue = await sha256Hex(new TextEncoder().encode(`SYNTHETIC_ED25519|${String(packageRow.package_hash)}|DARJ_DEMO_KEY`));
  await env.DB.prepare(
    `INSERT INTO synthetic_signatures
      (run_id, signature_id, package_id, provider, signed_hash, signature_value, signed_at)
      VALUES (?, ?, ?, 'SYNTHETIC_ED25519', ?, ?, ?)`,
  ).bind(runId, signatureId, PACKAGE_ID, packageRow.package_hash, signatureValue, signedAt).run();
  await appendEvent(runId, 'SIGNED', 'Priya · synthetic signer', 'Synthetic signature bound to the server-confirmed package hash.');
  return NextResponse.json({ signatureId, packageId: PACKAGE_ID, provider: 'SYNTHETIC_ED25519', signedHash: packageRow.package_hash, signatureValue, signedAt });
}

async function submitPackage(runId: string, body: JsonBody) {
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!idempotencyKey) throw new Error('DARJ_NOT_RECEIVED|A persisted idempotency key is required. Retrying is safe.');
  const packageRow = await env.DB.prepare('SELECT * FROM filing_packages WHERE run_id = ? AND package_id = ?').bind(runId, PACKAGE_ID).first();
  const signature = await env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? AND package_id = ?').bind(runId, PACKAGE_ID).first();
  if (!packageRow || !signature || signature.signed_hash !== packageRow.package_hash) throw new Error('DARJ_SIGNATURE_INVALID|The package signature could not be verified.');
  const requestedHash = typeof body.packageHash === 'string' ? body.packageHash : String(packageRow.package_hash);
  const requestedSignature = typeof body.signatureId === 'string' ? body.signatureId : String(signature.signature_id);
  const fingerprint = await sha256Hex(new TextEncoder().encode(canonicalize({ runId, packageId: PACKAGE_ID, packageHash: requestedHash, signatureId: requestedSignature })));
  const attempt = await env.DB.prepare('SELECT * FROM submission_attempts WHERE run_id = ? AND idempotency_key = ?').bind(runId, idempotencyKey).first();
  if (attempt) {
    if (attempt.request_fingerprint !== fingerprint) throw new Error('DARJ_IDEMPOTENCY_KEY_REUSED|This retry key belongs to a different request. No second receipt was created.');
    const receipt = await getReceipt(runId);
    return NextResponse.json({ ...(receipt ?? {}), replayed: true });
  }
  if (requestedHash !== packageRow.package_hash || requestedSignature !== signature.signature_id) {
    throw new Error('DARJ_PACKAGE_HASH_MISMATCH|The requested package or signature does not match the sealed server record.');
  }
  const existingReceipt = await getReceipt(runId);
  if (existingReceipt) {
    await env.DB.prepare(
      `INSERT INTO submission_attempts
       (run_id, idempotency_key, request_fingerprint, package_id, receipt_id, outcome, attempted_at)
       VALUES (?, ?, ?, ?, ?, 'RECEIPT_REPLAYED', ?)`,
    ).bind(runId, idempotencyKey, fingerprint, PACKAGE_ID, existingReceipt.receiptId, new Date().toISOString()).run();
    return NextResponse.json({ ...existingReceipt, replayed: true });
  }

  const receivedAt = new Date().toISOString();
  const custodyId = `SYN-CUSTODY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const receiptId = 'SYN-RASID-8129';
  const paymentId = 'SYN-PAY-4418';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO custody_submissions
       (run_id, custody_id, package_id, canonical_payload, package_hash, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(runId, custodyId, PACKAGE_ID, packageRow.canonical_payload, packageRow.package_hash, receivedAt),
    env.DB.prepare(
      `INSERT INTO receipts
       (run_id, receipt_id, custody_id, package_id, package_hash, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(runId, receiptId, custodyId, PACKAGE_ID, packageRow.package_hash, receivedAt),
    env.DB.prepare(
      `INSERT INTO payment_intents
       (run_id, payment_id, custody_id, state, amount_paise, reconciliation_reference, updated_at)
       VALUES (?, ?, ?, 'PENDING', 600000, ?, ?)`,
    ).bind(runId, paymentId, custodyId, `SYN-RECON-${runId.slice(-8)}`, receivedAt),
    env.DB.prepare(
      `INSERT INTO submission_attempts
       (run_id, idempotency_key, request_fingerprint, package_id, receipt_id, outcome, attempted_at)
       VALUES (?, ?, ?, ?, ?, 'RECEIPT_CREATED', ?)`,
    ).bind(runId, idempotencyKey, fingerprint, PACKAGE_ID, receiptId, receivedAt),
  ]);
  await appendEvent(runId, 'RECEIVED', 'DARJ custody gateway', 'Exact synthetic package committed to custody. This is not MCA acceptance.');
  const run = await getRun(runId);
  if (Number(run?.lose_submission) === 1) {
    await env.DB.prepare('UPDATE demo_runs SET lose_submission = 0 WHERE run_id = ?').bind(runId).run();
    return errorResponse('DARJ_SUBMISSION_RETRY_SAFE', 'SUBMISSION', 'The response was lost after custody committed. Retrying the same request is safe.', true, 503);
  }
  return NextResponse.json({ receiptId, custodyId, packageId: PACKAGE_ID, packageHash: packageRow.package_hash, receivedAt, replayed: false });
}

async function approvePayment(runId: string) {
  const payment = await getPayment(runId);
  if (!payment) throw new Error('DARJ_PAYMENT_RECONCILING|No payment intent was found.');
  if (payment.state !== 'PAID') {
    const now = new Date().toISOString();
    const providerEventId = `SYN-EVENT-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.batch([
      env.DB.prepare('UPDATE payment_intents SET state = ?, updated_at = ? WHERE run_id = ? AND payment_id = ?').bind('PAID', now, runId, payment.paymentId),
      env.DB.prepare('INSERT OR IGNORE INTO payment_events (run_id, provider_event_id, payment_id, event_type, received_at) VALUES (?, ?, ?, ?, ?)').bind(runId, providerEventId, payment.paymentId, 'APPROVED', now),
    ]);
    await appendEvent(runId, 'PAID', 'Synthetic payment simulator', 'Synthetic fee approved and recorded separately from custody.');
  }
  const run = await getRun(runId);
  if (Number(run?.lose_payment) === 1) {
    await env.DB.prepare('UPDATE demo_runs SET lose_payment = 0 WHERE run_id = ?').bind(runId).run();
    return errorResponse('DARJ_PAYMENT_RECONCILING', 'PAYMENT', 'Approval was recorded but the browser callback was lost. Reload to reconcile; do not pay again.', true, 503);
  }
  return NextResponse.json(await getPayment(runId));
}

async function setProcessor(runId: string, paused: boolean) {
  await env.DB.prepare('UPDATE demo_runs SET processor_paused = ? WHERE run_id = ?').bind(paused ? 1 : 0, runId).run();
  if (paused) await appendEvent(runId, 'PROCESSING_DELAYED', 'Demo processor', 'Processor paused. Custody and payment remain recorded; no resubmission is needed.');
  else await appendEvent(runId, 'PROCESSING_RESUMED', 'Demo processor', 'Processor resumed from the durable queue.');
  return NextResponse.json({ processorPaused: paused });
}

async function processPackage(runId: string) {
  const run = await getRun(runId);
  const payment = await getPayment(runId);
  if (!payment || payment.state !== 'PAID') throw new Error('DARJ_PAYMENT_RECONCILING|Processing waits for a reconciled payment state.');
  if (Number(run?.processor_paused) === 1) return NextResponse.json({ processingState: 'DELAYED' });
  const state = await getState(runId);
  if (!state.events.some((event) => event.eventType === 'PROCESSING')) {
    await appendEvent(runId, 'PROCESSING', 'DARJ processor', 'Deterministic processing checks started.');
  }
  if (!state.events.some((event) => event.eventType === 'ACCEPTED')) {
    await appendEvent(runId, 'ACCEPTED', 'DARJ processor', 'Synthetic package accepted by the prototype processor. This is not MCA acceptance.');
  }
  return NextResponse.json({ processingState: 'ACCEPTED' });
}

async function setRecoveryFlag(runId: string, body: JsonBody) {
  const flag = body.flag;
  if (flag === 'submission') await env.DB.prepare('UPDATE demo_runs SET lose_submission = 1 WHERE run_id = ?').bind(runId).run();
  if (flag === 'payment') await env.DB.prepare('UPDATE demo_runs SET lose_payment = 1 WHERE run_id = ?').bind(runId).run();
  return NextResponse.json({ ok: true });
}

async function resetRun(runId: string) {
  const tables = ['payment_events', 'payment_intents', 'submission_attempts', 'receipts', 'custody_submissions', 'synthetic_signatures', 'filing_packages', 'case_events', 'attachments', 'draft_snapshots'];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE run_id = ?`).bind(runId)));
  await env.DB.prepare('UPDATE demo_runs SET processor_paused = 0, lose_submission = 1, lose_payment = 1 WHERE run_id = ?').bind(runId).run();
  await seedRun(runId);
  return NextResponse.json(await getState(runId));
}

async function handleUpload(request: Request) {
  const runId = readRunId(request);
  if (!runId || !(await getRun(runId))) return errorResponse('DARJ_AUTH_REQUIRED', 'UPLOAD', 'Enter the synthetic demo before uploading.', true, 401);
  const form = await request.formData();
  const file = form.get('file');
  const slot = String(form.get('slot') ?? 'boardReport');
  if (!(file instanceof File)) return errorResponse('DARJ_ATTACHMENT_UPLOAD_INCOMPLETE', 'UPLOAD', 'Choose a synthetic PDF to continue.', true, 400);
  if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) return errorResponse('DARJ_ATTACHMENT_TYPE_UNSUPPORTED', 'UPLOAD', 'Only synthetic PDF files are accepted in this prototype.', true, 415);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const objectKey = `demo/${runId}/${CASE_ID}/${slot}-${crypto.randomUUID()}.pdf`;
  await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO attachments
     (run_id, case_id, slot, filename, object_key, bytes, mime, sha256, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)
     ON CONFLICT(run_id, case_id, slot) DO UPDATE SET
       filename=excluded.filename, object_key=excluded.object_key, bytes=excluded.bytes,
       mime=excluded.mime, sha256=excluded.sha256, verified_at=excluded.verified_at`,
  ).bind(runId, CASE_ID, slot, file.name, objectKey, bytes.byteLength, hash, now).run();
  return NextResponse.json({ slot, filename: file.name, bytes: bytes.byteLength, mime: 'application/pdf', sha256: hash, verifiedAt: now });
}

async function getState(runId: string) {
  const draft = await latestDraft(runId);
  const packageRow = await env.DB.prepare('SELECT * FROM filing_packages WHERE run_id = ? ORDER BY version DESC LIMIT 1').bind(runId).first();
  const signature = await env.DB.prepare('SELECT * FROM synthetic_signatures WHERE run_id = ? LIMIT 1').bind(runId).first();
  const receipt = await getReceipt(runId);
  const payment = await getPayment(runId);
  const run = await getRun(runId);
  const eventsResult = await env.DB.prepare('SELECT * FROM case_events WHERE run_id = ? AND case_id = ? ORDER BY seq').bind(runId, CASE_ID).all();
  return {
    runId,
    caseId: CASE_ID,
    draft: draft ? { version: Number(draft.version), form: JSON.parse(String(draft.form_json)) as FormDataShape, savedAt: String(draft.saved_at) } : null,
    attachments: await getAttachments(runId),
    package: packageRow ? toPackage(packageRow) : null,
    signature: signature ? toSignature(signature) : null,
    receipt,
    payment,
    processorPaused: Number(run?.processor_paused) === 1,
    events: eventsResult.results.map((row) => ({ seq: Number(row.seq), eventType: String(row.event_type), actor: String(row.actor), detail: String(row.detail), occurredAt: String(row.occurred_at) })),
  };
}

async function latestDraft(runId: string) {
  return env.DB.prepare('SELECT * FROM draft_snapshots WHERE run_id = ? AND case_id = ? ORDER BY version DESC LIMIT 1').bind(runId, CASE_ID).first();
}

async function getRun(runId: string) {
  return env.DB.prepare('SELECT * FROM demo_runs WHERE run_id = ? AND expires_at > ?').bind(runId, new Date().toISOString()).first();
}

async function getAttachments(runId: string) {
  const result = await env.DB.prepare('SELECT slot, filename, bytes, mime, sha256, verified_at FROM attachments WHERE run_id = ? AND case_id = ? ORDER BY slot').bind(runId, CASE_ID).all();
  return result.results.map((row) => ({ slot: String(row.slot), filename: String(row.filename), bytes: Number(row.bytes), mime: String(row.mime), sha256: String(row.sha256), verifiedAt: String(row.verified_at) }));
}

async function getReceipt(runId: string) {
  const row = await env.DB.prepare('SELECT * FROM receipts WHERE run_id = ? LIMIT 1').bind(runId).first();
  return row ? { receiptId: String(row.receipt_id), custodyId: String(row.custody_id), packageId: String(row.package_id), packageHash: String(row.package_hash), receivedAt: String(row.received_at) } : null;
}

async function getPayment(runId: string) {
  const row = await env.DB.prepare('SELECT * FROM payment_intents WHERE run_id = ? LIMIT 1').bind(runId).first();
  return row ? { paymentId: String(row.payment_id), state: String(row.state), amountPaise: Number(row.amount_paise), reconciliationReference: String(row.reconciliation_reference), updatedAt: String(row.updated_at) } : null;
}

async function appendEvent(runId: string, eventType: string, actor: string, detail: string) {
  const latest = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM case_events WHERE run_id = ? AND case_id = ?').bind(runId, CASE_ID).first<{ seq: number }>();
  await env.DB.prepare(
    'INSERT INTO case_events (run_id, case_id, seq, event_type, actor, detail, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(runId, CASE_ID, Number(latest?.seq ?? 0) + 1, eventType, actor, detail, new Date().toISOString()).run();
}

function readRunId(request: Request) {
  const cookie = request.headers.get('cookie') ?? '';
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`));
  return part ? decodeURIComponent(part.slice(COOKIE_NAME.length + 1)) : null;
}

function toPackage(row: Record<string, unknown>) {
  return { packageId: String(row.package_id), version: Number(row.version), hash: String(row.package_hash), sealedAt: String(row.sealed_at), canonicalPayload: String(row.canonical_payload) };
}

function toSignature(row: Record<string, unknown>) {
  return { signatureId: String(row.signature_id), packageId: String(row.package_id), provider: String(row.provider), signedHash: String(row.signed_hash), signatureValue: String(row.signature_value), signedAt: String(row.signed_at) };
}

function errorResponse(code: string, stage: string, summary: string, retryable: boolean, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({
    error: {
      code, stage, fieldPath: null, documentSlot: null, blocking: status >= 400,
      retryable, summary, detail: retryable ? 'Your saved work is unchanged. Retrying is safe with the same persisted key.' : 'Your saved work is unchanged.',
      correlationId: `DARJ-CORR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      ...extra,
    },
  }, { status });
}
