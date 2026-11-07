import { randomUUID } from 'node:crypto';
import { deliver, handoffFromEnv } from '../../client.js';
import { hookDataDir, wisdomHomeData } from '../../paths.js';
import { exitEnvelope } from './adapter.js';

/** Unknown tool outcomes stay unknown. A PostToolUse is not proof of success. */
export function toolError(toolName: string, response: any): boolean | undefined {
  if (typeof response?.isError === 'boolean') return response.isError;
  if (typeof response?.is_error === 'boolean') return response.is_error;
  if (toolName !== 'Bash') return undefined;
  const code = response?.exit_code ?? response?.exitCode ?? response?.metadata?.exit_code;
  if (typeof code === 'number') return code !== 0;
  return exitEnvelope(response);
}

// Codex kills a hook at its 40 s timeout, so delivery (10 s) plus starting the daemon
// (up to 10 s) stays well inside that window.
const daemonTimeoutMs = 10000;

/** A spawned subagent's ID, from Codex spawn_agent's result. */
function childAgentId(toolName: unknown, response: unknown): string | undefined {
  if (toolName !== 'spawn_agent') return undefined;
  let value: any = response;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  return typeof value?.agent_id === 'string' ? value.agent_id : undefined;
}

export function observation(event: any): Record<string, unknown> | undefined {
  const identity = {
    ...(typeof event.turn_id === 'string' ? { turnId: event.turn_id } : {}),
    ...(typeof event.agent_id === 'string' ? { agentId: event.agent_id } : {}),
  };
  switch (event.hook_event_name) {
    case 'SessionStart': return { type: 'session_started', data: {
      sessionId: event.session_id, source: event.transcript_path, origin: event.source } };
    case 'SessionEnd': return { type: 'session_ended', data: { reason: event.reason } };
    case 'UserPromptSubmit': return { type: 'input', ...identity, data: { text: event.prompt } };
    case 'PreToolUse': return { type: 'tool_started', ...identity, toolCallId: event.tool_use_id,
      toolName: event.tool_name, data: { input: event.tool_input } };
    case 'PostToolUse': return { type: 'tool_finished', ...identity, toolCallId: event.tool_use_id,
      toolName: event.tool_name, isError: toolError(event.tool_name, event.tool_response),
      childAgentId: childAgentId(event.tool_name, event.tool_response), data: { response: event.tool_response } };
    case 'Stop': return { type: 'agent_settled', ...identity, data: { lastAssistantMessage: event.last_assistant_message } };
    case 'SubagentStart': return { type: 'subagent_started', ...identity, data: { agentType: event.agent_type } };
    case 'SubagentStop': return { type: 'subagent_stopped', ...identity,
      data: { agentType: event.agent_type, transcriptPath: event.agent_transcript_path, lastAssistantMessage: event.last_assistant_message } };
    case 'PreCompact': case 'PostCompact': return { type: 'session_compact', ...identity,
      data: { phase: event.hook_event_name, trigger: event.trigger } };
    default: return undefined;
  }
}

/** Runs for every hook of every Codex process that uses Wisdom's home. It never stops
 * Codex: an event the daemon cannot take is kept in the spool. It always answers `{}`
 * (Stop and SubagentStop require JSON); a warning goes to stderr with exit code 1.
 */
export async function main(named = process.argv[2], place = process.argv[3]): Promise<void> {
  let event: any;
  let input = '';
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 15 * 1024 * 1024) throw new Error('Hook payload exceeds 15 MiB');
    }
    event = JSON.parse(input);
    const mapped = observation(event);
    // The project's copy of the hook stands aside in a tracked session: its home's copy records it.
    if (mapped && !(place === 'project' && wisdomHomeData('codex', process.env.CODEX_HOME))) {
      const dataDir = hookDataDir('codex', process.env.CODEX_HOME, named);
      // A subagent's events name its own rollout file; that is not the session transcript
      // switching. Its transcript is copied separately at SubagentStop.
      const identity = { sessionId: event.session_id, ...(typeof event.agent_id === 'string' ? {} : { source: event.transcript_path }) };
      if (typeof identity.sessionId !== 'string' || !identity.sessionId) throw new Error('Codex hook has no session_id');
      // One request: the neutral observation plus the exact received JSON object,
      // kept as a separate record so it never enters clean conversation output.
      const { spooled } = await deliver(dataDir, { harness: 'codex', cwd: typeof event.cwd === 'string' ? event.cwd : process.cwd(), ...handoffFromEnv(),
        observation: { observationId: randomUUID(), ...identity, ...mapped, harnessEvent: event } as any }, daemonTimeoutMs);
      if (spooled) {
        process.stderr.write(`Wisdom kept this ${event.hook_event_name} to record when its daemon is back (${spooled}). File changes meanwhile are not observed.\n`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const name = event?.hook_event_name ?? /"hook_event_name"\s*:\s*"(\w+)"/.exec(input)?.[1];
    process.stderr.write(`Wisdom could not record or keep this ${name ?? 'hook'}: ${String(error instanceof Error ? error.message : error)}.\n`);
    process.exitCode = 1;
  }
  process.stdout.write('{}');
}
