import { fileURLToPath } from 'node:url';

/** Commits: a static export (plain files in out/), so any host serves it and the data next to
 * it (data/). The root is pinned because the repository has its own lockfile.
 */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'export',
  images: { unoptimized: true },
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
};
export default config;
