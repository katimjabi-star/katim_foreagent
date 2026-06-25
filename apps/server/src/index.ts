import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { EventLog, MEMORY_LOG, replay, buildRefinePrompt, type ForemanEvent, type Vendor, type Reviewer, type IntakeDoc } from '@foreman/core';
import { EVENT_LOG, FOREMAN_HOME, PORT, WEB_DIST } from './config.ts';
import { startDemo } from './demo.ts';
import { startWatchers } from './watchers/index.ts';
import { Orchestrator } from './control/orchestrator.ts';
import { readProject } from './project-intel.ts';
import { discoverAgents, detectVendors } from './intake.ts';
import { detectMcp } from './mcp.ts';
import { claudeProjectRepos } from './known-repos.ts';
import { streamAi, runAi } from './ai/bridge.ts';
import { readSessionDetail } from './session-detail.ts';
import { listInstalledSkills, getCatalog, getFeed, getTemplates, installSkill, exportSkill } from './marketplace.ts';

type BoardMode = 'live' | 'demo';

const liveLog = new EventLog(EVENT_LOG);
// Demo stays in memory: it should never pollute ~/.foreman/events.jsonl or make
// "live" mode look like the sample board after the user toggles back.
const demoLog = new EventLog(MEMORY_LOG, { cap: 1_000, preserve: 24 });
startDemo(demoLog);

let boardMode: BoardMode = process.env.FOREMAN_DEMO === '1' || process.env.FOREMAN_MODE === 'demo' ? 'demo' : 'live';
const modeListeners = new Set<(mode: BoardMode) => void>();

function activeLog(): EventLog {
  return boardMode === 'demo' ? demoLog : liveLog;
}

function modeInfo(): { mode: BoardMode; eventLog: string; demo: true; live: true } {
  return { mode: boardMode, eventLog: boardMode === 'demo' ? MEMORY_LOG : EVENT_LOG, demo: true, live: true };
}

function setBoardMode(mode: BoardMode): void {
  if (mode === boardMode) return;
  boardMode = mode;
  console.log(`[foreman] board mode → ${mode}`);
  for (const fn of modeListeners) fn(mode);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/** SSE: replay current board as a snapshot, then stream every future append. */
function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  function writeSnapshot(): void {
    const board = replay(activeLog().all()).state(Date.now());
    res.write(`event: snapshot\ndata: ${JSON.stringify(board)}\n\n`);
  }
  function subscribeActive(): () => void {
    return activeLog().subscribe((e: ForemanEvent) => {
      res.write(`event: append\ndata: ${JSON.stringify(e)}\n\n`);
    });
  }

  res.write(`event: mode\ndata: ${JSON.stringify(modeInfo())}\n\n`);
  writeSnapshot();
  let unsub = subscribeActive();
  const unsubMode = (mode: BoardMode): void => {
    unsub();
    res.write(`event: mode\ndata: ${JSON.stringify(modeInfo())}\n\n`);
    writeSnapshot();
    unsub = subscribeActive();
  };
  modeListeners.add(unsubMode);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); modeListeners.delete(unsubMode); unsub(); });
}

/** Serve the built Svelte SPA in prod. In dev, Vite serves the UI and proxies here. */
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = (req.url ?? '/').split('?')[0]!;
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = normalize(join(WEB_DIST, rel));
  if (!filePath.startsWith(normalize(WEB_DIST))) { res.writeHead(403).end('forbidden'); return; }

  if (existsSync(filePath)) {
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(readFileSync(filePath));
    return;
  }
  // SPA fallback → index.html (so client routing works). If no build yet, hint dev mode.
  const index = join(WEB_DIST, 'index.html');
  if (existsSync(index)) {
    res.writeHead(200, { 'content-type': MIME['.html']! });
    res.end(readFileSync(index));
  } else {
    res.writeHead(200, { 'content-type': MIME['.html']! });
    res.end('<h1>Foreman server up</h1><p>No web build found. Run <code>bun run dev</code> (Vite on :5173) or <code>bun run build:web</code> then reload.</p>');
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Boot the real read-side and the control plane. Demo is a separate in-memory log
// selected by /api/mode, so live watchers keep collecting real sessions even while
// the user is looking at the demo board.
const { sessions } = startWatchers(liveLog);
console.log(`[foreman] initial board mode: ${boardMode}`);
const orchestrator = new Orchestrator(liveLog, join(FOREMAN_HOME, 'worktrees'));

// Repos the intake may target = live sessions ∪ projects opened in Claude Code. The
// latter makes a configured-but-idle repo (e.g. one with an MCP server but no live
// transcript) selectable, so its context/MCP can surface. Used by /api/context and as
// the path allow-list for the read-side discovery endpoints.
async function knownRepos(): Promise<Array<{ repo: string; path: string }>> {
  const byPath = new Map<string, { repo: string; path: string }>();
  for (const r of sessions.repos()) byPath.set(r.path, r);
  for (const r of await claudeProjectRepos()) if (!byPath.has(r.path)) byPath.set(r.path, r);
  return [...byPath.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}
async function knownRepoSet(): Promise<Set<string>> {
  return new Set((await knownRepos()).map((r) => r.path));
}

async function handleControl(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method !== 'POST') return false;
  try {
    if (path === '/api/spawn') {
      const b = (await readBody(req)) as {
        taskId?: string; repoPath?: string; vendor?: Vendor; prompt?: string; yolo?: boolean; model?: string;
        skills?: string[]; agents?: string[]; docs?: IntakeDoc[];
      };
      if (!b.taskId || !b.repoPath || !b.prompt) { sendJson(res, 400, { error: 'taskId, repoPath and prompt are required' }); return true; }
      // The control plane may only run in a repo the user already works in.
      if (!(await knownRepoSet()).has(b.repoPath)) { sendJson(res, 403, { error: 'unknown repo path' }); return true; }
      const out = await orchestrator.spawn({
        taskId: b.taskId, repoPath: b.repoPath, vendor: b.vendor ?? 'claude-code', prompt: b.prompt, yolo: b.yolo,
        model: b.model, skills: b.skills, agents: b.agents, docs: b.docs,
      });
      sendJson(res, 200, out);
      return true;
    }
    if (path === '/api/agents/stop') {
      const b = (await readBody(req)) as { agentId?: string };
      sendJson(res, 200, { stopped: b.agentId ? orchestrator.stop(b.agentId) : false });
      return true;
    }
    if (path === '/api/review') {
      const b = (await readBody(req)) as { taskId?: string; approve?: boolean };
      if (!b.taskId) { sendJson(res, 400, { error: 'taskId required' }); return true; }
      await orchestrator.review(b.taskId, b.approve ?? false);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/review/ai') {
      const b = (await readBody(req)) as { taskId?: string; reviewer?: Reviewer };
      if (!b.taskId) { sendJson(res, 400, { error: 'taskId required' }); return true; }
      // Fire-and-forget: the review.requested/ready events stream to the board.
      void orchestrator.aiReview(b.taskId, b.reviewer ?? 'claude-code').catch(() => {});
      sendJson(res, 200, { ok: true });
      return true;
    }
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
    return true;
  }
  return false;
}

// GET /api/project?path=<repoPath> — deterministic stack + git report. The path is
// restricted to repos Foreagent has actually observed, so the API can't be used to
// read arbitrary locations on disk.
async function handleProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const repoPath = url.searchParams.get('path') ?? '';
  if (!repoPath || !(await knownRepoSet()).has(repoPath)) { sendJson(res, 403, { error: 'unknown repo path' }); return; }
  try { sendJson(res, 200, await readProject(repoPath)); }
  catch (e) { sendJson(res, 500, { error: (e as Error).message }); }
}

// GET /api/context — what the New-task wizard should default to: the repo/branch the
// user is most likely targeting (the live session, else the most-recently-touched
// card), plus every known repo for the picker. Lets intake open pre-filled instead of
// making the user re-select what Foreagent already observes.
async function handleContext(res: ServerResponse): Promise<void> {
  // Context/intake are about acting on real repos, not the sample "acme/api"
  // demo board. Keep them pinned to live events even when the board is in demo.
  const board = replay(liveLog.all()).state(Date.now());
  const cards = Object.values(board.cards);
  const live = cards.filter((c) => c.agentStatus === 'running' || c.agentStatus === 'waiting');
  const pick = (live.length ? live : cards).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const reposList = await knownRepos();
  let active: { repo: string; repoPath?: string; branch?: string; sessionId?: string; vendor?: string } | undefined;
  if (pick) {
    const repoPath = sessions.path(pick.sessionId) ?? reposList.find((r) => r.repo === pick.repo)?.path;
    active = { repo: pick.repo, repoPath, branch: pick.branch, sessionId: pick.sessionId, vendor: pick.vendor };
  }
  sendJson(res, 200, { active, repos: reposList });
}

// GET /api/discover/agents?path=<repoPath> — reusable subagents available to the repo
// (project `.claude/agents` + user `~/.claude/agents`). Path is restricted to observed
// repos, same as /api/project, so it can't enumerate arbitrary disk locations.
async function handleDiscoverAgents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const repoPath = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path') ?? '';
  if (!repoPath || !(await knownRepoSet()).has(repoPath)) { sendJson(res, 403, { error: 'unknown repo path' }); return; }
  try { sendJson(res, 200, await discoverAgents(repoPath)); }
  catch (e) { sendJson(res, 500, { error: (e as Error).message }); }
}

// GET /api/mcp?path=<repoPath>&vendor=<vendor> — MCP servers available to that vendor
// for the repo, split into local (project) and global (user) scope. Path is restricted
// to observed repos, same guard as /api/project / /api/discover/agents.
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const repoPath = url.searchParams.get('path') ?? '';
  const vendor = (url.searchParams.get('vendor') ?? 'claude-code') as Vendor;
  if (!repoPath || !(await knownRepoSet()).has(repoPath)) { sendJson(res, 403, { error: 'unknown repo path' }); return; }
  try { sendJson(res, 200, await detectMcp(repoPath, vendor)); }
  catch (e) { sendJson(res, 500, { error: (e as Error).message }); }
}

// AI endpoints (POST, SSE-streamed response). The prompt rides the request BODY, so
// the client reads the stream via fetch() rather than EventSource (which is GET-only).
// repoPath, when given, is validated against observed repos so claude only ever runs
// in a directory the user already works in.
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' };

async function handleAi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method !== 'POST') return false;

  // Prompt refinement is buffered (we want the whole cleaned brief, not a stream) and
  // returns plain JSON. It is fail-safe: if `claude` is unavailable we echo the
  // original back so the intake wizard never blocks the user on a missing binary.
  if (path === '/api/ai/refine') {
    const b = (await readBody(req)) as { prompt?: string };
    if (!b.prompt || !b.prompt.trim()) { sendJson(res, 400, { error: 'prompt required' }); return true; }
    try {
      const refined = await runAi({ prompt: buildRefinePrompt(b.prompt), timeoutMs: 45_000 });
      sendJson(res, 200, { original: b.prompt, refined: refined.trim() || b.prompt });
    } catch (e) {
      sendJson(res, 200, { original: b.prompt, refined: b.prompt, error: (e as Error).message });
    }
    return true;
  }

  const AI_PATHS = ['/api/ai/ask', '/api/ai/summarize', '/api/ai/suggest', '/api/chat/resume'];
  if (!AI_PATHS.includes(path)) return false;

  const b = (await readBody(req)) as { prompt?: string; message?: string; repoPath?: string; sessionId?: string };
  let cwd: string | undefined;
  if (b.repoPath) {
    if (!(await knownRepoSet()).has(b.repoPath)) { sendJson(res, 403, { error: 'unknown repo path' }); return true; }
    cwd = b.repoPath;
  }

  let prompt: string;
  if (path === '/api/ai/summarize') {
    if (!cwd) { sendJson(res, 400, { error: 'repoPath required' }); return true; }
    prompt = 'Summarize this project for an engineer who is new to it, in 4-6 sentences: what it does, its architecture/stack, and its current state. Be concrete and concise. Do not list files.';
  } else if (path === '/api/ai/suggest') {
    if (!cwd) { sendJson(res, 400, { error: 'repoPath required' }); return true; }
    const [project, catalog] = await Promise.all([readProject(cwd), getCatalog()]);
    const names = catalog.map((s) => `${s.name} — ${s.description}`).join('\n');
    const stack = [...project.stack.languages, ...project.stack.frameworks].join(', ') || 'unknown stack';
    // When the wizard passes the task brief, rank skills by relevance to BOTH the
    // stack and the specific task — otherwise fall back to a stack-only recommendation.
    const task = b.prompt?.trim()
      ? `\n\nThe user is about to start this task:\n"""${b.prompt.trim().slice(0, 600)}"""\nWeigh relevance to this task most heavily.`
      : '';
    prompt = `This project uses: ${stack}.${task}\n\nFrom this catalog of available Claude Code skills, recommend the 2-3 most useful and say why in one line each. Only recommend from the list.\n\n${names}`;
  } else if (path === '/api/chat/resume') {
    if (!b.sessionId || !b.message) { sendJson(res, 400, { error: 'sessionId and message required' }); return true; }
    prompt = b.message;
  } else {
    if (!b.prompt) { sendJson(res, 400, { error: 'prompt required' }); return true; }
    prompt = b.prompt;
  }

  res.writeHead(200, SSE_HEADERS);
  streamAi({ prompt, cwd, resumeSessionId: path === '/api/chat/resume' ? b.sessionId : undefined }, res);
  return true;
}

// GET /api/session?id=<sessionId> — full parsed transcript detail, read on demand.
async function handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? '';
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  try {
    const detail = await readSessionDetail(id);
    if (!detail) { sendJson(res, 404, { error: 'session transcript not found' }); return; }
    sendJson(res, 200, detail);
  } catch (e) { sendJson(res, 500, { error: (e as Error).message }); }
}

// Marketplace: skills hub (installed + bundled catalog), What's New feed, templates.
async function handleMarket(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method === 'GET') {
    if (path === '/api/skills') { sendJson(res, 200, { installed: await listInstalledSkills(), catalog: await getCatalog() }); return true; }
    if (path === '/api/feed') { sendJson(res, 200, await getFeed()); return true; }
    if (path === '/api/templates') { sendJson(res, 200, await getTemplates()); return true; }
    if (path === '/api/skills/export') {
      const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
      const skill = await exportSkill(name);
      if (!skill) { sendJson(res, 404, { error: 'not found' }); return true; }
      sendJson(res, 200, skill); return true;
    }
  }
  if (req.method === 'POST' && path === '/api/skills/install') {
    const b = (await readBody(req)) as { id?: string };
    if (!b.id) { sendJson(res, 400, { error: 'id required' }); return true; }
    sendJson(res, 200, await installSkill(b.id)); return true;
  }
  return false;
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]!;
  if (path === '/api/health') return sendJson(res, 200, { ok: true, version: '0.1.0', ...modeInfo() });
  if (path === '/api/mode') {
    if (req.method === 'GET') return sendJson(res, 200, modeInfo());
    if (req.method === 'POST') {
      void readBody(req).then((b) => {
        const requested = (b as { mode?: string }).mode;
        if (requested !== 'live' && requested !== 'demo') return sendJson(res, 400, { error: 'mode must be "live" or "demo"' });
        setBoardMode(requested);
        return sendJson(res, 200, modeInfo());
      }).catch((e) => sendJson(res, 500, { error: (e as Error).message }));
      return;
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (path === '/api/board') return sendJson(res, 200, replay(activeLog().all()).state(Date.now()));
  if (path === '/api/events') return handleEvents(req, res);
  if (path === '/api/repos') return sendJson(res, 200, sessions.repos());
  if (path === '/api/context') { void handleContext(res); return; }
  if (path === '/api/vendors') { void detectVendors().then((v) => sendJson(res, 200, v)).catch((e) => sendJson(res, 500, { error: (e as Error).message })); return; }
  if (path === '/api/agents') return sendJson(res, 200, orchestrator.list());
  if (path === '/api/discover/agents') { void handleDiscoverAgents(req, res); return; }
  if (path === '/api/mcp') { void handleMcp(req, res); return; }
  if (path === '/api/reviewers') return sendJson(res, 200, { reviewers: orchestrator.reviewers() });
  if (path === '/api/project') { void handleProject(req, res); return; }
  if (path === '/api/session') { void handleSession(req, res); return; }
  if (path.startsWith('/api/ai/') || path === '/api/chat/resume') {
    void handleAi(req, res, path).then((handled) => { if (!handled) sendJson(res, 404, { error: 'not found' }); });
    return;
  }
  if (path === '/api/skills' || path === '/api/feed' || path === '/api/templates' || path.startsWith('/api/skills/')) {
    void handleMarket(req, res, path).then((handled) => { if (!handled) sendJson(res, 404, { error: 'not found' }); });
    return;
  }
  if (path.startsWith('/api/')) {
    void handleControl(req, res, path).then((handled) => { if (!handled) sendJson(res, 404, { error: 'not found' }); });
    return;
  }
  return serveStatic(req, res);
});

// Auto-pick a free port: if PORT (or the default) is taken, walk upward a few slots
// rather than crashing — `npx foreman` should always come up somewhere. Persistent
// handlers (not per-attempt callbacks) avoid stale 'listening' listeners firing on a
// later successful bind.
let currentPort = PORT;
let portAttempts = 20;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && portAttempts > 0) {
    portAttempts--;
    console.warn(`[foreman] port ${currentPort} in use, trying ${currentPort + 1}…`);
    server.listen(++currentPort);
  } else {
    console.error(`[foreman] could not bind a port: ${err.message}`);
    process.exit(1);
  }
});
server.on('listening', () => {
  const addr = server.address();
  const bound = addr && typeof addr === 'object' ? addr.port : currentPort;
  console.log(`[foreman] server on http://localhost:${bound}  (events: ${EVENT_LOG})`);
});
server.listen(currentPort);
