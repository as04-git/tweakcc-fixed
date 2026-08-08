// Please see the note about writing patches in ./index
//
// Make short aliases from settings.customModels[].alias resolve in /model.
//
// CC's model resolver is a single choke point (CC 2.1.220):
//
//   function vi(e){let t=e.trim(),r=t.toLowerCase(),n=Wb(r),o=n?Qs(r).trim():r;
//     if(RI(o))switch(o){case"fable":... case"opus":... case"best":... default:}
//     if(rm()&&O1e(o)&&Ykt())return ...;
//     if(n&&xoe()&&zig(o)&&IP(o))return ...;
//     if(n)return ...;return yL(t)}               // unknown ids pass through
//
// RI() tests membership in a HARDCODED alias list:
//   m1e=["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]",
//        "fable[1m]","opusplan"]
// The catalog's own aliases{} are never consulted here, so injected catalog
// entries with an `alias` field were unreachable as `/model <alias>` — the
// alias fell to the identity return and went to the proxy verbatim (400
// "unknown provider for model k3").
//
// Everything downstream of /model — catalog lookup (ww), context window (mZc),
// max output (lst), the skill/frontmatter allowlist (R5r calls vi() FIRST,
// then gates on the resolved id) — keys off vi()'s return value, so one
// injection at the head of vi() fixes aliases for /model, --model, agent
// frontmatter, and the Agent tool's model param simultaneously:
//
// ```diff
//  function vi(e){let t=e.trim(),r=t.toLowerCase(),n=Wb(r),o=n?Qs(r).trim():r;
// + let am={"k3":"kimi-k3","sol":"gpt-5.6-sol"};if(am[o])return am[o];
//  if(RI(o))switch(o){...
// ```
//
// Placement notes:
// - BEFORE the RI() switch, so aliases compose with nothing built-in and
//   cannot accidentally ride the [1m] arms. An alias maps to a bare catalog
//   id; `/model k3[1m]` resolves to the same id ([1m] is stripped into `o`
//   before lookup and deliberately not re-appended — custom windows are what
//   the catalog says they are).
// - Matching is case-insensitive for free (`o` derives from the lowercased
//   `r`); alias keys are lowercased at injection time.
//
// Guards:
// - Refuses aliases that collide with the built-in RI() list — the injection
//   precedes the switch, so `alias: "opus"` would shadow built-in opus.
// - Refuses aliases that collide with another custom model's id.
// - Refuses duplicate aliases (first-wins would be a silent config mistake).
// - Value changes (rename/re-point an alias) require `--restore && --apply`:
//   the anchor shape no longer matches once a map is injected, and a partial
//   pair-match is reported as such instead of double-injecting.

import { showDiff } from './index';
import { CustomModelDefinition } from '../types';

// CC 2.1.220's hardcoded resolver list (m1e), minus the [1m] variants which
// reduce to these bases before the switch.
const BUILTIN_ALIASES = new Set([
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'best',
  'opusplan',
]);

export const writeCustomModelAlias = (
  oldFile: string,
  models: CustomModelDefinition[]
): string | null => {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  const ids = new Set(models.map(m => m.id));

  for (const m of models) {
    if (!m.alias) continue;
    const key = m.alias.trim().toLowerCase();
    if (!key) continue;
    if (BUILTIN_ALIASES.has(key)) {
      console.error(
        `patch: customModelAlias: alias "${m.alias}" collides with a built-in ` +
          `resolver word — it would shadow it. Rename the alias.`
      );
      return null;
    }
    if (ids.has(key)) {
      console.error(
        `patch: customModelAlias: alias "${m.alias}" collides with a custom ` +
          `model id — pick a distinct alias.`
      );
      return null;
    }
    if (seen.has(key)) {
      console.error(
        `patch: customModelAlias: duplicate alias "${m.alias}" — aliases must be unique.`
      );
      return null;
    }
    seen.add(key);
    pairs.push([key, m.id]);
  }
  if (pairs.length === 0) return oldFile;

  // Idempotence: every pair already present -> skip. SOME present means the
  // config changed under an injected map — refuse loudly (restore first).
  const present = pairs.filter(([a, id]) =>
    oldFile.includes(`${JSON.stringify(a)}:${JSON.stringify(id)}`)
  );
  if (present.length === pairs.length) {
    console.log(
      'patch: customModelAlias: alias map already present — skipping'
    );
    return oldFile;
  }
  if (present.length > 0) {
    console.error(
      'patch: customModelAlias: a different alias map is already injected — ' +
        'run --restore before --apply to change aliases'
    );
    return null;
  }

  // Anchor: the head of vi(), capturing the minified locals so helper renames
  // (Wb/Qs/RI) across CC versions are tolerated; structural drift is not.
  const pattern =
    /function ([$\w]+)\(([$\w]+)\)\{let ([$\w]+)=\2\.trim\(\),([$\w]+)=\3\.toLowerCase\(\),([$\w]+)=([$\w]+)\(\4\),([$\w]+)=\5\?([$\w]+)\(\4\)\.trim\(\):\4;if\(([$\w]+)\(\7\)\)switch\(\7\)\{/;
  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    if (
      !/function [$\w]+\([$\w]+\)\{let [$\w]+=[$\w]+\.trim\(\)/.test(oldFile)
    ) {
      console.error(
        'patch: customModelAlias: model resolver (vi) not found — cannot wire aliases'
      );
    } else {
      console.error(
        'patch: customModelAlias: found the resolver but not the trim/lower/' +
          '[1m]-strip head shape — re-anchor for this CC version'
      );
    }
    return null;
  }

  const aliasVar = match[7]; // the [1m]-stripped, lowercased local (`o`)
  const mapLiteral =
    '{' +
    pairs
      .map(([a, id]) => `${JSON.stringify(a)}:${JSON.stringify(id)}`)
      .join(',') +
    '}';
  const inject = `let am=${mapLiteral};if(am[${aliasVar}])return am[${aliasVar}];`;

  // match[0] ends at `switch(o){`; insert right before `;if(RI(o))switch(o){`
  // — i.e. after the `o` declaration, before the built-in switch.
  const ifIdx = match[0].lastIndexOf(';if(');
  const pos = match.index + ifIdx + 1;

  const newFile = oldFile.slice(0, pos) + inject + oldFile.slice(pos);
  showDiff(oldFile, newFile, inject, pos, pos);
  return newFile;
};
