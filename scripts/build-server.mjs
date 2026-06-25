// Bundles the server (+ @foreman/core + chokidar) into ONE self-contained ESM file
// that runs on plain Node 20 — no bun, no node_modules. This is what makes
// `npx foreman` portable: the published package ships this bundle, the built web
// app, and the hook assets, with zero runtime dependencies to install.
import { build } from 'esbuild';

await build({
  entryPoints: ['apps/server/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'bin/dist/server.mjs',
  // chokidar 4 is pure JS; nothing native to keep external. fsevents is not a
  // chokidar 4 dependency, but mark it external defensively in case a transitive
  // optional require appears — Node falls back to fs.watch without it.
  external: ['fsevents'],
  // Some bundled deps may reference CJS `require`/`__dirname` from ESM output.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

console.log('✓ server bundled → bin/dist/server.mjs');
