import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mcpQuerySchema } from './schema.js';
import { call } from './client.js';
import type { Connection } from './daemon.js';

export function createLedgerMcp(connection: Connection): McpServer {
  const server = new McpServer({ name: 'wisdom-ledger', version: '0.3.0' });
  server.registerTool('ledger_query', {
    description: 'Read Wisdom evidence while agents run. op=describe gives the vocabulary; op=sessions discovers captures. Use preset=intent|timeline|changes|failures|file-history|interaction-review with captureId or scope. Custom find=requests|messages|tools|outputs|changes|events supports where, select, include in one query, with readVersion and bounded continuations. Example: {find:"changes",scope:{workspaceRoot:"/project"},where:{path:"src/auth.ts","tool.isError":true},include:{request:{select:["content"]},outputs:{select:["content"]}}}. Use op=inspect with captureId, id, sections and readVersion for exact bodies. clean=true returns conversation content without metadata. Intent is recorded surface text, not hidden reasoning. Check gaps, linkBasis, attribution, pending results, and truncation before drawing conclusions.',
    inputSchema: mcpQuerySchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async args => {
    try {
      const result = await call(connection, '/query', args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
  });
  return server;
}

export async function serveMcp(connection: Connection): Promise<void> {
  const server = createLedgerMcp(connection);
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => void server.close());
}
