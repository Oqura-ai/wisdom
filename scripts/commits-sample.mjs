// Sample data for the Commits app while developing it: the test repository (test/visualizer-fixture.ts)
// built into visualizer/public/data, where `npm run commits:dev` serves it. Run after `npm run build`.
// `node scripts/commits-sample.mjs local` builds it as local mode.
import { fixture, input } from '../dist/test/visualizer-fixture.js';
import { buildData, writeData } from '../dist/src/visualizer/build.js';

const mode = process.argv[2] === 'local' ? 'local' : 'team';
const base = input(fixture().dir, mode);
// Made-up turns, so the panel's chat view has something to show: each turn edits the file its
// commit names (s1's turn 1 is cited by several fixture commits, as the records say).
const requests = ['Make the change in the file', 'Run the tests', 'Tidy up and commit'];
const turns = id => requests.map((request, k) => {
  const at = `2026-11-20T09:${String(10 + k * 5).padStart(2, '0')}:00Z`, turn = k + 1;
  return { turn, at, request, items: () => [
    { kind: 'thinking', id: `${id}-${turn}-th`, at, text: { text: 'Look at the file first, then edit one line.' }, durationMs: 1800 },
    turn === 2
      ? { kind: 'tool', id: `${id}-${turn}-b`, at, toolCallId: `b${turn}`, name: 'Bash', input: { text: JSON.stringify({ command: 'npm test' }) },
        output: { text: '✔ 23 tests\n23 pass, 0 fail' }, status: 'ok', durationMs: 4200, changes: [] }
      : { kind: 'tool', id: `${id}-${turn}-e`, at, toolCallId: `e${turn}`, name: 'Edit', input: { text: JSON.stringify({ file_path: `${id}.txt` }) },
        output: { text: 'ok' }, status: 'ok', durationMs: 90,
        changes: [{ kind: 'change', id: `${id}-${turn}-c`, at, path: `${id}.txt`, operation: 'modify', attribution: 'observed-during-tool',
          patch: { text: `@@ -1 +1 @@\n-old line\n+new line from turn ${turn}` } }] },
    { kind: 'text', id: `${id}-${turn}-r`, at, source: 'transcript', text: { text: turn === 2 ? 'All **23 tests** pass.' : `Done: \`${id}.txt\` is updated.` } },
  ] };
});
const evidence = { ...base.evidence, turns: id => id === 'sX' ? [] : turns(id), version: () => 'sample-1' };
const build = { ...base, evidence, repository: 'acme/app' };
const { manifest } = writeData(new URL('../visualizer/public/data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), build, buildData(build));
console.log(`Sample data (${mode} mode): ${Object.keys(manifest.files).length} files in visualizer/public/data`);
