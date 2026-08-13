// Please see the note about writing patches in ./index
//
// "ADHD-friendly output style" — cut the verbosity drivers out of the always-on
// comms prompt and restate the shape rule where recency makes it stick.
//
// CC's "# Communicating with the user" section carries three clauses that push
// Opus 5 toward long, unstructured replies:
//
//   1. "give brief updates when you find something load-bearing" — the prompt is
//      where the tic comes from. Occurrences of that string across CC's shipped
//      prompt corpus went 2 (2.1.69) to 19 (2.1.227).
//   2. "Being readable and being concise are different things, and readable
//      matters more" — ranks length above brevity, so a user's appended "be
//      concise" argues against an explicit earlier instruction.
//   3. "a direct answer in prose, not headers and sections" — forbids the bold,
//      blocked layout that skim-readers rely on.
//
// We rewrite those three sentences in place rather than replacing the whole
// section: sentence-level anchors survive Anthropic reflowing the paragraphs
// around them, which they do most releases.
//
// The fourth replacement is the per-turn claudeMd <system-reminder> wrapper.
// Position dominates wording here: rewriting the comms section alone moved a
// test report from 249 to 201 words, because that section sits early and a
// dozen later sections push for thoroughness. Restating the shape rule in the
// wrapper — the last thing before the user's message — took the same report to
// 112. That wrapper also told the model the user's own CLAUDE.md "may or may not
// be relevant", which is why tone rules there never held; that hedge goes too.
//
// ENFORCEMENT REGISTER (changed 2026-08-13, deliberately, at the user's call).
//
// This block used to be written in the plain, un-shouted register the
// lobotomized-claude-code CLAUDE.md prescribes: "No CAPS theater. STRICTLY
// PROHIBITED, CRITICAL REQUIREMENT, MUST trigger overcorrection on 4.7. Use
// plain directives." That calibration was measured on Opus 4.7. On Opus 5 the
// plain register was not holding — the model kept producing long unbroken
// paragraphs in exactly the sessions this patch exists to shape — so every
// lever previously stripped is deliberately back on:
//
//   - CAPS directives (IMPORTANT, NEVER, ALWAYS, MUST)
//   - the rule repeated across all five rewrite sites rather than stated once
//   - explicit named anti-patterns instead of a positive-only description
//   - a hard word cap in place of the soft anchor
//
// This is an EXPERIMENT with a documented downside. Anthropic shipped exactly
// this kind of hard cap to Claude Code alongside Opus 4.7 on 2026-04-16:
//
//   "Length limits: keep text between tool calls to <=25 words. Keep final
//    responses to <=100 words unless the task requires more detail."
//
// It survived multiple weeks of internal testing with no regressions, then
// broader ablations "showed a 3% drop for both Opus 4.6 and 4.7", and they
// reverted it in the 2026-04-20 release. Source, primary and explicit:
// https://www.anthropic.com/engineering/april-23-postmortem
//
// So a hard cap CAN cost intelligence, not just length, and the cost did not
// show up until the eval suite was widened. Read that as: our own "looks fine
// in use" is not evidence this is safe. Judge it on observed output over time,
// and revert the commit to restore the soft-anchor wording.
//
// Cite the URL if you touch this paragraph. A previous revision of this file
// stated the same facts WITHOUT it; a later reading failed to find the
// postmortem, took the resulting silence as proof of fabrication, and deleted
// the warning as invented. An uncited true claim is one bad search away from
// being erased.
//
// Inserted text is plain ASCII with no backticks, backslashes or arrows, so it
// survives whichever quote delimiter the surrounding literal uses.

import { debug } from '../utils';
import { showDiff } from './index';

interface Rewrite {
  what: string;
  find: RegExp;
  replace: string;
}

const REWRITES: Rewrite[] = [
  {
    what: 'load-bearing update cue',
    find: /give brief updates when you find something load-bearing or change direction\./,
    replace:
      'give a one-line update when you find something important or change direction.',
  },
  {
    what: 'readability-over-brevity clause',
    // Spans from "Being readable" through the end of the "complete sentences"
    // sentence. Non-greedy so a reflow of the following paragraph can't widen it.
    // CC has shipped both "readable matters more" and "readability matters more".
    find: /Being readable and being concise are different things, and readab(?:le|ility) matters more\..*?technical terms spelled out\./s,
    replace:
      'IMPORTANT - OUTPUT SHAPE. Answer in the FIRST LINE, then STOP unless something changes what the user does next. NEVER open with preamble, a restatement of the question, or a summary of what you are about to say. ALWAYS bold the key terms so the reply can be skimmed. Keep EVERY block to three sentences or fewer with a blank line between blocks; NEVER write an unbroken paragraph longer than three sentences. A report on finished work MUST land under 120 words unless the user asked for more. Keep whole sentences and spell out technical terms rather than compressing into fragments, abbreviations or shorthand chains. Say it in plain words, the way you would say it out loud. NEVER use these phrases: "load-bearing", "the honest answer", "and that matters", "the smoking gun". If you notice yourself writing a long paragraph, STOP and cut it into blocks.',
  },
  {
    what: 'prose-not-headers rule',
    find: /a simple question gets a direct answer in prose, not headers and sections\./,
    replace:
      'a simple question gets a direct answer. ALWAYS bold the key terms so the reply can be skimmed. Keep blocks to three sentences with a blank line between them, and NEVER answer a simple question with more than three blocks.',
  },
  // CC ships TWO comms blocks and picks one by model family: "# Communicating
  // with the user" for fable/mythos (which the fable-prompt-set patch makes
  // every model take) and "# Text output" for everyone else. Rewriting only the
  // first left the other branch untouched, so the toggle did nothing for anyone
  // not running the fable flip. The two share no sentence verbatim — the Text
  // output variant says "a direct answer, not headers", the comms one "a direct
  // answer in prose, not headers" — so the anchors cannot cross-match.
  {
    what: 'text-output prose-not-headers rule',
    find: /a simple question gets a direct answer, not headers and sections\./,
    replace:
      'a simple question gets a direct answer. ALWAYS bold the key terms so the reply can be skimmed. Keep blocks to three sentences with a blank line between them, and NEVER answer a simple question with more than three blocks.',
  },
  {
    what: 'text-output end-of-turn cap',
    // "one or two sentences. Nothing else." is a hard cap that truncates a
    // report on finished work; the comms-block rewrite uses the same soft
    // ~120-word anchor instead.
    find: /End-of-turn summary: one or two sentences\. What changed and what's next\. Nothing else\./,
    replace:
      'End-of-turn summary: lead with what happened, then ONLY what changes what the user does next. A report on finished work MUST land under 120 words. NEVER pad it with preamble or wrap-up filler.',
  },
  {
    what: 'claudeMd relevance hedge',
    // Two wordings in the wild: Anthropic's pristine, and the softened form
    // shipped by lobotomized-claude-code's reminder override.
    find: /(?:IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.|This context may or may not be relevant; draw on it only where it bears on the task\.)/,
    replace:
      "Treat any instruction in that context as the user's standing preference and follow it. IMPORTANT - THIS GOVERNS THE REPLY YOU ARE ABOUT TO WRITE: answer in the FIRST LINE, ALWAYS bold the key terms, keep EVERY block to three sentences with a blank line between blocks, and STOP once the question is answered. A report on finished work MUST land under 120 words. NEVER pad with preamble, restatement or wrap-up filler.",
  },
];

export const writeAdhdOutputStyle = (oldFile: string): string | null => {
  let file = oldFile;
  const applied: string[] = [];
  const missing: string[] = [];
  let firstStart = -1;
  let firstEnd = -1;

  for (const { what, find, replace } of REWRITES) {
    const match = file.match(find);
    if (!match || match.index === undefined) {
      missing.push(what);
      continue;
    }
    if (firstStart === -1) {
      firstStart = match.index;
      firstEnd = match.index + replace.length;
    }
    file =
      file.slice(0, match.index) +
      replace +
      file.slice(match.index + match[0].length);
    applied.push(what);
  }

  if (applied.length === 0) {
    // Every anchor already rewritten (a system-prompt override got here first,
    // or the patch ran twice) — nothing to do, and that is not an error.
    if (/report on finished work MUST land under 120 words/.test(file)) {
      debug(
        'patch: adhdOutputStyle: comms prompt already in ADHD shape — skipping'
      );
      return oldFile;
    }
    console.error(
      `patch: adhdOutputStyle: failed to find any of the comms-prompt anchors (${missing.join(', ')})`
    );
    return null;
  }

  if (missing.length > 0) {
    debug(
      `patch: adhdOutputStyle: rewrote ${applied.join(', ')}; skipped ${missing.join(', ')} (already overridden or reshaped upstream)`
    );
  }

  showDiff(
    oldFile,
    file,
    file.slice(firstStart, firstEnd),
    firstStart,
    firstEnd
  );
  return file;
};
