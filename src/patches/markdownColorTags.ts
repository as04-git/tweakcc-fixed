// Please see the note about writing patches in ./index

import { showDiff } from './index';
import type { ColorTagPalettes } from '../types';
import { DEFAULT_COLOR_TAG_PALETTES } from '../colorTagPalettes';

/**
 * Teaches Claude Code's markdown renderer to honor a tiny colour-tag syntax so
 * the model can use colour to organise its own prose:
 *
 *     <c blue>text</c>          preset from the active palette
 *     <c v=#7aa2f7>text</c>     literal colour (escape hatch)
 *
 * ## Why this hook
 *
 * CC renders assistant markdown by walking `marked` tokens through a single
 * function that returns an ANSI *string* (Ink then prints it). Inside that
 * function raw HTML is currently a no-op:
 *
 * ```js
 * case"html":return e.text;
 * ```
 *
 * Nothing depends on that behaviour — inline HTML is simply echoed verbatim —
 * so replacing it is about as contained as a patch gets. We keep the fallback:
 * anything that is not one of our tags still returns `e.text` unchanged.
 *
 * ## Why open/close emit bare SGR sequences
 *
 * `marked` tokenises inline HTML as *separate* open and close tokens:
 *
 *     "<c blue>hi</c>"  ->  html("<c blue>")  text("hi")  html("</c>")
 *
 * There is no tree to wrap, so the interpreter cannot be a wrapper function —
 * it emits the colour's opening SGR sequence on `<c …>` and the scoped
 * foreground reset (`ESC[39m`) on `</c>`. `ESC[39m` resets *only* the
 * foreground, so surrounding bold/italic/dim from the renderer survive.
 * Consequently colour tags do not nest; the instructions tell the model so.
 *
 * ## Where the colours come from
 *
 * We reuse CC's own colour applicator rather than emitting escapes by hand. It
 * takes `#hex` / `rgb()` / `ansi256()` and routes through chalk, so 256-colour
 * and 16-colour terminals downgrade for free and `NO_COLOR` yields no output at
 * all. We recover the open/close pair by running a sentinel through it:
 *
 *     const [open, close] = colorFn("\0").split("\0")
 *
 * The active theme name is already a parameter of the renderer, so the palette
 * switches automatically between dark / light / daltonized / ansi variants. The
 * screen-reader flag is likewise already threaded in, and suppresses colour
 * entirely.
 *
 * ```diff
 *   function d2(e,t,r={}){let{listDepth:n=0,...,screenReader:l=!1}=r,...
 *     switch(e.type){
 *     ...
 * -   case"html":return e.text;
 * +   case"html":return _twkC(e.text,t,l)??e.text;
 *     }}
 * ```
 */

const HELPER = '_twkC';
const SPLIT_GUARD = '_twkS';

/**
 * Streaming output is cut into chunks that each render as their own Ink
 * element, so a colour span split across a chunk boundary would leave the first
 * chunk's foreground sequence unterminated — bleeding colour into everything
 * after it — and the second chunk emitting an orphan reset.
 *
 * The primary split path is safe already: it cuts at `stablePrefix`, a complete
 * markdown token boundary, which never lands inside an inline span. Only the
 * fallback splitter fires mid-block, and only for a single incomplete block
 * over 4096 characters — it cuts at the last newline, else at a *space* 1536
 * chars from the end, which can absolutely land inside a span.
 *
 * Claude Code already solves this shape of problem for code fences by carrying
 * the open fence forward and reopening it in the next chunk. Mirroring that for
 * colour would mean touching the chunk state object, the chunk emitter, and the
 * assembly — three fragile sites. Refusing to cut inside an open span gets the
 * same invariant in one self-contained function, so that is what this does.
 *
 * Bounded on both sides: it only backs the split up when doing so still leaves
 * forward progress (`open > 0`) and the backup is at most 3072 chars. A span
 * longer than that keeps the original split — an artifact is better than a
 * stalled or empty chunk, which would livelock the renderer.
 */
const buildSplitGuard = (): string =>
  `function ${SPLIT_GUARD}(s,i){` +
  `try{` +
  `var h=s.slice(0,i),o=h.lastIndexOf("<c ");` +
  // no opening tag, or the span already closed before the cut: split is safe
  `if(o===-1||h.indexOf("</c>",o)!==-1)return i;` +
  // only back up when it still makes progress and stays bounded
  `if(o>0&&i-o<=3072)return o;` +
  `return i;` +
  `}catch(e){return i;}` +
  `}`;

/**
 * Rewrites the fallback splitter to route its chosen index through the guard.
 * Returns the file unchanged (and says so) when the shape isn't found — the
 * colour patch is still correct without it, just exposed to the rare artifact.
 */
const applySplitGuard = (file: string): string => {
  const re =
    /function ([$\w]+)\(([$\w]+)\)\{let ([$\w]+)=\2\.lastIndexOf\(`\n`\);if\(\3<([$\w]+)\/2\)\3=\2\.lastIndexOf\(" ",\2\.length-([$\w]+)\);if\(\3<\4\/2\)\{\3=\2\.length-\5;let ([$\w]+)=\2\.charCodeAt\(\3\+1\);if\(\6>=56320&&\6<=57343\)\3--\}return \3\+1\}/;

  const m = file.match(re);
  if (!m || m.index === undefined) {
    console.log(
      'patch: markdownColorTags: stream split guard not applied (splitter shape not found) — colour tags still work; a colour span inside a >4096-char streamed block may briefly bleed'
    );
    return file;
  }

  const [whole, , arg, idx] = m;
  const patched = whole.replace(
    new RegExp(`return ${idx}\\+1\\}$`),
    `return ${SPLIT_GUARD}(${arg},${idx}+1)}`
  );

  return (
    file.slice(0, m.index) +
    buildSplitGuard() +
    patched +
    file.slice(m.index + whole.length)
  );
};

interface RendererIdents {
  /** Identifier of the renderer function (e.g. `d2`). */
  fnName: string;
  /** Name of the theme-name parameter (2nd positional param). */
  themeParam: string;
  /** Local bound to the destructured `screenReader` option, if present. */
  screenReaderVar: string | null;
  /** Identifier of CC's colour applicator, from the `codespan` case. */
  colorFn: string;
  /** Identifier of CC's chalk instance, from the `em` case. */
  chalkVar: string;
  /** Absolute offset of `function <fnName>(` in the file. */
  start: number;
  /** Absolute offset just past the function's closing brace. */
  end: number;
}

/**
 * Locates the markdown token renderer and reads the local identifiers we need
 * out of its own body, so the patch survives minifier renaming across releases.
 */
const findRenderer = (file: string): RendererIdents | null => {
  // The renderer is the only function containing all of these token cases.
  const anchor = file.indexOf('case"html":return e.text');
  if (anchor === -1) return null;

  // Walk back to the enclosing `function NAME(p1,p2,p3={})` declaration.
  const head = file.slice(Math.max(0, anchor - 20000), anchor);
  const decls = [
    ...head.matchAll(/function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)=\{\}\)/g),
  ];
  const decl = decls[decls.length - 1];
  if (!decl) return null;

  const fnName = decl[1];
  const themeParam = decl[3];
  const start = Math.max(0, anchor - 20000) + decl.index;

  // Balance braces from the declaration to find the function's extent.
  let depth = 0;
  let i = start + decl[0].length;
  for (; i < file.length; i++) {
    const ch = file[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const end = i;
  const body = file.slice(start, end);
  if (end <= anchor) return null;

  const sr = body.match(/screenReader:([$\w]+)=/);
  const color = body.match(/case"codespan":return ([$\w]+)\("permission"/);
  const chalk = body.match(/case"em":return ([$\w]+)\.italic\(/);
  if (!color || !chalk) return null;

  return {
    fnName,
    themeParam,
    screenReaderVar: sr ? sr[1] : null,
    colorFn: color[1],
    chalkVar: chalk[1],
    start,
    end,
  };
};

/**
 * Builds the injected runtime helper. Palettes are baked in at apply time so
 * there is no config read on the hot path.
 */
const buildHelper = (
  idents: RendererIdents,
  palettes: ColorTagPalettes
): string => {
  const { colorFn, chalkVar } = idents;
  const table = JSON.stringify(palettes);

  return (
    `function ${HELPER}(raw,theme,sr){` +
    `var P=${table};` +
    // `</c>` — scoped foreground reset only, so bold/italic/dim survive.
    `if(/^<\\/c\\s*>$/i.test(raw))return sr?"":(${chalkVar}.level>0?"\\x1b[39m":"");` +
    `var m=/^<c\\s+(?:v\\s*=\\s*)?["']?([^"'<>\\s]+)["']?\\s*\\/?>$/i.exec(raw);` +
    // Not one of ours: signal the caller to fall back to verbatim text.
    `if(!m)return null;` +
    `if(sr)return "";` +
    `var t=String(theme||"dark"),` +
    `pal=t.indexOf("ansi")!==-1?P.ansi:` +
    `(t.indexOf("light")===0` +
    `?(t.indexOf("daltonized")!==-1?P.lightDaltonized:P.light)` +
    `:(t.indexOf("daltonized")!==-1?P.darkDaltonized:P.dark));` +
    `var k=m[1].toLowerCase(),c=Object.prototype.hasOwnProperty.call(pal,k)?pal[k]:null;` +
    // Escape hatch: literal colour, but only in forms CC's applicator accepts.
    `if(!c&&/^(#[0-9a-f]{3}|#[0-9a-f]{6}|ansi256\\(\\d{1,3}\\)|rgb\\(\\s?\\d{1,3},\\s?\\d{1,3},\\s?\\d{1,3}\\s?\\))$/i.test(m[1]))c=m[1];` +
    // Unknown name: return null so the tag renders literally and the mistake is visible.
    `if(!c)return null;` +
    `try{var parts=${colorFn}(c,theme)("\\x00").split("\\x00");` +
    `return parts.length===2?parts[0]:"";}catch(e){return "";}` +
    `}`
  );
};

export const writeMarkdownColorTags = (
  oldFile: string,
  palettes: ColorTagPalettes = DEFAULT_COLOR_TAG_PALETTES
): string | null => {
  const idents = findRenderer(oldFile);
  if (!idents) {
    console.error(
      'patch: markdownColorTags: failed to locate the markdown token renderer'
    );
    return null;
  }

  const anchor = 'case"html":return e.text';
  const anchorIndex = oldFile.indexOf(anchor, idents.start);
  if (anchorIndex === -1 || anchorIndex > idents.end) {
    console.error(
      'patch: markdownColorTags: html token case not found inside the renderer'
    );
    return null;
  }

  const sr = idents.screenReaderVar ?? '!1';
  const replacement = `case"html":return ${HELPER}(e.text,${idents.themeParam},${sr})??e.text`;

  const helper = buildHelper(idents, palettes);

  // Insert the helper immediately before the renderer so it shares its scope
  // (that is what puts CC's colour applicator and chalk instance in reach).
  let newFile =
    oldFile.slice(0, anchorIndex) +
    replacement +
    oldFile.slice(anchorIndex + anchor.length);

  newFile =
    newFile.slice(0, idents.start) + helper + newFile.slice(idents.start);

  // Independent of the renderer edit: if this can't anchor, colour tags still
  // work correctly, so it must not fail the patch.
  newFile = applySplitGuard(newFile);

  showDiff(
    oldFile,
    newFile,
    replacement,
    anchorIndex,
    anchorIndex + anchor.length
  );

  return newFile;
};
