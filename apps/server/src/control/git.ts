import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Run a git command in `cwd`, returning trimmed stdout. Throws on non-zero. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(path: string): Promise<boolean> {
  try { return (await git(path, ['rev-parse', '--is-inside-work-tree'])) === 'true'; }
  catch { return false; }
}

export async function headSha(path: string): Promise<string> {
  return git(path, ['rev-parse', 'HEAD']);
}

/**
 * Create a detached worktree at `dest` on a fresh `branch` off `base`. If the
 * branch already exists (a retried task), reuse it. Returns nothing; throws on
 * failure so the caller can report agent.status error.
 */
export async function addWorktree(repo: string, dest: string, branch: string, base: string): Promise<void> {
  // -B resets the branch to base if it already exists, so retries are clean.
  await git(repo, ['worktree', 'add', '-B', branch, dest, base]);
}

export async function removeWorktree(repo: string, dest: string): Promise<void> {
  try { await git(repo, ['worktree', 'remove', '--force', dest]); } catch { /* best effort */ }
}

export interface DiffStat { files: number; added: number; removed: number; }

/**
 * Total change of the worktree relative to `base`, staged + unstaged. We `add -A`
 * into the index of the worktree first so untracked files count, then numstat
 * against base. Binary files (numstat "-") are counted as files, 0 lines.
 */
export async function diffStat(worktreeDir: string, base: string): Promise<DiffStat> {
  await git(worktreeDir, ['add', '-A']);
  const out = await git(worktreeDir, ['diff', '--cached', '--numstat', base]);
  let files = 0, added = 0, removed = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    files++;
    const [a, r] = line.split('\t');
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { files, added, removed };
}
