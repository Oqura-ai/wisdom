// Turns the dashboard's standalone build into dist-dashboard/, the folder the package ships
// and the daemon runs. Run through `npm run dashboard:build`, after `next build`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dashboard = path.join(root, 'dashboard');
const built = path.join(dashboard, '.next', 'standalone');
const out = path.join(root, 'dist-dashboard');
if (!fs.existsSync(path.join(built, 'server.js'))) throw new Error(`No standalone build in ${built}. Run: npm run dashboard:build`);

// Next leaves the static files and public/ for the host to place.
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(built, out, { recursive: true });
fs.cpSync(path.join(dashboard, '.next', 'static'), path.join(out, '.next', 'static'), { recursive: true });
fs.cpSync(path.join(dashboard, 'public'), path.join(out, 'public'), { recursive: true });

// The build records the folder it ran in. A published package must not carry that path.
const forms = [dashboard.replace(/[\\/]+$/, ''), root.replace(/[\\/]+$/, '')]
  .flatMap(folder => [folder, folder.replaceAll('\\', '/'), folder.replaceAll('\\', '\\\\')]);
const files = (folder) => fs.readdirSync(folder, { withFileTypes: true })
  .flatMap(item => item.isDirectory() ? files(path.join(folder, item.name)) : [path.join(folder, item.name)]);
for (const file of files(out)) {
  if (!/\.(?:js|cjs|mjs|json)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const clean = forms.reduce((value, form) => value.replaceAll(form, '.'), text);
  if (clean !== text) fs.writeFileSync(file, clean);
}

// Tracing drops license files, but each bundled package's license has to travel with it.
const packages = (folder) => fs.readdirSync(folder, { withFileTypes: true }).filter(item => item.isDirectory())
  .flatMap(item => item.name.startsWith('@') ? fs.readdirSync(path.join(folder, item.name)).map(name => `${item.name}/${name}`) : [item.name]);
const modules = path.join(out, 'node_modules');
const unlicensed = [];
for (const name of packages(modules)) {
  const source = path.join(dashboard, 'node_modules', name);
  const licenses = fs.existsSync(source) ? fs.readdirSync(source).filter(file => /^(?:licen[sc]e|notice)/i.test(file)) : [];
  if (!licenses.length) unlicensed.push(name);
  for (const file of licenses) fs.copyFileSync(path.join(source, file), path.join(modules, name, file));
}

// Native binaries would tie the package to the system that built it.
const native = files(out).filter(file => file.endsWith('.node'));
if (native.length) throw new Error(`The dashboard bundle holds native binaries:\n${native.join('\n')}`);
if (unlicensed.length) console.warn(`No license file found for: ${unlicensed.join(', ')}`);
const size = files(out).reduce((sum, file) => sum + fs.statSync(file).size, 0);
console.log(`dist-dashboard ready: ${(size / 1024 / 1024).toFixed(1)} MB, ${packages(modules).length} packages`);
