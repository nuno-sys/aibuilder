import type { LocaleBundleGen } from './gen/locale-bundle';
import type { SectionGen, SectionType } from './gen/section';
import type { SiteStructureGen } from './gen/site-structure';

/**
 * THE single derivation of every slot id in the system.
 *
 * The renderer, the editor's copy panel, `normalize()`, `genToDoc()` and the
 * translation validator all call into this file. Nothing else may build a slot id by
 * hand, and the model never authors one — which is precisely what makes
 * `validateBundle()` a real check instead of model output compared against model
 * output.
 *
 * Shape of an id:
 *   `page.${pageId}.meta.title`            page-level
 *   `${sectionId}.headline`                section-level scalar
 *   `${sectionId}.items.${i}.title`        section-level collection
 *   `${sectionId}.groups.${g}.items.${i}.name`   nested collection (menus only)
 *
 * Section ids are unique site-wide (enforced by `normalize()`), so a section slot id
 * needs no page prefix and survives a section being moved between pages.
 */

/* ── Slot kinds ─────────────────────────────────────────────────────────── */

/**
 * What a slot is *for*. Drives the maximum length `normalize()` enforces, the input
 * control the editor renders, and the "required copy" lint.
 */
export type SlotKind =
  | 'meta_title'
  | 'meta_description'
  | 'slug_seed'
  | 'nav_label'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'trustline'
  | 'item_title'
  | 'item_body'
  | 'label'
  | 'price'
  | 'stat_value'
  | 'stat_label'
  | 'question'
  | 'answer'
  | 'person_name'
  | 'person_role'
  | 'person_bio'
  | 'caption'
  | 'menu_group_title'
  | 'menu_item_name'
  | 'menu_item_description';

/**
 * Hard ceilings, in Unicode code points, applied by `normalize()`.
 *
 * `meta_title` and `meta_description` are the SERP truncation points, not opinions.
 * The rest are the widths the archetype CSS is laid out for — copy past them does
 * not wrap gracefully, it breaks the grid.
 */
export const SLOT_MAX_LENGTH: Readonly<Record<SlotKind, number>> = {
  meta_title: 60,
  meta_description: 155,
  slug_seed: 80,
  nav_label: 24,
  heading: 90,
  subheading: 180,
  body: 600,
  trustline: 120,
  item_title: 80,
  item_body: 400,
  label: 40,
  price: 24,
  stat_value: 12,
  stat_label: 60,
  question: 160,
  answer: 800,
  person_name: 80,
  person_role: 80,
  person_bio: 400,
  caption: 140,
  menu_group_title: 60,
  menu_item_name: 80,
  menu_item_description: 200,
};

/** One addressable string of a site, in one locale. */
export interface SlotDescriptor {
  readonly id: string;
  readonly kind: SlotKind;
  /** `SLOT_MAX_LENGTH[kind]`, denormalised so consumers never need a second lookup. */
  readonly maxLength: number;
  readonly pageId: string;
  /** `null` for page-level slots (meta, nav label). */
  readonly sectionId: string | null;
  /** `null` for page-level slots. */
  readonly sectionType: SectionType | null;
}

/** Every slot of a site, in stable document order, with O(1) lookup. */
export interface SlotInventory {
  readonly slots: readonly SlotDescriptor[];
  readonly byId: ReadonlyMap<string, SlotDescriptor>;
  readonly ids: ReadonlySet<string>;
}

/* ── Id builders ────────────────────────────────────────────────────────── */

/**
 * Builds a section-scoped slot id from a path, e.g.
 * `sectionSlotId("s3", "items", 0, "title")` -> `"s3.items.0.title"`.
 */
export function sectionSlotId(sectionId: string, ...path: readonly (string | number)[]): string {
  return [sectionId, ...path].join('.');
}

/** Builds `page.${pageId}.meta.${field}`. */
export function pageMetaSlotId(pageId: string, field: 'title' | 'description' | 'slug'): string {
  return `page.${pageId}.meta.${field}`;
}

/** Builds `page.${pageId}.nav.label`. */
export function pageNavSlotId(pageId: string): string {
  return `page.${pageId}.nav.label`;
}

/* ── Derivation ─────────────────────────────────────────────────────────── */

function slot(
  id: string,
  kind: SlotKind,
  pageId: string,
  sectionId: string | null,
  sectionType: SectionType | null,
): SlotDescriptor {
  return { id, kind, maxLength: SLOT_MAX_LENGTH[kind], pageId, sectionId, sectionType };
}

/**
 * Every slot a single section contributes, in render order.
 *
 * Guarantees: pure, total over the union (a new section type fails to compile until
 * it is handled), and dependent only on the section's own structure — so two calls
 * with the same section always produce the same ids.
 */
export function deriveSectionSlots(section: SectionGen, pageId: string): readonly SlotDescriptor[] {
  const id = section.id;
  const t = section.type;
  const out: SlotDescriptor[] = [];
  const push = (path: readonly (string | number)[], kind: SlotKind): void => {
    out.push(slot(sectionSlotId(id, ...path), kind, pageId, id, t));
  };

  // Every section owns a heading. Sections whose design shows no visible title
  // render it as a visually-hidden one: a landmark region without an accessible
  // name is a WCAG 1.3.1 failure, and the document outline is what screen-reader
  // users navigate by.
  push(['headline'], 'heading');

  switch (section.type) {
    case 'hero': {
      push(['subhead'], 'subheading');
      if (section.showTrustline) push(['trustline'], 'trustline');
      section.ctas.forEach((_cta, i) => push(['ctas', i, 'label'], 'label'));
      break;
    }
    case 'usp_trio': {
      section.items.forEach((_item, i) => {
        push(['items', i, 'title'], 'item_title');
        push(['items', i, 'body'], 'item_body');
      });
      break;
    }
    case 'about': {
      section.paragraphs.forEach((_p, i) => push(['paragraphs', i, 'text'], 'body'));
      if (section.cta !== null) push(['cta', 'label'], 'label');
      break;
    }
    case 'services_grid': {
      section.items.forEach((item, i) => {
        push(['items', i, 'title'], 'item_title');
        push(['items', i, 'body'], 'item_body');
        if (item.showPrice) push(['items', i, 'price'], 'price');
      });
      break;
    }
    case 'menu': {
      section.groups.forEach((group, g) => {
        push(['groups', g, 'title'], 'menu_group_title');
        group.items.forEach((item, i) => {
          push(['groups', g, 'items', i, 'name'], 'menu_item_name');
          push(['groups', g, 'items', i, 'price'], 'price');
          if (item.showDescription) {
            push(['groups', g, 'items', i, 'description'], 'menu_item_description');
          }
        });
      });
      break;
    }
    case 'gallery': {
      if (section.showCaptions) {
        section.media.forEach((_m, i) => push(['media', i, 'caption'], 'caption'));
      }
      break;
    }
    case 'reviews': {
      // Review bodies come from the shard's `reviews` table, never from the model.
      break;
    }
    case 'team': {
      section.items.forEach((item, i) => {
        push(['items', i, 'name'], 'person_name');
        push(['items', i, 'role'], 'person_role');
        if (item.showBio) push(['items', i, 'bio'], 'person_bio');
      });
      break;
    }
    case 'process_steps': {
      section.items.forEach((_item, i) => {
        push(['items', i, 'title'], 'item_title');
        push(['items', i, 'body'], 'item_body');
      });
      break;
    }
    case 'stats_band': {
      section.items.forEach((_item, i) => {
        push(['items', i, 'value'], 'stat_value');
        push(['items', i, 'label'], 'stat_label');
      });
      break;
    }
    case 'faq': {
      section.items.forEach((_item, i) => {
        push(['items', i, 'question'], 'question');
        push(['items', i, 'answer'], 'answer');
      });
      break;
    }
    case 'booking': {
      push(['body'], 'body');
      push(['ctaLabel'], 'label');
      break;
    }
    case 'contact_form': {
      push(['body'], 'body');
      push(['submitLabel'], 'label');
      section.fields.forEach((_f, i) => push(['fields', i, 'label'], 'label'));
      break;
    }
    case 'map_hours': {
      push(['body'], 'body');
      if (section.showRouteCta) push(['routeCtaLabel'], 'label');
      break;
    }
    case 'cta_band': {
      push(['body'], 'body');
      section.ctas.forEach((_cta, i) => push(['ctas', i, 'label'], 'label'));
      break;
    }
    case 'blog_teaser': {
      push(['linkLabel'], 'label');
      break;
    }
    case 'rich_text': {
      section.paragraphs.forEach((_p, i) => push(['paragraphs', i, 'text'], 'body'));
      break;
    }
    default: {
      // Exhaustiveness: adding a section type without extending this switch is a
      // compile error, not a page that silently renders without copy.
      const unreachable: never = section;
      throw new Error(`Unhandled section type: ${JSON.stringify(unreachable)}`);
    }
  }

  return out;
}

/**
 * The minimum a page must expose for its slots to be derivable.
 *
 * Both `PageGen` (pre-conversion) and `PageDoc` (post-conversion) satisfy it, which is
 * what lets the generator, the renderer and the linter share one derivation.
 */
export interface SlotPage {
  readonly pageId: string;
  readonly showInNav: boolean;
  readonly sections: readonly SectionGen[];
}

/**
 * Every slot a page contributes on its own behalf: the SERP metadata, the slug seed
 * the slugifier consumes, and the navigation label when the page is in the nav.
 */
export function derivePageSlots(page: SlotPage): readonly SlotDescriptor[] {
  const out: SlotDescriptor[] = [
    slot(pageMetaSlotId(page.pageId, 'title'), 'meta_title', page.pageId, null, null),
    slot(pageMetaSlotId(page.pageId, 'description'), 'meta_description', page.pageId, null, null),
    slot(pageMetaSlotId(page.pageId, 'slug'), 'slug_seed', page.pageId, null, null),
  ];
  if (page.showInNav) {
    out.push(slot(pageNavSlotId(page.pageId), 'nav_label', page.pageId, null, null));
  }
  return out;
}

/**
 * Derives the complete slot inventory of a site structure.
 *
 * Guarantees: pure and deterministic (same structure -> byte-identical id order);
 * de-duplicated, so `slots.length === ids.size` even if a caller hands in a
 * structure whose section ids collide (`normalize()` prevents that upstream, but
 * this function must not compound the problem); and total over the section union.
 */
export function deriveSlotInventory(structure: SiteStructureGen): SlotInventory {
  return deriveSlotInventoryForPages(structure.pages);
}

/**
 * Derives the slot inventory from a page list alone.
 *
 * The linter and the editor hold a `SiteDoc`, not a `SiteStructureGen`; routing them
 * through this overload keeps one derivation rather than two that can disagree.
 */
export function deriveSlotInventoryForPages(pages: readonly SlotPage[]): SlotInventory {
  const slots: SlotDescriptor[] = [];
  const byId = new Map<string, SlotDescriptor>();

  for (const page of pages) {
    for (const descriptor of derivePageSlots(page)) {
      if (byId.has(descriptor.id)) continue;
      byId.set(descriptor.id, descriptor);
      slots.push(descriptor);
    }
    for (const section of page.sections) {
      for (const descriptor of deriveSectionSlots(section, page.pageId)) {
        if (byId.has(descriptor.id)) continue;
        byId.set(descriptor.id, descriptor);
        slots.push(descriptor);
      }
    }
  }

  return { slots, byId, ids: new Set(byId.keys()) };
}

/* ── Bundle validation ──────────────────────────────────────────────────── */

/** A slot whose copy is longer than the slot kind allows. */
export interface OverlongSlot {
  readonly id: string;
  readonly length: number;
  readonly max: number;
}

/** The result of proving a locale bundle against a structure's slot inventory. */
export interface BundleValidation {
  /** True when `missing`, `unknown`, `blank` and `duplicate` are all empty. */
  readonly ok: boolean;
  /** Required slot ids with no entry — the only class that needs a model repair turn. */
  readonly missing: readonly string[];
  /** Entry ids that are not in the inventory. `normalize()` drops these. */
  readonly unknown: readonly string[];
  /** Entries present but empty after trimming. Treated as missing copy. */
  readonly blank: readonly string[];
  /** Ids that appear more than once. `normalize()` keeps the first. */
  readonly duplicate: readonly string[];
  /** Entries past their slot's ceiling. `normalize()` truncates at a word boundary. */
  readonly overlong: readonly OverlongSlot[];
}

/**
 * Proves key-set equality between a locale bundle and the slot inventory derived
 * from its structure.
 *
 * This is the check the whole slot indirection exists for: both sides are compared
 * against ids that only code can produce. Deterministic-repair classes (`unknown`,
 * `duplicate`, `overlong`) are reported separately from the one class that costs
 * another model call (`missing` / `blank`), so the caller can repair for free before
 * deciding to spend.
 */
export function validateBundle(
  structure: SiteStructureGen,
  bundle: LocaleBundleGen,
): BundleValidation {
  const inventory = deriveSlotInventory(structure);
  const seen = new Map<string, string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];

  for (const entry of bundle.entries) {
    if (!inventory.ids.has(entry.id)) {
      unknown.push(entry.id);
      continue;
    }
    if (seen.has(entry.id)) {
      duplicate.push(entry.id);
      continue;
    }
    seen.set(entry.id, entry.text);
  }

  const missing: string[] = [];
  const blank: string[] = [];
  const overlong: OverlongSlot[] = [];

  for (const descriptor of inventory.slots) {
    const text = seen.get(descriptor.id);
    if (text === undefined) {
      missing.push(descriptor.id);
      continue;
    }
    if (text.trim().length === 0) {
      blank.push(descriptor.id);
      continue;
    }
    const length = [...text].length;
    if (length > descriptor.maxLength) {
      overlong.push({ id: descriptor.id, length, max: descriptor.maxLength });
    }
  }

  return {
    ok:
      missing.length === 0 && unknown.length === 0 && blank.length === 0 && duplicate.length === 0,
    missing,
    unknown,
    blank,
    duplicate,
    overlong,
  };
}
