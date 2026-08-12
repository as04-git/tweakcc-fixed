// Please see the note about writing patches in ./index
//
// Let the Agent/Task tool's inline `model` parameter accept any model name, not
// just the built-in aliases. Custom agent *definitions* (.md frontmatter) can
// already name an arbitrary model; the tool's runtime parameter is the one
// surface still locked behind an enum. Without this, a subagent can only use a
// custom model via a saved agent definition, not an inline override.
//
// CC has used two Zod emission styles for this schema:
//
// CC 2.1.220 (method-style Zod API):
// ```diff
// -model:v.enum(["sonnet","opus","haiku","fable"]).optional()
// +model:v.string().optional()
// ```
//
// CC 2.1.226 (standalone Zod factories):
// ```diff
// -subagent_type:$().optional().describe(...),model:$r(["sonnet","opus","haiku","fable"]).optional()
// +subagent_type:$().optional().describe(...),model:$().optional()
// ```
//
// The 2.1.226 shape matters: checking only for `.enum([...])` falsely concluded
// that the restriction had disappeared, even though the standalone `$r([...])`
// factory still built the same enum. Both matchers are anchored to the Agent
// tool's model-field description so an unrelated four-value enum cannot satisfy
// or redirect this patch.

import { showDiff } from './index';

const MODEL_VALUES = '"sonnet","opus","haiku","fable"';
const MODEL_DESCRIPTION = 'Optional model override for this agent';

export const writeAgentToolModelString = (file: string): string | null => {
  // Already patched (enum replaced by a string schema) — support both Zod
  // emission styles so a second --apply is genuinely idempotent.
  const alreadyPatchedLegacy = new RegExp(
    `model:[$\\w]+\\.string\\(\\)\\.optional\\(\\)\\.describe\\(\\\`${MODEL_DESCRIPTION}`
  );
  const alreadyPatchedFactory = new RegExp(
    `model:[$\\w]+\\(\\)\\.optional\\(\\)\\.describe\\(\\\`${MODEL_DESCRIPTION}`
  );
  if (alreadyPatchedLegacy.test(file) || alreadyPatchedFactory.test(file)) {
    return file;
  }

  // CC 2.1.220: the enum is a method on the same Zod namespace that exposes
  // `.string()`, so preserving that captured namespace is enough.
  const legacyPattern = new RegExp(
    `,model:([$\\w]+)\\.enum\\(\\[${MODEL_VALUES}\\]\\)\\.optional\\(\\)(?=\\.describe\\(\\\`${MODEL_DESCRIPTION})`
  );
  const legacyMatch = file.match(legacyPattern);
  if (legacyMatch?.index !== undefined) {
    const replacement = `,model:${legacyMatch[1]}.string().optional()`;
    const start = legacyMatch.index;
    const end = start + legacyMatch[0].length;
    const newFile = file.slice(0, start) + replacement + file.slice(end);
    showDiff(file, newFile, replacement, start, end);
    return newFile;
  }

  // CC 2.1.226: capture the adjacent string factory from `subagent_type` and
  // reuse it for `model`; the enum factory has a different minified identifier.
  const factoryPattern = new RegExp(
    `(subagent_type:([$\\w]+)\\(\\)\\.optional\\(\\)\\.describe\\("The type of specialized agent to use for this task"\\),model:)` +
      `[$\\w]+\\(\\[${MODEL_VALUES}\\]\\)\\.optional\\(\\)(?=\\.describe\\(\\\`${MODEL_DESCRIPTION})`
  );
  const factoryMatch = file.match(factoryPattern);
  if (factoryMatch?.index !== undefined) {
    const replacement = `${factoryMatch[1]}${factoryMatch[2]}().optional()`;
    const start = factoryMatch.index;
    const end = start + factoryMatch[0].length;
    const newFile = file.slice(0, start) + replacement + file.slice(end);
    showDiff(file, newFile, replacement, start, end);
    return newFile;
  }

  // Custom-model support depends on this surface being open. If the Agent tool
  // still exists but its shape changed, fail loudly so showtime re-anchors it;
  // never infer success merely because one historical enum spelling vanished.
  if (file.includes(MODEL_DESCRIPTION)) {
    console.error(
      'patch: agentToolModelString: found the Agent model field but not a known ' +
        'restricted or free-string schema shape — re-anchor for this CC version'
    );
  } else {
    console.error(
      'patch: agentToolModelString: Agent model field description not found — ' +
        'cannot verify custom inline model support'
    );
  }
  return null;
};
