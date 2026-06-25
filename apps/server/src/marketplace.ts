import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOME } from './config.ts';

/**
 * Marketplace data layer. Curated content (skills catalog, What's New feed,
 * templates) ships as bundled JSON under assets/marketplace — local-first, no
 * network. Installed skills are read live from ~/.claude/skills. Installing a skill
 * is a guarded write: we create the skill folder + SKILL.md and REFUSE to overwrite
 * an existing skill, so we never clobber the user's own work.
 */

// In the published bundle the server is at bin/dist/server.mjs; assets ship at the
// package root. FOREMAN_ASSETS lets the entrypoint pin the absolute location.
function assetsDir(): string {
  if (process.env.FOREMAN_ASSETS) return process.env.FOREMAN_ASSETS;
  // dev: this file is apps/server/src/marketplace.ts → repo root is ../../..
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'marketplace');
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(join(assetsDir(), file), 'utf8')) as T; } catch { return fallback; }
}

export interface CatalogSkill { id: string; name: string; description: string; tags: string[]; skillMd: string; }
export interface InstalledSkill { name: string; description: string; path: string; }

/** Parse the `description:` line out of a SKILL.md frontmatter block. */
function descFromSkillMd(md: string): string {
  const m = md.match(/description:\s*(.+)/);
  return m ? m[1]!.trim() : '';
}

export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  const dir = join(CLAUDE_HOME, 'skills');
  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }
  const out: InstalledSkill[] = [];
  for (const name of entries) {
    const skillPath = join(dir, name);
    try {
      if (!(await stat(skillPath)).isDirectory()) continue;
      const md = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
      out.push({ name, description: descFromSkillMd(md), path: skillPath });
    } catch { /* not a skill dir */ }
  }
  return out;
}

export async function getCatalog(): Promise<CatalogSkill[]> { return readJson<CatalogSkill[]>('skills.json', []); }
export async function getFeed(): Promise<unknown[]> { return readJson<unknown[]>('feed.json', []); }
export async function getTemplates(): Promise<unknown[]> { return readJson<unknown[]>('templates.json', []); }

export interface InstallResult { ok: boolean; error?: string; path?: string; }

/** Install a catalog skill into ~/.claude/skills/<name>/SKILL.md (refuses to overwrite). */
export async function installSkill(id: string): Promise<InstallResult> {
  const skill = (await getCatalog()).find((s) => s.id === id || s.name === id);
  if (!skill) return { ok: false, error: 'unknown skill' };
  const dest = join(CLAUDE_HOME, 'skills', skill.name);
  try { await stat(dest); return { ok: false, error: 'already installed' }; } catch { /* good: doesn't exist */ }
  try {
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), skill.skillMd.endsWith('\n') ? skill.skillMd : skill.skillMd + '\n');
    return { ok: true, path: dest };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Export a skill's SKILL.md text (installed first, else from the catalog). */
export async function exportSkill(name: string): Promise<{ name: string; skillMd: string } | undefined> {
  try {
    const md = await readFile(join(CLAUDE_HOME, 'skills', name, 'SKILL.md'), 'utf8');
    return { name, skillMd: md };
  } catch { /* fall through to catalog */ }
  const c = (await getCatalog()).find((s) => s.name === name || s.id === name);
  return c ? { name: c.name, skillMd: c.skillMd } : undefined;
}
