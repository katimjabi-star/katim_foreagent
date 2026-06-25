import { describe, it, expect } from 'vitest';
import { parseAgentMd } from '../src/agents.ts';

describe('parseAgentMd', () => {
  it('parses name, description, tools, and model from frontmatter', () => {
    const md = [
      '---',
      'name: code-reviewer',
      'description: Independent review of changed code.',
      'tools: Read, Grep, Glob, Bash',
      'model: sonnet',
      '---',
      'You are a careful reviewer.',
    ].join('\n');
    expect(parseAgentMd(md)).toEqual({
      name: 'code-reviewer',
      description: 'Independent review of changed code.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      model: 'sonnet',
    });
  });

  it('falls back to the filename when name is omitted', () => {
    const md = '---\ndescription: does things\n---\nbody';
    expect(parseAgentMd(md, 'explore')?.name).toBe('explore');
  });

  it('returns null when there is no frontmatter at all', () => {
    expect(parseAgentMd('# Just a heading\n\nno frontmatter here', 'x')).toBeNull();
  });

  it('returns null when neither frontmatter name nor a fallback is available', () => {
    expect(parseAgentMd('---\ndescription: x\n---\n')).toBeNull();
  });

  it('strips quotes and treats model: * as no override', () => {
    const md = '---\nname: "planner"\ndescription: \'plans\'\nmodel: *\n---\n';
    expect(parseAgentMd(md)).toEqual({ name: 'planner', description: 'plans', tools: undefined, model: undefined });
  });

  it('tolerates CRLF line endings', () => {
    const md = '---\r\nname: win\r\ndescription: crlf\r\n---\r\nbody';
    expect(parseAgentMd(md)?.name).toBe('win');
  });

  it('folds a `>-` block-scalar description into one line', () => {
    const md = [
      '---',
      'name: planner',
      'description: >-',
      '  A longer description that the author',
      '  wrapped across several indented lines.',
      'model: sonnet',
      '---',
      'body',
    ].join('\n');
    const def = parseAgentMd(md)!;
    expect(def.description).toBe('A longer description that the author wrapped across several indented lines.');
    expect(def.model).toBe('sonnet');
  });

  it('reads list-form tools (block sequence)', () => {
    const md = [
      '---',
      'name: explorer',
      'description: searches',
      'tools:',
      '  - Read',
      '  - Grep',
      '  - Bash',
      '---',
      'body',
    ].join('\n');
    expect(parseAgentMd(md)?.tools).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('reads list-form tools at the same indent as the key', () => {
    const md = '---\nname: x\ndescription: d\ntools:\n- Read\n- Write\n---\n';
    expect(parseAgentMd(md)?.tools).toEqual(['Read', 'Write']);
  });
});
