<div align="center">

# ⚡ tweakcc-fixed

### Customize Claude Code far past its settings menu — themes, prompts, thinking, toolsets, and behavior — patched straight into the installed binary.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.0.98%20%E2%86%92%202.1.221-d97757?style=flat-square)](https://github.com/anthropics/claude-code)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#credit--license)

**[Install](#install) · [Customize](#what-you-can-customize) · [The fork](#what-this-fork-adds) · [This fork](#what-this-fork-adds-on-top) · [How it works](#how-it-works)**

</div>

---

Claude Code only exposes so much through its settings. tweakcc reaches the rest: it patches the installed binary directly — the `cli.js`, and the JavaScript baked into the native Bun build — so you can restyle the interface, rewrite the prompts Claude actually runs on, and change how it behaves. You pick what you want from a terminal UI, apply it in one command, and roll it back whenever you like.

The lineage runs [Piebald's tweakcc](https://github.com/Piebald-AI/tweakcc) → [skrabe's tweakcc-fixed](https://github.com/skrabe/tweakcc-fixed) → this. Everything each one does still applies: over four times the prompt coverage of the original, a deeper set of patches, and overrides that reach the native install where upstream stops ([below](#what-this-fork-adds)). What this fork adds on top is native support for models Claude Code has never heard of, and color as a formatting tool the model can actually use ([below](#what-this-fork-adds-on-top)).

```console
$ npx -y tweakcc-fixed@latest --apply
  ✓ Theme, spinner, thinking verbs, statusline
  ✓ System Prompt: Doing tasks (override)        92 fewer chars
  ✓ Tool Description: Bash (override)             4 fewer chars
  ✓ Toolset + subagent model selection
  …  patches applied · backup written
```

## Install

```bash
npx -y tweakcc-fixed@latest            # interactive TUI — toggle patches, edit prompts
npx -y tweakcc-fixed@latest --apply    # apply everything you've enabled
npx -y tweakcc-fixed@latest --restore  # revert from the backup
npx -y tweakcc-fixed@latest --validate-system-prompts  # dry-run the apply preflight over your overrides
```

Updating Claude Code overwrites the patches, so you just re-run `--apply` — your configuration in `~/.tweakcc/config.json` is untouched either way.

> **This fork is not on npm.** The commands above install [skrabe/tweakcc-fixed](https://github.com/skrabe/tweakcc-fixed), which does **not** include the custom-model or color-tag patches below. To get those, build from source:
>
> ```bash
> git clone https://github.com/as04-git/tweakcc-fixed.git && cd tweakcc-fixed
> pnpm install && pnpm build
> node dist/index.mjs           # TUI
> node dist/index.mjs --apply
> ```

## What you can customize

Everything lives behind one terminal UI: toggle a patch, edit a prompt, apply.

The surface is wide. You can restyle the **look** — themes, the wording of the thinking verbs, the spinner's symbols and speed, the input border, the statusline, table rendering, session titles. You can rewrite the **prompts** — every system prompt, tool description, and `<system-reminder>` is plain markdown you can edit, so you change what Claude is told, not just how it's dressed. You can retune the **tooling** — toolsets, subagent model selection, input-pattern highlighters, file-read limits, MCP startup. And you can adjust **behavior** — reasoning-effort defaults, memory handling, session naming, and a good deal more.

It works the same on npm and native (Bun-compiled) installs, every change is a toggle, and `--restore` puts the original binary back.

## What this fork adds

tweakcc-fixed is a strict superset of the original: everything above still applies, on the same latest Claude Code target. What it adds is reach.

The biggest difference is coverage. Its extractor pulls over four times the prompt surface upstream does — every model-facing string at any length: tool results, system reminders, utility-agent prompts, slash-command descriptions, and the short fragments the base skips. Every candidate string is classified by its emission site (model-facing vs UI vs internal) with verdicts cached content-addressed, so coverage is complete by construction, not by heuristic. That is what makes serious prompt editing possible in the first place.

|                              | tweakcc-fixed | upstream  |
| ---------------------------- | :-----------: | :-------: |
| Prompt sites (CC 2.1.221)    |   **3,347**   |    624    |
| Unique prompt IDs            |   **3,118**   |    624    |
| Patches                      |    **58**     |    45     |
| Overrides on native installs |    **yes**    | gated off |

That reach shows up in a few mechanisms the base doesn't have. The `<system-reminder>` injections that fire per turn — and never surface as named prompts — become editable: blank one out to drop it, or rewrite it. Each connected MCP server's instruction block can be dropped or rewritten the same way. And where upstream gates system-prompt overrides off for native installs, this fork applies them. It pairs with [lobotomized-claude-code](https://github.com/skrabe/lobotomized-claude-code), a set of per-model override packs tuned against exactly this extraction.

The extra patches cluster around a few themes: **memory** (a dream-mode consolidation pass, leaner memory types), **reasoning** (Opus defaulting to max effort, plus the experimental complexity router), **search** (the experimental fff backend), and a run of **correctness fixes** — an honest rewind-summary header, a "summarize from here" that actually starts at the rewind point, quieter empty system-reminders, and more.

Two of those are worth calling out, and both ship off by default. **fff-first Bash search** routes Claude's grep, find, and rg through [fff](https://github.com/dmtrKovalenko/fff) and a warm-index daemon, so results come back ranked; it serves a query only when the result is provably identical to the real tool and falls back to the embedded ripgrep/ugrep on anything it can't match exactly, so correctness never rides on it. **The complexity router** reads how hard each task is and routes reasoning effort to match — routine work runs low, the hardest runs max — without switching models or churning the prompt cache, and an explicit `/effort` or `CLAUDE_CODE_EFFORT_LEVEL` always wins.

Newest is **Better Claude in Chrome** — a menu item, not a patch, that installs [claude-browser-bridge](https://github.com/skrabe/claude-browser-bridge) and points Claude Code at your real, logged-in browser over the Chrome DevTools Protocol. It sees and _claims_ your existing signed-in tabs — a fuller, self-hosted take on Claude in Chrome, driven through a `/browser` skill and a programmable `run` primitive (script a whole flow — locate, fill, click, wait, read — in one call). Pick it and it fetches the bridge, wires up the MCP server and the skill, walks you through loading the extension once, and disables the built-in Claude in Chrome so you have one browser surface. Pure config plus a fetched repo, no `cli.js` patch; Reinstall and Uninstall live in the same menu.

<details>
<summary>Every patch the fork adds</summary>

<br>

Each patch is tagged with how it behaves on `--apply`: **`[default on]`** applies unless you set its config flag to `false`, **`[always]`** applies unconditionally with no toggle, **`[opt-in]`** applies only if you turn it on. Patches that change model-facing behavior are marked **on by default** below — `--apply` activates them even if you never selected them, so review these before applying.

**Memory & context**

- `dream-mode` **`[default on]`** — `/dream` plus automatic memory consolidation
- `lean-memory-types` **`[opt-in]`** — a trimmed memory-type taxonomy
- `claudemd-context-once-per-conversation` **`[default on]`** — inject CLAUDE.md and context once per conversation, not every turn (rewrites how CLAUDE.md reaches the model)

**Reasoning**

- `max-effort-default` **`[opt-in]`** — Opus defaults to max reasoning effort
- `complexity-router` **`[opt-in]`** — route reasoning effort by task difficulty _(experimental)_

**Search**

- `swap-ripgrep-for-fff` **`[opt-in]`** — fff-backed grep, find, and rg _(experimental)_

**Correctness & noise**

- `fix-rewind-summary-header` **`[default on]`** — an honest rewind / compaction summary header
- `fix-summarize-from-here` **`[default on]`** — "summarize from here" starts at the rewind point, not the top
- `strip-empty-system-reminders` **`[always]`** — drop the empty `<system-reminder>` blocks left after empty tool output
- `read-default-lines` **`[always]`** — an env-gated cap on the default `Read` line count
- `suppress-deferred-tools` **`[opt-in]`** — drop the deferred-tools announcement
- `multi-skill-invocation` **`[opt-in]`** — invoke every `/skill` you type in one message ("`/a /b do X`") directly, not just the leading one (real user invocations, no model round-trip)

**Models & prompts**

- `autonomous-operation-all-models` **`[opt-in]`** — apply the Fable/Mythos autonomous prompt set to every model
- `auto-mode-classifier-model` **`[opt-in]`** — pin the auto-mode safety classifier to a cheaper model

</details>

## What this fork adds on top

Two additions, both off by default.

### Custom models, natively

Claude Code's `/model` list, context-window accounting, `/effort` rungs and subagent resolution are all computed **inside the binary**, from an embedded model catalog. No proxy can reach them — which is why the usual approach of pointing `ANTHROPIC_BASE_URL` at a gateway and _renaming_ a model leaves Claude Code lying about what is running and capping context at the wrong number.

These patches extend the catalog instead of impersonating it. Put an entry in `settings.customModels` and it becomes a real picker row with its own context window, its own effort rungs, its own `/model` alias, and working subagent selection — without redefining what `opus`, `sonnet`, `haiku` or `fable` mean.

| patch                         | what it fixes                                                         |
| ----------------------------- | --------------------------------------------------------------------- |
| `custom-model-catalog`        | appends entries to the embedded catalog                               |
| `context-window-from-catalog` | the resolver never read the catalog; every custom model reported 200k |
| `custom-model-picker`         | catalog entries alone don't appear in the interactive `/model` picker |
| `custom-model-alias`          | `/model <alias>` for custom ids                                       |
| `agent-tool-model-string`     | lets the Agent tool accept a non-built-in model name                  |
| `rate-limits-from-headers`    | statusline quota in sessions the OAuth check would otherwise gate off |

They are provider-agnostic: any gateway speaking the Anthropic or OpenAI wire format will do. Built for running Kimi K3 and GPT-5.6 subscriptions next to a Claude subscription. The catalog is `safeParse`d at runtime and a parse failure falls back to an _empty_ catalog — a dead Claude Code — so `custom-model-catalog` self-validates its output before writing. [Design notes and CC internals map](docs/custom-model-gateway.md).

### Markdown color tags

Lets the model organize its own prose with color:

```
<c blue>text</c>          preset
<c v=#7aa2f7>text</c>     literal color
```

The hook is a genuinely dead branch in the markdown renderer — raw HTML is currently echoed verbatim — so non-tag HTML still passes through untouched. Colors route through Claude Code's own applicator, so 256- and 16-color terminals downgrade for free and `NO_COLOR` emits nothing.

The palette follows the active theme automatically. Dark and light entries all clear **WCAG AA**. The daltonized palettes are not the standard hues filtered: dichromats perceive roughly a blue-yellow axis plus luminance, so eight distinct hues is not achievable — simulating deuteranopia over the standard set collapses `blue`/`purple` to **dE 0.5**. They were solved numerically for maximum pairwise separation under deuteranopia and protanopia instead, and ship in two variants depending on whether you want maximum distance or names that match their colors. [Design notes](docs/markdown-color-tags.md).

## How it works

Two kinds of edit, both driven by your config in `~/.tweakcc/config.json`:

```
  ┌──────────────────────┐      ┌────────────────────────────┐
  │ 1. code patches      │      │ 2. prompt overrides        │
  │ regex-anchored        │      │ swap embedded prompt text   │
  │ splices of JS         │      │ for your markdown           │
  └──────────┬───────────┘      └─────────────┬──────────────┘
             └────────────┬────────────────────┘
                          ▼
       npm cli.js   ──or──   native Bun binary
       (patched in place)    (JS extracted → patched → repacked)
                          ▼
             backup written · `--restore` anytime
```

A code patch finds a minified shape with a regex and splices in modified JS; a prompt override swaps the embedded prompt text for your markdown. npm installs are patched in place, while native installs have their JS pulled out of the Bun binary with [node-lief](https://github.com/Piebald-AI/node-lief), patched, and repacked with stale bytecode cleared. The same building blocks ship as a library — `tryDetectInstallation`, `readContent`/`writeContent`, `backupFile`, and the minified-identifier `helpers` — if you'd rather script your own patches.

## Staying current

When Claude Code ships a new version, the [showtime skill](./skills/showtime/) runs the whole upgrade: pull the new `cli.js`, re-extract the prompts, realign anything that drifted, and verify it landed clean. Say "it's showtime," or run `node skills/showtime/driver.mjs check`.

**Relationship to upstream.** This fork shares history with [skrabe/tweakcc-fixed](https://github.com/skrabe/tweakcc-fixed) — identical commit hashes up to the point where this one diverges — so it tracks upstream rather than drifting from it:

```bash
git remote add upstream https://github.com/skrabe/tweakcc-fixed.git
git fetch upstream && git merge upstream/main
```

The additions here are deliberately narrow and self-contained, which keeps that merge cheap. The color-tag patch in particular has no dependency on the custom-model work and may be proposed upstream.

## Credit & license

Built on [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc) (© [Piebald LLC](https://piebald.ai)) — all of the core customization is its work — by way of [skrabe/tweakcc-fixed](https://github.com/skrabe/tweakcc-fixed), which contributed the extraction pipeline, the system-reminder and MCP-instruction overrides, native-install support, and most of the patch set, carried with fixes from upstream PRs [#601](https://github.com/Piebald-AI/tweakcc/pull/601), [#646](https://github.com/Piebald-AI/tweakcc/pull/646), [#655](https://github.com/Piebald-AI/tweakcc/pull/655), and [#664](https://github.com/Piebald-AI/tweakcc/pull/664). Only the custom-model and color-tag work above is this fork's. [MIT](https://github.com/Piebald-AI/tweakcc/blob/main/LICENSE).

<div align="center">

If it made your Claude Code better, a ⭐ helps others find it.

</div>
