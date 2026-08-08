// Please see the note about writing patches in ./index
//
// Show custom (non-Anthropic) models in the interactive /model picker.
//
// The catalog injection (custom-model-catalog) makes a model resolvable — you
// can `/model kimi-k3` and it works — but the interactive picker builds its
// list from a fixed enumeration plus explicit pushes, never iterating the
// catalog's models[]. So injected models were invisible in the UI.
//
// This is the config-driven twin of modelSelector.ts's model-customizations:
// same insertion point (the `description:"Custom model"` push site), but the
// pushed entries come from settings.customModels instead of a hardcoded list
// of historical Claude models.
//
// Entry shape matches the site's own pushes: {value, label, description}.

import { showDiff } from './index';
import { findCustomModelListInsertionPoint } from './modelSelector';
import { CustomModelDefinition } from '../types';

export const writeCustomModelPicker = (
  oldFile: string,
  models: CustomModelDefinition[]
): string | null => {
  if (!models || models.length === 0) return oldFile;

  // Idempotence: if every id is already pushed as a picker value, skip.
  const allPresent = models.every(m =>
    oldFile.includes(`{"value":${JSON.stringify(m.id)},`)
  );
  if (allPresent) {
    console.log(
      'patch: customModelPicker: picker entries already present — skipping'
    );
    return oldFile;
  }

  const found = findCustomModelListInsertionPoint(oldFile);
  if (!found) return null;

  const { insertionIndex, modelListVar } = found;

  const inject = models
    .map(m => {
      const entry = {
        value: m.id,
        label: m.display_name,
        description: m.description ?? m.display_name,
      };
      return `${modelListVar}.push(${JSON.stringify(entry)});`;
    })
    .join('');

  const newFile =
    oldFile.slice(0, insertionIndex) + inject + oldFile.slice(insertionIndex);
  showDiff(oldFile, newFile, inject, insertionIndex, insertionIndex);
  return newFile;
};
