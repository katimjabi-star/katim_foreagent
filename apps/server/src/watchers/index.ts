import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from '@foreman/core';
import { CLAUDE_HOME, HOOK_SPOOL } from '../config.ts';
import { SessionRegistry } from './registry.ts';
import { watchTasks } from './tasks.ts';
import { watchTranscripts } from './transcripts.ts';
import { watchHooks } from './hooks.ts';
import { watchGit } from './git.ts';

/** Starts the read-side: turns live ~/.claude changes into Foreman events. */
export function startWatchers(log: EventLog): { sessions: SessionRegistry; close: () => Promise<void> } {
  const sessions = new SessionRegistry();
  const tasksDir = join(CLAUDE_HOME, 'tasks');
  const projectsDir = join(CLAUDE_HOME, 'projects');

  if (!existsSync(CLAUDE_HOME)) {
    console.warn(`[foreman] no Claude home at ${CLAUDE_HOME} — board will be empty. Set CLAUDE_HOME to point at it.`);
    return { sessions, close: async () => {} };
  }

  // Transcripts first so cwd→repo is known before/while tasks resolve.
  const wt = existsSync(projectsDir) ? watchTranscripts(projectsDir, log, sessions) : undefined;
  const tk = existsSync(tasksDir) ? watchTasks(tasksDir, log, sessions) : undefined;
  // Upgrade tier — present only after `foreman --install`. Harmless if absent.
  const hk = watchHooks(HOOK_SPOOL, log);
  // Slow git poller — branch/dirty/divergence per repo, for the card git badges.
  const gt = watchGit(log, sessions);

  console.log(`[foreman] watching ${CLAUDE_HOME} (tasks${tk ? '✓' : '✗'}, transcripts${wt ? '✓' : '✗'}, hooks✓, git✓)`);
  return { sessions, close: async () => { await wt?.close(); await tk?.close(); await hk.close(); await gt.close(); } };
}
