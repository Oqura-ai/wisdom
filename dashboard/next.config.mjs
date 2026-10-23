import { fileURLToPath } from 'node:url';

/** Local-only viewer. The root is pinned because the repository has its own lockfile. */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
};
export default config;
