import { describe, it, expect } from 'vitest';
import { packByWeight, packingFloor } from './packByWeight.mjs';

const W = { a: 100, b: 90, c: 80, d: 70, e: 60, f: 50 };
const wOf = k => W[k];

describe('packByWeight', () => {
  it('balances by weight, not by count', () => {
    const bins = packByWeight(Object.keys(W), 3, wOf);
    const weights = bins.map(b => b.weight).sort((x, y) => y - x);
    // 450 over 3 bins = 150 each, and LPT finds it exactly here.
    expect(weights).toEqual([150, 150, 150]);
    // Counts are allowed to differ — that is the whole point.
    expect(bins.every(b => b.items.length === 2)).toBe(true);
  });

  it('gives one oversized item a bin to itself instead of burying it', () => {
    // The 2.1.237 shape: skill-claude-api-python-sdk-upgrade at 128,980 chars
    // against a 30,074 mean. Contiguous slicing put it WITH 14 siblings.
    const items = ['huge', ...Array.from({ length: 14 }, (_, i) => `s${i}`)];
    const weight = k => (k === 'huge' ? 128980 : 1600);
    const bins = packByWeight(items, 3, weight);
    const solo = bins.find(b => b.items.includes('huge'));
    expect(solo.items).toEqual(['huge']);
  });

  it('reaches the theoretical floor when one item dominates', () => {
    const items = ['huge', ...Array.from({ length: 14 }, (_, i) => `s${i}`)];
    const weight = k => (k === 'huge' ? 128980 : 1600);
    const bins = packByWeight(items, 3, weight);
    const max = Math.max(...bins.map(b => b.weight));
    expect(max).toBe(packingFloor(items, 3, weight));
  });

  it('is deterministic across runs — equal weights break on the key', () => {
    const items = ['z', 'y', 'x', 'w'];
    const flat = () => 10;
    const a = packByWeight(items, 2, flat).map(b => b.items.join(','));
    const b = packByWeight([...items].reverse(), 2, flat).map(x => x.items.join(','));
    expect(a).toEqual(b);
  });

  it('never returns an empty bin', () => {
    expect(packByWeight(['a', 'b'], 10, wOf).every(b => b.items.length > 0)).toBe(true);
  });

  it('survives degenerate input', () => {
    expect(packByWeight([], 3, wOf)).toEqual([]);
    expect(packByWeight(['a'], 0, wOf)).toHaveLength(1);
    expect(packByWeight(['a', 'b'], 1, () => NaN)[0].weight).toBe(0);
  });
});
