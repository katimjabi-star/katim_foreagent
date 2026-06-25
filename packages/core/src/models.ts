import type { Vendor } from './events.ts';

/**
 * The per-vendor model catalog the New-task intake picker offers, and the single
 * source of truth for which model string each vendor CLI is invoked with.
 *
 * Kept pure (just data + lookups) so it is testable and so both the harness builder
 * (orchestration.ts) and the UI (served via /api/vendors) read the SAME list — no
 * drift between what the picker shows and what the CLI actually accepts.
 *
 * IDs verified June 2026:
 *  - Claude  : the claude-api skill catalog (authoritative) — `claude --model <id>`.
 *  - Codex   : developers.openai.com/codex/models — `codex --model <id>` (gpt-5.x line).
 *  - Gemini  : geminicli.com/docs/cli/model — `gemini -m <id>` (preview IDs carry the
 *              `-preview` suffix the CLI expects).
 * Context/pricing is filled in only where authoritative (Claude); left undefined for
 * the others rather than guessed.
 */
export interface ModelOption {
  /** Exact value passed to the vendor CLI's model flag. */
  id: string;
  /** Short display name for the picker. */
  label: string;
  /** Human context window (e.g. "1M", "200K"), when known. */
  context?: string;
  /** USD per 1M input tokens, when known. */
  priceIn?: number;
  /** USD per 1M output tokens, when known. */
  priceOut?: number;
  /** One-word qualifier shown beside the option (e.g. "default", "fast", "preview"). */
  note?: string;
  /** The picker's pre-selected option for this vendor. */
  default?: boolean;
}

export const VENDOR_MODELS: Record<Vendor, ModelOption[]> = {
  'claude-code': [
    { id: 'claude-opus-4-8', label: 'Opus 4.8', context: '1M', priceIn: 5, priceOut: 25, note: 'default · most capable Opus', default: true },
    { id: 'claude-fable-5', label: 'Fable 5', context: '1M', priceIn: 10, priceOut: 50, note: 'most capable' },
    { id: 'claude-opus-4-7', label: 'Opus 4.7', context: '1M', priceIn: 5, priceOut: 25 },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', context: '1M', priceIn: 3, priceOut: 15, note: 'balanced' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', context: '200K', priceIn: 1, priceOut: 5, note: 'fast · cheap' },
  ],
  codex: [
    { id: 'gpt-5.5', label: 'GPT-5.5', note: 'default · frontier', default: true },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-mini', note: 'fast' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-codex-spark', note: 'preview · near-instant' },
  ],
  'gemini-cli': [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', note: 'default · preview', default: true },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', note: 'fast · preview' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'fast' },
  ],
  unknown: [],
};

/** Model options for a vendor (empty for an unknown vendor). */
export function modelsFor(vendor: Vendor): ModelOption[] {
  return VENDOR_MODELS[vendor] ?? [];
}

/** The default model id for a vendor — the option flagged `default`, else the first. */
export function defaultModel(vendor: Vendor): string | undefined {
  const list = modelsFor(vendor);
  return (list.find((m) => m.default) ?? list[0])?.id;
}

/** Whether `id` is a catalogued model for the vendor. */
export function isKnownModel(vendor: Vendor, id: string): boolean {
  return modelsFor(vendor).some((m) => m.id === id);
}
