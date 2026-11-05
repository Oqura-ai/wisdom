import { fileURLToPath } from 'node:url';

/** Local-only viewer. The root is pinned because the repository has its own lockfile.
 * `standalone` is what the package ships (see scripts/bundle-dashboard.mjs). No page uses
 * next/image, so sharp's per-system binaries stay out of it.
 */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  images: { unoptimized: true },
  outputFileTracingExcludes: { '*': ['node_modules/sharp/**', 'node_modules/@img/**'] },
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
};
export default config;
