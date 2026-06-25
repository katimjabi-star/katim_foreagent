import {
  COLUMNS, type Column, type ContextSnapshot, type ForemanEvent, type Vendor, type AgentStatus,
  type AlertKind, type AlertSeverity, type Reviewer,
} from './events.ts';

/** A card as the board renders it — the read-model, not the event stream. */
export interface Card {
  taskId: string;
  sessionId: string;
  repo: string;
  title: string;
  subtitle?: string;
  column: Column;
  blocks: string[];
  blockedBy: string[];
  vendor?: Vendor;
  agentId?: string;
  /** Subagent tree: which agent spawned this one, and the subagent type. */
  parentId?: string;
  agentType?: string;
  agentStatus?: AgentStatus;
  agentReason?: string;
  worktree?: string;
  context?: ContextSnapshot;
  diff?: { files: number; added: number; removed: number; testsGreen?: boolean };
  test?: { passed: boolean; command?: string; summary?: string };
  review?: { reviewer: Reviewer; verdict: 'approve' | 'changes' | 'error' | 'pending'; findings: string };
  /** Live git context for the card's repo (branch / dirty / divergence). */
  branch?: string;
  dirty?: number;
  ahead?: number;
  behind?: number;
  /** Compaction history for this session (count + last trigger). */
  compacted?: { count: number; trigger?: string; ts: number };
  lastTool?: string;
  /** Subagents this card spawned (one per `Task` tool call), newest last. */
  subagents?: { label: string; ts: number }[];
  /**
   * A placeholder card stood up from `session.seen` for a session that is active
   * but hasn't written any todos yet — it represents the "Aligning" stage. It is
   * removed the moment the session's first real task card appears.
   */
  synthetic?: boolean;
  updatedAt: number;
}

/** An attention-worthy signal surfaced in the Attention rail. */
export interface Alert {
  id: string;
  ts: number;
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  sessionId?: string;
  taskId?: string;
}

const ALERT_CAP = 60;
/** An Aligning placeholder older than this (no todos written) is treated as dead. */
const ALIGNING_TTL_MS = 20 * 60_000;
/** Keep at most this many subagent entries per card (newest win). */
const SUBAGENT_CAP = 12;

export interface BoardState {
  columns: Record<Column, Card[]>;
  cards: Record<string, Card>;
  /** Newest-first ring of recent attention signals (errors, limits, compaction). */
  alerts: Alert[];
  /** Rolled-up session totals shown in the top bar. */
  totals: { agents: number; costUsd: number; pctUsed: number };
}

/** ~40% context utilisation is HumanLayer's "dumb zone" — surface it as a flag. */
export const DUMB_ZONE = 0.4;

/**
 * Folds the event log into board state. Pure and idempotent over replay:
 * `replay(all())` on boot must equal the live state, or SSE late-joiners drift.
 */
export class BoardProjection {
  private cards = new Map<string, Card>();
  private alerts: Alert[] = [];
  /** Repo label per session, learned from session.seen (used for Aligning cards). */
  private sessionRepo = new Map<string, string>();

  private pushAlert(a: Alert): void {
    this.alerts.unshift(a);
    if (this.alerts.length > ALERT_CAP) this.alerts.length = ALERT_CAP;
  }

  apply(e: ForemanEvent): void {
    switch (e.type) {
      case 'task.created': {
        // The session has produced real work — retire its Aligning placeholder.
        this.dropSyntheticFor(e.sessionId);
        this.cards.set(e.taskId, {
          taskId: e.taskId,
          sessionId: e.sessionId,
          repo: e.repo,
          title: e.title,
          column: e.column,
          blocks: e.blocks ?? [],
          blockedBy: e.blockedBy ?? [],
          // Observed task cards come from Claude Code's on-disk task store, so they
          // are Claude Code by definition — default the ribbon vendor accordingly.
          // Control-plane spawns overwrite this with their real vendor on agent.spawned.
          vendor: 'claude-code',
          updatedAt: e.ts,
        });
        break;
      }
      case 'task.updated': {
        const c = this.cards.get(e.taskId);
        if (!c) break;
        if (e.title !== undefined) c.title = e.title;
        if (e.subtitle !== undefined) c.subtitle = e.subtitle;
        if (e.column !== undefined) c.column = e.column;
        if (e.repo !== undefined) c.repo = e.repo;
        if (e.blocks !== undefined) c.blocks = e.blocks;
        if (e.blockedBy !== undefined) c.blockedBy = e.blockedBy;
        c.updatedAt = e.ts;
        break;
      }
      case 'task.moved': {
        const c = this.cards.get(e.taskId);
        if (c) { c.column = e.column; c.updatedAt = e.ts; }
        break;
      }
      case 'task.removed': {
        this.cards.delete(e.taskId);
        break;
      }
      case 'agent.spawned': {
        const c = this.cards.get(e.taskId);
        if (c) { c.vendor = e.vendor; c.agentId = e.agentId; c.worktree = e.worktree; c.parentId = e.parentId; c.agentType = e.agentType; c.agentStatus = 'running'; c.updatedAt = e.ts; }
        break;
      }
      case 'agent.status': {
        // Spawned agents resolve by agentId; hook-derived status on an *observed*
        // session (no spawned agent) resolves by sessionId. A live running/waiting
        // session with no card yet is aligning.
        if (e.status === 'running' || e.status === 'waiting') this.ensureAligning(e.sessionId ?? this.sidOf(e.agentId), e.ts);
        const c = (e.agentId ? this.byAgent(e.agentId) : undefined) ?? (e.sessionId ? this.bySession(e.sessionId) : undefined);
        if (c) { c.agentStatus = e.status; c.agentReason = e.reason; c.updatedAt = e.ts; }
        break;
      }
      case 'tool.used': {
        const sid = this.sidOf(e.agentId);
        if (!e.taskId) this.ensureAligning(sid, e.ts);
        // Observed task cards have no agentId, so fall back to the session's lead
        // card — otherwise a session's tool activity (incl. its subagents) is lost.
        const c = e.taskId ? this.cards.get(e.taskId) : (this.byAgent(e.agentId) ?? (sid ? this.bySession(sid) : undefined));
        if (c) {
          c.lastTool = e.detail ? `${e.tool} · ${e.detail}` : e.tool;
          // A `Task` tool call IS a subagent invocation — record it so the card can
          // show its subagents nested beneath it, the way Claude Code does.
          if (/^Task$/i.test(e.tool)) {
            (c.subagents ??= []).push({ label: e.detail ?? 'subagent', ts: e.ts });
            if (c.subagents.length > SUBAGENT_CAP) c.subagents.shift();
          }
          c.updatedAt = e.ts;
        }
        break;
      }
      case 'context.snapshot': {
        if (!e.taskId) this.ensureAligning(e.sessionId ?? this.sidOf(e.agentId), e.ts);
        const c = e.taskId ? this.cards.get(e.taskId) : e.agentId ? this.byAgent(e.agentId) : this.bySession(e.sessionId);
        if (c) { c.context = e.snapshot; c.updatedAt = e.ts; }
        break;
      }
      case 'diff.ready': {
        const c = this.cards.get(e.taskId);
        if (c) { c.diff = { files: e.files, added: e.added, removed: e.removed, testsGreen: e.testsGreen }; c.updatedAt = e.ts; }
        break;
      }
      case 'test.run': {
        const c = this.cards.get(e.taskId);
        if (c) {
          c.test = { passed: e.passed, command: e.command, summary: e.summary };
          if (c.diff) c.diff.testsGreen = e.passed;
          c.updatedAt = e.ts;
        }
        break;
      }
      case 'context.compacted': {
        const c = this.bySession(e.sessionId);
        if (c) {
          c.compacted = { count: (c.compacted?.count ?? 0) + 1, trigger: e.trigger, ts: e.ts };
          c.updatedAt = e.ts;
        }
        this.pushAlert({
          id: e.id, ts: e.ts, kind: 'compacted', severity: 'info', sessionId: e.sessionId,
          taskId: c?.taskId,
          message: `Context compacted${e.trigger ? ` (${e.trigger})` : ''}${e.preTokens && e.postTokens ? ` · ${Math.round(e.preTokens / 1000)}k→${Math.round(e.postTokens / 1000)}k` : ''}`,
        });
        break;
      }
      case 'alert': {
        const c = e.taskId ? this.cards.get(e.taskId) : e.sessionId ? this.bySession(e.sessionId) : undefined;
        this.pushAlert({ id: e.id, ts: e.ts, kind: e.kind, severity: e.severity, message: e.message, sessionId: e.sessionId, taskId: c?.taskId ?? e.taskId });
        break;
      }
      case 'git.snapshot': {
        for (const c of this.cards.values()) {
          if (c.repo !== e.repo) continue;
          c.branch = e.branch; c.dirty = e.dirty; c.ahead = e.ahead; c.behind = e.behind;
        }
        break;
      }
      case 'review.requested': {
        const c = this.cards.get(e.taskId);
        if (c) { c.review = { reviewer: e.reviewer, verdict: 'pending', findings: '' }; c.updatedAt = e.ts; }
        break;
      }
      case 'review.ready': {
        const c = this.cards.get(e.taskId);
        if (c) { c.review = { reviewer: e.reviewer, verdict: e.verdict, findings: e.findings }; c.updatedAt = e.ts; }
        break;
      }
      case 'session.seen': {
        // Just remember the repo label — do NOT create a card here. session.seen
        // fires once per transcript on the watcher's initial scan (hundreds of
        // historical, dead sessions), so a card per session.seen floods the board.
        // The Aligning placeholder is instead driven by *live* activity below.
        this.sessionRepo.set(e.sessionId, e.repo);
        break;
      }
      // message events don't mutate card state in the v1 board.
    }
  }

  /**
   * A session showing live activity (a tool call, a context snapshot, a running
   * status) but with no todos yet is *aligning* — working the problem before it
   * writes a plan. Historical sessions never reach here: the transcript watcher
   * seeks to EOF on its initial scan, so only genuinely live sessions emit these
   * signals. Superseded by real task cards (see dropSyntheticFor in task.created).
   */
  private ensureAligning(sessionId: string | undefined, ts: number): void {
    if (!sessionId) return;
    for (const c of this.cards.values()) if (c.sessionId === sessionId) return; // already has a card
    const repo = this.sessionRepo.get(sessionId) ?? `session ${sessionId.slice(0, 8)}`;
    this.cards.set(`session:${sessionId}`, {
      taskId: `session:${sessionId}`, sessionId, repo,
      title: repo, subtitle: 'aligning — no plan yet',
      column: 'aligning', blocks: [], blockedBy: [], vendor: 'claude-code', synthetic: true, updatedAt: ts,
    });
  }

  /** Map a `session:<id>` agent handle (observed sessions) back to its sessionId. */
  private sidOf(agentId: string | undefined): string | undefined {
    return agentId?.startsWith('session:') ? agentId.slice('session:'.length) : undefined;
  }

  /** Remove a session's Aligning placeholder once it has real work to show. */
  private dropSyntheticFor(sessionId: string): void {
    for (const [id, c] of this.cards) if (c.synthetic && c.sessionId === sessionId) this.cards.delete(id);
  }

  private byAgent(agentId: string): Card | undefined {
    for (const c of this.cards.values()) if (c.agentId === agentId) return c;
    return undefined;
  }
  private bySession(sessionId: string): Card | undefined {
    // A session can own several cards; the live meter belongs on the one being
    // worked. Prefer the building card, then the most-recently-touched.
    let best: Card | undefined;
    for (const c of this.cards.values()) {
      if (c.sessionId !== sessionId) continue;
      if (c.column === 'building') return c;
      if (!best || c.updatedAt > best.updatedAt) best = c;
    }
    return best;
  }

  /**
   * Renders the board. Pass `now` (epoch ms) to age out stale Aligning placeholders:
   * an observed session that showed activity but never wrote todos is only "aligning"
   * while it's live — without a TTL, every such session in the whole event-log history
   * would pile up in the column. Omitting `now` keeps the render pure for replay tests.
   */
  state(now?: number): BoardState {
    const columns = Object.fromEntries(COLUMNS.map((c) => [c, [] as Card[]])) as Record<Column, Card[]>;
    const cards: Record<string, Card> = {};
    let costUsd = 0;
    let agents = 0;
    let pctMax = 0;
    // A session whose todos exist but none have started yet is still at the *spec*
    // stage — the whole plan is laid out but unbegun. Once any slice moves into
    // building/review/done, the remaining pending todos become active *slices*.
    const started = new Set<string>();
    for (const c of this.cards.values()) {
      if (c.column === 'building' || c.column === 'review' || c.column === 'done') started.add(c.sessionId);
    }
    for (const c of this.cards.values()) {
      // Age out dead Aligning placeholders (live-only state, see state() doc).
      if (c.synthetic && now !== undefined && now - c.updatedAt > ALIGNING_TTL_MS) continue;
      const col = c.column === 'sliced' && !started.has(c.sessionId) ? 'specd' : c.column;
      // Surface the derived stage on the read-model card (drawer/actions read
      // `.column`) without mutating the stored projection — a clone keeps replay
      // idempotent so the card can re-evaluate to 'sliced' once work starts.
      const view = col === c.column ? c : { ...c, column: col };
      columns[col].push(view);
      cards[view.taskId] = view;
      if (c.agentStatus === 'running' || c.agentStatus === 'waiting' || c.agentStatus === 'idle') agents++;
      if (c.context) { costUsd += c.context.costUsd; pctMax = Math.max(pctMax, c.context.pctUsed); }
    }
    for (const col of COLUMNS) columns[col].sort((a, b) => b.updatedAt - a.updatedAt);
    return { columns, cards, alerts: this.alerts.slice(), totals: { agents, costUsd, pctUsed: pctMax } };
  }
}

export function replay(events: readonly ForemanEvent[]): BoardProjection {
  const p = new BoardProjection();
  for (const e of events) p.apply(e);
  return p;
}
