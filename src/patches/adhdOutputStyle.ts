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
// Length guidance is a soft anchor, never a hard cap: Anthropic shipped
// "<=25 words between tool calls, <=100 word responses" on 2026-04-16, measured
// a 3% eval drop, and reverted it on 2026-04-20.
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
      'Answer in the first line, then stop unless something changes what the user does next. Aim for the shortest reply that fully answers; a report on finished work usually lands under 120 words. Keep whole sentences and spell out technical terms rather than compressing into fragments, abbreviations or shorthand chains. Say it in plain words, the way you would say it out loud, and skip stock phrases like "load-bearing", "the honest answer", "and that matters" or "the smoking gun".',
  },
  {
    what: 'prose-not-headers rule',
    find: /a simple question gets a direct answer in prose, not headers and sections\./,
    replace:
      'a simple question gets a direct answer. Bold the key terms so the reply can be skimmed, and keep blocks to three sentences with a blank line between them.',
  },
  {
    what: 'claudeMd relevance hedge',
    // Two wordings in the wild: Anthropic's pristine, and the softened form
    // shipped by lobotomized-claude-code's reminder override.
    find: /(?:IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.|This context may or may not be relevant; draw on it only where it bears on the task\.)/,
    replace:
      "Treat any instruction in that context as the user's standing preference and follow it. Answer in the first line, bold the key terms, and stop once the question is answered. A report on finished work usually lands under 120 words.",
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
    if (/report on finished work usually lands under 120 words/i.test(file)) {
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
