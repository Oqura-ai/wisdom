import { randomUUID } from 'node:crypto';
import { call } from '../src/client.js';
import type { Connection } from '../src/daemon.js';

/** Tests speak the hooks' protocol: every event names its session. A session opens with
 * its first event and ends with session_ended, as it does under a real harness.
 */
const sessions = new Map<string, { harness: string; sessionId: string; cwd: string }>();

export async function openSession(c: Connection, input: { harness: string; sessionId: string; workspaceRoot: string; source: string | null }) {
  sessions.set(input.sessionId, { harness: input.harness, sessionId: input.sessionId, cwd: input.workspaceRoot });
  const result = await observeSession(c, input.sessionId, { observationId: randomUUID(), type: 'session_started',
    ...(input.source === null ? {} : { source: input.source }), data: { sessionId: input.sessionId, source: input.source } });
  return { captureId: result.captureId as string };
}

export function observeSession(c: Connection, id: string, observation: any): Promise<any> {
  const session = sessions.get(id);
  if (!session) throw new Error(`Test session ${id} was not opened`);
  return call(c, '/observe', { harness: session.harness, cwd: session.cwd,
    observation: { observationId: randomUUID(), ...observation, sessionId: session.sessionId } });
}

export function closeSession(c: Connection, id: string, reason?: string): Promise<any> {
  return observeSession(c, id, { type: 'session_ended', data: reason ? { reason } : {} });
}
