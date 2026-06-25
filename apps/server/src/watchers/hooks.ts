import { openSync, readSync, closeSync, statSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { makeEvent, type AgentStatus, type EventLog } from '@foreman/core';

/**
 * Tails $FOREMAN_HOME/hooks.jsonl, the spool written by the fail-safe hook script
 * (assets/hooks/emit.sh) installed via `foreman --install`. This is the UPGRADE
 * tier — the baseline board works without it. Each hook line carries an event name
 * and Claude Code's payload; we translate the lifecycle events into agent.status so
 * a session's card shows running / waiting / idle, plus subagent + session signals.
 *
 * Byte-offset tailing mirrors the transcript watcher; the file may not exist until
 * the first hook fires, so we also watch its parent directory for its creation.
 */
const STATUS_FOR: Record<string, AgentStatus | undefined> = {
  SessionStart: 'running',
  Stop: 'idle', // main agent finished its turn — awaiting the next prompt
  Notification: 'waiting', // Claude is asking for input or permission
  SubagentStart: 'running', // a subagent was spawned; the parent is still working
  SubagentStop: 'running', // a subagent finished; the parent is still working
  SessionEnd: 'done',
};

/** Pull a string field from the hook payload by any of several key spellings. */
function str(data: unknown, ...keys: string[]): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  for (const k of keys) if (typeof d[k] === 'string') return d[k] as string;
  return undefined;
}

export function watchHooks(spoolPath: string, log: EventLog): FSWatcher {
  let offset = 0;
  try { offset = statSync(spoolPath).size; } catch { offset = 0; } // start at EOF if it exists

  function sessionIdOf(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    const id = d.session_id ?? d.sessionId;
    return typeof id === 'string' ? id : undefined;
  }

  function drain(): void {
    let end: number;
    try { end = statSync(spoolPath).size; } catch { return; }
    if (end <= offset) { offset = end; return; } // truncated/rotated → resync
    const fd = openSync(spoolPath, 'r');
    let text = '';
    try {
      const buf = Buffer.allocUnsafe(end - offset);
      readSync(fd, buf, 0, buf.length, offset);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }
    offset = end;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: { event?: string; data?: unknown };
      try { rec = JSON.parse(line); } catch { continue; }
      const sessionId = sessionIdOf(rec.data);
      if (!sessionId) continue;

      // PreCompact → a real-time compaction signal (the transcript also records it,
      // but the hook fires *before* the boundary line lands).
      if (rec.event === 'PreCompact') {
        log.append(makeEvent('context.compacted', { sessionId, trigger: str(rec.data, 'trigger') }));
        continue;
      }

      const status = rec.event ? STATUS_FOR[rec.event] : undefined;
      if (!status) continue;
      // For a Notification, the `message` field carries the actual question/permission
      // text the user would see — far more useful than the bare event name.
      const reason = rec.event === 'Notification'
        ? (str(rec.data, 'message') ?? 'Notification')
        : rec.event;
      log.append(makeEvent('agent.status', { sessionId, status, reason }));

      // A waiting Notification is also an Attention-rail signal with its text.
      if (rec.event === 'Notification') {
        log.append(makeEvent('alert', { sessionId, kind: 'needs-input', severity: 'warn', message: str(rec.data, 'message') ?? 'Claude needs your input' }));
      }
    }
  }

  // chokidar with depth 0 on the file's directory catches both creation and appends.
  return chokidar
    .watch(spoolPath, { ignoreInitial: true })
    .on('add', drain)
    .on('change', drain);
}
