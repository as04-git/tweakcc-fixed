// Please see the note about writing patches in ./index
//
// Inject custom (non-Anthropic) models into Claude Code's embedded model
// catalog so they become first-class: they appear in /model with a real label,
// report a correct context window to the statusline + auto-compaction, gate the
// right /effort rungs, and are usable by subagents. The built-in families
// (opus/sonnet/haiku/fable) are never modified.
//
// The catalog is a single embedded object literal (validated at runtime by a
// Zod schema in cli.js). On CC 2.1.220 it ends like:
//
//   ...image_limits:{maxWidth:2000,maxHeight:2000},advisor_rank:5}],aliases:{opus:{default:"claude-opus-5",...
//   ...haiku:{default:"claude-haiku-4-5"},fable:{default:"claude-fable-5"}},defaults:{},...
//
// We append entries to `models` (before the `]` preceding `,aliases:{`) and add
// keys to `aliases` (right after `aliases:{`). Both anchors are non-minified
// literals, so they're stable across builds. A model entry's `id` becomes both
// the /model picker value and the wire model name (the picker builders read the
// catalog id directly, e.g. `Km().fable5`), so `id` must be the exact id the
// configured gateway expects.
//
// Failure mode this guards against: the catalog is `safeParse`d, and on parse
// failure cli.js falls back to an EMPTY catalog (zero models -> dead CC). So we
// never write an injection that doesn't itself pass a structural validator.

import { showDiff } from './index';
import { CustomModelDefinition } from '../types';

// Catalog capabilities implied by each supported effort rung. The effort UI is
// gated on `M$(model, "effort")`; `max` additionally needs `max_effort`, and
// `xhigh`/`max` need `xhigh_effort`.
const buildCapabilities = (def: CustomModelDefinition): string[] => {
  const caps = new Set<string>(def.capabilities ?? []);
  const effort = def.effort ?? [];
  if (effort.length > 0) {
    caps.add('effort');
    if (effort.includes('max')) caps.add('max_effort');
    if (effort.includes('max') || effort.includes('xhigh'))
      caps.add('xhigh_effort');
  }
  return [...caps];
};

// Build one catalog `models[]` entry as a JS object literal, in the same key
// order/shape as the embedded entries. provider_ids.first_party mirrors `id`
// (CC resolves the wire name from the catalog id, and provider_ids must contain
// no collision with existing entries).
export const buildCatalogEntry = (def: CustomModelDefinition): string => {
  const maxOut = def.max_output_tokens ?? 64000;
  const caps = buildCapabilities(def);
  const parts: string[] = [
    `id:${JSON.stringify(def.id)}`,
    `family:${JSON.stringify(def.family)}`,
    `display_name:${JSON.stringify(def.display_name)}`,
    ...(def.description !== undefined
      ? [`slogan:${JSON.stringify(def.description)}`]
      : []),
    `provider_ids:{first_party:${JSON.stringify(def.id)}}`,
    `context:{window:${JSON.stringify(def.context_window)}}`,
    `max_output_tokens:{default:${JSON.stringify(maxOut)},upper:${JSON.stringify(maxOut)}}`,
    `capabilities:[${caps.map(c => JSON.stringify(c)).join(',')}]`,
    ...(def.default_effort !== undefined
      ? [`default_effort:${JSON.stringify(def.default_effort)}`]
      : []),
  ];
  return `{${parts.join(',')}}`;
};

const buildAliasEntry = (def: CustomModelDefinition): string | null =>
  def.alias
    ? `${JSON.stringify(def.alias)}:{default:${JSON.stringify(def.id)}}`
    : null;

// ---------------------------------------------------------------------------
// Structural validator (stand-in for the runtime Zod schema).
//
// We can't import cli.js's Zod schema here, but we know its shape. The point is
// not to re-implement Zod — it's to catch the injection producing something the
// schema would reject BEFORE it reaches a live install. Every config-derived
// scalar is JSON-encoded before this parser runs, and customModels are runtime-
// validated before patching, so `Function` evaluates generated data rather than
// executable config text.
// ---------------------------------------------------------------------------
const validateInjectedCatalog = (
  entries: string[],
  aliases: string[]
): string | null => {
  for (const entry of entries) {
    try {
      const obj = new Function(`"use strict";return (${entry});`)() as Record<
        string,
        unknown
      >;
      if (typeof obj.id !== 'string' || obj.id.length === 0)
        return 'entry missing string id';
      if (typeof obj.family !== 'string' || obj.family.length === 0)
        return `entry ${obj.id} missing string family`;
      if (typeof obj.display_name !== 'string')
        return `entry ${obj.id} missing display_name`;
      const ctx = obj.context as Record<string, unknown> | undefined;
      if (!ctx || typeof ctx.window !== 'number' || ctx.window <= 0)
        return `entry ${obj.id} has invalid context.window`;
      const mot = obj.max_output_tokens as Record<string, unknown> | undefined;
      if (!mot || typeof mot.default !== 'number')
        return `entry ${obj.id} has invalid max_output_tokens`;
      if (!Array.isArray(obj.capabilities))
        return `entry ${obj.id} capabilities not an array`;
    } catch (e) {
      return `entry failed to parse: ${(e as Error).message}`;
    }
  }
  for (const alias of aliases) {
    // alias entries look like: "k3":{default:"kimi-k3"}
    if (!/^"[^"]+":\{default:"[^"]+"\}$/.test(alias))
      return `alias entry malformed: ${alias}`;
  }
  return null;
};

const findAnchor = (
  file: string,
  pattern: RegExp,
  what: string
): { index: number; length: number } | null => {
  const m = file.match(pattern);
  if (!m || m.index === undefined) {
    console.error(`patch: customModelCatalog: failed to find ${what}`);
    return null;
  }
  return { index: m.index, length: m[0].length };
};

export const writeCustomModelCatalog = (
  oldFile: string,
  models: CustomModelDefinition[]
): string | null => {
  if (!models || models.length === 0) return oldFile;

  // Idempotence: if every id is already present as a catalog id, skip.
  const allPresent = models.every(m =>
    oldFile.includes(`id:${JSON.stringify(m.id)}`)
  );
  if (allPresent) {
    console.log(
      'patch: customModelCatalog: custom models already present — skipping'
    );
    return oldFile;
  }

  // Guard against family collisions with built-ins (we never redefine them).
  const builtinFamilies = new Set(['opus', 'sonnet', 'haiku', 'fable']);
  for (const m of models) {
    if (builtinFamilies.has(m.family)) {
      console.error(
        `patch: customModelCatalog: refusing built-in family "${m.family}" for ${m.id} — use a novel family`
      );
      return null;
    }
  }

  const entries = models.map(buildCatalogEntry);
  const aliases = models
    .map(buildAliasEntry)
    .filter((a): a is string => a !== null);

  const validationError = validateInjectedCatalog(entries, aliases);
  if (validationError) {
    console.error(
      `patch: customModelCatalog: generated catalog failed self-validation: ${validationError}`
    );
    return null;
  }

  let newFile = oldFile;

  // --- 1. Append to models[] ---------------------------------------------
  // Anchor: the last models entry's tail, `}],aliases:{`. Insert before `]`.
  const modelsAnchor = findAnchor(
    newFile,
    /\}\],aliases:\{/,
    'models[] -> aliases boundary'
  );
  if (!modelsAnchor) return null;
  const modelsInsertAt = modelsAnchor.index + 1; // after the final `}`, before `]`
  const modelsInject = ',' + entries.join(',');
  newFile =
    newFile.slice(0, modelsInsertAt) +
    modelsInject +
    newFile.slice(modelsInsertAt);
  showDiff(oldFile, newFile, modelsInject, modelsInsertAt, modelsInsertAt);

  // --- 2. Add alias keys ---------------------------------------------------
  if (aliases.length > 0) {
    // Re-find on the mutated file: `aliases:{opus:{default:`. Insert after `{`.
    const aliasesAnchor = findAnchor(
      newFile,
      /,aliases:\{opus:\{default:/,
      'aliases opening'
    );
    if (!aliasesAnchor) return null;
    // position right after `aliases:{`
    const aliasInsertAt = aliasesAnchor.index + ',aliases:{'.length;
    const aliasInject = aliases.join(',') + ',';
    const beforeAlias = newFile;
    newFile =
      newFile.slice(0, aliasInsertAt) +
      aliasInject +
      newFile.slice(aliasInsertAt);
    showDiff(beforeAlias, newFile, aliasInject, aliasInsertAt, aliasInsertAt);
  }

  return newFile;
};
