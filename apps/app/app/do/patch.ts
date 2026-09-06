import { deriveSlotInventoryForPages } from '@aibuilder/site-schema';
import type { PageDoc, SiteDoc, ThemeDoc } from '@aibuilder/site-schema';
import { FooterStyle, NavStyle, ThemeGen } from '@aibuilder/site-schema';
import { resolveTheme } from '@aibuilder/site-kit';
import { z } from 'zod';

/**
 * The editor's edit vocabulary: eight operations, every one of them exactly invertible.
 *
 * WHY A TYPED VOCABULARY AND NOT JSON PATCH. A JSON Patch `replace /pages/2/sections/0/media/refId`
 * can address any byte of the document, so validating it means re-validating the whole document
 * after every keystroke, and inverting it means diffing. Eight named operations can each be checked
 * against the one thing they touch — is this slot in the inventory, is this section a gallery, is
 * this locale enabled — and each one's inverse is the previous value, which is a constant-size
 * object. That is what makes the undo ring cheap enough to write to storage on every patch.
 *
 * WHY THE FULL THEME IS ONE OPERATION. All eight knobs travel together because `resolveTheme`
 * takes all eight: there is no such thing as resolving a radius without knowing the DNA. Sending
 * one knob would mean the DO reading the other seven back out of storage to re-resolve, which is
 * the same work with an extra failure mode. The payload is eight short enum strings.
 *
 * THE TOKENS ARE RESOLVED HERE, SERVER-SIDE, AND THE CLIENT'S COPY IS NEVER TRUSTED. The editor
 * applies CSS custom properties locally for an instant repaint (`@aibuilder/ui`'s `applyThemeTokens`),
 * but what gets stored is `resolveTheme(knobs)` — the function that constructs, then verifies, then
 * throws. A client that computed a failing contrast pair cannot persist it.
 *
 * NOTHING HERE TOUCHES `facts`. Business name, address, phone, hours and the GBP URL come from D1
 * and are the only source of those values (`SiteDoc`'s own header says so). Letting the editor
 * patch them would put unverified text into the JSON-LD builder, which is the one place this system
 * promises facts beat model output.
 */

/* ── The vocabulary ──────────────────────────────────────────────────────────────────────────── */

/** The eight design knobs, exactly `ThemeGen` minus the QA-only `rationale`. */
export const ThemeKnobsSchema = ThemeGen.omit({ rationale: true });
export type ThemeKnobsPatch = z.infer<typeof ThemeKnobsSchema>;

/**
 * One edit.
 *
 * A discriminated union with `op` as the tag, so `applyPatch`'s switch is exhaustive and adding a
 * ninth operation is a compile error until it is handled.
 */
export const DraftPatchSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set_copy'),
    locale: z.string().min(2).max(8),
    slotId: z.string().min(1).max(200),
    /** Bounded generously here; the real ceiling is the slot's own `maxLength`, checked on apply. */
    text: z.string().max(4000),
  }),
  z.object({ op: z.literal('set_theme'), theme: ThemeKnobsSchema }),
  z.object({ op: z.literal('set_nav_style'), value: NavStyle }),
  z.object({ op: z.literal('set_footer_style'), value: FooterStyle }),
  z.object({ op: z.literal('set_whatsapp_enabled'), value: z.boolean() }),
  z.object({
    op: z.literal('set_page_flag'),
    pageId: z.string().min(1).max(64),
    field: z.enum(['showInNav', 'noindex']),
    value: z.boolean(),
  }),
  z.object({
    op: z.literal('move_section'),
    pageId: z.string().min(1).max(64),
    sectionId: z.string().min(1).max(64),
    toIndex: z.number().int().min(0).max(63),
  }),
  z.object({
    op: z.literal('set_section_media'),
    sectionId: z.string().min(1).max(64),
    /** `null` addresses a single-media section (`hero`, `about`); a number indexes a gallery. */
    index: z.number().int().min(0).max(63).nullable(),
    /** `null` clears the slot, which only the single-media sections allow. */
    refId: z.string().min(1).max(64).nullable(),
  }),
]);
export type DraftPatch = z.infer<typeof DraftPatchSchema>;

/** Why a patch was refused. Every one is a client bug or a stale editor, never a server fault. */
export type PatchRejection =
  | 'locale_not_enabled'
  | 'unknown_slot'
  | 'slot_too_long'
  | 'unknown_page'
  | 'unknown_section'
  | 'section_has_no_media'
  | 'unknown_media'
  | 'index_out_of_range'
  | 'invalid_theme';

/** The outcome of applying one patch. */
export type PatchOutcome =
  | { readonly ok: true; readonly doc: SiteDoc; readonly inverse: DraftPatch }
  | { readonly ok: false; readonly reason: PatchRejection };

function reject(reason: PatchRejection): PatchOutcome {
  return { ok: false, reason };
}

/* ── Application ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Replaces one page in the document, preserving order.
 *
 * `map` rather than index assignment because `SiteDoc` is treated as immutable throughout: the DO
 * stores the result and hands the previous value back as the inverse, and sharing a mutated array
 * between the two would make undo a no-op in the most confusing possible way.
 */
function withPage(doc: SiteDoc, pageId: string, next: PageDoc): SiteDoc {
  return { ...doc, pages: doc.pages.map((page) => (page.pageId === pageId ? next : page)) };
}

/** The page that owns a section, and the section's index in it. */
function locateSection(
  doc: SiteDoc,
  sectionId: string,
): { readonly page: PageDoc; readonly index: number } | null {
  for (const page of doc.pages) {
    const index = page.sections.findIndex((section) => section.id === sectionId);
    if (index !== -1) {
      return { page, index };
    }
  }
  return null;
}

/**
 * Applies one patch to a document and returns the new document plus the patch that undoes it.
 *
 * PURE. No storage, no clock, no bindings — which is what lets `patch.test.ts` prove the
 * apply/invert round trip in a plain runner, and what lets the DO treat "apply" as a value
 * transformation it can validate before it writes anything.
 *
 * THE INVERSE IS COMPUTED FROM THE *PREVIOUS* STATE, always. `set_copy`'s inverse carries the old
 * text; `set_theme`'s carries the old eight knobs. An inverse derived from the new state would be
 * an identity operation, and the undo ring would silently do nothing.
 */
export function applyPatch(doc: SiteDoc, patch: DraftPatch): PatchOutcome {
  switch (patch.op) {
    case 'set_copy': {
      // Widened to `readonly string[]` rather than narrowing `patch.locale` to `Locale`: the patch
      // arrives from the network as a string, and asserting it into the enum before the membership
      // test is exactly the assertion this test exists to avoid.
      const enabled: readonly string[] = doc.locales.enabled;
      if (!enabled.includes(patch.locale)) {
        return reject('locale_not_enabled');
      }
      const inventory = deriveSlotInventoryForPages(doc.pages);
      const slot = inventory.byId.get(patch.slotId);
      if (slot === undefined) {
        // The slot ids come from `deriveSlotInventory`, never from a hand-built string — which is
        // exactly what makes this check meaningful rather than a comparison of model output with
        // model output.
        return reject('unknown_slot');
      }
      if ([...patch.text].length > slot.maxLength) {
        // Code points, not UTF-16 units: `SLOT_MAX_LENGTH` is a layout constraint and an emoji
        // occupies one column, not two.
        return reject('slot_too_long');
      }
      const localeCopy = doc.copy[patch.locale] ?? {};
      const previous = localeCopy[patch.slotId] ?? '';
      return {
        ok: true,
        doc: {
          ...doc,
          copy: { ...doc.copy, [patch.locale]: { ...localeCopy, [patch.slotId]: patch.text } },
        },
        inverse: { op: 'set_copy', locale: patch.locale, slotId: patch.slotId, text: previous },
      };
    }

    case 'set_theme': {
      let tokens: ThemeDoc['tokens'];
      try {
        // `resolveTheme` constructs, then verifies, then throws — the contrast contract is proven
        // by construction, so a knob combination that cannot satisfy it never reaches storage.
        tokens = resolveTheme(patch.theme);
      } catch {
        return reject('invalid_theme');
      }
      const previous: ThemeKnobsPatch = {
        dnaId: doc.theme.dnaId,
        paletteVariant: doc.theme.paletteVariant,
        accentHueShift: doc.theme.accentHueShift,
        typeScaleId: doc.theme.typeScaleId,
        radiusId: doc.theme.radiusId,
        densityId: doc.theme.densityId,
        motionId: doc.theme.motionId,
        colorMode: doc.theme.colorMode,
      };
      return {
        ok: true,
        doc: { ...doc, theme: { ...patch.theme, tokens } },
        inverse: { op: 'set_theme', theme: previous },
      };
    }

    case 'set_nav_style':
      return {
        ok: true,
        doc: { ...doc, chrome: { ...doc.chrome, navStyle: patch.value } },
        inverse: { op: 'set_nav_style', value: doc.chrome.navStyle },
      };

    case 'set_footer_style':
      return {
        ok: true,
        doc: { ...doc, chrome: { ...doc.chrome, footerStyle: patch.value } },
        inverse: { op: 'set_footer_style', value: doc.chrome.footerStyle },
      };

    case 'set_whatsapp_enabled':
      return {
        ok: true,
        doc: { ...doc, chrome: { ...doc.chrome, whatsappEnabled: patch.value } },
        inverse: { op: 'set_whatsapp_enabled', value: doc.chrome.whatsappEnabled },
      };

    case 'set_page_flag': {
      const page = doc.pages.find((candidate) => candidate.pageId === patch.pageId);
      if (page === undefined) {
        return reject('unknown_page');
      }
      const previous = patch.field === 'showInNav' ? page.showInNav : page.noindex;
      const next: PageDoc =
        patch.field === 'showInNav'
          ? { ...page, showInNav: patch.value }
          : { ...page, noindex: patch.value };
      return {
        ok: true,
        doc: withPage(doc, page.pageId, next),
        inverse: { op: 'set_page_flag', pageId: patch.pageId, field: patch.field, value: previous },
      };
    }

    case 'move_section': {
      const page = doc.pages.find((candidate) => candidate.pageId === patch.pageId);
      if (page === undefined) {
        return reject('unknown_page');
      }
      const from = page.sections.findIndex((section) => section.id === patch.sectionId);
      if (from === -1) {
        return reject('unknown_section');
      }
      if (patch.toIndex >= page.sections.length) {
        return reject('index_out_of_range');
      }
      const sections = [...page.sections];
      const [moved] = sections.splice(from, 1);
      if (moved === undefined) {
        // Unreachable: `from` came from `findIndex` on this array. Asserted rather than
        // non-null-asserted, because `noUncheckedIndexedAccess` is on for a reason.
        return reject('unknown_section');
      }
      sections.splice(patch.toIndex, 0, moved);
      return {
        ok: true,
        doc: withPage(doc, page.pageId, { ...page, sections }),
        // The inverse moves it back to where it started, which is `from` — not `toIndex`.
        inverse: {
          op: 'move_section',
          pageId: patch.pageId,
          sectionId: patch.sectionId,
          toIndex: from,
        },
      };
    }

    case 'set_section_media': {
      const located = locateSection(doc, patch.sectionId);
      if (located === null) {
        return reject('unknown_section');
      }
      const { page, index: sectionIndex } = located;
      const section = page.sections[sectionIndex];
      if (section === undefined) {
        return reject('unknown_section');
      }
      if (patch.refId !== null && doc.media[patch.refId] === undefined) {
        // A ref that is not in the document's own manifest would render as a missing image and,
        // worse, would survive into the published document.
        return reject('unknown_media');
      }

      if (patch.index === null) {
        // The single-media sections. `hero` and `about` are the two whose `media` is
        // `MediaRef | null`; every other type has no such field, and saying so is better than
        // silently succeeding.
        if (section.type !== 'hero' && section.type !== 'about') {
          return reject('section_has_no_media');
        }
        const previous = section.media;
        const next =
          patch.refId === null
            ? { ...section, media: null }
            : {
                ...section,
                // The focal point is a property of this USE of the asset and is preserved across a
                // swap: replacing the photo should not re-centre a crop the customer adjusted.
                media: { refId: patch.refId, focalPoint: previous?.focalPoint ?? 'center' },
              };
        const sections = [...page.sections];
        sections[sectionIndex] = next;
        return {
          ok: true,
          doc: withPage(doc, page.pageId, { ...page, sections }),
          inverse: {
            op: 'set_section_media',
            sectionId: patch.sectionId,
            index: null,
            refId: previous === null ? null : previous.refId,
          },
        };
      }

      if (section.type !== 'gallery') {
        return reject('section_has_no_media');
      }
      const existing = section.media[patch.index];
      if (existing === undefined) {
        return reject('index_out_of_range');
      }
      if (patch.refId === null) {
        // Clearing a gallery slot would leave a hole in an array the renderer indexes by position,
        // and removing the entry would renumber every caption slot after it. Neither is an edit;
        // both are a "remove image" operation this vocabulary does not have yet.
        return reject('unknown_media');
      }
      const media = [...section.media];
      media[patch.index] = { refId: patch.refId, focalPoint: existing.focalPoint };
      const sections = [...page.sections];
      sections[sectionIndex] = { ...section, media };
      return {
        ok: true,
        doc: withPage(doc, page.pageId, { ...page, sections }),
        inverse: {
          op: 'set_section_media',
          sectionId: patch.sectionId,
          index: patch.index,
          refId: existing.refId,
        },
      };
    }

    default: {
      // Exhaustiveness: a ninth operation fails to compile until it is handled here, rather than
      // silently becoming a patch that is accepted and does nothing.
      const unreachable: never = patch;
      throw new Error(`Unhandled patch: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Parses an untrusted patch, returning `null` rather than throwing. */
export function parsePatch(input: unknown): DraftPatch | null {
  const parsed = DraftPatchSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
