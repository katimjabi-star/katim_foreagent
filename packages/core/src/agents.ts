/**
 * Pure parser for Claude Code subagent definitions — `.claude/agents/*.md`.
 *
 * Claude Code (and Codex/Gemini, by convention) describe a reusable subagent as a
 * Markdown file with a YAML frontmatter block. Real-world files use several YAML
 * shapes for the same fields, all of which we must tolerate:
 *
 *   ---                          ---
 *   name: code-reviewer          name: planner
 *   description: One-liner.       description: >-
 *   tools: Read, Grep, Bash        A longer, folded description
 *   model: sonnet                  spread over several lines.
 *   ---                          tools:
 *                                  - Read
 *                                  - Bash
 *                                ---
 *
 * Like every parser in this package it is TOTAL: it returns null on anything it does
 * not understand and never throws. The fs walking lives in apps/server; this stays
 * pure so the frontmatter parsing is unit-testable against fixtures.
 */

export interface AgentDef {
  /** Slug used to invoke the subagent (from `name:`, or the filename fallback). */
  name: string;
  /** One-line summary used to decide relevance when suggesting agents for a task. */
  description: string;
  /** Tool allow-list, when the frontmatter pins one (inline or list form). */
  tools?: string[];
  /** Model override the agent declares (`model: sonnet`), when present. */
  model?: string;
}

type FrontmatterValue = string | string[];

/** Extract the raw text of a leading `---`…`---` YAML frontmatter block. */
function frontmatter(raw: string): string | null {
  // Tolerate a leading BOM / blank lines before the opening fence.
  const m = raw.replace(/^﻿/, '').match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1]! : null;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '').trim();
}

/**
 * Minimal, total YAML-frontmatter reader covering the shapes agent files actually use:
 * `key: value`, block scalars (`key: >` / `>-` / `|` / `|-` with indented body), and
 * block sequences (`key:` followed by `- item` lines). Anything fancier is ignored
 * rather than throwing — we only need a handful of scalar/list fields.
 */
function parseFrontmatter(fm: string): Record<string, FrontmatterValue> {
  const lines = fm.split(/\r?\n/);
  const out: Record<string, FrontmatterValue> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^(\s*)([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = m[2]!;
    const rest = m[3] ?? '';

    // Block scalar: `>` / `>-` (folded) or `|` / `|-` (literal), body is the deeper-
    // indented lines that follow.
    const block = rest.match(/^([|>])[+-]?\s*$/);
    if (block) {
      const body: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() === '') { body.push(''); i++; continue; }
        if (next.length - next.trimStart().length <= indent) break;
        body.push(next.trimStart()); i++;
      }
      out[key] = block[1] === '>'
        ? body.join(' ').replace(/\s+/g, ' ').trim()   // folded → single line
        : body.join('\n').trim();                       // literal → keep newlines
      continue;
    }

    // Block sequence: `key:` with nothing after it, then `- item` lines (at or below
    // the key's indent, per YAML). Falls back to '' when no items follow.
    if (rest === '') {
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const item = lines[i + 1]!.match(/^(\s*)-[ \t]+(.*)$/);
        if (!item || item[1]!.length < indent) break;
        items.push(stripQuotes(item[2]!)); i++;
      }
      out[key] = items.length ? items : '';
      continue;
    }

    out[key] = stripQuotes(rest);
  }
  return out;
}

/**
 * Parse one agent definition file. `fallbackName` (e.g. the filename without `.md`)
 * is used when the frontmatter omits `name:`, so a bare-but-valid agent file still
 * resolves to a usable slug. Returns null when there is no frontmatter at all or no
 * name can be determined.
 */
export function parseAgentMd(raw: string, fallbackName?: string): AgentDef | null {
  const fm = frontmatter(raw);
  if (fm === null) return null;
  const data = parseFrontmatter(fm);

  const nameVal = data.name;
  const name = (typeof nameVal === 'string' && nameVal) || fallbackName?.trim();
  if (!name) return null;

  const desc = data.description;
  const description = typeof desc === 'string' ? desc : Array.isArray(desc) ? desc.join(' ') : '';

  let tools: string[] | undefined;
  const toolsVal = data.tools;
  if (Array.isArray(toolsVal)) tools = toolsVal.filter(Boolean);
  else if (typeof toolsVal === 'string' && toolsVal) tools = toolsVal.split(',').map((t) => t.trim()).filter(Boolean);

  const modelVal = typeof data.model === 'string' ? data.model : undefined;
  const model = modelVal && modelVal !== '*' ? modelVal : undefined;

  return { name, description, tools, model };
}
