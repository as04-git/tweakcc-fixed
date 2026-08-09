import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { writeMarkdownColorTags } from './markdownColorTags';
import { DEFAULT_COLOR_TAG_PALETTES } from '../colorTagPalettes';

/**
 * A faithful miniature of Claude Code's markdown token renderer: same shape
 * (`function NAME(token, themeName, opts={})`), same destructured
 * `screenReader` option, same `case"codespan"` / `case"em"` / `case"html"`
 * bodies the patch reads its identifiers out of.
 *
 * The tests don't just assert on the patched *text* — they `eval` the patched
 * source and run it, so a syntactically broken or semantically wrong injection
 * fails here rather than in the terminal.
 */
const FIXTURE = `
var wt={level:3,italic:function(s){return "\\x1b[3m"+s+"\\x1b[23m"},bold:function(s){return s}};
function to(color,theme){return function(s){
  if(wt.level===0)return s;
  var code,m;
  if((m=/^#([0-9a-f]{6})$/i.exec(color))){
    var n=parseInt(m[1],16);
    code="38;2;"+((n>>16)&255)+";"+((n>>8)&255)+";"+(n&255);
  } else if((m=/^ansi256\\((\\d{1,3})\\)$/.exec(color))){
    code="38;5;"+m[1];
  } else { code="38;5;99"; }
  return "\\x1b["+code+"m"+s+"\\x1b[39m";
};}
function d2(e,t,r={}){let{listDepth:n=0,orderedListNumber:o=null,parent:i=null,highlight:s=null,glueProse:a=!1,screenReader:l=!1}=r,c=null;
switch(e.type){case"codespan":return to("permission",t)(e.text);case"em":return wt.italic(e.text);case"html":return e.text;case"def":return""}
return e.raw}
`;

const patch = (src = FIXTURE) =>
  writeMarkdownColorTags(src, DEFAULT_COLOR_TAG_PALETTES);

/** Evaluates patched source and returns the renderer's html-case handler. */
const load = (src: string) => {
  const factory = new Function(`${src}; return d2;`);
  return factory() as (
    token: { type: string; text?: string; raw?: string },
    theme: string,
    opts?: Record<string, unknown>
  ) => string;
};

const html = (text: string, theme = 'dark', opts = {}) =>
  load(patch()!)({ type: 'html', text }, theme, opts);

describe('markdownColorTags', () => {
  it('finds the renderer and rewrites only the html case', () => {
    const out = patch();
    expect(out).not.toBeNull();
    expect(out).toContain('case"html":return _twkC(e.text,t,l)??e.text');
    // untouched neighbours
    expect(out).toContain('case"codespan":return to("permission",t)(e.text)');
    expect(out).toContain('case"def":return""');
  });

  it('returns null when the renderer is absent', () => {
    expect(writeMarkdownColorTags('function unrelated(){return 1}')).toBeNull();
  });

  it('emits the palette color for a preset name', () => {
    expect(html('<c blue>')).toBe('\x1b[38;2;122;162;247m');
  });

  it('emits a scoped foreground reset for the closing tag', () => {
    // ESC[39m, not ESC[0m — bold/italic/dim from the renderer must survive.
    expect(html('</c>')).toBe('\x1b[39m');
  });

  it('accepts a literal hex through the escape hatch', () => {
    expect(html('<c v=#7aa2f7>')).toBe('\x1b[38;2;122;162;247m');
    expect(html('<c v="#7aa2f7">')).toBe('\x1b[38;2;122;162;247m');
  });

  it('passes unrelated HTML through verbatim', () => {
    expect(html('<br>')).toBe('<br>');
    expect(html('<div class="x">')).toBe('<div class="x">');
    expect(html('</span>')).toBe('</span>');
  });

  it('renders an unknown color name literally so the mistake is visible', () => {
    expect(html('<c chartreuse>')).toBe('<c chartreuse>');
  });

  it('rejects colors CC’s applicator would not accept', () => {
    expect(html('<c v=javascript:alert(1)>')).toBe('<c v=javascript:alert(1)>');
    expect(html('<c v=#12>')).toBe('<c v=#12>');
  });

  it('switches palette on the active theme name', () => {
    // distinct palettes must not collapse to the same escape
    const themes = ['dark', 'light', 'dark-daltonized', 'light-daltonized'];
    const seen = themes.map(t => html('<c red>', t));
    // every theme class must resolve `red` to its own value
    expect(new Set(seen).size).toBe(themes.length);
    expect(html('<c red>', 'dark')).toBe('\x1b[38;2;247;118;142m');
    expect(html('<c red>', 'light')).toBe('\x1b[38;2;196;38;94m');
    // *-ansi themes defer to the terminal's own palette
    expect(html('<c red>', 'dark-ansi')).toBe('\x1b[38;5;9m');
    expect(html('<c red>', 'light-ansi')).toBe('\x1b[38;5;9m');
  });

  it('suppresses color entirely under screen-reader mode', () => {
    expect(html('<c blue>', 'dark', { screenReader: true })).toBe('');
    expect(html('</c>', 'dark', { screenReader: true })).toBe('');
  });

  it('emits nothing when the terminal has no color support', () => {
    const noColor = patch()!.replace('level:3', 'level:0');
    const render = load(noColor);
    expect(render({ type: 'html', text: '<c blue>' }, 'dark', {})).toBe('');
    expect(render({ type: 'html', text: '</c>' }, 'dark', {})).toBe('');
  });

  // Applies the patch to the real extracted Claude Code bundle when one is
  // present, and compiles the result. Skipped on machines without an install.
  const realBundle = path.join(
    os.homedir(),
    '.tweakcc',
    'native-claudejs-orig.js'
  );
  const hasBundle = fs.existsSync(realBundle);

  it.skipIf(!hasBundle)(
    'applies cleanly to the real Claude Code bundle and still compiles',
    () => {
      const src = fs.readFileSync(realBundle, 'utf8');
      const out = writeMarkdownColorTags(src, DEFAULT_COLOR_TAG_PALETTES);
      expect(out).not.toBeNull();

      // the dead html case is gone, the dispatch is rewritten exactly once
      expect(out).not.toContain('case"html":return e.text');
      const hits = out!.split('case"html":return _twkC(').length - 1;
      expect(hits).toBe(1);

      // helper injected once, in the renderer's own scope
      expect(out!.split('function _twkC(').length - 1).toBe(1);

      // and the patched bundle is still syntactically valid JavaScript
      expect(() => new vm.Script(out!)).not.toThrow();
    },
    120_000
  );

  describe('stream split guard', () => {
    // Verbatim shape of CC's fallback splitter, including the real newline in
    // the template literal.
    const SPLITTER =
      'var Ebn=4096,FUp=1536;\nfunction BUp(e){let t=e.lastIndexOf(`\n`);if(t<Ebn/2)t=e.lastIndexOf(" ",e.length-FUp);if(t<Ebn/2){t=e.length-FUp;let r=e.charCodeAt(t+1);if(r>=56320&&r<=57343)t--}return t+1}';

    /** Patched splitter, callable. */
    const splitter = () => {
      const out = writeMarkdownColorTags(FIXTURE + SPLITTER)!;
      expect(out).toContain('return _twkS(e,t+1)}');
      return new Function(`${out}; return BUp;`)() as (s: string) => number;
    };

    it('rewrites the splitter to route through the guard', () => {
      const out = writeMarkdownColorTags(FIXTURE + SPLITTER)!;
      expect(out).toContain('function _twkS(s,i)');
      expect(out).toContain('return _twkS(e,t+1)}');
    });

    it('leaves the split alone when no span is open at the cut', () => {
      const plain = 'x'.repeat(3000) + ' ' + 'y'.repeat(3000);
      const guarded = splitter()(plain);
      const bare = plain.lastIndexOf(' ', plain.length - 1536) + 1;
      expect(guarded).toBe(bare);
    });

    it('leaves the split alone when the span closed before the cut', () => {
      const s = 'a'.repeat(2000) + '<c blue>done</c>' + 'b'.repeat(3000);
      const idx = splitter()(s);
      const head = s.slice(0, idx);
      // no unclosed span in the first chunk
      expect(head.lastIndexOf('<c ')).toBeLessThan(head.indexOf('</c>'));
    });

    it('backs the split up so it never lands inside an open span', () => {
      // span straddles where the naive space-split would cut
      const head = 'a'.repeat(3000);
      const span = '<c blue>' + 'word '.repeat(200) + '</c>';
      const s = head + span + 'b'.repeat(200);
      const idx = splitter()(s);
      const first = s.slice(0, idx);
      const open = first.lastIndexOf('<c ');
      // either no opening tag in the chunk, or it is closed within it
      const safe = open === -1 || first.indexOf('</c>', open) !== -1;
      expect(safe).toBe(true);
    });

    it('never returns 0, which would stall the renderer', () => {
      // pathological: one enormous span starting at index 0
      const s = '<c blue>' + 'z '.repeat(6000) + '</c>';
      const idx = splitter()(s);
      expect(idx).toBeGreaterThan(0);
    });

    it('keeps the original split when backing up would exceed the bound', () => {
      const s = 'a'.repeat(2000) + '<c blue>' + 'q '.repeat(4000);
      const guarded = splitter()(s);
      const bare = (() => {
        const t = s.lastIndexOf(' ', s.length - 1536);
        return t + 1;
      })();
      // span is longer than the 3072 backup bound -> original split retained
      expect(guarded).toBe(bare);
    });

    it('applies the guard to the real bundle exactly once', () => {
      if (!fs.existsSync(realBundle)) return;
      const out = writeMarkdownColorTags(fs.readFileSync(realBundle, 'utf8'))!;
      expect(out.split('function _twkS(s,i)').length - 1).toBe(1);
      expect(out).toMatch(/return _twkS\([$\w]+,[$\w]+\+1\)\}/);
    });
  });

  it('survives minified identifier renaming', () => {
    const renamed = FIXTURE.replace(/\bwt\b/g, 'Q9')
      .replace(/\bto\b/g, 'zK')
      .replace(/\bd2\b/g, 'xX')
      .replace(/screenReader:l=/, 'screenReader:S=');
    const out = writeMarkdownColorTags(renamed, DEFAULT_COLOR_TAG_PALETTES);
    expect(out).not.toBeNull();
    expect(out).toContain('case"html":return _twkC(e.text,t,S)??e.text');
    const render = new Function(`${out}; return xX;`)() as (
      t: { type: string; text: string },
      theme: string,
      o: Record<string, unknown>
    ) => string;
    expect(render({ type: 'html', text: '<c blue>' }, 'dark', {})).toBe(
      '\x1b[38;2;122;162;247m'
    );
  });
});
