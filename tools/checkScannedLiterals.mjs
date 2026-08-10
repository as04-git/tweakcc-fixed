#!/usr/bin/env node
// Refuse to blank a literal the BINARY matches against text.
//
// Most catalogued strings are only ever emitted — the minifier hoists them into
// a module const and the const is interpolated into a message. Overriding one
// changes what the model reads and nothing else. A small minority are also
// PREDICATES: CC passes them to `.includes()` / `.startsWith()` / `.indexOf()`
// to classify text. Blanking one of those does not shorten a prompt, it inverts
// a branch, because `"anything".includes("")` is unconditionally true.
//
// That is skrabe/lobotomized-claude-code#24. `system-prompt-command-name-framing-tag-3`
// is `<command-name>/loop</command-name>`, which CC greps stored transcripts for
// to decide whether a session was a `/loop` session and should be hidden:
//
//   catch { if (i) return o.includes("<command-name>/loop</command-name>"); continue }
//   ...
//   return c.some((u) => u.includes("<command-name>/loop</command-name>"))
//
// Wiped to "", every session holding any user message classified as a loop
// session, and `/resume` listed 5 of 50. The sibling `-2` is `zUp`, the prefilter
// the session-descriptor scanner runs over raw transcript lines, so blanking it
// also cost every row its title. Both are markup, both read as "no prose value"
// to an audit pass, and neither is reachable by any other gate: the binary boots,
// `--print` smokes READY, four-zeros is clean, and nothing errors. It only shows
// up as history quietly going missing.
//
// The rule is deliberately NOT "these literals must stay pristine". CC also
// matches literals it produced itself from the same const — `tool-result-tool-use-rejected-stop`
// is emitted as a tool result and later re-detected with `.startsWith(JLe)`, and
// since the override rewrites both sides at once the predicate still holds.
// Those are legitimately editable. The invariant that never survives is
// emptiness, so EMPTY is the gate and edited-but-non-empty is reported.
//
// Usage:
//   node tools/checkScannedLiterals.mjs <cli.js> <prompts.json> --set=<abs dir>
//     --set   override set to check; repeatable.
//     --json <path>  write findings for a downstream verifier packet.
//
// Exit 0 = no blanked predicate, 1 = findings, 2 = could not run.

import fs from 'node:fs';
import path from 'node:path';

// String methods that consume a literal as a needle rather than emitting it.
const MATCHERS = [
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'split',
  'search',
];

// A slot-free prompt reconstructs to a plain literal; anything carrying a
// runtime slot is interpolated, never a predicate needle.
export const literalOf = p => {
  const pieces = p.pieces || [];
  if (!pieces.every(x => typeof x === 'string')) return null;
  const s = pieces.join('');
  return s.trim() ? s : null;
};

export const bodyOf = text =>
  text.replace(/^<!--[\s\S]*?-->\s*\n?/, '').replace(/\s+$/, '');

const quoted = (lit, q) =>
  q +
  lit
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(q, 'g'), '\\' + q)
    .replace(/\n/g, '\\n') +
  q;

// Identifiers the minifier assigns exactly once at module scope are real
// constants. A name assigned all over the file is a local temp — `o` is not
// "the const holding this prompt" just because some `o=` happened to precede it.
const assignedOnce = (src, name) => {
  let count = 0;
  for (let i = src.indexOf(name + '='); i !== -1; i = src.indexOf(name + '=', i + 1)) {
    const before = src[i - 1];
    const after = src[i + name.length + 1];
    if (before && /[\w$]/.test(before)) continue;
    if (after === '=') continue; // ==, ===
    if (++count > 1) return false;
  }
  return count === 1;
};

// Evidence that the binary treats this literal as a needle: either passed
// inline to a matcher, or bound to a single-assignment const that is.
export const matchEvidence = (src, lit) => {
  const found = [];
  for (const q of ['"', "'"]) {
    const needle = quoted(lit, q);
    if (!src.includes(needle)) continue;

    for (const fn of MATCHERS) {
      if (src.includes(`.${fn}(${needle})`)) found.push(`inline .${fn}()`);
    }

    const names = new Set();
    let i = src.indexOf(needle);
    for (let n = 0; i !== -1 && n < 20; n++, i = src.indexOf(needle, i + 1)) {
      const pre = src.slice(Math.max(0, i - 40), i).trimEnd();
      if (!pre.endsWith('=')) continue;
      const m = pre.slice(0, -1).trimEnd().match(/[$\w]+$/);
      if (m && m[0].length <= 12) names.add(m[0]);
    }
    for (const name of names) {
      if (!assignedOnce(src, name)) continue;
      for (const fn of MATCHERS) {
        if (
          src.includes(`.${fn}(${name})`) ||
          src.includes(`.${fn}(${name},`)
        ) {
          found.push(`${name} -> .${fn}()`);
        }
      }
    }
  }
  return [...new Set(found)];
};

const main = () => {
  const args = process.argv.slice(2);
  const sets = args
    .filter(a => a.startsWith('--set='))
    .map(a => path.resolve(a.slice('--set='.length)));
  const jsonOut = (args[args.indexOf('--json') + 1] || '').startsWith('--')
    ? null
    : args.includes('--json')
      ? args[args.indexOf('--json') + 1]
      : null;
  const [cliPath, promptsPath] = args.filter(a => !a.startsWith('--'));

  if (!cliPath || !promptsPath || !sets.length) {
    console.error(
      'usage: checkScannedLiterals.mjs <cli.js> <prompts.json> --set=<dir> [--set=<dir>]'
    );
    process.exit(2);
  }
  for (const p of [cliPath, promptsPath, ...sets]) {
    if (!fs.existsSync(p)) {
      console.error(`checkScannedLiterals: missing ${p}`);
      process.exit(2);
    }
  }

  const src = fs.readFileSync(cliPath, 'utf8');
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8')).prompts;

  const seen = new Set();
  const blanked = [];
  const edited = [];

  for (const p of prompts) {
    if (seen.has(p.id)) continue;
    const lit = literalOf(p);
    // A 4KB+ literal is prose; the needle cases are short markers, and scanning
    // the bundle for every long prompt costs far more than it can find.
    if (!lit || lit.length > 4000) continue;
    seen.add(p.id);

    const evidence = matchEvidence(src, lit);
    if (!evidence.length) continue;

    for (const set of sets) {
      const file = path.join(set, `${p.id}.md`);
      if (!fs.existsSync(file)) continue;
      const body = bodyOf(fs.readFileSync(file, 'utf8'));
      if (body.trim() === lit.trim()) continue;
      const row = {
        id: p.id,
        set: path.basename(set),
        literal: lit,
        evidence,
      };
      if (body.trim()) edited.push(row);
      else blanked.push(row);
    }
  }

  for (const r of blanked) {
    console.error(
      `BLANKED PREDICATE  ${r.set}/${r.id}\n` +
        `   literal : ${JSON.stringify(r.literal.slice(0, 100))}\n` +
        `   matched : ${r.evidence.join(', ')}\n` +
        `   effect  : the matcher becomes unconditionally true — restore pristine`
    );
  }
  for (const r of edited) {
    console.log(
      `note: ${r.set}/${r.id} rewrites a matched literal (${r.evidence.join(', ')}) — ` +
        `fine while CC compares against text it built from the same const`
    );
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ blanked, edited }, null, 2));
  }

  if (blanked.length) {
    console.error(
      `\nscanned literals: ${blanked.length} blanked predicate(s), ${edited.length} rewritten`
    );
    process.exit(1);
  }
  console.log(
    `✓ scanned literals: 0 blanked predicates (${edited.length} rewritten, ${seen.size} literals examined)`
  );
};

if (import.meta.url === `file://${process.argv[1]}`) main();
