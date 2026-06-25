#!/bin/sh
# Foreman hook emitter — FAIL-SAFE BY CONTRACT.
#
# This runs inside a live Claude Code session on every matched hook event. It must
# NEVER block, prompt, slow, or fail the session: every error is swallowed and the
# script always exits 0. The worst case it can cause is a missing board update —
# never a broken coding session. Do not add anything here that can hang (network,
# locks, prompts) or that writes to stdout (hook stdout can be interpreted by Claude
# Code as control output).
#
# Usage (from settings.json):  sh /path/to/emit.sh <EventName>
# It appends one JSON line per event to $FOREMAN_HOME/hooks.jsonl, which the Foreman
# server tails. The Claude Code hook payload arrives on stdin as compact JSON.
event="${1:-unknown}"
dir="${FOREMAN_HOME:-$HOME/.foreman}"
spool="$dir/hooks.jsonl"
{
  mkdir -p "$dir" 2>/dev/null
  payload="$(cat | tr -d '\n\r')"
  [ -z "$payload" ] && payload='{}'
  ts="$(date +%s)000"
  printf '{"event":"%s","ts":%s,"data":%s}\n' "$event" "$ts" "$payload" >> "$spool"
} 2>/dev/null || true
exit 0
