// Please see the note about writing patches in ./index
//
// Populate the statusline's rate_limits (5h / 7d) from response headers even
// in API-key sessions.
//
// CC parses anthropic-ratelimit-unified-* response headers into the
// statusline's `.rate_limits.five_hour` / `.seven_day` only when `ii()`
// reports an OAuth-subscription session. When ANTHROPIC_API_KEY is set (e.g.
// pointing CC at a local gateway with its own credential), `ii()` is false
// and the parsing block early-returns — so quota headers are ignored even
// when they arrive (from Anthropic via passthrough, or synthesized by the
// gateway for other providers).
//
// CC 2.1.220 (function cpo):
// ```diff
// -let o=ii();if(!rir(o)){if(UDt={},jDt=!1,...);return}
// +let o=ii();if(!1){if(UDt={},jDt=!1,...);return}
// ```
//
// Making the early-return dead means the header parse (`UDt=SLu(headers)`)
// runs for every response. Absent headers produce an empty map (statusline
// shows nothing), so subscriber sessions are unaffected. rir/gkt are false in
// this build, so vLu always receives the Headers object — no null-deref risk.

import { showDiff } from './index';

export const writeRateLimitsFromHeaders = (file: string): string | null => {
  // Idempotent: gate already neutralized.
  if (/=ii\(\);if\(!1\)\{if\(UDt=\{\}/.test(file)) {
    return file;
  }

  const pattern = /let ([$\w]+)=ii\(\);if\(!rir\(\1\)\)\{if\(UDt=\{\}/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    if (!/rir\(/.test(file)) {
      console.log(
        'patch: rateLimitsFromHeaders: rate-limit gate not present — no-op'
      );
      return file;
    }
    console.error(
      'patch: rateLimitsFromHeaders: found rir but not the cpo gate shape'
    );
    return null;
  }

  const v = match[1];
  const replacement = `let ${v}=ii();if(!1){if(UDt={}`;
  const start = match.index;
  const end = start + match[0].length;
  const newFile = file.slice(0, start) + replacement + file.slice(end);

  showDiff(file, newFile, replacement, start, end);
  return newFile;
};
