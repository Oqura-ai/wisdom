import { randomUUID } from 'node:crypto';
import { deliver } from '../../client.js';
import { hookDataDir } from '../../paths.js';

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

/** Runs for every hook of every Claude Code process that uses Wisdom's home, however it
 * was started. It never stops Claude Code: an event the daemon cannot take is kept in
 * the spool, and exit code 1 shows the warning without blocking.
 */
export async function main(named = process.argv[2]): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const mapped = observation(event);
  if (!mapped) return;
  try {
    const dataDir = hookDataDir('claude-code', process.env.CLAUDE_CONFIG_DIR, named);
    // Every hook names its session, so /clear, /resume and forks reach the right record. A
    // subagent's hooks name the parent session; its transcript is copied at SubagentStop.
    if (typeof event.session_id !== 'string' || !event.session_id) throw new Error('Claude Code hook has no session_id');
    const identity = { sessionId: event.session_id, ...(typeof event.agent_id === 'string' ? {} : { source: event.transcript_path }) };
    const { spooled } = await deliver(dataDir, { harness: 'claude-code', cwd: typeof event.cwd === 'string' ? event.cwd : process.cwd(),
      observation: { observationId: randomUUID(), ...identity, ...mapped } as any });
    if (spooled) {
      process.stderr.write(`Wisdom kept this ${event.hook_event_name} to record when its daemon is back (${spooled}). File changes meanwhile are not observed.\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Wisdom could not record or keep this ${event.hook_event_name}: ${error instanceof Error ? error.message : error}.\n`);
    process.exitCode = 1;
  }
}
