import { env } from 'cloudflare:workers';
import { DataStore, ERRORS, Server, Upload } from '@tus/server';
import type { Readable } from 'node:stream';
import { sha256Hex } from '@/lib/canonical';
import { MAX_DEMO_PDF_BYTES, sniffDemoPdf } from '@/lib/pdf';

export const dynamic = 'force-dynamic';

const COOKIE_NAME = 'darj_demo_run';
const CSRF_COOKIE_NAME = 'darj_csrf';
const CASE_ID = 'DARJ-DEMO-AOC4-01';
const TUS_PATH = '/api/darj/uploads';
const ALLOWED_SLOTS = new Set(['financialStatements', 'auditorReport', 'boardReport']);
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

type UploadSessionRow = {
  run_id: string;
  upload_id: string;
  case_id: string;
  slot: string;
  filename: string;
  expected_bytes: number;
  confirmed_offset: number;
  client_sha256: string;
  fingerprint: string;
  object_key: string;
  provider_upload_id: string | null;
  uploaded_parts_json: string;
  state: string;
  created_at: string;
  expires_at: string;
};

class R2MultipartTusStore extends DataStore {
  extensions = ['creation', 'termination'];

  async create(file: Upload) {
    const metadata = file.metadata ?? {};
    const runId = metadata.runId ?? '';
    const slot = metadata.slot ?? '';
    const filename = metadata.filename ?? '';
    const filetype = metadata.filetype ?? '';
    const clientSha256 = metadata.sha256 ?? '';
    const fingerprint = metadata.fingerprint ?? '';
    if (!runId || !ALLOWED_SLOTS.has(slot) || !/^DARJ-[A-Za-z0-9._ -]+\.pdf$/u.test(filename) || filetype !== 'application/pdf') throw ERRORS.INVALID_METADATA;
    if (!/^[a-f0-9]{64}$/u.test(clientSha256) || !fingerprint || fingerprint.length > 500 || !file.size || !Number.isSafeInteger(file.size) || file.size > MAX_DEMO_PDF_BYTES) throw ERRORS.INVALID_METADATA;

    const existing = await env.DB.prepare('SELECT object_key, bytes, sha256 FROM attachments WHERE run_id = ? AND case_id = ? AND slot = ?').bind(runId, CASE_ID, slot).first();
    const now = new Date();
    const objectKey = existing && String(existing.sha256) === clientSha256 && Number(existing.bytes) === file.size
      ? String(existing.object_key)
      : `demo/${runId}/${CASE_ID}/${slot}-${file.id}.pdf`;
    let providerUploadId: string | null = null;
    let state = 'UPLOADING';
    let offset = 0;
    if (existing && String(existing.sha256) === clientSha256 && Number(existing.bytes) === file.size) {
      state = 'COMPLETE';
      offset = file.size;
    } else {
      const multipart = await env.FILES.createMultipartUpload(objectKey, {
        httpMetadata: { contentType: 'application/pdf', contentDisposition: `attachment; filename="${filename.replaceAll('"', '')}"` },
      });
      providerUploadId = multipart.uploadId;
    }
    await env.DB.prepare(`INSERT INTO upload_sessions
      (run_id, upload_id, case_id, slot, filename, expected_bytes, confirmed_offset, client_sha256, fingerprint, object_key, provider_upload_id, uploaded_parts_json, state, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`)
      .bind(runId, file.id, CASE_ID, slot, filename, file.size, offset, clientSha256, fingerprint, objectKey, providerUploadId, state, now.toISOString(), now.toISOString(), new Date(now.getTime() + UPLOAD_TTL_MS).toISOString()).run();
    return new Upload({ ...file, offset, storage: { type: 'r2-multipart', path: objectKey, bucket: 'FILES' } });
  }

  async getUpload(id: string) {
    const row = await getUploadSession(id);
    if (!row) throw ERRORS.FILE_NOT_FOUND;
    if (row.state === 'ABORTED' || row.state === 'FAILED') throw ERRORS.FILE_NO_LONGER_EXISTS;
    return new Upload({
      id,
      size: Number(row.expected_bytes),
      offset: Number(row.confirmed_offset),
      metadata: {
        runId: row.run_id,
        caseId: row.case_id,
        slot: row.slot,
        filename: row.filename,
        filetype: 'application/pdf',
        sha256: row.client_sha256,
        fingerprint: row.fingerprint,
      },
      storage: { type: 'r2-multipart', path: row.object_key, bucket: 'FILES' },
      creation_date: row.created_at,
    });
  }

  async write(stream: Readable, id: string, offset: number) {
    const row = await getUploadSession(id);
    if (!row) throw ERRORS.FILE_NOT_FOUND;
    if (row.state !== 'UPLOADING' || Number(row.confirmed_offset) !== offset || !row.provider_upload_id) throw ERRORS.INVALID_OFFSET;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    if (total === 0 || offset + total > Number(row.expected_bytes)) throw ERRORS.ERR_SIZE_EXCEEDED;

    const parts = JSON.parse(row.uploaded_parts_json) as R2UploadedPart[];
    const multipart = env.FILES.resumeMultipartUpload(row.object_key, row.provider_upload_id);
    const uploadedPart = await multipart.uploadPart(parts.length + 1, bytes);
    const nextOffset = offset + total;
    const nextParts = [...parts, { partNumber: uploadedPart.partNumber, etag: uploadedPart.etag }];
    const updated = await env.DB.prepare(`UPDATE upload_sessions SET confirmed_offset = ?, uploaded_parts_json = ?, updated_at = ?
      WHERE upload_id = ? AND confirmed_offset = ? AND state = 'UPLOADING'`)
      .bind(nextOffset, JSON.stringify(nextParts), new Date().toISOString(), id, offset).run();
    if (Number(updated.meta.changes ?? 0) !== 1) throw ERRORS.INVALID_OFFSET;

    if (nextOffset === Number(row.expected_bytes)) {
      await multipart.complete(nextParts);
      const stored = await env.FILES.get(row.object_key);
      if (!stored) {
        await failUpload(id, row.object_key);
        throw ERRORS.FILE_WRITE_ERROR;
      }
      const storedBytes = new Uint8Array(await stored.arrayBuffer());
      const serverHash = await sha256Hex(storedBytes);
      if (!sniffDemoPdf(storedBytes) || storedBytes.byteLength !== Number(row.expected_bytes) || serverHash !== row.client_sha256) {
        await failUpload(id, row.object_key);
        throw ERRORS.FILE_WRITE_ERROR;
      }
      const verifiedAt = new Date().toISOString();
      const currentVersion = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM attachment_versions WHERE run_id = ? AND case_id = ? AND slot = ?').bind(row.run_id, CASE_ID, row.slot).first();
      const version = Number(currentVersion?.version ?? 0) + 1;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO attachment_versions (run_id, case_id, slot, version, filename, object_key, bytes, mime, sha256, verified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)`)
          .bind(row.run_id, CASE_ID, row.slot, version, row.filename, row.object_key, storedBytes.byteLength, serverHash, verifiedAt),
        env.DB.prepare(`INSERT INTO attachments (run_id, case_id, slot, filename, object_key, bytes, mime, sha256, verified_at)
          VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?)
          ON CONFLICT(run_id, case_id, slot) DO UPDATE SET filename=excluded.filename, object_key=excluded.object_key, bytes=excluded.bytes, mime=excluded.mime, sha256=excluded.sha256, verified_at=excluded.verified_at`)
          .bind(row.run_id, CASE_ID, row.slot, row.filename, row.object_key, storedBytes.byteLength, serverHash, verifiedAt),
        env.DB.prepare(`UPDATE upload_sessions SET state = 'COMPLETE', confirmed_offset = expected_bytes, updated_at = ? WHERE upload_id = ?`).bind(verifiedAt, id),
      ]);
    }
    return nextOffset;
  }

  async remove(id: string) {
    const row = await getUploadSession(id);
    if (!row) throw ERRORS.FILE_NOT_FOUND;
    if (row.provider_upload_id && row.state === 'UPLOADING') await env.FILES.resumeMultipartUpload(row.object_key, row.provider_upload_id).abort();
    await env.DB.prepare(`UPDATE upload_sessions SET state = 'ABORTED', updated_at = ? WHERE upload_id = ?`).bind(new Date().toISOString(), id).run();
  }
}

async function getUploadSession(id: string) {
  return env.DB.prepare('SELECT * FROM upload_sessions WHERE upload_id = ?').bind(id).first<UploadSessionRow>();
}

async function failUpload(id: string, objectKey: string) {
  await env.FILES.delete(objectKey);
  await env.DB.prepare(`UPDATE upload_sessions SET state = 'FAILED', updated_at = ? WHERE upload_id = ?`).bind(new Date().toISOString(), id).run();
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get('cookie') ?? '';
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

async function authorizeTusRequest(request: Request, uploadId?: string) {
  const runId = readCookie(request, COOKIE_NAME);
  const csrfHeader = request.headers.get('x-darj-csrf');
  const csrfCookie = readCookie(request, CSRF_COOKIE_NAME);
  const run = runId ? await env.DB.prepare('SELECT 1 AS ok FROM demo_runs WHERE run_id = ? AND expires_at > ?').bind(runId, new Date().toISOString()).first() : null;
  if (!runId || !run || !csrfHeader || csrfHeader !== csrfCookie) throw { status_code: 401, body: 'DARJ upload session is not authorized.\n' };
  if (uploadId) {
    const session = await env.DB.prepare('SELECT run_id FROM upload_sessions WHERE upload_id = ?').bind(uploadId).first();
    if (session && String(session.run_id) !== runId) throw { status_code: 404, body: 'Upload not found.\n' };
  }
  return runId;
}

const server = new Server({
  path: TUS_PATH,
  datastore: new R2MultipartTusStore(),
  maxSize: MAX_DEMO_PDF_BYTES,
  relativeLocation: true,
  disableTerminationForFinishedUploads: true,
  namingFunction: () => crypto.randomUUID(),
  async onIncomingRequest(request, uploadId) {
    await authorizeTusRequest(request, uploadId);
  },
  async onUploadCreate(request, upload) {
    const runId = await authorizeTusRequest(request);
    return { metadata: { ...upload.metadata, runId, caseId: CASE_ID } };
  },
});

async function handle(request: Request) {
  const response = await server.handleWeb(request);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export const POST = handle;
export const PATCH = handle;
export const HEAD = handle;
export const DELETE = handle;
export const OPTIONS = handle;
