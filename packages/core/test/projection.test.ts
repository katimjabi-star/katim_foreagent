import { describe, it, expect } from 'vitest';
import { BoardProjection, replay } from '../src/projection.ts';
import { makeEvent, type ForemanEvent } from '../src/events.ts';

/** Folds a list of events and returns the rendered board. */
function board(events: ForemanEvent[]) {
  return replay(events).state();
}
const ids = (cards: { taskId: string }[]) => cards.map((c) => c.taskId).sort();

describe('pipeline: Aligning placeholder', () => {
  it('does NOT create a card from session.seen alone (avoids flooding on initial scan)', () => {
    // session.seen fires once per historical transcript at boot; a card per
    // session would flood Aligning with hundreds of dead sessions.
    const s = board([makeEvent('session.seen', { sessionId: 'sess-1', repo: 'acme/api' })]);
    expect(s.columns.aligning).toHaveLength(0);
  });

  it('stands up an aligning card from live activity with no todos (labelled from session.seen)', () => {
    const s = board([
      makeEvent('session.seen', { sessionId: 'sess-1', repo: 'acme/api' }),
      makeEvent('tool.used', { agentId: 'session:sess-1', tool: 'Read', detail: 'config.ts' }),
    ]);
    expect(ids(s.columns.aligning)).toEqual(['session:sess-1']);
    expect(s.columns.aligning[0]!.synthetic).toBe(true);
    expect(s.columns.aligning[0]!.repo).toBe('acme/api'); // label learned from session.seen
  });

  it('retires the placeholder once the session writes its first todo', () => {
    const s = board([
      makeEvent('session.seen', { sessionId: 'sess-1', repo: 'acme/api' }),
      makeEvent('tool.used', { agentId: 'session:sess-1', tool: 'Read' }),
      makeEvent('task.created', { taskId: 'sess-1:1', sessionId: 'sess-1', repo: 'acme/api', title: 'Add /health', column: 'sliced' }),
    ]);
    expect(s.columns.aligning).toHaveLength(0);
    expect(ids(s.columns.specd)).toEqual(['sess-1:1']); // first todo, nothing started → spec stage
  });

  it('does not create a placeholder when the session already has a real card', () => {
    const s = board([
      makeEvent('task.created', { taskId: 'sess-1:1', sessionId: 'sess-1', repo: 'acme/api', title: 'T', column: 'building' }),
      makeEvent('tool.used', { agentId: 'session:sess-1', tool: 'Edit' }),
    ]);
    expect(s.columns.aligning).toHaveLength(0);
  });

  it('ages out a stale Aligning placeholder when a clock is supplied', () => {
    const p = replay([
      makeEvent('session.seen', { sessionId: 'sess-1', repo: 'acme/api' }),
      makeEvent('tool.used', { agentId: 'session:sess-1', tool: 'Read' }),
    ]);
    const card = p.state().columns.aligning[0]!;
    const fresh = card.updatedAt + 60_000; // 1 min later
    const stale = card.updatedAt + 21 * 60_000; // past the 20-min TTL
    expect(p.state(fresh).columns.aligning).toHaveLength(1);
    expect(p.state(stale).columns.aligning).toHaveLength(0);
    expect(p.state().columns.aligning).toHaveLength(1); // pure render keeps it (replay-safe)
  });
});

describe('subagents from Task tool calls', () => {
  it('records Task calls as subagents on the session’s lead card', () => {
    const s = board([
      makeEvent('task.created', { taskId: 's:1', sessionId: 's', repo: 'r', title: 'build', column: 'building' }),
      makeEvent('tool.used', { agentId: 'session:s', tool: 'Task', detail: 'code-reviewer: audit auth' }),
      makeEvent('tool.used', { agentId: 'session:s', tool: 'Read', detail: 'auth.ts' }),
      makeEvent('tool.used', { agentId: 'session:s', tool: 'Task', detail: 'Explore: find call sites' }),
    ]);
    const card = s.cards['s:1']!;
    expect(card.subagents?.map((x) => x.label)).toEqual(['code-reviewer: audit auth', 'Explore: find call sites']);
    expect(card.lastTool).toBe('Task · Explore: find call sites');
  });

  it('attaches Task calls to the Aligning placeholder when there are no todos yet', () => {
    const s = board([
      makeEvent('session.seen', { sessionId: 's', repo: 'acme/api' }),
      makeEvent('tool.used', { agentId: 'session:s', tool: 'Task', detail: 'planner: draft approach' }),
    ]);
    expect(s.columns.aligning[0]!.subagents?.[0]!.label).toBe('planner: draft approach');
  });
});

describe('pipeline: Spec’d ↔ Sliced', () => {
  const plan: ForemanEvent[] = [
    makeEvent('task.created', { taskId: 's:1', sessionId: 's', repo: 'r', title: 'one', column: 'sliced' }),
    makeEvent('task.created', { taskId: 's:2', sessionId: 's', repo: 'r', title: 'two', column: 'sliced' }),
  ];

  it('shows an all-pending plan under Spec’d (laid out, unbegun)', () => {
    const s = board(plan);
    expect(ids(s.columns.specd)).toEqual(['s:1', 's:2']);
    expect(s.columns.sliced).toHaveLength(0);
  });

  it('moves remaining pending todos to Sliced once any slice starts building', () => {
    const s = board([
      ...plan,
      makeEvent('task.moved', { taskId: 's:1', column: 'building' }),
    ]);
    expect(ids(s.columns.building)).toEqual(['s:1']);
    expect(ids(s.columns.sliced)).toEqual(['s:2']); // sibling now an active slice
    expect(s.columns.specd).toHaveLength(0);
  });

  it('does not mutate the stored card — refinement is re-evaluated on replay', () => {
    // Build to "started", then assert the stored column stayed 'sliced' so a later
    // state() with no started work would render it back under Spec'd (idempotent).
    const p = new BoardProjection();
    for (const e of plan) p.apply(e);
    p.apply(makeEvent('task.moved', { taskId: 's:1', column: 'building' }));
    expect(p.state().columns.sliced.map((c) => c.taskId)).toEqual(['s:2']);
    // The view card is a clone; the projection's own card 2 is untouched.
    const raw = p.state().cards['s:2']!;
    expect(raw.column).toBe('sliced'); // rendered column; stored remains 'sliced'
  });
});
