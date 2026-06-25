import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { makeEvent, parseTaskJson, claudeStatusToColumn, type EventLog } from '@foreman/core';
import type { SessionRegistry } from './registry.ts';

/**
 * Watches ~/.claude/tasks/{sessionId}/{n}.json (Claude Code's TodoWrite store) and
 * turns each task file into task.created / task.updated / task.removed events.
 *
 * Global ids are namespaced `${sessionId}:${localId}` so tasks from concurrent
 * sessions never collide on the board; blocks/blockedBy are namespaced to match.
 */
export function watchTasks(tasksDir: string, log: EventLog, sessions: SessionRegistry): FSWatcher {
  const seen = new Set<string>();
  let initialScan = true;
  const staleInitialMs = Math.max(1, Number(process.env.FOREMAN_TASK_IMPORT_MAX_AGE_HOURS ?? 24)) * 60 * 60 * 1000;

  const sessionOf = (path: string) => basename(dirname(path));
  const localId = (path: string) => basename(path, '.json');
  const gid = (sessionId: string, id: string) => `${sessionId}:${id}`;
  const ns = (sessionId: string, ids: string[]) => ids.map((i) => gid(sessionId, i));
  const repoFor = (sessionId: string) => sessions.repo(sessionId) ?? `session ${sessionId.slice(0, 8)}`;

  function isStaleInitial(path: string): boolean {
    if (!initialScan) return false;
    try { return Date.now() - statSync(path).mtimeMs > staleInitialMs; }
    catch { return true; }
  }

  function emit(path: string): void {
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { return; }
    const task = parseTaskJson(raw);
    if (!task) return;
    const sessionId = sessionOf(path);
    const taskId = gid(sessionId, task.id);
    if (isStaleInitial(path)) {
      // On startup, ~/.claude/tasks can contain old TodoWrite files from prior
      // sessions. They are not live cards; remove any previously imported copy
      // from Foreagent's event log so Live mode does not show stale work.
      log.append(makeEvent('task.removed', { taskId }));
      return;
    }
    const column = claudeStatusToColumn(task.status);
    const subtitle = task.status === 'in_progress' ? (task.activeForm ?? task.subject) : undefined;

    if (!seen.has(taskId)) {
      seen.add(taskId);
      log.append(makeEvent('task.created', {
        taskId, sessionId, repo: repoFor(sessionId), title: task.subject, column,
        blocks: ns(sessionId, task.blocks), blockedBy: ns(sessionId, task.blockedBy),
      }));
      if (subtitle) log.append(makeEvent('task.updated', { taskId, subtitle }));
    } else {
      log.append(makeEvent('task.updated', {
        taskId, title: task.subject, subtitle, column,
        blocks: ns(sessionId, task.blocks), blockedBy: ns(sessionId, task.blockedBy),
      }));
    }
  }

  // A session's repo often resolves (from its transcript's cwd) after its task
  // cards already exist — relabel them when it does.
  sessions.onResolve((sessionId, repo) => {
    for (const taskId of seen) {
      if (taskId.startsWith(`${sessionId}:`)) log.append(makeEvent('task.updated', { taskId, repo }));
    }
  });

  return chokidar
    .watch(join(tasksDir), {
      // Match the BASENAME only — the watched root lives under ~/.claude, whose
      // own leading dot must not cause us to ignore the entire tree.
      ignored: (p) => basename(p).startsWith('.'), // skip .lock, .highwatermark, .hidden
      ignoreInitial: false,
      depth: 2,
    })
    .on('add', emit)
    .on('change', emit)
    .on('ready', () => { initialScan = false; })
    .on('unlink', (path) => {
      const taskId = gid(sessionOf(path), localId(path));
      if (seen.delete(taskId)) log.append(makeEvent('task.removed', { taskId }));
    });
}
