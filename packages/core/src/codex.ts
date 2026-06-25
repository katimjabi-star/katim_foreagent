import { basename } from 'node:path';
import type { ContextSnapshot } from './events.ts';
import { repoLabelFromCwd } from './claude.ts';

export type CodexToolKind = 'function' | 'custom' | 'web' | 'tool_search';

export type ParsedCodexItem =
  | { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | { kind: 'tool'; name: string; detail?: string; toolType?: CodexToolKind; callId?: string; status?: string };

export interface CodexTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  reasoning: number;
  total: number;
}

export interface CodexTokenCount {
  last: CodexTokenUsage;
  total: CodexTokenUsage;
  context: {
    window: number;
    pctUsed: number;
  };
}

export interface ParsedCodexLine {
  sessionId?: string;
  meta?: {
    sessionId: string;
    cwd?: string;
    repo: string;
    rootSessionId?: string;
    parentSessionId?: string;
    agentNickname?: string;
    agentRole?: string;
    model?: string;
  };
  cwd?: string;
  repo?: string;
  ts?: number;
  items: ParsedCodexItem[];
  usage?: ContextSnapshot;
  snapshot?: ContextSnapshot;
  tokenCount?: CodexTokenCount;
  taskStarted?: boolean;
  taskComplete?: boolean;
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() ? x : undefined;
}

function parseTs(x: unknown): number | undefined {
  if (typeof x !== 'string') return undefined;
  const t = Date.parse(x);
  return Number.isNaN(t) ? undefined : t;
}

function compact(s: string, max = 120): string | undefined {
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

function record(x: unknown): Record<string, unknown> | undefined {
  return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(raw));
  } catch { return undefined; }
}

function detailFromRecord(o: Record<string, unknown>): string | undefined {
  for (const key of ['cmd', 'command']) {
    const v = o[key];
    if (typeof v === 'string') return compact(v);
  }
  for (const key of ['file_path', 'path']) {
    const v = o[key];
    if (typeof v === 'string') return compact(basename(v), 80);
  }
  for (const key of ['pattern', 'query', 'prompt', 'url', 'ref_id', 'location', 'ticker']) {
    const v = o[key];
    if (typeof v === 'string') return compact(v);
  }
  return undefined;
}

function patchDetail(input: string): string | undefined {
  const match = input.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/m);
  if (match?.[1] && match[2]) return compact(`${match[1]} File: ${match[2]}`);
  const move = input.match(/^\*\*\* Move to: (.+)$/m);
  if (move?.[1]) return compact(`Move to: ${move[1]}`);
  return compact(input);
}

function detailFromArgs(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined;
    const parsed = parseJsonObject(raw);
    return parsed ? detailFromRecord(parsed) : patchDetail(raw);
  }
  const parsed = record(raw);
  return parsed ? detailFromRecord(parsed) : undefined;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return compact(content, 280);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((x) => x && typeof x === 'object' ? (x as Record<string, unknown>).text : undefined)
    .filter((x): x is string => typeof x === 'string' && !!x.trim())
    .join('\n');
  return compact(text, 280);
}

function tokenUsage(raw: unknown): CodexTokenUsage {
  const r = record(raw) ?? {};
  return {
    input: num(r.input_tokens),
    output: num(r.output_tokens),
    cacheRead: num(r.cached_input_tokens) || num(r.cache_read_input_tokens),
    cacheCreate: num(r.cache_creation_input_tokens),
    reasoning: num(r.reasoning_output_tokens),
    total: num(r.total_tokens),
  };
}

function pctUsed(totalTokens: number, window: number): number {
  if (!window) return 0;
  return Math.max(0, Math.min(1, totalTokens / window));
}

function webTool(payload: Record<string, unknown>): ParsedCodexItem {
  const action = record(payload.action) ?? {};
  const actionType = str(action.type);
  let name = actionType ? `web.${actionType}` : 'web_search';
  if (actionType === 'search') name = 'web.search';
  else if (actionType === 'open_page') name = 'web.open';
  else if (actionType === 'find_in_page') name = 'web.find';
  const detail = detailFromRecord(action);
  return {
    kind: 'tool',
    toolType: 'web',
    name,
    detail,
    status: str(payload.status),
    callId: str(payload.call_id),
  };
}

export function parseCodexLine(raw: string): ParsedCodexLine | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const payload = r.payload && typeof r.payload === 'object' ? r.payload as Record<string, unknown> : {};
  const out: ParsedCodexLine = { items: [] };
  out.ts = parseTs(r.timestamp);

  if (r.type === 'session_meta') {
    const sessionId = str(payload.id) ?? str(payload.session_id);
    if (!sessionId) return out;
    const cwd = str(payload.cwd);
    const repo = repoLabelFromCwd(cwd, sessionId);
    out.sessionId = sessionId;
    out.cwd = cwd;
    out.repo = repo;
    out.meta = {
      sessionId,
      cwd,
      repo,
      rootSessionId: str(payload.session_id),
      parentSessionId: str(payload.parent_thread_id),
      agentNickname: str(payload.agent_nickname),
      agentRole: str(payload.agent_role),
      model: str(payload.model) ?? str(payload.model_id),
    };
    return out;
  }

  if (r.type === 'event_msg') {
    const type = payload.type;
    if (type === 'task_started') out.taskStarted = true;
    if (type === 'task_complete') out.taskComplete = true;
    if (type === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
      const text = compact(payload.message, 280);
      if (text) out.items.push({ kind: 'message', role: 'user', text });
    }
    if (type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
      const text = compact(payload.message, 280);
      if (text) out.items.push({ kind: 'message', role: 'assistant', text });
    }
    if (type === 'token_count') {
      const info = payload.info && typeof payload.info === 'object' ? payload.info as Record<string, unknown> : {};
      const total = tokenUsage(info.total_token_usage);
      const last = tokenUsage(info.last_token_usage);
      const window = num(info.model_context_window);
      out.tokenCount = {
        last,
        total,
        context: { window, pctUsed: pctUsed(last.total || total.total || last.input || total.input, window) },
      };
      out.snapshot = {
        pctUsed: out.tokenCount.context.pctUsed,
        tokensIn: last.input,
        tokensOut: last.output + last.reasoning,
        cacheRead: last.cacheRead,
        costUsd: 0,
        model: 'codex',
      };
      out.usage = out.snapshot;
    }
    return out;
  }

  if (r.type === 'response_item') {
    const type = payload.type;
    if (type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
      const text = textFromContent(payload.content);
      if (text) out.items.push({ kind: 'message', role: payload.role, text });
    }
    if (type === 'function_call') {
      out.items.push({
        kind: 'tool',
        toolType: 'function',
        name: str(payload.name) ?? 'function',
        detail: detailFromArgs(payload.arguments),
        callId: str(payload.call_id),
        status: str(payload.status),
      });
    }
    if (type === 'custom_tool_call') {
      out.items.push({
        kind: 'tool',
        toolType: 'custom',
        name: str(payload.name) ?? 'custom_tool',
        detail: detailFromArgs(payload.input ?? payload.arguments),
        callId: str(payload.call_id),
        status: str(payload.status),
      });
    }
    if (type === 'web_search_call') {
      out.items.push(webTool(payload));
    }
    if (type === 'tool_search_call') {
      out.items.push({
        kind: 'tool',
        toolType: 'tool_search',
        name: 'tool_search',
        detail: detailFromArgs(payload.arguments),
        callId: str(payload.call_id),
        status: str(payload.status),
      });
    }
    return out;
  }

  return out;
}

export const parseCodexSessionLine = parseCodexLine;

export { repoLabelFromCwd };
