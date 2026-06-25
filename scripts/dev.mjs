#!/usr/bin/env node
// Zero-dependency dev orchestrator: runs the bun TS server (:3777) and the Vite
// dev server (:5173, proxies /api → server). One Ctrl-C kills both.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(cmd, args, env) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => { shutdown(code ?? 0); });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('bun', ['apps/server/src/index.ts'], { PORT: '3777' });
run('npx', ['vite', '--config', 'apps/web/vite.config.ts']);

console.log(`\n[foreman] dev up → open http://localhost:5173  (server :3777, initial mode: ${process.env.FOREMAN_DEMO === '1' ? 'demo' : 'live'})\n`);
