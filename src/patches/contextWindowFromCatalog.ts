// Please see the note about writing patches in ./index
//
// Make the context-window resolver read the injected catalog's `context.window`.
//
// On CC 2.1.220 the resolver is:
//
//   function mZc(e,t){if(Wb(e))return 1e6;if(t?.includes(v_e.header)&&Q8(e))return 1e6;
//     if(IP(e))return 1e6;let r=dro(e);if(r!==null)return r;
//     let n=Z.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(n!==void 0&&n>0&&!lo(vi(e)).startsWith("claude-"))return n;
//     return ber}                                   // ber = 200000, hardcoded
//
// It special-cases 1M variants and CLAUDE_CODE_MAX_CONTEXT_TOKENS, then falls
// back to a hardcoded 200000 — it never consults the model catalog. So a custom
// model with context_window:262144 in its catalog entry still reports 200000 to
// the statusline ctx bar and auto-compaction. We insert a catalog lookup ahead
// of the hardcoded fallback (after the env override, which must keep winning).
//
// ww() is the catalog by-id lookup; lo() resolves aliases/[1m] to the base id.
//
// ```diff
//  let r=dro(e);if(r!==null)return r;
// +let cw=ww(lo(e))?.context?.window;if(typeof cw==="number"&&cw>0)return cw;
//  let n=Z.CLAUDE_CODE_MAX_CONTEXT_TOKENS; ...
// ```

import { showDiff } from './index';

export const writeContextWindowFromCatalog = (file: string): string | null => {
  // Idempotent: the catalog lookup is already injected.
  if (/ww\(lo\([$\w]+\)\)\?\.context\?\.window/.test(file)) {
    return file;
  }

  const pattern =
    /let ([$\w]+)=dro\(([$\w]+)\);if\(\1!==null\)return \1;let ([$\w]+)=/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    // If the resolver shape is gone entirely (no dro/fallback), no-op.
    if (!/function mZc\(/.test(file)) {
      console.log(
        'patch: contextWindowFromCatalog: context-window resolver not present — no-op'
      );
      return file;
    }
    console.error(
      'patch: contextWindowFromCatalog: found the resolver but not the dro/fallback shape'
    );
    return null;
  }

  const modelVar = match[2];
  const inject = `let cw=ww(lo(${modelVar}))?.context?.window;if(typeof cw==="number"&&cw>0)return cw;`;

  // match[0] ends with `let X=` (the env-var declaration). Insert BEFORE it so
  // the env override keeps precedence over the catalog lookup.
  const letDecl = match[0].lastIndexOf('let ');
  const pos = match.index + letDecl;

  const newFile = file.slice(0, pos) + inject + file.slice(pos);
  showDiff(file, newFile, inject, pos, pos);
  return newFile;
};
