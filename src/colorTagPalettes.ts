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
