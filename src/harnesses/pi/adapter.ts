import path from 'node:path';
import { contentText, count, jsonlFiles, type HarnessAdapter, type NeutralUsage } from '../types.js';

/** Pi's Usage is already additive (input excludes cache) and carries cost. It appears
 * on assistant messages, standalone usage entries (cache warming) and compactions.
 */
function usage(entry: any): NeutralUsage[] {
  const raw = entry?.message?.role === 'assistant' ? entry.message.usage : entry?.usage;
  if (!raw || typeof raw !== 'object' || typeof entry?.id !== 'string') return [];
  return [{ key: entry.id, scope: 'call', model: entry.message?.model ?? entry.model, provider: entry.message?.provider ?? entry.provider,
    input: count(raw.input), cacheRead: count(raw.cacheRead), cacheWrite: count(raw.cacheWrite), output: count(raw.output),
    reasoning: count(raw.reasoning), costUsd: typeof raw.cost?.total === 'number' ? raw.cost.total : undefined }];
}

// Pi's message blocks (text, thinking, toolCall) already match the neutral shape.
export const pi: HarnessAdapter = {
  name: 'pi',
  homeEnv: 'PI_CODING_AGENT_DIR',
  defaultHome: ['.pi', 'agent'],
  resume: sessionId => ['pi', '--session', sessionId],
  toolTarget: (_toolName, input) => typeof input?.path === 'string' ? input.path : undefined,
  isDirectFileTool: toolName => ['read', 'edit', 'write'].includes(toolName),
  toolView: toolName => ['edit', 'write'].includes(toolName) ? 'patch' : toolName === 'read' ? 'file' : 'full',
  nativeSession: entry => entry?.type === 'session' && typeof entry.id === 'string' ? entry.id : undefined,
  nativeCwd: entry => entry?.type === 'session' && typeof entry.cwd === 'string' ? entry.cwd : undefined,
  nativeChanges: () => [],
  isScriptStep: () => false,
  // A fork's header is dated when it was made, before its copied lines' dates say otherwise.
  nativeForkedFrom: () => undefined,
  isNotice: () => false,
  // The header's `version` is its file format. The extension reports Pi's own version.
  nativeVersion: () => undefined,
  nativePrompt: entry => entry?.type === 'message' && entry.message?.role === 'user'
    ? contentText(entry.message.content)?.trim() || undefined : undefined,
  // sessions/<folder>/<time>_<session>.jsonl
  sessionFiles: home => jsonlFiles(path.join(home, 'sessions'), 1),
  sessionTraces: () => [],
  // Only the header names the session and its folder.
  cloneLine: (entry, { sessionId, move }) => entry?.type === 'session'
    ? { ...entry, id: sessionId, ...(typeof entry.cwd === 'string' ? { cwd: move(entry.cwd) } : {}) } : entry,
  // sessions/--<the folder, \ / and : as ->--/<ISO time, : and . as ->_<session>.jsonl
  sessionFile: (home, sessionId, cwd, now) => path.join(home, 'sessions', `--${cwd.replace(/[\\/:]/g, '-')}--`,
    `${now.toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`),
  nativeEntry: entry => ({ id: entry?.id, parentId: entry?.parentId, timestamp: entry?.timestamp,
    kind: String(entry?.type ?? 'unknown'), messages: entry?.message ? [entry.message] : [], usage: usage(entry) }),
};
