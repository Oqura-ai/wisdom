import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { call } from '../service/client.js';
import type { Connection } from '../service/daemon.js';
import { wisdomVersion } from '../setup/doctor.js';
import { hash } from '../storage/ledger.js';
import type { LedgerRecord, Manifest } from '../core/schema.js';
import { maskSecret, redactSecrets, scanSecrets } from './secrets.js';

/** A share file is gzipped JSON lines: a header, each session's manifest and records, its
 * evidence files, and an end line. Plain records, not a database, so it can be read without
 * Wisdom and checked before it is sent. Bump this when the layout changes.
 */
export const SHARE_FORMAT = 1;

interface Exported { readVersion: number; manifest: Manifest; records: LedgerRecord[]; dir: string; files: string[]; nativeBytes: number }

/** One piece of text bound for the file, and how to name a place inside it. */
interface Piece { captureId: string; record?: LedgerRecord; path?: string; encoding: 'utf8' | 'base64'; text: string; place: (index: number) => string }

export interface Finding { kind: string; value: string; shown: string; places: string[] }

export interface ShareDraft {
  sessions: Exported[];
  pieces: Piece[];
  findings: Finding[];
  /** Places that name this machine's home folder, which includes the username. */
  homePlaces: number;
  /** Files that are not text, so the scan could not read them. */
  unscanned: number;
}

/** What a record is, in words a person scanning the findings recognizes. */
function describe(record: LedgerRecord): string {
  switch (record.type) {
    case 'input': return 'prompt';
    case 'tool_started': return `${record.toolName ?? 'tool'} input`;
    case 'tool_finished': return `${record.toolName ?? 'tool'} output`;
    case 'file_change': return `change to ${record.path}`;
    default: return record.type.startsWith('source_') ? 'transcript' : record.type.replaceAll('_', ' ');
  }
}

/** Each record's turn or subagent, numbered as glance numbers them. */
function positions(records: LedgerRecord[]): Map<string, string> {
  const turns = new Map<string, number>();
  const agents: string[] = [];
  const labels = new Map<string, string>();
  for (const record of records) {
    if (record.type === 'input' && !record.agentId) turns.set(record.id, turns.size + 1);
    if (record.agentId && record.type !== 'usage' && !agents.includes(record.agentId)) agents.push(record.agentId);
    const turn = turns.get(record.type === 'input' && !record.agentId ? record.id : record.requestId ?? '');
    labels.set(record.id, record.agentId && agents.includes(record.agentId) ? `a${agents.indexOf(record.agentId) + 1}` : turn ? `t${turn}` : 'outside');
  }
  return labels;
}

function pieces(session: Exported): { pieces: Piece[]; unscanned: number } {
  const { manifest, records, dir, files, nativeBytes } = session;
  const captureId = manifest.captureId;
  const labels = positions(records);
  const at = (record: LedgerRecord, what = describe(record)) => `${labels.get(record.id)} · ${what}`;
  const owners = new Map<string, string>();
  for (const record of records) {
    if (record.dataRef) owners.set(`payloads/${record.dataRef}`, at(record));
    if (record.patchRef) owners.set(`payloads/${record.patchRef}`, at(record, `patch of ${record.path}`));
  }
  const transcript = records.filter(record => record.sourceOffset !== undefined);
  const result: Piece[] = records.map(record => ({ captureId, record, encoding: 'utf8', text: JSON.stringify(record), place: () => at(record) }));
  let unscanned = 0;
  for (const file of files) {
    let bytes = fs.readFileSync(path.join(dir, file));
    if (file === 'native-session.jsonl') bytes = bytes.subarray(0, nativeBytes);
    const text = bytes.toString('utf8');
    const utf8 = Buffer.from(text, 'utf8').equals(bytes);
    if (!utf8) unscanned++;
    const place = file === 'native-session.jsonl'
      ? (index: number) => {
          const offset = Buffer.byteLength(text.slice(0, index));
          const record = transcript.find(r => offset >= r.sourceOffset! && offset < r.sourceOffset! + (r.sourceLength ?? 0));
          return record ? at(record, 'harness transcript') : 'harness transcript';
        }
      : () => owners.get(file) ?? (file.startsWith('subagents/') ? 'subagent transcript' : file);
    result.push({ captureId, path: file, encoding: utf8 ? 'utf8' : 'base64', text: utf8 ? text : bytes.toString('base64'), place });
  }
  return { pieces: result, unscanned };
}

/** Read the sessions through the daemon's export view and find what looks like a secret.
 * Nothing is written.
 */
export async function draftShare(connection: Connection, refs: string[]): Promise<ShareDraft> {
  const exported: Exported[] = await Promise.all(refs.map(capture => call(connection, '/view', { view: 'export', capture })));
  const sessions = exported.filter((session, index) => exported.findIndex(other => other.manifest.captureId === session.manifest.captureId) === index);
  const built = sessions.map(pieces);
  const all = built.flatMap(b => b.pieces);
  const text = all.filter(piece => piece.encoding === 'utf8');
  return { sessions, pieces: all, findings: findSecrets(text), homePlaces: homePlaces(text.map(piece => piece.text)), unscanned: built.reduce((n, b) => n + b.unscanned, 0) };
}

/** What looks like a secret, once per value, with every place it appears. */
export function findSecrets(texts: { text: string; place: (index: number) => string }[]): Finding[] {
  const findings = new Map<string, Finding>();
  for (const { text, place } of texts) {
    for (const match of scanSecrets(text)) {
      const finding = findings.get(match.value) ?? { kind: match.kind, value: match.value, shown: maskSecret(match.value), places: [] };
      const where = place(match.index);
      if (!finding.places.includes(where)) finding.places.push(where);
      findings.set(match.value, finding);
    }
  }
  return [...findings.values()];
}

/** How often this machine's home folder, which names the user, appears in these texts. */
export function homePlaces(texts: string[]): number {
  const home = os.homedir();
  const forms = [...new Set([home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\')])];
  return texts.reduce((sum, text) => sum + forms.reduce((n, form) => n + text.split(form).length - 1, 0), 0);
}

/** Each session's transcript copy, redacted line by line, and where each line now starts and
 * how long it is, keyed by where it started. Records name their line by byte offset, so they
 * are pointed at the redacted line. Nothing to redact leaves the transcripts as they are.
 */
function redactTranscripts(pieces: Piece[], values: Map<string, string>): Map<string, { text: string; lines: Map<number, { offset: number; length: number }> }> {
  const result = new Map<string, { text: string; lines: Map<number, { offset: number; length: number }> }>();
  if (!values.size) return result;
  for (const piece of pieces) {
    if (piece.path !== 'native-session.jsonl' || piece.encoding !== 'utf8') continue;
    const lines = new Map<number, { offset: number; length: number }>();
    let from = 0, to = 0, text = '';
    // Each line keeps its newline, as the byte offsets count it.
    for (const line of piece.text.split(/(?<=\n)/)) {
      const after = redactSecrets(line, values);
      lines.set(from, { offset: to, length: Buffer.byteLength(after) });
      from += Buffer.byteLength(line); to += Buffer.byteLength(after); text += after;
    }
    result.set(piece.captureId, { text, lines });
  }
  return result;
}

/** Write the file. Redacted values are replaced in every piece, in this file only; the
 * recording itself is never changed. The header lists each redaction, never its value.
 */
export function writeShare(draft: ShareDraft, redact: Finding[], out: string): { file: string; bytes: number } {
  const values = new Map(redact.map(finding => [finding.value, finding.kind]));
  const lines: string[] = [];
  const edited = new Set<string>();
  const body: string[] = [];
  for (const session of draft.sessions) {
    body.push(JSON.stringify({ kind: 'session', manifest: session.manifest }));
  }
  const transcripts = redactTranscripts(draft.pieces, values);
  for (const piece of draft.pieces) {
    const text = piece.path === 'native-session.jsonl' && transcripts.has(piece.captureId) ? transcripts.get(piece.captureId)!.text
      : piece.encoding === 'utf8' ? redactSecrets(piece.text, values) : piece.text;
    if (text !== piece.text && piece.path) edited.add(`${piece.captureId}/${piece.path}`);
    if (piece.record) {
      // A record points at its transcript line by byte; a redacted line can be longer or shorter.
      const record: LedgerRecord = JSON.parse(text);
      const line = record.sourceOffset === undefined ? undefined : transcripts.get(piece.captureId)?.lines.get(record.sourceOffset);
      if (line) { record.sourceOffset = line.offset; record.sourceLength = line.length; }
      body.push(JSON.stringify({ kind: 'record', captureId: piece.captureId, record }));
    }
    else body.push(JSON.stringify({ kind: 'file', captureId: piece.captureId, path: piece.path, encoding: piece.encoding,
      sha256: hash(piece.encoding === 'utf8' ? text : Buffer.from(text, 'base64')), content: text }));
  }
  const patchesEdited = draft.sessions.flatMap(session => session.records
    .filter(record => record.patchRef && edited.has(`${session.manifest.captureId}/payloads/${record.patchRef}`))
    .map(record => ({ captureId: session.manifest.captureId, path: record.path })));
  lines.push(JSON.stringify({ kind: 'wisdom-share', format: SHARE_FORMAT, wisdomVersion: wisdomVersion(), createdAt: new Date().toISOString(),
    sessions: draft.sessions.map(({ manifest, readVersion }) => ({ captureId: manifest.captureId, harness: manifest.harness,
      harnessVersion: manifest.harnessVersion, project: path.basename(manifest.workspaceRoot), version: readVersion })),
    redactions: redact.map(({ kind, places }) => ({ kind, places })), keptFindings: draft.findings.length - redact.length, patchesEdited }));
  lines.push(...body, JSON.stringify({ kind: 'end', lines: body.length + 1 }));
  const bytes = zlib.gzipSync(lines.join('\n') + '\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out + '.tmp', bytes);
  fs.renameSync(out + '.tmp', out);
  return { file: out, bytes: bytes.length };
}

export interface ShareFile {
  header: { format: number; wisdomVersion: string; createdAt: string; sessions: { captureId: string; harness: string; project: string }[];
    redactions: { kind: string; places: string[] }[]; keptFindings: number; patchesEdited: { captureId: string; path?: string }[] };
  manifests: Manifest[];
  records: { captureId: string; record: LedgerRecord }[];
  files: { captureId: string; path: string; encoding: 'utf8' | 'base64'; content: string }[];
}

/** Read a share file back, checking its format, every file's checksum, and that nothing
 * is missing from the end. Checksums catch damage, not deliberate edits.
 */
export function readShare(file: string): ShareFile {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const [header, ...rest] = lines;
  if (header?.kind !== 'wisdom-share') throw new Error(`${file} is not a Wisdom share file.`);
  if (header.format !== SHARE_FORMAT) throw new Error(`${file} uses share format ${header.format}; this Wisdom reads format ${SHARE_FORMAT}.`);
  const end = rest.pop();
  if (end?.kind !== 'end' || end.lines !== lines.length - 1) throw new Error(`${file} is incomplete.`);
  const result: ShareFile = { header, manifests: [], records: [], files: [] };
  for (const line of rest) {
    if (line.kind === 'session') result.manifests.push(line.manifest);
    else if (line.kind === 'record') result.records.push({ captureId: line.captureId, record: line.record });
    else if (line.kind === 'file') {
      if (hash(line.encoding === 'utf8' ? line.content : Buffer.from(line.content, 'base64')) !== line.sha256) throw new Error(`${file} is damaged: ${line.path} does not match its checksum.`);
      result.files.push({ captureId: line.captureId, path: line.path, encoding: line.encoding, content: line.content });
    }
  }
  return result;
}

export function formatFindings(findings: Finding[]): string {
  const lines = [`Found ${findings.length === 1 ? '1 possible secret' : `${findings.length} possible secrets`}:`];
  findings.forEach((finding, index) => {
    const more = finding.places.length > 1 ? `  (and ${finding.places.length - 1} other place${finding.places.length > 2 ? 's' : ''})` : '';
    lines.push(`  ${String(index + 1).padEnd(3)}${finding.kind.padEnd(19)}${finding.shown.padEnd(18)}${finding.places[0]}${more}`);
  });
  return lines.join('\n');
}

/** Which findings to redact: all, none, or one by one. With no one to ask and no flag
 * saying what to do, nothing is shared. Any answer not understood cancels.
 */
export async function chooseRedactions(findings: Finding[], flags: { redact?: boolean; keep?: boolean },
  ask?: (question: string) => Promise<string>): Promise<Finding[] | undefined> {
  if (!findings.length || flags.keep) return [];
  if (flags.redact) return findings;
  if (!ask) throw new Error('Possible secrets were found, so nothing was written. Run again with --redact to replace them in the file, or --keep-secrets to send them as they are.');
  const answer = (await ask('\nRedact all and share? [r] redact all  [c] choose one by one  [k] keep all  [x] cancel: ')).trim().toLowerCase();
  if (answer === 'r') return findings;
  if (answer === 'k') return [];
  if (answer !== 'c') return undefined;
  const chosen: Finding[] = [];
  for (const [index, finding] of findings.entries()) {
    const reply = (await ask(`  ${index + 1}  ${finding.kind} ${finding.shown}: redact? [Y/n] `)).trim().toLowerCase();
    if (reply !== 'n') chosen.push(finding);
  }
  return chosen;
}

/** Where a share is saved by default: inside the data folder, which git ignores and Wisdom
 * never observes, so a file holding a kept secret cannot be committed by accident.
 */
export function defaultSharePath(dataDir: string, draft: ShareDraft, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const first = draft.sessions[0]!.manifest.captureId.slice(0, 8);
  const more = draft.sessions.length > 1 ? `-and-${draft.sessions.length - 1}` : '';
  return path.join(dataDir, 'shared-out', `${first}${more}-${stamp}.wisdom-share`);
}
