#!/usr/bin/env node
// Production entry for `npx foreman`. Runs the self-contained server bundle on plain
// Node (no bun needed) and opens the browser. In a dev checkout where the bundle
// hasn't been built, it falls back to running the TypeScript source via bun.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Hook install/uninstall is a separate, dependency-free entry — handle it and exit.
const arg = process.argv[2];
if (arg === '--install' || arg === '--uninstall' || arg === 'install' || arg === 'uninstall') {
  await import('./install.mjs');
  process.exit(0);
}
if (arg === '--help' || arg === '-h') {
  console.log(`foreman — observe→control board for AI coding agents

  npx foreman              start the board (opens your browser)
  npx foreman --install    install the optional Claude Code hooks (richer status)
  npx foreman --uninstall  remove the hooks
  PORT=4000 npx foreman    use a specific port (otherwise auto-picks from 3777)
`);
  process.exit(0);
}

const port = process.env.PORT ?? '3777';
const bundle = join(root, 'bin', 'dist', 'server.mjs');

// Published package → plain node on the bundle. Dev checkout → bun on the source.
const [cmd, args] = existsSync(bundle)
  ? ['node', [bundle]]
  : ['bun', [join(root, 'apps', 'server', 'src', 'index.ts')]];

const server = spawn(cmd, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: port,
    // The bundle lives in bin/dist, so resolve shipped assets absolutely.
    FOREMAN_WEB_DIST: process.env.FOREMAN_WEB_DIST ?? join(root, 'apps', 'web', 'dist'),
    FOREMAN_ASSETS: process.env.FOREMAN_ASSETS ?? join(root, 'assets', 'marketplace'),
  },
});

server.on('error', (err) => {
  if (cmd === 'bun') console.error('[foreman] bun not found and no built bundle present. Run `npm run build` first, or install bun for dev.');
  else console.error('[foreman] failed to start server:', err.message);
  process.exit(1);
});

// The server prints its actual port (it may auto-pick if PORT is taken); open the
// default guess after a short delay. Honour FOREMAN_NO_OPEN for headless use.
if (process.env.FOREMAN_NO_OPEN !== '1') {
  const url = `http://localhost:${port}`;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  setTimeout(() => { try { spawn(opener, [url], { stdio: 'ignore', detached: true }).unref(); } catch {} }, 1000);
}

server.on('exit', (code) => process.exit(code ?? 0));
