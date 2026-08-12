// Please see the note about writing patches in ./index
//
// Adds a "fableplan" model alias: Fable while planning, Opus while executing.
//
// It is a SELECTABLE MODEL ALIAS, deliberately, and that is the whole design.
// The obvious alternative — hooking the plan/execute transition and swapping the
// model — is wrong: `Net({from,to,trigger})` is the mode-change telemetry call,
// so wrapping it mutates state on EVERY plan<->execute transition for EVERY
// user, whether or not they chose this pairing, and it fights `/model`.
//
// Claude Code already ships exactly the right mechanism for two aliases of its
// own, and this rides it:
//
//   function uM(e){ let{permissionMode:t,mainLoopModel:r,...}=e, o=tW();
//     if((o==="opusplan"||o==="opusplan[1m]")&&t==="plan"&&!n){ …Opus… }
//     if(tW()==="haiku"&&t==="plan"){ …Sonnet… }
//     return r }
//
// `uM` answers "which model does THIS request use", gated on the selected alias
// `tW()`. So nothing happens unless the user picks fableplan, the selection
// stays `fableplan` in `/model` throughout, and nothing is ever switched
// underneath them.
//
// Six splices, all anchored on shapes verified against CC 2.1.228:
//   1. the alias whitelist  (`sM()` rejects anything not in it)
//   2. the plan resolver `uM`
//   3. the builtin-default switch
//   4. the alias -> concrete model switch
//   5. the `/model` picker options
//   6. the effort resolver
//
// Effort keys on the RESOLVED MODEL, not on plan mode. The alias already encodes
// the mode — planning resolves to Fable, executing to Opus — so the model the
// effort resolver is handed says which side of the pairing we are on, with no
// need for a plan-mode getter inside it. It also composes with the complexity
// router, which splices the same function at a different point (right after its
// `=ENV();` prefix): this rides the top of the body, so when fableplan is
// selected it answers first and the router keeps every other model.

// Scope note, because it nearly went the other way. The splices call helpers
// declared far from where they are injected — the effort resolver reaches for
// the selected-alias getter half a megabyte away, and the plan resolver calls
// the alias-to-model function. Bun's bundle wraps each module as
// `var NAME=v(()=>{…})`, which LOOKS like it would trap those declarations in a
// closure, and a cross-closure call would be a ReferenceError at runtime that
// every parse gate passes. It does not: the `v(()=>{})` body carries only the
// assignments, and the `function` declarations sit at module-outer scope.
// Verified against 2.1.228 by brace balance and by the vanilla bundle's own
// call sites — the alias getter is called from 20.7 MB away, the alias-to-model
// function from 22 MB. Re-check this before moving a splice to a new site.

import { FablePlanConfig } from '../types';
import { debug } from '../utils';
import { showDiff } from './index';

const ALIAS = 'fableplan';

/**
 * Splice 1 — the alias whitelist.
 *
 * `h9e=["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]",
 *       "fable[1m]","opusplan"]`, read by `sM(e){return h9e.includes(e)}`.
 * Every other site defers to this, so an alias missing here is inert no matter
 * what the rest of the patch does.
 */
const patchAliasWhitelist = (file: string): string | null => {
  // Idempotency must be checked AT THIS SITE, not by asking whether the alias
  // appears anywhere in the bundle: the sibling splices put it in four other
  // places first, so a global check silently skipped the one splice that makes
  // the alias legal at all, and `sM()` then rejected it everywhere.
  // Trailing entries are allowed so the pattern still matches its OWN output;
  // an anchor that cannot see the patched shape reports "failed to find" on the
  // second run rather than "already applied".
  const pattern =
    /(\[(?:"[\w[\]]+",)*"opusplan"(?:,"[\w[\]]+")*\])(\s*,\s*[$\w]+\s*=\s*\["sonnet","opus","haiku")/;
  const match = file.match(pattern);
  if (match && match[1].includes(`"${ALIAS}"`)) {
    debug('patch: fablePlan: alias already in the whitelist — skipping');
    return file;
  }
  if (!match || match.index === undefined) {
    console.error('patch: fablePlan: failed to find the model alias whitelist');
    return null;
  }
  const replacement = match[1].slice(0, -1) + `,"${ALIAS}"]` + match[2];
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 2 — the per-request model resolver.
 *
 * Inserted immediately after the destructuring so it answers before the
 * opusplan and haiku branches, and falls through to Claude Code's own
 * resolution for every other alias. `as(alias)` is CC's alias -> concrete model
 * function, so org model restrictions and `[1m]` handling apply unchanged.
 */
const patchPlanResolver = (
  file: string,
  config: FablePlanConfig,
  aliasToModel: string
): string | null => {
  const pattern =
    /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3,([$\w]+)=([$\w]+)\(\);)/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error(
      'patch: fablePlan: failed to find the plan-mode model resolver (uM shape)'
    );
    return null;
  }
  const [, prefix, , , mode, , , selected] = match;
  const injection =
    `if(${selected}==="${ALIAS}")return ${aliasToModel}(` +
    `${mode}==="plan"?"${config.planModel}":"${config.execModel}");`;
  const replacement = prefix + injection;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 3 — the builtin-default switch.
 *
 * `function Gvo(e){let t=T9e();switch(e){case"opus":return zZe(t);…
 *   case"opusplan":return Kvo(t);…}}`
 * Answers "what does this alias default to", used outside plan mode. fableplan
 * mirrors whatever its EXEC model resolves to, since that is its resting state.
 */
const patchBuiltinDefault = (
  file: string,
  config: FablePlanConfig
): string | null => {
  const pattern = new RegExp(
    `(switch\\(([$\\w]+)\\)\\{(?:case"[\\w]+":return [$\\w]+\\([$\\w]+\\);)*?case"${config.execModel}":return ([$\\w]+)\\(([$\\w]+)\\);)`
  );
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error(
      'patch: fablePlan: failed to find the builtin-default alias switch'
    );
    return null;
  }
  const replacement = `${match[1]}case"${ALIAS}":return ${match[3]}(${match[4]});`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 4 — alias to concrete model.
 *
 * `function as(e){…if(sM(o))switch(o){case"fable":{…}case"opusplan":return
 *   n?aM(vJ(yk())):yk();…case"opus":return n?aM(vJ(ww())):ww();…}}`
 * The exec model's arm is cloned verbatim under the new alias, so fableplan
 * rests on exactly what that alias rests on. Returns the resolver's own name so
 * splice 2 can call it.
 */
const patchAliasToModel = (
  file: string,
  config: FablePlanConfig
): { file: string; resolver: string } | null => {
  const pattern = new RegExp(
    `function ([$\\w]+)\\(([$\\w]+)\\)\\{let [$\\w]+=\\2\\.trim\\(\\)[\\s\\S]{0,120}?if\\([$\\w]+\\(([$\\w]+)\\)\\)switch\\(\\3\\)\\{` +
      `([\\s\\S]{0,600}?case"${config.execModel}":(return [^;]+;))`
  );
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error(
      'patch: fablePlan: failed to find the alias-to-model resolver (as shape)'
    );
    return null;
  }
  const resolver = match[1];
  const upTo = match[0];
  const replacement = `${upTo}case"${ALIAS}":${match[5]}`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + upTo.length);
  showDiff(file, newFile, replacement, match.index, match.index + upTo.length);
  return { file: newFile, resolver };
};

/**
 * Splice 5 — the `/model` picker.
 *
 * `function qB_(e,t){let r=BB_(e),n=X.ANTHROPIC_CUSTOM_MODEL_OPTION;…}` builds
 * the option list. Claude Code has a sibling for opusplan
 * (`{value:"opusplan",label:"Opus Plan Mode",description:"Use Opus in plan
 * mode, Sonnet otherwise"}`) but only splices it in when opusplan is ALREADY
 * selected, so the option has to be pushed onto the base list to be pickable.
 */
const patchModelPicker = (
  file: string,
  config: FablePlanConfig
): string | null => {
  const pattern =
    /(function [$\w]+\(([$\w]+),([$\w]+)\)\{let ([$\w]+)=[$\w]+\(\2\),([$\w]+)=[$\w]+\.ANTHROPIC_CUSTOM_MODEL_OPTION;)/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error('patch: fablePlan: failed to find the model picker options');
    return null;
  }
  const list = match[4];
  const label = `${title(config.planModel)} Plan Mode`;
  const description = `Use ${title(config.planModel)} in plan mode, ${title(config.execModel)} otherwise`;
  const option = JSON.stringify({ value: ALIAS, label, description });
  const injection = `if(!${list}.some((z)=>z.value==="${ALIAS}"))${list}.push(${option});`;
  const replacement = match[1] + injection;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 6 — reasoning effort, keyed on the resolved model.
 *
 * The alias already encodes the mode, so the model handed to the effort
 * resolver says which side of the pairing this request is on — no plan-mode
 * getter needed inside it. Rides the top of the resolver body, which is a
 * different anchor from the complexity router's (`=ENV();`), so the two
 * compose: fableplan answers for its own two models, the router keeps the rest.
 */
const patchEffortResolver = (
  file: string,
  config: FablePlanConfig,
  selectedAlias: string
): string | null => {
  const pattern =
    /(function ([$\w]+)\(([$\w]+),([$\w]+)\)\{)(if\(!([$\w]+)\(\3\)\)return;let [$\w]+=[$\w]+\(\3\),[$\w]+=[$\w]+\(\3\),[$\w]+=[$\w]+\(\);)/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    if (!file.includes('CLAUDE_CODE_EFFORT_LEVEL')) {
      debug('patch: fablePlan: effort resolver absent in this build — no-op');
      return file;
    }
    console.error('patch: fablePlan: failed to find the effort resolver');
    return null;
  }
  const model = match[3];
  const injection =
    `if(${selectedAlias}()==="${ALIAS}")` +
    `return String(${model}).includes("${config.planModel}")` +
    `?"${config.planEffort}":"${config.execEffort}";`;
  const replacement = match[1] + injection + match[5];
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 7 — surface Claude Code's own clear-context option.
 *
 * `let p=it((yt)=>yt.settings.showClearContextOnPlanAccept)??!1` — Claude Code
 * builds the option and then defaults it OFF. Flipping the fallback to true
 * offers "Yes, clear context (N% used) and auto-accept edits", which hands only
 * the plan to the executing model instead of re-sending the whole planning
 * transcript to a different one. Independent of the pairing.
 */
const patchClearContextOption = (file: string): string | null => {
  const pattern =
    /(=[$\w]+\(\([$\w]+\)=>[$\w]+\.settings\.showClearContextOnPlanAccept\)\?\?)!1/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    debug(
      'patch: fablePlan: showClearContextOnPlanAccept gate not present — no-op'
    );
    return file;
  }
  const replacement = `${match[1]}!0`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

const title = (alias: string): string =>
  alias.charAt(0).toUpperCase() + alias.slice(1);

/**
 * The alias sitting in the whitelist is the definitive marker that this patch
 * has run: it is the one splice without which every other one is inert, and no
 * vanilla build ships it. Checked up front so a re-apply is a no-op rather than
 * a second set of splices — five of the six anchors still match their own
 * output and would happily inject twice.
 */
const ALREADY_APPLIED = new RegExp(
  `\\["sonnet",(?:"[\\w[\\]]+",)*"${ALIAS}"[,\\]]`
);

export const writeFablePlan = (
  oldFile: string,
  config: FablePlanConfig
): string | null => {
  if (ALREADY_APPLIED.test(oldFile)) {
    debug('patch: fablePlan: already applied — no-op');
    return oldFile;
  }
  if (config.planModel === config.execModel) {
    console.error(
      'patch: fablePlan: planModel and execModel are the same — nothing to pair'
    );
    return null;
  }

  // The alias-to-model resolver goes first: it hands back its own minified name,
  // which the plan resolver calls.
  const resolved = patchAliasToModel(oldFile, config);
  if (!resolved) return null;
  let file = resolved.file;

  const whitelisted = patchAliasWhitelist(file);
  if (!whitelisted) return null;
  file = whitelisted;

  const planned = patchPlanResolver(file, config, resolved.resolver);
  if (!planned) return null;
  file = planned;

  const defaulted = patchBuiltinDefault(file, config);
  if (!defaulted) return null;
  file = defaulted;

  const picked = patchModelPicker(file, config);
  if (!picked) return null;
  file = picked;

  // The selected-alias getter is the `o=NAME()` captured by the plan resolver;
  // re-read it here rather than threading it through, so a shape change in one
  // does not silently mis-wire the other.
  const selectedAlias = file.match(
    /let\{permissionMode:[$\w]+,mainLoopModel:[$\w]+,exceeds200kTokens:[$\w]+=!1\}=[$\w]+,[$\w]+=([$\w]+)\(\);/
  )?.[1];
  if (!selectedAlias) {
    console.error(
      'patch: fablePlan: failed to read the selected-alias getter for effort'
    );
    return null;
  }

  const efforted = patchEffortResolver(file, config, selectedAlias);
  if (!efforted) return null;
  file = efforted;

  if (config.offerClearContextOnPlanAccept) {
    const cleared = patchClearContextOption(file);
    if (!cleared) return null;
    file = cleared;
  }

  return file;
};
