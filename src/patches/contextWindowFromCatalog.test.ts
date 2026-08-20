import { describe, it, expect } from 'vitest';
import { writeContextWindowFromCatalog } from './contextWindowFromCatalog';

// Faithful to CC 2.1.226's qmf: Zti() special-case, then env override gated on
// non-"claude-" ids, then hardcoded `return nbr`. Plus the l2 capabilities
// check that identifies the catalog by-id lookup (Bv).
const QMF =
  'function qmf(e,t){if(wS(e))return 1e6;if(t?.includes(uW.header)&&fW(e))return 1e6;if(B$(e))return 1e6;let r=Zti(e);if(r!==null)return r;let n=te.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(n!==void 0&&n>0&&!wo(ns(e)).startsWith("claude-"))return n;return nbr}';
const L2 =
  'function l2(e,t){let r=e.replace(/\\[1m\\]/gi,""),n=Bv(r);if(n!==void 0)return n.capabilities.includes(t)?!0:void 0;return Frg?.(r,t)}';
const SRC = QMF + L2;

describe('writeContextWindowFromCatalog', () => {
  it('inserts a claude-guarded catalog lookup before the env override', () => {
    const out = writeContextWindowFromCatalog(SRC);
    expect(out).not.toBeNull();
    expect(out).toContain('wo(ns(e))');
    expect(out).toContain('Bv(cwb)?.context?.window');
    expect(out).toContain('cwb.startsWith("claude-")?void 0:');
    // catalog lookup comes before the env-var read, env read still present
    const cwIdx = out!.indexOf('?.context?.window');
    const envIdx = out!.indexOf('let n=te.CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    const fallbackIdx = out!.indexOf('return nbr');
    expect(cwIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(cwIdx);
    expect(fallbackIdx).toBeGreaterThan(envIdx);
    // names were extracted, not hardcoded: renaming wo/ns/Bv must still work
    const renamed = SRC.replaceAll('wo(', 'Xy(')
      .replaceAll('ns(', 'Zw(')
      .replaceAll('=Bv(', '=Qq(');
    const out2 = writeContextWindowFromCatalog(renamed);
    expect(out2).toContain('Xy(Zw(e))');
    expect(out2).toContain('Qq(cwb)?.context?.window');
    // still syntactically valid JS
    expect(() => new Function('"use strict";' + out!)).not.toThrow();
  });

  it('is idempotent', () => {
    const once = writeContextWindowFromCatalog(SRC)!;
    expect(writeContextWindowFromCatalog(once)).toBe(once);
  });

  it('fails loudly (null) when the resolver shape is absent', () => {
    // A silent no-op on 2.1.226 is how custom models spent a day at a wrong
    // 200k window — drift must surface as a failed patch in --apply output.
    expect(writeContextWindowFromCatalog('function other(){}')).toBeNull();
  });
});
