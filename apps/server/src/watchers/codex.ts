import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import * as core from '@foreman/core';
import type { AlertKind, AlertSeverity, ContextSnapshot, EventLog } from '@foreman/core';
import type { SessionRegistry } from './registry.ts';

type CodexItem =
  | { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | { kind: 'tool'; name: string; detail?: string };

interface CodexUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

interface CodexAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
}

interface CodexMeta {
  sessionId: string;
  cwd?: string;
  parentSessionId?: string;
  agentNickname?: string;
  agentRole?: string;
  model?: string;
}

interface ParsedCodexLine {
  sessionId?: string;
  cwd?: string;
  meta?: CodexMeta;
  items: CodexItem[];
  usage?: CodexUsage;
  model?: string;
  snapshot?: ContextSnapshot;
  alerts?: CodexAlert[];
  compaction?: { trigger?: string; preTokens?: number; postTokens?: number };
  taskStarted?: boolean;
  taskComplete?: boolean;
}

type CoreWithCodex = typeof core & {
  parseCodexLine?: (raw: string) => unknown;
};

const CODEX_AGENT = (sessionId: string): string => `session:${sessionId}`;
const CODEX_TASK = (sessionId: string): string => `codex:${sessionId}`;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMPORT_MAX_AGE_MS = Math.max(1, Number(process.env.FOREMAN_CODEX_IMPORT_MAX_AGE_HOURS ?? 24)) * 60 * 60 * 1000;
const INITIAL_SESSION_CAP = Math.max(1, Number(process.env.FOREMAN_CODEX_INITIAL_SESSION_CAP ?? 40));
const HEAD_BYTES = Math.max(16_384, Number(process.env.FOREMAN_CODEX_HEAD_BYTES ?? 1_000_000));
const READ_BYTES = Math.max(16_384, Number(process.env.FOREMAN_CODEX_TAIL_BYTES ?? 1_000_000));
const CARRY_BYTES = 64_000;

function rec(x: unknown): Record<string, unknown> | undefined {
  return x && typeof x === 'object' ? x as Record<string, unknown> : undefined;
}

function str(data: unknown, ...keys: string[]): string | undefined {
  const r = rec(data);
  if (!r) return undefined;
  for (const k of keys) if (typeof r[k] === 'string') return r[k] as string;
  return undefined;
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

function clip(s: string, n: number): string {
  return s.trim().replace(/\s+/g, ' ').slice(0, n);
}

function sessionIdFromPath(path: string): string {
  const stem = basename(path, '.jsonl');
  return stem.match(UUID_RE)?.[0] ?? stem;
}

function nestedParentId(payload: Record<string, unknown>): string | undefined {
  const source = rec(payload.source);
  const subagent = rec(source?.subagent);
  const spawn = rec(subagent?.thread_spawn);
  return str(spawn, 'parent_thread_id');
}

function parseMeta(payload: Record<string, unknown>): CodexMeta | undefined {
  const sessionId = str(payload, 'id') ?? str(payload, 'session_id');
  if (!sessionId) return undefined;
  return {
    sessionId,
    cwd: str(payload, 'cwd'),
    parentSessionId: str(payload, 'parent_thread_id') ?? nestedParentId(payload),
    agentNickname: str(payload, 'agent_nickname'),
    agentRole: str(payload, 'agent_role'),
    model: str(payload, 'model', 'model_id'),
  };
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (rec(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try { return rec(JSON.parse(raw)); } catch { return undefined; }
}

function toolDetail(payload: Record<string, unknown>): string | undefined {
  const args = parseArgs(payload.arguments) ?? parseArgs(payload.input);
  const fromArgs = args && (
    str(args, 'command', 'cmd') ??
    str(args, 'file_path', 'path') ??
    str(args, 'pattern', 'query', 'q') ??
    str(args, 'description', 'prompt')
  );
  if (fromArgs) return clip(fromArgs.split('/').pop() ?? fromArgs, 80);
  const raw = typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : undefined;
  return raw ? clip(raw, 80) : undefined;
}

function firstContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = rec(block);
    const text = str(b, 'text');
    if (text) return text;
  }
  return undefined;
}

function tokenSnapshot(payload: Record<string, unknown>): ContextSnapshot | undefined {
  const info = rec(payload.info);
  const usage = rec(info?.last_token_usage) ?? rec(info?.total_token_usage);
  if (!info || !usage) return undefined;
  const tokensIn = num(usage.input_tokens);
  const tokensOut = num(usage.output_tokens) + num(usage.reasoning_output_tokens);
  const cacheRead = num(usage.cached_input_tokens);
  const totalTokens = num(usage.total_tokens) || tokensIn + tokensOut + cacheRead;
  if (!totalTokens) return undefined;
  const window = num(info.model_context_window);
  return {
    pctUsed: window > 0 ? Math.min(1, totalTokens / window) : 0,
    tokensIn,
    tokensOut,
    cacheRead,
    costUsd: 0,
    model: str(info, 'model', 'model_id') ?? 'codex',
  };
}

function fallbackParseCodexLine(raw: string): ParsedCodexLine | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  const r = rec(o);
  if (!r) return null;
  const type = str(r, 'type');
  const payload = rec(r.payload) ?? {};
  const out: ParsedCodexLine = { items: [] };

  if (type === 'session_meta') {
    const meta = parseMeta(payload);
    if (!meta) return out;
    out.meta = meta;
    out.sessionId = meta.sessionId;
    out.cwd = meta.cwd;
    out.model = meta.model;
    return out;
  }

  if (type === 'event_msg') {
    const eventType = str(payload, 'type');
    if (eventType === 'user_message' || eventType === 'agent_message') {
      const message = str(payload, 'message');
      if (message) out.items.push({
        kind: 'message',
        role: eventType === 'user_message' ? 'user' : 'assistant',
        text: clip(message, 280),
      });
    } else if (eventType === 'token_count') {
      out.snapshot = tokenSnapshot(payload);
    } else if (eventType === 'turn_aborted') {
      out.alerts = [{ kind: 'needs-input', severity: 'warn', message: 'Codex turn was interrupted' }];
    }
    return out;
  }

  if (type === 'response_item') {
    const itemType = str(payload, 'type');
    if (itemType && itemType.endsWith('_call') && itemType !== 'function_call_output') {
      out.items.push({ kind: 'tool', name: str(payload, 'name') ?? itemType, detail: toolDetail(payload) });
      return out;
    }
    if (itemType === 'message') {
      const role = str(payload, 'role');
      if (role === 'user' || role === 'assistant' || role === 'system') {
        const text = firstContentText(payload.content);
        if (text) out.items.push({ kind: 'message', role, text: clip(text, 280) });
      }
    }
    return out;
  }

  if (type === 'compacted') {
    out.compaction = {
      trigger: str(payload, 'trigger', 'reason'),
      preTokens: num(payload.pre_tokens) || num(payload.preTokens) || undefined,
      postTokens: num(payload.post_tokens) || num(payload.postTokens) || undefined,
    };
  }

  return out;
}

function normalizeMeta(x: unknown): CodexMeta | undefined {
  const r = rec(x);
  if (!r) return undefined;
  const sessionId = str(r, 'sessionId', 'session_id', 'id');
  if (!sessionId) return undefined;
  return {
    sessionId,
    cwd: str(r, 'cwd'),
    parentSessionId: str(r, 'parentSessionId', 'parent_thread_id', 'parentId'),
    agentNickname: str(r, 'agentNickname', 'agent_nickname', 'nickname'),
    agentRole: str(r, 'agentRole', 'agent_role', 'role'),
    model: str(r, 'model', 'model_id'),
  };
}

function normalizeParsed(x: unknown): ParsedCodexLine | null {
  const r = rec(x);
  if (!r) return null;
  const sessionId = str(r, 'sessionId', 'session_id');
  const cwd = str(r, 'cwd');
  const meta = normalizeMeta(r.meta) ?? normalizeMeta(r.sessionMeta) ?? (sessionId && cwd ? { sessionId, cwd } : undefined);
  const usage = rec(r.usage);
  const snapshot = rec(r.snapshot) ?? (typeof usage?.pctUsed === 'number' ? usage : undefined);
  const items = Array.isArray(r.items)
    ? r.items.filter((i): i is CodexItem => {
        const item = rec(i);
        return item?.kind === 'tool' || item?.kind === 'message';
      })
    : [];
  return {
    sessionId: sessionId ?? meta?.sessionId,
    cwd: cwd ?? meta?.cwd,
    meta,
    items,
    usage: usage && typeof usage.input === 'number' ? usage as unknown as CodexUsage : undefined,
    model: str(r, 'model') ?? meta?.model,
    snapshot: snapshot as ContextSnapshot | undefined,
    alerts: Array.isArray(r.alerts) ? r.alerts as CodexAlert[] : undefined,
    compaction: rec(r.compaction) as ParsedCodexLine['compaction'],
    taskStarted: r.taskStarted === true,
    taskComplete: r.taskComplete === true,
  };
}

function parseCodexLine(raw: string): ParsedCodexLine | null {
  const helper = (core as CoreWithCodex).parseCodexLine;
  if (helper) {
    try { return normalizeParsed(helper(raw)); } catch { return null; }
  }
  return fallbackParseCodexLine(raw);
}

function usageSnapshot(usage: CodexUsage, model: string | undefined, costSoFar: number): ContextSnapshot {
  return {
    pctUsed: core.contextPct(usage, model),
    tokensIn: usage.input,
    tokensOut: usage.output,
    cacheRead: usage.cacheRead,
    costUsd: costSoFar + core.turnCostUsd(usage, model),
    model: model ?? 'codex',
  };
}

function readSlice(path: string, from: number, maxBytes: number): { text: string; end: number; skipped: boolean } {
  const end = statSync(path).size;
  if (end <= from) return { text: '', end, skipped: false };
  const start = end - from > maxBytes ? Math.max(0, end - maxBytes) : from;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(end - start);
    readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), end, skipped: start !== from };
  } finally { closeSync(fd); }
}

function readHead(path: string): string[] {
  try {
    const end = Math.min(statSync(path).size, HEAD_BYTES);
    if (!end) return [];
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(end);
      readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8').split('\n').slice(0, 40);
    } finally { closeSync(fd); }
  } catch { return []; }
}

function isRecent(path: string): boolean {
  try { return Date.now() - statSync(path).mtimeMs <= IMPORT_MAX_AGE_MS; }
  catch { return false; }
}

function titleFor(meta: CodexMeta | undefined, repo: string): string {
  if (meta?.agentNickname && meta.agentRole) return `${meta.agentNickname} (${meta.agentRole})`;
  if (meta?.agentNickname) return meta.agentNickname;
  return `${repo} Codex session`;
}

/**
 * Tails ~/.codex/sessions/YYYY/MM/DD/*.jsonl. Initial import is deliberately small:
 * only recent session_meta records seed cards, and old files are seeked to EOF.
 */
export function watchCodexSessions(sessionsDir: string, log: EventLog, sessions: SessionRegistry): FSWatcher {
  const offsets = new Map<string, number>();
  const carry = new Map<string, string>();
  const sessionByPath = new Map<string, string>();
  const metaBySession = new Map<string, CodexMeta>();
  const taskRepoBySession = new Map<string, string>();
  const seenSessions = new Set<string>();
  const seenTasks = new Set<string>();
  const statusBySession = new Map<string, 'running' | 'idle'>();
  const costBySession = new Map<string, number>();
  let initialScan = true;
  let initialSeeds = 0;

  function remember(meta: CodexMeta, path: string): void {
    sessionByPath.set(path, meta.sessionId);
    metaBySession.set(meta.sessionId, meta);
    if (!meta.cwd) return;
    const repo = core.repoLabelFromCwd(meta.cwd, meta.sessionId);
    const previous = sessions.repo(meta.sessionId);
    sessions.set(meta.sessionId, repo, meta.cwd);
    if (previous !== repo && seenTasks.has(CODEX_TASK(meta.sessionId))) {
      taskRepoBySession.set(meta.sessionId, repo);
      log.append(core.makeEvent('task.updated', { taskId: CODEX_TASK(meta.sessionId), repo }));
    }
  }

  function emitSessionSeen(sessionId: string, repo: string): void {
    if (seenSessions.has(sessionId)) return;
    seenSessions.add(sessionId);
    log.append(core.makeEvent('session.seen', { sessionId, repo }));
  }

  function ensureCodexTask(sessionId: string, path: string, reason: string): void {
    const meta = metaBySession.get(sessionId);
    const repo = meta?.cwd
      ? core.repoLabelFromCwd(meta.cwd, sessionId)
      : sessions.repo(sessionId) ?? `session ${sessionId.slice(0, 8)}`;
    emitSessionSeen(sessionId, repo);

    const taskId = CODEX_TASK(sessionId);
    const agentId = CODEX_AGENT(sessionId);
    if (!seenTasks.has(taskId)) {
      seenTasks.add(taskId);
      taskRepoBySession.set(sessionId, repo);
      log.append(core.makeEvent('task.created', {
        taskId,
        sessionId,
        repo,
        title: titleFor(meta, repo),
        column: 'aligning',
      }));
      log.append(core.makeEvent('agent.spawned', {
        agentId,
        taskId,
        vendor: 'codex',
        worktree: meta?.cwd,
        parentId: meta?.parentSessionId ? CODEX_AGENT(meta.parentSessionId) : undefined,
        agentType: meta?.agentRole ?? meta?.agentNickname,
      }));
    } else if (taskRepoBySession.get(sessionId) !== repo) {
      taskRepoBySession.set(sessionId, repo);
      log.append(core.makeEvent('task.updated', { taskId, repo }));
    }

    sessionByPath.set(path, sessionId);
    if (statusBySession.get(sessionId) !== 'running') {
      statusBySession.set(sessionId, 'running');
      log.append(core.makeEvent('agent.status', { agentId, sessionId, status: 'running', reason }));
    }
  }

  function seedFromHead(path: string, seedLive: boolean): void {
    for (const line of readHead(path)) {
      if (!line.trim()) continue;
      const parsed = parseCodexLine(line);
      if (!parsed?.meta) continue;
      remember(parsed.meta, path);
      if (seedLive) ensureCodexTask(parsed.meta.sessionId, path, 'session_meta');
      return;
    }
  }

  function emitParsed(path: string, parsed: ParsedCodexLine): void {
    if (parsed.meta) remember(parsed.meta, path);
    const sessionId = parsed.sessionId ?? parsed.meta?.sessionId ?? sessionByPath.get(path) ?? sessionIdFromPath(path);
    const meta = parsed.meta ?? metaBySession.get(sessionId);
    if (parsed.cwd && !meta?.cwd) remember({ sessionId, cwd: parsed.cwd }, path);
    if (parsed.meta || parsed.taskStarted || parsed.taskComplete || parsed.items.length || parsed.usage || parsed.snapshot || parsed.compaction || parsed.alerts?.length) {
      ensureCodexTask(sessionId, path, parsed.meta ? 'session_meta' : 'activity');
    }

    if (parsed.taskComplete) {
      statusBySession.set(sessionId, 'idle');
      log.append(core.makeEvent('agent.status', { agentId: CODEX_AGENT(sessionId), sessionId, status: 'idle', reason: 'task complete' }));
    }

    if (parsed.compaction) {
      log.append(core.makeEvent('context.compacted', { sessionId, ...parsed.compaction }));
    }
    for (const alert of parsed.alerts ?? []) {
      log.append(core.makeEvent('alert', { sessionId, ...alert }));
    }

    const snapshot = parsed.snapshot;
    if (snapshot) {
      log.append(core.makeEvent('context.snapshot', { sessionId, agentId: CODEX_AGENT(sessionId), snapshot }));
    } else if (parsed.usage) {
      const current = costBySession.get(sessionId) ?? 0;
      const snap = usageSnapshot(parsed.usage, parsed.model ?? meta?.model, current);
      costBySession.set(sessionId, snap.costUsd);
      log.append(core.makeEvent('context.snapshot', { sessionId, agentId: CODEX_AGENT(sessionId), snapshot: snap }));
    }

    for (const item of parsed.items) {
      if (item.kind === 'tool') {
        log.append(core.makeEvent('tool.used', { agentId: CODEX_AGENT(sessionId), tool: item.name, detail: item.detail }));
      } else {
        log.append(core.makeEvent('message', { sessionId, agentId: CODEX_AGENT(sessionId), role: item.role, text: item.text }));
      }
    }
  }

  function drain(path: string): void {
    const from = offsets.get(path) ?? 0;
    let chunk: { text: string; end: number; skipped: boolean };
    try { chunk = readSlice(path, from, READ_BYTES); } catch { return; }
    offsets.set(path, chunk.end);
    if (!chunk.text) return;

    const prior = chunk.skipped ? '' : carry.get(path) ?? '';
    const text = prior + chunk.text;
    const lines = text.split('\n');
    if (!text.endsWith('\n')) {
      const tail = lines.pop() ?? '';
      carry.set(path, tail.slice(-CARRY_BYTES));
    } else {
      carry.delete(path);
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseCodexLine(line);
      if (parsed) emitParsed(path, parsed);
    }
  }

  return chokidar
    .watch(sessionsDir, {
      ignored: (p) => basename(p).startsWith('.'),
      ignoreInitial: false,
      depth: 5,
    })
    .on('add', (path) => {
      if (!path.endsWith('.jsonl')) return;
      const seedLive = !initialScan || (isRecent(path) && initialSeeds++ < INITIAL_SESSION_CAP);
      seedFromHead(path, seedLive);
      try { offsets.set(path, statSync(path).size); } catch { offsets.set(path, 0); }
    })
    .on('change', (path) => { if (path.endsWith('.jsonl')) drain(path); })
    .on('unlink', (path) => {
      offsets.delete(path);
      carry.delete(path);
      sessionByPath.delete(path);
    })
    .on('ready', () => { initialScan = false; });
}
