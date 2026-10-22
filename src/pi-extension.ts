import { randomUUID } from 'node:crypto';
import { call, connectionAt, defaultDataDir } from './client.js';
import type { Connection } from './daemon.js';

// A tiny structural interface keeps this extension independent of a second Pi
// installation. The installed Pi supplies its real API at runtime (verified on 1.2.0).
interface PiAPI {
  on(event: string, handler: (event: any, context: any) => Promise<any>): void;
  registerCommand(name: string, options: { description: string; handler: (args: string, context: any) => Promise<void> }): void;
}

export default function wisdomTracking(pi: PiAPI): void {
  let connection: Connection;
  let captureId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let failure: string | undefined;
  let queue = Promise.resolve();
  const finished = new Set<string>();

  // Serial delivery preserves this extension's observation order. The tool_call
  // handler awaits the acknowledgement, so the before-image exists before execution.
  const send = (data: any) => {
    const task = queue.then(async () => {
      if (!captureId) throw new Error(failure ?? 'No active Wisdom capture');
      await call(connection, `/captures/${captureId}/observe`, { observationId: randomUUID(), ...data });
    });
    queue = task.catch(error => { failure = String(error); });
    return task;
  };
  const warn = (ctx: any, error: unknown) => {
    failure = String(error);
    ctx.ui?.setStatus('wisdom', 'Wisdom tracking interrupted');
    ctx.ui?.notify(`Wisdom tracking: ${failure}`, 'error');
  };

  pi.on('session_start', async (_event, ctx) => {
    finished.clear(); failure = undefined; queue = Promise.resolve();
    try {
      connection = connectionAt(process.env.WISDOM_DATA_DIR ?? defaultDataDir);
      const manifest = await call(connection, '/captures', {
        piSessionId: ctx.sessionManager.getSessionId(), workspaceRoot: ctx.cwd,
        source: ctx.sessionManager.getSessionFile() ?? null
      });
      captureId = manifest.captureId;
      ctx.ui?.setStatus('wisdom', `Wisdom ${captureId!.slice(0, 8)}`);
      heartbeat = setInterval(() => {
        if (captureId) void call(connection, `/captures/${captureId}/heartbeat`, {}).catch(error => {
          if (!failure) warn(ctx, error);
        });
      }, 5000);
      heartbeat.unref();
    } catch (error) { captureId = undefined; warn(ctx, error); }
  });

  pi.on('input', async (event, ctx) => {
    try { await send({ type: 'input', data: event }); } catch (error) { warn(ctx, error); }
    return { action: 'continue' };
  });
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (failure) throw new Error(failure);
      await send({ type: 'tool_started', toolCallId: event.toolCallId, toolName: event.toolName,
        parentToolCallId: event.parentToolCallId, data: { input: event.input } });
    } catch (error) {
      warn(ctx, error);
      return { block: true, reason: 'Wisdom cannot record this tool. Restore the daemon and /reload before continuing.' };
    }
  });

  const result = async (event: any, ctx: any) => {
    if (finished.has(event.toolCallId)) return;
    try {
      await send({ type: 'tool_finished', toolCallId: event.toolCallId, toolName: event.toolName,
        parentToolCallId: event.parentToolCallId, isError: event.isError,
        data: event.result ?? { content: event.content, details: event.details, structuredContent: event.structuredContent } });
      finished.add(event.toolCallId);
    } catch (error) { warn(ctx, error); }
  };
  pi.on('tool_result', result);
  // Blocked/validation-failed calls may skip tool_result. Preserve their execution
  // outcome too, while avoiding duplicate normal completion records.
  pi.on('tool_execution_end', result);
  for (const eventName of ['agent_settled', 'session_tree', 'session_compact']) {
    pi.on(eventName, async (event, ctx) => {
      try { await send({ type: eventName, data: eventName === 'agent_settled' ? undefined : event }); }
      catch (error) { warn(ctx, error); }
    });
  }
  pi.on('message_end', async (event, ctx) => {
    // Native session records supply persisted message bodies. Only keep fallback
    // bodies when Pi persistence is disabled, rather than duplicating every message.
    if (!ctx.sessionManager.getSessionFile()) {
      try { await send({ type: 'message', data: event.message }); } catch (error) { warn(ctx, error); }
    }
  });
  pi.on('session_shutdown', async (event, ctx) => {
    clearInterval(heartbeat); heartbeat = undefined;
    await queue;
    if (captureId) {
      try { await call(connection, `/captures/${captureId}/close`, { reason: event.reason }); }
      catch (error) { warn(ctx, error); }
    }
    captureId = undefined;
  });
  pi.registerCommand('wisdom-status', {
    description: 'Show the live Wisdom capture ID and tracking status',
    handler: async (_args, ctx) => ctx.ui.notify(failure ?? `Capture: ${captureId ?? 'not connected'}`, failure ? 'error' : 'info')
  });
}
