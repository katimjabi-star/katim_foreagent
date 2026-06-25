import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  makeEvent, buildAgentCommand, buildHarnessPrompt, worktreeBranch, INTAKE_DIR,
  type EventLog, type Vendor, type Reviewer, type IntakeDoc,
} from '@foreman/core';
import { isGitRepo, headSha, addWorktree, removeWorktree, diffStat } from './git.ts';

const exec = promisify(execFile);

/** Detect a project's test command from its manifests. Returns null when unknown. */
function detectTestCommand(dir: string): { bin: string; args: string[]; label: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) return { bin: 'npm', args: ['test', '--silent'], label: 'npm test' };
  } catch { /* not a node project */ }
  if (existsSync(join(dir, 'go.mod'))) return { bin: 'go', args: ['test', './...'], label: 'go test ./...' };
  if (existsSync(join(dir, 'Cargo.toml'))) return { bin: 'cargo', args: ['test'], label: 'cargo test' };
  return null;
}

export interface SpawnRequest {
  taskId: string;
  repoPath: string;
  vendor: Vendor;
  prompt: string;
  yolo?: boolean;
  /** Model id to pin the vendor CLI to (its own flag); omit for the CLI default. */
  model?: string;
  /** Intake context: skills/agents to lean on and PRD/spec docs to stage + read. */
  skills?: string[];
  agents?: string[];
  docs?: IntakeDoc[];
}

/** Filesystem-safe name for a staged intake doc — basename only, no traversal. */
function safeDocName(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'doc.md';
}

interface Running {
  agentId: string;
  taskId: string;
  vendor: Vendor;
  repoPath: string;
  worktree: string;
  base: string;
  proc: ChildProcess;
}

/**
 * The control plane: spawns vendor CLIs in isolated git worktrees and reports their
 * lifecycle back into the SAME event log the observers write to — so a controlled
 * agent and an observed session render identically on the board. The review gate is
 * the human checkpoint: a finished agent moves its card to `review` with a diff; the
 * user approves (merge the branch) or rejects (discard the worktree).
 */
export class Orchestrator {
  private running = new Map<string, Running>();
  /** Finished agents whose worktree survives until the human review gate decides. */
  private reviewable = new Map<string, { worktree: string; base: string; repoPath: string }>();
  private seq = 0;

  /** binOverride lets users point a vendor at a custom path/wrapper (and lets tests
   *  inject a stub). Falls back to FOREMAN_<VENDOR>_BIN env vars, then the default. */
  constructor(private log: EventLog, private worktreeRoot: string, private binOverride: Partial<Record<Vendor, string>> = {}) {}

  private binFor(vendor: Vendor, fallback: string): string {
    const env = process.env[`FOREMAN_${vendor.replace(/-/g, '_').toUpperCase()}_BIN`];
    return this.binOverride[vendor] ?? env ?? fallback;
  }

  list(): Array<{ agentId: string; taskId: string; vendor: Vendor; worktree: string }> {
    return [...this.running.values()].map(({ agentId, taskId, vendor, worktree }) => ({ agentId, taskId, vendor, worktree }));
  }

  async spawn(req: SpawnRequest): Promise<{ agentId: string }> {
    const agentId = `ctl:${Date.now().toString(36)}-${(this.seq++).toString(36)}`;

    if (!(await isGitRepo(req.repoPath))) {
      this.log.append(makeEvent('agent.status', { agentId, status: 'error', reason: 'not a git repository' }));
      throw new Error(`not a git repo: ${req.repoPath}`);
    }

    const branch = worktreeBranch(req.taskId);
    const worktree = join(this.worktreeRoot, branch.replace(/\//g, '__'));
    mkdirSync(this.worktreeRoot, { recursive: true });

    let base: string;
    try {
      base = await headSha(req.repoPath);
      await addWorktree(req.repoPath, worktree, branch, base);
      // A fresh worktree has no node_modules; symlink the base repo's so the agent
      // (and our post-run test step) can actually execute. Best-effort, never fatal.
      const baseMods = join(req.repoPath, 'node_modules');
      const wtMods = join(worktree, 'node_modules');
      if (existsSync(baseMods) && !existsSync(wtMods)) { try { symlinkSync(baseMods, wtMods, 'dir'); } catch { /* ignore */ } }
    } catch (e) {
      this.log.append(makeEvent('agent.status', { agentId, status: 'error', reason: `worktree: ${(e as Error).message}` }));
      throw e;
    }

    // Stage any attached intake docs (PRD/specs) into the worktree, then build the
    // harness-engineered prompt that points the agent at them + the chosen skills.
    const staged = this.stageDocs(worktree, req.docs);
    const prompt = buildHarnessPrompt({ prompt: req.prompt, skills: req.skills, agents: req.agents, docs: staged });

    this.log.append(makeEvent('agent.spawned', { agentId, taskId: req.taskId, vendor: req.vendor, worktree: branch }));

    const { bin, args } = buildAgentCommand(req.vendor, prompt, { yolo: req.yolo, model: req.model });
    let proc: ChildProcess;
    try {
      proc = spawn(this.binFor(req.vendor, bin), args, { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.log.append(makeEvent('agent.status', { agentId, status: 'error', reason: `spawn ${bin}: ${(e as Error).message}` }));
      await removeWorktree(req.repoPath, worktree);
      throw e;
    }

    const rec: Running = { agentId, taskId: req.taskId, vendor: req.vendor, repoPath: req.repoPath, worktree, base, proc };
    this.running.set(agentId, rec);

    // Stream tool/markers would come from the vendor's stdout; for v1 we surface
    // coarse lifecycle. (Per-tool streaming is the observer tier's job already.)
    proc.on('error', (err) => {
      this.log.append(makeEvent('agent.status', { agentId, status: 'error', reason: err.message }));
      this.running.delete(agentId);
    });
    proc.on('exit', (code) => { void this.onExit(rec, code ?? 0); });

    return { agentId };
  }

  /** Write attached intake docs under {@link INTAKE_DIR} in the worktree. Returns the
   *  staged docs (names sanitised) so the harness prompt references the real paths. */
  private stageDocs(worktree: string, docs: IntakeDoc[] | undefined): IntakeDoc[] {
    const staged: IntakeDoc[] = [];
    if (!docs?.length) return staged;
    const dir = join(worktree, INTAKE_DIR);
    try { mkdirSync(dir, { recursive: true }); } catch { return staged; }
    for (const d of docs) {
      if (!d?.name || typeof d.content !== 'string') continue;
      const name = safeDocName(d.name);
      try { writeFileSync(join(dir, name), d.content); staged.push({ name }); } catch { /* skip unwritable doc */ }
    }
    return staged;
  }

  private async onExit(rec: Running, code: number): Promise<void> {
    this.running.delete(rec.agentId);
    if (code !== 0) {
      this.log.append(makeEvent('agent.status', { agentId: rec.agentId, status: 'error', reason: `exited ${code}` }));
      return;
    }
    // Success → compute the diff and hand the card to the review gate.
    try {
      const d = await diffStat(rec.worktree, rec.base);
      this.reviewable.set(rec.taskId, { worktree: rec.worktree, base: rec.base, repoPath: rec.repoPath });
      this.log.append(makeEvent('diff.ready', { taskId: rec.taskId, agentId: rec.agentId, files: d.files, added: d.added, removed: d.removed }));
      await this.runTests(rec); // best-effort; emits test.run if a command is known
      this.log.append(makeEvent('task.moved', { taskId: rec.taskId, column: 'review' }));
      this.log.append(makeEvent('agent.status', { agentId: rec.agentId, status: 'done' }));
    } catch (e) {
      this.log.append(makeEvent('agent.status', { agentId: rec.agentId, status: 'error', reason: `diff: ${(e as Error).message}` }));
    }
  }

  /** Run the repo's test command in the worktree and emit test.run. Skips silently
   *  when no command is detected or node deps are missing (keeps the badge honest). */
  private async runTests(rec: Running): Promise<void> {
    const cmd = detectTestCommand(rec.worktree);
    if (!cmd) return;
    if (cmd.bin === 'npm' && !existsSync(join(rec.worktree, 'node_modules'))) return; // can't run without deps
    try {
      await exec(cmd.bin, cmd.args, { cwd: rec.worktree, timeout: 120_000, maxBuffer: 8 << 20 });
      this.log.append(makeEvent('test.run', { taskId: rec.taskId, agentId: rec.agentId, passed: true, command: cmd.label, summary: 'passed' }));
    } catch (e) {
      const err = e as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
      const summary = err.killed ? 'timed out' : ((err.stderr || err.stdout || '').trim().split('\n').slice(-1)[0] || 'failed').slice(0, 140);
      this.log.append(makeEvent('test.run', { taskId: rec.taskId, agentId: rec.agentId, passed: false, command: cmd.label, summary }));
    }
  }

  stop(agentId: string): boolean {
    const rec = this.running.get(agentId);
    if (!rec) return false;
    rec.proc.kill('SIGTERM');
    this.log.append(makeEvent('agent.status', { agentId, status: 'idle', reason: 'stopped by user' }));
    return true;
  }

  /** Review gate: approve → done, reject → back to sliced; discard the worktree. */
  async review(taskId: string, approve: boolean): Promise<void> {
    const rec = this.reviewable.get(taskId) ?? [...this.running.values()].find((r) => r.taskId === taskId);
    const column = approve ? 'done' : 'sliced';
    this.log.append(makeEvent('task.moved', { taskId, column }));
    if (rec) await removeWorktree(rec.repoPath, rec.worktree);
    this.reviewable.delete(taskId);
  }

  /** Which reviewer CLIs resolve on this machine (drives the UI's picker). */
  reviewers(): Reviewer[] {
    const all: Array<[Reviewer, string]> = [['claude-code', 'claude'], ['codex', 'codex'], ['gemini-cli', 'gemini']];
    return all.filter(([v, bin]) => which(this.binFor(v, bin))).map(([v]) => v);
  }

  /**
   * Cross-model code review: run a *different* model over the diff, read-only, and
   * post its findings. The anti-sycophancy pattern — the model that wrote the code
   * shouldn't be the one to grade it. Reuses the surviving review-gate worktree.
   */
  async aiReview(taskId: string, reviewer: Reviewer): Promise<void> {
    const rec = this.reviewable.get(taskId) ?? (() => {
      const r = [...this.running.values()].find((x) => x.taskId === taskId);
      return r ? { worktree: r.worktree, base: r.base, repoPath: r.repoPath } : undefined;
    })();
    if (!rec) throw new Error('no reviewable worktree for this task');

    this.log.append(makeEvent('review.requested', { taskId, reviewer }));
    let diff = '';
    try { diff = (await exec('git', ['-C', rec.worktree, 'diff', rec.base], { maxBuffer: 8 << 20 })).stdout; } catch { /* empty */ }
    if (!diff.trim()) { this.log.append(makeEvent('review.ready', { taskId, reviewer, verdict: 'error', findings: 'No diff to review.' })); return; }

    const prompt = [
      'You are a senior code reviewer. Review this git diff for correctness, security, edge cases, and design fit.',
      'Be concise and specific (file:line where possible). Do NOT modify any files.',
      'End with exactly one line: "VERDICT: APPROVE" or "VERDICT: CHANGES".',
      '', '```diff', diff.slice(0, 60_000), '```',
    ].join('\n');

    const { bin, args } = this.reviewCommand(reviewer, prompt);
    try {
      const out = await this.capture(bin, args, rec.worktree, 180_000);
      const verdict = /VERDICT:\s*APPROVE/i.test(out) ? 'approve' : 'changes';
      this.log.append(makeEvent('review.ready', { taskId, reviewer, verdict, findings: out.trim().slice(0, 8000) || '(no output)' }));
    } catch (e) {
      this.log.append(makeEvent('review.ready', { taskId, reviewer, verdict: 'error', findings: `reviewer failed: ${(e as Error).message}` }));
    }
  }

  private reviewCommand(reviewer: Reviewer, prompt: string): { bin: string; args: string[] } {
    if (reviewer === 'codex') return { bin: this.binFor('codex', 'codex'), args: ['exec', '--read-only', prompt] };
    if (reviewer === 'gemini-cli') return { bin: this.binFor('gemini-cli', 'gemini'), args: ['-p', prompt] };
    return { bin: this.binFor('claude-code', 'claude'), args: ['-p', prompt, '--permission-mode', 'plan'] };
  }

  /** Spawn a read-only reviewer and collect its stdout. */
  private capture(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('review timed out')); }, timeoutMs);
      proc.stdout.on('data', (c) => { out += c; });
      proc.stderr.on('data', (c) => { err += c; });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('exit', (code) => { clearTimeout(timer); code === 0 || out.trim() ? resolve(out) : reject(new Error(err.trim().slice(0, 200) || `exit ${code}`)); });
    });
  }
}

/** PATH lookup without a shell — true when `bin` (or an absolute path) is runnable. */
function which(bin: string): boolean {
  if (bin.includes('/')) return existsSync(bin);
  const dirs = (process.env.PATH ?? '').split(':');
  return dirs.some((d) => d && existsSync(join(d, bin)));
}
