import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ForemanEvent } from './events.ts';

/**
 * Append-only event log backed by a JSONL file.
 *
 * Deliberately NO native DB (no better-sqlite3): native modules are the #1 reason
 * `npx <tool>` fails on someone else's machine. A JSONL file + in-memory replay is
 * plenty for a local single-user observer and keeps install frictionless. A SQLite
 * adapter can slot in later behind this same interface for team/history use.
 */
export class EventLog {
  private events: ForemanEvent[] = [];
  private listeners = new Set<(e: ForemanEvent) => void>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) {
      mkdirSync(dirname(this.file), { recursive: true });
      return;
    }
    const raw = readFileSync(this.file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.events.push(JSON.parse(trimmed) as ForemanEvent);
      } catch {
        // Skip a corrupt line rather than refuse to boot — observability tools
        // must never hard-fail on a half-written record.
      }
    }
  }

  /** Append, persist, and fan out to live subscribers (SSE). */
  append(event: ForemanEvent): ForemanEvent {
    this.events.push(event);
    appendFileSync(this.file, JSON.stringify(event) + '\n');
    for (const fn of this.listeners) fn(event);
    return event;
  }

  /** All events so far (for replaying into a fresh projection / late SSE join). */
  all(): readonly ForemanEvent[] {
    return this.events;
  }

  /** Subscribe to future appends. Returns an unsubscribe fn. */
  subscribe(fn: (e: ForemanEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
