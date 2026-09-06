-- ============================================================================================
-- migrations/cp/0002_taxonomy.sql          database: aibuilder-cp
--
-- PURPOSE
--   The reference data every surface reads and nothing writes at runtime: the locale registry,
--   the two-level industry taxonomy with its design-DNA preset and localized labels, and the
--   reserved-slug list. Adding a locale or an industry is an INSERT (see 0007), never a migration.
--
-- MIGRATION RULE (architecture §5.4). A cascade-parent table can NEVER be rebuilt in place on D1:
--   `PRAGMA foreign_keys=OFF` does not exist there, and `defer_foreign_keys` defers constraint
--   *checking*, not FK *actions*, so the 12-step rebuild silently cascade-deletes every child and
--   `foreign_key_check` still passes. Forward change is expand -> migrate -> contract with only
--   `ALTER TABLE ADD/DROP/RENAME COLUMN`. `industries` and `locales` are cascade parents of
--   `industry_translations`; treat both as unrebuildable.
-- ============================================================================================

-- The global locale registry. Architecture §5.4: there is not one locale-named column anywhere in
-- this system. Everything that varies per locale is a row here, mirrored at build time by
-- `packages/core/src/locales.ts` and asserted equal by that package's tests.
CREATE TABLE locales (
  code         TEXT PRIMARY KEY,
  english_name TEXT NOT NULL CHECK (length(english_name) BETWEEN 2 AND 64),
  native_name  TEXT NOT NULL CHECK (length(native_name) BETWEEN 2 AND 64),
  hreflang     TEXT NOT NULL CHECK (length(hreflang) BETWEEN 2 AND 12),
  -- First path segment of every content URL in this locale. Deliberately separate from `code`:
  -- a future pt-BR split keeps code = 'pt-BR' while serving /pt-br/.
  url_segment  TEXT NOT NULL,
  direction    TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr','rtl')),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order   INTEGER NOT NULL DEFAULT 100,
  created_at   INTEGER NOT NULL,
  CHECK (code GLOB '[a-z][a-z]' OR code GLOB '[a-z][a-z]-[A-Z][A-Z]'),
  CHECK (length(url_segment) BETWEEN 2 AND 12 AND url_segment NOT GLOB '*[^a-z-]*')
) STRICT;

CREATE INDEX idx_locales_active ON locales(sort_order, code) WHERE is_active = 1;

-- Top level of the onboarding industry picker. Fifteen rows, read on every bootstrap request.
CREATE TABLE industry_groups (
  key        TEXT PRIMARY KEY,
  icon       TEXT NOT NULL CHECK (length(icon) BETWEEN 1 AND 32),
  -- The ONE deliberate exception to the translation-table rule, and the same exception the shard
  -- makes for `media_assets.alt_text`: fifteen groups times six locales is under 2 KB in total, it
  -- is always fetched whole, and it is never filtered or sorted by locale. A join here would cost
  -- more than the column. Leaf industries keep a real translation table because they also carry
  -- `search_terms`, which IS filtered on.
  labels     TEXT NOT NULL CHECK (json_valid(labels) AND length(labels) <= 2048),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  -- `_` is allowed as well as `-`: these keys are internal join keys (written to
  -- `sites.industry_key`), never URL segments, and packages/core/src/industries.ts — the single
  -- source of truth this table is projected from — uses snake_case.
  CHECK (length(key) BETWEEN 2 AND 48
         AND key NOT GLOB '*[^a-z0-9_-]*'
         AND key GLOB '[a-z]*'
         AND key NOT GLOB '*-')
) STRICT;

CREATE INDEX idx_industry_groups_active ON industry_groups(sort_order, key) WHERE is_active = 1;

-- Leaf industries. Drives the dropdown, the design DNA, the prompt fragment and the stock-photo
-- query. Keys are projected from packages/core/src/industries.ts by scripts/generate-taxonomy-seed.mjs
-- and asserted equal to it by test; never hand-edit them here.
CREATE TABLE industries (
  key                    TEXT PRIMARY KEY,
  group_key              TEXT NOT NULL REFERENCES industry_groups(key) ON DELETE RESTRICT,
  -- Default JSON-LD type. The model never authors this; `packages/site-kit/src/seo/allowlist.ts`
  -- is the committed allowlist and this column is the per-industry default it starts from.
  schema_org_type        TEXT NOT NULL DEFAULT 'LocalBusiness'
                           CHECK (length(schema_org_type) BETWEEN 3 AND 48
                                  AND schema_org_type NOT GLOB '*[^A-Za-z]*'),
  -- Design-DNA archetype. Phase 1 ships four and Phase 2 adds sixteen more, so this is DELIBERATELY
  -- a shape check and not an enum: `industries` is a cascade parent of `industry_translations`, and
  -- the MIGRATION RULE above forbids rebuilding it — which is exactly what widening a CHECK
  -- constraint requires. The closed set lives in `packages/site-kit/src/tokens/dna.ts`, where adding
  -- an archetype is a code change that the type system checks, and the seed and the registry are
  -- asserted equal by test. Same reasoning as `generation_calls.stop_reason` in the shard.
  dna_id                 TEXT NOT NULL
                           CHECK (length(dna_id) BETWEEN 3 AND 32 AND dna_id NOT GLOB '*[^a-z0-9_]*'),
  -- Optional per-industry overrides for the bounded theme knobs (paletteVariant, accentHueShift,
  -- typeScaleId, radiusId, densityId, motionId, colorMode). NULL means "the DNA's own defaults",
  -- which is the Phase 1 seed for every row.
  design_preset          TEXT CHECK (design_preset IS NULL OR
                           (json_valid(design_preset) AND length(design_preset) <= 2048)),
  default_page_keys      TEXT NOT NULL DEFAULT '["home","about","services","contact"]'
                           CHECK (json_valid(default_page_keys) AND length(default_page_keys) <= 512),
  -- sha256 of the industry-specific prompt fragment. Part of the Anthropic cache prefix, so a
  -- change here invalidates exactly one cache breakpoint and nothing else.
  prompt_fragment_sha256 BLOB CHECK (prompt_fragment_sha256 IS NULL OR length(prompt_fragment_sha256) = 32),
  -- A Wikidata or schema.org URI carrying the meaning `schema_org_type` had to drop when no
  -- LocalBusiness subtype fits the trade. Emitted as `additionalType`, which is the honest
  -- alternative to inventing a `@type`: the graph stays valid and the specific trade is still
  -- stated. NULL whenever the subtype is already exact.
  additional_type        TEXT CHECK (additional_type IS NULL OR
                           (length(additional_type) BETWEEN 8 AND 200
                            AND additional_type GLOB 'https://*')),
  stock_query            TEXT CHECK (stock_query IS NULL OR length(stock_query) BETWEEN 3 AND 120),
  is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order             INTEGER NOT NULL DEFAULT 100,
  created_at             INTEGER NOT NULL,
  -- `_` is allowed as well as `-`: these keys are internal join keys (written to
  -- `sites.industry_key`), never URL segments, and packages/core/src/industries.ts — the single
  -- source of truth this table is projected from — uses snake_case.
  CHECK (length(key) BETWEEN 2 AND 48
         AND key NOT GLOB '*[^a-z0-9_-]*'
         AND key GLOB '[a-z]*'
         AND key NOT GLOB '*-'
         AND key NOT GLOB '*--*')
) STRICT;

-- Covering: the bootstrap route reads the whole active taxonomy in group order without a table
-- lookup per row.
CREATE INDEX idx_industries_active
  ON industries(group_key, sort_order, key, schema_org_type, dna_id) WHERE is_active = 1;

CREATE TABLE industry_translations (
  industry_key TEXT NOT NULL REFERENCES industries(key) ON DELETE CASCADE,
  locale       TEXT NOT NULL REFERENCES locales(code) ON DELETE CASCADE,
  label        TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  -- Comma-separated alias terms the client-side fuzzy filter matches on ("kapper, kapsalon,
  -- knippen"). Stored lowercased so the match is a plain substring test.
  search_terms TEXT CHECK (search_terms IS NULL OR
                 (length(search_terms) <= 400 AND search_terms = lower(search_terms))),
  PRIMARY KEY (industry_key, locale)
) STRICT, WITHOUT ROWID;

-- Covering: "the whole taxonomy in locale X, alphabetically" with no table lookups.
CREATE INDEX idx_industry_tr_locale ON industry_translations(locale, label, industry_key, search_terms);

-- System, brand, protocol and abuse-reserved labels, PLUS retired tenant slugs. Enforced by the
-- `BEFORE INSERT` / `BEFORE UPDATE OF slug` triggers on `sites` in 0006 — without those this table
-- is decoration and a site with slug='www' inserts cleanly.
CREATE TABLE reserved_slugs (
  slug       TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'system'
               CHECK (reason IN ('system','protocol','brand','abuse','retired')),
  note       TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_at INTEGER NOT NULL DEFAULT 0,
  -- Deliberately looser than the `sites.slug` CHECK: protocol labels such as `_acme-challenge`
  -- start with an underscore and could never be a tenant slug, but they must still be reserved so
  -- that no future relaxation of the slug rule can hand one out.
  CHECK (length(slug) BETWEEN 1 AND 63 AND slug = lower(slug) AND slug NOT GLOB '*[^a-z0-9_-]*')
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_reserved_slugs_reason ON reserved_slugs(reason, slug);
