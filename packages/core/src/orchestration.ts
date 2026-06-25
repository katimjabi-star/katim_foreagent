import type { Vendor } from './events.ts';

/**
 * Pure orchestration helpers — how to invoke each vendor CLI headlessly and how to
 * name the git worktree an agent runs in. Kept pure (no spawning, no fs) so the
 * exact argv and branch names are unit-testable; the actual process + git work
 * lives in apps/server/src/control.
 *
 * The control model: every spawned agent runs in its OWN git worktree on its OWN
 * branch, fully autonomously (vendor "yolo"/auto-approve), then surfaces a diff to
 * the review gate. Isolation is what makes hands-off execution safe — a bad run is
 * a throwaway branch, never a mutation of the user's working tree.
 */

export interface AgentCommand {
  bin: string;
  args: string[];
}

/** The CLI entrypoint for each vendor (override via PATH or config). */
export const VENDOR_BIN: Record<Vendor, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
  unknown: 'claude',
};

/**
 * Build the headless invocation for a vendor. `yolo` requests the vendor's
 * non-interactive auto-approve mode — appropriate ONLY because we run inside a
 * throwaway worktree behind a review gate. `model`, when given, pins the model the
 * CLI runs with (each vendor's own flag); omit it to use the CLI's own default so
 * the plain spawn path is byte-for-byte unchanged. The model is always passed as a
 * discrete argv entry — never interpolated into a shell string.
 */
export function buildAgentCommand(vendor: Vendor, prompt: string, opts: { yolo?: boolean; model?: string } = {}): AgentCommand {
  const yolo = opts.yolo ?? true;
  const model = opts.model?.trim();
  switch (vendor) {
    case 'claude-code':
    case 'unknown':
      // `-p` = print/headless; permission mode controls autonomy; `--model` pins it.
      return { bin: VENDOR_BIN['claude-code'], args: ['-p', prompt, '--permission-mode', yolo ? 'bypassPermissions' : 'acceptEdits', ...(model ? ['--model', model] : [])] };
    case 'codex':
      // `codex exec` is the non-interactive runner; --full-auto skips approvals; --model pins it.
      return { bin: VENDOR_BIN.codex, args: ['exec', ...(yolo ? ['--full-auto'] : []), ...(model ? ['--model', model] : []), prompt] };
    case 'gemini-cli':
      // `-p` one-shot prompt; `-y` is YOLO/auto-approve; `-m` pins the model.
      return { bin: VENDOR_BIN['gemini-cli'], args: ['-p', prompt, ...(yolo ? ['-y'] : []), ...(model ? ['-m', model] : [])] };
  }
}

/** Filesystem-safe branch name for a task's agent run. */
export function worktreeBranch(taskId: string): string {
  const slug = taskId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
  return `foreman/${slug}`;
}

/**
 * Where intake documents (PRDs/specs the user attaches) are staged inside the
 * agent's worktree. Kept here so the server (which writes the files) and the harness
 * prompt (which tells the agent where to read them) cannot drift apart. Relative to
 * the worktree root; `.foreman/` keeps intake artefacts out of the way of real code.
 */
export const INTAKE_DIR = '.foreman/intake';

/** An attached background document. `content` is optional — when omitted the file is
 *  assumed already staged in the worktree and is referenced by name only. */
export interface IntakeDoc { name: string; content?: string }

export interface HarnessInput {
  /** The (ideally already-refined) task instruction from the user. */
  prompt: string;
  /** Skill names to lean on for this task (installed Claude Code skills). */
  skills?: string[];
  /** Subagent names available/recommended for this task. */
  agents?: string[];
  /** Background documents staged under {@link INTAKE_DIR} in the worktree. */
  docs?: IntakeDoc[];
}

/**
 * Compose the final, harness-engineered prompt handed to a spawned agent — the
 * user's instruction wrapped with the context it should use: which skills to lean
 * on, which subagents are available, and which background documents to read first.
 *
 * Vendor-agnostic on purpose: every CLI takes a single prompt string, so harness
 * assembly happens here (pure, testable) rather than in per-vendor argv. When no
 * extras are supplied it returns the prompt unchanged, so the plain spawn path is
 * byte-for-byte what it was before intake existed.
 */
export function buildHarnessPrompt(input: HarnessInput): string {
  const skills = (input.skills ?? []).filter(Boolean);
  const agents = (input.agents ?? []).filter(Boolean);
  const docs = (input.docs ?? []).filter((d) => d && d.name);
  if (!skills.length && !agents.length && !docs.length) return input.prompt;

  const parts: string[] = ['## Task', input.prompt.trim()];
  if (docs.length) {
    parts.push(
      '',
      '## Background documents',
      `Read these first — they have been placed in \`${INTAKE_DIR}/\` in this worktree:`,
      ...docs.map((d) => `- \`${INTAKE_DIR}/${d.name}\``),
    );
  }
  if (skills.length) {
    parts.push('', '## Skills to use', `Lean on these installed skills where they apply: ${skills.join(', ')}.`);
  }
  if (agents.length) {
    parts.push('', '## Subagents available', `You may delegate to these subagents: ${agents.join(', ')}.`);
  }
  return parts.join('\n');
}

/**
 * Build the instruction for the prompt-refinement pass: correct spelling/grammar and
 * tighten a rough task brief WITHOUT expanding its scope, and return ONLY the cleaned
 * prompt (no commentary). Run headlessly via `claude -p` — same trick as the rest of
 * the AI bridge, so it rides existing CLI auth with no API key.
 */
export function buildRefinePrompt(text: string): string {
  return [
    'You are a precise technical editor. Rewrite the following coding-task brief so it is',
    'clear, correctly spelled, and grammatical. Preserve the original intent and scope exactly —',
    'do NOT add requirements, do NOT answer or perform the task, do NOT add commentary.',
    'Output ONLY the rewritten brief as plain text.',
    '',
    '--- BRIEF ---',
    text.trim(),
    '--- END ---',
  ].join('\n');
}
