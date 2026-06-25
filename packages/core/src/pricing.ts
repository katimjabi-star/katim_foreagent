import type { TokenUsage } from './claude.ts';

/**
 * Per-model pricing + context windows, sourced from the claude-api skill
 * (cached 2026-06-04). Used to derive the real cost/context meters from the
 * token usage Claude Code already records in each transcript — no API calls.
 *
 *   cache read   ≈ 0.1× input price
 *   cache write  ≈ 1.25× input price (5-minute TTL; the common case)
 */
export interface ModelPricing {
  inPerMTok: number;
  outPerMTok: number;
  contextWindow: number;
}

const PRICING: Array<[match: RegExp, p: ModelPricing]> = [
  [/fable-5|mythos-5/, { inPerMTok: 10, outPerMTok: 50, contextWindow: 1_000_000 }],
  [/opus-4-(5|6|7|8)/, { inPerMTok: 5, outPerMTok: 25, contextWindow: 1_000_000 }],
  [/sonnet-4-6/, { inPerMTok: 3, outPerMTok: 15, contextWindow: 1_000_000 }],
  [/sonnet/, { inPerMTok: 3, outPerMTok: 15, contextWindow: 200_000 }],
  [/haiku/, { inPerMTok: 1, outPerMTok: 5, contextWindow: 200_000 }],
];

const FALLBACK: ModelPricing = { inPerMTok: 5, outPerMTok: 25, contextWindow: 200_000 };

export function pricingFor(model: string | undefined): ModelPricing {
  if (model) for (const [re, p] of PRICING) if (re.test(model)) return p;
  return FALLBACK;
}

/** Dollar cost of one assistant turn's usage. */
export function turnCostUsd(u: TokenUsage, model: string | undefined): number {
  const p = pricingFor(model);
  const inRate = p.inPerMTok / 1_000_000;
  const outRate = p.outPerMTok / 1_000_000;
  return (
    u.input * inRate +
    u.output * outRate +
    u.cacheRead * inRate * 0.1 +
    u.cacheCreate * inRate * 1.25
  );
}

/** Fraction (0..1) of the model's context window occupied by this turn's input. */
export function contextPct(u: TokenUsage, model: string | undefined): number {
  const window = pricingFor(model).contextWindow;
  const used = u.input + u.cacheRead + u.cacheCreate; // tokens fed to the model this turn
  return Math.min(1, used / window);
}
