import type { IconId } from '@aibuilder/site-schema';

/**
 * The 12 icon paths, keyed by the `IconId` the model picks.
 *
 * A closed set is the whole design: the model chooses an *id*, code owns the geometry, and no model
 * string ever reaches an `<svg>` (invariant 1). There is no icon font, no `<img>`, no sprite sheet
 * and no runtime fetch — every icon is inlined with `currentColor`, so it costs zero requests, never
 * flashes, and inherits the tone it is rendered inside.
 *
 * All 12 are drawn on a 24×24 grid with a 2 px stroke, `stroke-linecap: round`, so a single set of
 * presentation attributes on the `<svg>` covers every one of them.
 */
export const ICON_PATHS: Readonly<Record<IconId, string>> = {
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3.5 2',
  shield: 'M12 3 4.5 6v5.5c0 4.5 3.1 7.9 7.5 9.5 4.4-1.6 7.5-5 7.5-9.5V6L12 3Z',
  star: 'm12 3.5 2.7 5.5 6 .9-4.35 4.24 1.03 6-5.38-2.83L6.62 20.1l1.03-6L3.3 9.9l6-.9L12 3.5Z',
  leaf: 'M20 4c0 9-5 13-12 13H5c0-9 5-13 12-13h3ZM5 21c0-4 2.5-7.5 7-10',
  truck: 'M3 6h11v11H3V6Zm11 4h4l3 3.5V17h-7M7.5 17a2 2 0 1 0 0 .01M17.5 17a2 2 0 1 0 0 .01',
  heart: 'M12 20.5 4.6 13a4.7 4.7 0 0 1 6.6-6.7l.8.8.8-.8A4.7 4.7 0 0 1 19.4 13L12 20.5Z',
  wrench:
    'M15.5 3a5.5 5.5 0 0 0-5 7.7L3.5 17.6 6.4 20.5l6.9-7a5.5 5.5 0 0 0 6.9-7.3L17 9l-2.5-.5L14 6l3.2-3.2A5.5 5.5 0 0 0 15.5 3Z',
  scissors:
    'M7 4l10 13M17 4 7 17M6.5 17a2.5 2.5 0 1 0 0 .01M6.5 4a2.5 2.5 0 1 0 0 .01M17.5 17a2.5 2.5 0 1 0 0 .01',
  cup: 'M5 4h11v8a5.5 5.5 0 0 1-11 0V4Zm11 2h2.5a2.5 2.5 0 0 1 0 5H16M4 21h13',
  sparkle:
    'M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5ZM18.5 16l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z',
  euro: 'M18 6.5A6.5 6.5 0 0 0 7.5 12 6.5 6.5 0 0 0 18 17.5M4.5 10.5h7M4.5 13.5h7',
  phone:
    'M6 3h3.5l1.8 4.3-2.2 1.6a12 12 0 0 0 5.5 5.5l1.6-2.2 4.3 1.8V18a3 3 0 0 1-3 3A15.5 15.5 0 0 1 3 6a3 3 0 0 1 3-3Z',
};
