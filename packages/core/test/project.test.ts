import { describe, it, expect } from 'vitest';
import { detectStack, githubSlug } from '../src/project.ts';

describe('detectStack', () => {
  it('detects a TypeScript + Svelte + bun project from package.json', () => {
    const s = detectStack({
      'package.json': JSON.stringify({
        packageManager: 'bun@1.3.0',
        dependencies: { svelte: '^5.0.0' },
        devDependencies: { vite: '^6.0.0', vitest: '^3.0.0' },
      }),
      'tsconfig.json': '{}',
    });
    expect(s.languages).toContain('TypeScript');
    expect(s.ecosystems).toContain('bun');
    expect(s.frameworks).toEqual(expect.arrayContaining(['Svelte', 'Vite', 'tests']));
    expect(s.dependencies.find((d) => d.name === 'vite')?.dev).toBe(true);
  });

  it('detects Python from requirements.txt and parses pinned versions', () => {
    const s = detectStack({ 'requirements.txt': 'fastapi==0.110.0\n# comment\nuvicorn>=0.29\n' });
    expect(s.languages).toEqual(['Python']);
    expect(s.frameworks).toContain('FastAPI');
    expect(s.dependencies).toEqual([
      { name: 'fastapi', version: '==0.110.0', dev: false },
      { name: 'uvicorn', version: '>=0.29', dev: false },
    ]);
  });

  it('detects Go and Rust by manifest presence', () => {
    expect(detectStack({ 'go.mod': 'module x' }).languages).toEqual(['Go']);
    expect(detectStack({ 'Cargo.toml': '[package]' }).ecosystems).toContain('cargo');
  });

  it('returns empty (never guesses) when no manifest is recognised', () => {
    expect(detectStack({}).languages).toEqual([]);
  });
});

describe('githubSlug', () => {
  it('parses ssh and https GitHub remotes', () => {
    expect(githubSlug('git@github.com:acme/widgets.git')).toBe('acme/widgets');
    expect(githubSlug('https://github.com/acme/widgets')).toBe('acme/widgets');
  });
  it('returns undefined for non-GitHub or missing remotes', () => {
    expect(githubSlug('https://gitlab.com/a/b.git')).toBeUndefined();
    expect(githubSlug(undefined)).toBeUndefined();
  });
});
