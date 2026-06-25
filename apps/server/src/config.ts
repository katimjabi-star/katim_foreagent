import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code persists its state — Foreman's read-only integration surface.
 * CLAUDE_CONFIG_DIR is Claude Code's own override; we honor it first, then our
 * legacy CLAUDE_HOME, then the default.
 */
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME ?? join(homedir(), '.claude');

/** Where Codex persists rollout transcripts. */
export const CODEX_HOME = process.env.CODEX_CONFIG_DIR ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');

/** Foreman's own data dir (the event log + hook spool live here). */
export const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman');
export const EVENT_LOG = join(FOREMAN_HOME, 'events.jsonl');
export const HOOK_SPOOL = join(FOREMAN_HOME, 'hooks.jsonl');

export const PORT = Number(process.env.PORT ?? 3777);

/** Static web build (served in prod / by `npx foreman`). Vite owns it in dev. */
export const WEB_DIST = process.env.FOREMAN_WEB_DIST ?? join(import.meta.dirname, '../../web/dist');
