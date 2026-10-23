import { daemon, localOnly } from '@/lib/daemon';

export const dynamic = 'force-dynamic';

/** Server-sent events: one message whenever the ledger's committed revision changes.
 * Clients refetch only then, so an idle project costs one small health call a second.
 */
export async function GET(request: Request) {
  const refused = localOnly(request);
  if (refused) return refused;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let last: string | undefined;
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const tick = async () => {
        let state: { status: string; readVersion?: number; error?: string };
        try { const health = await daemon('/health'); state = { status: 'live', readVersion: health.readVersion }; }
        catch (error) { state = { status: 'offline', error: (error as Error).message }; }
        const key = JSON.stringify(state);
        if (key !== last) { last = key; send('state', state); }
      };
      void tick(); timer = setInterval(() => void tick(), 1000);
      request.signal.addEventListener('abort', () => { clearInterval(timer); try { controller.close(); } catch { /* closed */ } });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
}
