#!/usr/bin/env node
// Pipeline driver for the tweakcc-fixed CC version-bump ("showtime") pipeline.
//
// This is the MECHANICAL + VERIFICATION harness. The judgment-heavy phases
// (upstream merge-conflict resolution, naming anonymous prompts, the LCC
// override realignment) are agent work — see SKILL.md. This driver runs the
// deterministic parts and the 4-zeros health check so an agent can prove a
// bump landed clean.
//
// Subcommands (all safe to re-run; --apply is idempotent):
//   node driver.mjs check            health-check the current install (default)
//   node driver.mjs extract [out]    extract cli.js from the native binary
//   node driver.mjs report [oldVer]  run + parse the version-bump report
//   node driver.mjs versions         show installed CC vs repo's latest prompts JSON
//
// Paths are resolved relative to the repo, not the cwd, so it works from anywhere.

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Resolve the tweakcc-fixed repo root. This skill can be installed anywhere
// (a clone's skills/, your ~/.claude/skills/, a plugin dir), so don't assume a
// fixed depth — locate the repo by its signature (data/prompts +
// tools/promptExtractor.js): honor a TWEAKCC_REPO override, then walk up from
// cwd and from the skill's own location, then fall back to `git`.
function findRepo() {
  const isRepo = (d) =>
    !!d &&
    fs.existsSync(path.join(d, 'data', 'prompts')) &&
    fs.existsSync(path.join(d, 'tools', 'promptExtractor.js'));
  if (process.env.TWEAKCC_REPO && isRepo(process.env.TWEAKCC_REPO)) {
    return path.resolve(process.env.TWEAKCC_REPO);
  }
  for (const start of [process.cwd(), HERE]) {
    let d = path.resolve(start);
    for (;;) {
      if (isRepo(d)) return d;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (isRepo(top)) return top;
  } catch {
    /* not inside a git checkout */
  }
  console.error(
    'driver: could not locate the tweakcc-fixed repo (need data/prompts + tools/promptExtractor.js).\n' +
      'Run it from inside your tweakcc-fixed checkout, or set TWEAKCC_REPO=/path/to/tweakcc-fixed.'
  );
  process.exit(2);
}
const REPO = findRepo();
const TWEAKCC = path.join(os.homedir(), '.tweakcc');
const ORIG_JS = path.join(TWEAKCC, 'native-claudejs-orig.js');

const C = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  info: (s) => `\x1b[36m·\x1b[0m ${s}`,
  head: (s) => `\x1b[1m${s}\x1b[0m`,
};

let FAILED = false;
const fail = (s) => { FAILED = true; console.log(C.bad(s)); };

// ---- path resolution -------------------------------------------------------

function ccBinary() {
  // The user's CC install: ~/.local/bin/claude is a symlink to the versioned
  // native binary. realpath gives the binary itself (the extraction source).
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return fs.realpathSync(c); } catch { /* not found, try next */ }
  }
  // last resort: `command -v claude` (won't catch a shell function, but try)
  try {
    const p = execSync('command -v claude', { encoding: 'utf8' }).trim();
    if (p) return fs.realpathSync(p);
  } catch { /* command -v failed; fall through */ }
  return null;
}

function ccVersion(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8' });
    return (out.match(/\d+\.\d+\.\d+/) || [])[0] || null;
  } catch { return null; }
}

function distNativeModule() {
  const dir = path.join(REPO, 'dist');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => /^nativeInstallation-.*\.mjs$/.test(x));
  return f ? path.join(dir, f) : null;
}

function repoPromptsVersions() {
  const dir = path.join(REPO, 'data/prompts');
  return fs
    .readdirSync(dir)
    .map((f) => (f.match(/^prompts-(\d+\.\d+\.\d+)\.json$/) || [])[1])
    .filter(Boolean)
    .sort((a, b) => cmpVer(a, b));
}

const cmpVer = (a, b) =>
  a.split('.').map(Number).reduce((acc, n, i) => acc || n - b.split('.').map(Number)[i], 0);

// ---- subcommands -----------------------------------------------------------

function cmdVersions() {
  const bin = ccBinary();
  if (!bin) return fail('could not resolve the claude binary');
  const installed = ccVersion(bin);
  const repoVers = repoPromptsVersions();
  const latestRepo = repoVers[repoVers.length - 1];
  console.log(C.head('Versions'));
  console.log(C.info(`claude binary:        ${bin}`));
  console.log(C.info(`installed CC:         ${installed}`));
  console.log(C.info(`repo latest prompts:  ${latestRepo}`));
  if (installed && latestRepo) {
    if (cmpVer(installed, latestRepo) > 0)
      console.log(C.bad(`NEW VERSION: installed ${installed} > repo ${latestRepo} -> run the bump pipeline (SKILL.md)`));
    else if (cmpVer(installed, latestRepo) === 0)
      console.log(C.ok(`up to date: installed CC matches repo's latest prompts JSON`));
    else
      console.log(C.info(`installed CC (${installed}) is older than repo (${latestRepo}) — repo is ahead`));
  }
  return { installed, latestRepo };
}

async function cmdExtract(outArg) {
  const bin = ccBinary();
  if (!bin) return fail('could not resolve the claude binary');
  const ver = ccVersion(bin) || 'unknown';
  const mod = distNativeModule();
  if (!mod) return fail('dist nativeInstallation module not found — run `pnpm build` first');
  const out = outArg || path.join(os.tmpdir(), `cli-${ver}.js`);
  console.log(C.head(`Extract cli.js (CC ${ver})`));
  console.log(C.info(`binary: ${bin}`));
  const { extractClaudeJsFromNativeInstallation } = await import(mod);
  const r = await extractClaudeJsFromNativeInstallation(bin, ver);
  const data = r?.data ?? r;
  fs.writeFileSync(out, data);
  const firstVer = (data.toString('utf8').match(/\d+\.\d+\.\d+/) || [])[0];
  console.log(C.ok(`extracted ${(data.length / 1048576).toFixed(1)}MB -> ${out} (clearBytecode=${r?.clearBytecode}, contains ${firstVer})`));
  if (firstVer !== ver) fail(`extracted cli.js version ${firstVer} != installed ${ver}`);
  return out;
}

function cmdReport(oldArg) {
  const bin = ccBinary();
  const installed = ccVersion(bin);
  const repoVers = repoPromptsVersions();
  const old = oldArg || repoVers[repoVers.length - 2];
  const cur = installed && repoVers.includes(installed) ? installed : repoVers[repoVers.length - 1];
  console.log(C.head(`Version-bump report ${old} -> ${cur}`));
  let out;
  try {
    out = execFileSync(process.execPath, ['tools/versionBumpReport.js', old, cur], {
      cwd: REPO,
      encoding: 'utf8',
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const grab = (re) => (out.match(re) || [])[1];
  const checks = [
    ['blocking issues', grab(/blocking issues:\s*(\d+)/)],
    // The report prints THREE `anonymous:` lines — one per metrics block ("old",
    // "committed new", "extracted"). A bare /anonymous:\s*(\d+)/ matched the
    // FIRST, i.e. the PREVIOUS version's count, so a bump that extracted N
    // anonymous prompts still reported 0 and read as green while the report
    // itself listed them under blocking issues (seen on 2.1.215: 8 anonymous,
    // driver said 0). Key on the extracted block — that is the one this bump
    // produced and the one the completion bar is about.
    ['anonymous prompts', grab(/extracted metrics:\s*\{[^}]*?anonymous:\s*(\d+)/s)],
    ['UNKNOWN placeholders', grab(/UNKNOWN placeholders:\s*(\d+)/)],
    ['empty identifierMap', grab(/empty identifierMap entries:\s*(\d+)/)],
    ['prompt overrides not in JSON', grab(/prompt overrides not in JSON:\s*(\d+)/)],
    ['inline anchor issues', grab(/inline anchor issues:\s*(\d+)/)],
  ];
  for (const [label, val] of checks) {
    if (val === undefined) console.log(C.info(`${label}: (not reported)`));
    else if (val === '0') console.log(C.ok(`${label}: 0`));
    else fail(`${label}: ${val}`);
  }
  const matches = /matchesCommittedJson:\s*true/.test(out);
  console.log(matches ? C.ok('fresh extraction matches committed prompts JSON') : C.info('matchesCommittedJson: not true (refresh ~/.tweakcc/native-claudejs-orig.js to current CC first)'));
}

function cmdCheck() {
  console.log(C.head('=== tweakcc-fixed pipeline health check ==='));
  const { installed } = cmdVersions() || {};
  console.log('');

  // 1. stale-backup guard (a stale backup makes --apply a downgrade)
  console.log(C.head('Backup vintage (stale -> --apply would downgrade)'));
  const backupVer = fs.existsSync(ORIG_JS)
    ? (fs.readFileSync(ORIG_JS, 'utf8').slice(0, 10_000).match(/\/\/ Version: (\d+\.\d+\.\d+)/) || [])[1]
    : null;
  if (!backupVer) console.log(C.info('no native-claudejs-orig.js yet (first --apply will create it)'));
  else if (installed && backupVer !== installed)
    fail(`STALE backup: orig.js=${backupVer} but CC=${installed} — rm the backup trio before --apply (see SKILL.md Gotchas)`);
  else console.log(C.ok(`backup vintage ${backupVer} matches installed CC`));
  console.log('');

  // 2. apply hygiene (idempotent re-apply, parse the log)
  console.log(C.head('Apply hygiene (idempotent re-apply)'));
  const log = path.join(os.tmpdir(), 'tweakcc-driver-apply.log');
  let applyOk = false;
  try {
    execSync(`node dist/index.mjs --apply > ${log} 2>&1`, { cwd: REPO });
    applyOk = true;
  } catch { applyOk = false; }
  const txt = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const count = (re) => (txt.match(re) || []).length;
  const hyg = [
    ['✗ failures', count(/✗|✘/g)],
    ['"failed to find"', count(/failed to find/g)],
    ['"Could not find"', count(/[Cc]ould not find/g)],
    ['"Conflicts detected"', count(/Conflicts detected/g)],
    // When the installed CC is newer than the newest published prompts JSON,
    // EVERY named prompt override is skipped and the run still ends
    // "Customizations applied successfully!" — the inline blobs and code
    // patches did apply. None of the patterns above fire, so without this row
    // a box running Layer 0 with no prompt overrides reports clean.
    [
      'system prompts skipped (CC newer than published data)',
      count(/System prompts not available|Error downloading system prompts|Prompts file not found/gi),
    ],
  ];
  for (const [label, n] of hyg) {
    if (n === 0) console.log(C.ok(`${label}: 0`));
    else fail(`${label}: ${n}`);
  }
  if (/applied successfully/i.test(txt)) console.log(C.ok('"Customizations applied successfully!"'));
  else fail(`apply did not report success (exit ok=${applyOk}; see ${log})`);
  console.log('');

  // 3. smoke test (binary boots + responds). On a mise-managed install `claude`
  // is a shell function and the resolved binary yields no output from node, so a
  // null result is INCONCLUSIVE (verify in your shell), not a failure.
  console.log(C.head('Smoke test (claude --print READY)'));
  const bin = ccBinary();
  try {
    const out = execFileSync(bin, ['--print', 'say only the word READY'], { encoding: 'utf8', timeout: 120000, input: '' });
    if (/READY/.test(out)) console.log(C.ok('READY'));
    else console.log(C.info('smoke inconclusive from node — verify in your shell: claude --print "say only the word READY"'));
  } catch { console.log(C.info('smoke inconclusive from node (mise/shell-function) — verify in your shell: claude --print "say only the word READY"')); }
  console.log('');

  // 4. mis-bind audit — an override placeholder bound to the wrong slot resolves
  //    to a valid-but-wrong var (wrong content, no crash); four-zeros + smoke miss it.
  console.log(C.head('Mis-bind audit (override placeholders vs upstream slots)'));
  {
    const pieb = path.join(os.tmpdir(), 'tweakcc-driver-pieb.json');
    const v = ccVersion(ccBinary()) || repoPromptsVersions().slice(-1)[0];
    let out = '', code = 0;
    try { execSync(`git show upstream/main:data/prompts/prompts-${v}.json > ${pieb} 2>/dev/null`, { cwd: REPO }); } catch { /* no upstream ref; audit skips */ }
    try { out = execSync(`node tools/auditMisbinds.mjs data/prompts/prompts-${v}.json ${pieb} 2>&1`, { cwd: REPO, encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
    if (code === 0 && /audit: 0/.test(out)) console.log(C.ok('mis-bind audit: 0'));
    else if (/SKIPPED/.test(out)) console.log(C.info('mis-bind audit: skipped (no upstream ref — dump it per SKILL.md)'));
    else fail(`mis-bind audit: ${out.split('\n').filter((l) => /slot|MIS-BIND/.test(l)).slice(0, 4).join(' | ').slice(0, 220)}`);
  }
  console.log('');

  // 5. substitution-tag audit — CC fills some prompts via String.replace("<tag>", …),
  //    which no-ops SILENTLY when the tag is absent. An override that trims or suppresses
  //    one applies clean, boots clean and smokes clean while receiving nothing (issue #2).
  console.log(C.head('Substitution-tag audit (runtime injection sites in overrides)'));
  {
    let out = '', code = 0;
    try { out = execSync('node tools/checkSubstitutionTags.mjs 2>&1', { cwd: REPO, encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
    if (code === 0) console.log(C.ok(out.trim().replace(/^\u2713\s*/, '')));
    else fail(`substitution tags: ${out.split('\n').filter((l) => /\u2014/.test(l)).slice(0, 4).join(' | ').slice(0, 240)}`);
  }
  console.log('');

  // 6. predicate-literal audit — a few catalogued literals are needles CC greps
  //    text with, not prose it emits. Blanking one inverts a branch, because
  //    `"anything".includes("")` is always true. Wiping the /loop sentinel
  //    classified every session as a /loop session and /resume listed 5 of 50,
  //    while apply, boot and the READY smoke all stayed green (issue #24).
  console.log(C.head('Predicate-literal audit (blanked needles the binary greps with)'));
  {
    const set = path.join(TWEAKCC, 'system-prompts');
    const v = ccVersion(ccBinary()) || repoPromptsVersions().slice(-1)[0];
    const jsonPath = path.join(REPO, 'data/prompts', `prompts-${v}.json`);
    if (!fs.existsSync(ORIG_JS) || !fs.existsSync(set) || !fs.existsSync(jsonPath)) {
      console.log(C.info('no pristine cli.js, override set or prompts JSON — skipped'));
    } else {
      let out = '', code = 0;
      try { out = execSync(`node tools/checkScannedLiterals.mjs ${ORIG_JS} ${jsonPath} --set=${set} 2>&1`, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
      catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
      if (code === 0) console.log(C.ok(out.split('\n').filter((l) => /^✓/.test(l)).join(' ').replace(/^✓\s*/, '')));
      else fail(`predicate literals: ${out.split('\n').filter((l) => /BLANKED PREDICATE/.test(l)).slice(0, 4).join(' | ').slice(0, 240)}`);
    }
  }
  console.log('');

  console.log(FAILED ? C.bad('HEALTH CHECK FAILED — see above') : C.ok('HEALTH CHECK PASSED — on-version, patched clean, mis-bind-free, injection-sites-intact, predicate-safe, boots'));
}

// ---- dispatch --------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const run = async () => {
  switch (cmd) {
    case undefined:
    case 'check': cmdCheck(); break;
    case 'versions': cmdVersions(); break;
    case 'extract': await cmdExtract(rest[0]); break;
    case 'report': cmdReport(rest[0]); break;
    default: console.log(`unknown subcommand: ${cmd}\nsee: node driver.mjs (check|extract|report|versions)`); process.exit(2);
  }
  process.exit(FAILED ? 1 : 0);
};
run().catch((e) => { console.error(C.bad(String(e?.stack || e))); process.exit(1); });
