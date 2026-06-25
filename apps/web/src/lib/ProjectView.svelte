<script lang="ts">
  import { ui, fetchRepos, fetchProject, streamAi, type RepoChoice, type ProjectReport } from './store.svelte.ts';
  import Icon from './Icon.svelte';

  let repoList = $state<RepoChoice[]>([]);
  let report = $state<ProjectReport | null>(null);
  let loading = $state(false);

  // AI summary + Q&A (Sprint B) — both stream `claude -p`.
  let summary = $state('');
  let summaryBusy = $state(false);
  let question = $state('');
  let answer = $state('');
  let qaBusy = $state(false);

  async function load(path: string): Promise<void> {
    if (!path) return;
    loading = true;
    ui.projectPath = path;
    summary = ''; answer = ''; question = '';
    report = await fetchProject(path);
    loading = false;
  }

  async function genSummary(): Promise<void> {
    if (!report || summaryBusy) return;
    summary = ''; summaryBusy = true;
    await streamAi('/api/ai/summarize', { repoPath: report.path }, {
      onToken: (t) => (summary += t),
      onError: (e) => (summary = summary || `⚠ ${e}`),
    });
    summaryBusy = false;
  }

  async function ask(): Promise<void> {
    if (!report || !question.trim() || qaBusy) return;
    answer = ''; qaBusy = true;
    await streamAi('/api/ai/ask', { repoPath: report.path, prompt: question.trim() }, {
      onToken: (t) => (answer += t),
      onError: (e) => (answer = answer || `⚠ ${e}`),
    });
    qaBusy = false;
  }

  // On first mount, populate the repo list and auto-select one.
  $effect(() => {
    if (repoList.length) return;
    fetchRepos().then((rs) => {
      repoList = rs;
      const initial = ui.projectPath || rs[0]?.path;
      if (initial) load(initial);
    });
  });

  const prodDeps = $derived(report?.stack.dependencies.filter((d) => !d.dev) ?? []);
  const devDeps = $derived(report?.stack.dependencies.filter((d) => d.dev) ?? []);
</script>

<div class="wrap">
  <div class="head">
    <select class="repo" value={ui.projectPath} onchange={(e) => load((e.target as HTMLSelectElement).value)} aria-label="Select project">
      {#each repoList as r}<option value={r.path}>{r.repo}</option>{/each}
    </select>
    {#if report?.path}<span class="path">{report.path}</span>{/if}
  </div>

  {#if loading}
    <div class="empty">Reading project…</div>
  {:else if !report}
    <div class="empty">No project selected, or no repositories observed yet. Start a Claude Code session in a repo and it'll appear here.</div>
  {:else}
    <div class="grid">
      <!-- Identity / git -->
      <section class="panel span2">
        <div class="p-h">Repository</div>
        <div class="kv">
          <div><span class="k">Name</span><span class="v">{report.name}</span></div>
          {#if report.git}
            <div><span class="k">Branch</span><span class="v accent">{report.git.branch}</span></div>
            {#if report.git.githubSlug}
              <div><span class="k">GitHub</span><a class="v link" href={`https://github.com/${report.git.githubSlug}`} target="_blank" rel="noreferrer">{report.git.githubSlug} <Icon name="external" size={12} /></a></div>
            {:else if report.git.remoteUrl}
              <div><span class="k">Remote</span><span class="v mono">{report.git.remoteUrl}</span></div>
            {/if}
            <div><span class="k">Working tree</span><span class="v">{report.git.dirty === 0 ? 'clean ✓' : `${report.git.dirty} changed`}</span></div>
            <div><span class="k">vs upstream</span><span class="v mono">↑{report.git.ahead} ↓{report.git.behind}</span></div>
          {:else}
            <div><span class="k">Git</span><span class="v dim">not a git repository</span></div>
          {/if}
        </div>
      </section>

      <!-- Stack -->
      <section class="panel span2">
        <div class="p-h">Tech stack</div>
        <div class="chips">
          {#each report.stack.languages as l}<span class="chip lang">{l}</span>{/each}
          {#each report.stack.frameworks as f}<span class="chip fw">{f}</span>{/each}
          {#each report.stack.ecosystems as e}<span class="chip eco">{e}</span>{/each}
          {#if !report.stack.languages.length && !report.stack.frameworks.length}
            <span class="dim">No manifest detected (package.json, pyproject.toml, go.mod, Cargo.toml…)</span>
          {/if}
        </div>
        <div class="counts">{prodDeps.length} dependencies · {devDeps.length} dev</div>
      </section>

      <!-- AI overview -->
      <section class="panel span2">
        <div class="p-h">AI overview <button class="ai-btn" disabled={summaryBusy} onclick={genSummary}><Icon name="sparkles" size={13} /> {summaryBusy ? 'generating…' : summary ? 'regenerate' : 'generate'}</button></div>
        {#if summary}
          <div class="ai-out">{summary}{#if summaryBusy}<span class="caret">▋</span>{/if}</div>
        {:else}
          <div class="dim">Generate a plain-English summary of this project, written by <code>claude -p</code> using your existing Claude Code auth — no API key.</div>
        {/if}
      </section>

      <!-- Ask about the project -->
      <section class="panel span2">
        <div class="p-h">Ask about this project</div>
        <form class="qa" onsubmit={(e) => { e.preventDefault(); ask(); }}>
          <input bind:value={question} placeholder="e.g. How does the event log work? What changed recently?" />
          <button class="ai-btn" disabled={qaBusy || !question.trim()}>{qaBusy ? '…' : 'Ask'}</button>
        </form>
        {#if answer}<div class="ai-out">{answer}{#if qaBusy}<span class="caret">▋</span>{/if}</div>{/if}
      </section>

      <!-- Recent commits -->
      {#if report.git?.lastCommits.length}
        <section class="panel span2">
          <div class="p-h">Recent commits</div>
          <ul class="commits">
            {#each report.git.lastCommits as c}
              <li><span class="sha">{c.sha}</span> <span class="subj">{c.subject}</span> <span class="when">{c.when}</span></li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- Dependencies -->
      {#if prodDeps.length}
        <section class="panel">
          <div class="p-h">Dependencies <span class="dim">{prodDeps.length}</span></div>
          <ul class="deps">{#each prodDeps as d}<li><span class="dn">{d.name}</span><span class="dv">{d.version}</span></li>{/each}</ul>
        </section>
      {/if}
      {#if devDeps.length}
        <section class="panel">
          <div class="p-h">Dev dependencies <span class="dim">{devDeps.length}</span></div>
          <ul class="deps">{#each devDeps as d}<li><span class="dn">{d.name}</span><span class="dv">{d.version}</span></li>{/each}</ul>
        </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap { flex: 1; overflow: auto; padding: 18px 20px; min-height: 0; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .repo { background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); font-size: 13px; padding: 7px 11px; border-radius: 7px; min-width: 200px; }
  .repo:focus { outline: none; border-color: var(--accent-dim); }
  .path { font-family: var(--mono); font-size: 11.5px; color: var(--txt-faint); }
  .empty { color: var(--txt-faint); padding: 40px 0; text-align: center; }

  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .span2 { grid-column: span 2; }
  .p-h { font-size: 11px; text-transform: uppercase; letter-spacing: .16em; color: var(--txt-dim); font-weight: 700; margin-bottom: 12px; }

  .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; }
  .kv > div { display: flex; flex-direction: column; gap: 3px; }
  .kv .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--txt-faint); }
  .kv .v { font-size: 13.5px; color: var(--txt); }
  .v.accent { color: var(--accent); font-family: var(--mono); }
  .v.mono { font-family: var(--mono); font-size: 12px; }
  .v.link { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); text-decoration: none; }
  .v.link:hover { text-decoration: underline; }
  .v.dim, .dim { color: var(--txt-faint); }

  .chips { display: flex; flex-wrap: wrap; gap: 7px; }
  .chip { font-family: var(--mono); font-size: 11.5px; padding: 4px 11px; border-radius: var(--r-sm); border: 1px solid var(--line-2); background: var(--panel); color: var(--txt); }
  .chip.lang { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-ghost); }
  .chip.fw { color: var(--txt); border-color: var(--line-2); }
  .chip.eco { color: var(--txt-dim); border-color: var(--line); }
  .counts { margin-top: 12px; font-family: var(--mono); font-size: 11px; color: var(--txt-faint); }

  .commits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  .commits li { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; }
  .commits .sha { font-family: var(--mono); color: var(--accent); font-size: 11.5px; }
  .commits .subj { flex: 1; color: var(--txt); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commits .when { color: var(--txt-faint); font-size: 11px; white-space: nowrap; }

  .deps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-height: 320px; overflow: auto; }
  .deps li { display: flex; justify-content: space-between; gap: 12px; font-family: var(--mono); font-size: 11.5px; }
  .deps .dn { color: var(--txt); }
  .deps .dv { color: var(--txt-faint); }

  .p-h { display: flex; align-items: center; justify-content: space-between; }
  .ai-btn { display: inline-flex; align-items: center; gap: 5px; font-family: var(--ui); text-transform: none; letter-spacing: normal; font-size: 11px; font-weight: 600; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--accent-dim); background: var(--accent-ghost); color: var(--accent); cursor: pointer; }
  .ai-btn:hover:not(:disabled) { background: var(--accent-ghost); }
  .ai-btn:disabled { opacity: .5; cursor: default; }
  .ai-out { font-size: 13px; line-height: 1.65; color: var(--txt); white-space: pre-wrap; margin-top: 4px; }
  .caret { color: var(--accent); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .qa { display: flex; gap: 8px; margin-bottom: 10px; }
  .qa input { flex: 1; background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); border-radius: 7px; padding: 8px 11px; font-size: 13px; }
  .qa input:focus { outline: none; border-color: var(--accent-dim); }
  code { font-family: var(--mono); color: var(--accent); }
</style>
