import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeSonnet1mAvailable } from './sonnet1mAvailable';

// Faithful to CC 2.1.228. The opus predicate (Qee) is emitted with a
// byte-identical body immediately BEFORE the sonnet one (kpe) — that adjacency
// is the whole reason the patch resolves the name through the gate instead of
// matching the body shape.
const OPUS_PREDICATE = 'function Qee(){if(Tse())return!1;if(Ui())return UEu();return!0}';
const SONNET_PREDICATE = 'function kpe(){if(Tse())return!1;if(Ui())return UEu();return!0}';
const SONNET_GATE =
  'function fHa(e){let t=e.toLowerCase();if(!(t.includes("sonnet[1m]")||t.includes("sonnet-4-6[1m]")||t.includes("sonnet-5[1m]")))return!1;if(yN(as(e)))return!1;return!kpe()}';
// The opus gate names Qee, so a gate-shaped regex must not pick it up either.
const OPUS_GATE =
  'function pHa(e){let t=e.toLowerCase();return!Qee()&&!MF()&&t.includes("opus")&&t.includes("[1m]")}';

const SITE = `${OPUS_PREDICATE}${SONNET_PREDICATE}var x=1;${OPUS_GATE}${SONNET_GATE}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeSonnet1mAvailable', () => {
  it('drops the entitlement lookup from the sonnet predicate', () => {
    const out = writeSonnet1mAvailable(SITE);
    expect(out).not.toBeNull();
    expect(out).toContain('function kpe(){if(Tse())return!1;return!0}');
  });

  it('leaves the byte-identical opus predicate untouched', () => {
    const out = writeSonnet1mAvailable(SITE)!;
    expect(out).toContain(OPUS_PREDICATE);
    // Exactly one predicate still consults the entitlement fn: opus.
    expect(out.match(/if\(Ui\(\)\)return UEu\(\);/g)).toHaveLength(1);
  });

  it('preserves the CLAUDE_CODE_DISABLE_1M_CONTEXT kill switch', () => {
    const out = writeSonnet1mAvailable(SITE)!;
    expect(out).toMatch(/function kpe\(\)\{if\(Tse\(\)\)return!1;/);
  });

  it('leaves the gate and surrounding code otherwise intact', () => {
    const out = writeSonnet1mAvailable(SITE)!;
    expect(out).toContain(SONNET_GATE);
    expect(out).toContain(OPUS_GATE);
    expect(out).toContain('var x=1;');
  });

  it('is idempotent', () => {
    const once = writeSonnet1mAvailable(SITE)!;
    expect(writeSonnet1mAvailable(once)).toBe(once);
  });

  it('fails loudly when the sonnet gate is absent', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeSonnet1mAvailable(`${OPUS_PREDICATE}${OPUS_GATE}`)).toBeNull();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('failed to find the sonnet 1M availability gate')
    );
  });

  it('fails loudly when the resolved predicate has an unexpected shape', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drifted = SITE.replace(
      SONNET_PREDICATE,
      'function kpe(){return someNewGate()?UEu():!0}'
    );
    expect(writeSonnet1mAvailable(drifted)).toBeNull();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('resolved the entitlement predicate as "kpe"')
    );
  });

  it('follows the gate to whatever the predicate is renamed to', () => {
    const renamed = SITE.replace(/kpe/g, 'zZ9');
    const out = writeSonnet1mAvailable(renamed);
    expect(out).not.toBeNull();
    expect(out).toContain('function zZ9(){if(Tse())return!1;return!0}');
    expect(out).toContain(OPUS_PREDICATE);
  });
});
