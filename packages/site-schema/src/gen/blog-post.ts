import { z } from 'zod';
import { GenSchemaVersion, LinkRef, Locale, MediaRef } from './common';

/**
 * `BlogPostGen` — generation document C: one post, one locale.
 *
 * Blog posts carry literal text rather than slot ids. They are generated per locale
 * as whole documents (a translated post is a new generation, not a string map), so
 * the slot indirection would buy nothing and cost a second call to fill it.
 *
 * The block union is the *entire* expressive range: there is no markdown, no inline
 * markup and no raw HTML anywhere in it (invariant 1). Emphasis is a block type.
 */
export const BlogBlockGen = z.discriminatedUnion('type', [
  z.object({ type: z.literal('h2'), text: z.string() }),
  z.object({ type: z.literal('h3'), text: z.string() }),
  z.object({ type: z.literal('p'), text: z.string() }),
  z.object({ type: z.literal('ul'), items: z.array(z.string()) }),
  z.object({ type: z.literal('ol'), items: z.array(z.string()) }),
  z.object({
    type: z.literal('quote'),
    text: z.string(),
    attributionText: z.string().nullable(),
  }),
  z.object({ type: z.literal('image'), media: MediaRef, captionText: z.string().nullable() }),
  // `labelText` is required: a CTA without a label has no accessible name, which is
  // a WCAG 2.4.4 failure the renderer cannot repair on its own.
  z.object({ type: z.literal('cta'), labelText: z.string(), target: LinkRef }),
]);
export type BlogBlockGen = z.infer<typeof BlogBlockGen>;

export const BLOG_BLOCK_TYPES = ['h2', 'h3', 'p', 'ul', 'ol', 'quote', 'image', 'cta'] as const;
export type BlogBlockType = BlogBlockGen['type'];

/** Narrow `BlogBlockGen` to a single member, e.g. `BlogBlockOf<"image">`. */
export type BlogBlockOf<T extends BlogBlockType> = Extract<BlogBlockGen, { type: T }>;

/**
 * One generated blog post.
 *
 * `slugSeed` is a phrase, not a slug: code applies locale-aware transliteration and
 * collision suffixing, because a generic NFD strip yields the empty string for
 * Greek, Cyrillic and Han.
 */
export const BlogPostGen = z.object({
  schemaVersion: GenSchemaVersion,
  locale: Locale,
  titleText: z.string(),
  slugSeed: z.string(),
  excerptText: z.string(),
  metaDescriptionText: z.string(),
  heroMedia: MediaRef.nullable(),
  blocks: z.array(BlogBlockGen),
});
export type BlogPostGen = z.infer<typeof BlogPostGen>;
