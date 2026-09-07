import { describe, expect, it } from 'vitest';

import {
  LUMINANCE_BOUNDARY,
  classifyLuminance,
  luminanceMatchesMode,
  parseHexColour,
  hueOfHex,
  relativeLuminanceOfHex,
  toHexColour,
} from '../luminance';

describe('parseHexColour', () => {
  it('accepts the three forms a provider actually returns', () => {
    expect(parseHexColour('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColour('#1A2B3C')).toEqual({ r: 26, g: 43, b: 60 });
    // Alpha is parsed off and ignored: honouring it would darken every measurement.
    expect(parseHexColour('#1a2b3c80')).toEqual({ r: 26, g: 43, b: 60 });
  });

  it('returns null rather than a wrong colour', () => {
    for (const bad of ['', 'fff', '#ff', '#gggggg', 'rgb(1,2,3)', '#12345']) {
      expect(parseHexColour(bad), bad).toBeNull();
    }
  });
});

describe('relativeLuminanceOfHex', () => {
  it('anchors on the two colours whose luminance is defined to be exact', () => {
    expect(relativeLuminanceOfHex('#000000')).toBe(0);
    expect(relativeLuminanceOfHex('#ffffff')).toBe(1);
  });

  it('weights green far above blue, as the sRGB coefficients require', () => {
    const green = relativeLuminanceOfHex('#00ff00') ?? 0;
    const red = relativeLuminanceOfHex('#ff0000') ?? 0;
    const blue = relativeLuminanceOfHex('#0000ff') ?? 0;
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(green).toBeCloseTo(0.7152, 4);
    expect(blue).toBeCloseTo(0.0722, 4);
  });
});

describe('classifyLuminance', () => {
  it('calls a mid-grey light, which is the whole reason the boundary is not 0.5', () => {
    // #808080 has a relative luminance of ~0.216 — BELOW the 0.5 midpoint of the scale, and yet
    // it is plainly a light-ish ground that white text struggles on. The boundary sits at 0.32 so
    // that the classification tracks what a scrim can rescue, not where the number happens to fall.
    const grey = relativeLuminanceOfHex('#808080') ?? 0;
    expect(grey).toBeLessThan(0.5);
    expect(grey).toBeLessThan(LUMINANCE_BOUNDARY);
    expect(classifyLuminance('#808080')).toBe('dark');

    // A genuinely light ground.
    expect(classifyLuminance('#e8e2d8')).toBe('light');
    expect(classifyLuminance('#0f0e17')).toBe('dark');
  });

  it('is null for anything unmeasurable, and never guesses light', () => {
    expect(classifyLuminance(null)).toBeNull();
    expect(classifyLuminance(undefined)).toBeNull();
    expect(classifyLuminance('not a colour')).toBeNull();
  });
});

describe('luminanceMatchesMode', () => {
  it('pairs dark footage with dark sites and light with light', () => {
    expect(luminanceMatchesMode('dark', 'dark')).toBe(true);
    expect(luminanceMatchesMode('light', 'light')).toBe(true);
    expect(luminanceMatchesMode('light', 'dark')).toBe(false);
    expect(luminanceMatchesMode('dark', 'light')).toBe(false);
  });

  it('permits unknown, because no header is worse than a hard-working scrim', () => {
    expect(luminanceMatchesMode(null, 'dark')).toBe(true);
    expect(luminanceMatchesMode(null, 'light')).toBe(true);
  });
});

describe('hueOfHex', () => {
  it('reads the primaries off the wheel', () => {
    expect(hueOfHex('#ff0000')).toBe(0);
    expect(hueOfHex('#00ff00')).toBe(120);
    expect(hueOfHex('#0000ff')).toBe(240);
    expect(hueOfHex('#ffff00')).toBe(60);
  });

  it('refuses a hue for near-grey, where the angle is rounding noise', () => {
    expect(hueOfHex('#808080')).toBeNull();
    expect(hueOfHex('#000000')).toBeNull();
    expect(hueOfHex('#ffffff')).toBeNull();
    // A tint too faint to read as a colour.
    expect(hueOfHex('#807f7f')).toBeNull();
  });

  it('round-trips through toHexColour', () => {
    expect(toHexColour(156, 107, 64)).toBe('#9c6b40');
    expect(hueOfHex(toHexColour(156, 107, 64))).toBe(28);
    expect(toHexColour(-5, 300, 64)).toBe('#00ff40');
  });
});
