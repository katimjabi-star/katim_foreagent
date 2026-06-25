<script lang="ts">
  import {
    ui, fetchRepos, fetchSkills, fetchFeed, fetchTemplates, installSkill, spawnAgent, streamAi,
    type RepoChoice, type CatalogSkill, type InstalledSkill, type FeedItem, type TemplateItem,
  } from './store.svelte.ts';
  import Icon from './Icon.svelte';

  type Tab = 'skills' | 'whatsnew' | 'templates';
  let tab = $state<Tab>('skills');
  let q = $state('');

  let installed = $state<InstalledSkill[]>([]);
  let catalog = $state<CatalogSkill[]>([]);
  let feed = $state<FeedItem[]>([]);
  let templates = $state<TemplateItem[]>([]);
  let repos = $state<RepoChoice[]>([]);
  let targetRepo = $state('');
  let notice = $state('');

  // AI suggestions
  let suggestOut = $state('');
  let suggestBusy = $state(false);

  $effect(() => {
    fetchSkills().then((s) => { installed = s.installed; catalog = s.catalog; });
    fetchFeed().then((f) => (feed = f));
    fetchTemplates().then((t) => (templates = t));
    fetchRepos().then((rs) => { repos = rs; if (rs.length && !targetRepo) targetRepo = ui.projectPath || rs[0]!.path; });
  });

  const installedNames = $derived(new Set(installed.map((s) => s.name)));
  const match = (text: string) => !q || text.toLowerCase().includes(q.toLowerCase());
  const shownCatalog = $derived(catalog.filter((s) => match(`${s.name} ${s.description} ${s.tags.join(' ')}`)));
  const shownFeed = $derived(feed.filter((f) => match(`${f.title} ${f.summary} ${f.tag}`)));
  const shownTemplates = $derived(templates.filter((t) => match(`${t.title} ${t.tag}`)));

  async function doInstall(id: string): Promise<void> {
    notice = '';
    const r = await installSkill(id);
    if (r.ok) { const s = await fetchSkills(); installed = s.installed; notice = `Installed “${id}” into ~/.claude/skills.`; }
    else notice = `Could not install: ${r.error}`;
  }

  async function suggest(): Promise<void> {
    if (!targetRepo || suggestBusy) return;
    suggestOut = ''; suggestBusy = true;
    await streamAi('/api/ai/suggest', { repoPath: targetRepo }, { onToken: (t) => (suggestOut += t), onError: (e) => (suggestOut = suggestOut || `⚠ ${e}`) });
    suggestBusy = false;
  }

  async function runTemplate(t: TemplateItem): Promise<void> {
    notice = '';
    if (!targetRepo) { notice = 'Pick a target repo first.'; return; }
    const taskId = `ctl:${t.id}-${Date.now().toString(36)}`;
    const res = await spawnAgent({ taskId, repoPath: targetRepo, vendor: 'claude-code', prompt: t.prompt });
    notice = res.ok ? `Spawned “${t.title}” → watch the Board / In Review.` : `Spawn failed: ${res.error}`;
  }
</script>

<div class="wrap">
  <div class="tabs">
    <button class:active={tab === 'skills'} onclick={() => (tab = 'skills')}>Skills</button>
    <button class:active={tab === 'whatsnew'} onclick={() => (tab = 'whatsnew')}>What's New</button>
    <button class:active={tab === 'templates'} onclick={() => (tab = 'templates')}>Templates</button>
    <input class="search" type="search" placeholder="search…" bind:value={q} />
    <select class="repo" bind:value={targetRepo} title="Target repo for installs / template runs">
      {#each repos as r}<option value={r.path}>{r.repo}</option>{/each}
    </select>
  </div>

  {#if notice}<div class="notice">{notice}</div>{/if}

  <div class="body">
    {#if tab === 'skills'}
      <section class="ai-suggest">
        <div class="as-h">AI suggestions <button class="ai-btn" disabled={suggestBusy || !targetRepo} onclick={suggest}><Icon name="sparkles" size={13} /> {suggestBusy ? 'thinking…' : 'suggest for this repo'}</button></div>
        {#if suggestOut}<div class="ai-out">{suggestOut}{#if suggestBusy}<span class="caret">▋</span>{/if}</div>
        {:else}<div class="dim">Let <code>claude -p</code> recommend skills based on the selected repo's detected stack.</div>{/if}
      </section>

      <div class="cards">
        {#each shownCatalog as s}
          <div class="card">
            <div class="c-top"><span class="c-name">{s.name}</span>{#each s.tags as t}<span class="tagchip">{t}</span>{/each}</div>
            <div class="c-desc">{s.description}</div>
            <div class="c-foot">
              {#if installedNames.has(s.name)}
                <span class="installed">✓ installed</span>
                <a class="link" href={`/api/skills/export?name=${encodeURIComponent(s.name)}`} target="_blank" rel="noreferrer">export</a>
              {:else}
                <button class="install" onclick={() => doInstall(s.id)}>Install</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      {#if installed.length}
        <div class="sub-h">Installed in ~/.claude/skills ({installed.length})</div>
        <div class="inst-list">
          {#each installed as s}<div class="inst"><span class="in-name">{s.name}</span><span class="in-desc">{s.description}</span><a class="link" href={`/api/skills/export?name=${encodeURIComponent(s.name)}`} target="_blank" rel="noreferrer">export</a></div>{/each}
        </div>
      {/if}

    {:else if tab === 'whatsnew'}
      <div class="feed">
        {#each shownFeed as f}
          <article class="fitem">
            <div class="f-top"><span class="f-title">{f.title}</span><span class="tagchip">{f.tag}</span></div>
            <div class="f-sum">{f.summary}</div>
            <div class="f-why"><b>Why it matters:</b> {f.why}</div>
            <div class="f-src">{f.source}</div>
          </article>
        {/each}
      </div>

    {:else}
      <div class="cards">
        {#each shownTemplates as t}
          <div class="card">
            <div class="c-top"><span class="c-name">{t.title}</span><span class="tagchip">{t.tag}</span></div>
            <div class="c-desc">{t.prompt}</div>
            <div class="c-foot"><button class="install" onclick={() => runTemplate(t)}>Spawn in {targetRepo.split('/').pop() || 'repo'}</button></div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .wrap { flex: 1; overflow: auto; padding: 16px 20px; min-height: 0; display: flex; flex-direction: column; }
  .tabs { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  .tabs > button { background: transparent; border: 1px solid transparent; color: var(--txt-dim); font-size: 12.5px; padding: 6px 12px; border-radius: 7px; cursor: pointer; }
  .tabs > button:hover { color: var(--txt); }
  .tabs > button.active { background: var(--panel-2); border-color: var(--line-2); color: var(--txt); }
  .search { margin-left: auto; background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); font-family: var(--mono); font-size: 12px; padding: 6px 10px; border-radius: 6px; width: 180px; }
  .repo { background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); font-size: 12px; padding: 6px 9px; border-radius: 6px; max-width: 150px; }
  .search:focus, .repo:focus { outline: none; border-color: var(--accent-dim); }
  .notice { margin-top: 12px; font-size: 12.5px; color: var(--accent); }
  .body { padding-top: 16px; }

  .ai-suggest { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; }
  .as-h { display: flex; justify-content: space-between; align-items: center; font-size: 11px; text-transform: uppercase; letter-spacing: .14em; color: var(--txt-dim); font-weight: 700; margin-bottom: 8px; }
  .ai-btn { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--accent-dim); background: var(--accent-ghost); color: var(--accent); cursor: pointer; text-transform: none; letter-spacing: normal; }
  .ai-btn:disabled { opacity: .5; cursor: default; }
  .ai-out { font-size: 13px; line-height: 1.6; white-space: pre-wrap; color: var(--txt); }
  .caret { color: var(--accent); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 13px 15px; display: flex; flex-direction: column; gap: 8px; }
  .c-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .c-name { font-weight: 600; font-size: 13.5px; }
  .tagchip { font-family: var(--mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--txt-dim); border: 1px solid var(--line-2); border-radius: 4px; padding: 1px 6px; }
  .c-desc { font-size: 12.5px; color: var(--txt-dim); line-height: 1.5; flex: 1; }
  .c-foot { display: flex; align-items: center; gap: 12px; }
  .install { background: var(--accent); color: var(--on-accent); border: none; font-weight: 700; font-size: 11.5px; padding: 6px 13px; border-radius: var(--r-sm); cursor: pointer; }
  .install:hover { background: var(--accent-strong); }
  .installed { color: var(--ok); font-size: 12px; }
  .link { color: var(--accent); font-size: 11.5px; text-decoration: none; }
  .link:hover { text-decoration: underline; }

  .sub-h { font-size: 11px; text-transform: uppercase; letter-spacing: .14em; color: var(--txt-faint); font-weight: 700; margin: 22px 0 10px; }
  .inst-list { display: flex; flex-direction: column; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .inst { display: flex; align-items: center; gap: 12px; padding: 9px 13px; background: var(--panel); }
  .in-name { font-family: var(--mono); font-size: 12px; color: var(--accent); min-width: 130px; }
  .in-desc { flex: 1; font-size: 12px; color: var(--txt-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .feed { display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
  .fitem { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .f-top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .f-title { font-weight: 700; font-size: 14.5px; }
  .f-sum { font-size: 13px; color: var(--txt); line-height: 1.6; }
  .f-why { font-size: 12.5px; color: var(--txt-dim); line-height: 1.55; margin-top: 8px; }
  .f-why b { color: var(--txt); }
  .f-src { font-family: var(--mono); font-size: 10.5px; color: var(--txt-faint); margin-top: 8px; }
  .dim { color: var(--txt-faint); }
  code { font-family: var(--mono); color: var(--accent); }
</style>
