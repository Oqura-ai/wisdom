import { randomUUID } from 'node:crypto';
import { call, connectionAt, defaultDataDir } from '../../client.js';
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

/** The only failure output Codex honours. Verified on Codex CLI 0.147.0: exit code 2
 * and crashes are logged as "Failed" and the tool still runs; this JSON blocks it.
 * Other events cannot undo work, so they get no decision.
 */
export function failureDecision(eventName: unknown, reason: string): string | undefined {
  if (eventName === 'PreToolUse') return JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  if (eventName === 'UserPromptSubmit') return JSON.stringify({ decision: 'block', reason });
  return undefined;
}

// Codex kills a hook at its 40 s timeout and then runs the tool, so Wisdom must
// answer well inside that window.
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

export async function main(): Promise<void> {
  const launchId = process.env.WISDOM_LAUNCH_ID;
  if (!launchId) { process.stdout.write('{}'); return; } // Hook trust setup, not recording.
  let event: any;
  let input = '';
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 15 * 1024 * 1024) throw new Error('Hook payload exceeds 15 MiB');
    }
    event = JSON.parse(input);
    const mapped = observation(event);
    if (mapped) {
      const connection = connectionAt(process.env.WISDOM_DATA_DIR ?? defaultDataDir);
      // A subagent's events name its own rollout file; that is not the session transcript
      // switching. Its transcript is copied separately at SubagentStop.
      const identity = { sessionId: event.session_id, ...(typeof event.agent_id === 'string' ? {} : { source: event.transcript_path }) };
      if (typeof identity.sessionId !== 'string' || !identity.sessionId) throw new Error('Codex hook has no session_id');
      // One request: the neutral observation plus the exact received JSON object,
      // kept as a separate record so it never enters clean conversation output.
      await call(connection, `/launches/${launchId}/observe`, { observationId: randomUUID(), ...identity, ...mapped,
        harnessEvent: event }, daemonTimeoutMs);
    }
    process.stdout.write('{}'); // Stop and SubagentStop require JSON, not plain text.
  } catch (error) {
    const name = event?.hook_event_name ?? /"hook_event_name"\s*:\s*"(\w+)"/.exec(input)?.[1];
    const reason = `Wisdom cannot record this ${name ?? 'hook'}: ${String(error instanceof Error ? error.message : error).replace(/\.$/, '')}. `
      + 'Restart the Wisdom daemon and start a new tracked Codex session; work stays paused until recording works.';
    const decision = failureDecision(name, reason);
    // Blocking events exit 0 with a decision: a non-zero exit would let the tool run.
    if (decision) process.stdout.write(decision);
    else { process.stderr.write(reason + '\n'); process.exitCode = 1; }
  }
}
