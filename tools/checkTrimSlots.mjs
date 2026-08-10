#!/usr/bin/env node
// Report runtime interpolations a trim or suppression removed entirely.
//
// A prompt body carries two kinds of runtime token: `${IDENTIFIER}` slots the
// patcher binds positionally into the binary, and `{{TEMPLATE}}` names CC fills
// from the model catalogue. A trim may delete a sentence containing one — that
// is allowed. What is almost never intended is deleting the LAST occurrence of
// a token, because the value it carried then reaches the model nowhere.
//
// So the rule is deliberately not "the token sets must match". It is: a token
// pristine has and the deployed body has ZERO of. Measured on the CC 2.1.226
// audit that is 4 findings across 67 changed overrides, and one of the four was
// a real miss nothing else could see — `data-multiple-browsers-connected-tool-result`
// deleted `${VAR_1(VAR_2.askUserToolName)}` as "pure interpolation" when it
// renders the only instruction on an isError result, and the adversarial pass
// never selected it because that verdict cited no sibling.
//
// Scope matters. Run against a bump's CHANGED ids and it is a gate. Run it
// across the whole set and it is an INVENTORY of every such decision ever made
// — ~100 of 859 overrides — which is interesting once and useless as a gate, so
// `--all` reports and exits 0 while the scoped form exits non-zero.
//
// Usage:
//   node tools/checkTrimSlots.mjs <prompts.json> --set=<abs dir> --ids=<file>
//   node tools/checkTrimSlots.mjs <prompts.json> --set=<abs dir> --all
//     --ids  newline-separated ids this run changed. Gate mode.
//     --all  every override that differs from pristine. Report mode, exits 0.
//     --json <path>  write the findings for a downstream verifier packet.
//
// Exit 0 = no findings (or --all), 1 = findings, 2 = could not run.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const TOKEN = /\$\{[^}]{0,120}\}|\{\{[^}]{0,80}\}\}/g;

// `${...}` can nest a whole ternary, and the naive match then truncates at the
// first inner `}`. A slot's identity is its opening identifier, so compare on
// that; and drop the degenerate forms reconstruction can produce (`${}`,
// `${""}`), which name nothing and would be pure noise.
export const normalizeToken = tok => {
  const inner = tok.replace(/^\$\{|^\{\{|\}\}$|\}$/g, '').trim();
  if (!inner || /^(["']{2})$/.test(inner)) return null;
  const lead = inner.match(/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*/);
  return lead ? lead[0] : null;
};

export const tokensOf = s =>
  new Set(((s || '').match(TOKEN) || []).map(normalizeToken).filter(Boolean));

// The canonical reconstruction: the `${` and `}` are already in the pieces, so
// the BARE label is appended, and the map key is identifiers[i] — never i.
export const reconstruct = p => {
  const pieces = p.pieces || [];
  const ids = p.identifiers || [];
  const map = p.identifierMap || {};
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    out += pieces[i];
    if (i < ids.length) out += map[String(ids[i])] ?? `UNKNOWN_${ids[i]}`;
  }
  return out;
};

export const stripFrontmatter = t => {
  if (!t.startsWith('<!--')) return t;
  const end = t.indexOf('-->');
  return end === -1 ? t : t.slice(end + 3).replace(/^\n/, '');
};

// A same-id multi-site prompt binds a different slot set per site, so the
// override has to satisfy the UNION — checking only the first entry is the
// same first-entry-only mistake that has misclassified stubs before.
export const lostTokens = (pristineBodies, deployed) => {
  const have = tokensOf(deployed);
  const want = new Set();
  for (const b of pristineBodies) for (const t of tokensOf(b)) want.add(t);
  return [...want].filter(t => !have.has(t));
};

const main = () => {
  const die = (msg, code = 2) => {
    console.error(`checkTrimSlots: ${msg}`);
    process.exit(code);
  };

  const args = process.argv.slice(2);
  const jsonPath = args.find(a => !a.startsWith('--'));
  const setDir = (args.find(a => a.startsWith('--set=')) || '').slice(6);
  const idsFile = (args.find(a => a.startsWith('--ids=')) || '').slice(6);
  const all = args.includes('--all');
  const outIdx = args.indexOf('--json');
  const outPath = outIdx === -1 ? null : args[outIdx + 1];

  if (!jsonPath || !setDir)
    die('usage: <prompts.json> --set=<dir> (--ids=<file> | --all) [--json <path>]');
  if (!idsFile && !all)
    die(
      'pass --ids=<file> to gate a bump, or --all to inventory the whole set — ' +
        'an unscoped gate reports every historical decision and gets ignored'
    );
  if (!fs.existsSync(jsonPath)) die(`no prompts JSON at ${jsonPath}`);
  if (!fs.existsSync(setDir)) die(`no override set at ${setDir}`);

  const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts || [];
  const pristine = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!pristine.has(p.id)) pristine.set(p.id, []);
    pristine.get(p.id).push(reconstruct(p));
  }

  const bodyOf = id => stripFrontmatter(fs.readFileSync(path.join(setDir, `${id}.md`), 'utf8'));

  const ids = idsFile
    ? fs.readFileSync(idsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : [...pristine.keys()].filter(id => {
        if (!fs.existsSync(path.join(setDir, `${id}.md`))) return false;
        const b = bodyOf(id).trim();
        return !pristine.get(id).some(p => p.trim() === b);
      });

  const findings = [];
  for (const id of ids) {
    if (!pristine.has(id) || !fs.existsSync(path.join(setDir, `${id}.md`))) continue;
    const body = bodyOf(id);
    const lost = lostTokens(pristine.get(id), body);
    if (lost.length)
      findings.push({ id, suppressed: body.trim() === '', lost, remaining: [...tokensOf(body)] });
  }

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(findings, null, 1));

  if (!findings.length) {
    console.log(
      `checkTrimSlots: 0 — every runtime token still has a home across ${ids.length} changed override(s)`
    );
    process.exit(0);
  }

  console.log(
    `checkTrimSlots: ${findings.length} override(s) dropped the last occurrence of a runtime token (of ${ids.length} checked)`
  );
  for (const f of findings) {
    console.log(`  ${f.suppressed ? 'suppressed' : 'trimmed'}  ${f.id}`);
    for (const t of f.lost) console.log(`      lost  ${t}`);
  }
  console.log(
    '\nNot automatically wrong: deleting a sentence whole takes its token with it.\n' +
      'Each one needs a reason — hand them to the adversarial pass rather than reverting blind.'
  );
  process.exit(all ? 0 : 1);
};

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main();
}
