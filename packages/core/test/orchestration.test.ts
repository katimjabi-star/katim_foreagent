import { describe, it, expect } from 'vitest';
import {
  buildAgentCommand, worktreeBranch, VENDOR_BIN,
  buildHarnessPrompt, buildRefinePrompt, INTAKE_DIR,
} from '../src/orchestration.ts';
import { modelsFor, defaultModel, isKnownModel } from '../src/models.ts';

describe('buildAgentCommand', () => {
  it('builds a headless claude invocation, bypassing permissions in yolo mode', () => {
    expect(buildAgentCommand('claude-code', 'do the thing', { yolo: true })).toEqual({
      bin: 'claude',
      args: ['-p', 'do the thing', '--permission-mode', 'bypassPermissions'],
    });
  });
  it('downgrades to acceptEdits when yolo is off', () => {
    expect(buildAgentCommand('claude-code', 'x', { yolo: false }).args).toContain('acceptEdits');
  });
  it('uses `codex exec --full-auto` for codex', () => {
    expect(buildAgentCommand('codex', 'fix bug')).toEqual({ bin: 'codex', args: ['exec', '--full-auto', 'fix bug'] });
  });
  it('uses gemini -p with -y for yolo', () => {
    expect(buildAgentCommand('gemini-cli', 'hi')).toEqual({ bin: 'gemini', args: ['-p', 'hi', '-y'] });
  });
  it('treats unknown vendor as claude', () => {
    expect(buildAgentCommand('unknown', 'x').bin).toBe(VENDOR_BIN['claude-code']);
  });
  it('never interpolates the prompt into a shell string (passed as a discrete arg)', () => {
    const { args } = buildAgentCommand('claude-code', '$(rm -rf /); echo pwned');
    expect(args).toContain('$(rm -rf /); echo pwned'); // verbatim arg, no shell ever sees it
  });

  it('omits the model flag when no model is given (unchanged plain spawn path)', () => {
    expect(buildAgentCommand('claude-code', 'x').args).not.toContain('--model');
    expect(buildAgentCommand('codex', 'x').args).not.toContain('--model');
    expect(buildAgentCommand('gemini-cli', 'x').args).not.toContain('-m');
  });

  it('pins the model with the per-vendor flag when given', () => {
    expect(buildAgentCommand('claude-code', 'x', { model: 'claude-opus-4-8' }).args)
      .toEqual(['-p', 'x', '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-4-8']);
    expect(buildAgentCommand('codex', 'x', { model: 'gpt-5.5' }).args)
      .toEqual(['exec', '--full-auto', '--model', 'gpt-5.5', 'x']);
    expect(buildAgentCommand('gemini-cli', 'x', { model: 'gemini-3-pro-preview' }).args)
      .toEqual(['-p', 'x', '-y', '-m', 'gemini-3-pro-preview']);
  });

  it('treats a blank model as no override', () => {
    expect(buildAgentCommand('claude-code', 'x', { model: '   ' }).args).not.toContain('--model');
  });
});

describe('model catalog', () => {
  it('exposes a non-empty catalogue for each real vendor and none for unknown', () => {
    expect(modelsFor('claude-code').length).toBeGreaterThan(0);
    expect(modelsFor('codex').length).toBeGreaterThan(0);
    expect(modelsFor('gemini-cli').length).toBeGreaterThan(0);
    expect(modelsFor('unknown')).toEqual([]);
  });

  it('defaults Claude to Opus 4.8', () => {
    expect(defaultModel('claude-code')).toBe('claude-opus-4-8');
  });

  it('every vendor with models has exactly one usable default', () => {
    for (const v of ['claude-code', 'codex', 'gemini-cli'] as const) {
      const d = defaultModel(v);
      expect(d).toBeTruthy();
      expect(isKnownModel(v, d!)).toBe(true);
    }
    expect(defaultModel('unknown')).toBeUndefined();
  });

  it('rejects unknown model ids', () => {
    expect(isKnownModel('claude-code', 'gpt-5.5')).toBe(false);
    expect(isKnownModel('codex', 'claude-opus-4-8')).toBe(false);
  });
});

describe('worktreeBranch', () => {
  it('namespaces under foreman/ and sanitises the task id', () => {
    expect(worktreeBranch('sess-abc:12')).toBe('foreman/sess-abc-12');
  });
  it('falls back to foreman/task for an all-symbol id', () => {
    expect(worktreeBranch('///')).toBe('foreman/task');
  });
});

describe('buildHarnessPrompt', () => {
  it('returns the prompt unchanged when no skills/agents/docs are supplied', () => {
    expect(buildHarnessPrompt({ prompt: 'add a /health endpoint' })).toBe('add a /health endpoint');
    expect(buildHarnessPrompt({ prompt: 'x', skills: [], agents: [], docs: [] })).toBe('x');
  });

  it('references staged docs by their intake path', () => {
    const out = buildHarnessPrompt({ prompt: 'build it', docs: [{ name: 'PRD.md' }] });
    expect(out).toContain(`${INTAKE_DIR}/PRD.md`);
    expect(out).toContain('## Background documents');
    expect(out).toContain('## Task');
  });

  it('lists skills and agents when provided', () => {
    const out = buildHarnessPrompt({ prompt: 'go', skills: ['test-author'], agents: ['code-reviewer'] });
    expect(out).toContain('test-author');
    expect(out).toContain('code-reviewer');
  });

  it('drops empty/blank entries defensively', () => {
    const out = buildHarnessPrompt({ prompt: 'go', skills: ['', 'a'], agents: [''], docs: [{ name: '' }] });
    expect(out).toContain('## Skills to use');
    expect(out).not.toContain('## Subagents available');
    expect(out).not.toContain('## Background documents');
  });
});

describe('buildRefinePrompt', () => {
  it('embeds the raw text and forbids scope expansion / task execution', () => {
    const p = buildRefinePrompt('  add hhelth chek  ');
    expect(p).toContain('add hhelth chek');
    expect(p).toMatch(/do NOT add requirements/i);
    expect(p).toMatch(/Output ONLY/i);
  });
});
