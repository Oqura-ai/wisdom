import type { SQLInputValue } from 'node:sqlite';
import { workspaceKey } from './database.js';
import { filterColumns, resources } from './vocabulary.js';
import type { Query } from './schema.js';

export type Resource = keyof typeof resources;

function bound(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error('Filter values must be strings, finite numbers, booleans, or null');
}

function comparison(column: string, value: unknown, bindings: SQLInputValue[]): string {
  const operations: [string, unknown][] = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value) : [['eq', value]];
  if (!operations.length) throw new Error('An empty filter does not express a condition');
  return operations.map(([operator, operand]) => {
    if (operator === 'in') {
      if (!Array.isArray(operand) || operand.length < 1 || operand.length > 100) throw new Error('in needs 1–100 values');
      if (operand.includes(null)) throw new Error('Use eq:null instead of null in an in filter');
      bindings.push(...operand.map(bound));
      return `${column} IN (${operand.map(() => '?').join(',')})`;
    }
    if (operator === 'eq' && operand === null) return `${column} IS NULL`;
    if (operator === 'contains') {
      if (typeof operand !== 'string') throw new Error('contains needs a string');
      bindings.push(operand);
      return `instr(lower(${column}),lower(?))>0`;
    }
    const sqlOperator = ({ eq: '=', gte: '>=', lte: '<=' } as Record<string, string>)[operator];
    if (!sqlOperator) throw new Error(`Unknown filter operator: ${operator}`);
    bindings.push(bound(operand)); return `${column}${sqlOperator}?`;
  }).map(sql => `(${sql})`).join(' AND ');
}

/** Normalize only path-filter values, including operator operands. All clients
 * get the same workspace-relative slash convention; other strings stay literal.
 */
function normalizePath(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\\', '/');
  if (Array.isArray(value)) return value.map(normalizePath);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizePath(v)]));
  return value;
}

/** Compile a small, explicit vocabulary to parameterized SQL. This is deliberately
 * not a general SQL language or a natural-language query interpreter.
 */
export function filters(where: Record<string, unknown>, bindings: SQLInputValue[]): string[] {
  if (Object.keys(where).length > 30) throw new Error('At most 30 filter fields are allowed');
  return Object.entries(where).map(([field, value]) => {
    if (field === 'surface') {
      if (typeof value !== 'boolean') throw new Error('surface needs a boolean');
      const surface = `(r.type='input' OR ${resources.messages})`;
      return value ? surface : `NOT ${surface}`;
    }
    if (field === 'tool.name' || field === 'tool.isError') {
      const test = comparison(field === 'tool.name' ? 't.tool_name' : 't.is_error', value, bindings);
      return `EXISTS(SELECT 1 FROM records t WHERE t.capture_id=r.capture_id AND t.revision<=r_boundary.version
        AND t.tool_call_id=r.tool_call_id AND t.type IN ('tool_started','tool_finished') AND ${test})`;
    }
    if (!Object.hasOwn(filterColumns, field)) throw new Error(`Unknown filter field: ${field}`);
    return comparison(filterColumns[field], field === 'path' ? normalizePath(value) : value, bindings);
  });
}

export function selection(request: Query, readVersion: number, after: number) {
  const bindings: SQLInputValue[] = [readVersion];
  const clauses = ['r.revision<=r_boundary.version', 'r.revision>?']; bindings.push(after);
  const scope = request.scope;
  if (!request.captureId && !scope?.captureIds && !scope?.sessionIds && !scope?.workspaceRoot) {
    throw new Error('Supply captureId or scope with captureIds, sessionIds, or workspaceRoot');
  }
  if (request.captureId) { clauses.push('r.capture_id=?'); bindings.push(request.captureId); }
  for (const [column, values] of [['r.capture_id', scope?.captureIds], ['c.session_id', scope?.sessionIds]] as const) {
    if (values) { clauses.push(`${column} IN (${values.map(() => '?').join(',')})`); bindings.push(...values); }
  }
  if (scope?.workspaceRoot) { clauses.push('c.workspace_root=?'); bindings.push(workspaceKey(scope.workspaceRoot)); }
  clauses.push(resources[request.find ?? 'events']);
  clauses.push(...filters(request.where ?? {}, bindings));
  return { bindings, from: `FROM records r JOIN captures c ON c.id=r.capture_id
    CROSS JOIN (SELECT ? AS version) r_boundary WHERE ${clauses.join(' AND ')}` };
}
