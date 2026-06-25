import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { parseAgentMd, VENDOR_BIN, modelsFor, defaultModel, type AgentDef, type Vendor, type ModelOption } from '@foreman/core';
import { CLAUDE_HOME } from './config.ts';

const exec = promisify(execFile);

/**
 * Task-intake discovery: find the reusable subagents available to a repo so the
 * New-task wizard can suggest them. Claude Code reads subagents from two places —
 * the project's `.claude/agents/` and the user's `~/.claude/agents/` — with the
 * project copy winning on name collision; we mirror that precedence here.
 *
 * Pure parsing lives in @foreman/core (parseAgentMd); this module only does the fs
 * walk and is intentionally best-effort: a missing directory or unreadable file is
 * skipped, never fatal.
 */

export interface DiscoveredAgent extends AgentDef {
  /** `project` = repo-local `.claude/agents`; `user` = `~/.claude/agents`. */
  scope: 'project' | 'user';
}

async function readAgentsFrom(dir: string, scope: DiscoveredAgent['scope']): Promise<DiscoveredAgent[]> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }
  const out: DiscoveredAgent[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    try {
      const def = parseAgentMd(await readFile(join(dir, file), 'utf8'), file.replace(/\.md$/, ''));
      if (def) out.push({ ...def, scope });
    } catch { /* unreadable / not an agent file */ }
  }
  return out;
}

export async function discoverAgents(repoPath: string): Promise<DiscoveredAgent[]> {
  const [user, project] = await Promise.all([
    readAgentsFrom(join(CLAUDE_HOME, 'agents'), 'user'),
    readAgentsFrom(join(repoPath, '.claude', 'agents'), 'project'),
  ]);
  // Project agents override user agents of the same name (Claude Code's own rule).
  const byName = new Map<string, DiscoveredAgent>();
  for (const a of [...user, ...project]) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which vendor CLIs are actually installed on this machine — the New-task picker only
 * offers vendors it can really run, and shows where each resolved from. The model
 * catalogue rides along (from @foreman/core) so the UI gets installed vendors AND
 * their model lists in one round trip, with the catalogue as the single source.
 *
 * Mirrors the orchestrator's bin resolution: a `FOREMAN_<VENDOR>_BIN` env override
 * wins, else the default binary name resolved against PATH. Version is best-effort
 * (`<bin> --version`, short timeout); a missing/erroring binary is simply not shown.
 */
export interface VendorInfo {
  vendor: Vendor;
  /** The binary name/path Foreagent will invoke. */
  bin: string;
  /** Absolute resolved path, when found on PATH. */
  path?: string;
  installed: boolean;
  /** First line of `<bin> --version`, when it responds. */
  version?: string;
  /** Models offered for this vendor (from the core catalogue). */
  models: ModelOption[];
  /** Pre-selected model id for the picker. */
  defaultModel?: string;
}

/** Vendors we probe for; `unknown` is never a real CLI. */
const PROBE_VENDORS: Vendor[] = ['claude-code', 'codex', 'gemini-cli'];

/** Resolve a binary name against PATH without a shell (absolute paths checked directly). */
function resolveOnPath(bin: string): string | undefined {
  if (bin.includes('/')) return existsSync(bin) ? bin : undefined;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function probeVersion(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(path, ['--version'], { timeout: 4000, maxBuffer: 1 << 20 });
    return stdout.trim().split('\n')[0]?.slice(0, 80) || undefined;
  } catch { return undefined; }
}

export async function detectVendors(): Promise<VendorInfo[]> {
  return Promise.all(PROBE_VENDORS.map(async (vendor): Promise<VendorInfo> => {
    const override = process.env[`FOREMAN_${vendor.replace(/-/g, '_').toUpperCase()}_BIN`];
    const bin = override || VENDOR_BIN[vendor];
    const path = resolveOnPath(bin);
    const version = path ? await probeVersion(path) : undefined;
    return { vendor, bin, path, installed: !!path, version, models: modelsFor(vendor), defaultModel: defaultModel(vendor) };
  }));
}
