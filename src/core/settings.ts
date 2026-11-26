import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

/** `wisdom.yaml`, at the project's top: one person's settings for this project. `wisdom init`
 * and `wisdom connect` write it with every default commented out, and git ignores it through the
 * clone's own `info/exclude`. Without it, or with only comments, everything is the default. A flag
 * on a command wins over it. Hooks never read it, so a broken file can never stop recording. */
export const SETTINGS_FILE = 'wisdom.yaml';

/** The YAML parser, loaded only when a file is read. Hooks load this module through shared code on
 * every event and never read a file, so they never pay for it (about 55 ms each, measured). */
export const yaml = () => createRequire(import.meta.url)('yaml') as typeof import('yaml');

/** The model that writes commit guides when nothing names another: Claude Haiku 5.5, through
 * the person's own Claude Code. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';

const harnessKeys = <T extends z.ZodTypeAny>(value: T) => z.object({ claude: value.optional(), codex: value.optional(), pi: value.optional() }).strict().optional();

const schema = z.object({
  version: z.literal(1).default(1),
  harnesses: harnessKeys(z.boolean()),
  paths: harnessKeys(z.string().min(1)),
  skill: z.boolean().optional(),
  mcp: z.boolean().optional(),
  recording: z.object({
    idleMinutes: z.number().int().min(1).max(1440).optional(),
    maxFileMB: z.number().int().min(1).max(16).optional(),
    // As .wisdomignore takes them: a file or folder from the project's top, no globs.
    ignore: z.array(z.string().transform(value => value.trim().replaceAll('\\', '/').replace(/\/$/, ''))
      .refine(value => value && !value.includes('*') && !value.startsWith('/') && !value.split('/').includes('..'),
        'a path from the project\'s top, such as secrets/ or data/big.csv, with no * or ..')).optional(),
    skipFolders: z.array(z.string().regex(/^(?!\.\.?$)[^\\/*]+$/, 'a folder name such as target or vendor, with no slash')).optional(),
  }).strict().optional(),
  daemon: z.object({
    port: z.number().int().min(1024).max(65534).optional(),
    dashboard: z.boolean().optional(),
  }).strict().optional(),
  guides: z.object({
    on: z.boolean().optional(),
    // Passed to `claude --model` as one argument, never through a shell.
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/, 'a model name such as claude-haiku-5-5').optional(),
    timeoutSeconds: z.number().int().min(30).max(300).optional(),
    turns: z.number().int().min(5).max(60).optional(),
    extra: z.string().max(2000).optional(),
  }).strict().optional(),
  share: z.object({
    secrets: z.enum(['ask', 'redact', 'keep']).optional(),
  }).strict().optional(),
  prices: z.record(z.string(), z.object({ input: z.number().nonnegative(), cached: z.number().nonnegative(), output: z.number().nonnegative() }).strict()).optional(),
  handoff: z.object({
    longSessionTokens: z.number().int().min(10_000).optional(),
    extra: z.string().max(2000).optional(),
  }).strict().optional(),
}).strict();

export type Settings = z.infer<typeof schema>;

/** The settings of the project `project`. A file that does not parse, or names a setting Wisdom
 * does not know (a typo), throws and names the line or setting: it is never half-read. */
export function readSettings(project: string): Settings {
  const file = path.join(project, SETTINGS_FILE);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error: any) { if (error?.code === 'ENOENT') return { version: 1 }; throw error; }
  let value: unknown;
  try { value = yaml().parse(text) ?? {}; }
  catch (error) { throw new Error(`${file} is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : error}`); }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${file}: ${result.error.issues.map(issue => `${issue.path.join('.') || 'the file'}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}

/** How every setting is read: a broken file means the defaults, never part of it, and why is
 * printed (to the log, for the daemon and git hooks). `wisdom doctor` reports it too. */
export function settingsOrDefaults(project: string, quiet = false): Settings {
  try { return readSettings(project); }
  catch (error) {
    if (!quiet) console.error(`Using Wisdom's defaults: ${error instanceof Error ? error.message : error}`);
    return { version: 1 };
  }
}

type HarnessKey = 'claude-code' | 'codex' | 'pi';
const key = (harness: HarnessKey) => harness === 'claude-code' ? 'claude' : harness;

/** Whether `init` and `connect` set this harness up (all are, unless turned off). */
export const harnessOn = (settings: Settings, harness: HarnessKey) => settings.harnesses?.[key(harness)] !== false;

/** Another installation of a harness, when the file names one. A path (it holds a slash; Pi's
 * is always a file) is taken from the project's folder; a bare name is looked up on PATH. */
export function harnessPath(project: string, settings: Settings, harness: HarnessKey): string | undefined {
  const named = settings.paths?.[key(harness)];
  return named && (harness === 'pi' || /[\\/]/.test(named)) ? path.resolve(project, named) : named;
}

/** The file as `init` writes it: every default, commented out. */
export const settingsTemplate = (shown = '') => `# Wisdom settings for this project. Only yours: git ignores this file.
# Remove the "# " before a line to change it. Check it with: wisdom doctor
# Every setting explained: docs/usage.md#settings
version: 1

# harnesses: { claude: true, codex: true, pi: true }   # false: init and connect leave that agent alone
# paths: { claude: claude, codex: codex }              # use another install (pi: path to its cli.js)
# skill: true           # teach your agents how to read past sessions (false: they won't know the commands)
# mcp: true             # also give them a tool for it, in sessions started by wisdom track

# daemon: { port: 7434, dashboard: true }   # the dashboard opens on port + 1, Commits on port + 2

# recording:
#   idleMinutes: 10     # no activity this long: the session is paused, and continues when you're back
#   maxFileMB: 1        # a bigger file: its change is noted, without its contents
#   ignore: []          # exact files or folders never recorded, e.g. [secrets/, data/big.csv]
#   skipFolders: []     # folder names skipped everywhere, like node_modules, e.g. [target, vendor]

# share: { secrets: ask }   # share and export always check for keys, tokens, passwords and emails;
#                           #   then: ask you, redact them all, or keep them

# guides:               # the note a model writes for each commit (on/off: wisdom guide on|off)
#                       #   in team mode, wisdom-team.yaml decides these four, the same for everyone
#   model: ${DEFAULT_MODEL}
#   timeoutSeconds: 150 # give up on one guide after this long
#   turns: 30           # how much of the sessions it may read; fewer is cheaper
#   extra: ""           # your own instruction, e.g. "Write in simple English."

# handoff:
#   longSessionTokens: 150000   # past this, handoff suggests a fresh session (the old one is full)
#   extra: ""           # your own instruction for every handoff, e.g. "Run the tests first."

# prices: {}            # your Codex prices per million tokens, e.g. { gpt-5.6-sol: { input: 4, cached: 0.4, output: 20 } }
${shown}`;

/** Write the file when it is missing, or refresh it when it still holds only defaults (so a newer
 * Wisdom's defaults show). A file with a setting of the person's own is never rewritten. */
export function writeSettings(project: string, shown = ''): 'written' | 'refreshed' | 'kept' | { invalid: string } {
  const file = path.join(project, SETTINGS_FILE);
  if (!fs.existsSync(file)) { fs.writeFileSync(file, settingsTemplate(shown)); return 'written'; }
  let settings: Settings;
  try { settings = readSettings(project); }
  catch (error) { return { invalid: error instanceof Error ? error.message : String(error) }; }
  if (Object.keys(settings).some(key => key !== 'version')) return 'kept';
  if (fs.readFileSync(file, 'utf8') === settingsTemplate(shown)) return 'kept';
  fs.writeFileSync(file, settingsTemplate(shown));
  return 'refreshed';
}

/** Lines shown in the file as comments, under a heading, for the person to read: never settings. */
export const shownAs = (heading: string, text: string) =>
  `\n# ${heading}\n${text.split('\n').map(line => `#  | ${line}`.trimEnd()).join('\n')}\n`;

/** One setting written into the file (made first when missing), keeping every comment and every
 * other line as it is. A file with a problem is not touched: the problem is thrown. */
export function setSetting(project: string, keys: string[], value: unknown): void {
  readSettings(project);
  const file = path.join(project, SETTINGS_FILE);
  if (!fs.existsSync(file)) fs.writeFileSync(file, settingsTemplate());
  const document = yaml().parseDocument(fs.readFileSync(file, 'utf8'));
  document.setIn(keys, value);
  fs.writeFileSync(file, document.toString());
}
