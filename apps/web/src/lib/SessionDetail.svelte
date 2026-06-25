<script lang="ts">
  import { ui, fetchSession, streamAi, spawnAgent, type SessionDetail } from './store.svelte.ts';
  import Icon from './Icon.svelte';

  const { sessionId }: { sessionId: string } = $props();

  let detail = $state<SessionDetail | null>(null);
  let loading = $state(true);

  // Chat: three modes the user chose — resume the thread, new agent run, or Q&A.
  type Mode = 'resume' | 'qa' | 'newrun';
  let mode = $state<Mode>('resume');
  let input = $state('');
  let output = $state('');
  let busy = $state(false);
  let note = $state('');

  $effect(() => {
    loading = true;
    fetchSession(sessionId).then((d) => { detail = d; loading = false; });
  });

  async function send(): Promise<void> {
    if (!input.trim() || busy) return;
    const msg = input.trim();
    busy = true; output = ''; note = '';

    if (mode === 'newrun') {
      if (!detail?.cwd) { note = 'No repo path known for this session.'; busy = false; return; }
      const taskId = `ctl:${sessionId.slice(0, 6)}-${Date.now().toString(36)}`;
      const res = await spawnAgent({ taskId, repoPath: detail.cwd, vendor: 'claude-code', prompt: msg });
      note = res.ok ? 'Agent spawned in an isolated worktree — watch the Board / In Review.' : `Spawn failed: ${res.error}`;
      busy = false; input = '';
      return;
    }

    const endpoint = mode === 'resume' ? '/api/chat/resume' : '/api/ai/ask';
    const body = mode === 'resume'
      ? { sessionId, message: msg, repoPath: detail?.cwd }
      : { prompt: msg, repoPath: detail?.cwd };
    input = '';
    await streamAi(endpoint, body, { onToken: (t) => (output += t), onError: (e) => (output = output || `⚠ ${e}`) });
    busy = false;
  }

  function fmtTime(ts?: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // Sparkline path for the context curve (0..1 over the run).
  const sparkPath = $derived.by(() => {
    const pts = detail?.timeline ?? [];
    if (pts.length < 2) return '';
    const w = 100, h = 28;
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - p.pctUsed * h).toFixed(1)}`).join(' ');
  });
  const peakCtx = $derived(Math.max(0, ...(detail?.timeline ?? []).map((p) => p.pctUsed)));
  // Subagent orchestration: Task-tool invocations are this session's spawned children.
  const subagents = $derived((detail?.tools ?? []).filter((t) => /^Task$/i.test(t.name)));
</script>

<div class="wrap">
  <button class="back" onclick={() => (ui.sessionDetail = undefined)}><Icon name="back" size={13} /> Sessions</button>

  {#if loading}
    <div class="empty">Loading transcript…</div>
  {:else if !detail}
    <div class="empty">Transcript not found for this session.</div>
  {:else}
    <div class="hd">
      <div class="hd-main">
        <div class="sid">session {detail.sessionId.slice(0, 8)}</div>
        {#if detail.cwd}<div class="cwd">{detail.cwd}</div>{/if}
      </div>
      <div class="hd-stats">
        {#if detail.model}<span class="m">{detail.model}</span>{/if}
        <span class="m">{detail.totals.messages} msgs</span>
        <span class="m">{detail.totals.tools} tools</span>
        <span class="m cost">${detail.totals.costUsd.toFixed(2)}</span>
        <span class="m">ctx {Math.round(detail.totals.pctUsed * 100)}%</span>
      </div>
    </div>

    <div class="cols">
      <!-- Left: transcript + tools -->
      <div class="left">
        {#if sparkPath}
          <div class="panel">
            <div class="p-h">Context over the run <span class="dim">peak {Math.round(peakCtx * 100)}%</span></div>
            <svg viewBox="0 0 100 28" preserveAspectRatio="none" class="spark">
              <line x1="0" y1={28 - 0.4 * 28} x2="100" y2={28 - 0.4 * 28} class="dumb" />
              <path d={sparkPath} class="line" />
            </svg>
            <div class="spark-cap"><span>start</span><span class="dim">dashed = 40% dumb-zone</span><span>now</span></div>
          </div>
        {/if}

        <div class="panel grow">
          <div class="p-h">Transcript <span class="dim">{detail.messages.length} shown</span></div>
          <div class="msgs">
            {#each detail.messages as m}
              <div class="msg {m.role}">
                <span class="role">{m.role}</span>
                <span class="t">{fmtTime(m.ts)}</span>
                <div class="text">{m.text}</div>
              </div>
            {/each}
            {#if !detail.messages.length}<div class="dim">No messages parsed.</div>{/if}
          </div>
        </div>
      </div>

      <!-- Right: chat -->
      <div class="right">
        <div class="panel grow">
          <div class="p-h">Chat</div>
          <div class="modes">
            <button class:active={mode === 'resume'} onclick={() => (mode = 'resume')} title="Continue this session's thread with claude --resume">Resume thread</button>
            <button class:active={mode === 'qa'} onclick={() => (mode = 'qa')} title="Ask about the project without touching the session">Q&amp;A</button>
            <button class:active={mode === 'newrun'} onclick={() => (mode = 'newrun')} title="Spawn a new agent run in an isolated worktree">New run</button>
          </div>
          <div class="mode-note dim">
            {#if mode === 'resume'}Continues this exact session's context in a new headless turn (<code>claude --resume</code>). Avoid if the session is open live in a terminal.
            {:else if mode === 'qa'}Read-only question about the repo, answered by <code>claude -p</code>. Doesn't touch the session.
            {:else}Turns your message into a fresh agent task in an isolated git worktree → lands in <b>In Review</b>.{/if}
          </div>

          {#if output}<div class="out">{output}{#if busy}<span class="caret">▋</span>{/if}</div>{/if}
          {#if note}<div class="note">{note}</div>{/if}

          <form class="composer" onsubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea bind:value={input} rows="3" placeholder={mode === 'newrun' ? 'Describe the task for a new agent…' : 'Type a message…'}></textarea>
            <button class="send" disabled={busy || !input.trim()}>{busy ? '…' : mode === 'newrun' ? 'Spawn' : 'Send'}</button>
          </form>
        </div>

        {#if subagents.length}
          <div class="panel">
            <div class="p-h"><span class="ph-l"><Icon name="tree" size={13} /> Subagents</span> <span class="dim">{subagents.length} spawned</span></div>
            <div class="subs">
              {#each subagents as s}
                <div class="sub-node"><span class="sn-rail"></span><span class="sn-d">{s.detail ?? 'subagent task'}</span></div>
              {/each}
            </div>
          </div>
        {/if}

        {#if detail.tools.length}
          <div class="panel">
            <div class="p-h">Recent tools <span class="dim">{detail.tools.length}</span></div>
            <div class="tools">
              {#each detail.tools.slice(-14).reverse() as t}
                <div class="tool"><span class="tn">{t.name}</span>{#if t.detail}<span class="td">{t.detail}</span>{/if}</div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap { flex: 1; overflow: hidden; padding: 14px 18px; min-height: 0; display: flex; flex-direction: column; }
  .back { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; background: transparent; border: 1px solid var(--line-2); color: var(--txt-dim); font-size: 12px; padding: 6px 12px; border-radius: var(--r-sm); cursor: pointer; margin-bottom: 12px; transition: border-color .14s, color .14s; }
  .back:hover { color: var(--txt); border-color: var(--accent-dim); }
  .empty { color: var(--txt-faint); text-align: center; padding: 40px; }

  .hd { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
  .sid { font-weight: 700; font-size: 15px; }
  .cwd { font-family: var(--mono); font-size: 11.5px; color: var(--txt-faint); margin-top: 2px; }
  .hd-stats { display: flex; gap: 6px; flex-wrap: wrap; }
  .m { font-family: var(--mono); font-size: 10.5px; color: var(--txt-dim); background: var(--panel-2); border: 1px solid var(--line); padding: 3px 8px; border-radius: 5px; }
  .m.cost { color: var(--txt); }

  .cols { flex: 1; display: grid; grid-template-columns: 1.3fr 1fr; gap: 12px; min-height: 0; }
  .left, .right { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .panel.grow { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .p-h { font-size: 11px; text-transform: uppercase; letter-spacing: .14em; color: var(--txt-dim); font-weight: 700; margin-bottom: 10px; display: flex; justify-content: space-between; }
  .dim { color: var(--txt-faint); }

  .spark { width: 100%; height: 40px; }
  .spark .line { fill: none; stroke: var(--accent); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .spark .dumb { stroke: var(--warn); stroke-width: .5; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; opacity: .6; }
  .spark-cap { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 9.5px; color: var(--txt-faint); margin-top: 3px; }

  .msgs { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
  .msg { font-size: 12.5px; }
  .msg .role { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; padding: 1px 6px; border-radius: 4px; background: var(--panel-2); border: 1px solid var(--line); }
  .msg.user .role { color: var(--accent); }
  .msg.assistant .role { color: #c8a6f5; }
  .msg .t { font-family: var(--mono); font-size: 10px; color: var(--txt-faint); margin-left: 6px; }
  .msg .text { margin-top: 4px; color: var(--txt); white-space: pre-wrap; line-height: 1.5; }

  .modes { display: flex; gap: 5px; margin-bottom: 8px; }
  .modes button { flex: 1; background: var(--panel-2); border: 1px solid var(--line); color: var(--txt-dim); font-size: 11.5px; padding: 6px; border-radius: 6px; cursor: pointer; }
  .modes button.active { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-ghost); }
  .mode-note { font-size: 11px; line-height: 1.5; margin-bottom: 10px; }
  .out { flex: 1; overflow: auto; font-size: 12.5px; line-height: 1.6; color: var(--txt); white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
  .note { font-size: 12px; color: var(--accent); margin-bottom: 10px; }
  .caret { color: var(--accent); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .composer { display: flex; gap: 8px; align-items: flex-end; }
  .composer textarea { flex: 1; background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: var(--ui); resize: vertical; }
  .composer textarea:focus { outline: none; border-color: var(--accent-dim); }
  .send { background: var(--accent); color: var(--on-accent); border: none; font-weight: 700; padding: 9px 16px; border-radius: var(--r-sm); font-size: 12px; cursor: pointer; }
  .send:hover:not(:disabled) { background: var(--accent-strong); }
  .send:disabled { opacity: .5; cursor: default; }

  .ph-l { display: inline-flex; align-items: center; gap: 7px; }
  .ph-l :global(.icon) { color: var(--accent); }
  .subs { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow: auto; }
  .sub-node { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--txt); padding-left: 4px; }
  .sub-node .sn-rail { width: 14px; height: 14px; border-left: 2px solid var(--accent-dim); border-bottom: 2px solid var(--accent-dim); border-bottom-left-radius: 4px; flex: 0 0 auto; }
  .sub-node .sn-d { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tools { display: flex; flex-direction: column; gap: 5px; max-height: 180px; overflow: auto; }
  .tool { font-family: var(--mono); font-size: 11px; display: flex; gap: 8px; }
  .tool .tn { color: var(--accent); }
  .tool .td { color: var(--txt-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code { font-family: var(--mono); color: var(--accent); }
</style>
