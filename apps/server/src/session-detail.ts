import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTranscriptLine, contextPct, turnCostUsd } from '@foreman/core';
import { CLAUDE_HOME } from './config.ts';

/**
 * On-demand transcript reader for the Session detail view. We deliberately do NOT
 * keep full transcripts in the event log (it would bloat unboundedly); instead we
 * locate and parse the session's .jsonl file when the user opens it. Reuses the same
 * pure parsers as the live watcher, so detail and board never disagree.
 */

export interface DetailMessage { role: string; text: string; ts?: number; }
export interface DetailTool { name: string; detail?: string; ts?: number; }
export interface DetailPoint { ts?: number; pctUsed: number; costCumulative: number; }

export interface SessionDetail {
  sessionId: string;
  cwd?: string;
  model?: string;
  messages: DetailMessage[];
  tools: DetailTool[];
  timeline: DetailPoint[];
  totals: { messages: number; tools: number; costUsd: number; pctUsed: number };
}

/** Find <sessionId>.jsonl under ~/.claude/projects/<slug>/. */
async function findTranscript(sessionId: string): Promise<string | undefined> {
  const projects = join(CLAUDE_HOME, 'projects');
  let slugs: string[];
  try { slugs = await readdir(projects); } catch { return undefined; }
  const target = `${sessionId}.jsonl`;
  for (const slug of slugs) {
    try {
      const files = await readdir(join(projects, slug));
      if (files.includes(target)) return join(projects, slug, target);
    } catch { /* not a dir */ }
  }
  return undefined;
}

const MSG_CAP = 400; // keep payload bounded for very long sessions

export async function readSessionDetail(sessionId: string): Promise<SessionDetail | undefined> {
  const path = await findTranscript(sessionId);
  if (!path) return undefined;
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch { return undefined; }

  const detail: SessionDetail = {
    sessionId, messages: [], tools: [], timeline: [],
    totals: { messages: 0, tools: 0, costUsd: 0, pctUsed: 0 },
  };
  let cost = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const p = parseTranscriptLine(line);
    if (!p) continue;
    if (p.cwd) detail.cwd = p.cwd;
    if (p.model) detail.model = p.model;
    for (const item of p.items) {
      if (item.kind === 'tool') detail.tools.push({ name: item.name, detail: item.detail, ts: p.ts });
      else detail.messages.push({ role: item.role, text: item.text, ts: p.ts });
    }
    if (p.usage) {
      cost += turnCostUsd(p.usage, p.model);
      const pct = contextPct(p.usage, p.model);
      detail.timeline.push({ ts: p.ts, pctUsed: pct, costCumulative: cost });
      detail.totals.pctUsed = pct; // latest
    }
  }

  detail.totals.messages = detail.messages.length;
  detail.totals.tools = detail.tools.length;
  detail.totals.costUsd = cost;
  // Cap messages/tools to the most recent for payload size; timeline stays (small).
  if (detail.messages.length > MSG_CAP) detail.messages = detail.messages.slice(-MSG_CAP);
  if (detail.tools.length > MSG_CAP) detail.tools = detail.tools.slice(-MSG_CAP);
  return detail;
}
