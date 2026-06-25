// Foreman hook installer — `foreman --install` / `foreman --uninstall`.
//
// Installs the OPTIONAL upgrade tier: Claude Code hooks that emit subagent/idle/
// waiting signals the transcript can't give us. The baseline board (tasks, tools,
// context/cost meters) works with NO hooks — this only adds richer agent status.
//
// Safety contract (non-negotiable):
//   1. Back up settings.json before ANY modification (timestamped, never overwrite).
//   2. Merge is non-destructive and idempotent — we only add our own entries and
//      never touch the user's other hooks, keys, or formatting beyond a re-stringify.
//   3. The hooks themselves are fail-safe (see assets/hooks/emit.sh): always exit 0.
// Plain Node, zero deps — runs under `npx foreman` without bun.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const FOREMAN_HOME = process.env.FOREMAN_HOME || join(homedir(), '.foreman');
const SETTINGS = join(CLAUDE_HOME, 'settings.json');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SRC = join(REPO_ROOT, 'assets', 'hooks', 'emit.sh');

// The events worth the cost of a hook — each surfaces a signal the transcript lacks
// or gives it to us in real time (PreCompact fires before the boundary line lands;
// Notification carries the live permission/question text).
const EVENTS = ['SubagentStart', 'SubagentStop', 'Stop', 'Notification', 'PreCompact', 'SessionStart', 'SessionEnd'];

// An entry is "ours" if any of its commands invoke our emit.sh.
const isOurs = (entry) =>
  Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('emit.sh'));

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    console.error(`✗ ${SETTINGS} is not valid JSON — refusing to touch it. Fix it and re-run.`);
    process.exit(1);
  }
}

function backup() {
  if (!existsSync(SETTINGS)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${SETTINGS}.foreman-bak-${stamp}`;
  copyFileSync(SETTINGS, dest);
  return dest;
}

function install() {
  // 1. Stage the fail-safe hook script under ~/.foreman.
  const hookDir = join(FOREMAN_HOME, 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const hookDest = join(hookDir, 'emit.sh');
  copyFileSync(HOOK_SRC, hookDest);
  chmodSync(hookDest, 0o755);

  // 2. Back up, then merge our hook entries in (idempotent).
  const settings = readSettings();
  const bak = backup();
  settings.hooks ??= {};
  let added = 0;
  for (const event of EVENTS) {
    const list = (settings.hooks[event] ??= []);
    if (list.some(isOurs)) continue; // already installed for this event
    list.push({ hooks: [{ type: 'command', command: `sh '${hookDest}' ${event}` }] });
    added++;
  }
  mkdirSync(CLAUDE_HOME, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

  console.log('✓ Foreman hooks installed (fail-safe — they always exit 0).');
  console.log(`  hook script : ${hookDest}`);
  console.log(`  spool       : ${join(FOREMAN_HOME, 'hooks.jsonl')}`);
  console.log(`  settings    : ${SETTINGS}${bak ? `\n  backup      : ${bak}` : ''}`);
  console.log(added ? `  added ${added} hook event(s): ${EVENTS.join(', ')}` : '  already up to date — no changes.');
  console.log('\nRestart any open Claude Code sessions to pick up the hooks.');
}

function uninstall() {
  if (!existsSync(SETTINGS)) {
    console.log('Nothing to do — no settings.json found.');
    return;
  }
  const settings = readSettings();
  const bak = backup();
  let removed = 0;
  for (const event of EVENTS) {
    const list = settings.hooks?.[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !isOurs(e));
    removed += list.length - kept.length;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✓ Removed ${removed} Foreman hook entr${removed === 1 ? 'y' : 'ies'}. Backup: ${bak}`);
  console.log('  (Your other hooks and settings were left untouched.)');
}

const cmd = process.argv[2];
if (cmd === '--uninstall' || cmd === 'uninstall') uninstall();
else install();
