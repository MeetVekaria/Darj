import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const CASE_ID = 'SYN-CASE-AOC4-01';

export async function GET(request: Request) {
  const runId = readRunId(request);
  if (!runId || !(await activeRun(runId))) return NextResponse.json({ error: { code: 'DARJ_AUTH_REQUIRED', stage: 'LOGIN', blocking: true, retryable: true, summary: 'Re-enter the synthetic demo.', detail: 'Your local draft is unchanged.', correlationId: `DARJ-CORR-${crypto.randomUUID().slice(0, 8).toUpperCase()}` } }, { status: 401 });
  const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
  const result = await env.DB.prepare('SELECT * FROM case_events WHERE run_id = ? AND case_id = ? AND seq > ? ORDER BY seq').bind(runId, CASE_ID, Number.isFinite(after) ? after : 0).all();
  return NextResponse.json({ events: result.results.map(toEvent) }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function readRunId(request: Request) {
  const cookie = request.headers.get('cookie') ?? '';
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith('darj_demo_run='));
  return part ? decodeURIComponent(part.slice('darj_demo_run='.length)) : null;
}

function activeRun(runId: string) {
  return env.DB.prepare('SELECT run_id FROM demo_runs WHERE run_id = ? AND expires_at > ?').bind(runId, new Date().toISOString()).first();
}

function toEvent(row: Record<string, unknown>) {
  return { seq: Number(row.seq), eventType: String(row.event_type), actor: String(row.actor), detail: String(row.detail), occurredAt: String(row.occurred_at) };
}

