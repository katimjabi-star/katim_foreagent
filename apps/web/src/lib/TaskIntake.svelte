<script lang="ts">
  // The New-task intake console (loop-engineered task intake).
  //
  // Before a brief is even typed, this screen makes the run's CONTEXT unmissable:
  //   • which folder (absolute path) and project,
  //   • which git branch the worktree forks from,
  //   • which vendor CLI will run it — gated on what's actually installed on the host,
  //   • which model that vendor will use (real June-2026 model IDs),
  //   • what kind of code / policy it is (detected stack + CLAUDE.md/AGENTS.md/…),
  //   • which skills and subagents are already available to lean on.
  // Then the brief (with one-click refine, doc upload, and an inert voice affordance),
  // and the chosen vendor/model/skills/agents/docs ride into the harness prompt.
  //
  // Loop-engineering references that shape this flow: the verifier-is-the-bottleneck
  // wedge (O'Reilly "Loop Engineering"; MindStudio) — surface context + a review gate
  // up front so the human stays in the loop. The pre-build clarifying-questions "grill"
  // loop is Phase 2; the seam is marked below.
  import { onMount, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import Button from './Button.svelte';
  import {
    fetchContext, discoverAgents, refinePrompt, spawnAgent, fetchSkills, fetchVendors, fetchProject, streamAi,
    type Vendor, type DiscoveredAgent, type IntakeContext, type InstalledSkill, type CatalogSkill,
    type IntakeDoc, type VendorInfo, type ProjectReport,
  } from './store.svelte.ts';

  const { onclose }: { onclose: () => void } = $props();

  const VENDOR_LABEL: Record<Vendor, string> = {
    'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', unknown: 'Claude Code',
  };

  let ctx = $state<IntakeContext>({ repos: [] });
  let repo = $state('');                 // selected repoPath
  let vendor = $state<Vendor>('claude-code');
  let model = $state('');
  let prompt = $state('');
  let docs = $state<IntakeDoc[]>([]);

  let vendors = $state<VendorInfo[]>([]);
  let project = $state<ProjectReport | null>(null);
  let projLoading = $state(false);

  let agents = $state<DiscoveredAgent[]>([]);
  let selAgents = $state<string[]>([]);
  let installed = $state<InstalledSkill[]>([]);
  let catalog = $state<CatalogSkill[]>([]);
  let selSkills = $state<string[]>([]);

  let refining = $state(false);
  let refineErr = $state('');
  let suggesting = $state(false);
  let suggestText = $state('');
  let micNote = $state(false);
  let busy = $state(false);
  let err = $state('');

  const repoLabel = $derived(ctx.repos.find((r) => r.path === repo)?.repo ?? '');
  const vinfo = $derived(vendors.find((v) => v.vendor === vendor));
  const vendorReady = $derived(!!vinfo?.installed);
  const models = $derived(vinfo?.models ?? []);
  const selModel = $derived(models.find((m) => m.id === model));
  const anyInstalled = $derived(vendors.some((v) => v.installed));
  // Branch comes from the project report (works without a live session) and falls back
  // to the active session's branch — fixes the old "branch only after a session touches
  // the repo" gap.
  const branch = $derived(project?.git?.branch ?? (ctx.active?.repoPath === repo ? ctx.active?.branch : undefined));
  const git = $derived(project?.git);
  const stackList = $derived(project ? [...project.stack.languages, ...project.stack.frameworks] : []);
  const policies = $derived(project?.policies ?? []);

  onMount(async () => {
    const [c, s, v] = await Promise.all([fetchContext(), fetchSkills(), fetchVendors()]);
    ctx = c; installed = s.installed; catalog = s.catalog; vendors = v;
    if (c.active?.repoPath) repo = c.active.repoPath;
    else if (c.repos.length) repo = c.repos[0]!.path;
    // Prefer the active session's vendor when it's installed, else the first installed,
    // else leave the default (the picker will flag it as not installed).
    const wantVendor = c.active?.vendor && c.active.vendor !== 'unknown' ? c.active.vendor : undefined;
    const installedVendors = v.filter((x) => x.installed);
    const pick = (wantVendor && v.find((x) => x.vendor === wantVendor && x.installed)) || installedVendors[0];
    if (pick) vendor = pick.vendor;
    const vm = v.find((x) => x.vendor === vendor);
    model = (vm?.defaultModel ?? vm?.models[0]?.id) ?? '';
  });

  // When the vendor changes (user action), reset the model to that vendor's default
  // unless the current model is still valid for it.
  $effect(() => {
    const v = vendor;
    const list = untrack(() => vendors).find((x) => x.vendor === v)?.models ?? [];
    if (!list.some((m) => m.id === untrack(() => model))) {
      model = (list.find((m) => m.default)?.id ?? list[0]?.id) ?? '';
    }
  });

  // When the repo changes: refresh the project report (folder/branch/stack/policy),
  // discovered agents, and the AI skill suggestion. The suggestion is intentionally NOT
  // re-run on every keystroke (each run spawns claude); `prompt` is read untracked and
  // the user can re-run it with the ↻ button.
  let suggestAbort: AbortController | undefined;
  $effect(() => {
    const path = repo;
    if (!path) { agents = []; project = null; return; }
    projLoading = true;
    fetchProject(path).then((p) => { if (untrack(() => repo) === path) { project = p; projLoading = false; } });
    discoverAgents(path).then((a) => { if (untrack(() => repo) === path) agents = a; });
    untrack(() => runSuggest(path));
  });

  function runSuggest(path: string): void {
    suggestAbort?.abort();
    suggestAbort = new AbortController();
    suggestText = ''; suggesting = true;
    streamAi('/api/ai/suggest', { repoPath: path, prompt }, {
      onToken: (t) => { suggestText += t; },
      onDone: () => { suggesting = false; },
      onError: () => { suggesting = false; },
    }, suggestAbort.signal);
  }

  function toggle(list: string[], name: string): string[] {
    return list.includes(name) ? list.filter((x) => x !== name) : [...list, name];
  }

  async function doRefine(): Promise<void> {
    if (!prompt.trim() || refining) return;
    refining = true; refineErr = '';
    const { refined, error } = await refinePrompt(prompt);
    refining = false;
    if (error) refineErr = error; else prompt = refined;
  }

  async function onFiles(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    for (const f of Array.from(input.files ?? [])) {
      try { const content = await f.text(); docs = [...docs.filter((d) => d.name !== f.name), { name: f.name, content }]; }
      catch { /* unreadable file */ }
    }
    input.value = '';
  }

  async function submit(): Promise<void> {
    if (!repo) { err = 'No repo selected — Foreagent learns repos from active Claude Code sessions.'; return; }
    if (!vendorReady) { err = `${VENDOR_LABEL[vendor]} CLI is not installed on this machine.`; return; }
    if (!prompt.trim()) { err = 'Write a brief for the agent.'; return; }
    busy = true; err = '';
    const taskId = `ctl:${repoLabel || 'task'}-${Date.now().toString(36)}`;
    const res = await spawnAgent({ taskId, repoPath: repo, vendor, model, prompt: prompt.trim(), skills: selSkills, agents: selAgents, docs });
    busy = false;
    if (res.ok) onclose(); else err = res.error ?? 'spawn failed';
  }
</script>

<div class="overlay" onclick={onclose} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && onclose()} role="dialog" aria-label="New task" tabindex="-1">
    <div class="modal-h">
      <span>New task</span>
      <button class="x" onclick={onclose} aria-label="Close"><Icon name="x" size={16} /></button>
    </div>

    <!-- Step 1 · Context (auto-detected, prominent) -->
    <section class="step">
      <div class="step-h"><span class="num">1</span> Context</div>

      {#if ctx.repos.length}
        <!-- Project + vendor + model selectors -->
        <div class="row">
          <label class="fld">Project
            <select bind:value={repo}>
              {#each ctx.repos as r}<option value={r.path}>{r.repo}</option>{/each}
            </select>
          </label>
          <label class="fld">Run with
            <select bind:value={vendor}>
              {#each vendors as v}
                <option value={v.vendor} disabled={!v.installed}>
                  {VENDOR_LABEL[v.vendor]}{v.installed ? '' : ' · not installed'}
                </option>
              {/each}
            </select>
          </label>
          <label class="fld">Model
            <select bind:value={model} disabled={!models.length}>
              {#if !models.length}<option value="">CLI default</option>{/if}
              {#each models as m}<option value={m.id}>{m.label}{m.note ? ` · ${m.note.split(' · ')[0]}` : ''}</option>{/each}
            </select>
          </label>
        </div>

        <!-- The unmissable run target: folder · project · branch · model · stack · policy -->
        <div class="ctxcard">
          <div class="cc-row">
            <span class="cc-k"><Icon name="project" size={12} /> Project</span>
            <span class="cc-v">{repoLabel || '—'}</span>
          </div>
          <div class="cc-row">
            <span class="cc-k"><Icon name="box" size={12} /> Folder</span>
            <span class="cc-v path" title={repo}>{repo || '—'}</span>
          </div>
          <div class="cc-row">
            <span class="cc-k"><Icon name="git" size={12} /> Branch</span>
            <span class="cc-v">
              {#if projLoading && !project}<span class="dim">resolving…</span>
              {:else if branch}
                <code>{branch}</code>
                {#if git}<span class="gitmeta">{#if git.dirty}· {git.dirty} dirty{/if}{#if git.ahead}· ↑{git.ahead}{/if}{#if git.behind}· ↓{git.behind}{/if}</span>{/if}
                <span class="dim">→ forks <code>foreman/…</code></span>
              {:else}<span class="dim">not a git repo</span>{/if}
            </span>
          </div>
          <div class="cc-row">
            <span class="cc-k"><Icon name="sparkles" size={12} /> Model</span>
            <span class="cc-v">
              {#if selModel}
                <code>{selModel.id}</code>
                {#if selModel.context}<span class="gitmeta">· {selModel.context} ctx</span>{/if}
                {#if selModel.priceIn != null}<span class="gitmeta">· ${selModel.priceIn}/${selModel.priceOut} per Mtok</span>{/if}
              {:else}<span class="dim">{VENDOR_LABEL[vendor]} CLI default</span>{/if}
            </span>
          </div>
          <div class="cc-row">
            <span class="cc-k"><Icon name="market" size={12} /> Stack</span>
            <span class="cc-v">
              {#if stackList.length}{#each stackList.slice(0, 8) as s}<span class="tag">{s}</span>{/each}
              {:else if projLoading}<span class="dim">detecting…</span>
              {:else}<span class="dim">no manifests detected</span>{/if}
            </span>
          </div>
          <div class="cc-row">
            <span class="cc-k"><Icon name="check" size={12} /> Policy</span>
            <span class="cc-v">
              {#if policies.length}{#each policies as p}<span class="tag policy">{p}</span>{/each}
              {:else if projLoading}<span class="dim">checking…</span>
              {:else}<span class="dim">no policy files (CLAUDE.md, AGENTS.md…)</span>{/if}
            </span>
          </div>
        </div>

        <!-- Vendor install provenance + warnings -->
        <div class="ctxline">
          {#if vinfo?.installed}
            <span class="pill ok"><span class="d"></span> {VENDOR_LABEL[vendor]} ready</span>
            {#if vinfo.version}<span class="dim small">{vinfo.version}</span>{/if}
            {#if vinfo.path}<span class="dim small path" title={vinfo.path}>{vinfo.path}</span>{/if}
          {:else}
            <span class="pill warn">⚠ {VENDOR_LABEL[vendor]} CLI not found on PATH</span>
            {#if anyInstalled}<span class="dim small">pick an installed vendor above</span>{/if}
          {/if}
        </div>
        {#if !anyInstalled}
          <div class="dim small">No vendor CLI detected (claude / codex / gemini). Install one and reopen.</div>
        {/if}
      {:else}
        <div class="dim small">No repos observed yet. Foreagent learns repos from active Claude Code sessions — start one (or open this project) and reopen.</div>
      {/if}
    </section>

    <!-- Step 2 · Brief -->
    <section class="step">
      <div class="step-h"><span class="num">2</span> Brief</div>
      <div class="brief">
        <textarea bind:value={prompt} rows="4" placeholder="e.g. Add a /health endpoint with a test"></textarea>
        <div class="tools">
          <button class="tool" onclick={doRefine} disabled={refining || !prompt.trim()} title="Fix spelling & grammar (claude -p)">
            <Icon name="sparkles" size={14} /> {refining ? 'Refining…' : 'Refine'}
          </button>
          <label class="tool" title="Attach PRD / spec (.md, .txt)">
            <Icon name="paperclip" size={14} /> Attach
            <input type="file" accept=".md,.markdown,.txt,text/*" multiple onchange={onFiles} hidden />
          </label>
          <button class="tool" class:on={micNote} onclick={() => (micNote = !micNote)} title="Voice input (coming soon)">
            <Icon name="mic" size={14} /> Voice
          </button>
        </div>
      </div>
      {#if micNote}<div class="dim small note">🎤 Voice input is coming soon — the brief is text-only for now.</div>{/if}
      {#if refineErr}<div class="dim small note">Refine unavailable ({refineErr}); brief left unchanged.</div>{/if}

      {#if docs.length}
        <div class="docs">
          {#each docs as d}
            <span class="chip doc">
              <Icon name="box" size={12} /> {d.name}
              <button class="chip-x" onclick={() => (docs = docs.filter((x) => x.name !== d.name))} aria-label="Remove {d.name}"><Icon name="x" size={11} /></button>
            </span>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Skills + agents -->
    <section class="step">
      <div class="step-h">
        <span class="num"><Icon name="sparkles" size={12} /></span> Skills &amp; agents
        <button class="re" onclick={() => repo && runSuggest(repo)} disabled={!repo || suggesting} title="Re-suggest for this task">
          ↻ {suggesting ? 'thinking…' : 're-suggest'}
        </button>
      </div>

      {#if installed.length}
        <div class="grp-label">Skills <span class="dim">— picked skills are injected into the agent's harness</span></div>
        <div class="chips">
          {#each installed as s}
            <button class="chip" class:sel={selSkills.includes(s.name)} title={s.description} onclick={() => (selSkills = toggle(selSkills, s.name))}>
              {#if selSkills.includes(s.name)}<Icon name="check" size={11} />{/if}{s.name}
            </button>
          {/each}
        </div>
      {:else}
        <div class="dim small">No skills installed — add some in the Marketplace.</div>
      {/if}

      {#if agents.length}
        <div class="grp-label">Subagents <span class="dim">— from .claude/agents (project + user)</span></div>
        <div class="chips">
          {#each agents as a}
            <button class="chip" class:sel={selAgents.includes(a.name)} title={`${a.description}${a.scope === 'project' ? ' · project' : ' · user'}`} onclick={() => (selAgents = toggle(selAgents, a.name))}>
              {#if selAgents.includes(a.name)}<Icon name="check" size={11} />{:else}<Icon name="agent" size={11} />{/if}{a.name}
            </button>
          {/each}
        </div>
      {:else}
        <div class="dim small">No subagents in this repo's <code>.claude/agents</code> (or your user agents).</div>
      {/if}

      {#if suggestText || suggesting}
        <div class="suggest"><span class="dim small">Recommended</span><div class="suggest-body">{suggestText}{#if suggesting}<span class="caret">▍</span>{/if}</div></div>
      {/if}
    </section>

    <div class="foot">
      <div class="dim small">Runs autonomously in an isolated worktree (<code>foreman/…</code>), then lands in <b>In Review</b> with a diff. A clarifying-questions step is coming next.</div>
      {#if err}<div class="err">{err}</div>{/if}
      <div class="actions">
        <button class="btn-ghost" onclick={onclose}>Cancel</button>
        <Button disabled={busy || !ctx.repos.length || !vendorReady} onclick={submit}>{busy ? 'Starting…' : 'Start agent'}</Button>
      </div>
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.62); backdrop-filter: blur(3px); display: grid; place-items: center; z-index: 50; }
  .modal { width: 600px; max-width: 94vw; max-height: 90vh; overflow-y: auto; background: rgba(18,22,28,.9); border: 1px solid var(--line-2); border-radius: var(--r-lg); padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--shadow-lg); }
  .modal-h { display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 15px; letter-spacing: .02em; }
  .x { background: none; border: none; color: var(--txt-faint); cursor: pointer; padding: 4px; border-radius: 6px; }
  .x:hover { color: var(--txt); background: var(--panel); }

  .step { display: flex; flex-direction: column; gap: 8px; }
  .step-h { display: flex; align-items: center; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--txt-dim); }
  .num { display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: var(--panel-2); border: 1px solid var(--line-2); color: var(--accent); font-size: 10px; font-weight: 700; }
  .re { margin-left: auto; background: none; border: 1px solid var(--line); color: var(--txt-dim); border-radius: 6px; padding: 2px 7px; font-size: 10px; cursor: pointer; text-transform: none; letter-spacing: normal; }
  .re:hover:not(:disabled) { color: var(--txt); border-color: var(--line-2); }
  .re:disabled { opacity: .5; cursor: default; }

  .row { display: flex; gap: 10px; }
  .fld { flex: 1; display: flex; flex-direction: column; gap: 5px; font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--txt-dim); min-width: 0; }
  select, textarea { background: var(--panel-2); border: 1px solid var(--line); color: var(--txt); border-radius: 7px; padding: 8px 10px; font-size: 13px; font-family: var(--mono); text-transform: none; letter-spacing: normal; }
  select:disabled { opacity: .55; }
  textarea { resize: vertical; width: 100%; box-sizing: border-box; }
  select:focus, textarea:focus { outline: none; border-color: var(--accent-dim); }

  /* The context card — the run target, made unmissable. */
  .ctxcard { display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  .cc-row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 11px; border-bottom: 1px solid var(--line); }
  .cc-row:last-child { border-bottom: none; }
  .cc-k { flex: 0 0 84px; display: inline-flex; align-items: center; gap: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--txt-faint); padding-top: 2px; }
  .cc-v { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; font-size: 12.5px; color: var(--txt); }
  .cc-v code { font-family: var(--mono); color: var(--accent); font-size: 12px; }
  .cc-v.path { font-family: var(--mono); font-size: 11.5px; color: var(--txt-dim); word-break: break-all; }
  .gitmeta { font-family: var(--mono); font-size: 10.5px; color: var(--txt-faint); }
  .tag { font-family: var(--mono); font-size: 10.5px; color: var(--txt-dim); background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }
  .tag.policy { color: var(--accent); border-color: var(--accent-dim); }

  .ctxline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; color: var(--txt-dim); background: var(--panel); border: 1px solid var(--line); border-radius: 20px; padding: 2px 9px; }
  .pill.ok { color: var(--ok); border-color: rgba(86,190,128,.35); }
  .pill.ok .d { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  .pill.warn { color: var(--warn); border-color: rgba(230,172,51,.35); }
  .path { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .brief { position: relative; }
  .tools { display: flex; gap: 6px; margin-top: 6px; }
  .tool { display: inline-flex; align-items: center; gap: 5px; background: var(--panel-2); border: 1px solid var(--line); color: var(--txt-dim); border-radius: 7px; padding: 5px 9px; font-size: 11px; cursor: pointer; }
  .tool:hover:not(:disabled) { color: var(--txt); border-color: var(--line-2); }
  .tool:disabled { opacity: .5; cursor: default; }
  .tool.on { color: var(--accent); border-color: var(--accent-dim); }
  .note { margin-top: -2px; }

  .docs, .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; background: var(--panel-2); border: 1px solid var(--line); color: var(--txt-dim); border-radius: 20px; padding: 4px 11px; font-size: 11.5px; cursor: pointer; font-family: var(--mono); }
  .chip:hover { color: var(--txt); border-color: var(--line-2); }
  .chip.sel { color: var(--accent); border-color: var(--accent-dim); background: rgba(230,172,51,.08); }
  .chip.doc { cursor: default; color: var(--txt-dim); }
  .chip-x { background: none; border: none; color: var(--txt-faint); cursor: pointer; padding: 0 0 0 2px; display: inline-flex; }
  .chip-x:hover { color: #e0726b; }
  .grp-label { font-size: 11px; color: var(--txt-dim); margin-top: 2px; }

  .suggest { display: flex; flex-direction: column; gap: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; margin-top: 4px; }
  .suggest-body { font-size: 12px; color: var(--txt-dim); white-space: pre-wrap; line-height: 1.45; }
  .caret { color: var(--accent); animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  .foot { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
  .dim { color: var(--txt-faint); }
  .small { font-size: 10px; }
  .err { color: #e0726b; font-size: 12px; font-family: var(--mono); }
  code { font-family: var(--mono); color: var(--accent); }
  .btn-ghost { background: none; border: 1px solid var(--line); color: var(--txt-dim); border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
  .btn-ghost:hover { color: var(--txt); border-color: var(--line-2); }
</style>
