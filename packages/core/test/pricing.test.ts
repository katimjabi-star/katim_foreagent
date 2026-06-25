import { describe, it, expect } from 'vitest';
import { pricingFor, turnCostUsd, contextPct } from '../src/pricing.ts';
import type { TokenUsage } from '../src/claude.ts';

const u = (p: Partial<TokenUsage>): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, ...p });

describe('pricingFor', () => {
  it('maps Opus 4.8 to $5/$25 over a 1M window', () => {
    expect(pricingFor('claude-opus-4-8')).toEqual({ inPerMTok: 5, outPerMTok: 25, contextWindow: 1_000_000 });
  });
  it('maps dated Haiku 4.5 to $1/$5 over 200K', () => {
    expect(pricingFor('claude-haiku-4-5-20251001')).toEqual({ inPerMTok: 1, outPerMTok: 5, contextWindow: 200_000 });
  });
  it('maps Sonnet 4.6 to a 1M window but older sonnets to 200K', () => {
    expect(pricingFor('claude-sonnet-4-6').contextWindow).toBe(1_000_000);
    expect(pricingFor('claude-sonnet-4-5').contextWindow).toBe(200_000);
  });
  it('maps Fable 5 to $10/$50', () => {
    expect(pricingFor('claude-fable-5')).toMatchObject({ inPerMTok: 10, outPerMTok: 50 });
  });
  it('falls back to Opus-tier rates on an unknown model', () => {
    expect(pricingFor(undefined)).toEqual({ inPerMTok: 5, outPerMTok: 25, contextWindow: 200_000 });
  });
});

describe('turnCostUsd', () => {
  it('prices input + output at the model rate', () => {
    // 1M input @ $5 + 1M output @ $25 = $30
    expect(turnCostUsd(u({ input: 1_000_000, output: 1_000_000 }), 'claude-opus-4-8')).toBeCloseTo(30, 6);
  });
  it('discounts cache reads to 0.1x input and charges cache writes at 1.25x', () => {
    // 1M cache read @ $5*0.1 = $0.50 ; 1M cache write @ $5*1.25 = $6.25
    expect(turnCostUsd(u({ cacheRead: 1_000_000 }), 'claude-opus-4-8')).toBeCloseTo(0.5, 6);
    expect(turnCostUsd(u({ cacheCreate: 1_000_000 }), 'claude-opus-4-8')).toBeCloseTo(6.25, 6);
  });
});

describe('contextPct', () => {
  it('sums input+cache against the window and clamps to 1', () => {
    // 500K of a 1M window = 0.5
    expect(contextPct(u({ input: 100_000, cacheRead: 400_000 }), 'claude-opus-4-8')).toBeCloseTo(0.5, 6);
    // output tokens do NOT count toward context fill
    expect(contextPct(u({ output: 999_999, input: 0 }), 'claude-opus-4-8')).toBe(0);
    // over-full clamps
    expect(contextPct(u({ input: 5_000_000 }), 'claude-haiku-4-5')).toBe(1);
  });
});
