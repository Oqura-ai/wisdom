// The Commits app as it ships: visualizer/out (the static export) copied to dist-commits/,
// without data/ (the sample data `npm run commits:sample` writes is development only). The
// daemon serves this folder with this machine's data beside it (src/visualizer/serve.ts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const from = path.join(root, 'visualizer', 'out'), to = path.join(root, 'dist-commits');
if (!fs.existsSync(path.join(from, 'index.html'))) throw new Error('visualizer/out has no build: run npm run commits:build');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true, filter: source => path.relative(from, source).split(path.sep)[0] !== 'data' });
// Like the dashboard bundle: nothing from the build machine, nothing native.
for (const file of fs.readdirSync(to, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())) {
  const full = path.join(file.parentPath, file.name);
  if (/\.(node|exe|dll|so|dylib)$/i.test(file.name)) throw new Error(`A native binary is in the Commits bundle: ${full}`);
  if (fs.readFileSync(full).includes(root.replace(/[\\/]+$/, ''))) throw new Error(`${full} names this machine's folder ${root}`);
}
console.log(`Commits bundled in ${path.relative(root, to)}`);
