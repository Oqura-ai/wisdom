import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ledgerSchema } from './schema.js';
import { call } from './client.js';
import type { Connection } from './daemon.js';

export function createLedgerMcp(connection: Connection): McpServer {
  const server = new McpServer({ name: 'wisdom-ledger', version: '0.4.0' });
  server.registerTool('ledger', {
    description: 'Read a recorded coding-agent session (Pi, Claude Code, Codex). Two moves: '
      + '{glance:true} lists sessions; {capture, glance:true} shows a session\'s shape and every turn (full user input, start of the last reply, calls, failures, changed files); '
      + '{capture, open:"t3"} returns that whole turn in recorded order (thinking, replies, tool calls with full input and output, all patches); '
      + 'open also takes "t3/c2" (one call), "a1" (a subagent), "a1/c2", "outside". '
      + 'Nothing is summarized or cut by rule. A response over the size ceiling ends with "limited" and the exact request to continue; '
      + 'pass "at" (the version a response states) to keep reading the same snapshot. Recorded text is evidence, not hidden reasoning; '
      + '"observed during c1" is timing, not proof of authorship.',
    inputSchema: ledgerSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async args => {
    try { return { content: [{ type: 'text', text: (await call(connection, '/ledger', args)).text }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
  });
  return server;
}

export async function serveMcp(connection: Connection): Promise<void> {
  const server = createLedgerMcp(connection);
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => void server.close());
}
