import { describe, it, expect } from 'vitest';
import { writeContextWindowFromCatalog } from './contextWindowFromCatalog';

// Faithful to CC 2.1.220's mZc: dro() special-case, then env override, then
// hardcoded `return ber`.
const MZC =
  'function mZc(e,t){if(Wb(e))return 1e6;if(t?.includes(v_e.header)&&Q8(e))return 1e6;if(IP(e))return 1e6;let r=dro(e);if(r!==null)return r;let n=Z.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(n!==void 0&&n>0&&!lo(vi(e)).startsWith("claude-"))return n;return ber}';

describe('writeContextWindowFromCatalog', () => {
  it('inserts a catalog lookup before the env override', () => {
    const out = writeContextWindowFromCatalog(MZC);
    expect(out).not.toBeNull();
    expect(out).toContain('ww(lo(e))?.context?.window');
    // catalog lookup comes before the env-var read, env read still present
    const cwIdx = out!.indexOf('ww(lo(e))?.context?.window');
    const envIdx = out!.indexOf('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    const fallbackIdx = out!.indexOf('return ber');
    expect(cwIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(cwIdx);
    expect(fallbackIdx).toBeGreaterThan(envIdx);
    // still syntactically valid JS
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function('"use strict";' + out!)).not.toThrow();
  });

  it('is idempotent', () => {
    const once = writeContextWindowFromCatalog(MZC)!;
    expect(writeContextWindowFromCatalog(once)).toBe(once);
  });

  it('no-ops when the resolver is absent', () => {
    expect(writeContextWindowFromCatalog('function other(){}')).toBe(
      'function other(){}'
    );
  });
});
