// Codex runs this for each hook event, with Wisdom's data folder as its argument. The
// logic lives in Wisdom's build. If the build cannot load, the event cannot be kept:
// say so, and answer `{}` so Codex goes on (Wisdom never stops the harness).
let hook;
try { hook = await import('../../dist/src/harnesses/codex/hook.js'); }
catch (error) {
  for await (const _ of process.stdin) { /* drain */ }
  process.stderr.write(`Wisdom's Codex hook could not load (${error?.message ?? error}). Run npm run build in Wisdom; this event is not recorded.\n`);
  process.stdout.write('{}');
  process.exitCode = 1;
}
if (hook) await hook.main(process.argv[2]);
