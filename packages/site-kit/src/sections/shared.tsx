import type { JSX } from 'hono/jsx/jsx-runtime';
import type { Cta, LinkRef, MediaRef, SectionGen, SiteDoc } from '@aibuilder/site-schema';
import { mediaFor, sectionSlotId, textFor } from '@aibuilder/site-schema';
import type { RenderContext, RenderScope, ResolvedImage } from '../context';
import { ICON_PATHS } from '../icons';
import { relFor, resolveLink } from '../links';
import type { Tone } from '../tokens/tones';

/**
 * The primitives every section composes from.
 *
 * All markup in this directory is `hono/jsx`, which escapes every text child and every attribute
 * value. That is what makes invariant 1 structural here rather than a convention: there is no
 * `raw()`, no `innerHTML` and no markdown parser in this package, and eslint fails the build on
 * the first two. The only string concatenation that produces markup lives in `render.ts`, and
 * everything it interpolates goes through `escape.ts`.
 */

/** A rendered node. `hono/jsx` types this as an already-escaped string. */
export type Markup = JSX.Element;

/** What a component may pass as `children`. Mirrors `hono/jsx`'s own `Child`. */
export type Children = Markup | (Markup | null | false)[];

/** What every section component receives. */
export interface SectionProps<S extends SectionGen = SectionGen> {
  readonly section: S;
  readonly doc: SiteDoc;
  readonly ctx: RenderContext;
  readonly scope: RenderScope;
  readonly tone: Tone;
  /** 1 only for the page's single `<h1>`. `renderPage` decides; a section never chooses. */
  readonly headingLevel: 1 | 2;
}

/** One slot's copy, in this scope's locale. */
export function slot(
  doc: SiteDoc,
  scope: RenderScope,
  sectionId: string,
  ...path: readonly (string | number)[]
): string {
  return textFor(doc, scope.locale, sectionSlotId(sectionId, ...path));
}

/** `aria-labelledby` target for a section's own headline. */
export function headingId(sectionId: string): string {
  return `${sectionId}-h`;
}

/**
 * The section element.
 *
 * `aria-labelledby` promotes it to a named `region` landmark. The name is always the section's own
 * headline, visible or `.vh` — a landmark without an accessible name is a WCAG 1.3.1 failure, and
 * it is the reason `deriveSectionSlots` gives *every* section a `headline` slot.
 */
export function SectionShell(props: {
  readonly section: SectionGen;
  readonly tone: Tone;
  readonly ctx: RenderContext;
  readonly extraClass?: string;
  readonly children: Children;
}): Markup {
  const { section, tone, ctx } = props;
  const height = ctx.sectionHeights[section.id];
  const ground = ctx.sectionGrounds[section.id] ?? null;
  return (
    <section
      class={`section ${props.extraClass ?? ''}`.trim()}
      id={section.id}
      data-tone={tone}
      data-variant={section.variant}
      data-ground={ground === null ? undefined : '1'}
      style={`--sec-h:${Math.round(height ?? 720)}px`}
      aria-labelledby={headingId(section.id)}
    >
      {ground === null ? null : (
        <div class="section__media" aria-hidden="true">
          <Picture image={ground} sizes="100vw" extraClass="section__ground" />
          <div class="section__scrim"></div>
        </div>
      )}
      {props.children}
    </section>
  );
}

/**
 * A section headline.
 *
 * `visuallyHidden` changes a class and nothing else, so the accessible name never depends on the
 * variant: `usp_trio/icons_row` shows no title in the design, and hiding it by removing the element
 * would silently un-name the landmark.
 */
export function SectionHeading(props: {
  readonly sectionId: string;
  readonly level: 1 | 2;
  readonly text: string;
  /** Used when the slot resolved to `''`. An unnamed region is worse than a generic one. */
  readonly fallback: string;
  readonly visuallyHidden?: boolean;
  readonly extraClass?: string;
}): Markup {
  const text = props.text.trim() === '' ? props.fallback : props.text;
  const classes = [props.visuallyHidden === true ? 'vh' : '', props.extraClass ?? '']
    .filter((part) => part !== '')
    .join(' ');
  return props.level === 1 ? (
    <h1 id={headingId(props.sectionId)} class={classes}>
      {text}
    </h1>
  ) : (
    <h2 id={headingId(props.sectionId)} class={classes}>
      {text}
    </h2>
  );
}

/**
 * One of the twelve icons.
 *
 * `aria-hidden` + `focusable="false"`: an icon beside a heading duplicates the heading, and IE-era
 * SVGs are in the tab order without the second attribute.
 */
export function Icon(props: {
  readonly id: keyof typeof ICON_PATHS;
  readonly size?: number;
}): Markup {
  const size = props.size ?? 28;
  return (
    <svg
      class="icon"
      aria-hidden="true"
      focusable="false"
      width={String(size)}
      height={String(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d={ICON_PATHS[props.id]} />
    </svg>
  );
}

/** Maps `CtaStyle` to the three button classes. These *are* `CTA_STYLES` from `gen/common.ts`. */
const CTA_CLASS = {
  primary: 'btn btn--primary',
  secondary: 'btn btn--secondary',
  ghost: 'btn btn--ghost',
} as const;

/**
 * A call to action.
 *
 * Returns `null` when the `LinkRef` cannot be resolved — a button with a dead `href` is worse than
 * no button, and the linter already reports the underlying dangling ref. The label is the anchor's
 * entire accessible name; there is no icon-only CTA anywhere in this package.
 */
export function CtaLink(props: {
  readonly cta: Cta;
  readonly label: string;
  readonly doc: SiteDoc;
  readonly scope: RenderScope;
}): Markup | null {
  const link = resolveLink(props.doc, props.cta.target, props.scope.locale);
  if (link === null || props.label.trim() === '') return null;
  const rel = relFor(link);
  return (
    <a
      class={CTA_CLASS[props.cta.style]}
      href={link.href}
      rel={rel}
      target={link.external ? '_blank' : undefined}
    >
      {props.label}
    </a>
  );
}

/** A plain in-flow link built from a `LinkRef`. Same resolution rules as `CtaLink`. */
export function RefLink(props: {
  readonly target: LinkRef;
  readonly label: string;
  readonly doc: SiteDoc;
  readonly scope: RenderScope;
  readonly extraClass?: string;
}): Markup | null {
  const link = resolveLink(props.doc, props.target, props.scope.locale);
  if (link === null) return null;
  const rel = relFor(link);
  return (
    <a
      class={props.extraClass}
      href={link.href}
      rel={rel}
      target={link.external ? '_blank' : undefined}
    >
      {props.label}
    </a>
  );
}

/** Resolves a `MediaRef` all the way to a renderable image, or `null`. */
export function imageFor(
  doc: SiteDoc,
  ctx: RenderContext,
  ref: MediaRef | null,
): ResolvedImage | null {
  const asset = mediaFor(doc, ref);
  if (asset === null) return null;
  return ctx.images[asset.refId] ?? null;
}

/**
 * A responsive image.
 *
 * Always `width`/`height` (CLS), always `loading="lazy"` and `decoding="async"` — the one exception
 * is the hero poster, which `layout/hero.tsx` renders itself because it is the LCP element and must
 * be eager and decoded synchronously. `sizes` is passed per layout rather than being `100vw`
 * everywhere.
 */
export function Picture(props: {
  readonly image: ResolvedImage;
  readonly sizes: string;
  readonly extraClass?: string;
}): Markup {
  const { image } = props;
  return (
    <picture>
      {image.sources.map((source) => (
        <source type={source.type} sizes={props.sizes} srcset={source.srcset} />
      ))}
      <img
        class={props.extraClass}
        src={image.src}
        alt={image.alt}
        width={String(image.width)}
        height={String(image.height)}
        sizes={props.sizes}
        loading="lazy"
        decoding="async"
        style={`--focal:${image.focal}`}
      />
    </picture>
  );
}
