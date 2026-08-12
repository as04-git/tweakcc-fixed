// Please see the note about writing patches in ./index

import { escapeIdent, showDiff } from './index';

// Historical Claude models to add to the /model picker, alongside the aliases
// (sonnet/opus/haiku/fable/best/opusplan) CC offers natively.
//
// FLOOR: the 4.5 generation. Everything older — Opus 4.1, Opus 4, Sonnet 4, and
// the whole Claude 3 family — is retired at the API, so listing it produced
// picker rows that looked selectable and then failed on first request. CC's own
// catalog still *describes* those families (they remain in the embedded entry
// list so old session transcripts and pinned settings still render a name), and
// `r6()` still reverse-maps their dated wire ids, which is exactly why they
// resolved far enough to appear here without ever being usable. Deprecation is
// not visible in the binary; it has to be encoded by hand, which is what this
// floor is.
//
// `value` is the picker value and the model CC resolves. Both spellings work —
// the catalog `id` (e.g. `claude-opus-4-5`) and the dated
// `provider_ids.first_party` wire name (`claude-opus-4-5-20251101`), which
// `r6()` maps back to the same entry. The dated form is kept where it pins a
// specific snapshot, matching what these entries have always shipped.
// prettier-ignore
export const CUSTOM_MODELS: { value: string; label: string; description: string }[] = [
  { value: 'claude-opus-4-8',              label: 'Opus 4.8',             description: "Claude Opus 4.8" },
  { value: 'claude-opus-4-7',              label: 'Opus 4.7',             description: "Claude Opus 4.7" },
  { value: 'claude-opus-4-6',              label: 'Opus 4.6',             description: "Claude Opus 4.6 (February 2026)" },
  { value: 'claude-sonnet-4-6',            label: 'Sonnet 4.6',           description: "Claude Sonnet 4.6 (February 2026)" },
  { value: 'claude-haiku-4-5-20251001',    label: 'Haiku 4.5',            description: "Claude Haiku 4.5 (October 2025)" },
  { value: 'claude-opus-4-5-20251101',     label: 'Opus 4.5',             description: "Claude Opus 4.5 (November 2025)" },
  { value: 'claude-sonnet-4-5-20250929',   label: 'Sonnet 4.5',           description: "Claude Sonnet 4.5 (September 2025)" },
];

export const findCustomModelListInsertionPoint = (
  fileContents: string
): { insertionIndex: number; modelListVar: string } | null => {
  // 1. Find the custom model push pattern.
  // The lead boundary must NOT be a literal space: CC 2.1.197 restructured the
  // availableModels enumeration into a for-of loop so the push is now preceded by
  // `;` (`...continue;t.push({value:c,...})`) instead of a space. A negative
  // lookbehind on [$\w] captures the full list var regardless of the preceding
  // punctuation (`;`, ` `, `{`, `,`, …). The sibling opus[1m] helper push wraps its
  // arg as `.push(gda(s)??{value:...})`, so requiring `.push({value:` right after
  // the paren keeps this matching only the real model-list assembly site.
  const pushPattern =
    /(?<![$\w])([$\w]+)\.push\(\{value:[$\w]+,label:[$\w]+,description:"Custom model"\}\)/;
  const pushMatch = fileContents.match(pushPattern);
  if (!pushMatch || pushMatch.index === undefined) {
    console.error(
      'patch: findCustomModelListInsertionPoint: failed to find custom model push'
    );
    return null;
  }

  // 2. Extract the model list variable name
  const modelListVar = pushMatch[1];

  // The declaration/function head can move farther from the push site across CC builds
  // and when other patches expand this block (notably opusplan1m, which injects ~400
  // bytes BEFORE the custom-model push inside the same function), so keep a generous
  // lookback window. On CC 2.1.140 the head sits ~1500 bytes from the push BEFORE
  // opusplan1m runs and ~1530 bytes after, so 5000 leaves comfortable slack for
  // future CC builds and additional pre-patches.
  const searchStart = Math.max(0, pushMatch.index - 5000);
  const chunk = fileContents.slice(searchStart, pushMatch.index);

  // Declaration can be emitted as let/var/const depending on minifier output,
  // or as one variable in a comma-separated declaration list.
  const declPattern = `(?:(?:let|var|const) |,)${escapeIdent(modelListVar)}=.+?;`;
  const funcPattern = new RegExp(
    `function [$\\w]+\\([^)]*\\)\\{[\\s\\S]{0,5000}?${declPattern}`,
    'g'
  );
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(chunk)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    console.error(
      `patch: findCustomModelListInsertionPoint: failed to find function with ${modelListVar}`
    );
    return null;
  }

  // 5. Return index after the semicolon (end of the match), and the var name
  const insertionIndex = searchStart + lastMatch.index + lastMatch[0].length;
  return { insertionIndex, modelListVar };
};

// Collect every model name the embedded catalog will resolve: each entry's `id`
// plus all of its `provider_ids` values (the dated `first_party` wire names are
// what several CUSTOM_MODELS entries use, and `r6()` maps them back to the same
// entry). Returns null if the catalog can't be read, which is the signal to skip
// filtering rather than to drop everything.
//
// This is a VALIDITY filter, not a deprecation filter — the catalog carries no
// deprecation marker, so retired-but-still-catalogued families (Claude 3.5,
// Opus 4, Opus 4.1) pass it. Deprecation is the CUSTOM_MODELS floor's job. What
// this catches is the other failure: an entry naming a model this build has
// never heard of, which produces a picker row that looks selectable and then
// fails on first request. Three such entries shipped for a long time
// (claude-3-5-sonnet-20240620, claude-3-haiku-20240307, claude-3-opus-20240229 —
// all absent from the 2.1.228 catalog), so this is a real drift mode, and it is
// silent: the push applies cleanly and every counter stays zero.
const collectCatalogModelNames = (fileContents: string): Set<string> | null => {
  const entry =
    /\{id:"(claude-[^"]+)",family:"[^"]+",display_name:"[^"]+"(.{0,600}?)provider_ids:\{([^}]*)\}/gs;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = entry.exec(fileContents)) !== null) {
    names.add(match[1]);
    for (const value of match[3].matchAll(/:"([^"]+)"/g)) names.add(value[1]);
  }
  return names.size > 0 ? names : null;
};

export const writeModelCustomizations = (oldFile: string): string | null => {
  // Skip if custom models are already injected (e.g. from a previous
  // tweakcc run baked into the backup, or future native support).
  // The JSON.stringify format uses quoted keys: {"value":"claude-opus-4-6",...}
  if (oldFile.includes('"value":"claude-opus-4-6"')) {
    console.log(
      'patch: modelCustomizations: custom models already present — skipping'
    );
    return oldFile;
  }

  const found = findCustomModelListInsertionPoint(oldFile);
  if (!found) return null;

  const { insertionIndex, modelListVar } = found;

  const catalogNames = collectCatalogModelNames(oldFile);
  let models = CUSTOM_MODELS;
  if (catalogNames === null) {
    console.log(
      'patch: modelCustomizations: could not read the embedded catalog — ' +
        'injecting all models unfiltered'
    );
  } else {
    models = CUSTOM_MODELS.filter(m => catalogNames.has(m.value));
    for (const dropped of CUSTOM_MODELS.filter(m => !catalogNames.has(m.value)))
      console.log(
        `patch: modelCustomizations: skipping "${dropped.label}" (${dropped.value}) — ` +
          'not in this build\'s model catalog'
      );
  }

  if (models.length === 0) {
    console.error(
      'patch: modelCustomizations: no CUSTOM_MODELS entry is present in this ' +
        "build's catalog — the list needs updating for this CC version"
    );
    return null;
  }

  // Build the injection: push each custom model onto the list
  const inject = models
    .map(model => `${modelListVar}.push(${JSON.stringify(model)});`)
    .join('');

  const newFile =
    oldFile.slice(0, insertionIndex) + inject + oldFile.slice(insertionIndex);
  showDiff(oldFile, newFile, inject, insertionIndex, insertionIndex);
  return newFile;
};
