// Please see the note about writing patches in ./index
//
// Let the Agent/Task tool's inline `model` parameter accept any model name, not
// just the built-in aliases. Custom agent *definitions* (.md frontmatter) can
// already name an arbitrary model; the tool's runtime parameter is the one
// surface still locked behind an enum. Without this, a subagent can only use a
// custom model via a saved agent definition, not an inline override.
//
// CC 2.1.220:
// ```diff
// -model:v.enum(["sonnet","opus","haiku","fable"]).optional()
// +model:v.string().optional()
// ```
//
// The enum array contains only non-minified string literals, so the anchor is
// stable. The Zod schema builder var (`v` above) is minified and captured.
//
// OBSOLETE ON CC ≥2.1.226 (verified 2026-08-10): upstream removed the enum
// entirely — no `enum(["sonnet","opus","haiku","fable"])` anywhere in the
// binary, and a live Agent-tool spawn with model:"kimi-k3-256k" ran natively.
// The no-op path below is therefore the expected, correct outcome; it logs
// "satisfied" rather than looking like a failure.

import { showDiff } from './index';

export const writeAgentToolModelString = (file: string): string | null => {
  // Already patched (enum replaced by string) — idempotent.
  if (
    /model:[$\w]+\.string\(\)\.optional\(\)\.describe\(`Optional model override for this agent/.test(
      file
    )
  ) {
    return file;
  }

  const pattern =
    /,model:([$\w]+)\.enum\(\["sonnet","opus","haiku","fable"\]\)\.optional\(\)/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    // The enum may already be gone in some builds (e.g. upstream widened it).
    if (!/\.enum\(\["sonnet","opus","haiku","fable"\]\)/.test(file)) {
      console.log(
        'patch: agentToolModelString: enum absent (upstream ≥2.1.226 accepts free model strings — verified live 2026-08-10) — satisfied'
      );
      return file;
    }
    console.error(
      'patch: agentToolModelString: found the model enum but not the expected Agent-tool shape'
    );
    return null;
  }

  const zodVar = match[1];
  const replacement = `,model:${zodVar}.string().optional()`;
  const start = match.index;
  const end = start + match[0].length;
  const newFile = file.slice(0, start) + replacement + file.slice(end);

  showDiff(file, newFile, replacement, start, end);
  return newFile;
};
