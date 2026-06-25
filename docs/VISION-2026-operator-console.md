# Foreagent → the Operator Console for the agent loop (2026 vision)

> Status: strategy / architecture. Additive only — every capability below is a new
> `ForemanEvent` type + a renderer. The existing observe→control board stays intact.

## TL;DR — what Foreagent should *be*

In June 2026 the field renamed itself. The skill ladder is now:

**prompt engineering → context engineering → harness engineering → loop engineering.**
Each wraps the previous. (Steinberger framed it; Osmani named "Loop Engineering.")

- **Harness** = the environment the agent runs in (codebase made legible, executable, verifiable; tools, MCP, permissions).
- **Loop** = goal → act → check → update state → decide (continue / retry / stop / escalate).
- The canonical "Operator Loop Stack" has five layers: **harness · loop contract · state layer · checker · human checkpoint.** The recurring punchline: **"the verifier is the bottleneck, not the model."**

**Foreagent's wedge: be the console for the checker + human-checkpoint layers, across many agents, vendors, and models, on one event spine, local-first, riding existing CLI auth.** Not another agent — *mission control for everyone else's loops.* That's the thing nobody ships as a unified product.

---

## Reconciled capability map

Legend — Foreagent today: ✅ solid · 🟡 partial · ❌ missing.

| Capability (2026 concept) | Exists in ecosystem? | Foreagent today | What to build | New event(s) |
|---|---|---|---|---|
| Token/cost/context meters | ccusage, CC Usage Monitor, `/usage` | ✅ real `usage`→ctx%/cost, dumb-zone 40% | burn-rate + limit-ETA | `context.snapshot` (extend) |
| Running/idle/waiting status | CC hooks | ✅ via hooks | — | `agent.status` |
| Worktree isolation + diff + human review | Vibe Kanban, Conductor, Crystal, Codex | ✅ orchestrator + review gate | — | `agent.spawned`, `diff.ready` |
| **Loop visibility** (goal, iteration, verifier verdict, stop/retry/escalate) | mostly absent in UIs | ❌ | render the loop contract + checker results | `loop.*` (new) |
| **Subagent tree** (CC nests 5 deep; dynamic workflows = 10s–100s bg agents) | weak everywhere | ❌ `SubagentStop` only keeps parent running | parent→child tree, per-node tools/cost/status | `agent.spawned` (add `parentId`), `subagent.*` |
| **Multi-model orchestration** (Sakana Fugu / AB-MCTS / TreeQuest) | Fugu (as a model), TreeQuest (lib) | ❌ single agent per task | route/branch across Claude·Codex·Gemini; show which model owns each branch | `route.*`, `agent.spawned.model` |
| **Cross-model code review** (Codex⇄Claude anti-sycophancy) | Codex plugin for Claude Code | ❌ review is human-only | a Review action: pick reviewer (Claude/Codex/Gemini), run in worktree, post findings; badge "reviewed by X" | `review.requested/ready` |
| **MCP** (consume + expose; 2026-07-28 spec) | huge ecosystem, ~2k registry servers | ❌ none | (a) ingest MCP tool spans as observability; (b) expose Foreagent as an MCP server (Server Card + Tasks ext) | `mcp.tool.used`, `mcp.server.seen` |
| Branch / active-work / testing **on the board** | partial in point tools | 🟡 git intel exists in Project tab, not per-card; `testsGreen` schema unused | surface branch + current step + test status per card | `git.snapshot`, `test.run` |
| Error / limit / auth / compaction alerts | CC Usage Monitor (limits only) | 🟡 errors only for spawned agents | parse `tool_result.is_error`, usage-limit/429/auth, wire `PreCompact` | `agent.status:error`, `context.compacted` |
| **OTel GenAI export/ingest** (CNCF semconv: agent/workflow/tool/model spans) | standardizing in 2026 | ❌ | emit our events as GenAI spans/metrics; optional ingest | exporter, not an event |
| **Capability radar / auto-adapt** ("show new updates, adapt every time") | nobody | 🟡 static marketplace "What's New" | scheduled `claude -p` research loop → flags model/MCP/CC/orchestration changes + "adopt X" | `feed.item` (live) |

---

## The pillars (deep dives)

### 1. Loop & harness visibility — "what are the agents actually doing"
Render the **loop**, not just a card. For each active agent show its **loop contract** (goal, max iterations/budget, stop condition), a live **iteration timeline** (act → checker verdict → decision), and the **checker** output (tests, lint, types, the cross-model reviewer). Because *the verifier is the bottleneck*, the checker pane is the hero of the UI — make verifier results first-class, not a footnote. Human-checkpoint events (needs approval / escalation) bubble to a dedicated **Attention rail**.

### 2. Subagent + multi-model orchestration tree (Sakana Fugu / AB-MCTS lens)
Claude Code subagents nest up to 5 deep and dynamic workflows fan out to hundreds of background agents. Visualize this as a **live tree**: parent task → subagents, each node with its own status, tools, tokens, cost, and model. Frame it with the AB-MCTS mental model (Sakana's TreeQuest): each node is a branch the orchestrator chose to **expand / deepen / switch-model**. Sakana **Fugu** packages multi-agent orchestration *as a model* (select→delegate→verify→synthesize behind one endpoint); we can treat Fugu (or our own router) as one selectable "vendor" and still visualize its internal delegation if it emits structure. Add `parentId` to `agent.spawned` — that one field unlocks the tree on the existing spine.

### 3. Cross-model code review (the button you asked for)
The 2026 anti-sycophancy pattern: **the model that wrote the code must not be the one that grades it.** Add a **Review** action on any card/diff: choose the reviewer model (Claude / Codex / Gemini / Fugu), Foreagent spawns it read-only against the worktree diff, and posts structured findings into the review gate with a clear **"reviewed by Codex"** badge. This is `review.requested → review.ready`, reusing the worktree + diff machinery we already have. It directly leverages the Codex-plugin-for-Claude-Code cross-provider review loop.

### 4. MCP — both directions (2026-07-28 spec)
- **Consume**: MCP tool calls are part of "what the agent did." Ingest them as `mcp.tool.used` spans; show which MCP servers a session touched (and surface MCP **Server Cards** discovered via `.well-known`).
- **Expose**: ship Foreagent itself as an **MCP server** so any agent can query board state / spawn / request a review programmatically. Use the new **Tasks extension** (long-running work) for agent runs and **MCP Apps** (server-rendered UI) to embed the board inside other clients. Stateless core + OAuth/OIDC means this scales cleanly later.

### 5. Branch / active-work / testing on the main dashboard
We already read git branch/remote/dirty/ahead-behind/commits (`project-intel.ts`) — but only in the Project tab. Promote it: each active card shows its **branch**, a one-line **current step** (from the loop contract / last tool), and a **test badge** (`testsGreen` is already in the schema — wire the orchestrator/harness to actually run the project's test command and emit `test.run`). This makes the board answer "which branch, doing what, tests passing?" at a glance.

### 6. Error / limit / auth / compaction alerting
Parse `tool_result.is_error` and system/error lines (today the transcript parser drops them); detect usage-limit / 429 / auth-expiry; wire the `PreCompact` hook + capture the `Notification` message *text* so "waiting" tells you the actual question. Surface all of it in the Attention rail with severities.

### 7. OTel GenAI conventions — standards-aligned observability
Emit Foreagent events as **OpenTelemetry GenAI** spans/metrics (agent / workflow / tool / model spans + token & latency metrics; CNCF-backed, stabilizing through 2026). Benefit: drop Foreagent into an existing Grafana/Datadog/Honeycomb stack with no rewrite, and optionally *ingest* OTel from non-CLI agents — making Foreagent vendor-neutral beyond the three CLIs.

### 8. Capability radar — the "adapt every time" engine
You explicitly want the tool to surface new AI developments and tell you to adopt them. Build a **scheduled `claude -p` research loop** (rides existing auth, no API key) that watches model releases, the MCP spec, Claude Code / Codex changelogs, and new orchestration techniques, then writes `feed.item` events with a **"recommended action for your harness."** Our static marketplace "What's New" becomes a live, self-updating capability radar. This is itself a loop-engineering artifact (goal → fetch → verify → summarize → stop).

---

## Unique positioning (honest)
Every individual piece has a point solution: orchestration (Vibe Kanban / Conductor / Codex), usage (ccusage / Usage Monitor), tracing (OTel / Langfuse / Helicone), multi-model (Fugu / TreeQuest), cross-model review (Codex plugin). **None unify them.** Foreagent's defensible bet is the **operator console**: observe + loop/verifier visibility + multi-agent/multi-model tree + cross-model review + human-checkpoint + capability radar, **local-first, vendor-neutral, on one replayable event spine, using your existing CLI subscriptions (no API keys).** The architecture decision that already exists — observers and controllers emit the *same* events — is exactly what makes this unification cheap.

## Phased roadmap (each phase = events + renderers; nothing destructive)
1. **Attention + truth** (highest signal/lowest cost): `Notification` text, error/limit/auth detection, `PreCompact`, branch + test badges on cards. 
2. **Loop & tree**: `parentId` subagent tree, loop-contract/iteration/checker rendering.
3. **Cross-model review button**: `review.requested/ready` reusing worktree+diff.
4. **MCP expose + OTel export**: Foreagent as MCP server (Tasks ext) + GenAI span exporter.
5. **Multi-model routing + capability radar**: AB-MCTS-style routing across vendors; scheduled research loop feeding the radar.

## References
- Sakana Fugu — multi-agent orchestration as a model: https://sakana.ai/fugu-beta/
- Sakana TreeQuest / AB-MCTS: https://venturebeat.com/ai/sakana-ais-treequest-deploy-multi-model-teams-that-outperform-individual-llms-by-30
- Sakana Marlin (8-hour autonomous research agent): https://www.marktechpost.com/2026/06/15/sakana-ai-marlin/
- Loop Engineering (Osmani / overview): https://tosea.ai/blog/loop-engineering-ai-agents-complete-guide-2026 · https://www.jacknjoroge.com/loop-engineering/
- Harness engineering (awesome list): https://github.com/ai-boost/awesome-harness-engineering
- MCP 2026-07-28 release candidate / roadmap: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ · https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/
- MCP Registry: https://registry.modelcontextprotocol.io/
- Claude Code skills/hooks/subagents: https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more
- Codex cross-provider review plugin: https://www.mindstudio.ai/blog/openai-codex-plugin-claude-code-cross-provider-review
- OTel GenAI semantic conventions: https://mlflow.org/docs/latest/genai/tracing/opentelemetry/genai-semconv/
