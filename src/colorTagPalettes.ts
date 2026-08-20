import type { ColorTagPalettes, DaltonizedVariant } from './types';

/**
 * Default palettes for the markdown colour-tag patch.
 *
 * The renderer already knows the active theme name, so the palette is chosen at
 * render time and the model never has to think about light vs dark.
 *
 * ## How these values were chosen
 *
 * - **dark / light** — every entry clears WCAG AA (>= 4.5:1) against its
 *   reference background (`#1a1b26` for dark, `#ffffff` for light). The dark set
 *   is Tokyo Night's palette; the light set is hand-tuned for contrast on white,
 *   since bright terminal colours are unreadable there.
 *
 * - **daltonized** — these are NOT the standard hues with a filter applied.
 *   Dichromats perceive roughly a blue-yellow axis plus luminance, so eight
 *   distinct hues is not physically achievable: simulating deuteranopia and
 *   protanopia over the standard dark palette collapses `blue`/`purple` to
 *   dE 0.5 and `orange`/`yellow` to dE 1.9 — indistinguishable. These values
 *   were instead solved numerically to maximise minimum pairwise separation
 *   under both simulations, subject to >= 4.5:1 contrast. Every pair is >= 15
 *   dE apart under both conditions, carried mostly by luminance, not hue.
 *
 *   Name fidelity is deliberately not a constraint here — the audience for a
 *   daltonized theme needs the colours to be *told apart*, not to match their
 *   names. Enforcing plausible names costs real separation (it drops the dark
 *   set from ~18.8 to 14.3 dE), so the names are approximate by design.
 *
 *   Okabe-Ito was evaluated and rejected: it is a fills-on-white palette, and
 *   as terminal text it fails AA on both backgrounds (yellow is 1.32:1 on
 *   white, blue 3.30:1 on dark) with a deuteranopia minimum of just 5.1 dE.
 *
 * - **ansi** — used for the `*-ansi` themes, where the point is to defer to the
 *   terminal's own palette. Seven of the eight map onto the base 16 so the
 *   user's terminal theme governs; `orange` has no ANSI equivalent and falls
 *   back to a 256-cube index.
 *
 * Users can override any of this in `~/.tweakcc/config.json` under
 * `settings.misc.colorTagPalettes`; values are baked into the binary on apply.
 */
export const DEFAULT_COLOR_TAG_PALETTES: ColorTagPalettes = {
  // Tokyo Night — all >= 6.4:1 on #1a1b26
  dark: {
    red: '#f7768e',
    orange: '#ff9e64',
    yellow: '#e0af68',
    green: '#9ece6a',
    cyan: '#2ac3de',
    blue: '#7aa2f7',
    purple: '#bb9af7',
    gray: '#9aa5ce',
  },
  // all >= 4.8:1 on #ffffff
  light: {
    red: '#c4265e',
    orange: '#a75300',
    yellow: '#8f6c00',
    green: '#2f7d31',
    cyan: '#00697a',
    blue: '#1a56db',
    purple: '#8250df',
    gray: '#5c6370',
  },
  // >= 15 dE between every pair under deuteranopia AND protanopia; min
  // contrast 4.51 on #1a1b26. Hue is secondary here — separation is carried
  // mostly by luminance, which is what survives dichromacy.
  darkDaltonized: {
    red: '#fb3109',
    orange: '#eda126',
    yellow: '#d2fb18',
    green: '#7da163',
    cyan: '#0e90aa',
    blue: '#4e86d4',
    purple: '#d9c2fa',
    gray: '#918383',
  },
  // >= 15 dE between every pair under both conditions; min contrast 4.77 on
  // white. `gray` is near-black on purpose: it is the only neutral that stays
  // separated from `red` (a true mid-gray #595959 collapses to dE 7.0 under
  // protanopia). The cost is that `gray` reads much like body text here.
  lightDaltonized: {
    red: '#892f4d',
    orange: '#4b2001',
    yellow: '#847215',
    green: '#415a30',
    cyan: '#0b7e8e',
    blue: '#0467f1',
    purple: '#584573',
    gray: '#1f1f1f',
  },
  // defer to the terminal's own 16-colour palette where one exists
  ansi: {
    red: 'ansi256(9)',
    orange: 'ansi256(208)',
    yellow: 'ansi256(11)',
    green: 'ansi256(10)',
    cyan: 'ansi256(14)',
    blue: 'ansi256(12)',
    purple: 'ansi256(13)',
    gray: 'ansi256(8)',
  },
};

/**
 * The name-faithful alternative to the daltonized palettes above.
 *
 * Same solver, same constraints, plus a requirement that each colour stay
 * recognisable as its name (hue pinned to its family, saturation floor,
 * bounded lightness). That costs separation — worst pair falls from 18.8 to
 * 14.3 dE on dark and 18.3 to 16.4 dE on light — but both remain inside the
 * band where colours are reliably told apart, so this is a real option rather
 * than a worse one. Choose it if you want `orange` to look orange.
 */
export const NAME_FAITHFUL_DALTONIZED: Pick<
  ColorTagPalettes,
  'darkDaltonized' | 'lightDaltonized'
> = {
  // worst pair 14.3 dE (cyan~purple, deuteranopia)
  darkDaltonized: {
    red: '#e84a6a',
    orange: '#b7744e',
    yellow: '#c4b36e',
    green: '#28dc46',
    cyan: '#22f8fc',
    blue: '#758fc7',
    purple: '#af7fe6',
    gray: '#949494',
  },
  // worst pair 16.4 dE (red~gray, protanopia)
  lightDaltonized: {
    red: '#46010b',
    orange: '#7c4322',
    yellow: '#8d7102',
    green: '#1d7c2d',
    cyan: '#2c6d6a',
    blue: '#2c598c',
    purple: '#ab21ca',
    gray: '#3b3535',
  },
};

/**
 * Resolves the palettes to bake into the binary: pick a daltonized variant,
 * then let an explicit user override win over everything.
 */
export const resolveColorTagPalettes = (
  variant: DaltonizedVariant = 'separation',
  override?: ColorTagPalettes | null
): ColorTagPalettes => {
  if (override) return override;
  if (variant === 'name-faithful') {
    return { ...DEFAULT_COLOR_TAG_PALETTES, ...NAME_FAITHFUL_DALTONIZED };
  }
  return DEFAULT_COLOR_TAG_PALETTES;
};

/** The preset names the model is allowed to use. */
export const COLOR_TAG_NAMES = Object.keys(
  DEFAULT_COLOR_TAG_PALETTES.dark
) as (keyof ColorTagPalettes['dark'])[];

/**
 * Reference backgrounds the palettes above were contrast-checked against, and
 * the backgrounds the muted variants are blended toward.
 */
const REFERENCE_BACKGROUNDS: Record<
  Exclude<keyof ColorTagPalettes, 'ansi'>,
  string
> = {
  dark: '#1a1b26',
  light: '#ffffff',
  darkDaltonized: '#1a1b26',
  lightDaltonized: '#ffffff',
};

/**
 * Contrast the muted variants aim for, in place of the AA 4.5:1 the primary
 * palettes clear.
 *
 * 3.2:1 is a deliberate landing spot rather than a round number: WCAG puts the
 * floor for large text and for UI components at 3:1, so this stays above the
 * threshold at which a colour stops being reliably readable, while sitting far
 * enough below 4.5 that the text visibly recedes next to body prose. The muted
 * set is only ever used on secondary chrome (the session recap), which is
 * already rendered dim and italic — the blend is what makes the effect
 * consistent across terminals, since SGR 2 (faint) is widely ignored when a
 * truecolour foreground is set.
 */
const MUTED_CONTRAST_TARGET = 3.2;

/**
 * Muted counterparts for the ANSI palette. There is no arithmetic to do on a
 * palette index, and blending is not available, so this is the one place the
 * mapping is hand-written: each bright colour drops to its normal-intensity
 * sibling, which is what "muted" means in a 16-colour terminal. `gray` is
 * already the dim one and has nowhere lower to go, so it stays.
 */
const ANSI_MUTED: Record<string, string> = {
  'ansi256(9)': 'ansi256(1)',
  'ansi256(208)': 'ansi256(130)',
  'ansi256(11)': 'ansi256(3)',
  'ansi256(10)': 'ansi256(2)',
  'ansi256(14)': 'ansi256(6)',
  'ansi256(12)': 'ansi256(4)',
  'ansi256(13)': 'ansi256(5)',
  'ansi256(8)': 'ansi256(8)',
};

const parseHex = (value: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const h =
    m[1].length === 3
      ? m[1]
          .split('')
          .map(c => c + c)
          .join('')
      : m[1];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};

const toHex = (rgb: [number, number, number]): string =>
  '#' +
  rgb
    .map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'))
    .join('');

/** WCAG relative luminance. */
const luminance = (rgb: [number, number, number]): number => {
  const [r, g, b] = rgb.map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (
  a: [number, number, number],
  b: [number, number, number]
): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

const mix = (
  colour: [number, number, number],
  background: [number, number, number],
  amount: number
): [number, number, number] => [
  colour[0] * (1 - amount) + background[0] * amount,
  colour[1] * (1 - amount) + background[1] * amount,
  colour[2] * (1 - amount) + background[2] * amount,
];

/**
 * Blends one colour toward a background until it lands on the muted contrast
 * target, by bisection on the blend amount. Contrast falls monotonically as the
 * colour approaches the background, so bisection converges; 40 iterations put
 * the answer well inside one 8-bit step.
 *
 * A colour already at or below the target is returned untouched — muting it
 * further would push it under the readability floor rather than making it
 * quieter.
 */
const muteColour = (value: string, background: string): string => {
  const ansi = ANSI_MUTED[value.trim()];
  if (ansi) return ansi;
  const colour = parseHex(value);
  const bg = parseHex(background);
  if (!colour || !bg) return value;
  if (contrastRatio(colour, bg) <= MUTED_CONTRAST_TARGET) return value;

  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (contrastRatio(mix(colour, bg, mid), bg) > MUTED_CONTRAST_TARGET)
      low = mid;
    else high = mid;
  }
  return toHex(mix(colour, bg, low));
};

/**
 * Derives the muted palette set used for secondary chrome from whichever
 * palettes are actually in effect, so a user override under
 * `settings.misc.colorTagPalettes` gets a matching muted set for free instead
 * of falling back to a hardcoded table tuned for different colours.
 *
 * Note what this does NOT preserve: the daltonized palettes carry their
 * separation mostly in luminance, and compressing luminance toward the
 * background necessarily compresses that separation. The muted set is therefore
 * correct for *reading* but is not a colourblind-separation palette in its own
 * right — which is why it is confined to a single non-load-bearing surface, and
 * why nothing that must be told apart by colour alone uses it.
 */
export const deriveMutedPalettes = (
  palettes: ColorTagPalettes
): ColorTagPalettes => {
  const out = {} as ColorTagPalettes;
  for (const key of Object.keys(palettes) as (keyof ColorTagPalettes)[]) {
    const background =
      key === 'ansi'
        ? null
        : REFERENCE_BACKGROUNDS[key as Exclude<keyof ColorTagPalettes, 'ansi'>];
    const source = palettes[key];
    const muted = {} as ColorTagPalettes['dark'];
    for (const name of Object.keys(source) as (keyof typeof source)[]) {
      muted[name] = background
        ? muteColour(source[name], background)
        : (ANSI_MUTED[source[name].trim()] ?? source[name]);
    }
    out[key] = muted;
  }
  return out;
};
