/**
 * `@aibuilder/site-schema` -- the site-document contract.
 *
 * This package is the keystone of the system and depends on nothing but `zod`. Three
 * layers, one authoring source:
 *
 *   `gen/`          model-facing schemas. Flat, non-recursive, enum-bounded, every
 *                   field required and nullable, and free of any constraint the
 *                   structured-output grammar cannot enforce.
 *   `normalize.ts`  deterministic repair of model output. Repairs, never throws.
 *   `doc.ts`        `SiteDoc`: the renderer input, the editor form model and the R2
 *                   storage shape, with types DERIVED from the `gen/` schemas.
 *
 * Around them:
 *
 *   `slots.ts`      the single derivation of every slot id, plus `validateBundle()`.
 *   `gen-to-doc.ts` merges generated documents with D1 facts and the server-built
 *                   media and link manifests.
 *   `lint.ts`       semantic checks: contrast, dangling refs, section placement,
 *                   required copy, routing, legal constraints.
 *   `migrations/`   pure `vN -> vN+1` upgrades, applied on read.
 *
 * The four invariants that make all of this a security boundary are documented at the
 * top of `gen/section.ts`. Read them before adding a field.
 */

export * from './errors';

export * from './gen/common';
export * from './gen/section';
export * from './gen/site-structure';
export * from './gen/locale-bundle';
export * from './gen/blog-post';

export * from './slots';
export * from './normalize';
export * from './doc';
export * from './gen-to-doc';
export * from './lint';
export * from './migrations';
