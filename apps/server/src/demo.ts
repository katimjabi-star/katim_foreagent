import { makeEvent, type EventLog, type Column } from '@foreman/core';

/**
 * Sprint 0 liveness: synthesises a realistic stream so the board is alive before
 * the real filesystem watchers (Sprint 1) exist. Gated by FOREMAN_DEMO=1 — it must
 * never run against real Claude data. Mirrors the brand mockup's scenario.
 */
export function startDemo(log: EventLog): void {
  const repo = 'acme/api';
  const seed: Array<{ id: string; title: string; col: Column; sub?: string }> = [
    { id: 't-auth', title: 'Auth provider revamp', col: 'aligning', sub: 'grill-me · 16 questions' },
    { id: 't-rate', title: 'Rate limiting', col: 'specd', sub: 'PRD → issue #214' },
    { id: 't-jwt', title: 'JWT middleware', col: 'sliced', sub: 'slice 2/4 · tracer-bullet' },
    { id: 't-oauth', title: 'OAuth + PKCE flow', col: 'building', sub: 'worktree wt/oauth' },
    { id: 't-audit', title: 'Audit log schema', col: 'building', sub: 'worktree wt/audit' },
    { id: 't-hook', title: 'Webhook verification', col: 'review', sub: '+142 −30 · tests green' },
    { id: 't-mig', title: 'DB migration runner', col: 'done', sub: 'merged → PR #208' },
  ];

  for (const s of seed) {
    log.append(makeEvent('task.created', { taskId: s.id, sessionId: 'demo', repo, title: s.title, column: s.col }));
    if (s.sub) log.append(makeEvent('task.updated', { taskId: s.id, subtitle: s.sub }));
  }
  log.append(makeEvent('agent.spawned', { agentId: 'a-oauth', taskId: 't-oauth', vendor: 'claude-code', worktree: 'wt/oauth' }));
  log.append(makeEvent('agent.spawned', { agentId: 'a-audit', taskId: 't-audit', vendor: 'gemini-cli', worktree: 'wt/audit' }));
  log.append(makeEvent('agent.spawned', { agentId: 'a-hook', taskId: 't-hook', vendor: 'codex' }));
  log.append(makeEvent('agent.status', { agentId: 'a-audit', status: 'waiting', reason: 'permission' }));
  log.append(makeEvent('diff.ready', { taskId: 't-hook', agentId: 'a-hook', files: 3, added: 142, removed: 30, testsGreen: true }));

  // A climbing context meter on the OAuth agent — walks into the dumb zone live.
  let pct = 0.18;
  let cost = 0.4;
  setInterval(() => {
    pct = Math.min(0.92, pct + Math.random() * 0.04);
    cost += Math.random() * 0.15;
    log.append(makeEvent('context.snapshot', {
      sessionId: 'demo', agentId: 'a-oauth', taskId: 't-oauth',
      snapshot: { pctUsed: Number(pct.toFixed(3)), tokensIn: Math.round(pct * 200000), tokensOut: 4200, cacheRead: 18000, costUsd: Number(cost.toFixed(2)), model: 'claude-opus-4-8' },
    }));
    const tools = ['Edit src/auth/oauth.ts', 'Bash npm test', 'Read src/auth/callback.ts', 'Edit src/auth/pkce.ts'];
    log.append(makeEvent('tool.used', { agentId: 'a-oauth', taskId: 't-oauth', tool: 'ToolUse', detail: tools[Math.floor(Math.random() * tools.length)] }));
    if (pct >= 0.9) pct = 0.18; // loop the demo
  }, 2500);
}
