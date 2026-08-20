# Override intent

How to keep hand-made prompt overrides separable from Claude Code version drift.

This document is written for a fresh session with no prior context. It states the
problem, the current decision, the full inventory as of CC 2.1.237, and the
build instructions for the mechanism that is planned but not yet built.

## The problem

A system-prompt override is a **full replacement body**. The patcher swaps
Claude Code's embedded prompt for whatever the `.md` file contains — it does not
apply a diff.

That has a consequence nobody notices at the time. When Anthropic edits a
prompt, the override keeps the old wording forever, and nothing in the file
records which lines were chosen on purpose. Six months later the file contains a
mixture of deliberate edits and fossilised old pristine, and the two are
indistinguishable by inspection.

Every counter stays at zero while this happens. `--apply` reports success, the
mis-bind audit passes, the smoke test passes. The only visible signal is the
advisory `ccVersion` conflict, which says "the pristine moved" and nothing about
which part of your file you meant.

Two failure modes seen in practice on 2026-08-20, at the CC 2.1.226 → 2.1.237
bump:

1. **Frozen text.** `system-reminder-file-modified-externally` carried the
   literal wording of CC **2.1.18**. Anthropic had since moved that sentence into
   a computed `${ATTACHMENT_OBJECT}` value. The override kept injecting the 2018
   -era literal, and had done so across roughly two hundred releases.
2. **Silent disablement.** `system-reminder-new-diagnostics-detected` referenced
   `${DIAGNOSTICS_SUMMARY}`. In 2.1.237 that slot is named
   `DIAGNOSTICS_TRACKER_CLASS`, so the patcher logged
   `Unresolved placeholder ... - skipping` and dropped the whole file. The
   override had no intentional content, so nothing was lost — but the same
   mechanism would silently drop a file that did.

## Current decision (2026-08-20): D4, cleanup without machinery

The drift was cleaned by hand and no tooling was built. The reasoning: the real
intent set is three items, so a mechanism to protect three items costs more than
it saves, and "prefer changing the situation to adding machinery" applies.

D1 below is the intended successor **when the intent set grows past roughly ten
items, or when a bump produces drift that is not trivially fixable by hand.**

## The intent inventory

Every deliberate change to a Claude Code prompt on this machine. Anything not on
this list is drift and should be reverted to pristine, not preserved.

### 1. Colour-tag instructions — three prompts

The `markdown-color-tags` patch teaches the renderer the syntax. The model only
uses it if the prompts say it exists. The same content is appended in three
places because three different prompts govern text output.

| prompt id | shape of the edit |
| --- | --- |
| `system-prompt-harness-instructions` | one bullet appended to the harness bullet list |
| `system-prompt-communication-style` | a `# Color` section appended |
| `system-prompt-communicating-with-the-user` | a `# Color` section appended |

Canonical text lives in [`markdown-color-tags.md`](markdown-color-tags.md) under
"Instructions to pair with the patch". Keep the three copies in sync with it.

### 2. Fable 5 text-drop defect — one prompt

In `system-prompt-communicating-with-the-user`, inside the
`${…VAR_0? … :""}` conditional block. Two insertions:

- After `Text you write between tool calls may not be shown to the user.` —
  the sentences naming `anthropics/claude-code#74260`, stating that mid-turn
  text followed by further thinking is silently discarded, and saying to treat
  it as always in effect.
- After `Keep text between tool calls to brief status notes` — the clause
  forbidding a question-asking tool paired with context in the same message.

**Retire both when the upstream issue closes.** The same note exists in
`~/.claude/CLAUDE.md` and should be deleted at the same time.

### 3. Nothing else

As of 2026-08-20 there is no third category. Two other overrides were active and
are *not* intentional; see the open questions at the bottom of this file.

## D1 — the mechanism, if it gets built

**Shape.** One machine-readable intent file. At each version bump, delete every
override, let the patcher regenerate pristine stubs, then replay the intent file
onto them. Drift stops being something to detect, because a body is never
carried across a version.

**Why this shape rather than a drift report.** A report tells you drift happened
and leaves you to act. Regeneration means the old body never survives long
enough to fossilise. The cost is that every edit must be expressible as a
mechanical operation, which is the real constraint on the design.

### Build instructions

1. **Schema.** One entry per edit, not per file — a prompt can carry several
   independent edits with different lifetimes, which is already true of
   `system-prompt-communicating-with-the-user`. Fields:
   - `id` — the prompt id, matching the `.md` filename.
   - `op` — `append` | `insert-after` | `replace` | `replace-body`.
   - `anchor` — for `insert-after` and `replace`, the exact existing substring.
     Required to be unique within the pristine body.
   - `text` — the content to insert, or the replacement.
   - `why` — one line. This is the field that makes the file worth keeping.
   - `retire-when` — optional. Free text, e.g. an upstream issue number.

2. **Applier.** A script under `tools/` that reads the intent file, reads the
   regenerated pristine stub for each `id`, applies its entries in order, and
   writes the result. **It must fail loudly when an anchor is missing or matches
   more than once** — a silently skipped intent is the exact failure this whole
   design exists to prevent. Exit non-zero and name the entry.

3. **Placeholder check.** After applying, verify every `${NAME}` in the result
   exists in that prompt's `identifierMap` in the current
   `data/prompts/prompts-<ver>.json`. This catches the
   `DIAGNOSTICS_SUMMARY` class of failure before `--apply` does, and with a
   better error message.

4. **Pipeline position.** Runs in the showtime pipeline between Phase 6
   (`--apply`, which regenerates the stubs) and the final verification apply. It
   needs the stubs to exist, and its output needs to be applied.

5. **Migration.** Not needed. The intent inventory above is the seed content, and
   the three colour-tag entries plus the two Fable entries are the whole file.

### What D1 does not solve

An edit that **removes** text is expressible as `replace` with an empty string,
but only while its anchor survives. A whole-body trim (`replace-body`) is not
protected from drift at all — the body is still frozen text, just frozen text
that is now labelled as such. If a trim-style override ever becomes load-bearing
here, that is the case to think harder about.

## Open questions

Two overrides are active, carry no recorded intent, and change model-facing
behaviour. Neither has been resolved.

- **`system-reminder-file-modified-externally`** — freezes CC 2.1.18 wording
  ("This change was intentional, so make sure to take it into account… Don't
  tell the user this"). Reverting it means the model receives whatever 2.1.237's
  computed `${ATTACHMENT_OBJECT}` renders, which has not been observed. If the
  old wording is genuinely preferred, it belongs in the inventory above as an
  intent, not left in place as an accident.
- **`tool-description-showonboardingrolepicker`** — trims the tool description
  from 787 to 133 characters, dropping the resolution-paths detail and the
  "do NOT call this in normal conversation" guard. Arrived in the 2026-08-07
  bulk import rather than being hand-written, so it most likely came from a
  lobotomized-claude-code pack.
