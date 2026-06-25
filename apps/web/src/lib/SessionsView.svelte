<script lang="ts">
  import { board, ui, type Card } from './store.svelte.ts';

  // Group cards by session to show one row per live/observed session.
  interface SessionRow { sessionId: string; repo: string; cards: Card[]; ctx?: number; cost?: number; status?: string; }
  const rows = $derived.by<SessionRow[]>(() => {
    const map = new Map<string, SessionRow>();
    for (const c of Object.values(board.value.cards)) {
      let r = map.get(c.sessionId);
      if (!r) { r = { sessionId: c.sessionId, repo: c.repo, cards: [] }; map.set(c.sessionId, r); }
      r.cards.push(c);
      if (c.context) { r.ctx = Math.max(r.ctx ?? 0, c.context.pctUsed); r.cost = (r.cost ?? 0) + c.context.costUsd; }
      if (c.agentStatus) r.status = c.agentStatus;
    }
    return [...map.values()].sort((a, b) => b.cards.length - a.cards.length);
  });
</script>

<div class="wrap">
  {#if !rows.length}
    <div class="empty">No sessions observed yet. They appear as Claude Code runs in your repos.</div>
  {:else}
    <div class="hint">Click a session for its transcript, context/cost timeline, tools, and chat (resume · Q&amp;A · new run).</div>
    <div class="list">
      {#each rows as r}
        <button class="row" onclick={() => (ui.sessionDetail = r.sessionId)}>
          <div class="dot {r.status ?? ''}"></div>
          <div class="repo">{r.repo}</div>
          <div class="sid">{r.sessionId.slice(0, 8)}</div>
          <div class="tasks">{r.cards.length} task{r.cards.length === 1 ? '' : 's'}</div>
          <div class="meters">
            {#if r.ctx !== undefined}<span class="m">ctx {Math.round(r.ctx * 100)}%</span>{/if}
            {#if r.cost}<span class="m cost">${r.cost.toFixed(2)}</span>{/if}
            {#if r.status}<span class="m st {r.status}">{r.status}</span>{/if}
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap { flex: 1; overflow: auto; padding: 18px 20px; min-height: 0; }
  .empty { color: var(--txt-faint); text-align: center; padding: 40px 0; }
  .hint { color: var(--txt-faint); font-size: 12px; margin-bottom: 14px; border-left: 2px solid var(--accent-dim); padding-left: 10px; }
  .list { display: flex; flex-direction: column; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .row { display: grid; grid-template-columns: 16px 1fr 90px 90px auto; align-items: center; gap: 12px; padding: 12px 16px; background: var(--panel); border: none; width: 100%; text-align: left; cursor: pointer; color: inherit; font: inherit; }
  .row:hover { background: var(--panel-2); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--txt-faint); }
  .dot.running { background: var(--accent); box-shadow: 0 0 8px -1px var(--accent); }
  .dot.waiting { background: var(--warn); }
  .dot.error { background: var(--danger); }
  .repo { font-weight: 600; font-size: 13px; }
  .sid, .tasks { font-family: var(--mono); font-size: 11.5px; color: var(--txt-dim); }
  .meters { display: flex; gap: 6px; }
  .m { font-family: var(--mono); font-size: 10.5px; color: var(--txt-dim); background: var(--panel-2); border: 1px solid var(--line); padding: 2px 7px; border-radius: 5px; }
  .m.cost { color: var(--txt); }
  .m.st.running { color: var(--accent); }
  .m.st.waiting { color: var(--warn); }
</style>
