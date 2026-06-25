<script lang="ts">
  import { board, ui, isLive, type Card } from './store.svelte.ts';
  import Icon from './Icon.svelte';
  const { card }: { card: Card } = $props();

  const live = $derived(isLive(card));
  const DUMB_ZONE = 0.4;
  const pct = $derived(card.context?.pctUsed ?? 0);
  const inDumbZone = $derived(pct >= DUMB_ZONE);
  const vendorClass = $derived(
    card.vendor === 'claude-code' ? 'claude' : card.vendor === 'codex' ? 'codex' : card.vendor === 'gemini-cli' ? 'gemini' : '',
  );
  const vendorName = (v?: string) => (v === 'claude-code' ? 'Claude' : v === 'codex' ? 'Codex' : v === 'gemini-cli' ? 'Gemini' : '');
  const reviewerShort = (r: string) => vendorName(r) || r;
  const isSub = $derived(!!card.parentId);
  const parentCard = $derived(isSub ? Object.values(board.value.cards).find((c) => c.agentId === card.parentId) : undefined);

  function openDrawer(): void { ui.cardDrawer = card.taskId; }
  function stop(e: Event): void { e.stopPropagation(); }
</script>

<div class="card" class:active={!!card.agentId} class:live class:warnglow={inDumbZone} role="button" tabindex="0" onclick={openDrawer} onkeydown={(e) => e.key === 'Enter' && openDrawer()}>
  <div class="ribbon {vendorClass}" class:sub={isSub} class:live>
    <span class="role">{isSub ? 'SUBAGENT' : 'AGENT'}</span>
    {#if vendorName(card.vendor)}<span class="rb-sep"></span><span class="rb-v">{vendorName(card.vendor)}</span>{/if}
    {#if card.agentType}<span class="rb-sep"></span><span class="rb-t">{card.agentType}</span>{/if}
    {#if isSub && parentCard}<span class="rb-p">↳ {parentCard.title}</span>{/if}
    {#if live}<span class="rb-live" title="working now"><span class="lv-dot"></span>LIVE</span>{:else}<span class="rb-open" title="Open detail"><Icon name="chevron" size={13} /></span>{/if}
  </div>
  <div class="topline">
    <span class="title">{card.title}</span>
  </div>
  {#if card.subtitle}<div class="sub">{card.subtitle}</div>{/if}

  {#if card.agentStatus === 'running' && card.lastTool}
    <div class="step"><Icon name="bolt" size={11} /> {card.lastTool}</div>
  {/if}

  {#if card.subagents?.length}
    <div class="subagents">
      <div class="sa-h"><Icon name="tree" size={11} /> {card.subagents.length} subagent{card.subagents.length > 1 ? 's' : ''}</div>
      {#each card.subagents.slice(-4) as sa}
        <div class="sa"><span class="sa-rail"></span><span class="sa-tag">SUB</span><span class="sa-label">{sa.label}</span></div>
      {/each}
    </div>
  {/if}

  {#if card.agentStatus === 'waiting'}
    <div class="idle"><Icon name="pause" size={12} /> waiting for user{card.agentReason ? ` — ${card.agentReason}` : ''}</div>
  {:else if card.agentStatus === 'idle'}
    <div class="idle"><Icon name="pause" size={12} /> idle</div>
  {/if}

  {#if card.context && (card.agentStatus === 'running')}
    <div class="bar"><i style="width:{Math.round(pct * 100)}%"></i></div>
  {/if}

  {#if card.diff}
    <div class="sub"><span class="ok">+{card.diff.added} −{card.diff.removed}</span> · {card.diff.files} files</div>
  {/if}

  {#if card.test}
    <div class="sub"><span class={card.test.passed ? 'ok' : 'bad'}>{card.test.passed ? 'tests ✓' : 'tests ✗'}</span>{#if card.test.command} · <span class="mono">{card.test.command}</span>{/if}</div>
  {/if}

  {#if card.review}
    <div class="review {card.review.verdict}">
      <Icon name={card.review.verdict === 'approve' ? 'check' : card.review.verdict === 'error' ? 'x' : 'warn'} size={11} />
      {card.review.verdict === 'pending' ? `${reviewerShort(card.review.reviewer)} reviewing…` : `${reviewerShort(card.review.reviewer)}: ${card.review.verdict}`}
    </div>
  {/if}

  <div class="meters">
    {#if card.branch}<span class="meter branch" title={card.dirty ? `${card.dirty} changed files` : 'clean'}>⎇ {card.branch}{card.dirty ? ` ·${card.dirty}` : ''}</span>{/if}
    {#if card.context}
      <span class="meter" class:warn={inDumbZone}>ctx {Math.round(pct * 100)}%{inDumbZone ? ' ⚠' : ''}</span>
      <span class="meter cost">${card.context.costUsd.toFixed(2)}</span>
      <span class="meter">{(card.context.tokensIn / 1000).toFixed(1)}k tok</span>
    {/if}
    {#if card.compacted}<span class="meter">compacted ×{card.compacted.count}</span>{/if}
    {#each card.blockedBy as b}<span class="meter">blockedBy {b}</span>{/each}
  </div>

  {#if card.column === 'review'}
    <div class="card-actions">
      <button class="mini" onclick={(e) => { stop(e); board.selected = card.taskId; }}>View diff</button>
      <button class="mini primary" onclick={(e) => { stop(e); ui.cardDrawer = card.taskId; }}>Open detail</button>
    </div>
  {/if}
</div>

<style>
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px; overflow: hidden; transition: border-color .15s, transform .12s, box-shadow .15s, background .15s; box-shadow: var(--shadow-sm); cursor: pointer; }
  .card:hover { border-color: var(--line-2); background: var(--panel-2); transform: translateY(-2px); box-shadow: var(--shadow-md); }
  .card:focus-visible { outline: none; border-color: var(--accent); }

  /* Agent/subagent ribbon — a full-bleed colored top strip identifying the worker. */
  .ribbon { display: flex; align-items: center; gap: 7px; margin: -12px -12px 10px; padding: 5px 10px; font-family: var(--mono); font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--on-accent); background: var(--accent); }
  .ribbon.claude { background: linear-gradient(90deg, var(--claude), color-mix(in srgb, var(--claude) 70%, #000)); }
  .ribbon.codex { background: linear-gradient(90deg, var(--codex), color-mix(in srgb, var(--codex) 70%, #000)); color: #06281a; }
  .ribbon.gemini { background: linear-gradient(90deg, var(--gemini), color-mix(in srgb, var(--gemini) 70%, #000)); }
  .ribbon.sub { background: repeating-linear-gradient(45deg, var(--charcoal), var(--charcoal) 7px, #2d343c 7px, #2d343c 14px); color: var(--accent); }
  .ribbon .role { font-weight: 800; }
  .ribbon .rb-sep { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .55; }
  .ribbon .rb-v, .ribbon .rb-t { opacity: .92; }
  .ribbon .rb-p { margin-left: 4px; text-transform: none; letter-spacing: 0; font-weight: 600; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ribbon .rb-open { margin-left: auto; transform: rotate(90deg); opacity: .7; }
  /* "Working now" badge — pulsing dot + LIVE, pinned to the right of the ribbon. */
  .ribbon .rb-live { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 9px; font-weight: 800; letter-spacing: .1em; padding: 1px 6px 1px 5px; border-radius: 999px; background: rgba(0,0,0,.22); }
  .ribbon .lv-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 0 currentColor; animation: lvpulse 1.4s infinite; }
  @keyframes lvpulse { 0% { box-shadow: 0 0 0 0 rgba(255,255,255,.6); } 70% { box-shadow: 0 0 0 6px rgba(255,255,255,0); } 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); } }
  .card.active { border-color: var(--accent-dim); box-shadow: inset 0 0 0 1px var(--accent-dim), 0 10px 28px -18px var(--accent); }
  /* A live card glows in its vendor colour and breathes so it stands out at a glance. */
  .card.live { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim), 0 0 30px -10px var(--accent); animation: cardbreathe 2.4s ease-in-out infinite; }
  .card.live:hover { transform: translateY(-2px); }
  @keyframes cardbreathe { 0%, 100% { box-shadow: 0 0 0 1px var(--accent-dim), 0 0 24px -12px var(--accent); } 50% { box-shadow: 0 0 0 1px var(--accent), 0 0 34px -8px var(--accent); } }
  .card.warnglow { border-color: rgba(251,191,36,.4); box-shadow: 0 0 26px -12px var(--warn); }
  .topline { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .title { font-weight: 600; font-size: 13px; line-height: 1.25; }
  .sub { color: var(--txt-dim); font-size: 11.5px; margin-top: 3px; line-height: 1.4; }
  .mono { font-family: var(--mono); font-size: 10.5px; }
  .ok { color: var(--ok); }
  .bad { color: var(--danger); }
  .step { display: flex; align-items: center; gap: 5px; margin-top: 6px; font-family: var(--mono); font-size: 10.5px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Subagents spawned by this card's agent — nested beneath it, Claude-Code style. */
  .subagents { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .sa-h { display: flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--txt-dim); }
  .sa-h :global(.icon) { color: var(--accent); }
  .sa { display: flex; align-items: center; gap: 7px; padding-left: 4px; font-size: 11px; color: var(--txt-dim); overflow: hidden; }
  .sa-rail { width: 11px; height: 9px; flex: 0 0 auto; border-left: 2px solid var(--charcoal); border-bottom: 2px solid var(--charcoal); border-bottom-left-radius: 4px; }
  .sa-tag { font-family: var(--mono); font-size: 8.5px; font-weight: 800; letter-spacing: .08em; color: var(--accent); background: repeating-linear-gradient(45deg, var(--charcoal), var(--charcoal) 5px, #2d343c 5px, #2d343c 10px); padding: 1px 5px; border-radius: 3px; flex: 0 0 auto; }
  .sa-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .review { display: inline-flex; align-items: center; gap: 5px; margin-top: 7px; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: var(--r-sm); border: 1px solid var(--line-2); }
  .review.approve { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .review.changes { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-ghost); }
  .review.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
  .review.pending { color: var(--txt-dim); }
  .meter.branch { color: var(--txt-dim); }
  .idle { display: flex; align-items: center; gap: 5px; color: var(--warn); font-family: var(--mono); font-size: 11px; margin-top: 6px; }
  .bar { height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; margin: 9px 0 4px; }
  .bar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-dim), var(--accent)); }
  .meters { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .meter { font-family: var(--mono); font-size: 10.5px; color: var(--txt-dim); background: var(--panel-2); border: 1px solid var(--line); padding: 2px 6px; border-radius: 5px; }
  .meter.warn { color: var(--warn); border-color: #5a4516; background: #1a1505; }
  .meter.cost { color: var(--txt); }
  .card-actions { display: flex; gap: 6px; margin-top: 10px; }
  .mini { flex: 1; text-align: center; font-size: 11px; padding: 6px; border-radius: 6px; border: 1px solid var(--line-2); background: var(--panel-2); color: var(--txt); cursor: pointer; }
  .mini.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 700; }
</style>
