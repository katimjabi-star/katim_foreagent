<script lang="ts">
  import { onMount } from 'svelte';
  import { board, mode, ui, connect, setBoardMode, waitingCards, type View } from './lib/store.svelte.ts';
  import BoardView from './lib/BoardView.svelte';
  import ProjectView from './lib/ProjectView.svelte';
  import SessionsView from './lib/SessionsView.svelte';
  import SessionDetail from './lib/SessionDetail.svelte';
  import MarketView from './lib/MarketView.svelte';
  import Icon from './lib/Icon.svelte';
  import Button from './lib/Button.svelte';
  import AttentionRail from './lib/AttentionRail.svelte';
  import CardDrawer from './lib/CardDrawer.svelte';
  import TaskIntake from './lib/TaskIntake.svelte';

  onMount(connect);

  const NAV: { id: View; label: string; icon: string }[] = [
    { id: 'board', label: 'Board', icon: 'board' },
    { id: 'project', label: 'Project', icon: 'project' },
    { id: 'sessions', label: 'Sessions', icon: 'sessions' },
    { id: 'market', label: 'Marketplace', icon: 'market' },
  ];
  const TITLES: Record<View, string> = { board: 'Agent Board', project: 'Project Overview', sessions: 'Sessions', market: 'Marketplace' };

  const totals = $derived(board.value.totals);
  const waiting = $derived(waitingCards());

  // ---- New-task intake (global control action) ----
  let showSpawn = $state(false);
</script>

<div class="shell">
  <nav class="rail">
    <div class="brand">FOREAGENT</div>
    <div class="nav">
      {#each NAV as item}
        <button class="navitem" class:active={ui.view === item.id} onclick={() => (ui.view = item.id)}>
          <span class="g"><Icon name={item.icon} size={17} /></span>{item.label}
          {#if item.id === 'sessions' && waiting.length}<span class="badge">{waiting.length}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="rail-foot">
      <div class="live" class:off={!board.connected}><span class="dot"></span>{board.connected ? 'live' : 'offline'}</div>
      <div class="ver">observe→control · v0.1</div>
    </div>
  </nav>

  <div class="main">
    <header>
      <div class="title"><span class="tick"></span>{TITLES[ui.view]}</div>
      <div class="spacer"></div>
      <div class="mode" title={mode.value === 'live' ? 'Showing actual Claude/Codex/Gemini sessions' : 'Showing the in-memory demo board'}>
        <button class:active={mode.value === 'live'} disabled={mode.switching} onclick={() => setBoardMode('live')}>Live</button>
        <button class:active={mode.value === 'demo'} disabled={mode.switching} onclick={() => setBoardMode('demo')}>Demo</button>
      </div>
      <div class="stat"><b>{totals.agents}</b> agents<span class="sep"></span>session <b>${totals.costUsd.toFixed(2)}</b><span class="sep"></span>ctx <b>{Math.round(totals.pctUsed * 100)}%</b></div>
      <AttentionRail />
      <Button onclick={() => (showSpawn = true)}>New task</Button>
    </header>

    {#if ui.view === 'board'}<BoardView />
    {:else if ui.view === 'project'}<ProjectView />
    {:else if ui.view === 'sessions'}
      {#if ui.sessionDetail}<SessionDetail sessionId={ui.sessionDetail} />{:else}<SessionsView />{/if}
    {:else}<MarketView />{/if}
  </div>
</div>

<CardDrawer />

{#if showSpawn}<TaskIntake onclose={() => (showSpawn = false)} />{/if}

<style>
  .shell { flex: 1; display: flex; min-height: 0; }

  /* Left rail — the commercial dashboard nav, frosted glass over the canvas. */
  .rail { flex: 0 0 212px; background: linear-gradient(180deg, rgba(54,61,69,.5), rgba(54,61,69,.18)); backdrop-filter: blur(10px); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 22px 14px; }
  /* Wordmark with the KATIM orange "macron" — short dash over the trailing letters. */
  .brand { position: relative; font-weight: 800; letter-spacing: .04em; font-size: 19px; text-transform: uppercase; line-height: 1; align-self: flex-start; margin: 2px 4px 30px; padding-top: 9px; }
  .brand::before { content: ''; position: absolute; top: 0; right: 0; width: 22px; height: 4px; background: var(--accent); }
  .nav { display: flex; flex-direction: column; gap: 2px; }
  .navitem { display: flex; align-items: center; gap: 11px; padding: 10px 12px; border-radius: var(--r-sm); border: 1px solid transparent; background: transparent; color: var(--txt-dim); font-size: 13px; font-weight: 500; cursor: pointer; text-align: left; position: relative; transition: background .14s, color .14s, border-color .14s; }
  .navitem:hover { color: var(--txt); background: var(--panel); }
  .navitem.active { color: var(--txt); background: var(--panel-2); border-color: var(--line-2); }
  .navitem.active::before { content: ''; position: absolute; left: -14px; top: 50%; transform: translateY(-50%); width: 3px; height: 20px; background: var(--accent); }
  .navitem.active .g { color: var(--accent); }
  .navitem:hover .g { color: var(--accent); }
  .navitem .g { display: grid; place-items: center; width: 18px; color: var(--txt-faint); transition: color .14s; }
  .badge { margin-left: auto; background: var(--warn); color: #1a1505; font-size: 10px; font-weight: 700; border-radius: 9px; padding: 1px 6px; }
  .rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 7px; padding: 0 4px; }
  .live { display: flex; align-items: center; gap: 7px; color: var(--ok); font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; }
  .live.off { color: var(--txt-faint); }
  .live.off .dot { background: var(--txt-faint); animation: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(86,190,128,.5); } 70% { box-shadow: 0 0 0 7px rgba(86,190,128,0); } 100% { box-shadow: 0 0 0 0 rgba(86,190,128,0); } }
  .ver { font-family: var(--mono); font-size: 9.5px; color: var(--txt-faint); letter-spacing: .04em; }

  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  header { display: flex; align-items: center; gap: 14px; padding: 0 20px; height: 58px; flex: 0 0 58px; background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015)); backdrop-filter: blur(16px) saturate(140%); border-bottom: 1px solid var(--line); }
  .title { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; letter-spacing: .005em; }
  .title .tick { width: 18px; height: 3px; background: var(--accent); flex: 0 0 auto; }
  .spacer { flex: 1; }
  .mode { display: inline-flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--line); background: rgba(255,255,255,.035); border-radius: 999px; }
  .mode button { border: 0; background: transparent; color: var(--txt-faint); border-radius: 999px; padding: 5px 10px; font-family: var(--mono); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; cursor: pointer; transition: background .14s, color .14s; }
  .mode button:hover:not(:disabled) { color: var(--txt); background: rgba(255,255,255,.06); }
  .mode button.active { color: #1a1505; background: var(--accent); }
  .mode button:disabled { opacity: .6; cursor: wait; }
  .stat { display: flex; align-items: center; font-family: var(--mono); font-size: 12px; color: var(--txt-dim); }
  .stat b { color: var(--txt); font-weight: 600; }
  .stat .sep { display: inline-block; width: 3px; height: 3px; border-radius: 50%; background: var(--line-2); margin: 0 10px; }
</style>
