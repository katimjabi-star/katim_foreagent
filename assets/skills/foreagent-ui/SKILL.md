---
name: foreagent-ui
description: Foreagent's design system — the KATIM / EDGE Group brand identity (Gibson typography, signal orange, disciplined charcoal two-tone, flat structural surfaces, orange rule + arrow-CTA motifs) applied over a dark control-room base. Use it for any UI work in apps/web so every surface stays on-brand.
---

# Foreagent UI design system — KATIM / EDGE identity

A disciplined defense-grade brand language: **Gibson** type, **signal orange**,
charcoal two-tone, **flat** structural surfaces (not glass), and a small set of
hard-working motifs. **Use the CSS variables and global classes in
`apps/web/src/theme.css` — never hardcode colors or font names.**

## Foundations

**Typography.** Brand font is **Gibson** (licensed Monotype/Canada Type — used
automatically when installed locally). Free fallback is **Poppins** (loaded in
`index.html`); stack: `'Gibson', 'Poppins', 'Inter', system-ui`. Headings are bold
(700–800), uppercase for section titles, near-zero tracking. Mono = JetBrains Mono
for metrics/data only.

**Colour — two-tone + orange.** Stay disciplined; orange is the only signal.
- `--accent` `#ee5a24` (EDGE/KATIM orange), `--accent-2` lighter, `--accent-strong` `#c9420f` for hover.
- `--accent-ghost` (11% orange) tinted fills; `--accent-dim` tinted borders; `--on-accent` `#fff` for text on orange.
- `--charcoal` `#363d45` brand slate. Surfaces are charcoal-translucent; text is a slate ramp (`--txt / --txt-dim / --txt-faint`).
- No rainbow icon palette — that is off-brand. Vendor dots (`--claude/--codex/--gemini`) are the only non-orange hues, and only as functional status indicators.

**Shape — flat & structural.** Near-square corners (`--r-sm 3`, `--r-md 5`, `--r-lg 8`).
Solid blocks, hairline borders, restrained shadow. Light blur only (6px) — this is a
flat brand, **not** glassmorphism.

## Motifs (the brand signature)

- **Orange rule** (`.rule`, and auto-applied under every `.p-h`): a short ~26–32px × 2–3px orange bar under headings. KATIM's core device.
- **Wordmark macron**: a short orange dash over the trailing letters of the wordmark (the `.brand::before` dash).
- **Arrow CTA** (`Button.svelte` / `.btn-primary`): flat solid-orange block, white label, trailing `→` that slides right on hover. One per view.
- **Section index** (`.sectnum`): orange mono `02/` before a major section title.
- **Title tick**: a short orange bar before the active view title.

## Components (global classes)

- `.btn-primary` — flat orange arrow CTA (the hero action; use `Button.svelte`).
- `.btn-ghost` — charcoal-outline secondary; border goes orange on hover.
- `.pill` — small rounded status/tag badge.
- `.glass` — standard charcoal card surface (`--panel` + hairline + `--shadow-sm`).
- Icons: inline SVG via `Icon.svelte`, monochrome — orange when active, slate otherwise.

## Rules

1. Never hardcode a hex or font — reference a token so re-theming is one file.
2. Orange is the only accent. No multi-colour icons.
3. One `.btn-primary` (orange arrow CTA) per view; everything else is `.btn-ghost` or a plain icon button.
4. Keep it flat and square — small radii, hairline borders, minimal blur. No heavy glass.
5. Section headings get the orange rule; major sections may add a `02/` index.
6. Motion is subtle (120–160ms): arrow slide, border/colour fades. Nothing bouncy.
