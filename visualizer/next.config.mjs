import { fileURLToPath } from 'node:url';

/** Commits: a static export (plain files in out/), so any host serves it and the data next to
 * it (data/). The root is the repository's, so the app can import the data contract
 * (src/visualizer/contract.ts) itself, not a copy of it.
 */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'export',
  images: { unoptimized: true },
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
};
export default config;
