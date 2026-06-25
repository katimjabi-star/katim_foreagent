import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { makeEvent, parseTranscriptLine, repoLabelFromCwd, turnCostUsd, contextPct, type EventLog } from '@foreman/core';
import type { SessionRegistry } from './registry.ts';

/**
 * Tails ~/.claude/projects/**\/*.jsonl. On first sight of a file we seek to EOF
 * (don't replay potentially huge history into the event log) but DO read it once
 * to learn its cwd→repo mapping; thereafter we stream only newly-appended lines.
 */
export function watchTranscripts(projectsDir: string, log: EventLog, sessions: SessionRegistry): FSWatcher {
  const offsets = new Map<string, number>();
  // Cost is cumulative per session; context % is the latest turn's window fill.
  const costBySession = new Map<string, number>();

  function learnRepo(path: string): void {
    // Cheap scan of the head for the first cwd we can find.
    try {
      const head = readFileSync(path, 'utf8').split('\n').slice(0, 40);
      for (const line of head) {
        const parsed = parseTranscriptLine(line);
        if (parsed?.cwd && parsed.sessionId) {
          sessions.set(parsed.sessionId, repoLabelFromCwd(parsed.cwd, basename(path, '.jsonl')), parsed.cwd);
          return;
        }
      }
    } catch { /* ignore */ }
  }

  function readFrom(path: string, from: number): { text: string; end: number } {
    const fd = openSync(path, 'r');
    try {
      const end = statSync(path).size;
      if (end <= from) return { text: '', end };
      const buf = Buffer.allocUnsafe(end - from);
      readSync(fd, buf, 0, buf.length, from);
      return { text: buf.toString('utf8'), end };
    } finally { closeSync(fd); }
  }

  function drain(path: string): void {
    const from = offsets.get(path) ?? 0;
    const { text, end } = readFrom(path, from);
    offsets.set(path, end);
    if (!text) return;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseTranscriptLine(line);
      if (!parsed) continue;
      const sessionId = parsed.sessionId ?? basename(path, '.jsonl');
      if (parsed.cwd) sessions.set(sessionId, repoLabelFromCwd(parsed.cwd, sessionId), parsed.cwd);
      if (parsed.compaction) {
        log.append(makeEvent('context.compacted', {
          sessionId,
          trigger: parsed.compaction.trigger,
          preTokens: parsed.compaction.preTokens,
          postTokens: parsed.compaction.postTokens,
        }));
      }
      if (parsed.alerts) {
        for (const a of parsed.alerts) log.append(makeEvent('alert', { sessionId, kind: a.kind, severity: a.severity, message: a.message }));
      }
      if (parsed.usage) {
        const cost = (costBySession.get(sessionId) ?? 0) + turnCostUsd(parsed.usage, parsed.model);
        costBySession.set(sessionId, cost);
        log.append(makeEvent('context.snapshot', {
          sessionId,
          snapshot: {
            pctUsed: contextPct(parsed.usage, parsed.model),
            tokensIn: parsed.usage.input,
            tokensOut: parsed.usage.output,
            cacheRead: parsed.usage.cacheRead,
            costUsd: cost,
            model: parsed.model ?? 'unknown',
          },
        }));
      }
      for (const item of parsed.items) {
        if (item.kind === 'tool') {
          log.append(makeEvent('tool.used', { agentId: `session:${sessionId}`, tool: item.name, detail: item.detail }));
        } else {
          log.append(makeEvent('message', { sessionId, role: item.role, text: item.text }));
        }
      }
    }
  }

  return chokidar
    .watch(projectsDir, {
      // Basename-only dotfile filter (see tasks.ts) — full-path matching would
      // ignore everything because the root sits under ~/.claude.
      ignored: (p) => basename(p).startsWith('.'),
      ignoreInitial: false,
      depth: 3,
    })
    .on('add', (path) => {
      if (!path.endsWith('.jsonl')) return;
      learnRepo(path);
      const sessionId = basename(path, '.jsonl');
      log.append(makeEvent('session.seen', { sessionId, repo: sessions.repo(sessionId) ?? sessionId }));
      try { offsets.set(path, statSync(path).size); } catch { offsets.set(path, 0); } // seek to EOF
    })
    .on('change', (path) => { if (path.endsWith('.jsonl')) drain(path); });
}
