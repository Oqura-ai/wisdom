import type { Captures } from './captures.js';
import { querySchema } from './schema.js';
import { composableQuery } from './composable-query.js';
import { cleanQuery } from './clean-query.js';
import { inspectEvidence } from './evidence.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { vocabulary } from './vocabulary.js';

/** One service boundary for HTTP and MCP. Clients only submit requests. */
export function query(captures: Captures, input: unknown): unknown {
  const request = querySchema.parse(input);
  if (request.op === 'describe') return vocabulary;
  if (request.op === 'inspect') return inspectEvidence(captures, request);
  if (request.op === 'sessions') {
    const cursor = request.cursor ? decodeCursor(request.cursor) : undefined;
    if (cursor && (cursor.op !== 'sessions' || typeof cursor.after !== 'string')) throw new Error('Invalid sessions cursor');
    const rows = captures.database.sql.prepare('SELECT id,manifest FROM captures WHERE id>? ORDER BY id LIMIT ?')
      .all((cursor?.after as string) ?? '', request.limit + 1);
    return { items: rows.slice(0, request.limit).map(row => ({ ...JSON.parse(String(row.manifest)),
      lastSeq: captures.database.lastSeq(String(row.id)) })),
      nextCursor: rows.length > request.limit ? encodeCursor({ op: 'sessions', after: rows[request.limit - 1].id }) : null,
      note: 'Capture inventory and lifecycle status are live.' };
  }
  return request.clean ? cleanQuery(captures, request) : composableQuery(captures, request);
}
