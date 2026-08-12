#!/usr/bin/env node
// Prompt-coverage gate: does OUR catalogue carry every model-facing string a
// reference catalogue found?
//
// Why this exists. The showtime no-regression bar compares NAMED COUNTS — ours
// (3771) vs upstream's (644) — which passes unconditionally and so can never
// see a miss. It is also blind by construction to the real failure mode: Claude
// Code ships MORE THAN ONE description for the same tool on different code
// paths, and two extractors each find a different one. `refreshmcptools` is the
// worked example — we catalogue "Re-query the tool lists…" and upstream
// catalogues "Re-queries the tool list…", same tool, same version, both live in
// the binary, and the id-level diff shows nothing wrong.
//
// So compare by CONTENT, and let the BINARY arbitrate:
//   in reference, in our binary, not in our catalogue  -> MISSING   (exit 1)
//   in reference, not in our binary                    -> not ours  (info)
//
// Two traps this had to be built around, both of which produced confidently
// wrong numbers on the way here:
//
//   1. The bundle stores non-ASCII as `\uXXXX`. Reference bodies are decoded
//      text. Probing the bundle with a run containing an em-dash — which most
//      of these bodies have — fails for every one of them. Probes are therefore
//      split on non-ASCII and only pure-ASCII runs are used.
//   2. Interpolations. A body's literal text is only the pieces between
//      `${...}` slots, so probes are split there too.
//
// Usage:
//   node tools/checkPromptCoverage.mjs <ours.json> <reference.json> <pristine cli.js>
// Exit 0 = no gap.

import fs from 'node:fs';

const MIN_PROBE = 40;

export const literalRuns = (pieces, minLength = MIN_PROBE) =>
  (pieces ?? [])
    .map(String)
    .flatMap(s => s.split(/\$\{[^}]*\}/))
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length >= minLength)
    .sort((a, b) => b.length - a.length);

/** Pure-ASCII sub-runs, the only form that can be found in a `\uXXXX` bundle. */
export const asciiRuns = (text, minLength = MIN_PROBE) => {
  const out = [];
  let cur = '';
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) cur += ch;
    else {
      out.push(cur);
      cur = '';
    }
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(s => s.length >= minLength);
};

export const coverageReport = (ours, reference, bundle) => {
  const haystack = ours
    .flatMap(p => (p.pieces ?? []).map(String))
    .join(' ')
    .replace(/\s+/g, ' ');
  const missing = [];
  const notOurs = [];
  const unprobeable = [];

  for (const p of reference) {
    const runs = literalRuns(p.pieces);
    if (runs.length === 0) {
      unprobeable.push(p.id);
      continue;
    }
    if (runs.some(r => haystack.includes(r))) continue;

    const probes = runs.flatMap(r => asciiRuns(r));
    const tokens = Math.ceil((p.pieces ?? []).join('').length / 4);
    if (probes.length === 0) {
      unprobeable.push(p.id);
      continue;
    }
    if (probes.some(probe => bundle.includes(probe))) {
      missing.push({ id: p.id, tokens });
    } else {
      notOurs.push({ id: p.id, tokens });
    }
  }
  missing.sort((a, b) => b.tokens - a.tokens);
  return { missing, notOurs, unprobeable };
};

const main = () => {
  const [oursPath, referencePath, bundlePath] = process.argv.slice(2);
  if (!oursPath || !referencePath || !bundlePath) {
    console.error(
      'usage: checkPromptCoverage.mjs <ours.json> <reference.json> <pristine cli.js>'
    );
    process.exit(2);
  }
  const load = f => JSON.parse(fs.readFileSync(f, 'utf8')).prompts;
  const { missing, notOurs, unprobeable } = coverageReport(
    load(oursPath),
    load(referencePath),
    fs.readFileSync(bundlePath, 'utf8')
  );

  const total = missing.reduce((s, m) => s + m.tokens, 0);
  if (missing.length === 0) {
    console.log(
      `✓ prompt coverage: every reference prompt present ` +
        `(${notOurs.length} reference-only, ${unprobeable.length} unprobeable)`
    );
    process.exit(0);
  }

  console.log(
    `MISSING FROM OUR CATALOGUE: ${missing.length} entries (~${total} tokens) ` +
      `present in the binary but absent from our prompts JSON`
  );
  for (const m of missing) {
    console.log(`  ${String(m.tokens).padStart(6)} tk  ${m.id}`);
  }
  console.log(
    `\n(${notOurs.length} reference entries are absent from this binary — a ` +
      `different build, not our gap. ${unprobeable.length} too short to verify.)`
  );
  process.exit(1);
};

if (import.meta.url === `file://${process.argv[1]}`) main();
