import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexToml, detectMcp, type McpServer } from '../src/mcp.ts';

const byName = (s: McpServer[]) => Object.fromEntries(s.map((x) => [x.name, x]));

describe('parseCodexToml', () => {
  it('reads a stdio server (command + args) from an [mcp_servers.x] table', () => {
    const r = parseCodexToml(
      `[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n`,
      '~/.codex/config.toml',
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      name: 'github', vendor: 'codex', scope: 'user', transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-github',
    });
  });

  it('reads a remote server (url ⇒ http transport)', () => {
    const r = parseCodexToml(`[mcp_servers.docs]\nurl = "https://mcp.example.com/sse"\n`, 's');
    expect(r[0]).toMatchObject({ name: 'docs', transport: 'http', url: 'https://mcp.example.com/sse' });
  });

  it('handles a quoted table name and ignores nested tables (e.g. .env) and comments', () => {
    const r = parseCodexToml(
      `# a comment\n[mcp_servers."my-server"]\ncommand = "uvx"\nargs = ["thing"]\n[mcp_servers."my-server".env]\nTOKEN = "secret"\n`,
      's',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('my-server');
    expect(r[0]!.command).toBe('uvx thing');
  });

  it('returns [] for config with no mcp_servers tables', () => {
    expect(parseCodexToml(`[model]\nname = "gpt-5.5"\n`, 's')).toEqual([]);
  });
});

describe('detectMcp — project scope', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'foreman-mcp-'));
    await mkdir(join(repo, '.claude'), { recursive: true });
    await mkdir(join(repo, '.gemini'), { recursive: true });
    await writeFile(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
        sentry: { type: 'http', url: 'https://mcp.sentry.dev/sse' },
      },
    }));
    await writeFile(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['playwright'] }));
    await writeFile(join(repo, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { filesystem: { command: 'uvx', args: ['mcp-server-filesystem', '/data'] } },
    }));
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  it('reads Claude shared .mcp.json servers and applies enable-gating', async () => {
    const m = byName(await detectMcp(repo, 'claude-code'));
    expect(m.playwright).toMatchObject({ scope: 'project', source: '.mcp.json', transport: 'stdio', enabled: true });
    expect(m.playwright!.command).toBe('npx -y @playwright/mcp');
    // configured but not in enabledMcpjsonServers ⇒ not enabled here
    expect(m.sentry).toMatchObject({ transport: 'http', url: 'https://mcp.sentry.dev/sse', enabled: false });
  });

  it('reads Gemini project settings (vendor-scoped: claude servers are not returned)', async () => {
    const m = await detectMcp(repo, 'gemini-cli');
    expect(m.map((x) => x.name)).toEqual(['filesystem']);
    expect(m[0]).toMatchObject({ vendor: 'gemini-cli', scope: 'project', command: 'uvx mcp-server-filesystem /data' });
  });

  it('treats unknown vendor as claude-code', async () => {
    const m = await detectMcp(repo, 'unknown');
    expect(m.some((x) => x.name === 'playwright')).toBe(true);
  });
});
