import { describe, it, expect } from 'vitest';
import { writeRateLimitsFromHeaders } from './rateLimitsFromHeaders';

// Faithful to CC 2.1.220's cpo gate.
const GATE =
  'function cpo(e,t,r=!1,n=Date.now()){let o=ii();if(!rir(o)){if(UDt={},jDt=!1,wpe.status!=="allowed"||wpe.resetsAt||wpe.rateLimitGraceActive)GDt({status:"allowed",unifiedRateLimitFallbackAvailable:!1,isUsingOverage:!1});return}let i=Rcs(e),s=vLu(i);if(!bLu(n)){UDt=SLu(i);jDt=!1}}';

describe('writeRateLimitsFromHeaders', () => {
  it('neutralizes the subscription gate so header parsing always runs', () => {
    const out = writeRateLimitsFromHeaders(GATE);
    expect(out).not.toBeNull();
    expect(out).toContain('let o=ii();if(!1){if(UDt={}');
    // parse path intact
    expect(out).toContain('UDt=SLu(i)');
  });

  it('is idempotent', () => {
    const once = writeRateLimitsFromHeaders(GATE)!;
    expect(writeRateLimitsFromHeaders(once)).toBe(once);
  });

  it('no-ops when the gate is absent entirely', () => {
    expect(writeRateLimitsFromHeaders('function other(){}')).toBe(
      'function other(){}'
    );
  });
});
