/** Shared session→repo correlation, populated by the transcript watcher (which
 *  sees `cwd`) and read by the tasks watcher (whose files are keyed only by
 *  session UUID). Tasks discovered before their transcript get a relabel event.
 *
 *  We keep the absolute cwd too: the orchestration layer needs a real path to add
 *  a git worktree to when spawning an agent against a repo. */
export class SessionRegistry {
  private repoBySession = new Map<string, string>();
  private pathBySession = new Map<string, string>();
  private onResolveCbs = new Set<(sessionId: string, repo: string) => void>();

  repo(sessionId: string): string | undefined {
    return this.repoBySession.get(sessionId);
  }

  path(sessionId: string): string | undefined {
    return this.pathBySession.get(sessionId);
  }

  set(sessionId: string, repo: string, path?: string): void {
    if (path) this.pathBySession.set(sessionId, path);
    if (this.repoBySession.get(sessionId) === repo) return;
    this.repoBySession.set(sessionId, repo);
    for (const cb of this.onResolveCbs) cb(sessionId, repo);
  }

  /** Distinct repos seen, as {repo,path} — the orchestration spawn picker. */
  repos(): Array<{ repo: string; path: string }> {
    const byPath = new Map<string, string>();
    for (const [sid, path] of this.pathBySession) {
      const repo = this.repoBySession.get(sid) ?? path;
      if (!byPath.has(path)) byPath.set(path, repo);
    }
    return [...byPath].map(([path, repo]) => ({ repo, path })).sort((a, b) => a.repo.localeCompare(b.repo));
  }

  onResolve(cb: (sessionId: string, repo: string) => void): void {
    this.onResolveCbs.add(cb);
  }
}
