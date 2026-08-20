// Please see the note about writing patches in ./index

import { showDiff } from './index';
import type { ColorTagPalettes } from '../types';
import {
  DEFAULT_COLOR_TAG_PALETTES,
  deriveMutedPalettes,
} from '../colorTagPalettes';

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
const STRING_HELPER = '_twkCT';

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
  palettes: ColorTagPalettes,
  mutedPalettes: ColorTagPalettes
): string => {
  const { colorFn, chalkVar } = idents;
  const table = JSON.stringify(palettes);
  const mutedTable = JSON.stringify(mutedPalettes);

  return (
    `function ${HELPER}(raw,theme,sr,muted){` +
    `var P=muted?${mutedTable}:${table};` +
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

/**
 * Finds the identifier of CC's synchronous global-config reader, by way of the
 * one place in the bundle that reads a theme name off it.
 *
 * The markdown renderer receives the theme name as a parameter, so the token
 * helper never had to look it up. The surfaces below are Ink components and
 * plain mapper functions with no such parameter, and the theme lives behind a
 * React context whose hook cannot be called from a mapper. The config reader is
 * the one accessor that works from anywhere.
 */
const findConfigGetter = (file: string): string | null => {
  const m = /([$\w]+)\(\)\.theme\|\|"light"/.exec(file);
  return m ? m[1] : null;
};

/**
 * Builds the string-level interpreter used outside the markdown renderer.
 *
 * The token helper answers "what SGR sequence does this ONE tag mean", because
 * `marked` hands the renderer each inline-HTML tag as its own token. Nothing
 * tokenises the strings that reach a dialog or the recap line, so those need
 * the other shape: take a whole string, rewrite every tag in it, leave
 * everything else alone.
 *
 * Three properties it has to hold, all of them learnt from where these strings
 * go next:
 *
 * - **It runs at render, never on the data model.** The AskUserQuestion display
 *   model is not display-only: `displayQuestion.text` is what the tool feeds
 *   back to the model as the question it asked, `displayLabel` is matched by
 *   equality to recover the selected option's preview, and `displayHeader` is
 *   measured and truncated to lay out the tab bar. Colouring any of those at
 *   the point they are built would put escape sequences into the model's own
 *   context and break an equality test and a width calculation. Every call
 *   site below is therefore a JSX child or a select-item label.
 * - **It closes what it opens.** A span left open at the end of a string would
 *   bleed its colour into whatever Ink prints next, so an unbalanced string
 *   gets a scoped foreground reset appended.
 * - **It never throws.** Any failure returns the input untouched, which renders
 *   the tags literally — the same failure mode as an unapplied patch.
 */
const buildStringHelper = (configGetter: string | null): string =>
  `function ${STRING_HELPER}(raw,muted){` +
  `try{` +
  `if(typeof raw!=="string"||raw.indexOf("<c")===-1)return raw;` +
  `var th="dark";` +
  (configGetter ? `try{th=${configGetter}().theme||"dark"}catch(e){}` : '') +
  `var sr=!!(process.env.CLAUDE_AX_SCREEN_READER||process.env.INK_SCREEN_READER||process.env.CLAUDE_CODE_ACCESSIBILITY);` +
  `var open=0;` +
  `var out=raw.replace(/<c\\s+(?:v\\s*=\\s*)?["']?[^"'<>\\s]+["']?\\s*\\/?>|<\\/c\\s*>/gi,function(tag){` +
  `var r=${HELPER}(tag,th,sr,muted);` +
  // null = not one of ours (or an unknown colour name): leave it visible.
  `if(r===null)return tag;` +
  `if(tag.charAt(1)==="/")open=open>0?open-1:0;else open++;` +
  `return r;});` +
  `if(open>0&&!sr&&out.indexOf("\\x1b")!==-1)out+="\\x1b[39m";` +
  `return out;` +
  `}catch(e){return raw}` +
  `}`;

/** One rewrite of a UI render site: what to find, and what to put back. */
interface UiSite {
  /** Human-readable name, used only in the "not applied" log line. */
  label: string;
  pattern: RegExp;
  replace: string;
  /** How many matches this site is expected to have. */
  expect: number;
}

/**
 * The render sites outside the markdown renderer.
 *
 * Each is anchored on the SHAPE of the expression rather than on any minified
 * name, and each carries its own expected match count so a bundle that grows or
 * loses one of them says so instead of silently half-applying.
 *
 * The AskUserQuestion header chips are deliberately absent. They are short
 * (12 characters at most), and the tab bar both measures them with a width
 * function and truncates them to fit — a colour span inside a string that is
 * about to be cut by character count is a corrupted escape sequence, and the
 * payoff on a 12-character chip is close to nothing.
 */
const UI_SITES: UiSite[] = [
  {
    // The option -> select-item mapper. `value` is the machine identity and
    // stays raw; label and description are what the row prints.
    label: 'AskUserQuestion option rows',
    pattern:
      /return\{type:"text",value:([$\w]+)\.value,label:\1\.displayLabel,description:([$\w]+)\(\1\.displayDescription\)\}/,
    replace:
      `return{type:"text",value:$1.value,label:${STRING_HELPER}($1.displayLabel),` +
      `description:${STRING_HELPER}($2($1.displayDescription))}`,
    expect: 1,
  },
  {
    // The question itself, in both the live dialog and its memoised twin. The
    // memo key stays on the raw text, so this does not defeat the cache.
    label: 'AskUserQuestion question text',
    pattern: /\{title:([$\w.?]+)\.displayQuestion\.text,color:"text"\}/g,
    replace: `{title:${STRING_HELPER}($1.displayQuestion.text),color:"text"}`,
    expect: 2,
  },
  {
    // The answered-questions summary rendered above the dialog.
    label: 'AskUserQuestion answered summary',
    pattern: /children:([$\w?.]+)\.displayQuestion\.text\|\|"Question"/,
    replace: `children:${STRING_HELPER}($1.displayQuestion.text||"Question")`,
    expect: 1,
  },
  {
    // The multi-select rows, which print displayLabel directly rather than
    // going through the mapper above.
    label: 'AskUserQuestion multi-select rows',
    pattern: /children:\[" ",([$\w]+)\.displayLabel\]/,
    replace: `children:[" ",${STRING_HELPER}($1.displayLabel)]`,
    expect: 1,
  },
  {
    // The session recap line. Muted, because the recap is secondary chrome that
    // Claude Code already renders dim and italic; a full-strength colour there
    // would make the quietest line on screen the loudest. The label ("recap: ")
    // is matched only to pin the anchor to this component.
    label: 'session recap line',
    pattern:
      /(children:\["recap:"," "\][\s\S]{0,400}?\{dimColor:!0,italic:!0,children:)([$\w]+)(\})/,
    replace: `$1${STRING_HELPER}($2,1)$3`,
    expect: 1,
  },
];

/**
 * Applies the UI render-site rewrites.
 *
 * Independent of the renderer edit, exactly like the stream-split guard: a site
 * whose shape has drifted logs and is skipped, because colour tags in assistant
 * prose are the feature and colour tags in a dialog are the extension. A bundle
 * change should cost the extension, not the patch.
 */
const applyUiSites = (file: string): string => {
  let out = file;
  for (const site of UI_SITES) {
    const found = out.match(site.pattern);
    const count = site.pattern.global
      ? [...out.matchAll(site.pattern)].length
      : found
        ? 1
        : 0;
    if (count !== site.expect) {
      console.log(
        `patch: markdownColorTags: ${site.label} not colour-tagged ` +
          `(expected ${site.expect} site(s), found ${count}) — colour tags still ` +
          `work in assistant prose`
      );
      continue;
    }
    out = out.replace(site.pattern, site.replace);
  }
  return out;
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

  const configGetter = findConfigGetter(oldFile);
  const helper =
    buildHelper(idents, palettes, deriveMutedPalettes(palettes)) +
    buildStringHelper(configGetter);

  // Insert the helpers immediately before the renderer so they share its scope
  // (that is what puts CC's colour applicator and chalk instance in reach).
  //
  // The UI sites below sit up to 3 MB away in the bundle and still resolve
  // both names: the bundle is a single top-level scope — its string-width
  // helper, for one, is declared once and called from regions 16 MB apart — so
  // a function declaration here hoists across the whole file.
  let newFile =
    oldFile.slice(0, anchorIndex) +
    replacement +
    oldFile.slice(anchorIndex + anchor.length);

  newFile =
    newFile.slice(0, idents.start) + helper + newFile.slice(idents.start);

  // Independent of the renderer edit: if these can't anchor, colour tags still
  // work correctly in assistant prose, so they must not fail the patch.
  newFile = applySplitGuard(newFile);
  newFile = applyUiSites(newFile);

  showDiff(
    oldFile,
    newFile,
    replacement,
    anchorIndex,
    anchorIndex + anchor.length
  );

  return newFile;
};
