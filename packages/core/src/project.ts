/**
 * Project intelligence — deterministic stack detection from manifest files.
 *
 * Pure parsers (no fs, no git): the server reads files and runs git, then hands the
 * raw contents here. That keeps detection unit-testable against fixtures and lets the
 * Project Overview tab render a trustworthy, non-AI baseline before any LLM summary.
 */

export interface Dependency { name: string; version: string; dev: boolean; }

export interface StackInfo {
  /** Detected languages, most-specific first (e.g. "TypeScript", "Python"). */
  languages: string[];
  /** Frameworks/runtimes inferred from dependencies (e.g. "Svelte", "React", "FastAPI"). */
  frameworks: string[];
  /** Package manager / build ecosystem (e.g. "npm", "bun", "pip", "cargo", "go"). */
  ecosystems: string[];
  dependencies: Dependency[];
}

export interface ManifestInput {
  /** Filename → raw text contents, for whichever manifests the server found. */
  [filename: string]: string;
}

/** Frameworks we recognise from a dependency name (substring match, lowercased). */
const FRAMEWORK_SIGNS: Array<[match: RegExp, label: string]> = [
  [/^svelte$|sveltekit/, 'Svelte'],
  [/^react$|^react-dom$/, 'React'],
  [/^vue$/, 'Vue'],
  [/^next$/, 'Next.js'],
  [/^@angular\/core$/, 'Angular'],
  [/^vite$/, 'Vite'],
  [/^express$/, 'Express'],
  [/^fastify$/, 'Fastify'],
  [/^@nestjs\/core$/, 'NestJS'],
  [/^fastapi$/, 'FastAPI'],
  [/^flask$/, 'Flask'],
  [/^django$/, 'Django'],
  [/^@anthropic-ai\/sdk$|^anthropic$/, 'Anthropic SDK'],
  [/^vitest$|^jest$/, 'tests'],
];

function frameworksFor(deps: Dependency[]): string[] {
  const out = new Set<string>();
  for (const d of deps) for (const [re, label] of FRAMEWORK_SIGNS) if (re.test(d.name.toLowerCase())) out.add(label);
  return [...out];
}

function parsePackageJson(raw: string): { deps: Dependency[]; isBun: boolean } | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const deps: Dependency[] = [];
  const collect = (obj: unknown, dev: boolean) => {
    if (obj && typeof obj === 'object') {
      for (const [name, version] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof version === 'string') deps.push({ name, version, dev });
      }
    }
  };
  collect(r.dependencies, false);
  collect(r.devDependencies, true);
  const isBun = typeof r.packageManager === 'string' && r.packageManager.startsWith('bun');
  return { deps, isBun };
}

/** Parse a requirements.txt-style file (one `pkg==ver` / `pkg>=ver` per line). */
function parseRequirements(raw: string): Dependency[] {
  const out: Dependency[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z0-9._-]+)\s*([=<>!~]+.*)?$/);
    if (m) out.push({ name: m[1]!, version: m[2]?.trim() ?? '*', dev: false });
  }
  return out;
}

/**
 * Detect the stack from whatever manifest files were found. Recognises Node
 * (package.json), Python (pyproject.toml / requirements.txt), Go (go.mod), and
 * Rust (Cargo.toml). Unknown ecosystems are simply omitted, never guessed.
 */
export function detectStack(manifests: ManifestInput): StackInfo {
  const languages = new Set<string>();
  const ecosystems = new Set<string>();
  let dependencies: Dependency[] = [];

  const pkg = manifests['package.json'];
  if (pkg) {
    const parsed = parsePackageJson(pkg);
    if (parsed) {
      languages.add(manifests['tsconfig.json'] || /\.ts['"]/.test(pkg) ? 'TypeScript' : 'JavaScript');
      ecosystems.add(parsed.isBun || manifests['bun.lock'] || manifests['bun.lockb'] ? 'bun' : 'npm');
      dependencies = dependencies.concat(parsed.deps);
    }
  }
  if (manifests['tsconfig.json']) languages.add('TypeScript');

  if (manifests['pyproject.toml'] || manifests['requirements.txt'] || manifests['Pipfile']) {
    languages.add('Python');
    ecosystems.add(manifests['pyproject.toml'] ? 'pip/pyproject' : 'pip');
    if (manifests['requirements.txt']) dependencies = dependencies.concat(parseRequirements(manifests['requirements.txt']));
  }
  if (manifests['go.mod']) { languages.add('Go'); ecosystems.add('go'); }
  if (manifests['Cargo.toml']) { languages.add('Rust'); ecosystems.add('cargo'); }

  return {
    languages: [...languages],
    frameworks: frameworksFor(dependencies),
    ecosystems: [...ecosystems],
    dependencies,
  };
}

/** Filenames the server should try to read when building a StackInfo. */
export const MANIFEST_FILES = [
  'package.json', 'tsconfig.json', 'bun.lock', 'bun.lockb',
  'pyproject.toml', 'requirements.txt', 'Pipfile',
  'go.mod', 'Cargo.toml',
];

// ---- Git details (shaped here; the server fills them by running git) ----

export interface GitInfo {
  branch: string;
  remoteUrl?: string;
  /** github "owner/repo" parsed from the remote, when it is a GitHub remote. */
  githubSlug?: string;
  ahead: number;
  behind: number;
  dirty: number; // count of changed files
  lastCommits: Array<{ sha: string; subject: string; when: string }>;
}

/** Parse `owner/repo` out of an ssh or https GitHub remote URL. */
export function githubSlug(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined;
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
