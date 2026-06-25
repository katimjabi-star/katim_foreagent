import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Vendor } from '@foreman/core';
import { CLAUDE_HOME } from './config.ts';

/**
 * MCP (Model Context Protocol) server discovery for the New-task intake.
 *
 * MCP is how an agent gets extra tools/context, and where those servers are
 * configured differs by vendor AND by scope — the "local vs global" split the
 * intake needs to surface before a run:
 *
 *   Claude Code  user:    ~/.claude.json            .mcpServers
 *                project: ~/.claude.json            .projects[repo].mcpServers   (private/local)
 *                project: <repo>/.mcp.json          .mcpServers                  (shared/committed)
 *   Codex        user:    ~/.codex/config.toml      [mcp_servers.<name>]
 *   Gemini CLI   user:    ~/.gemini/settings.json   .mcpServers
 *                project: <repo>/.gemini/settings.json .mcpServers
 *
 * Availability is vendor-specific: a server wired into Claude is not visible to
 * Codex. So detection is keyed on the *selected* vendor. Everything here is
 * best-effort and read-only — a missing or malformed file is skipped, never fatal.
 */

export interface McpServer {
  name: string;
  vendor: Vendor;
  /** `user` = global (machine-wide); `project` = local to this repo. */
  scope: 'user' | 'project';
  /** Display path of the file it was read from (home collapsed to `~`). */
  source: string;
  /** stdio (a spawned command) or a remote transport (http/sse). */
  transport: 'stdio' | 'http' | 'sse';
  /** For stdio: the command line that launches the server. */
  command?: string;
  /** For http/sse: the server URL. */
  url?: string;
  /**
   * Claude `.mcp.json` (shared) servers require per-project approval before use;
   * `false` means "configured but not yet enabled here". Undefined = always on.
   */
  enabled?: boolean;
}

const HOME = homedir();

/** Collapse an absolute path under $HOME to `~/…` for compact display. */
function tilde(p: string): string {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

async function readJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/** Normalize a vendor's raw server config object into our shape. */
function normalize(name: string, raw: any, vendor: Vendor, scope: McpServer['scope'], source: string): McpServer {
  const url: string | undefined = raw?.url ?? raw?.httpUrl ?? raw?.serverUrl;
  const declared = String(raw?.type ?? '').toLowerCase();
  const transport: McpServer['transport'] =
    declared === 'http' || declared === 'sse' ? declared : url ? 'http' : 'stdio';
  const command = raw?.command
    ? [raw.command, ...(Array.isArray(raw.args) ? raw.args.map(String) : [])].join(' ')
    : undefined;
  return { name, vendor, scope, source: tilde(source), transport, command, url };
}

/** Pull `.mcpServers` (an object of name→config) out of a parsed JSON blob. */
function fromMcpServers(obj: any, vendor: Vendor, scope: McpServer['scope'], source: string): McpServer[] {
  const servers = obj?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).map(([name, raw]) => normalize(name, raw, vendor, scope, source));
}

/**
 * Minimal TOML reader for Codex's `[mcp_servers.<name>]` tables — enough to pull
 * command/args/url without a TOML dependency. Ignores nested tables (e.g. `.env`)
 * and only understands the handful of keys MCP entries use.
 */
export function parseCodexToml(text: string, source: string): McpServer[] {
  const out = new Map<string, { command?: string; args?: string[]; url?: string }>();
  let cur: string | null = null;
  const header = /^\[mcp_servers\.("?)([^."\]]+)\1\]\s*$/;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) {
      const m = header.exec(t);
      cur = m ? (m[2] ?? null) : null; // any other table (incl. mcp_servers.x.env) ends capture
      if (cur && !out.has(cur)) out.set(cur, {});
      continue;
    }
    if (!cur) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    const entry = out.get(cur)!;
    if (key === 'command') entry.command = val.replace(/^["']|["']$/g, '');
    else if (key === 'url') entry.url = val.replace(/^["']|["']$/g, '');
    else if (key === 'args') {
      entry.args = [...val.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
    }
  }

  return [...out.entries()].map(([name, e]) =>
    normalize(name, { command: e.command, args: e.args, url: e.url }, 'codex', 'user', source));
}

/** Claude `.mcp.json` (shared) servers are gated by these settings flags. */
async function claudeEnabledNames(repoPath: string): Promise<{ all: boolean; names: Set<string> }> {
  const names = new Set<string>();
  let all = false;
  for (const f of [
    join(repoPath, '.claude', 'settings.local.json'),
    join(repoPath, '.claude', 'settings.json'),
    join(CLAUDE_HOME, 'settings.json'),
  ]) {
    const s = await readJson(f);
    if (!s) continue;
    if (s.enableAllProjectMcpServers === true) all = true;
    if (Array.isArray(s.enabledMcpjsonServers)) for (const n of s.enabledMcpjsonServers) names.add(String(n));
  }
  return { all, names };
}

async function detectClaude(repoPath: string): Promise<McpServer[]> {
  // `.claude.json` may live at $HOME or under CLAUDE_CONFIG_DIR; try both.
  const cfg = (await readJson(join(HOME, '.claude.json'))) ?? (await readJson(join(CLAUDE_HOME, '.claude.json')));
  const cfgSource = join(HOME, '.claude.json');

  const user = fromMcpServers(cfg, 'claude-code', 'user', cfgSource);
  const projLocal = cfg?.projects?.[repoPath]
    ? fromMcpServers(cfg.projects[repoPath], 'claude-code', 'project', `${cfgSource} (project)`)
    : [];

  const shared = await readJson(join(repoPath, '.mcp.json'));
  let projShared = fromMcpServers(shared, 'claude-code', 'project', '.mcp.json');
  if (projShared.length) {
    const { all, names } = await claudeEnabledNames(repoPath);
    projShared = projShared.map((s) => ({ ...s, enabled: all || names.has(s.name) }));
  }

  // Precedence (Claude's own): local private > project shared > user. Dedupe by name.
  const byName = new Map<string, McpServer>();
  for (const s of [...user, ...projShared, ...projLocal]) byName.set(s.name, s);
  return [...byName.values()];
}

async function detectGemini(repoPath: string): Promise<McpServer[]> {
  const user = fromMcpServers(await readJson(join(HOME, '.gemini', 'settings.json')), 'gemini-cli', 'user', '~/.gemini/settings.json');
  const project = fromMcpServers(await readJson(join(repoPath, '.gemini', 'settings.json')), 'gemini-cli', 'project', '.gemini/settings.json');
  const byName = new Map<string, McpServer>();
  for (const s of [...user, ...project]) byName.set(s.name, s); // project overrides user
  return [...byName.values()];
}

async function detectCodex(): Promise<McpServer[]> {
  try { return parseCodexToml(await readFile(join(HOME, '.codex', 'config.toml'), 'utf8'), '~/.codex/config.toml'); }
  catch { return []; }
}

/** MCP servers available to `vendor` for `repoPath`, sorted project-first then by name. */
export async function detectMcp(repoPath: string, vendor: Vendor): Promise<McpServer[]> {
  const v: Vendor = vendor === 'unknown' ? 'claude-code' : vendor;
  const servers =
    v === 'codex' ? await detectCodex()
    : v === 'gemini-cli' ? await detectGemini(repoPath)
    : await detectClaude(repoPath);
  return servers.sort((a, b) =>
    a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1);
}
