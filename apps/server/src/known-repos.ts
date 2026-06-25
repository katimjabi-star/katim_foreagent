import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CLAUDE_HOME } from './config.ts';

/**
 * Repos the user has opened in Claude Code, read from `~/.claude.json`'s `projects`
 * map. This is a *richer* discovery source than live sessions alone: a project the
 * user worked in (and configured MCP / settings for) is listed here even when no
 * session is currently streaming a transcript for it.
 *
 * Without this, the New-task picker could only offer repos with an active transcript,
 * so a repo like `xmail` — which has an MCP server configured but no live session —
 * was invisible, and its MCP could never surface. Read-only and best-effort; only
 * paths that still exist on disk are returned. Cached briefly because `.claude.json`
 * can be large.
 */
let cache: { at: number; repos: Array<{ repo: string; path: string }> } | null = null;

export async function claudeProjectRepos(): Promise<Array<{ repo: string; path: string }>> {
  if (cache && Date.now() - cache.at < 10_000) return cache.repos;
  let repos: Array<{ repo: string; path: string }> = [];
  try {
    const raw = await readFile(join(homedir(), '.claude.json'), 'utf8')
      .catch(() => readFile(join(CLAUDE_HOME, '.claude.json'), 'utf8'));
    const j = JSON.parse(raw);
    repos = Object.keys(j?.projects ?? {})
      .filter((p) => p.startsWith('/') && existsSync(p))
      .map((p) => ({ repo: basename(p) || p, path: p }));
  } catch { /* no file / unreadable — fall back to live sessions only */ }
  cache = { at: Date.now(), repos };
  return repos;
}
