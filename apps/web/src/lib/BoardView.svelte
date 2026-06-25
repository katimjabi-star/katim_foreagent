<script lang="ts">
  import { board, repos, reviewCard, requestReview, fetchReviewers, clearDone, restoreCleared, isCleared, type Column, type Card as CardT, type Reviewer } from './store.svelte.ts';
  import Card from './Card.svelte';
  import Icon from './Icon.svelte';

  let reviewers = $state<Reviewer[]>(['claude-code']);
  let reviewer = $state<Reviewer>('claude-code');
  const reviewerName = (r: string) => (r === 'claude-code' ? 'Claude' : r === 'codex' ? 'Codex' : r === 'gemini-cli' ? 'Gemini' : r);
  $effect(() => { fetchReviewers().then((rs) => { if (rs.length) { reviewers = rs; if (!rs.includes(reviewer)) reviewer = rs[0]!; } }); });

  const COLUMNS: { id: Column; label: string }[] = [
    { id: 'aligning', label: 'Aligning' },
    { id: 'specd', label: "Spec'd" },
    { id: 'sliced', label: 'Sliced' },
    { id: 'building', label: 'Building' },
    { id: 'review', label: 'In Review' },
    { id: 'done', label: 'Done' },
  ];

  const repoList = $derived(repos());

  function matches(card: CardT, q: string): boolean {
    if (!q) return true;
    const hay = `${card.title} ${card.repo} ${card.subtitle ?? ''}`.toLowerCase();
    let i = 0;
    for (const ch of q.toLowerCase()) { i = hay.indexOf(ch, i); if (i === -1) return false; i++; }
    return true;
  }
  function visible(col: Column): CardT[] {
    return board.value.columns[col].filter(
      (c) => (!board.repoFilter || c.repo === board.repoFilter) && matches(c, board.query) && !isCleared(c.taskId),
    );
  }
  const clearedCount = $derived(board.cleared.length);

  const reviewCards = $derived(board.value.columns.review.filter((c) => !board.repoFilter || c.repo === board.repoFilter));
  const selectedCard = $derived(board.selected ? board.value.cards[board.selected] : undefined);

  function fmtTime(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
  const stream = $derived([...board.activity].reverse().slice(0, 60));
</script>

<div class="toolbar">
  <select class="repo" bind:value={board.repoFilter} aria-label="Filter by repository">
    <option value="">all repos ({repoList.length})</option>
    {#each repoList as r}<option value={r}>{r}</option>{/each}
  </select>
  <input class="search" type="search" placeholder="search cards…" bind:value={board.query} aria-label="Search cards" />
</div>

<section class="boardgrid">
  {#each COLUMNS as col}
    {@const cards = visible(col.id)}
    <div class="col">
      <div class="col-h">
        <span class="col-name">{col.label} <span class="count">{String(cards.length).padStart(2, '0')}</span></span>
        {#if col.id === 'done'}
          {#if cards.length}<button class="col-clear" onclick={clearDone} title="Hide completed cards">Clear</button>
          {:else if clearedCount}<button class="col-clear restore" onclick={restoreCleared} title="Show cleared cards again">Restore {clearedCount}</button>{/if}
        {/if}
      </div>
      <div class="col-body">
        {#each cards as card (card.taskId)}
          <Card {card} />
        {/each}
      </div>
    </div>
  {/each}
</section>

<section class="dock">
  <div class="pane">
    <div class="pane-h"><span class="ph-l"><Icon name="activity" size={13} /> Agent Stream</span> <span class="dim">{stream.length ? `${board.activity.length} events` : ''}</span></div>
    <div class="pane-body log">
      {#if stream.length}
        {#each stream as a}
          <div class="row {a.kind}"><span class="t">{fmtTime(a.ts)}</span> <span class="k">{a.kind}</span> {a.text}</div>
        {/each}
      {:else}
        <div class="dim">waiting for activity…</div>
      {/if}
    </div>
  </div>
  <div class="pane">
    <div class="pane-h"><span class="ph-l"><Icon name="check" size={13} /> Review gate</span> {#if reviewCards.length}<span class="dim">{reviewCards.length} pending</span>{/if}</div>
    <div class="pane-body">
      {#if selectedCard && selectedCard.column === 'review'}
        <div class="rv-title">{selectedCard.title}</div>
        <div class="dim">{selectedCard.repo}{selectedCard.worktree ? ` · ${selectedCard.worktree}` : ''}</div>
        {#if selectedCard.diff}
          <div class="rv-diff"><span class="ok">+{selectedCard.diff.added}</span> <span class="rm">−{selectedCard.diff.removed}</span> · {selectedCard.diff.files} files{#if selectedCard.diff.testsGreen} · <span class="ok">tests ✓</span>{/if}</div>
        {:else}
          <div class="dim">No diff captured yet for this card.</div>
        {/if}

        <div class="rv-ai">
          <span class="rv-l">Cross-model review</span>
          <select bind:value={reviewer} title="Reviewer model — a different model than the author catches more">
            {#each reviewers as r}<option value={r}>{reviewerName(r)}</option>{/each}
          </select>
          <button class="mini" disabled={selectedCard.review?.verdict === 'pending'} onclick={() => requestReview(selectedCard!.taskId, reviewer)}>
            {selectedCard.review?.verdict === 'pending' ? 'Reviewing…' : 'Run review'}
          </button>
        </div>
        {#if selectedCard.review && selectedCard.review.verdict !== 'pending'}
          <div class="rv-findings {selectedCard.review.verdict}">
            <div class="rvf-h"><b>{reviewerName(selectedCard.review.reviewer)}</b> · {selectedCard.review.verdict}</div>
            <div class="rvf-body">{selectedCard.review.findings}</div>
          </div>
        {/if}

        <div class="rv-actions">
          <button class="mini primary" onclick={() => { reviewCard(selectedCard!.taskId, true); board.selected = undefined; }}>Approve &amp; merge</button>
          <button class="mini" onclick={() => { reviewCard(selectedCard!.taskId, false); board.selected = undefined; }}>Reject &amp; send back ↩</button>
        </div>
      {:else if reviewCards.length}
        <div class="dim">Select a card in <b>In Review</b> to inspect its diff:</div>
        {#each reviewCards as c}
          <button class="rv-pick" onclick={() => (board.selected = c.taskId)}>{c.title}</button>
        {/each}
      {:else}
        <div class="dim">Nothing in review. Cards land here when an agent reports a diff.</div>
      {/if}
    </div>
  </div>
</section>

<style>
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .repo, .search { background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); font-family: var(--mono); font-size: 12px; padding: 6px 10px; border-radius: 6px; }
  .repo { max-width: 200px; }
  .search { width: 200px; }
  .search:focus, .repo:focus { outline: none; border-color: var(--accent-dim); }

  .boardgrid { flex: 1; display: grid; grid-template-columns: repeat(6, 1fr); grid-template-rows: minmax(0, 1fr); gap: 1px; background: var(--line); overflow: hidden; min-height: 0; }
  .col { background: var(--bg); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .col-h { display: flex; align-items: center; justify-content: space-between; padding: 11px 13px; border-bottom: 1px solid var(--line); text-transform: uppercase; letter-spacing: .18em; font-size: 10.5px; font-weight: 700; color: var(--txt-dim); }
  .col-h .count { font-family: var(--mono); color: var(--txt-faint); font-weight: 500; }
  .col-clear { font-family: var(--ui); font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: var(--txt-faint); background: transparent; border: 1px solid var(--line-2); border-radius: var(--r-sm); padding: 3px 8px; cursor: pointer; transition: color .14s, border-color .14s; }
  .col-clear:hover { color: var(--accent); border-color: var(--accent-dim); }
  .col-clear.restore { color: var(--accent); border-color: var(--accent-dim); }
  .col-body { flex: 1; min-height: 0; padding: 11px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }

  /* Fixed-height dock with bulletproof internal scroll. The pane is a positioning
     context; its header and body are absolutely positioned to fill it, so the body
     has a DEFINITE height (bottom:0 of a fixed-height pane) and always scrolls — it
     can never grow the pane, regardless of how much log/review content piles up.
     This sidesteps the flex/grid min-height:auto pitfall entirely. */
  .dock { flex: 0 0 220px; height: 220px; display: grid; grid-template-columns: 1.4fr 1fr; grid-template-rows: 220px; gap: 1px; background: var(--line); border-top: 1px solid var(--line); }
  .pane { position: relative; background: var(--panel); min-width: 0; overflow: hidden; }
  .pane-h { position: absolute; inset: 0 0 auto 0; z-index: 1; box-sizing: border-box; height: 37px; padding: 9px 13px; border-bottom: 1px solid var(--line); background: var(--panel); font-size: 11px; text-transform: uppercase; letter-spacing: .14em; color: var(--txt-dim); font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
  .ph-l { display: flex; align-items: center; gap: 7px; }
  .ph-l :global(.icon) { color: var(--accent); }
  .pane-body { position: absolute; inset: 37px 0 0 0; overflow-y: auto; overflow-x: hidden; padding: 10px 13px; font-family: var(--mono); font-size: 11.5px; line-height: 1.7; }
  /* Make the dock scrollbar unmistakably visible (overrides the global subtle one). */
  .pane-body::-webkit-scrollbar { width: 10px; }
  .pane-body::-webkit-scrollbar-thumb { box-shadow: inset 0 0 0 10px var(--line-2); border: 2px solid transparent; border-radius: 8px; background-clip: padding-box; }
  .pane-body:hover::-webkit-scrollbar-thumb { box-shadow: inset 0 0 0 10px var(--txt-faint); }
  .log .row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--txt-dim); }
  .log .t { color: var(--txt-faint); }
  .log .k { display: inline-block; min-width: 52px; text-transform: uppercase; font-size: 9.5px; letter-spacing: .08em; }
  .log .row.tool .k { color: var(--accent); }
  .log .row.status .k { color: var(--warn); }
  .log .row.diff .k { color: var(--ok); }
  .log .row.message .k { color: var(--txt-faint); }
  .dim { color: var(--txt-faint); }
  .ok { color: var(--ok); }
  .rm { color: #d4756b; }
  .rv-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .rv-diff { margin: 8px 0; }
  .rv-ai { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .rv-ai .rv-l { font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--txt-faint); font-weight: 700; }
  .rv-ai select { margin-left: auto; background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); font-size: 11px; padding: 4px 7px; border-radius: var(--r-sm); }
  .rv-findings { margin-top: 8px; border: 1px solid var(--line-2); border-radius: var(--r-sm); padding: 8px 10px; max-height: 130px; overflow: auto; }
  .rv-findings.approve { border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .rv-findings.changes { border-color: var(--accent-dim); }
  .rv-findings.error { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
  .rvf-h { font-size: 11px; margin-bottom: 5px; text-transform: uppercase; letter-spacing: .06em; color: var(--txt-dim); }
  .rvf-body { font-size: 11.5px; line-height: 1.5; color: var(--txt); white-space: pre-wrap; font-family: var(--mono); }
  .rv-actions { display: flex; gap: 6px; margin-top: 10px; }
  .rv-pick { display: block; width: 100%; text-align: left; margin-top: 6px; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line-2); background: var(--panel-2); color: var(--txt); cursor: pointer; font-family: var(--mono); font-size: 11px; }
  .rv-pick:hover { border-color: var(--accent-dim); }
  .mini { flex: 1; text-align: center; font-size: 11px; padding: 6px; border-radius: 6px; border: 1px solid var(--line-2); background: var(--panel-2); color: var(--txt); cursor: pointer; }
  .mini.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 700; }
</style>
