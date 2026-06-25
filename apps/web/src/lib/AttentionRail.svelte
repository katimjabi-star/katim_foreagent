<script lang="ts">
  import { board, ui, attention, type AttentionItem } from './store.svelte.ts';
  import Icon from './Icon.svelte';

  let open = $state(false);
  const items = $derived(attention());
  const errors = $derived(items.filter((i) => i.severity === 'error').length);
  const worst = $derived(items.length ? items[0]!.severity : undefined);

  const ICON: Record<string, string> = {
    'needs-input': 'pause', 'rate-limit': 'warn', 'server-error': 'warn',
    'tool-error': 'x', 'auth': 'warn', 'dumb-zone': 'bolt', 'near-limit': 'warn', 'compacted': 'box',
  };
  const LABEL: Record<string, string> = {
    'needs-input': 'Needs you', 'rate-limit': 'Usage limit', 'server-error': 'Server error',
    'tool-error': 'Tool error', 'auth': 'Auth', 'dumb-zone': 'Dumb zone', 'near-limit': 'Near limit', 'compacted': 'Compacted',
  };

  function go(it: AttentionItem): void {
    if (it.taskId) { ui.view = 'board'; board.selected = it.taskId; }
    open = false;
  }
  function fmt(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
</script>

<div class="attn" class:open>
  <button class="bell" class:has={items.length} data-sev={worst} onclick={() => (open = !open)} title="Attention — agents needing you / errors / limits">
    <Icon name="bell" size={16} />
    {#if items.length}<span class="count" data-sev={worst}>{errors || items.length}</span>{/if}
  </button>

  {#if open}
    <div class="sheet" role="dialog" aria-label="Attention">
      <div class="sheet-h"><span class="rule"></span> Attention <span class="dim">{items.length} signal{items.length === 1 ? '' : 's'}</span></div>
      {#if !items.length}
        <div class="empty">All clear — nothing needs you.</div>
      {:else}
        <ul class="list">
          {#each items as it (it.id)}
            <li class="row {it.severity}" onclick={() => go(it)} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && go(it)}>
              <span class="ic"><Icon name={ICON[it.kind] ?? 'warn'} size={14} /></span>
              <span class="body">
                <span class="top"><span class="kind">{LABEL[it.kind] ?? it.kind}</span>{#if it.title}<span class="task">{it.title}</span>{/if}<span class="t">{fmt(it.ts)}</span></span>
                <span class="msg">{it.message}</span>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .attn { position: relative; }
  .bell { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--r-sm); border: 1px solid var(--line-2); background: transparent; color: var(--txt-dim); cursor: pointer; transition: color .14s, border-color .14s; }
  .bell:hover, .attn.open .bell { color: var(--txt); border-color: var(--accent); }
  .bell.has[data-sev='error'] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
  .bell.has[data-sev='warn'] { color: var(--accent); }
  .count { position: absolute; top: -6px; right: -6px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; font-family: var(--mono); font-size: 9.5px; font-weight: 700; display: grid; place-items: center; color: #fff; background: var(--accent); }
  .count[data-sev='error'] { background: var(--danger); }

  .sheet { position: absolute; top: 42px; right: 0; width: 380px; max-height: 60vh; overflow: auto; z-index: 60; background: rgba(18,21,26,.96); backdrop-filter: blur(16px); border: 1px solid var(--line-2); border-radius: var(--r-md); box-shadow: var(--shadow-lg); padding: 12px; }
  .sheet-h { display: flex; align-items: center; gap: 9px; font-size: 11px; text-transform: uppercase; letter-spacing: .14em; font-weight: 700; color: var(--txt-dim); margin-bottom: 10px; }
  .sheet-h .rule { width: 18px; height: 3px; background: var(--accent); }
  .sheet-h .dim { margin-left: auto; text-transform: none; letter-spacing: 0; color: var(--txt-faint); font-weight: 500; }
  .empty { color: var(--txt-faint); font-size: 12.5px; padding: 14px 4px; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; gap: 10px; padding: 9px 10px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--panel); cursor: pointer; transition: border-color .12s, background .12s; }
  .row:hover { border-color: var(--accent-dim); background: var(--panel-2); }
  .row .ic { flex: 0 0 auto; color: var(--txt-dim); margin-top: 1px; }
  .row.error .ic { color: var(--danger); }
  .row.warn .ic { color: var(--accent); }
  .row.info .ic { color: var(--txt-faint); }
  .body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .top { display: flex; align-items: center; gap: 8px; }
  .kind { font-size: 11.5px; font-weight: 700; color: var(--txt); }
  .task { font-size: 11px; color: var(--txt-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .t { font-family: var(--mono); font-size: 9.5px; color: var(--txt-faint); }
  .msg { font-size: 12px; color: var(--txt-dim); line-height: 1.45; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
</style>
