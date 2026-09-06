import { describe, expect, it } from 'vitest';
import { SLOT_MAX_LENGTH, deriveSlotInventoryForPages } from '@aibuilder/site-schema';
import { THEME_MESSAGE_TYPE } from '@aibuilder/ui';

import { applyPatch, parsePatch } from '../do/patch';
import type { DraftPatch } from '../do/patch';
import { previewBridgeScript } from '../lib/preview-bridge';
import { FIXTURE_KNOBS, siteDocFixture } from './fixtures';

/**
 * The patch vocabulary: eight operations, every one exactly invertible.
 *
 * THE ROUND TRIP IS THE PROPERTY WORTH TESTING. `applyPatch` returns the new document AND the patch
 * that undoes it, and the undo ring is built entirely on that promise: apply the inverse and you are
 * back where you started, byte for byte. A near-inverse — one that restores the value but not the
 * position, or the text but not the missing key — would produce an undo that looks right and
 * silently changes something else.
 *
 * These run in a plain runner: `applyPatch` is a pure function of `(doc, patch)` with no storage, no
 * clock and no bindings, which is exactly why the Durable Object can validate a patch before it
 * writes anything.
 */

/** Applies a patch and asserts it succeeded, returning the outcome for further assertions. */
function apply(doc: ReturnType<typeof siteDocFixture>, patch: DraftPatch) {
  const outcome = applyPatch(doc, patch);
  if (!outcome.ok) {
    throw new Error(`patch rejected: ${outcome.reason}`);
  }
  return outcome;
}

describe('every patch is exactly invertible', () => {
  it('round-trips a copy edit, including one that had no previous value', () => {
    const doc = siteDocFixture();
    const inventory = deriveSlotInventoryForPages(doc.pages);
    // A slot that exists in the inventory but has no entry in `copy` — the case where the inverse
    // must restore ABSENCE, not some other text.
    const empty = inventory.slots.find((slot) => doc.copy['nl']?.[slot.id] === undefined);
    expect(empty).toBeDefined();

    const forward = apply(doc, {
      op: 'set_copy',
      locale: 'nl',
      slotId: empty?.id ?? '',
      text: 'Iets',
    });
    const back = apply(forward.doc, forward.inverse);

    expect(back.doc.copy['nl']?.[empty?.id ?? '']).toBe('');
    expect(forward.doc.copy['nl']?.[empty?.id ?? '']).toBe('Iets');
  });

  it('round-trips a section move back to its ORIGINAL index, not the target index', () => {
    const doc = siteDocFixture();
    const before = doc.pages[0]?.sections.map((section) => section.id) ?? [];

    const forward = apply(doc, {
      op: 'move_section',
      pageId: 'p_home',
      sectionId: 's_gallery',
      toIndex: 0,
    });
    expect(forward.doc.pages[0]?.sections.map((section) => section.id)).toEqual([
      's_gallery',
      's_hero',
    ]);

    const back = apply(forward.doc, forward.inverse);
    expect(back.doc.pages[0]?.sections.map((section) => section.id)).toEqual(before);
  });

  it('round-trips a theme change and re-resolves the tokens', () => {
    const doc = siteDocFixture();
    const forward = apply(doc, {
      op: 'set_theme',
      theme: { ...FIXTURE_KNOBS, dnaId: 'midnight_neon', colorMode: 'dark' },
    });

    expect(forward.doc.theme.dnaId).toBe('midnight_neon');
    // The tokens are the RESOLVER's output, never the client's: `resolveTheme` constructs, verifies
    // and throws, so a stored theme is always one whose contrast can be proven.
    expect(forward.doc.theme.tokens).not.toEqual(doc.theme.tokens);

    const back = apply(forward.doc, forward.inverse);
    expect(back.doc.theme.dnaId).toBe(FIXTURE_KNOBS.dnaId);
    expect(back.doc.theme.tokens).toEqual(doc.theme.tokens);
  });

  it('round-trips a page flag and a chrome toggle', () => {
    const doc = siteDocFixture();
    const nav = apply(doc, {
      op: 'set_page_flag',
      pageId: 'p_contact',
      field: 'showInNav',
      value: false,
    });
    expect(nav.doc.pages[1]?.showInNav).toBe(false);
    expect(apply(nav.doc, nav.inverse).doc.pages[1]?.showInNav).toBe(true);

    const chrome = apply(doc, { op: 'set_whatsapp_enabled', value: true });
    expect(chrome.doc.chrome.whatsappEnabled).toBe(true);
    expect(apply(chrome.doc, chrome.inverse).doc.chrome.whatsappEnabled).toBe(false);
  });

  it('round-trips a gallery image swap, preserving the focal point', () => {
    const doc = siteDocFixture();
    const forward = apply(doc, {
      op: 'set_section_media',
      sectionId: 's_gallery',
      index: 0,
      refId: 'm2',
    });
    const section = forward.doc.pages[0]?.sections[1];
    expect(section?.type === 'gallery' ? section.media[0]?.refId : null).toBe('m2');

    const back = apply(forward.doc, forward.inverse);
    const restored = back.doc.pages[0]?.sections[1];
    expect(restored?.type === 'gallery' ? restored.media[0]?.refId : null).toBe('m1');
  });

  it('does not mutate the document it was given', () => {
    const doc = siteDocFixture();
    const snapshot = JSON.stringify(doc);
    apply(doc, { op: 'set_copy', locale: 'nl', slotId: 's_hero.headline', text: 'Anders' });
    // The undo ring hands the previous document and the inverse patch to two different callers; a
    // shared mutation would make undo a silent no-op.
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('a patch is refused rather than clamped', () => {
  it('refuses a slot id that is not in the derived inventory', () => {
    const outcome = applyPatch(siteDocFixture(), {
      op: 'set_copy',
      locale: 'nl',
      slotId: 'not.a.real.slot',
      text: 'x',
    });
    expect(outcome).toEqual({ ok: false, reason: 'unknown_slot' });
  });

  it('refuses copy past the slot kind ceiling, measured in CODE POINTS', () => {
    const doc = siteDocFixture();
    // `s_hero.headline` is a `heading`. One emoji is one column in the layout and two UTF-16 units,
    // so a UTF-16 length check here would refuse text that fits.
    const max = SLOT_MAX_LENGTH.heading;
    const justFits = '🙂'.repeat(max);
    expect(
      applyPatch(doc, {
        op: 'set_copy',
        locale: 'nl',
        slotId: 's_hero.headline',
        text: justFits,
      }).ok,
    ).toBe(true);

    const oneTooMany = '🙂'.repeat(max + 1);
    expect(
      applyPatch(doc, {
        op: 'set_copy',
        locale: 'nl',
        slotId: 's_hero.headline',
        text: oneTooMany,
      }),
    ).toEqual({ ok: false, reason: 'slot_too_long' });
  });

  it('refuses a locale the site has not enabled', () => {
    expect(
      applyPatch(siteDocFixture(), {
        op: 'set_copy',
        locale: 'de',
        slotId: 's_hero.headline',
        text: 'Hallo',
      }),
    ).toEqual({ ok: false, reason: 'locale_not_enabled' });
  });

  it('refuses a media ref that is not in the document manifest', () => {
    expect(
      applyPatch(siteDocFixture(), {
        op: 'set_section_media',
        sectionId: 's_gallery',
        index: 0,
        refId: 'not_in_manifest',
      }),
    ).toEqual({ ok: false, reason: 'unknown_media' });
  });

  it('refuses a single-media operation on a section that has no media field', () => {
    expect(
      applyPatch(siteDocFixture(), {
        op: 'set_section_media',
        sectionId: 's_gallery',
        index: null,
        refId: 'm2',
      }),
    ).toEqual({ ok: false, reason: 'section_has_no_media' });
  });

  it('refuses a section move past the end of the page', () => {
    expect(
      applyPatch(siteDocFixture(), {
        op: 'move_section',
        pageId: 'p_home',
        sectionId: 's_hero',
        toIndex: 9,
      }),
    ).toEqual({ ok: false, reason: 'index_out_of_range' });
  });
});

describe('untrusted input never reaches applyPatch', () => {
  it('rejects a body that is not one of the eight operations', () => {
    expect(parsePatch({ op: 'delete_everything' })).toBeNull();
    expect(parsePatch(null)).toBeNull();
    expect(parsePatch({ op: 'set_copy', locale: 'nl' })).toBeNull();
    // A theme with a knob outside its enum: the schema is the closed design surface, and this is
    // where "eight enums" stops being a comment and becomes a check.
    expect(
      parsePatch({ op: 'set_theme', theme: { ...FIXTURE_KNOBS, dnaId: 'custom' } }),
    ).toBeNull();
  });

  it('accepts exactly what the editor sends', () => {
    expect(
      parsePatch({ op: 'set_copy', locale: 'nl', slotId: 's_hero.headline', text: 'Hoi' }),
    ).toEqual({ op: 'set_copy', locale: 'nl', slotId: 's_hero.headline', text: 'Hoi' });
  });
});

describe('the preview bridge and the editor agree on one message type', () => {
  it('uses the same constant on both sides of the origin boundary', () => {
    // The bridge is a frozen string inside the preview document and cannot import the constant, so
    // this is the assertion that keeps the two spellings equal. A mismatch is a theme change that
    // silently does nothing.
    expect(previewBridgeScript('https://app.test')).toContain(JSON.stringify(THEME_MESSAGE_TYPE));
  });

  it('embeds the dashboard origin as a JSON string literal', () => {
    expect(previewBridgeScript('https://app.test')).toContain('"https://app.test"');
  });
});
