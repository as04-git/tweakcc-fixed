import { describe, it, expect } from 'vitest';
import { writeAutoModelSwap } from './autoModelSwap';

// Faithful to CC 2.1.226's fXs head (auto-compact generator): DISABLE_COMPACT
// gate, failure-circuit-breaker gate, then the KJ_ threshold gate reading
// toolUseContext.options.mainLoopModel / .autoCompactWindow / .agentContext.
const FXS_HEAD =
  'async function*fXs(e,t,r,n,o,i,s){if(te.DISABLE_COMPACT)return{kind:"not_needed"};' +
  'if(o?.consecutiveFailures!==void 0&&o.consecutiveFailures>=DYd)return{kind:"failure_breaker_open"};' +
  'let a=t.options.mainLoopModel,l=t.options.autoCompactWindow;' +
  'if(!await KJ_(e,a,l,n,i,t.agentContext))return{kind:"not_needed"};';
const SRC = FXS_HEAD + 'let u=qJ_(e,a,l,i);return{kind:"compacted"}}';

describe('writeAutoModelSwap', () => {
  it('injects the swap block right after the KJ_ threshold gate', () => {
    const out = writeAutoModelSwap(SRC);
    expect(out).not.toBeNull();
    expect(out).toContain('__autoModelSwapMap={"kimi-k3-256k":"kimi-k3"}');
    expect(out).toContain('__autoModelSwapMap[a]');
    expect(out).toContain(
      't.setAppState(__amsX=>({...__amsX,mainLoopModel:__autoModelSwapTo,mainLoopModelForSession:null}))'
    );
    expect(out).toContain(
      't.options={...t.options,mainLoopModel:__autoModelSwapTo}'
    );
    expect(out).toContain('key:"auto-model-swap"');
    expect(out).toContain('"claude-gateway","bin","model-swap-event');
    expect(out).not.toContain('".claude-gateway","bin","model-swap-event');
    // insertion lands after the threshold gate, before the rest of fXs
    const gateIdx = out!.indexOf(
      'if(!await KJ_(e,a,l,n,i,t.agentContext))return{kind:"not_needed"};'
    );
    const swapIdx = out!.indexOf('__autoModelSwapMap=');
    const restIdx = out!.indexOf('let u=qJ_');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(swapIdx).toBeGreaterThan(gateIdx);
    expect(restIdx).toBeGreaterThan(swapIdx);
    // still syntactically valid JS (async generator context)
    expect(
      () => new Function('"use strict";return async function*(){' + out! + '}')
    ).not.toThrow();
  });

  it('uses live-extracted names, not hardcoded ones', () => {
    const renamed = SRC.replaceAll('fXs', 'Zq2')
      .replaceAll(/\ba\b/g, 'Md')
      .replaceAll(/\bt\b/g, 'Cx');
    const out = writeAutoModelSwap(renamed);
    expect(out).not.toBeNull();
    expect(out).toContain('__autoModelSwapMap[Md]');
    expect(out).toContain('Cx.setAppState');
    expect(out).toContain('Cx.options={...Cx.options');
  });

  it('is idempotent', () => {
    const once = writeAutoModelSwap(SRC)!;
    expect(writeAutoModelSwap(once)).toBe(once);
  });

  it('fails loudly (null) when the fXs head shape is absent', () => {
    // M13 lesson: anchor drift must surface as a failed patch in --apply,
    // never a silent no-op.
    expect(writeAutoModelSwap('function other(){}')).toBeNull();
  });
});
