import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from '@foreman/core';
import { CLAUDE_HOME, CODEX_HOME, HOOK_SPOOL } from '../config.ts';
import { SessionRegistry } from './registry.ts';
import { watchTasks } from './tasks.ts';
import { watchTranscripts } from './transcripts.ts';
import { watchHooks } from './hooks.ts';
import { watchGit } from './git.ts';
import { watchCodexSessions } from './codex.ts';

/** Starts the read-side: turns live agent transcript changes into Foreman events. */
export function startWatchers(log: EventLog): { sessions: SessionRegistry; close: () => Promise<void> } {
  const sessions = new SessionRegistry();
  const tasksDir = join(CLAUDE_HOME, 'tasks');
  const projectsDir = join(CLAUDE_HOME, 'projects');
  const codexSessionsDir = join(CODEX_HOME, 'sessions');

  if (!existsSync(CLAUDE_HOME)) {
    console.warn(`[foreman] no Claude home at ${CLAUDE_HOME} — Claude cards will be empty. Set CLAUDE_HOME to point at it.`);
  }

  // Transcripts first so cwd→repo is known before/while tasks resolve.
  const wt = existsSync(projectsDir) ? watchTranscripts(projectsDir, log, sessions) : undefined;
  const tk = existsSync(tasksDir) ? watchTasks(tasksDir, log, sessions) : undefined;
  // Upgrade tier — present only after `foreman --install`. Harmless if absent.
  const hk = watchHooks(HOOK_SPOOL, log);
  // Slow git poller — branch/dirty/divergence per repo, for the card git badges.
  const gt = watchGit(log, sessions);
  const cx = existsSync(codexSessionsDir) ? watchCodexSessions(codexSessionsDir, log, sessions) : undefined;

  console.log(`[foreman] watching ${CLAUDE_HOME} / ${CODEX_HOME} (tasks${tk ? '✓' : '✗'}, transcripts${wt ? '✓' : '✗'}, codex${cx ? '✓' : '✗'}, hooks✓, git✓)`);
  return { sessions, close: async () => { await wt?.close(); await tk?.close(); await cx?.close(); await hk.close(); await gt.close(); } };
}
