// Please see the note about writing patches in ./index
//
// Make the context-window resolver read the injected catalog's `context.window`.
//
// On CC 2.1.237 the resolver is (2.1.226 names in parentheses):
//
//   function Ihd(e,t){if(jE(e))return 1e6;if(t?.includes(uK.header)&&fK(e))return 1e6;
//     if(g2(e))return 1e6;let r=cGo(e);if(r!==null)return r;
//     let n=q.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(n!==void 0&&n>0&&!Do(ms(e)).startsWith("claude-"))return n;
//     return QDr}                                   // QDr = 200000, hardcoded
//
// (2.1.226: qmf / wS / uW.header / fW / B$ / Zti / te.… / wo(ns(e)) / nbr.
//  2.1.220: mZc / Wb / dro / Z.… / lo(vi(e)) / ber. Same shape every time,
//  only the minified names move — which is the whole argument for extracting
//  every one of them from the file instead of writing any of them down.)
//
// It special-cases 1M variants and CLAUDE_CODE_MAX_CONTEXT_TOKENS, then falls
// back to a hardcoded 200000 — it never consults the model catalog. So a custom
// model with context_window:262144 in its catalog entry still reports 200000 to
// the statusline ctx bar and auto-compaction (the 2.1.226 auto-compact resolver
// M3 computes its base window from this function via hT). We insert a catalog
// lookup ahead of the env override.
//
// Name map (2.1.237, 2.1.226 in parentheses): oH (Bv) is the catalog by-id
// lookup; ms (ns) is the model resolver incl. custom aliases; Do (wo) resolves
// alias/[1m] to the base id; q (te) is the env namespace. All four are
// minified and WILL rename on version bumps, so they are extracted from the
// file at apply time rather than hardcoded: the env namespace, Do and ms from
// the env-override guard itself, oH from the capabilities check
// (`n=oH(r);if(n!==void 0)return n.capabilities…`).
//
// BUILT-IN GUARD (new for 2.1.226): the catalog now lists window:1e6 for the
// BASE opus/sonnet entries (1M is opt-in via the [1m]/beta arms, which run
// first). A blind catalog read would redefine built-ins to 1M — exactly what
// this gateway is designed not to do. The lookup is therefore gated to
// non-"claude-" ids, mirroring the env override's own guard:
//
// ```diff
//  let r=cGo(e);if(r!==null)return r;
// +let cwb=Do(ms(e)),cw=cwb.startsWith("claude-")?void 0:oH(cwb)?.context?.window;
// +if(typeof cw==="number"&&cw>0)return cw;
//  let n=q.CLAUDE_CODE_MAX_CONTEXT_TOKENS; ...
// ```
//
// FAILURE POLICY (changed 2026-08-10): anchor drift returns null (loud ✗),
// never a silent no-op. The 2.1.226 bump renamed mZc→qmf and the old patch
// silently no-opped, leaving custom models at a wrong 200k window for a day
// before anyone noticed. A failed patch is visible in --apply output — and on
// 2.1.237 that is exactly how the `te` -> `q` rename surfaced: --apply refused
// to repack the binary and named this patch.

import { showDiff } from './index';

export const writeContextWindowFromCatalog = (file: string): string | null => {
  // Idempotent: the catalog lookup is already injected.
  if (/\?\.context\?\.window/.test(file)) {
    return file;
  }

  // Anchor 1: the env-override guard inside the resolver. Captures the env-var
  // local, the env namespace, the base-id resolver (wo), the model resolver
  // (ns), and the model parameter — all from the live file so minified renames
  // don't break us.
  //
  // The namespace used to be hardcoded as `te.`, which is precisely what broke
  // on CC 2.1.237: the resolver body is unchanged apart from that object being
  // renamed `te` -> `q`. Hardcoding one minified name in a patch that goes to
  // the trouble of extracting three others was the bug; it is captured now.
  // The rest of the shape is specific enough on its own — the guard's
  // `!wo(ns(e)).startsWith("claude-")` test is unique in the bundle, so
  // widening the namespace to any identifier still yields exactly one match.
  const envGuard =
    /let ([$\w]+)=([$\w]+)\.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if\(\1!==void 0&&\1>0&&!([$\w]+)\(([$\w]+)\(([$\w]+)\)\)\.startsWith\("claude-"\)\)return \1/.exec(
      file
    );

  // Anchor 2: the catalog by-id lookup (Bv), identified by the capabilities
  // check in l2 — `.capabilities.includes` is catalog-entry semantics, unique
  // to the lookup we want.
  const catalogLookup =
    /,([$\w]+)=([$\w]+)\([$\w]+\);if\(\1!==void 0\)return \1\.capabilities\.includes/.exec(
      file
    );

  if (!envGuard || envGuard.index === undefined || !catalogLookup) {
    console.error(
      'patch: contextWindowFromCatalog: resolver/env-guard/catalog-lookup shape not found — re-anchor for this CC version (see patch header)'
    );
    return null;
  }

  const [, , , wo, ns, modelVar] = envGuard;
  const bv = catalogLookup[2];

  const inject =
    `let cwb=${wo}(${ns}(${modelVar})),cw=cwb.startsWith("claude-")?void 0:` +
    `${bv}(cwb)?.context?.window;if(typeof cw==="number"&&cw>0)return cw;`;

  // Insert BEFORE the env-var declaration so the catalog lookup runs first
  // (same ordering as the 2.1.220 version of this patch).
  const pos = envGuard.index;

  const newFile = file.slice(0, pos) + inject + file.slice(pos);
  showDiff(file, newFile, inject, pos, pos);
  return newFile;
};
