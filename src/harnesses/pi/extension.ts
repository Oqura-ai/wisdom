import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deliver, handoffFromEnv } from '../../client.js';
import { harnessHome } from '../../paths.js';

// A tiny structural interface keeps this extension independent of a second Pi
// installation. The installed Pi supplies its real API at runtime (verified on 1.2.0).
interface PiAPI {
  on(event: string, handler: (event: any, context: any) => Promise<any>): void;
  registerCommand(name: string, options: { description: string; handler: (args: string, context: any) => Promise<void> }): void;
}

/** Wisdom's data folder, when Pi runs with its agent folder inside one; otherwise this
 * Pi is outside Wisdom and nothing is recorded.
 */
function dataFolder(): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return undefined;
  const data = path.resolve(agentDir, '..', '..', '..');
  return path.resolve(harnessHome(data, 'pi')) === path.resolve(agentDir) ? data : undefined;
}

/** The version of the Pi that is running, from its own package. */
function piVersion(): string | undefined {
  try {
    for (let dir = path.dirname(fs.realpathSync(process.argv[1]!)); ; dir = path.dirname(dir)) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const { name, version } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (/pi-coding-agent$/.test(name) && typeof version === 'string') return version;
      }
      if (path.dirname(dir) === dir) return undefined;
    }
  } catch { return undefined; }
}

/** Loaded from the settings of Pi's home in Wisdom's folder. Every event names its
 * session, so /new, /fork, /clone and /resume reach the right record. It never blocks Pi:
 * an event the daemon cannot take is kept in the spool.
 */
export default function wisdomTracking(pi: PiAPI): void {
  const dataDir = dataFolder();
  if (!dataDir) return;
  let session: { sessionId: string; source: string | null; cwd: string } | undefined;
  let warning: string | undefined;
  let queue = Promise.resolve();
  const harnessVersion = piVersion();
  const handoff = handoffFromEnv();

  // Serial delivery preserves this extension's observation order. The tool_call
  // handler awaits it, so the before-image exists before execution.
  const send = (ctx: any, data: Record<string, unknown>) => {
    const current = session;
    const task = queue.then(async () => {
      if (!current) return;
      const { spooled } = await deliver(dataDir, { harness: 'pi', harnessVersion, cwd: current.cwd, ...handoff,
        observation: { observationId: randomUUID(), sessionId: current.sessionId, source: current.source, ...data } as any });
      if (spooled && !warning) {
        warning = `Wisdom is keeping events to record when its daemon is back (${spooled}).`;
        ctx.ui?.setStatus('wisdom', 'Wisdom: keeping events'); ctx.ui?.notify(warning, 'warning');
      } else if (!spooled && warning) { warning = undefined; ctx.ui?.setStatus('wisdom', 'Wisdom recording'); }
    });
    queue = task.catch(error => { ctx.ui?.notify(`Wisdom could not record or keep an event: ${String(error)}`, 'error'); });
    return queue;
  };

  pi.on('session_start', async (event, ctx) => {
    session = { sessionId: ctx.sessionManager.getSessionId(), source: ctx.sessionManager.getSessionFile() ?? null, cwd: ctx.cwd };
    ctx.ui?.setStatus('wisdom', 'Wisdom recording');
    await send(ctx, { type: 'session_started', data: { sessionId: session.sessionId, source: session.source, origin: event?.reason } });
  });
  pi.on('input', async (event, ctx) => { await send(ctx, { type: 'input', data: event }); return { action: 'continue' }; });
  pi.on('tool_call', async (event, ctx) => {
    await send(ctx, { type: 'tool_started', toolCallId: event.toolCallId, toolName: event.toolName,
      parentToolCallId: event.parentToolCallId, data: { input: event.input } });
  });

  const finished = new Set<string>();
  const result = async (event: any, ctx: any) => {
    if (finished.has(event.toolCallId)) return;
    finished.add(event.toolCallId);
    await send(ctx, { type: 'tool_finished', toolCallId: event.toolCallId, toolName: event.toolName,
      parentToolCallId: event.parentToolCallId, isError: event.isError,
      data: event.result ?? { content: event.content, details: event.details, structuredContent: event.structuredContent } });
  };
  pi.on('tool_result', result);
  // Blocked/validation-failed calls may skip tool_result. Preserve their execution
  // outcome too, while avoiding duplicate normal completion records.
  pi.on('tool_execution_end', result);
  for (const eventName of ['agent_settled', 'session_tree', 'session_compact']) {
    pi.on(eventName, async (event, ctx) => { await send(ctx, { type: eventName, data: eventName === 'agent_settled' ? undefined : event }); });
  }
  pi.on('message_end', async (event, ctx) => {
    // Native session records supply persisted message bodies. Only keep fallback
    // bodies when Pi persistence is disabled, rather than duplicating every message.
    if (!ctx.sessionManager.getSessionFile()) await send(ctx, { type: 'message', data: event.message });
  });
  pi.on('session_shutdown', async (event, ctx) => {
    await send(ctx, { type: 'session_ended', data: { reason: event?.reason } });
    session = undefined; finished.clear();
  });
  pi.registerCommand('wisdom-status', {
    description: 'Show the session Wisdom is recording',
    handler: async (_args, ctx) => ctx.ui.notify(warning ?? `Wisdom is recording session ${session?.sessionId ?? '(none yet)'}`, warning ? 'warning' : 'info')
  });
}
