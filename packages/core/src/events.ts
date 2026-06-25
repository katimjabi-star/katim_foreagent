/**
 * Foreman event vocabulary.
 *
 * The whole system is event-sourced: observers (filesystem watchers) and, later,
 * controllers (the command bus that spawns agents) BOTH emit these same events.
 * That is the single decision that lets the observer→control hybrid share one
 * spine instead of becoming two bolted-together apps — the board only ever reads
 * a projection of this log and never knows who produced an event.
 */

/** The six SDLC columns (Matt Pocock's skill pipeline made into board state). */
export type Column = 'aligning' | 'specd' | 'sliced' | 'building' | 'review' | 'done';

export const COLUMNS: Column[] = ['aligning', 'specd', 'sliced', 'building', 'review', 'done'];

/** Which CLI produced the work — multi-agent from day one. */
export type Vendor = 'claude-code' | 'codex' | 'gemini-cli' | 'unknown';

/** Lifecycle status of an agent working a card. */
export type AgentStatus = 'running' | 'idle' | 'waiting' | 'done' | 'error';

/** Severity of an attention-worthy signal surfaced in the Attention rail. */
export type AlertSeverity = 'info' | 'warn' | 'error';

/** What kind of attention a signal needs — drives the rail's grouping/icon. */
export type AlertKind =
  | 'needs-input'   // Claude is asking for permission/input (hook Notification)
  | 'rate-limit'    // usage/session limit hit (transcript apiErrorStatus 429)
  | 'server-error'  // transient API/server error (e.g. 529 overloaded)
  | 'tool-error'    // a tool_result came back is_error:true
  | 'auth'          // auth/credit failure
  | 'dumb-zone'     // context ≥ 40% — degraded reasoning
  | 'near-limit'    // context burn projected to exhaust soon
  | 'compacted';    // context was just compacted

/** Which model reviewed a diff in the cross-model review gate. */
export type Reviewer = 'claude-code' | 'codex' | 'gemini-cli';

/** Token / cost / context snapshot — the moat: context-budget awareness. */
export interface ContextSnapshot {
  /** 0..1 fraction of the model context window used. ~0.40 is the "dumb zone". */
  pctUsed: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  costUsd: number;
  model: string;
}

interface Base {
  /** Monotonic-ish unique id. */
  id: string;
  /** Unix epoch ms. */
  ts: number;
}

export type ForemanEvent = Base &
  (
    | { type: 'task.created'; taskId: string; sessionId: string; repo: string; title: string; column: Column; blocks?: string[]; blockedBy?: string[] }
    | { type: 'task.updated'; taskId: string; title?: string; subtitle?: string; column?: Column; repo?: string; blocks?: string[]; blockedBy?: string[] }
    | { type: 'task.moved'; taskId: string; column: Column }
    | { type: 'task.removed'; taskId: string }
    | { type: 'agent.spawned'; agentId: string; taskId: string; vendor: Vendor; worktree?: string; parentId?: string; agentType?: string }
    | { type: 'agent.status'; agentId?: string; sessionId?: string; status: AgentStatus; reason?: string }
    | { type: 'tool.used'; agentId: string; taskId?: string; tool: string; detail?: string }
    | { type: 'message'; sessionId: string; agentId?: string; role: 'user' | 'assistant' | 'system'; text: string }
    | { type: 'context.snapshot'; sessionId: string; agentId?: string; taskId?: string; snapshot: ContextSnapshot }
    | { type: 'context.compacted'; sessionId: string; trigger?: string; preTokens?: number; postTokens?: number }
    | { type: 'diff.ready'; taskId: string; agentId?: string; files: number; added: number; removed: number; testsGreen?: boolean }
    | { type: 'test.run'; taskId: string; agentId?: string; passed: boolean; command?: string; summary?: string }
    | { type: 'alert'; sessionId?: string; taskId?: string; agentId?: string; kind: AlertKind; severity: AlertSeverity; message: string }
    | { type: 'review.requested'; taskId: string; reviewer: Reviewer }
    | { type: 'review.ready'; taskId: string; reviewer: Reviewer; verdict: 'approve' | 'changes' | 'error'; findings: string }
    | { type: 'session.seen'; sessionId: string; repo: string }
    | { type: 'git.snapshot'; sessionId?: string; repo: string; branch: string; dirty: number; ahead?: number; behind?: number }
  );

export type EventType = ForemanEvent['type'];

let seq = 0;
/** Create a fully-formed event. ts/id are stamped here so emitters stay terse. */
export function makeEvent<T extends ForemanEvent['type']>(
  type: T,
  payload: Omit<Extract<ForemanEvent, { type: T }>, keyof Base | 'type'>,
): ForemanEvent {
  return {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    ts: Date.now(),
    type,
    ...payload,
  } as unknown as ForemanEvent;
}
