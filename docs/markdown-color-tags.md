# Markdown color tags

Lets Claude use color to organize its own prose, with a syntax small enough to be
cheap in context and a palette that follows the active theme.

```
<c blue>text</c>          preset
<c v=#7aa2f7>text</c>     literal color
```

Enable it in the tweakcc TUI under **Misc → Markdown color tags**, or set
`settings.misc.enableMarkdownColorTags` in `~/.tweakcc/config.json`, then
`--apply`. The patch alone only teaches the _renderer_; pair it with the
instructions below so the model knows the syntax exists.

## How it works

Claude Code renders assistant markdown by walking `marked` tokens through a
single function that returns an ANSI **string**, which Ink then prints. Styling
is already string-level chalk throughout (`bold`, `italic`, `dim`), so color is
not a new rendering mode — it is the mechanism already in use.

Inside that function, raw HTML is a no-op:

```js
case "html": return e.text;   // inline HTML is echoed verbatim
```

Nothing depends on that behavior, which makes it an unusually contained hook.
The patch replaces it with a color-tag interpreter and keeps the fallback: any
HTML that isn't one of our tags still returns unchanged.

### Why the tags don't wrap their contents

`marked` tokenizes inline HTML as _separate_ open and close tokens:

```
"<c blue>hi</c>"  ->  html("<c blue>")   text("hi")   html("</c>")
```

There is no tree to wrap, so the interpreter can't be a wrapper function. It
emits the color's opening SGR sequence on `<c …>` and a **scoped** foreground
reset (`ESC[39m`) on `</c>` — scoped, so surrounding bold/italic/dim survive.
The consequence is that color tags don't nest, which the instructions state.

This also settled the syntax. `<c #7aa2f7>` **does not tokenize as HTML at all**
(attribute names can't begin with `#`) and degrades into literal text, so the
literal-color form has to be `<c v=#7aa2f7>`.

### Colors come from Claude Code's own applicator

Rather than emit escapes by hand, the patch calls the color function the
renderer already uses. It accepts `#hex`, `rgb()` and `ansi256()` and routes
through chalk, so 256-color and 16-color terminals downgrade for free and
`NO_COLOR` produces no output at all. The open/close pair is recovered by
running a sentinel through it:

```js
const [open, close] = colorFn('\0').split('\0');
```

The active theme name and the screen-reader flag are already parameters of the
renderer, so palette switching and accessibility suppression need no new
detection.

## Palettes

Selected at render time from the theme name. Override any of it under
`settings.misc.colorTagPalettes`.

| theme          | palette           |
| -------------- | ----------------- |
| `dark`         | Tokyo Night       |
| `light`        | contrast-tuned    |
| `*-daltonized` | CVD-optimized     |
| `*-ansi`       | terminal's own 16 |

Every entry in the dark and light palettes clears **WCAG AA** (≥ 4.5:1) against
its reference background. Bright terminal colors are unreadable on white, so the
light set is tuned separately rather than reused.

### The daltonized palettes are not the standard hues with a filter

Dichromats perceive roughly a blue–yellow axis plus luminance, so **eight
distinct hues is not physically achievable**. Simulating deuteranopia and
protanopia over the standard dark palette collapses `blue`/`purple` to
**dE 0.5** and `orange`/`yellow` to **dE 1.9** — indistinguishable.

The daltonized values were solved numerically instead: maximize minimum pairwise
separation under both simulations, subject to ≥ 4.5:1 contrast. Result is ≥ 15
dE between every pair under both conditions, bought largely through
**luminance** rather than hue.

**Name fidelity is deliberately not a constraint.** Someone using a daltonized
theme needs the colors _told apart_, not matched to their names — and enforcing
plausible names costs real separation (it drops the dark set from ≈ 18.8 to
14.3 dE). So `orange` is a dark brown and `gray` is near-black. That last one is
load-bearing: a true mid-gray `#595959` collapses against `red` to **dE 7.0**
under protanopia. The cost is that on light-daltonized, `gray` reads much like
body text.

### Both variants are available

`settings.misc.colorTagDaltonizedVariant` (or the TUI row **Color tags —
colorblind palette**) picks between them:

| variant                | dark worst pair | light worst pair | trade                                   |
| ---------------------- | --------------- | ---------------- | --------------------------------------- |
| `separation` (default) | **18.8 dE**     | **18.3 dE**      | `orange` reads brown, `gray` near-black |
| `name-faithful`        | 14.3 dE         | 16.4 dE          | each color looks like its name          |

Both sit inside the band where colors are reliably told apart, so this is a
genuine preference rather than a good option and a bad one. `separation` is the
default because the audience for a daltonized theme needs the colors _told
apart_ more than named correctly.

### Why not Okabe-Ito

The obvious move is to reach for the well-known colorblind-safe palette. It was
evaluated and rejected on measurement:

|                 | deuteranopia min dE | protanopia min dE | worst on white | worst on dark |
| --------------- | ------------------- | ----------------- | -------------- | ------------- |
| Okabe-Ito (raw) | **5.1**             | ≥ 15              | **1.32**       | 3.30          |
| this palette    | **≥ 15**            | **≥ 15**          | 4.77           | 4.51          |

Okabe-Ito is designed for categorical **fills on white paper**, and it is very
good at that. As terminal _text_ it fails WCAG AA on both backgrounds, and its
deuteranopia separation is roughly a third of what the solver reaches — because
"distinguishable as adjacent swatches" is a weaker requirement than
"distinguishable as thin glyphs against a background."

`*-ansi` themes defer to the terminal's own palette — seven of the eight map
onto the base 16; `orange` has no ANSI equivalent and uses a 256-cube index.

## Instructions to pair with the patch

Append to `~/.tweakcc/system-prompts/system-prompt-communication-style.md` — the
site that already governs text output — then `--apply`.

```markdown
# Color

Color text with `<c NAME>text</c>` — presets: red, orange, yellow, green, cyan,
blue, purple, gray. Use `<c v=#7aa2f7>text</c>` for a specific color.

Use it where color makes structure scannable: the term being defined, the value
that changed, the one line of an error that matters. Uncolored text is the
default, and color only works by contrast with it — a colored paragraph is worse
than a plain one. Don't nest tags.

Color never carries meaning on its own. It is stripped for screen readers and in
piped output, so anything it conveys must survive in the words alone.
```

## Streaming: why the splitter is patched too

Streaming output is cut into chunks that each render as their own Ink element.
A color span split across a chunk boundary would leave the first chunk's
foreground sequence unterminated — bleeding color into everything after it — and
the second chunk emitting an orphan reset.

The primary split path is already safe: it cuts at `stablePrefix`, a complete
markdown token boundary, which never lands inside an inline span. Only the
fallback splitter cuts mid-block, and only when a single incomplete block
exceeds `Ebn` (4096 chars) — it takes the last newline, else a **space** 1536
chars from the end, which can land inside a span.

Three fixes were considered:

| approach                              | outcome                                             | sites touched |
| ------------------------------------- | --------------------------------------------------- | ------------- |
| reset at chunk end                    | stops the bleed but **loses the rest of the color** | 1             |
| carry + reopen, mirroring `openFence` | fully correct                                       | 3             |
| **span-aware split point**            | correct by construction                             | **1**         |

Claude Code already solves this shape of problem for code fences by carrying
`openFence` forward and reopening it in the next chunk, so the second option is
the house pattern. But it means touching the chunk state object, the chunk
emitter, and the assembly. Refusing to cut inside an open span reaches the same
invariant in one self-contained function, so that is what ships.

The guard is bounded on both sides: it only backs the split up when that still
leaves forward progress (`open > 0`) and the backup is ≤ 3072 chars. A span
longer than that keeps the original split — a brief artifact is better than an
empty chunk, which would livelock the renderer. There is a test for exactly that
case.

The guard is applied independently of the renderer edit. If its anchor ever
stops matching, it logs and the color patch still applies correctly — the only
loss is exposure to the rare artifact.

## Failure behavior

| situation                             | result                                    |
| ------------------------------------- | ----------------------------------------- |
| unknown color name                    | renders literally, so the mistake is seen |
| color the applicator rejects          | renders literally                         |
| screen-reader mode                    | no color emitted                          |
| `NO_COLOR` / no TTY                   | no color emitted                          |
| patch absent (e.g. after a CC update) | tags render as literal text               |

That last row is the real cost of the design: an un-reapplied patch shows raw
`<c blue>` tags in output. It is the same failure mode as every other tweakcc
patch after a Claude Code update — re-run `--apply`.
