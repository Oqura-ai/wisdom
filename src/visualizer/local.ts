/**
 * Local Commits: the Commits builder over this machine alone (design policy 5.20). This
 * project's branches (main included), its own commit records and links, and its own
 * recordings, read through ReadStore as any process but the daemon reads them. Nothing is
 * fetched or compared with a remote, and no team file is needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gitText, listRefs } from '../team/gitrefs.js';
import { ReadStore } from '../storage/readstore.js';
import { storeEvidence } from './evidence.js';
import { buildData, writeData, type BuildInput } from './build.js';
import type { Manifest } from './contract.js';

/** Where local builds go: beside the recordings, never committed or shared. */
export const commitsDataDir = (dataDir: string) => path.join(dataDir, 'commits', 'data');

/** git's answer, or empty when it has none (no origin, a detached HEAD, no commit yet). */
const maybe = (project: string, args: string[]) => { try { return gitText(project, args); } catch { return ''; } };

const version = () => JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version as string;

/** The default branch here: the one origin's HEAD names if this clone has it, else main or
 * master, else the branch checked out. Undefined when there is no commit yet. */
export function localMain(project: string): string | undefined {
  const heads = listRefs(project, 'refs/heads/');
  const has = (name: string) => heads.has(`refs/heads/${name}`);
  const origin = maybe(project, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  for (const name of [origin, 'main', 'master']) if (name && has(name)) return name;
  const current = maybe(project, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return current && has(current) ? current : [...heads.keys()][0]?.slice('refs/heads/'.length);
}

/** What changes a local build: branch tips, Wisdom's refs, and each session's newest record. */
export function localSignature(project: string, store: ReadStore): string {
  const refs = maybe(project, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/wisdom/']);
  const sessions = [...store.database.sessionVersions()].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => `${id}=${n}`).join(',');
  return `${refs}\n${sessions}`;
}

/** The build input for this machine. Each session's version is its newest record, so a turn
 * file is made again only when its session changed. */
export function localInput(project: string, store: ReadStore, main: string): BuildInput {
  const versions = store.database.sessionVersions();
  const held = new Set(store.database.manifests().map(m => m.captureId));
  // The store only for a session it holds: a session recorded elsewhere or deleted is missing,
  // never a step that "changed" (checkStep tells the two apart by this).
  const evidence = storeEvidence(id => held.has(id) ? store : undefined, () => [...held], id => versions.has(id) ? `r${versions.get(id)}` : undefined);
  const branches = [...listRefs(project, 'refs/heads/').keys()].map(ref => ref.slice('refs/heads/'.length))
    .filter(name => name !== main).map(name => ({ name, ref: `refs/heads/${name}` }));
  return { project, mode: 'local', main: { name: main, ref: `refs/heads/${main}` }, branches, evidence, wisdomVersion: version() };
}

/** Build this machine's Commits data into `out`. Undefined when there is nothing to build yet. */
export function buildLocal(project: string, dataDir: string, out = commitsDataDir(dataDir)): { manifest: Manifest; made: number; reused: number } | undefined {
  const main = localMain(project);
  if (!main) return undefined;
  const store = new ReadStore(dataDir);
  try {
    const input = localInput(project, store, main);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    return writeData(out, input, buildData(input));
  } finally { store.close(); }
}
