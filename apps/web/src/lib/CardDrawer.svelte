<script lang="ts">
  import { ui, cardById, fetchSession, type SessionDetail } from './store.svelte.ts';
  import Icon from './Icon.svelte';

  // Live card (reflects board updates) + the session activity behind it.
  const card = $derived(cardById(ui.cardDrawer));
  let detail = $state<SessionDetail | null>(null);
  let loading = $state(false);
  let loadedFor = $state<string | undefined>(undefined);

  $effect(() => {
    const sid = card?.sessionId;
    if (!sid || sid === loadedFor) return;
    loading = true; loadedFor = sid;
    fetchSession(sid).then((d) => { if (card?.sessionId === sid) { detail = d; loading = false; } });
  });

  const vendorName = (v?: string) => (v === 'claude-code' ? 'Claude' : v === 'codex' ? 'Codex' : v === 'gemini-cli' ? 'Gemini' : '');
  const isSub = $derived(!!card?.parentId);
  const vendorClass = $derived(card?.vendor === 'claude-code' ? 'claude' : card?.vendor === 'codex' ? 'codex' : card?.vendor === 'gemini-cli' ? 'gemini' : '');
  const subagents = $derived((detail?.tools ?? []).filter((t) => /^Task$/i.test(t.name)));
  const recentTools = $derived((detail?.tools ?? []).slice(-16).reverse());
  const recentMsgs = $derived((detail?.messages ?? []).slice(-12));

  function close(): void { ui.cardDrawer = undefined; }
  function openFullSession(): void { if (card) { ui.sessionDetail = card.sessionId; ui.view = 'sessions'; close(); } }
  function fmt(ts?: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
</script>

{#if card}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-label="Card detail">
    <div class="ribbon {vendorClass}" class:sub={isSub}>
      <span class="role">{isSub ? 'SUBAGENT' : 'AGENT'}</span>
      {#if vendorName(card.vendor)}<span class="dot"></span><span>{vendorName(card.vendor)}</span>{/if}
      {#if card.agentType}<span class="dot"></span><span>{card.agentType}</span>{/if}
      <button class="x" onclick={close} aria-label="Close"><Icon name="x" size={15} /></button>
    </div>

    <div class="body">
      <h2 class="title">{card.title}</h2>
      <div class="meta">
        <span class="col">{card.column}</span>
        {#if card.agentStatus}<span class="status {card.agentStatus}">{card.agentStatus}</span>{/if}
        <span class="repo">{card.repo}</span>
        {#if card.branch}<span class="branch">⎇ {card.branch}{card.dirty ? ` ·${card.dirty}` : ''}</span>{/if}
      </div>

      {#if card.agentReason}<div class="reason"><Icon name="pause" size={12} /> {card.agentReason}</div>{/if}

      <!-- What it's doing right now -->
      {#if card.lastTool}
        <div class="now"><span class="now-l">Current step</span><span class="now-v"><Icon name="bolt" size={12} /> {card.lastTool}</span></div>
      {/if}

      <!-- Meters -->
      {#if card.context}
        <div class="meters">
          <div class="m"><span class="mk">context</span><span class="mv" class:warn={card.context.pctUsed >= 0.4}>{Math.round(card.context.pctUsed * 100)}%</span></div>
          <div class="m"><span class="mk">cost</span><span class="mv">${card.context.costUsd.toFixed(3)}</span></div>
          <div class="m"><span class="mk">tokens in</span><span class="mv">{(card.context.tokensIn / 1000).toFixed(1)}k</span></div>
          <div class="m"><span class="mk">model</span><span class="mv sm">{card.context.model}</span></div>
        </div>
      {/if}

      <!-- Outcome: diff / test / review -->
      {#if card.diff || card.test || card.review}
        <section>
          <div class="s-h"><span class="rule"></span> Output</div>
          {#if card.diff}<div class="line"><span class="ok">+{card.diff.added} −{card.diff.removed}</span> · {card.diff.files} files</div>{/if}
          {#if card.test}<div class="line"><span class={card.test.passed ? 'ok' : 'bad'}>{card.test.passed ? 'tests ✓' : 'tests ✗'}</span>{#if card.test.command} · {card.test.command}{/if}{#if card.test.summary} · {card.test.summary}{/if}</div>{/if}
          {#if card.review}<div class="line review {card.review.verdict}">{vendorName(card.review.reviewer)} review: <b>{card.review.verdict}</b>{#if card.review.findings && card.review.verdict !== 'pending'}<div class="findings">{card.review.findings}</div>{/if}</div>{/if}
        </section>
      {/if}

      <!-- Subagents spawned -->
      {#if subagents.length}
        <section>
          <div class="s-h"><span class="rule"></span> Subagents <span class="dim">{subagents.length}</span></div>
          {#each subagents as s}<div class="sub-node"><span class="sn-rail"></span>{s.detail ?? 'subagent task'}</div>{/each}
        </section>
      {/if}

      <!-- Live activity -->
      <section>
        <div class="s-h"><span class="rule"></span> What it's doing {#if loading}<span class="dim">loading…</span>{/if}</div>
        {#if recentTools.length}
          <div class="tools">
            {#each recentTools as t}<div class="tool"><span class="tn">{t.name}</span>{#if t.detail}<span class="td">{t.detail}</span>{/if}<span class="tt">{fmt(t.ts)}</span></div>{/each}
          </div>
        {:else if !loading}
          <div class="dim">No tool activity captured for this session.</div>
        {/if}
      </section>

      <!-- Recent transcript -->
      {#if recentMsgs.length}
        <section>
          <div class="s-h"><span class="rule"></span> Recent messages</div>
          <div class="msgs">
            {#each recentMsgs as m}
              <div class="msg {m.role}"><span class="role-tag">{m.role}</span><span class="mtext">{m.text}</span></div>
            {/each}
          </div>
        </section>
      {/if}

      <button class="full" onclick={openFullSession}>Open full session <Icon name="arrow" size={13} /></button>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 70; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 440px; max-width: 92vw; z-index: 71; background: rgba(16,19,24,.97); backdrop-filter: blur(18px); border-left: 1px solid var(--line-2); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; animation: slide .18s ease; }
  @keyframes slide { from { transform: translateX(28px); opacity: .4; } to { transform: translateX(0); opacity: 1; } }

  .ribbon { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 9px 14px; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--on-accent); background: var(--accent); }
  .ribbon.claude { background: linear-gradient(90deg, var(--claude), color-mix(in srgb, var(--claude) 65%, #000)); }
  .ribbon.codex { background: linear-gradient(90deg, var(--codex), color-mix(in srgb, var(--codex) 65%, #000)); color: #06281a; }
  .ribbon.gemini { background: linear-gradient(90deg, var(--gemini), color-mix(in srgb, var(--gemini) 65%, #000)); }
  .ribbon.sub { background: repeating-linear-gradient(45deg, var(--charcoal), var(--charcoal) 8px, #2d343c 8px, #2d343c 16px); color: var(--accent); }
  .ribbon .dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .6; }
  .ribbon .x { margin-left: auto; display: grid; place-items: center; width: 24px; height: 24px; border: none; background: rgba(0,0,0,.18); color: inherit; border-radius: var(--r-sm); cursor: pointer; }

  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 16px 24px; display: flex; flex-direction: column; gap: 14px; }
  .title { margin: 0; font-size: 17px; font-weight: 700; line-height: 1.25; }
  .meta { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
  .meta > span { font-family: var(--mono); font-size: 10.5px; padding: 3px 8px; border-radius: var(--r-sm); border: 1px solid var(--line); color: var(--txt-dim); }
  .meta .col { text-transform: uppercase; letter-spacing: .08em; }
  .meta .status.running { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .meta .status.waiting { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
  .meta .status.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
  .meta .branch { color: var(--accent); border-color: var(--accent-dim); }

  .reason { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--warn); background: rgba(240,168,48,.08); border: 1px solid rgba(240,168,48,.28); padding: 8px 10px; border-radius: var(--r-sm); }
  .now { display: flex; flex-direction: column; gap: 3px; }
  .now-l { font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--txt-faint); font-weight: 700; }
  .now-v { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 12.5px; color: var(--accent); }

  .meters { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
  .m { display: flex; justify-content: space-between; gap: 8px; padding: 7px 10px; background: var(--panel); }
  .mk { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--txt-faint); }
  .mv { font-family: var(--mono); font-size: 12px; color: var(--txt); }
  .mv.sm { font-size: 10px; } .mv.warn { color: var(--warn); }

  section { display: flex; flex-direction: column; gap: 7px; }
  .s-h { display: flex; align-items: center; gap: 9px; font-size: 11px; text-transform: uppercase; letter-spacing: .14em; font-weight: 700; color: var(--txt-dim); }
  .s-h .rule { width: 16px; height: 3px; background: var(--accent); }
  .s-h .dim { margin-left: auto; }
  .dim { color: var(--txt-faint); font-weight: 500; letter-spacing: 0; text-transform: none; }
  .line { font-size: 12.5px; color: var(--txt); }
  .ok { color: var(--ok); } .bad { color: var(--danger); }
  .review.changes { color: var(--accent); } .review.approve { color: var(--ok); } .review.error { color: var(--danger); }
  .findings { margin-top: 5px; font-family: var(--mono); font-size: 11px; line-height: 1.5; color: var(--txt-dim); white-space: pre-wrap; max-height: 160px; overflow: auto; border-left: 2px solid var(--line-2); padding-left: 8px; }

  .sub-node { display: flex; align-items: center; gap: 9px; font-size: 12px; }
  .sn-rail { width: 13px; height: 13px; border-left: 2px solid var(--accent-dim); border-bottom: 2px solid var(--accent-dim); border-bottom-left-radius: 4px; flex: 0 0 auto; }

  .tools { display: flex; flex-direction: column; gap: 4px; }
  .tool { display: flex; align-items: baseline; gap: 8px; font-family: var(--mono); font-size: 11px; }
  .tool .tn { color: var(--accent); }
  .tool .td { color: var(--txt-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .tool .tt { color: var(--txt-faint); font-size: 9.5px; }

  .msgs { display: flex; flex-direction: column; gap: 8px; }
  .msg { font-size: 12px; }
  .msg .role-tag { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; padding: 1px 5px; border-radius: 4px; background: var(--panel-2); border: 1px solid var(--line); margin-right: 6px; }
  .msg.user .role-tag { color: var(--accent); }
  .msg.assistant .role-tag { color: var(--claude); }
  .msg .mtext { color: var(--txt-dim); line-height: 1.5; }

  .full { margin-top: 6px; display: inline-flex; align-items: center; gap: 7px; align-self: flex-start; background: transparent; border: 1px solid var(--line-2); color: var(--txt); font-size: 12px; padding: 8px 13px; border-radius: var(--r-sm); cursor: pointer; }
  .full:hover { border-color: var(--accent); color: #fff; }
</style>
