// Sample data for the Commits app while developing it: the test repository (test/visualizer-fixture.ts)
// built into visualizer/public/data, where `npm run commits:dev` serves it. Run after `npm run build`.
// `node scripts/commits-sample.mjs local` builds it as local mode.
import { fixture, input } from '../dist/test/visualizer-fixture.js';
import { buildData, writeData } from '../dist/src/visualizer/build.js';

const mode = process.argv[2] === 'local' ? 'local' : 'team';
const build = { ...input(fixture().dir, mode), repository: 'acme/app' };
const { manifest } = writeData(new URL('../visualizer/public/data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), build, buildData(build));
console.log(`Sample data (${mode} mode): ${Object.keys(manifest.files).length} files in visualizer/public/data`);
