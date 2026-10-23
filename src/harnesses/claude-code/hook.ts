import { randomUUID } from 'node:crypto';
import { call, connectionAt, defaultDataDir } from '../../client.js';

/** Map one Claude Code hook payload to a neutral observation. Verified against
 * Claude Code 2.1.306 payloads; unknown events are ignored, not guessed.
 */
export function observation(event: any): Record<string, unknown> | undefined {
  const agent = typeof event.agent_id === 'string' ? { agentId: event.agent_id } : {};
  const tool = { toolCallId: event.tool_use_id, toolName: event.tool_name, ...agent };
  switch (event.hook_event_name) {
    case 'SessionStart': return { type: 'session_started',
      data: { sessionId: event.session_id, source: event.transcript_path, origin: event.source } };
    case 'SessionEnd': return { type: 'session_ended', data: { sessionId: event.session_id, reason: event.reason } };
    case 'UserPromptSubmit': return { type: 'input', data: { text: event.prompt, promptId: event.prompt_id } };
    case 'PreToolUse': return { type: 'tool_started', ...tool, data: { input: event.tool_input } };
    case 'PostToolUse': return { type: 'tool_finished', ...tool, isError: false,
      ...(typeof event.tool_response?.agentId === 'string' ? { childAgentId: event.tool_response.agentId } : {}),
      data: { response: event.tool_response, durationMs: event.duration_ms } };
    case 'PostToolUseFailure': return { type: 'tool_finished', ...tool, isError: true,
      data: { error: event.error, isInterrupt: event.is_interrupt, durationMs: event.duration_ms } };
    case 'Stop': return { type: 'agent_settled', data: { lastAssistantMessage: event.last_assistant_message } };
    case 'SubagentStart': return { type: 'subagent_started', ...agent, data: { agentType: event.agent_type } };
    case 'SubagentStop': return { type: 'subagent_stopped', ...agent,
      data: { agentType: event.agent_type, transcriptPath: event.agent_transcript_path, lastAssistantMessage: event.last_assistant_message } };
    case 'PreCompact': return { type: 'session_compact', data: { trigger: event.trigger } };
    default: return undefined;
  }
}

// Fail closed where Claude Code allows blocking: no unrecorded tool or prompt runs.
const blocking = new Set(['PreToolUse', 'UserPromptSubmit']);

export async function main(): Promise<void> {
  const captureId = process.env.WISDOM_CAPTURE_ID;
  if (!captureId) return; // Not started by `wisdom track claude`.
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const mapped = observation(event);
  if (!mapped) return;
  try {
    const connection = connectionAt(process.env.WISDOM_DATA_DIR ?? defaultDataDir);
    await call(connection, `/captures/${captureId}/observe`, { observationId: randomUUID(), ...mapped });
  } catch (error) {
    process.stderr.write(`Wisdom cannot record this ${event.hook_event_name}: ${error instanceof Error ? error.message : error}. `
      + 'Restart the Wisdom daemon; work stays paused until recording works.\n');
    process.exitCode = blocking.has(event.hook_event_name) ? 2 : 1;
  }
}
