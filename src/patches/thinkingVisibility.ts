// Please see the note about writing patches in ./index

import { showDiff } from './index';

/**
 * CC v2.0.50
 * ```diff
 *  case "thinking":
 * -  if (!V && !I) return null;
 *    return w3.createElement(Q$Q, {
 *      addMargin: B,
 *      param: A,
 * -    isTranscriptMode: V,
 * +    isTranscriptMode: true,
 *      verbose: I,
 *    });
 * ```
 *
 * CC v2.1.18
 * ```diff
 *  case "thinking": {
 * -  if (!D && !H) return null;
 *    let T = D && !(!P || f === P),
 *      k;
 *    if (K[22] !== Y || K[23] !== D || K[24] !== q || K[25] !== T || K[26] !== H)
 *      k = Y9.createElement(YW1, {
 *        addMargin: Y,
 *        param: q,
 * -      isTranscriptMode: D,
 * +      isTranscriptMode: true,
 *        verbose: H,
 *        hideInTranscript: T,
 *      });
 *  }
 * ```
 */

export const writeThinkingVisibility = (oldFile: string): string | null => {
  // CC ≥ 2.1.87 ships with thinking blocks always visible — skip if already configured.
  const nativeCheck =
    /case"thinking":\{(?:(?!case")[^]){0,600}isTranscriptMode:true/;
  if (nativeCheck.test(oldFile)) {
    console.log(
      'patch: thinkingVisibility: already configured natively — skipping'
    );
    return oldFile;
  }

  // Method 1 (CC >= 2.1.237). Anthropic inserted a whole alternate-renderer
  // branch between `case"thinking":{` and the early return:
  //
  //   case"thinking":{
  //     if(KYi!==null&&YYi!==null&&KYi(NL)){ ... return e6 }   <-- new
  //     if(!Tzt&&!yhe){return null}
  //     ... jsx(prn,{addMargin:U8,param:NL,isTranscriptMode:Tzt,verbose:yhe})
  //
  // so every `case"thinking":`-prefixed pattern below stops matching even though
  // the code it targets is byte-for-byte the same. (`KYi`/`YYi` are declared
  // `null` and assigned nowhere in the bundle — 3 occurrences each, the
  // declaration plus the two reads in that guard — so the new branch is a dead
  // injection seam and the second branch is still the live one.)
  //
  // The fix is to stop anchoring on the enclosing `case` at all. The early
  // return and the JSX props are self-consistent: the two negated variables ARE
  // `isTranscriptMode` and `verbose`, in that order, so backreferencing them
  // makes the anchor unique on its own (verified: exactly 1 match in 2.1.237)
  // and immune to anything Anthropic inserts ahead of it.
  const selfConsistent =
    /if\(!([$\w]+)&&!([$\w]+)\)\{?return null\}?;?(.{0,400}?isTranscriptMode:)\1,verbose:\2/;
  const scMatch = oldFile.match(selfConsistent);
  if (scMatch && scMatch.index !== undefined) {
    const replacement = scMatch[3] + 'true,verbose:' + scMatch[2];
    const start = scMatch.index;
    const end = start + scMatch[0].length;
    const newFile = oldFile.slice(0, start) + replacement + oldFile.slice(end);
    showDiff(oldFile, newFile, replacement, start, end);
    return newFile;
  }

  // Unified pattern that matches all three formats:
  // - Group 1: `case"thinking":` (+/- `{`)
  // - Group 2: the early return we want to remove. CC <= 2.1.18:
  //   `if(!D&&!H)return null;`; CC 2.1.204: `if(!cit&&!BY){return null}`
  //   (braces, no trailing semicolon). Anchored on the two negated vars so the
  //   lazy body can't span to an unrelated `return null` (e.g. the separate
  //   `case"thinking":` spinner-icon block that has no early return).
  // - Group 3: Everything from `{` or return up to `isTranscriptMode:`
  // - Then the variable name followed by comma (replaced with `true,`)
  const pattern =
    /(case"thinking":\{?)(if\(![$\w]+&&![$\w]+\)\{?return null\}?;?)(.{0,400}isTranscriptMode:).+?,/;

  const match = oldFile.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: thinkingVisibility: failed to find thinking visibility pattern'
    );
    return null;
  }

  // Replacement: skip match[2] (removes the if-return-null), set isTranscriptMode to true
  const replacement = match[1] + match[3] + 'true,';

  const startIndex = match.index;
  const endIndex = startIndex + match[0].length;

  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);

  showDiff(oldFile, newFile, replacement, startIndex, endIndex);

  return newFile;
};
