import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEvent, type EventLog } from '@foreman/core';
import type { SessionRegistry } from './registry.ts';

const exec = promisify(execFile);

/**
 * Polls the branch / dirty / divergence of every known repo on a slow interval and
 * emits `git.snapshot` so each card can show "which branch, how many changes". Cheap
 * (three `git` reads per repo) and best-effort — any failure just skips that repo.
 */
export function watchGit(log: EventLog, sessions: SessionRegistry, intervalMs = 15_000): { close: () => Promise<void> } {
  async function snap(repoPath: string, repo: string): Promise<void> {
    const run = async (args: string[]): Promise<string> => {
      try { const { stdout } = await exec('git', args, { cwd: repoPath, maxBuffer: 1 << 20 }); return stdout.trim(); }
      catch { return ''; }
    };
    if ((await run(['rev-parse', '--is-inside-work-tree'])) !== 'true') return;
    const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
    const dirty = (await run(['status', '--porcelain'])).split('\n').filter((l) => l.trim()).length;
    let ahead = 0, behind = 0;
    const m = (await run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).match(/^(\d+)\s+(\d+)$/);
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
    log.append(makeEvent('git.snapshot', { repo, branch, dirty, ahead, behind }));
  }

  async function tick(): Promise<void> {
    for (const { repo, path } of sessions.repos()) await snap(path, repo);
  }

  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return { close: async () => clearInterval(timer) };
}
