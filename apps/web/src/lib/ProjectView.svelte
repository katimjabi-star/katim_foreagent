<script lang="ts">
  import { ui, fetchRepos, fetchProject, streamAi, type RepoChoice, type ProjectReport } from './store.svelte.ts';
  import Icon from './Icon.svelte';

  let repoList = $state<RepoChoice[]>([]);
  let report = $state<ProjectReport | null>(null);
  let loading = $state(false);
  let archOpen = $state(false);
  let archTab = $state<'overview' | 'frontend' | 'backend' | 'data'>('overview');

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
  const depNames = $derived(report?.stack.dependencies.map((d) => d.name.toLowerCase()) ?? []);
  const hasAny = (names: string[]) => names.some((n) => depNames.some((d) => d === n || d.includes(n)));
  const frontendStack = $derived([
    ...((report?.stack.frameworks ?? []).filter((f) => /react|svelte|vue|vite|next|expo|native|tailwind/i.test(f))),
    ...prodDeps.filter((d) => /react|svelte|vue|vite|expo|native|tailwind|map|ui|lucide/i.test(d.name)).slice(0, 8).map((d) => d.name),
  ]);
  const backendStack = $derived([
    ...((report?.stack.frameworks ?? []).filter((f) => /express|fastify|hono|nestjs|bun|node|server|api/i.test(f))),
    ...prodDeps.filter((d) => /express|fastify|hono|server|ws|socket|redis|pg|postgres|prisma|drizzle|auth|jwt|bcrypt/i.test(d.name)).slice(0, 10).map((d) => d.name),
  ]);
  const apiSignals = $derived([
    hasAny(['express', 'fastify', 'hono', '@nestjs']) ? 'HTTP API' : '',
    hasAny(['ws', 'socket.io', 'websocket']) ? 'Realtime/WebSocket' : '',
    hasAny(['zod', 'valibot', 'yup']) ? 'Schema validation' : '',
    hasAny(['jsonwebtoken', 'jwt', 'passport', 'better-auth']) ? 'Auth boundary' : '',
  ].filter(Boolean));
  const dataSignals = $derived([
    hasAny(['pg', 'postgres', 'postgresql']) ? 'Postgres' : '',
    hasAny(['redis', 'ioredis']) ? 'Redis' : '',
    hasAny(['prisma', 'drizzle', 'typeorm', 'sequelize']) ? 'ORM/query layer' : '',
    hasAny(['sqlite', 'better-sqlite3']) ? 'SQLite' : '',
  ].filter(Boolean));
  const architectureNodes = $derived([
    { id: 'ui', title: 'Frontend', meta: frontendStack.length ? frontendStack.slice(0, 3).join(' / ') : 'client surface', icon: 'project' },
    { id: 'api', title: 'Backend/API', meta: backendStack.length ? backendStack.slice(0, 3).join(' / ') : (apiSignals.join(' / ') || 'service layer'), icon: 'box' },
    { id: 'data', title: 'Data & services', meta: dataSignals.length ? dataSignals.join(' / ') : 'manifests + git context', icon: 'git' },
  ]);
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
        <div class="p-h">
          Tech stack
          <button class="ai-btn" onclick={() => { archTab = 'overview'; archOpen = true; }}><Icon name="tree" size={13} /> Architecture</button>
        </div>
        <div class="stack-layout">
          <div class="stack-main">
            <div class="chips">
              {#each report.stack.languages as l}<span class="chip lang">{l}</span>{/each}
              {#each report.stack.frameworks as f}<span class="chip fw">{f}</span>{/each}
              {#each report.stack.ecosystems as e}<span class="chip eco">{e}</span>{/each}
              {#if !report.stack.languages.length && !report.stack.frameworks.length}
                <span class="dim">No manifest detected (package.json, pyproject.toml, go.mod, Cargo.toml…)</span>
              {/if}
            </div>
            <div class="counts">{prodDeps.length} dependencies · {devDeps.length} dev · {report.policies?.length ?? 0} policy files</div>
          </div>
          <div class="stack-map">
            {#each architectureNodes as n, i}
              <div class="node">
                <span class="node-ic"><Icon name={n.icon} size={14} /></span>
                <span class="node-t">{n.title}</span>
                <span class="node-m">{n.meta}</span>
              </div>
              {#if i < architectureNodes.length - 1}<span class="flow"><Icon name="arrow" size={14} /></span>{/if}
            {/each}
          </div>
        </div>
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

{#if archOpen && report}
  <div class="modal-backdrop" role="presentation" onclick={() => (archOpen = false)}>
    <div
      class="arch-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Architecture diagram"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="modal-head">
        <div>
          <div class="p-h modal-title">Architecture</div>
          <div class="modal-sub">{report.name} · {report.path}</div>
        </div>
        <button class="icon-btn" aria-label="Close architecture dialog" onclick={() => (archOpen = false)}><Icon name="x" size={16} /></button>
      </div>

      <div class="tabs" role="tablist" aria-label="Architecture sections">
        <button class:active={archTab === 'overview'} onclick={() => (archTab = 'overview')}><Icon name="tree" size={13} /> Overview</button>
        <button class:active={archTab === 'frontend'} onclick={() => (archTab = 'frontend')}><Icon name="project" size={13} /> Frontend</button>
        <button class:active={archTab === 'backend'} onclick={() => (archTab = 'backend')}><Icon name="box" size={13} /> Backend/API</button>
        <button class:active={archTab === 'data'} onclick={() => (archTab = 'data')}><Icon name="git" size={13} /> Data</button>
      </div>

      {#if archTab === 'overview'}
        <div class="diagram">
          {#each architectureNodes as n, i}
            <div class="arch-node {n.id}">
              <div class="arch-ic"><Icon name={n.icon} size={18} /></div>
              <div class="arch-copy">
                <div class="arch-title">{n.title}</div>
                <div class="arch-meta">{n.meta}</div>
              </div>
            </div>
            {#if i < architectureNodes.length - 1}<div class="connector"><Icon name="arrow" size={18} /></div>{/if}
          {/each}
        </div>
        <div class="insight-grid">
          <div><span class="k">Languages</span><span class="v">{report.stack.languages.join(', ') || 'unknown'}</span></div>
          <div><span class="k">Frameworks</span><span class="v">{report.stack.frameworks.join(', ') || 'none detected'}</span></div>
          <div><span class="k">Runtime/ecosystem</span><span class="v">{report.stack.ecosystems.join(', ') || 'unknown'}</span></div>
          <div><span class="k">Git state</span><span class="v">{report.git ? `${report.git.branch} · ${report.git.dirty} changed` : 'not a git repo'}</span></div>
        </div>
      {:else if archTab === 'frontend'}
        <div class="tab-grid">
          <div class="tab-panel">
            <div class="tab-h">UI surface</div>
            <div class="chips">{#each frontendStack as item}<span class="chip fw">{item}</span>{:else}<span class="dim">No frontend-specific dependency detected.</span>{/each}</div>
          </div>
          <div class="tab-panel">
            <div class="tab-h">Likely responsibilities</div>
            <ul class="bullets">
              <li>Route screens and interactive client workflows.</li>
              <li>State hydration from backend APIs or local manifests.</li>
              <li>Reusable UI components, icons, forms, and dashboards.</li>
            </ul>
          </div>
        </div>
      {:else if archTab === 'backend'}
        <div class="tab-grid">
          <div class="tab-panel">
            <div class="tab-h">Services & API layer</div>
            <div class="chips">
              {#each backendStack as item}<span class="chip fw">{item}</span>{/each}
              {#each apiSignals as item}<span class="chip lang">{item}</span>{/each}
              {#if !backendStack.length && !apiSignals.length}<span class="dim">No backend/API dependency detected from manifests.</span>{/if}
            </div>
          </div>
          <div class="tab-panel">
            <div class="tab-h">Boundary checks</div>
            <ul class="bullets">
              <li>Keep API contracts explicit and stable between UI and services.</li>
              <li>Surface realtime paths separately from request/response routes.</li>
              <li>Track auth, validation, and integration clients as separate concerns.</li>
            </ul>
          </div>
        </div>
      {:else}
        <div class="tab-grid">
          <div class="tab-panel">
            <div class="tab-h">Data and external services</div>
            <div class="chips">{#each dataSignals as item}<span class="chip lang">{item}</span>{:else}<span class="dim">No database or cache package detected.</span>{/each}</div>
          </div>
          <div class="tab-panel">
            <div class="tab-h">Dependencies</div>
            <ul class="deps modal-deps">{#each prodDeps.slice(0, 20) as d}<li><span class="dn">{d.name}</span><span class="dv">{d.version}</span></li>{/each}</ul>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

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
  .stack-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .9fr); gap: 16px; align-items: stretch; }
  .stack-main { min-width: 0; }
  .stack-map { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; gap: 8px; align-items: stretch; min-width: 0; }
  .node { min-width: 0; border: 1px solid var(--line); background: rgba(255,255,255,.035); border-radius: 8px; padding: 10px; display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; align-content: center; }
  .node-ic { color: var(--accent); grid-row: span 2; display: grid; place-items: center; }
  .node-t { color: var(--txt); font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .node-m { color: var(--txt-faint); font-family: var(--mono); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .flow { color: var(--txt-faint); display: grid; place-items: center; }

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

  .modal-backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(10,12,15,.72); backdrop-filter: blur(10px); display: grid; place-items: center; padding: 24px; }
  .arch-modal { width: min(1080px, 100%); max-height: min(760px, calc(100vh - 48px)); overflow: auto; background: var(--bg); border: 1px solid var(--line-2); border-radius: 8px; box-shadow: 0 22px 70px rgba(0,0,0,.45); padding: 18px; }
  .modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .modal-title { margin: 0 0 5px; }
  .modal-sub { color: var(--txt-faint); font-family: var(--mono); font-size: 11px; word-break: break-all; }
  .icon-btn { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--txt-dim); cursor: pointer; }
  .icon-btn:hover { color: var(--txt); border-color: var(--line-2); }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; }
  .tabs button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--txt-dim); border-radius: 7px; padding: 7px 10px; font-size: 12px; cursor: pointer; }
  .tabs button.active { background: var(--accent-ghost); border-color: var(--accent-dim); color: var(--accent); }
  .diagram { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; gap: 10px; align-items: center; margin: 10px 0 14px; }
  .arch-node { min-height: 132px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 16px; display: flex; gap: 12px; align-items: flex-start; }
  .arch-node.api { border-color: var(--accent-dim); background: var(--accent-ghost); }
  .arch-ic { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 7px; color: var(--accent); background: rgba(255,255,255,.05); }
  .arch-title { color: var(--txt); font-weight: 800; font-size: 14px; margin-bottom: 6px; }
  .arch-meta { color: var(--txt-dim); font-family: var(--mono); font-size: 11px; line-height: 1.45; }
  .connector { color: var(--txt-faint); display: grid; place-items: center; }
  .insight-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .insight-grid > div, .tab-panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 13px; min-width: 0; }
  .insight-grid .k { display: block; color: var(--txt-faint); font-size: 10px; text-transform: uppercase; letter-spacing: .11em; margin-bottom: 5px; }
  .insight-grid .v { display: block; color: var(--txt); font-size: 12.5px; overflow-wrap: anywhere; }
  .tab-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .tab-h { color: var(--txt-dim); font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: .13em; margin-bottom: 10px; }
  .bullets { margin: 0; padding-left: 18px; color: var(--txt); font-size: 13px; line-height: 1.7; }
  .modal-deps { max-height: 260px; }

  @media (max-width: 900px) {
    .grid, .kv, .stack-layout, .tab-grid, .insight-grid { grid-template-columns: 1fr; }
    .span2 { grid-column: span 1; }
    .stack-map, .diagram { grid-template-columns: 1fr; }
    .flow, .connector { transform: rotate(90deg); min-height: 20px; }
    .arch-modal { max-height: calc(100vh - 24px); }
  }
</style>
