// Client-side board store fed by the server's SSE stream.
//
// The server projection is the single source of truth: on each appended event we
// debounce-refetch /api/board rather than duplicating the reducer in the browser.
// Alongside the board snapshot we keep a rolling, human-readable ACTIVITY LOG built
// directly from the append stream — that is what the Agent Stream dock renders, and
// it's also how we fire desktop notifications when a card starts waiting on a human.

export type Column = 'aligning' | 'specd' | 'sliced' | 'building' | 'review' | 'done';
export type Vendor = 'claude-code' | 'codex' | 'gemini-cli' | 'unknown';
export type AgentStatus = 'running' | 'idle' | 'waiting' | 'done' | 'error';
export type Reviewer = 'claude-code' | 'codex' | 'gemini-cli';
export type BoardMode = 'live' | 'demo';
export type AlertSeverity = 'info' | 'warn' | 'error';
export type AlertKind =
  | 'needs-input' | 'rate-limit' | 'server-error' | 'tool-error' | 'auth'
  | 'dumb-zone' | 'near-limit' | 'compacted';

export interface ContextSnapshot {
  pctUsed: number; tokensIn: number; tokensOut: number; cacheRead: number; costUsd: number; model: string;
}
export interface Card {
  taskId: string; sessionId: string; repo: string; title: string; subtitle?: string;
  column: Column; blocks: string[]; blockedBy: string[];
  vendor?: Vendor; agentId?: string; parentId?: string; agentType?: string;
  agentStatus?: AgentStatus; agentReason?: string; worktree?: string;
  context?: ContextSnapshot; diff?: { files: number; added: number; removed: number; testsGreen?: boolean };
  test?: { passed: boolean; command?: string; summary?: string };
  review?: { reviewer: Reviewer; verdict: 'approve' | 'changes' | 'error' | 'pending'; findings: string };
  branch?: string; dirty?: number; ahead?: number; behind?: number;
  compacted?: { count: number; trigger?: string; ts: number };
  lastTool?: string;
  subagents?: { label: string; ts: number }[];
  synthetic?: boolean;
  updatedAt: number;
}
export interface Alert {
  id: string; ts: number; kind: AlertKind; severity: AlertSeverity; message: string;
  sessionId?: string; taskId?: string;
}
export interface BoardState {
  columns: Record<Column, Card[]>;
  cards: Record<string, Card>;
  alerts: Alert[];
  totals: { agents: number; costUsd: number; pctUsed: number };
}

export interface Activity { ts: number; kind: 'tool' | 'message' | 'status' | 'diff'; text: string; repo?: string; }

// ---- Top-level navigation ----
export type View = 'board' | 'project' | 'sessions' | 'market';
export const ui = $state<{ view: View; projectPath: string; sessionDetail?: string; cardDrawer?: string }>({ view: 'board', projectPath: '' });

export const mode = $state<{ value: BoardMode; eventLog?: string; switching: boolean; error?: string }>({
  value: 'live',
  eventLog: undefined,
  switching: false,
  error: undefined,
});

export async function setBoardMode(next: BoardMode): Promise<void> {
  if (mode.switching || next === mode.value) return;
  mode.switching = true;
  mode.error = undefined;
  try {
    const r = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    });
    const j = (await r.json()) as { mode?: BoardMode; eventLog?: string; error?: string };
    if (!r.ok || !j.mode) throw new Error(j.error ?? `HTTP ${r.status}`);
    mode.value = j.mode;
    mode.eventLog = j.eventLog;
  } catch (e) {
    mode.error = (e as Error).message;
  } finally {
    mode.switching = false;
  }
}

// ---- Project Overview (Sprint A) ----
export interface Dependency { name: string; version: string; dev: boolean; }
export interface StackInfo { languages: string[]; frameworks: string[]; ecosystems: string[]; dependencies: Dependency[]; }
export interface GitInfo {
  branch: string; remoteUrl?: string; githubSlug?: string;
  ahead: number; behind: number; dirty: number;
  lastCommits: Array<{ sha: string; subject: string; when: string }>;
}
export interface ProjectReport { name: string; path: string; stack: StackInfo; git?: GitInfo; policies?: string[]; }

export async function fetchProject(path: string): Promise<ProjectReport | null> {
  try {
    const r = await fetch(`/api/project?path=${encodeURIComponent(path)}`);
    return r.ok ? ((await r.json()) as ProjectReport) : null;
  } catch { return null; }
}

const EMPTY: BoardState = {
  columns: { aligning: [], specd: [], sliced: [], building: [], review: [], done: [] },
  cards: {}, alerts: [], totals: { agents: 0, costUsd: 0, pctUsed: 0 },
};

/** Context fraction at/after which reasoning degrades (HumanLayer's "dumb zone"). */
export const DUMB_ZONE = 0.4;
/** Project context burn near the window — flag before it's too late. */
export const NEAR_LIMIT = 0.85;

const ACTIVITY_CAP = 200;

export const board = $state<{
  value: BoardState;
  connected: boolean;
  activity: Activity[];
  /** UI filter state, owned here so the header + board + dock stay in sync. */
  query: string;
  repoFilter: string; // '' = all repos
  selected?: string; // taskId pinned into the review pane
  /** Ticking clock (ms) so recency-based "live" highlighting decays in the UI. */
  now: number;
  /** Done taskIds the user has cleared from view (client-side, persisted). */
  cleared: string[];
}>({
  value: EMPTY,
  connected: false,
  activity: [],
  query: '',
  repoFilter: '',
  selected: undefined,
  now: 0,
  cleared: loadCleared(),
});

/** A session/agent is "live" if it reports running, or was touched very recently. */
const LIVE_WINDOW_MS = 75_000;
export function isLive(card: Card): boolean {
  if (card.agentStatus === 'running' || card.agentStatus === 'waiting') return true;
  if (card.agentStatus === 'done' || card.agentStatus === 'error' || card.agentStatus === 'idle') return false;
  return board.now > 0 && board.now - card.updatedAt < LIVE_WINDOW_MS;
}

// ---- Clear "Done" (client-side; observed cards are read-only on disk) ----
const CLEARED_KEY = 'foreman.cleared';
function loadCleared(): string[] {
  try { const v = JSON.parse(localStorage.getItem(CLEARED_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveCleared(): void {
  try { localStorage.setItem(CLEARED_KEY, JSON.stringify(board.cleared)); } catch { /* private mode / quota */ }
}
/** Hide every card currently in Done (keeps new ones; survives reload). */
export function clearDone(): void {
  const ids = board.value.columns.done.map((c) => c.taskId);
  board.cleared = [...new Set([...board.cleared, ...ids])];
  saveCleared();
}
/** Bring back everything that was cleared. */
export function restoreCleared(): void {
  board.cleared = [];
  saveCleared();
}
export function isCleared(taskId: string): boolean {
  return board.cleared.includes(taskId);
}

/** Repos seen on the board, for the multi-repo selector. */
export function repos(): string[] {
  return [...new Set(Object.values(board.value.cards).map((c) => c.repo))].sort();
}

/** Look up a single card by task id (drives the detail drawer). */
export function cardById(taskId: string | undefined): Card | undefined {
  return taskId ? board.value.cards[taskId] : undefined;
}

/** Cards currently blocked waiting on a human — drives the attention badge. */
export function waitingCards(): Card[] {
  return Object.values(board.value.cards).filter((c) => c.agentStatus === 'waiting');
}

export interface AttentionItem {
  id: string; ts: number; kind: AlertKind; severity: AlertSeverity; message: string;
  taskId?: string; repo?: string; title?: string;
}

/**
 * The Attention rail's data: live card-derived signals (needs-input, errored,
 * near-limit, dumb-zone) merged with transient event alerts (rate-limit, tool
 * errors, compaction). Sorted worst-first, newest-first.
 */
export function attention(): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const c of Object.values(board.value.cards)) {
    if (c.agentStatus === 'waiting') items.push({ id: `w:${c.taskId}`, ts: c.updatedAt, kind: 'needs-input', severity: 'warn', message: c.agentReason || 'waiting for your input', taskId: c.taskId, repo: c.repo, title: c.title });
    else if (c.agentStatus === 'error') items.push({ id: `e:${c.taskId}`, ts: c.updatedAt, kind: 'tool-error', severity: 'error', message: c.agentReason || 'agent errored', taskId: c.taskId, repo: c.repo, title: c.title });
    const pct = c.context?.pctUsed ?? 0;
    if (pct >= NEAR_LIMIT) items.push({ id: `n:${c.taskId}`, ts: c.updatedAt, kind: 'near-limit', severity: 'warn', message: `context ${Math.round(pct * 100)}% — near the window limit`, taskId: c.taskId, repo: c.repo, title: c.title });
    else if (pct >= DUMB_ZONE) items.push({ id: `d:${c.taskId}`, ts: c.updatedAt, kind: 'dumb-zone', severity: 'info', message: `context ${Math.round(pct * 100)}% — in the dumb zone`, taskId: c.taskId, repo: c.repo, title: c.title });
  }
  const transient = new Set<AlertKind>(['rate-limit', 'server-error', 'tool-error', 'auth', 'compacted']);
  for (const a of board.value.alerts) {
    if (!transient.has(a.kind)) continue;
    const c = a.taskId ? board.value.cards[a.taskId] : undefined;
    items.push({ id: a.id, ts: a.ts, kind: a.kind, severity: a.severity, message: a.message, taskId: a.taskId, repo: c?.repo, title: c?.title });
  }
  const rank: Record<AlertSeverity, number> = { error: 0, warn: 1, info: 2 };
  return items.sort((x, y) => rank[x.severity] - rank[y.severity] || y.ts - x.ts).slice(0, 40);
}

export async function fetchReviewers(): Promise<Reviewer[]> {
  try { const r = await fetch('/api/reviewers'); if (!r.ok) return ['claude-code']; return ((await r.json()) as { reviewers: Reviewer[] }).reviewers; }
  catch { return ['claude-code']; }
}

/** Kick off a cross-model AI review; results stream back as review.* events. */
export async function requestReview(taskId: string, reviewer: Reviewer): Promise<void> {
  try { await fetch('/api/review/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId, reviewer }) }); }
  catch { /* SSE reconciles */ }
}

let notifyAllowed = false;
function armNotifications(): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') { notifyAllowed = true; return; }
  if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { notifyAllowed = p === 'granted'; });
}
function notify(title: string, body: string): void {
  if (notifyAllowed && typeof Notification !== 'undefined') {
    try { new Notification(title, { body, silent: false }); } catch { /* ignore */ }
  }
}

function pushActivity(a: Activity): void {
  board.activity.push(a);
  if (board.activity.length > ACTIVITY_CAP) board.activity.splice(0, board.activity.length - ACTIVITY_CAP);
}

let refetchTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefetch(): void {
  if (refetchTimer) return;
  refetchTimer = setTimeout(async () => {
    refetchTimer = undefined;
    try {
      const res = await fetch('/api/board');
      if (res.ok) board.value = (await res.json()) as BoardState;
    } catch { /* transient; SSE will trigger another */ }
  }, 120);
}

interface AppendEvent {
  type: string; ts?: number;
  tool?: string; detail?: string; agentId?: string;
  role?: string; text?: string; sessionId?: string;
  status?: AgentStatus; reason?: string;
  taskId?: string; files?: number; added?: number; removed?: number;
  kind?: AlertKind; severity?: AlertSeverity; message?: string;
  passed?: boolean; command?: string; trigger?: string;
  reviewer?: Reviewer; verdict?: string;
}

function describe(e: AppendEvent): Activity | undefined {
  switch (e.type) {
    case 'tool.used':
      return { ts: e.ts ?? 0, kind: 'tool', text: e.detail ? `${e.tool} · ${e.detail}` : (e.tool ?? 'tool') };
    case 'message':
      return e.text ? { ts: e.ts ?? 0, kind: 'message', text: `${e.role ?? 'msg'}: ${e.text.slice(0, 120)}` } : undefined;
    case 'agent.status':
      return { ts: e.ts ?? 0, kind: 'status', text: `${e.status}${e.reason ? ` (${e.reason})` : ''}` };
    case 'diff.ready':
      return { ts: e.ts ?? 0, kind: 'diff', text: `diff ready · +${e.added} −${e.removed} · ${e.files} files` };
    case 'test.run':
      return { ts: e.ts ?? 0, kind: 'status', text: `tests ${e.passed ? 'passed ✓' : 'failed ✗'}${e.command ? ` (${e.command})` : ''}` };
    case 'alert':
      return { ts: e.ts ?? 0, kind: 'status', text: `⚠ ${e.kind}: ${e.message ?? ''}`.slice(0, 140) };
    case 'context.compacted':
      return { ts: e.ts ?? 0, kind: 'status', text: `context compacted${e.trigger ? ` (${e.trigger})` : ''}` };
    case 'review.requested':
      return { ts: e.ts ?? 0, kind: 'status', text: `review requested → ${e.reviewer}` };
    case 'review.ready':
      return { ts: e.ts ?? 0, kind: 'diff', text: `review by ${e.reviewer}: ${e.verdict}` };
    default:
      return undefined;
  }
}

function reconcileBoardSnapshot(next: BoardState): void {
  board.value = next;
  const hasSelected = !!board.selected && !!next.cards[board.selected];
  if (!hasSelected) board.selected = undefined;
  const hasDrawer = !!ui.cardDrawer && !!next.cards[ui.cardDrawer];
  if (!hasDrawer) ui.cardDrawer = undefined;
  if (board.repoFilter && !Object.values(next.cards).some((c) => c.repo === board.repoFilter)) {
    board.repoFilter = '';
  }
}

function resetModeLocalState(): void {
  board.activity = [];
  board.selected = undefined;
  ui.cardDrawer = undefined;
}

// ---- Control plane (write-side) — POST helpers for the orchestration API. ----

export interface RepoChoice { repo: string; path: string; }

export async function fetchRepos(): Promise<RepoChoice[]> {
  try { const r = await fetch('/api/repos'); return r.ok ? ((await r.json()) as RepoChoice[]) : []; }
  catch { return []; }
}

/** A background document attached at intake (PRD/spec); content is the file text. */
export interface IntakeDoc { name: string; content: string; }

export interface SpawnReq {
  taskId: string; repoPath: string; vendor: Vendor; prompt: string; model?: string;
  skills?: string[]; agents?: string[]; docs?: IntakeDoc[];
}

export async function spawnAgent(req: SpawnReq): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/spawn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    if (r.ok) return { ok: true };
    return { ok: false, error: ((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- Task intake (Phase 1) — context auto-detect, agent discovery, prompt refine. ----

export interface IntakeContext {
  active?: { repo: string; repoPath?: string; branch?: string; sessionId?: string; vendor?: Vendor };
  repos: RepoChoice[];
}

/** What the New-task wizard should default to + every repo Foreagent has observed. */
export async function fetchContext(): Promise<IntakeContext> {
  try { const r = await fetch('/api/context'); return r.ok ? ((await r.json()) as IntakeContext) : { repos: [] }; }
  catch { return { repos: [] }; }
}

/** A selectable model for a vendor (id is the value passed to the vendor's CLI flag). */
export interface ModelOption { id: string; label: string; context?: string; priceIn?: number; priceOut?: number; note?: string; default?: boolean; }

/** A vendor CLI as detected on the host: whether it's installed, where, and its models. */
export interface VendorInfo {
  vendor: Vendor; bin: string; path?: string; installed: boolean; version?: string;
  models: ModelOption[]; defaultModel?: string;
}

/** Which vendor CLIs are installed on this machine (+ their model catalogues). */
export async function fetchVendors(): Promise<VendorInfo[]> {
  try { const r = await fetch('/api/vendors'); return r.ok ? ((await r.json()) as VendorInfo[]) : []; }
  catch { return []; }
}

export interface DiscoveredAgent { name: string; description: string; tools?: string[]; model?: string; scope: 'project' | 'user'; }

/** Reusable subagents available to a repo (.claude/agents, project + user scope). */
export async function discoverAgents(repoPath: string): Promise<DiscoveredAgent[]> {
  try { const r = await fetch(`/api/discover/agents?path=${encodeURIComponent(repoPath)}`); return r.ok ? ((await r.json()) as DiscoveredAgent[]) : []; }
  catch { return []; }
}

/** An MCP server available to a vendor for a repo — local (project) or global (user) scope. */
export interface McpServer {
  name: string; vendor: Vendor; scope: 'user' | 'project'; source: string;
  transport: 'stdio' | 'http' | 'sse'; command?: string; url?: string; enabled?: boolean;
}

/** MCP servers the selected vendor can use for this repo (local + global scope). */
export async function fetchMcp(repoPath: string, vendor: Vendor): Promise<McpServer[]> {
  try {
    const r = await fetch(`/api/mcp?path=${encodeURIComponent(repoPath)}&vendor=${encodeURIComponent(vendor)}`);
    return r.ok ? ((await r.json()) as McpServer[]) : [];
  } catch { return []; }
}

/** Clean up a rough brief via `claude -p`. Fail-safe: returns the original on error. */
export async function refinePrompt(prompt: string): Promise<{ refined: string; error?: string }> {
  try {
    const r = await fetch('/api/ai/refine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
    if (!r.ok) return { refined: prompt, error: `HTTP ${r.status}` };
    const j = (await r.json()) as { refined?: string; error?: string };
    return { refined: j.refined ?? prompt, error: j.error };
  } catch (e) { return { refined: prompt, error: (e as Error).message }; }
}

// ---- Session detail (Sprint C) ----
export interface DetailMessage { role: string; text: string; ts?: number; }
export interface DetailTool { name: string; detail?: string; ts?: number; }
export interface DetailPoint { ts?: number; pctUsed: number; costCumulative: number; }
export interface SessionDetail {
  sessionId: string; cwd?: string; model?: string;
  messages: DetailMessage[]; tools: DetailTool[]; timeline: DetailPoint[];
  totals: { messages: number; tools: number; costUsd: number; pctUsed: number };
}

export async function fetchSession(id: string): Promise<SessionDetail | null> {
  try { const r = await fetch(`/api/session?id=${encodeURIComponent(id)}`); return r.ok ? ((await r.json()) as SessionDetail) : null; }
  catch { return null; }
}

// ---- Marketplace (Sprint D) ----
export interface CatalogSkill { id: string; name: string; description: string; tags: string[]; skillMd: string; }
export interface InstalledSkill { name: string; description: string; path: string; }
export interface FeedItem { id: string; title: string; tag: string; summary: string; why: string; source: string; }
export interface TemplateItem { id: string; title: string; tag: string; prompt: string; }

async function getJson<T>(url: string, fallback: T): Promise<T> {
  try { const r = await fetch(url); return r.ok ? ((await r.json()) as T) : fallback; } catch { return fallback; }
}
export const fetchSkills = () => getJson<{ installed: InstalledSkill[]; catalog: CatalogSkill[] }>('/api/skills', { installed: [], catalog: [] });
export const fetchFeed = () => getJson<FeedItem[]>('/api/feed', []);
export const fetchTemplates = () => getJson<TemplateItem[]>('/api/templates', []);

export async function installSkill(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/skills/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    return (await r.json()) as { ok: boolean; error?: string };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- AI bridge (Sprint B) — stream `claude -p` output over a fetch POST. ----
// EventSource is GET-only, so we POST and parse the SSE frames off the response body.
export interface AiHandlers { onToken: (t: string) => void; onDone?: () => void; onError?: (e: string) => void; }

export async function streamAi(endpoint: string, body: unknown, h: AiHandlers, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) { h.onError?.((e as Error).message); return; }
  if (!res.ok || !res.body) { h.onError?.(`HTTP ${res.status}`); return; }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch (e) { h.onError?.((e as Error).message); return; }
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    // SSE frames are separated by a blank line.
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const ev = /event:\s*(\w+)/.exec(frame)?.[1];
      const dataLine = /data:\s*([\s\S]*)$/.exec(frame)?.[1] ?? '';
      if (ev === 'token') { try { h.onToken(JSON.parse(dataLine)); } catch { /* ignore */ } }
      else if (ev === 'done') h.onDone?.();
      else if (ev === 'error') { let m = dataLine; try { m = (JSON.parse(dataLine) as { error?: string }).error ?? dataLine; } catch { /* */ } h.onError?.(m); }
    }
  }
  h.onDone?.();
}

export async function reviewCard(taskId: string, approve: boolean): Promise<void> {
  try { await fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId, approve }) }); }
  catch { /* SSE will reconcile board state regardless */ }
}

export function connect(): void {
  armNotifications();
  // Tick a clock so recency-based "live" highlighting fades as work goes quiet.
  board.now = Date.now();
  setInterval(() => { board.now = Date.now(); }, 4000);
  const es = new EventSource('/api/events');
  es.addEventListener('mode', (ev) => {
    const m = JSON.parse((ev as MessageEvent).data) as { mode: BoardMode; eventLog?: string };
    if (m.mode !== mode.value || m.eventLog !== mode.eventLog) resetModeLocalState();
    mode.value = m.mode;
    mode.eventLog = m.eventLog;
    mode.error = undefined;
  });
  es.addEventListener('snapshot', (ev) => {
    reconcileBoardSnapshot(JSON.parse((ev as MessageEvent).data) as BoardState);
    board.connected = true;
  });
  es.addEventListener('append', (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as AppendEvent;
    const a = describe(e);
    if (a) pushActivity(a);
    if (e.type === 'agent.status' && e.status === 'waiting') {
      notify('FOREAGENT — agent waiting', e.reason ? `An agent needs you: ${e.reason}` : 'An agent is waiting for input.');
    }
    if (e.type === 'alert' && e.severity === 'error') {
      notify('FOREAGENT — agent blocked', e.message ?? 'An agent hit an error.');
    }
    scheduleRefetch();
  });
  es.onerror = () => { board.connected = false; };
}
