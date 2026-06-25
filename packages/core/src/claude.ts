/**
 * Pure parsers for Claude Code's on-disk format.
 *
 * This format is REVERSE-ENGINEERED, not a published contract — Anthropic can and
 * does change it between releases. So: every parser is total (returns null on
 * anything unexpected, never throws), tolerant of unknown fields, and covered by
 * golden-file tests against captured real fixtures. The stateful fs watching lives
 * in apps/server; everything here is pure and unit-testable.
 */
import type { Column, AlertKind, AlertSeverity } from './events.ts';

// ---------- Tasks: ~/.claude/tasks/{sessionId}/{n}.json (TodoWrite) ----------

export interface ClaudeTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  blocks: string[];
  blockedBy: string[];
}

export function parseTaskJson(raw: string): ClaudeTask | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.subject !== 'string') return null;
  const status = r.status;
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
  return {
    id: r.id,
    subject: r.subject,
    description: typeof r.description === 'string' ? r.description : undefined,
    activeForm: typeof r.activeForm === 'string' ? r.activeForm : undefined,
    status,
    blocks: Array.isArray(r.blocks) ? r.blocks.filter((x): x is string => typeof x === 'string') : [],
    blockedBy: Array.isArray(r.blockedBy) ? r.blockedBy.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** TodoWrite has 3 states; the richer SDLC columns fill from hooks/control later. */
export function claudeStatusToColumn(status: ClaudeTask['status']): Column {
  switch (status) {
    case 'pending': return 'sliced';
    case 'in_progress': return 'building';
    case 'completed': return 'done';
  }
}

// ---------- Transcripts: ~/.claude/projects/{slug}/{sessionId}.jsonl ----------

export type ParsedItem =
  | { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | { kind: 'tool'; name: string; detail?: string };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** A parsed attention signal — error / limit / auth, surfaced to the Attention rail. */
export interface ParsedAlert { kind: AlertKind; severity: AlertSeverity; message: string }

export interface ParsedLine {
  sessionId?: string;
  ts?: number;
  cwd?: string;
  items: ParsedItem[];
  /** Present on assistant turns — the source of the real context/cost meters. */
  usage?: TokenUsage;
  model?: string;
  /** Error / usage-limit / auth signals detected on this line (best-effort). */
  alerts?: ParsedAlert[];
  /** Set when this line is a context-compaction boundary record. */
  compaction?: { trigger?: string; preTokens?: number; postTokens?: number };
}

function num(x: unknown): number { return typeof x === 'number' && Number.isFinite(x) ? x : 0; }

function parseUsage(msg: Record<string, unknown>): TokenUsage | undefined {
  const u = msg.usage;
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Record<string, unknown>;
  const usage: TokenUsage = {
    input: num(r.input_tokens),
    output: num(r.output_tokens),
    cacheRead: num(r.cache_read_input_tokens),
    cacheCreate: num(r.cache_creation_input_tokens),
  };
  if (usage.input + usage.output + usage.cacheRead + usage.cacheCreate === 0) return undefined;
  return usage;
}

/** Best-effort one-line tool summary, e.g. `Edit · oauth.ts` or `Bash · npm test`. */
function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === 'string') return i.file_path.split('/').pop();
  if (typeof i.path === 'string') return i.path.split('/').pop();
  if (typeof i.command === 'string') return i.command.slice(0, 48);
  if (typeof i.pattern === 'string') return i.pattern.slice(0, 48);
  if (typeof i.description === 'string') return i.description.slice(0, 48);
  return undefined;
}

/** First text block of a message's content (the friendly error text on api-error lines). */
function firstText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
    }
  }
  return undefined;
}

/** Strip Claude Code's <tool_use_error>…</tool_use_error> wrapper for a clean message. */
function stripToolError(s: string): string {
  return s.replace(/<\/?tool_use_error>/g, '').trim();
}

export function parseTranscriptLine(raw: string): ParsedLine | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;

  const out: ParsedLine = { items: [] };
  if (typeof r.sessionId === 'string') out.sessionId = r.sessionId;
  if (typeof r.cwd === 'string') out.cwd = r.cwd;
  if (typeof r.timestamp === 'string') { const t = Date.parse(r.timestamp); if (!Number.isNaN(t)) out.ts = t; }
  else if (typeof r.timestamp === 'number') out.ts = r.timestamp;

  // Context-compaction boundary: a system record carrying pre/post token counts.
  if (r.type === 'system' && r.subtype === 'compact_boundary') {
    const m = r.compactMetadata && typeof r.compactMetadata === 'object' ? r.compactMetadata as Record<string, unknown> : {};
    out.compaction = {
      trigger: typeof m.trigger === 'string' ? m.trigger : undefined,
      preTokens: num(m.preTokens) || undefined,
      postTokens: num(m.postTokens) || undefined,
    };
    return out;
  }

  // API / usage-limit / auth failure: surfaced on an assistant record as top-level flags.
  if (r.type === 'assistant' && (r.isApiErrorMessage === true || typeof r.error === 'string')) {
    const status = num(r.apiErrorStatus);
    const errStr = typeof r.error === 'string' ? r.error : '';
    let kind: AlertKind = 'server-error';
    let severity: AlertSeverity = 'warn';
    if (errStr === 'rate_limit' || status === 429) { kind = 'rate-limit'; severity = 'error'; }
    else if (status === 401 || status === 403) { kind = 'auth'; severity = 'error'; }
    const text = firstText(r.message) ?? `API error${status ? ` ${status}` : ''}`;
    (out.alerts ??= []).push({ kind, severity, message: text.trim().slice(0, 160) });
  }

  if ((r.type === 'user' || r.type === 'assistant') && r.message && typeof r.message === 'object') {
    const msg = r.message as Record<string, unknown>;
    const role = msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system' ? msg.role : r.type as 'user' | 'assistant';
    if (r.type === 'assistant') {
      const usage = parseUsage(msg);
      if (usage) out.usage = usage;
      if (typeof msg.model === 'string' && msg.model !== '<synthetic>') out.model = msg.model;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim()) out.items.push({ kind: 'message', role, text: content.trim().slice(0, 280) });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.items.push({ kind: 'message', role, text: b.text.trim().slice(0, 280) });
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          out.items.push({ kind: 'tool', name: b.name, detail: toolDetail(b.input) });
        } else if (b.type === 'tool_result' && b.is_error === true) {
          const txt = typeof b.content === 'string' ? stripToolError(b.content) : '';
          (out.alerts ??= []).push({ kind: 'tool-error', severity: 'warn', message: (txt || 'tool returned an error').slice(0, 160) });
        }
        // thinking blocks are intentionally ignored in the v1 board.
      }
    }
  }
  return out;
}

/** ~/.claude/projects/-Users-me-Projects-foreman → "foreman" (display label). */
export function repoLabelFromCwd(cwd: string | undefined, fallback: string): string {
  if (!cwd) return fallback;
  const seg = cwd.split('/').filter(Boolean).pop();
  return seg ?? fallback;
}
