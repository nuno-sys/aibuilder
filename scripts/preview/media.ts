import { deflateSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColorMode, DnaId } from '@aibuilder/site-schema';
import { DNA, hexOf, resolveTheme } from '@aibuilder/site-kit';
import { INDUSTRIES, MEDIA_LIBRARY, selectHeroVideo } from '@aibuilder/core';
import type { LibraryVideo, MediaGroupKey } from '@aibuilder/core';
import type { DemoMedia, DemoSite } from './demo-sites';
import { DEMO_SITES } from './demo-sites';

/**
 * The placeholder imagery, synthesised.
 *
 * WHY SYNTHESISE ANYTHING. The real hero binaries are deliberately not in this repository — the
 * header of `apps/marketing/src/content/hero-media.ts` says so and gives the encoder invocations
 * that produce them — and the tenant media pipeline only exists at publish time. A preview
 * therefore has to draw its own pictures, and the two easy answers are both wrong: a grey box
 * makes every archetype look identical, and a stock photograph makes the preview look like a
 * finished site that ships with photography it does not have.
 *
 * So each asset is an SVG composition built from THAT ARCHETYPE'S OWN RESOLVED TOKENS: the same
 * `resolveTheme()` the renderer calls, the same accent, the same neutral ladder, plus the DNA's
 * `support` hue for a second colour. The geometry differs per archetype for the same reason the
 * CSS does — beams and glow for `midnight_neon`, arcs and hairlines for `warm_trattoria`, calm
 * rounded fields for `clinical_trust`, hazard stripes and plate edges for `garage_steel`.
 *
 * Every image carries a small `PLACEHOLDER` label in a corner. That is not decoration: an
 * unlabelled synthetic image in a screenshot is indistinguishable from a shipped asset, and
 * somebody will eventually put that screenshot in a deck.
 *
 * The favicons are real PNGs, encoded here (deflate + CRC-32, ~60 lines below), because a `<link
 * rel="icon" sizes="32x32">` pointing at an SVG served from a `.png` URL is the kind of small lie
 * that makes a preview stop being evidence.
 */

/* ── Where things live ──────────────────────────────────────────────────── */

/**
 * Where this harness and the repository live.
 *
 * `run.mjs` bundles each entry point into `scripts/preview/dist/`, so `import.meta.url` in the
 * *bundle* points one directory deeper than the source. The runner therefore exports both paths;
 * the fallback keeps the modules correct when they are executed from source instead.
 */
const HERE = process.env['PREVIEW_HARNESS_DIR'] ?? path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env['PREVIEW_REPO_ROOT'] ?? path.resolve(HERE, '..', '..');

/** The harness's output directory. Ignored by git; see the root `.gitignore`. */
export const OUTPUT_DIR = path.join(ROOT, '.preview');

/** Assets every demo site shares a URL space with. Served by `serve.ts` under every site. */
export const SHARED_DIR = path.join(OUTPUT_DIR, '_shared');

/** URL prefix for images. Production uses `/_a/…`; the split keeps fonts and images apart here. */
export const IMAGE_BASE = '/_m';

/** `RenderContext.assetBase`. In `site-kit` this prefixes the `@font-face` URLs and nothing else. */
export const ASSET_BASE = '/_a/f';

/** One synthesised file: what to serve, and with which content type. */
export interface PreviewAsset {
  readonly contentType: string;
  readonly body: Buffer;
}

/* ── Palette, straight out of the theme resolver ────────────────────────── */

interface Palette {
  readonly bg: string;
  readonly bgAlt: string;
  readonly surface: string;
  readonly surface2: string;
  readonly fg: string;
  readonly fgMuted: string;
  readonly border: string;
  readonly accent: string;
  readonly accentEdge: string;
  readonly accentSubtle: string;
  readonly onAccent: string;
  readonly support: string;
  readonly mode: ColorMode;
}

/** `hexOf`, but never fatal: an unparseable token falls back rather than failing the whole run. */
function hex(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  try {
    return hexOf(value);
  } catch {
    return fallback;
  }
}

/**
 * The archetype's palette as hex.
 *
 * `support` is not in the resolved token set — `paletteVariant: 'alt'` is how a document reaches
 * it — so it is rebuilt from the DNA's own `AccentSpec` at this ground's lightness. That keeps the
 * second colour of every composition a colour the design system actually owns.
 */
function paletteOf(dnaId: DnaId, mode: ColorMode): Palette {
  const tokens = resolveTheme({
    dnaId,
    paletteVariant: 'default',
    accentHueShift: '0',
    typeScaleId: 'regular',
    radiusId: 'soft',
    densityId: 'regular',
    motionId: 'none',
    colorMode: mode,
  });
  const support = DNA[dnaId].support;
  const supportOklch = `oklch(${String(support.lightness[mode])} ${String(support.chroma)} ${String(support.hue)})`;
  return {
    bg: hex(tokens['--color-bg'], '#101010'),
    bgAlt: hex(tokens['--color-bg-alt'], '#181818'),
    surface: hex(tokens['--color-surface'], '#202020'),
    surface2: hex(tokens['--color-surface-2'], '#282828'),
    fg: hex(tokens['--color-fg'], '#f0f0f0'),
    fgMuted: hex(tokens['--color-fg-muted'], '#9a9a9a'),
    border: hex(tokens['--color-border'], '#3a3a3a'),
    accent: hex(tokens['--color-accent'], '#7f5af0'),
    accentEdge: hex(tokens['--color-accent-edge'], '#7f5af0'),
    accentSubtle: hex(tokens['--color-accent-subtle'], '#2a2440'),
    onAccent: hex(tokens['--color-fg-on-accent'], '#ffffff'),
    support: hex(supportOklch, '#4a90d9'),
    mode,
  };
}

/** The colour mode each demo document asks for. Read back off the document, never assumed. */
function modeOf(site: DemoSite): ColorMode {
  return site.doc.theme.colorMode;
}

/* ── Deterministic noise ────────────────────────────────────────────────── */

/** mulberry32. Same asset id, same picture, every run — so screenshots diff cleanly. */
function rngFor(seed: string): () => number {
  let state = 0x9e3779b9;
  for (const character of seed) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 0x85ebca6b) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rounds to two decimals so the emitted SVG stays small and byte-stable. */
function n(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/* ── The four archetype compositions ────────────────────────────────────── */

/** What a composition is given: a box, the archetype's palette, and its own seeded noise. */
interface Canvas {
  readonly width: number;
  readonly height: number;
  readonly palette: Palette;
  readonly random: () => number;
}

/**
 * Which motif a given asset gets.
 *
 * Three per archetype, chosen from the asset's own seed. Without this every gallery would be four
 * copies of one picture with the shapes nudged a few pixels, which reads as a placeholder grid
 * rather than as a set of photographs — and a photo grid is exactly what these sections are for.
 * The palette, the ground and the mark-making stay the archetype's; only the arrangement moves.
 */
function motifOf(random: () => number): 0 | 1 | 2 {
  const value = Math.floor(random() * 3);
  return value === 1 ? 1 : value === 2 ? 2 : 0;
}

/** A lit room after dark: glow, beams, rings, a horizon. */
function midnightNeon(canvas: Canvas): string {
  const { width: w, height: h, palette: p, random } = canvas;
  const radius = Math.min(w, h);
  const motif = motifOf(random);
  const parts: string[] = [
    `<rect width="${n(w)}" height="${n(h)}" fill="url(#ground)"/>`,
    `<ellipse cx="${n(w * (0.24 + random() * 0.2))}" cy="${n(h * (0.28 + random() * 0.16))}" rx="${n(w * 0.42)}" ry="${n(h * 0.4)}" fill="${p.accent}" opacity="0.5" filter="url(#soft)"/>`,
    `<ellipse cx="${n(w * (0.66 + random() * 0.2))}" cy="${n(h * (0.6 + random() * 0.18))}" rx="${n(w * 0.3)}" ry="${n(h * 0.34)}" fill="${p.support}" opacity="0.38" filter="url(#soft)"/>`,
  ];

  if (motif === 0) {
    // Light beams from the rig.
    for (let index = 0; index < 5; index += 1) {
      const x = w * (0.08 + (index + random() * 0.6) / 6);
      const top = w * (0.012 + random() * 0.02);
      const spread = top * (3 + random() * 3);
      parts.push(
        `<path d="M ${n(x)} 0 L ${n(x + top)} 0 L ${n(x + spread)} ${n(h)} L ${n(x - spread * 0.4)} ${n(h)} Z" fill="url(#beam)" opacity="${n(0.16 + random() * 0.2)}"/>`,
      );
    }
    const horizon = h * (0.68 + random() * 0.1);
    parts.push(
      `<rect x="0" y="${n(horizon)}" width="${n(w)}" height="${n(h * 0.012)}" fill="${p.accentEdge}" opacity="0.55"/>`,
      `<circle cx="${n(w * 0.5)}" cy="${n(horizon)}" r="${n(radius * 0.055)}" fill="none" stroke="${p.accent}" stroke-width="${n(radius * 0.006)}" opacity="0.9"/>`,
    );
  } else if (motif === 1) {
    // Concentric rings, like a lens or a speaker cone seen head on.
    const cx = w * (0.4 + random() * 0.2);
    const cy = h * (0.42 + random() * 0.16);
    for (let index = 0; index < 6; index += 1) {
      parts.push(
        `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(radius * (0.08 + index * 0.075))}" fill="none" stroke="${index % 2 === 0 ? p.accent : p.support}" stroke-width="${n(radius * (0.012 - index * 0.0012))}" opacity="${n(0.9 - index * 0.11)}"/>`,
      );
    }
    parts.push(
      `<rect x="0" y="${n(h * 0.86)}" width="${n(w)}" height="${n(h * 0.02)}" fill="${p.accentEdge}" opacity="0.45"/>`,
    );
  } else {
    // A hard diagonal split with scattered lights above it.
    parts.push(
      `<path d="M 0 ${n(h)} L ${n(w)} ${n(h * 0.34)} L ${n(w)} ${n(h)} Z" fill="${p.bgAlt}" opacity="0.9"/>`,
      `<path d="M 0 ${n(h)} L ${n(w)} ${n(h * 0.34)}" stroke="${p.accent}" stroke-width="${n(radius * 0.008)}" opacity="0.8"/>`,
    );
    for (let index = 0; index < 9; index += 1) {
      parts.push(
        `<circle cx="${n(w * random())}" cy="${n(h * random() * 0.7)}" r="${n(radius * (0.008 + random() * 0.03))}" fill="${index % 3 === 0 ? p.support : p.accent}" opacity="${n(0.25 + random() * 0.5)}"/>`,
      );
    }
  }

  const defs = [
    `<linearGradient id="ground" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${p.bgAlt}"/><stop offset="1" stop-color="${p.bg}"/></linearGradient>`,
    `<linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.accent}" stop-opacity="0.9"/><stop offset="1" stop-color="${p.accent}" stop-opacity="0"/></linearGradient>`,
    `<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${n(radius * 0.09)}"/></filter>`,
  ];
  return svgDocument(canvas, defs, parts);
}

/** Paper, not screen: cream ground, terracotta arcs, hairlines, a printed frame. */
function warmTrattoria(canvas: Canvas): string {
  const { width: w, height: h, palette: p, random } = canvas;
  const radius = Math.min(w, h);
  const motif = motifOf(random);
  const parts: string[] = [`<rect width="${n(w)}" height="${n(h)}" fill="${p.bg}"/>`];

  if (motif === 0) {
    parts.push(
      `<circle cx="${n(w * (0.62 + random() * 0.16))}" cy="${n(h * 0.4)}" r="${n(radius * 0.42)}" fill="${p.accentSubtle}"/>`,
      `<circle cx="${n(w * 0.24)}" cy="${n(h * 0.74)}" r="${n(radius * 0.3)}" fill="${p.surface2}" opacity="0.8"/>`,
    );
    for (let index = 0; index < 4; index += 1) {
      const r = radius * (0.2 + index * 0.11);
      const cx = w * 0.34;
      const cy = h * 0.52;
      parts.push(
        `<path d="M ${n(cx - r)} ${n(cy)} A ${n(r)} ${n(r)} 0 0 1 ${n(cx + r)} ${n(cy)}" fill="none" stroke="${index % 2 === 0 ? p.accent : p.support}" stroke-width="${n(radius * (0.004 + random() * 0.006))}" opacity="${n(0.5 + index * 0.12)}" stroke-linecap="round"/>`,
      );
    }
  } else if (motif === 1) {
    // Stacked bands, like a folded menu card.
    for (let index = 0; index < 5; index += 1) {
      const y = h * (0.12 + index * 0.16);
      const inset = w * (0.06 + random() * 0.1);
      parts.push(
        `<rect x="${n(inset)}" y="${n(y)}" width="${n(w - inset * 2)}" height="${n(h * (0.03 + random() * 0.05))}" rx="${n(radius * 0.02)}" fill="${index % 2 === 0 ? p.accentSubtle : p.surface2}"/>`,
      );
    }
    parts.push(
      `<circle cx="${n(w * 0.78)}" cy="${n(h * 0.74)}" r="${n(radius * 0.16)}" fill="none" stroke="${p.accent}" stroke-width="${n(radius * 0.012)}"/>`,
    );
  } else {
    // A single large plate with a knife-edge rule.
    parts.push(
      `<circle cx="${n(w * 0.5)}" cy="${n(h * 0.48)}" r="${n(radius * 0.36)}" fill="${p.surface2}"/>`,
      `<circle cx="${n(w * 0.5)}" cy="${n(h * 0.48)}" r="${n(radius * 0.28)}" fill="none" stroke="${p.accent}" stroke-width="${n(radius * 0.01)}" opacity="0.8"/>`,
      `<circle cx="${n(w * 0.5)}" cy="${n(h * 0.48)}" r="${n(radius * 0.14)}" fill="${p.accentSubtle}"/>`,
      `<line x1="${n(w * 0.1)}" y1="${n(h * 0.86)}" x2="${n(w * 0.9)}" y2="${n(h * 0.86)}" stroke="${p.support}" stroke-width="${n(radius * 0.006)}"/>`,
    );
  }

  for (let index = 1; index <= 3; index += 1) {
    const y = h * (0.16 + index * 0.22);
    parts.push(
      `<line x1="${n(w * 0.08)}" y1="${n(y)}" x2="${n(w * 0.92)}" y2="${n(y)}" stroke="${p.border}" stroke-width="${n(Math.max(1, radius * 0.0016))}"/>`,
    );
  }
  parts.push(
    `<rect x="${n(w * 0.08)}" y="${n(h * 0.08)}" width="${n(w * 0.84)}" height="${n(h * 0.84)}" fill="none" stroke="${p.accent}" stroke-width="${n(Math.max(1, radius * 0.002))}" opacity="0.45"/>`,
  );
  return svgDocument(canvas, [], parts);
}

/** Nothing between the visitor and the information: calm fields, thin arcs, a dot grid. */
function clinicalTrust(canvas: Canvas): string {
  const { width: w, height: h, palette: p, random } = canvas;
  const radius = Math.min(w, h);
  const motif = motifOf(random);
  const parts: string[] = [`<rect width="${n(w)}" height="${n(h)}" fill="url(#ground)"/>`];

  if (motif === 0) {
    parts.push(
      `<rect x="${n(-w * 0.05)}" y="${n(h * (0.42 + random() * 0.08))}" width="${n(w * 1.1)}" height="${n(h * 0.5)}" rx="${n(radius * 0.16)}" fill="${p.accentSubtle}"/>`,
      `<rect x="${n(w * 0.52)}" y="${n(h * 0.1)}" width="${n(w * 0.42)}" height="${n(h * 0.5)}" rx="${n(radius * 0.12)}" fill="${p.surface2}"/>`,
    );
    for (let index = 0; index < 3; index += 1) {
      parts.push(
        `<circle cx="${n(w * 0.3)}" cy="${n(h * 0.38)}" r="${n(radius * (0.26 + index * 0.1))}" fill="none" stroke="${index === 1 ? p.support : p.accent}" stroke-width="${n(radius * 0.005)}" opacity="${n(0.35 + index * 0.2)}"/>`,
      );
    }
  } else if (motif === 1) {
    // Rounded columns of different heights: calm, orderly, nothing shouting.
    for (let index = 0; index < 5; index += 1) {
      const columnWidth = w * 0.12;
      const x = w * (0.09 + index * 0.18);
      const height = h * (0.3 + random() * 0.45);
      parts.push(
        `<rect x="${n(x)}" y="${n(h * 0.85 - height)}" width="${n(columnWidth)}" height="${n(height)}" rx="${n(columnWidth / 2)}" fill="${index % 2 === 0 ? p.accentSubtle : p.surface2}"/>`,
      );
    }
    parts.push(
      `<line x1="0" y1="${n(h * 0.85)}" x2="${n(w)}" y2="${n(h * 0.85)}" stroke="${p.accent}" stroke-width="${n(radius * 0.006)}" opacity="0.7"/>`,
    );
  } else {
    // One soft field and a pair of crossing guides.
    parts.push(
      `<circle cx="${n(w * (0.4 + random() * 0.2))}" cy="${n(h * 0.5)}" r="${n(radius * 0.44)}" fill="${p.accentSubtle}"/>`,
      `<line x1="0" y1="${n(h * 0.3)}" x2="${n(w)}" y2="${n(h * 0.36)}" stroke="${p.support}" stroke-width="${n(radius * 0.004)}" opacity="0.6"/>`,
      `<line x1="0" y1="${n(h * 0.72)}" x2="${n(w)}" y2="${n(h * 0.66)}" stroke="${p.accent}" stroke-width="${n(radius * 0.004)}" opacity="0.6"/>`,
      `<circle cx="${n(w * 0.5)}" cy="${n(h * 0.5)}" r="${n(radius * 0.06)}" fill="${p.accent}" opacity="0.75"/>`,
    );
  }

  const step = radius * 0.055;
  const dots: string[] = [];
  for (let x = w * 0.08; x < w * 0.5; x += step) {
    for (let y = h * 0.68; y < h * 0.92; y += step) {
      dots.push(`M ${n(x)} ${n(y)} h 0.01`);
    }
  }
  parts.push(
    `<path d="${dots.join(' ')}" stroke="${p.accent}" stroke-width="${n(radius * 0.008)}" stroke-linecap="round" opacity="0.3"/>`,
  );
  const defs = [
    `<linearGradient id="ground" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${p.surface}"/><stop offset="1" stop-color="${p.bgAlt}"/></linearGradient>`,
  ];
  return svgDocument(canvas, defs, parts);
}

/** A phone number you can hit with a gloved thumb: steel plate, hazard stripes, bolts. */
function garageSteel(canvas: Canvas): string {
  const { width: w, height: h, palette: p, random } = canvas;
  const radius = Math.min(w, h);
  const motif = motifOf(random);
  const parts: string[] = [`<rect width="${n(w)}" height="${n(h)}" fill="url(#steel)"/>`];

  if (motif === 0) {
    const bandY = h * (0.54 + random() * 0.08);
    parts.push(
      `<rect x="0" y="${n(h * 0.18)}" width="${n(w)}" height="${n(h * 0.22)}" fill="${p.surface2}" opacity="0.85"/>`,
      `<rect x="0" y="${n(bandY)}" width="${n(w)}" height="${n(h * 0.13)}" fill="url(#hazard)"/>`,
      `<rect x="0" y="${n(bandY - h * 0.008)}" width="${n(w)}" height="${n(h * 0.008)}" fill="${p.fg}" opacity="0.75"/>`,
      `<rect x="${n(w * 0.06)}" y="${n(h * 0.72)}" width="${n(w * 0.34)}" height="${n(h * 0.06)}" fill="${p.accent}"/>`,
      `<rect x="${n(w * 0.06)}" y="${n(h * 0.82)}" width="${n(w * 0.2)}" height="${n(h * 0.035)}" fill="${p.support}" opacity="0.7"/>`,
    );
  } else if (motif === 1) {
    // Vertical plates, bolted.
    for (let index = 0; index < 4; index += 1) {
      const x = w * (0.04 + index * 0.24);
      parts.push(
        `<rect x="${n(x)}" y="${n(h * 0.1)}" width="${n(w * 0.2)}" height="${n(h * 0.8)}" fill="${index % 2 === 0 ? p.surface2 : p.bgAlt}" opacity="0.92"/>`,
        `<circle cx="${n(x + w * 0.1)}" cy="${n(h * 0.16)}" r="${n(radius * 0.014)}" fill="${p.fgMuted}"/>`,
        `<circle cx="${n(x + w * 0.1)}" cy="${n(h * 0.84)}" r="${n(radius * 0.014)}" fill="${p.fgMuted}"/>`,
      );
    }
    parts.push(
      `<rect x="0" y="${n(h * (0.44 + random() * 0.1))}" width="${n(w)}" height="${n(h * 0.07)}" fill="${p.accent}"/>`,
    );
  } else {
    // Chevrons, the way a floor is marked.
    const chevron = h * 0.22;
    for (let index = 0; index < 4; index += 1) {
      const y = h * 0.1 + index * chevron;
      parts.push(
        `<path d="M 0 ${n(y)} L ${n(w * 0.5)} ${n(y + chevron * 0.5)} L ${n(w)} ${n(y)}" fill="none" stroke="${index % 2 === 0 ? p.accent : p.fgMuted}" stroke-width="${n(radius * 0.022)}" opacity="${n(0.5 + index * 0.12)}"/>`,
      );
    }
    parts.push(
      `<rect x="0" y="${n(h * 0.88)}" width="${n(w)}" height="${n(h * 0.09)}" fill="url(#hazard)"/>`,
    );
  }

  for (let index = 0; index < 6; index += 1) {
    parts.push(
      `<circle cx="${n(w * (0.08 + index * 0.168))}" cy="${n(h * 0.055)}" r="${n(radius * 0.016)}" fill="none" stroke="${p.fgMuted}" stroke-width="${n(radius * 0.005)}"/>`,
    );
  }

  const stripe = radius * 0.06;
  const defs = [
    `<linearGradient id="steel" x1="0" y1="0" x2="0.2" y2="1"><stop offset="0" stop-color="${p.surface}"/><stop offset="0.55" stop-color="${p.bgAlt}"/><stop offset="1" stop-color="${p.surface2}"/></linearGradient>`,
    `<pattern id="hazard" width="${n(stripe * 2)}" height="${n(stripe * 2)}" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="${n(stripe * 2)}" height="${n(stripe * 2)}" fill="${p.accent}"/><rect width="${n(stripe)}" height="${n(stripe * 2)}" fill="${p.fg}" opacity="0.82"/></pattern>`,
  ];
  return svgDocument(canvas, defs, parts);
}

/** The static map: a street grid, a route and a pin, in the archetype's own colours. */
function mapComposition(canvas: Canvas): string {
  const { width: w, height: h, palette: p, random } = canvas;
  const parts: string[] = [`<rect width="${n(w)}" height="${n(h)}" fill="${p.bgAlt}"/>`];
  for (let index = 0; index < 7; index += 1) {
    const y = h * (0.08 + index * 0.14 + random() * 0.02);
    parts.push(
      `<line x1="0" y1="${n(y)}" x2="${n(w)}" y2="${n(y)}" stroke="${p.border}" stroke-width="${n(h * (index % 3 === 0 ? 0.016 : 0.007))}"/>`,
    );
  }
  for (let index = 0; index < 8; index += 1) {
    const x = w * (0.06 + index * 0.13 + random() * 0.02);
    parts.push(
      `<line x1="${n(x)}" y1="0" x2="${n(x)}" y2="${n(h)}" stroke="${p.border}" stroke-width="${n(h * (index % 4 === 0 ? 0.014 : 0.006))}"/>`,
    );
  }
  parts.push(
    `<rect x="${n(w * 0.1)}" y="${n(h * 0.58)}" width="${n(w * 0.26)}" height="${n(h * 0.3)}" fill="${p.surface2}" opacity="0.9"/>`,
    `<rect x="${n(w * 0.66)}" y="${n(h * 0.12)}" width="${n(w * 0.24)}" height="${n(h * 0.26)}" fill="${p.surface2}" opacity="0.9"/>`,
    `<path d="M ${n(w * 0.06)} ${n(h * 0.86)} L ${n(w * 0.4)} ${n(h * 0.62)} L ${n(w * 0.52)} ${n(h * 0.5)}" fill="none" stroke="${p.support}" stroke-width="${n(h * 0.018)}" stroke-linecap="round" stroke-dasharray="${n(h * 0.05)} ${n(h * 0.035)}"/>`,
  );
  const px = w * 0.52;
  const py = h * 0.5;
  const pin = h * 0.11;
  parts.push(
    `<path d="M ${n(px)} ${n(py + pin)} C ${n(px - pin * 0.9)} ${n(py - pin * 0.1)} ${n(px - pin * 0.75)} ${n(py - pin)} ${n(px)} ${n(py - pin)} C ${n(px + pin * 0.75)} ${n(py - pin)} ${n(px + pin * 0.9)} ${n(py - pin * 0.1)} ${n(px)} ${n(py + pin)} Z" fill="${p.accent}"/>`,
    `<circle cx="${n(px)}" cy="${n(py - pin * 0.35)}" r="${n(pin * 0.28)}" fill="${p.bg}"/>`,
  );
  return svgDocument(canvas, [], parts);
}

/** The composition function for one archetype. */
const COMPOSITIONS: Readonly<Record<DnaId, (canvas: Canvas) => string>> = {
  midnight_neon: midnightNeon,
  warm_trattoria: warmTrattoria,
  clinical_trust: clinicalTrust,
  garage_steel: garageSteel,
};

/**
 * Wraps a composition in the document, the label and (for share cards) the caption.
 *
 * The label is the honest part of this file: `PLACEHOLDER` plus the pixel size, in the muted
 * foreground of the same palette so it reads as part of the image rather than as a watermark
 * pasted on top.
 */
function svgDocument(canvas: Canvas, defs: readonly string[], body: readonly string[]): string {
  const { width: w, height: h, palette: p } = canvas;
  const size = Math.min(30, Math.max(11, Math.min(w, h) * 0.028));
  const label = `PLACEHOLDER · ${String(w)}×${String(h)}`;
  // Wide enough for the label at this size: ~0.62 em per character plus the tracking, plus padding.
  const plate = Math.min(w * 0.92, label.length * size * 0.78 + size * 1.6);
  // No quoted family names: this string goes into an XML attribute, and a `"` inside a
  // double-quoted attribute makes the whole SVG unparseable — which renders as a broken image,
  // not as an error. `shoot.ts` now fails the run on broken images for exactly this reason.
  const font = 'ui-sans-serif, system-ui, sans-serif';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${String(w)}" height="${String(h)}" role="img">`,
    defs.length === 0 ? '' : `<defs>${defs.join('')}</defs>`,
    body.join(''),
    // Centred, and a little up from the edge. Every one of these images is rendered with
    // `object-fit: cover`, which crops the sides of a wide box and the top and bottom of a tall
    // one; a corner label is the one position that a crop reliably eats. The horizontal centre
    // always survives, because `object-position` is 50% 50%.
    //
    // The plate behind it is not decoration either: the label has to stay readable over a hazard
    // stripe, a neon glow and a cream ground alike, and a label nobody can read is the same as no
    // label at all.
    `<rect x="${n(w / 2 - plate / 2)}" y="${n(h * 0.94 - size * 1.15)}" width="${n(plate)}" height="${n(size * 1.6)}" rx="${n(size * 0.3)}" fill="${p.bg}" opacity="0.55"/>`,
    `<text x="${n(w / 2)}" y="${n(h * 0.94)}" text-anchor="middle" font-family="${font}" font-size="${n(size)}" letter-spacing="${n(size * 0.16)}" fill="${p.fg}" opacity="0.75">${label}</text>`,
    '</svg>',
  ].join('');
}

/** The share card: the archetype composition plus the site's name, so the crop is judgeable. */
function ogComposition(canvas: Canvas, site: DemoSite): string {
  const base = COMPOSITIONS[site.archetype](canvas);
  const { width: w, height: h, palette: p } = canvas;
  // No quoted family names: this string goes into an XML attribute, and a `"` inside a
  // double-quoted attribute makes the whole SVG unparseable — which renders as a broken image,
  // not as an error. `shoot.ts` now fails the run on broken images for exactly this reason.
  const font = 'ui-sans-serif, system-ui, sans-serif';
  const caption = [
    `<rect x="0" y="${n(h * 0.62)}" width="${n(w)}" height="${n(h * 0.38)}" fill="${p.bg}" opacity="0.82"/>`,
    `<text x="${n(w * 0.06)}" y="${n(h * 0.79)}" font-family="${font}" font-size="${n(h * 0.11)}" font-weight="700" fill="${p.fg}">${escapeXml(site.label)}</text>`,
    `<text x="${n(w * 0.06)}" y="${n(h * 0.9)}" font-family="${font}" font-size="${n(h * 0.05)}" fill="${p.fgMuted}">Demonstratiesite · placeholderbeeld</text>`,
  ].join('');
  return base.replace('</svg>', `${caption}</svg>`);
}

/** The five characters that must not appear raw in XML text. */
function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/** The scalable favicon: the accent ground with the archetype's mark. */
function iconSvg(palette: Palette): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    `<rect width="64" height="64" rx="12" fill="${palette.accent}"/>`,
    `<circle cx="32" cy="32" r="15" fill="none" stroke="${palette.onAccent}" stroke-width="6"/>`,
    `<rect x="29" y="8" width="6" height="18" fill="${palette.onAccent}"/>`,
    '</svg>',
  ].join('');
}

/* ── A very small PNG encoder ───────────────────────────────────────────── */

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** RGBA8, non-interlaced, one filter byte per row. Enough for a favicon and nothing more. */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function rgbOf(hexColor: string): readonly [number, number, number] {
  const value = hexColor.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/** The raster favicon: the same mark as `iconSvg`, drawn a pixel at a time. */
function iconPng(palette: Palette, size: number): Buffer {
  const [ar, ag, ab] = rgbOf(palette.accent);
  const [fr, fg, fb] = rgbOf(palette.onAccent);
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const ringOuter = size * 0.47;
  const ringInner = size * 0.32;
  const stemHalf = size * 0.05;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - centre;
      const dy = y - centre;
      const distance = Math.hypot(dx, dy);
      const onRing = distance <= ringOuter && distance >= ringInner;
      const onStem = Math.abs(dx) <= stemHalf && y <= centre && distance <= ringOuter;
      const [r, g, b] = onRing || onStem ? [fr, fg, fb] : [ar, ag, ab];
      const offset = (y * size + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  return encodePng(size, size, pixels);
}

/* ── Fonts ──────────────────────────────────────────────────────────────── */

/** The four families the archetypes ask for, by `FontSpec.asset`. */
const FONT_ASSETS = ['inter', 'space-grotesk', 'playfair-display', 'archivo'] as const;

/** `site-kit` emits one face per family per subset. Both are the same file for a variable font. */
const FONT_SUBSETS = ['latin', 'latin-ext'] as const;

/**
 * Fontsource splits a variable font into one file per axis set, and the order here matters.
 *
 * `standard` carries every standard axis at once — for Archivo that is `wght` **and** `wdth`,
 * which `garage_steel` needs: its DNA sets `--font-display-wdth: 78`, and a weight-only file would
 * silently ignore it and render the condensed industrial headings at normal width. `wght` is the
 * fallback for the families that ship only that axis (Space Grotesk, Playfair Display).
 */
const AXIS_CANDIDATES = ['standard', 'full', 'wght', 'opsz'] as const;

/** Where a font file actually is on disk, or `null` when the package is not installed. */
function fontSourceFile(asset: string, subset: string): string | null {
  const base = path.join(HERE, 'node_modules', '@fontsource-variable', asset, 'files');
  for (const axis of AXIS_CANDIDATES) {
    const candidate = path.join(base, `${asset}-${subset}-${axis}-normal.woff2`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** What `writeAssets` found, so the run can report on it rather than silently degrading. */
export interface FontReport {
  readonly asset: string;
  readonly subset: string;
  readonly source: string | null;
}

/* ── The asset table ────────────────────────────────────────────────────── */

/** URL path of one media asset. Absolute, because that is what a published page emits. */
export function imageUrl(site: DemoSite, refId: string): string {
  return `${IMAGE_BASE}/${site.key}/${refId}.svg`;
}

/** Where the ingest wrote the library binaries. Served under `/_lib`. */
export const LIBRARY_DIR = path.join(ROOT, '.media-library', 'out');

/** URL base for a library object. A manifest key is the path under this. */
export const LIBRARY_BASE = '/_lib';

/** URL path of one library object, from the key the catalogue names. */
export function libraryUrl(key: string): string {
  return `${LIBRARY_BASE}/${key}`;
}

/**
 * The hero clip for one demo site, chosen the way the builder chooses it.
 *
 * Deliberately runs the REAL selector against the REAL catalogue rather than handing each demo a
 * clip picked by hand. A preview whose media the harness assigned proves the harness works;
 * running the selector proves the PRODUCT works — that luminance actually tracks the theme, and
 * that two sites in one group do not land on the same clip.
 *
 * `null` when the library is empty or cannot dress this combination. The header is then a
 * full-screen poster, which is exactly what production does.
 *
 * ALSO NULL WHEN THE BINARIES ARE NOT ON DISK. The catalogue is committed and the binaries are not
 * — `.media-library/` is git-ignored — so a fresh clone that has not run `pnpm media:ingest` has
 * every key and none of the bytes. Selecting anyway would emit a portrait `<source>` whose srcset
 * 404s, and a `<picture>` does not fall through to the next source when the matched one fails: the
 * phone would get a broken image rather than a poster. Checking the directory keeps the harness
 * honest on a machine that has never run the ingest.
 */
export function selectDemoHero(site: DemoSite): LibraryVideo | null {
  if (!existsSync(LIBRARY_DIR)) return null;
  const industry = INDUSTRIES.find((entry) => entry.key === site.doc.facts.industryKey);
  if (industry === undefined) return null;
  const dna = DNA[site.archetype];
  return selectHeroVideo(MEDIA_LIBRARY, {
    group: industry.groupKey as MediaGroupKey,
    colorMode: dna.canonicalMode,
    accentHue: dna.accent.hue,
    seed: site.key,
  });
}

/** URL path of one of a site's icons. */
export function iconUrl(site: DemoSite, file: string): string {
  return `${IMAGE_BASE}/${site.key}/${file}`;
}

/** Renders one planned asset. */
function renderMedia(site: DemoSite, asset: DemoMedia, palette: Palette): string {
  const canvas: Canvas = {
    width: asset.width,
    height: asset.height,
    palette,
    random: rngFor(`${site.key}:${asset.refId}`),
  };
  if (asset.kind === 'map') return mapComposition(canvas);
  if (asset.kind === 'og') return ogComposition(canvas, site);
  return COMPOSITIONS[site.archetype](canvas);
}

/**
 * Every file the rendered pages can ask for, keyed by URL path.
 *
 * One table serves both consumers: `render.ts` writes it to disk so the output directory stands on
 * its own, and `serve.ts` answers from it directly so a media change needs no re-render.
 */
export function buildAssetTable(
  sites: readonly DemoSite[] = DEMO_SITES,
): Map<string, PreviewAsset> {
  const table = new Map<string, PreviewAsset>();
  for (const site of sites) {
    const palette = paletteOf(site.archetype, modeOf(site));
    for (const asset of site.media) {
      table.set(imageUrl(site, asset.refId), {
        contentType: 'image/svg+xml; charset=utf-8',
        body: Buffer.from(renderMedia(site, asset, palette), 'utf8'),
      });
    }
    table.set(iconUrl(site, 'icon.svg'), {
      contentType: 'image/svg+xml; charset=utf-8',
      body: Buffer.from(iconSvg(palette), 'utf8'),
    });
    table.set(iconUrl(site, 'icon-32.png'), {
      contentType: 'image/png',
      body: iconPng(palette, 32),
    });
    table.set(iconUrl(site, 'icon-180.png'), {
      contentType: 'image/png',
      body: iconPng(palette, 180),
    });
  }
  return table;
}

/** The font files, as a table keyed by the URL `site-kit`'s `@font-face` block asks for. */
export function buildFontTable(): { table: Map<string, string>; report: FontReport[] } {
  const table = new Map<string, string>();
  const report: FontReport[] = [];
  for (const asset of FONT_ASSETS) {
    for (const subset of FONT_SUBSETS) {
      const source = fontSourceFile(asset, subset);
      report.push({ asset, subset, source });
      if (source !== null) table.set(`${ASSET_BASE}/${asset}-${subset}.woff2`, source);
    }
  }
  return { table, report };
}

/** Writes one file, creating its directory. `urlPath` is rooted at `SHARED_DIR`. */
function writeUnder(directory: string, urlPath: string, body: Buffer): string {
  const target = path.join(directory, urlPath.replace(/^\//u, ''));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

/** Writes every synthesised asset and every available font into `SHARED_DIR`. */
export function writeAssets(sites: readonly DemoSite[] = DEMO_SITES): {
  readonly files: number;
  readonly bytes: number;
  readonly fonts: readonly FontReport[];
} {
  const table = buildAssetTable(sites);
  let bytes = 0;
  for (const [urlPath, asset] of table) {
    writeUnder(SHARED_DIR, urlPath, asset.body);
    bytes += asset.body.byteLength;
  }
  const { table: fonts, report } = buildFontTable();
  for (const [urlPath, source] of fonts) {
    const target = path.join(SHARED_DIR, urlPath.replace(/^\//u, ''));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return { files: table.size + fonts.size, bytes, fonts: report };
}

/** `node run.mjs media` — write the imagery on its own, without re-rendering the HTML. */
export function main(): void {
  const result = writeAssets();
  const missing = result.fonts.filter((entry) => entry.source === null);
  console.log(
    `media: ${String(result.files)} files into ${path.relative(ROOT, SHARED_DIR)} (${String(Math.round(result.bytes / 1024))} kB of SVG/PNG)`,
  );
  if (missing.length > 0) {
    console.log(
      `media: ${String(missing.length)} font file(s) not installed — ${missing
        .map((entry) => `${entry.asset}-${entry.subset}`)
        .join(', ')}. Run \`npm install\` in scripts/preview for the real faces; ` +
        'without them the pages fall back to the metric-matched local stack.',
    );
  }
}
