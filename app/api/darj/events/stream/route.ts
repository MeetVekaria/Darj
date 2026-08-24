import { env } from 'cloudflare:workers';

export const dynamic = 'force-dynamic';

const CASE_ID = 'SYN-CASE-AOC4-01';

export async function GET(request: Request) {
  const runId = readRunId(request);
  if (!runId || !(await activeRun(runId))) return new Response('Authentication required', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const urlAfter = Number(new URL(request.url).searchParams.get('after') ?? 0);
  const headerAfter = Number(request.headers.get('last-event-id') ?? 0);
  const after = Math.max(Number.isFinite(urlAfter) ? urlAfter : 0, Number.isFinite(headerAfter) ? headerAfter : 0);
  const result = await env.DB.prepare('SELECT * FROM case_events WHERE run_id = ? AND case_id = ? AND seq > ? ORDER BY seq').bind(runId, CASE_ID, after).all();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('retry: 5000\n\n'));
      for (const row of result.results) {
        const event = { seq: Number(row.seq), eventType: String(row.event_type), actor: String(row.actor), detail: String(row.detail), occurredAt: String(row.occurred_at) };
        controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } });
}

function readRunId(request: Request) {
  const cookie = request.headers.get('cookie') ?? '';
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith('darj_demo_run='));
  return part ? decodeURIComponent(part.slice('darj_demo_run='.length)) : null;
}

function activeRun(runId: string) {
  return env.DB.prepare('SELECT run_id FROM demo_runs WHERE run_id = ? AND expires_at > ?').bind(runId, new Date().toISOString()).first();
}

