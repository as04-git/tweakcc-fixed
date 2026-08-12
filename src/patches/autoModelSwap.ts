// Please see the note about writing patches in ./index
//
// Auto-model-swap at the auto-compact threshold (M14 / claude-gateway).
//
// When a session on a small-context custom model reaches its auto-compact
// ceiling, CC's default behavior is to compact — destroying the raw
// conversation and replacing it with a summary. For gateway models that have
// a larger-window sibling (kimi-k3-256k → kimi-k3 @ 1M), the strictly better
// move is to swap the session model to the larger window and continue
// uncompacted. This patch does that swap at the exact point where compaction
// would otherwise trigger.
//
// Insertion site (CC 2.1.226): fXs(), the auto-compact generator exported as
// `autocompact` from the deps object (rVd). Its head:
//
//   async function*fXs(e,t,r,n,o,i,s){
//     if(te.DISABLE_COMPACT)return{kind:"not_needed"};
//     if(o?.consecutiveFailures!==void 0&&o.consecutiveFailures>=DYd)
//       return{kind:"failure_breaker_open"};
//     let a=t.options.mainLoopModel,l=t.options.autoCompactWindow;
//     if(!await KJ_(e,a,l,n,i,t.agentContext))return{kind:"not_needed"};
//     ...                                            // compaction proceeds
//
// `e` = messages, `t` = the query loop's toolUseContext — the SAME object the
// query loop holds, so mutating `t.options.mainLoopModel` in place propagates
// to every downstream reader this turn (fXs reads it again later, the pre-
// computed-compact armer QKs reads it, etc.), and `t.setAppState` updates the
// appState the query loop polls between turns (the live-switch path). This is
// exactly the mutation the /model handler (vwn) and the native consent/refusal
// fallback swaps perform; we replicate it, minus Ewn (settings persist) — the
// swap is SESSION-ONLY by design. A fresh 256k session will auto-swap again
// when it fills; the user's default stays untouched.
//
// Placement is AFTER the KJ_ threshold gate, so the swap only fires when
// compaction is actually due — mid-session turns pass through untouched — and
// BEFORE the reactive/auto branch, so both compaction routes are covered.
// Because the swapped model's window (1M) exceeds current usage, the next
// turn's KJ_ evaluation returns not_needed and compaction never fires.
//
// ```diff
//  if(!await KJ_(e,a,l,n,i,t.agentContext))return{kind:"not_needed"};
// +{const __sw={"kimi-k3-256k":"kimi-k3"},__to=__sw[a];if(__to){
// +  t.setAppState(X=>({...X,mainLoopModel:__to,mainLoopModelForSession:null}));
// +  t.options={...t.options,mainLoopModel:__to};
// +  yield{type:"system",subtype:"notification",...};   // visible banner
// +  try{ ... spawn ~/claude-gateway/bin/model-swap-event ... }catch{}
// +  return{kind:"not_needed"}}}
// ```
//
// The side-door: the patch spawns ~/claude-gateway/bin/model-swap-event IF
// IT EXISTS (fire-and-forget, detached, stdin JSON record). That script
// appends to ~/claude-gateway/model-swap-stats.jsonl and can grow any other
// reaction later — all policy lives OUTSIDE the binary, one anchor inside.
// Absent script = stats silently skipped. Deliberately NOT routed through
// CC's hook system: the event set is closed (3-4 extra anchors in high-churn
// code), and hooks exist to intercept CC's decisions — here the patch IS the
// decision-maker.
//
// fastMode bookkeeping (f3/m3 in the native swap paths) is skipped on
// purpose: that gate is Claude-side; no custom model can be a fast-mode
// target.
//
// ANCHOR / FAILURE POLICY (per M13 lesson): anchored on literal strings that
// survive minification — "DISABLE_COMPACT", "mainLoopModel",
// "autoCompactWindow", "agentContext", {kind:"not_needed"} — with the
// function/variable names extracted from the live file at apply time. Anchor
// drift → console.error + null (loud ✗ in --apply), never a silent no-op.

import { showDiff } from './index';

export const writeAutoModelSwap = (file: string): string | null => {
  // Idempotent: the swap map is already injected.
  if (file.includes('__autoModelSwapMap=')) {
    return file;
  }

  // Anchor: the fXs head. Params are (e=messages, t=toolUseContext, r,
  // n=querySource, o=state, i, s) — the consecutiveFailures check runs on the
  // 5th param (o), the KJ_ threshold gate takes (e, a, l, n, i,
  // t.agentContext). Captures messages (1), toolUseContext (2), and the
  // current-model var (8) — all live-extracted so minified renames don't
  // break the patch. Literal strings ("DISABLE_COMPACT", "mainLoopModel",
  // "autoCompactWindow", "agentContext", the {kind:...} returns) are the
  // anchor substance; they survive minification.
  const head =
    /async function\*[$\w]+\(([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)\{if\([$\w]+\.DISABLE_COMPACT\)return\{kind:"not_needed"\};if\(\5\?\.consecutiveFailures!==void 0&&\5\.consecutiveFailures>=[$\w]+\)return\{kind:"failure_breaker_open"\};let ([$\w]+)=\2\.options\.mainLoopModel,([$\w]+)=\2\.options\.autoCompactWindow;if\(!await [$\w]+\(\1,\8,\9,\4,\6,\2\.agentContext\)\)return\{kind:"not_needed"\};/.exec(
      file
    );

  if (!head || head.index === undefined) {
    console.error(
      'patch: autoModelSwap: fXs head shape not found (DISABLE_COMPACT / ' +
        'mainLoopModel / autoCompactWindow / agentContext gate) — re-anchor ' +
        'for this CC version (see patch header)'
    );
    return null;
  }

  const [, messagesVar, ctxVar, , , , , , modelVar] = head;
  const insertPos = head.index + head[0].length;

  // t.setAppState + in-place options mutation = the /model (vwn) swap, minus
  // Ewn persist. Yielded notification matches the shape lv() uses elsewhere
  // ({type:"system",subtype:"notification",key,text,priority,color}) so it
  // renders as a banner, not raw transcript noise.
  const inject =
    `{const __autoModelSwapMap={"kimi-k3-256k":"kimi-k3"},` +
    `__autoModelSwapTo=__autoModelSwapMap[${modelVar}];` +
    `if(__autoModelSwapTo){` +
    `${ctxVar}.setAppState(__amsX=>({...__amsX,mainLoopModel:__autoModelSwapTo,mainLoopModelForSession:null}));` +
    `${ctxVar}.options={...${ctxVar}.options,mainLoopModel:__autoModelSwapTo};` +
    'yield{type:"system",subtype:"notification",key:"auto-model-swap",' +
    'text:`Context full on ${' +
    modelVar +
    '} — switched to ${__autoModelSwapTo} for this session · continuing uncompacted`,' +
    'priority:"immediate",color:"info"};' +
    'try{const __amsEv=[require("os").homedir(),"claude-gateway","bin","model-swap-event"].join("/");' +
    'if(require("fs").existsSync(__amsEv)){' +
    'const __amsP=require("child_process").spawn(__amsEv,[],{stdio:["pipe","ignore","ignore"],detached:!0});' +
    '__amsP.on("error",()=>{});' +
    '__amsP.stdin.end(JSON.stringify({ts:new Date().toISOString(),from:' +
    modelVar +
    ',to:__autoModelSwapTo,message_count:' +
    messagesVar +
    '.length}));' +
    '__amsP.unref()}}catch{}' +
    'return{kind:"not_needed"}}}';

  const newFile = file.slice(0, insertPos) + inject + file.slice(insertPos);
  showDiff(file, newFile, inject, insertPos, insertPos);
  return newFile;
};
