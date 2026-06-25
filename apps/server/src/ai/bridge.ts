import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';

/**
 * The single AI seam. Every AI feature (project summary, skill suggestions, Q&A,
 * session chat) runs through `claude -p` — Claude Code's headless print mode — so it
 * rides the user's EXISTING Claude Code auth/subscription. No API key, no separate
 * billing, nothing to configure: if `claude` is on PATH (it is, for our users), AI
 * works. This keeps Foreagent local-first and zero-config.
 *
 * We stream stdout to the browser over Server-Sent Events as it arrives, so long
 * answers render progressively instead of blocking.
 */

export interface AiRequest {
  prompt: string;
  /** cwd for the run (a repo path) so Claude has project context. Optional. */
  cwd?: string;
  /** Resume an existing Claude Code session thread instead of a fresh one. */
  resumeSessionId?: string;
  /** Override the claude binary (mirrors the orchestrator's bin override). */
  bin?: string;
  /** Hard cap (ms) for buffered runs — kill + reject if claude hangs. */
  timeoutMs?: number;
}

function resolveBin(explicit?: string): string {
  return explicit ?? process.env.FOREMAN_CLAUDE_CODE_BIN ?? 'claude';
}

function buildArgs(req: AiRequest): string[] {
  // `-p` headless print; read-only permission mode — the AI bridge must never edit
  // files (that is the control plane's job, behind the review gate).
  const args = ['-p', req.prompt, '--permission-mode', 'plan'];
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  return args;
}

/**
 * Run claude headlessly and stream its stdout to an SSE response. Sends:
 *   event: token  data: <text chunk>
 *   event: done   data: {"ok":true}            (on exit 0)
 *   event: error  data: {"error":"…"}          (spawn failure / non-zero exit)
 * The caller is responsible for having written SSE headers.
 */
export function streamAi(req: AiRequest, res: ServerResponse): void {
  let proc;
  try {
    proc = spawn(resolveBin(req.bin), buildArgs(req), { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
    res.end();
    return;
  }

  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    res.write(`event: token\ndata: ${JSON.stringify(chunk.toString('utf8'))}\n\n`);
  });
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  proc.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });
  proc.on('exit', (code) => {
    if (code === 0) res.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    else res.write(`event: error\ndata: ${JSON.stringify({ error: stderr.trim() || `claude exited ${code}` })}\n\n`);
    res.end();
  });

  // If the client disconnects, kill the child so we don't leak processes.
  res.on('close', () => { if (!proc.killed) proc.kill('SIGTERM'); });
}

/** Buffered (non-streaming) variant — resolves with the full stdout text. A
 *  `timeoutMs` guards against a hung `claude` (the buffered callers have no client
 *  socket to notice a disconnect), killing the child and rejecting. */
export function runAi(req: AiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(resolveBin(req.bin), buildArgs(req), { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(e as Error); return; }
    let out = '', err = '', settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = req.timeoutMs
      ? setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); done(() => reject(new Error('claude timed out'))); }, req.timeoutMs)
      : undefined;
    proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    proc.on('error', (e) => done(() => reject(e)));
    proc.on('exit', (code) => done(() => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `claude exited ${code}`)))));
  });
}
