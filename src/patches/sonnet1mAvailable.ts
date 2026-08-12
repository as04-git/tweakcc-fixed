// Please see the note about writing patches in ./index
//
// Stop Claude Code from reporting "Sonnet with 1M context is not available for
// your account" when the account is fine and only the *entitlement lookup* is
// unavailable.
//
// THE FALSE NEGATIVE (traced on CC 2.1.228)
//
// Sonnet 5's catalog entry already declares the capability:
//
//   {id:"claude-sonnet-5",...,context:{window:1e6,native_1m:!0,
//    native_1m_3p:{...},supports_1m_beta:!0},...}
//
// so 1M is a property of the model, not of a paid add-on. Three predicates
// decide whether the picker offers it (minified names from 2.1.228):
//
//   function Tse(){return J.CLAUDE_CODE_DISABLE_1M_CONTEXT}       // env kill switch
//   function kpe(){if(Tse())return!1;if(Ui())return UEu();return!0}  // entitlement
//   function fHa(e){ ...only sonnet [1m] ids...;
//                    if(yN(as(e)))return!1;      // native-1m fast path
//                    return!kpe()}               // else ask the entitlement
//
// `yN` is the fast path that *should* answer "yes, natively supported":
//
//   function yN(e){...;let n=Mb(e);
//                  if(n==="firstParty"&&vf()||n6(n)||n==="mantle")return!0;
//                  return HFy(n,r)}              // HFy default: return!1
//
// but `vf()` is a *base-URL* check, not an account check:
//
//   function vf(){if(J._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return eln()}
//   function eln(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return b3e(e)}
//   function b3e(e){try{return["api.anthropic.com"].includes(new URL(e).host)}catch{return!1}}
//
// So ANY session pointed at a local proxy / gateway (an `ANTHROPIC_BASE_URL`
// whose host isn't literally api.anthropic.com — exactly the custom-model
// gateway setup the rest of this repo exists to support) fails `vf()`, `yN`
// falls through to `HFy`'s `default: return!1`, and the decision lands on the
// entitlement lookup:
//
//   function UEu(){let e=Xt().cachedExtraUsageDisabledReason;
//     if(e===void 0)return!1;                    // never fetched  -> "no"
//     if(e===null)return!0;
//     switch(e){case"out_of_credits":return!0;
//       case...:case"fetch_error":case"unknown":return!1;default:return!1}}
//
// `undefined` (not yet fetched), `"fetch_error"` and `"unknown"` all resolve to
// "not entitled". Those are *cache and transport* states, not denials — and a
// gateway-routed session is precisely the case where that cache never gets
// populated from api.anthropic.com. Net effect: `fHa` reports true, `B5p`
// filters `sonnet[1m]` out of the picker, `DU_` never pushes the 1M row, and an
// explicit `/model sonnet[1m]` is rejected with the "not available for your
// account" message.
//
// THE FIX
//
// Drop the entitlement lookup from the sonnet predicate only:
//
//   -function kpe(){if(Tse())return!1;if(Ui())return UEu();return!0}
//   +function kpe(){if(Tse())return!1;return!0}
//
// One edit fixes every consumer, because they all route through this predicate:
// `fHa` (the unavailable gate feeding both the `B5p` picker filter and the
// model-switch validator), `DU_` (which pushes the 1M row into the picker), and
// `MU_`'s `[1m]` gate over `availableModels`. The `Tse()` clause is preserved so
// `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` still turns 1M off.
//
// WHY THE NAME IS RESOLVED, NOT MATCHED DIRECTLY
//
// The opus predicate `Qee` is emitted with a BYTE-IDENTICAL body immediately
// before the sonnet one:
//
//   function Qee(){if(Tse())return!1;if(Ui())return UEu();return!0}
//   function kpe(){if(Tse())return!1;if(Ui())return UEu();return!0}
//
// so a regex written against the body shape matches OPUS first and would
// silently patch the wrong model (a mis-bind that applies cleanly, boots fine,
// and leaves the reported symptom untouched). We therefore anchor on `fHa`,
// whose `"sonnet[1m]"` / `"sonnet-4-6[1m]"` / `"sonnet-5[1m]"` string literals
// are non-minified and stable, read the callee name out of its `return!X()`
// tail, and only then rewrite the function with that name.
//
// A non-patch alternative exists — `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`
// makes `vf()` return true and takes the `yN` fast path — but it lies about the
// base URL globally (it also flips `Spe()`, the `HWs` model_unavailable_gate
// row suppression, and other first-party-only behavior). This patch changes one
// predicate instead.

import { showDiff } from './index';

// `fHa` on 2.1.228. Anchored on the non-minified sonnet 1M id literals; the body
// contains no braces, so `[^{}]*?` safely spans it. Captures the entitlement
// predicate's minified name from the `return!NAME()` tail.
const SONNET_1M_GATE =
  /function [$\w]+\([$\w]+\)\{[^{}]*?"sonnet\[1m\]"[^{}]*?return\s*!\s*([$\w]+)\(\)\}/;

export const writeSonnet1mAvailable = (oldFile: string): string | null => {
  const gate = oldFile.match(SONNET_1M_GATE);
  if (!gate) {
    console.error(
      'patch: sonnet1mAvailable: failed to find the sonnet 1M availability gate ' +
        '(the "sonnet[1m]" literal check ending in return!<entitlement>())'
    );
    return null;
  }
  const entitlementFn = gate[1];

  // Idempotence: the entitlement clause is already gone from this predicate.
  const alreadyPatched = new RegExp(
    `function ${entitlementFn}\\(\\)\\{if\\([$\\w]+\\(\\)\\)return!1;return!0\\}`
  );
  if (alreadyPatched.test(oldFile)) {
    console.log(
      'patch: sonnet1mAvailable: entitlement check already removed — skipping'
    );
    return oldFile;
  }

  // Capture group 1 keeps the `if(Tse())return!1;` env kill switch; the
  // `if(Ui())return UEu();` entitlement clause between it and `return!0` is what
  // gets dropped.
  const definition = new RegExp(
    `function ${entitlementFn}\\(\\)\\{(if\\([$\\w]+\\(\\)\\)return!1;)` +
      `if\\([$\\w]+\\(\\)\\)return [$\\w]+\\(\\);return!0\\}`
  );
  const match = oldFile.match(definition);
  if (!match || match.index === undefined) {
    console.error(
      `patch: sonnet1mAvailable: resolved the entitlement predicate as "${entitlementFn}" ` +
        'but its definition did not match the expected shape — re-anchor for this CC version'
    );
    return null;
  }

  const replacement = `function ${entitlementFn}(){${match[1]}return!0}`;
  const start = match.index;
  const end = start + match[0].length;
  const newFile = oldFile.slice(0, start) + replacement + oldFile.slice(end);

  showDiff(oldFile, newFile, replacement, start, end);
  return newFile;
};
