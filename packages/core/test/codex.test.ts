import { describe, expect, it } from 'vitest';
import { makeEvent, parseCodexLine, replay } from '../src/index.ts';

describe('parseCodexLine', () => {
  it('extracts session metadata', () => {
    const p = parseCodexLine(JSON.stringify({
      timestamp: '2026-06-25T07:40:12.582Z',
      type: 'session_meta',
      payload: { session_id: 's1', cwd: '/home/test/katim_foreagent' },
    }))!;
    expect(p.sessionId).toBe('s1');
    expect(p.cwd).toBe('/home/test/katim_foreagent');
    expect(typeof p.ts).toBe('number');
  });

  it('uses child id and parent metadata for subagent sessions', () => {
    const p = parseCodexLine(JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: 'parent',
        id: 'child',
        parent_thread_id: 'parent',
        cwd: '/home/test',
        agent_nickname: 'Goodall',
        agent_role: 'worker',
      },
    }))!;
    expect(p.sessionId).toBe('child');
    expect(p.meta).toMatchObject({
      sessionId: 'child',
      parentSessionId: 'parent',
      agentNickname: 'Goodall',
      agentRole: 'worker',
    });
  });

  it('extracts messages and tool calls', () => {
    const msg = parseCodexLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Working now.' },
    }))!;
    expect(msg.items).toEqual([{ kind: 'message', role: 'assistant', text: 'Working now.' }]);

    const tool = parseCodexLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }) },
    }))!;
    expect(tool.items[0]).toMatchObject({ kind: 'tool', name: 'exec_command', detail: 'npm test' });
  });

  it('extracts token context from token_count', () => {
    const p = parseCodexLine(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 25, total_tokens: 225 },
          total_token_usage: { total_tokens: 1000 },
          model_context_window: 1000,
        },
      },
    }))!;
    expect(p.snapshot).toMatchObject({ pctUsed: 0.225, tokensIn: 200, tokensOut: 25, cacheRead: 50, model: 'codex' });
  });

  it('supports a codex card in the board projection', () => {
    const events = [
      makeEvent('task.created', { taskId: 'codex:s1', sessionId: 's1', repo: 'katim_foreagent', title: 'Codex session: katim_foreagent', column: 'aligning' }),
      makeEvent('agent.spawned', { agentId: 'session:s1', taskId: 'codex:s1', vendor: 'codex', parentId: 'session:parent', agentType: 'worker' }),
      makeEvent('agent.status', { agentId: 'session:s1', sessionId: 's1', status: 'running' }),
      makeEvent('tool.used', { agentId: 'session:s1', tool: 'exec_command', detail: 'npm test' }),
    ];
    const card = replay(events).state().cards['codex:s1']!;
    expect(card.vendor).toBe('codex');
    expect(card.parentId).toBe('session:parent');
    expect(card.agentType).toBe('worker');
    expect(card.agentStatus).toBe('running');
    expect(card.lastTool).toBe('exec_command · npm test');
  });
});
