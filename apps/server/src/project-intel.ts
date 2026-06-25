import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { detectStack, githubSlug, MANIFEST_FILES, type StackInfo, type GitInfo } from '@foreman/core';

const exec = promisify(execFile);

/**
 * Agent-policy / coding-convention files an agent should honour. Surfacing which of
 * these a repo carries tells the user (and the intake harness) "this is the kind of
 * code/policy you're working in" before a single line is generated.
 */
const POLICY_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.github/copilot-instructions.md'];

async function detectPolicies(repoPath: string): Promise<string[]> {
  const hits = await Promise.all(
    POLICY_FILES.map(async (f) => {
      try { await access(join(repoPath, f)); return f; } catch { return ''; }
    }),
  );
  return hits.filter(Boolean);
}

/** Read whichever known manifest files exist in `repoPath` (missing ones skipped). */
async function readManifests(repoPath: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  await Promise.all(
    MANIFEST_FILES.map(async (f) => {
      try { found[f] = await readFile(join(repoPath, f), 'utf8'); } catch { /* absent */ }
    }),
  );
  return found;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

// Field/record separators git expands from %x1f/%x1e — safe against subjects that
// contain spaces, tabs, or newlines.
const FS = '\x1f';
const RS = '\x1e';

/** Best-effort git status; returns undefined if the path isn't a git repo. */
async function readGit(repoPath: string): Promise<GitInfo | undefined> {
  try {
    if ((await git(repoPath, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return undefined;
  } catch { return undefined; }

  const safe = async (args: string[], fallback = '') => { try { return await git(repoPath, args); } catch { return fallback; } };

  const branch = (await safe(['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
  const remoteUrl = (await safe(['remote', 'get-url', 'origin'])) || undefined;
  const dirty = (await safe(['status', '--porcelain'])).split('\n').filter((l) => l.trim()).length;

  // ahead/behind vs upstream, when an upstream is configured.
  let ahead = 0, behind = 0;
  const counts = await safe(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  const m = counts.match(/^(\d+)\s+(\d+)$/);
  if (m) { behind = Number(m[1]); ahead = Number(m[2]); }

  const log = await safe(['log', '-5', `--pretty=format:%h%x1f%s%x1f%cr%x1e`]);
  const lastCommits = log
    ? log.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
        const [sha, subject, when] = r.split(FS);
        return { sha: sha ?? '', subject: subject ?? '', when: when ?? '' };
      })
    : [];

  return { branch, remoteUrl, githubSlug: githubSlug(remoteUrl), ahead, behind, dirty, lastCommits };
}

export interface ProjectReport {
  name: string;
  path: string;
  stack: StackInfo;
  git?: GitInfo;
  /** Agent-policy files present in the repo (CLAUDE.md, AGENTS.md, …). */
  policies: string[];
}

/** Full deterministic project report for the Project Overview tab. */
export async function readProject(repoPath: string): Promise<ProjectReport> {
  const [manifests, gitInfo, policies] = await Promise.all([readManifests(repoPath), readGit(repoPath), detectPolicies(repoPath)]);
  return { name: basename(repoPath) || repoPath, path: repoPath, stack: detectStack(manifests), git: gitInfo, policies };
}
