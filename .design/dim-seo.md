# SEO + i18n + Performance Architecture — `aibuilder`

Grounded on the schema already in `/home/user/aibuilder/migrations` (`locales`, `site_locales`, `pages`, `page_translations`, `custom_domains`, `site_reviews`, `industries.schema_org_type`). Everything below is either implementable against those tables as-is, or listed in §7 as an additive `0010` migration.

Two rendering surfaces, one engine:

| | Marketing site | Tenant sites |
|---|---|---|
| Host | `mijnsaas.com` (see §6.1 — move it) | `<slug>.mijnsaas.com` → custom domain |
| Runtime | Cloudflare Pages + Worker | Worker + R2 (no Pages) |
| Locales | all 6, always | subset from `site_locales` |
| JS budget | ≤ 30 KB br | ≤ 14 KB br |
| Third parties | Stripe.js on `/checkout` only | **zero** |

---

## 1. i18n URL architecture

### 1.1 The five invariants

Every URL that the Worker will ever return `200` for satisfies all five. Anything else gets a `308`.

```
I1  scheme  = https
I2  host    = the site's canonical host (§6.4)
I3  path    = "/" + <url_segment> + [ "/" + segment ]* + "/"     (always trailing slash)
I4  path    = lowercase, ASCII-only [a-z0-9/_.-]                 (already a D1 CHECK)
I5  query   = stripped for canonical purposes; only an allowlist survives at all
```

`I3` means **there is no unprefixed content URL anywhere**. `/over-ons/` does not exist. `/nl/over-ons/` does. This single rule is what makes the 7th locale a config change: no route is special-cased for the default language, so adding one never touches a template.

### 1.2 What lives at `/`

**`/` is a 308 to the site's default locale root. Unconditional, identical for every requester, including Googlebot.**

```
GET https://bakkerij-jansen.mijnsaas.com/
→ 308 Permanent Redirect
   Location: /nl/
   Cache-Control: public, max-age=3600
   Cloudflare-CDN-Cache-Control: public, max-age=86400
   X-Robots-Tag: noindex          # the redirect itself is not a page
```

Why 308 and not the alternatives:

- **Not a language-selector page.** A page whose only content is six flags is thin content, it becomes the strongest-linked URL on the site (every "share this site" link points at `/`), and it dilutes the home page it should be feeding. It also fails Lighthouse SEO on "document does not have a meta description" unless you pad it.
- **Not "serve `/nl/` content at `/` too".** That is two URLs, one body. You then need `rel=canonical` from `/` to `/nl/`, which means `/` burns crawl budget forever and every inbound link to `/` needs a canonical hop. And the moment the tenant changes their default locale, `/` silently changes language while its backlinks keep pointing at it.
- **308 not 302,** because the redirect is a permanent property of the site, and 308 (unlike 301) forbids method rewriting, which matters because the same Worker path handles form POSTs.
- The cost is one edge round-trip with no origin fetch — measured at the Cloudflare edge that is ~15–30 ms, and it only ever hits users who type the bare domain. Search traffic lands on `/nl/` directly because that is what is in the sitemap, the hreflang cluster, and every canonical.

`x-default` points at the **default locale URL**, not at `/`:

```html
<link rel="alternate" hreflang="nl"        href="https://bakkerij-jansen.mijnsaas.com/nl/">
<link rel="alternate" hreflang="x-default" href="https://bakkerij-jansen.mijnsaas.com/nl/">
```

Two `hreflang` values resolving to one URL is valid and is exactly what x-default is for when there is no negotiating page. `site_locales` already enforces this with `uq_site_locales_default` — exactly one `is_default = 1` per site, so there is exactly one x-default target and it cannot drift.

### 1.3 Why geo-redirects are an SEO trap

Cloudflare makes `request.cf.country` free and one line away. Do not use it to redirect. Six independent failure modes, any one of which is fatal:

1. **Googlebot crawls from a small set of IPs, overwhelmingly US.** A country redirect means Googlebot requests `/nl/`, is bounced to `/en/`, and *never sees the Dutch page at all*. The Dutch site does not get indexed. Google's own guidance is explicit: locale-adaptive serving means crawlers "may not detect versions of your site intended for other locales."
2. **It destroys hreflang reciprocity.** hreflang requires that when Google fetches `/de/`, it *gets* `/de/`. If `/de/` 302s to `/nl/` for a Dutch-IP crawler, the cluster is non-reciprocal and Google discards the whole cluster — not just the German entry. You lose the i18n signal for all six locales.
3. **Accept-Language is not a fallback.** Googlebot sends no `Accept-Language` (and when it does locale-adaptive crawling, it does so unpredictably). Same outcome.
4. **It poisons the edge cache.** Vary the body by country without `Vary` and you serve Dutch HTML to Portuguese users from cache. Add `Vary: CF-IPCountry` and you fragment every cached HTML object ~200×, which annihilates the cache hit rate that the whole CWV plan (§4.9) depends on.
5. **It breaks sharing and back-navigation.** A Dutch user shares `https://.../en/menu/` with a German colleague; the colleague lands on `/de/menu/`, which may not exist → 404, or worse a redirect loop with the browser's back button.
6. **It is a Core Web Vitals tax on 100% of traffic** — an extra RTT on every single navigation, including the SERP entry, which is where LCP is measured.

**The correct alternative** is *suggest, never redirect*:

```html
<!-- rendered server-side, hidden by default, zero CLS (it's in normal flow at the top of <body>
     only after first paint? No — it is position:sticky in flow but reserved: see §4.6) -->
<aside id="lang-hint" hidden data-current="nl">…</aside>
```

```js
// 380 bytes. Runs once, after LCP. Never redirects.
(() => {
  if (document.cookie.includes('lg=1')) return;
  const el = document.getElementById('lang-hint');
  const avail = JSON.parse(el.dataset.avail);          // ["nl","en","de"]
  const cur   = el.dataset.current;
  const want  = (navigator.languages || []).map(l => l.slice(0,2).toLowerCase())
                  .find(l => avail.includes(l));
  if (!want || want === cur) return;
  el.querySelector('a').href = el.dataset[`href${want}`];
  el.hidden = false;                                    // position:fixed → no CLS
})();
```

Plus a real `<a hreflang>` language switcher in the footer (crawlable, no JS). Googlebot sees the page it asked for, users see a one-line dismissible bar. If you additionally want *server-side* personalisation, the only safe form is: serve the requested URL with `200`, and inject the hint bar based on `cf.country` **only when the request is not from a verified bot** — but even then, prefer the client-side version so the HTML stays a single cacheable object.

### 1.4 Trailing slashes

Trailing slash on every content URL, no exceptions. Rationale: the locale root (`/nl/`) requires one anyway, so the alternative is an inconsistent rule ("slash on directories, none on leaves") that every template author gets wrong once. Uniformity also makes the normaliser a two-line regex.

Exempt (never get a slash): `/robots.txt`, `/sitemap.xml`, `/sitemaps/*.xml`, `/favicon.ico`, `/_a/*` (hashed assets), `/.well-known/*`, `/api/*`.

**Store the canonical form in D1.** `page_translations.path` should hold `'/nl/over-ons/'`, not `'/nl/over-ons'` — the existing CHECK permits it, and storing the exact served path means `uq_page_tr_path` is literally the URL-uniqueness constraint. Add the enforcing trigger in `0010`:

```sql
CREATE TRIGGER trg_page_tr_path_canonical
BEFORE INSERT ON page_translations
BEGIN
  SELECT RAISE(ABORT, 'path must start and end with /')
  WHERE NEW.path NOT GLOB '/*' OR NEW.path NOT GLOB '*/'
     OR NEW.path GLOB '*//*';
END;
```

**Slug transliteration** — `I4` forbids non-ASCII, which is correct (punycode/percent-encoding in paths is a canonicalisation minefield), so the generator must fold per locale, not with a generic `NFD`-strip:

| locale | rule |
|---|---|
| `de` | ä→ae ö→oe ü→ue ß→ss, *then* NFD-strip. `Über uns` → `ueber-uns` |
| `nl` | ĳ→ij (U+0133), then NFD-strip |
| `fr` | œ→oe æ→ae, then NFD-strip. `Réservations` → `reservations` |
| `es`/`pt` | ñ→n, NFD-strip. `Serviços` → `servicos` |
| all | lowercase, collapse `[^a-z0-9]+` → `-`, trim `-`, max 60 chars, dedupe with `-2` |

Localised slugs are worth it (`/de/leistungen/` outranks `/de/services/` for German queries) and cost nothing because `page_translations` already keys path per `(page_id, locale)`.

### 1.5 The exact hreflang cluster

Emitted on **every** indexable page, in `<head>`, one `<link>` per enabled locale plus x-default. Absolute, `https`, canonical host, trailing slash, **localised path per locale**.

```html
<!doctype html>
<html lang="nl" dir="ltr">
<head>
<meta charset="utf-8">
<title>Diensten — Bakkerij Jansen | Amsterdam</title>
<link rel="canonical" href="https://bakkerij-jansen.mijnsaas.com/nl/diensten/">

<link rel="alternate" hreflang="nl"        href="https://bakkerij-jansen.mijnsaas.com/nl/diensten/">
<link rel="alternate" hreflang="en"        href="https://bakkerij-jansen.mijnsaas.com/en/services/">
<link rel="alternate" hreflang="de"        href="https://bakkerij-jansen.mijnsaas.com/de/leistungen/">
<link rel="alternate" hreflang="fr"        href="https://bakkerij-jansen.mijnsaas.com/fr/services/">
<link rel="alternate" hreflang="es"        href="https://bakkerij-jansen.mijnsaas.com/es/servicios/">
<link rel="alternate" hreflang="pt"        href="https://bakkerij-jansen.mijnsaas.com/pt/servicos/">
<link rel="alternate" hreflang="x-default" href="https://bakkerij-jansen.mijnsaas.com/nl/diensten/">

<meta property="og:locale" content="nl_NL">
<meta property="og:locale:alternate" content="en_GB">
<meta property="og:locale:alternate" content="de_DE">
<meta property="og:locale:alternate" content="fr_FR">
<meta property="og:locale:alternate" content="es_ES">
<meta property="og:locale:alternate" content="pt_PT">
<meta property="og:url" content="https://bakkerij-jansen.mijnsaas.com/nl/diensten/">
```

The `/en/services/` page emits the **identical seven lines**, only its `canonical`, `<html lang>`, `og:url` and `og:locale` differ. That is the reciprocity rule and it is non-negotiable: **every member of a cluster lists every member, including itself.**

Hard rules the builder enforces (throw at build time, never at request time):

| Rule | Why |
|---|---|
| A locale with **no translation of this page** is *omitted* from the cluster. Never substitute a fallback-language URL. | A non-reciprocal entry makes Google drop the *entire* cluster, not just that entry. `page_translations` missing a `(page_id, locale)` row is the signal. |
| hreflang value must match `^[a-z]{2}(-[A-Z]{2})?$` and the language must be ISO 639-1. `locales.hreflang` is the source; `locales.code` CHECK already enforces the shape. | Invalid values are silently ignored by Google, so the bug is invisible without a validator. |
| URL must be byte-identical to that page's own `<link rel=canonical>`. | Pointing hreflang at a URL that canonicalises elsewhere breaks the cluster. |
| Never emit hreflang on a `noindex` page or a redirect. | Wasted, and confuses cluster resolution. |
| Region variants: `/pt/` may carry **both** `hreflang="pt"` and `hreflang="pt-BR"` if you want Brazilian targeting without a separate page. Two values, one URL, valid. Only split into `/pt-br/` when the *content* differs (price, address, legal). | Avoids a 2× content-generation cost for zero ranking gain. |

The cluster is generated, never authored:

```ts
// src/shared/seo/hreflang.ts
export function hreflangCluster(
  host: string,
  siteLocales: SiteLocale[],          // FROM site_locales WHERE is_enabled = 1 ORDER BY sort_order
  pathsByLocale: Map<string, string>, // FROM page_translations WHERE page_id = ?
): Alternate[] {
  const out: Alternate[] = [];
  let xdefault: string | undefined;
  for (const l of siteLocales) {
    const path = pathsByLocale.get(l.locale);
    if (!path) continue;                       // rule: omit, never substitute
    const href = `https://${host}${path}`;
    out.push({ hreflang: l.hreflang, href });
    for (const alias of l.hreflang_aliases ?? []) out.push({ hreflang: alias, href });
    if (l.is_default) xdefault = href;
  }
  if (xdefault) out.push({ hreflang: 'x-default', href: xdefault });
  return out;
}
```

### 1.6 Canonical rules

```ts
// src/shared/seo/canonical.ts — the ONLY place a canonical URL is ever produced.
export function canonicalUrl(host: string, path: string, page: PageCtx): string {
  // 1. Never cross-language. A /de/ page canonicalises to itself, never to /nl/.
  // 2. Never cross-host except subdomain -> primary custom domain (§6.4).
  // 3. Query is dropped entirely for content pages.
  //    Blog pagination keeps ?page via a PATH segment instead: /nl/blog/pagina/2/
  // 4. Paginated pages SELF-canonicalise. Never canonicalise page 2 to page 1
  //    (it hides the deeper posts from discovery).
  // 5. Filter/sort views are noindex,follow — not canonicalised away, because a
  //    canonical is a hint and a noindex is a directive.
  return `https://${host}${path}`;   // path already satisfies I3/I4
}
```

Self-referencing canonical on **every** `200` HTML response, including `noindex` ones (a canonical on a noindex page is harmless and prevents URL-parameter duplicates from being treated as separate). The single exception: never emit `<link rel=canonical>` on a page that also emits `noindex` *and* is a paginated/filtered variant — there, `noindex, follow` alone is correct.

`utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `ref` are stripped by the Worker with a `308` to the clean URL **only for bots**; for humans, keep them (analytics) and rely on the canonical. Bot detection here is safe because it is not cloaking — the *content* is identical, only the URL shape differs.

### 1.7 Adding the 7th locale is a config change

The full diff to ship Italian:

```sql
-- 1. Global registry: one row.
INSERT INTO locales (code, english_name, native_name, hreflang, url_segment, direction, sort_order, created_at)
VALUES ('it','Italian','Italiano','it','it','ltr', 70, unixepoch()*1000);

-- 2. Per site that wants it: one row.
INSERT INTO site_locales (site_id, locale, url_segment, is_default, is_enabled, translation_status, sort_order, created_at, updated_at)
VALUES ('ste_…','it','it',0,1,'pending',70,unixepoch()*1000,unixepoch()*1000);

-- 3. One page_translations row per page, produced by the translation job.
```

Nothing else. Specifically, **zero** code changes, because:

- The router builds its locale matcher from the table: `^/(en|nl|de|fr|es|pt|it)/` is compiled at Worker cold start from `SELECT url_segment FROM locales WHERE is_active = 1`, cached in module scope with a 60 s TTL and a KV-backed version stamp so a locale insert propagates without a deploy.
- The hreflang builder iterates `site_locales` (§1.5).
- The sitemap index iterates `site_locales` (§2.1).
- The language switcher iterates `site_locales`.
- The AI translation job selects `(page_id, locale)` pairs where `page_translations` has no row — adding a locale automatically produces exactly the missing work items, and `translation_status` tracks it.
- UI strings live in `src/shared/i18n/<code>.json`; a missing file falls back to `en` at build time with a CI warning, so the site is never broken by a half-shipped locale.
- `industry_translations` gets its label rows the same way.

The only thing that is *not* a config change is RTL (`direction = 'rtl'` for `ar`/`he`), which needs logical CSS properties. Write the CSS with `margin-inline-start`, `padding-inline`, `inset-inline-start`, `text-align: start` from day one and even that becomes free.

---

## 2. Sitemaps and robots.txt

### 2.1 Shape

```
https://<host>/sitemap.xml            ← sitemap index, ALWAYS this URL
https://<host>/sitemaps/nl.xml        ← per-locale, pages
https://<host>/sitemaps/nl-blog.xml   ← per-locale, blog posts (split at 2 000 URLs)
https://<host>/sitemaps/nl-images.xml ← per-locale, image sitemap
…
```

Per-locale files, not one big file, for three concrete reasons: Search Console reports index coverage **per submitted sitemap**, so "German isn't indexing" is a one-glance diagnosis instead of a spreadsheet exercise; a locale republish only invalidates one object in R2; and it keeps each file trivially under the 50 000-URL / 50 MB caps even for a blog-heavy tenant.

**Index:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://bakkerij-jansen.mijnsaas.com/sitemaps/nl.xml</loc>
    <lastmod>2026-09-04T09:12:31+02:00</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://bakkerij-jansen.mijnsaas.com/sitemaps/nl-blog.xml</loc>
    <lastmod>2026-08-28T14:03:00+02:00</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://bakkerij-jansen.mijnsaas.com/sitemaps/en.xml</loc>
    <lastmod>2026-09-04T09:12:31+02:00</lastmod>
  </sitemap>
</sitemapindex>
```

**Per-locale sitemap, with the hreflang cluster repeated per URL** (belt-and-braces with the `<head>` links; Google explicitly permits and merges both):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://bakkerij-jansen.mijnsaas.com/nl/diensten/</loc>
    <lastmod>2026-09-04T09:12:31+02:00</lastmod>
    <xhtml:link rel="alternate" hreflang="nl"        href="https://bakkerij-jansen.mijnsaas.com/nl/diensten/"/>
    <xhtml:link rel="alternate" hreflang="en"        href="https://bakkerij-jansen.mijnsaas.com/en/services/"/>
    <xhtml:link rel="alternate" hreflang="de"        href="https://bakkerij-jansen.mijnsaas.com/de/leistungen/"/>
    <xhtml:link rel="alternate" hreflang="fr"        href="https://bakkerij-jansen.mijnsaas.com/fr/services/"/>
    <xhtml:link rel="alternate" hreflang="es"        href="https://bakkerij-jansen.mijnsaas.com/es/servicios/"/>
    <xhtml:link rel="alternate" hreflang="pt"        href="https://bakkerij-jansen.mijnsaas.com/pt/servicos/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="https://bakkerij-jansen.mijnsaas.com/nl/diensten/"/>
    <image:image>
      <image:loc>https://bakkerij-jansen.mijnsaas.com/_a/brood-3f9a1c.avif</image:loc>
    </image:image>
  </url>
</urlset>
```

Note the self-referencing `xhtml:link` — required. A `<url>` inside `nl.xml` that lists `en`/`de` but not `nl` is an invalid cluster.

**Omit `<changefreq>` and `<priority>` entirely.** Google ignores both; they are pure bytes and a source of "our priority is 1.0 everywhere" noise. Drop `pages.sitemap_priority` from the emitter (keep the column, it is harmless, but do not serialise it).

### 2.2 lastmod discipline

This is where most generated-site platforms self-destruct. Google *does* use `lastmod` for crawl scheduling, and it *does* start ignoring the whole sitemap when it detects lastmod is uncorrelated with actual change.

**Rule: `lastmod` = the timestamp at which the rendered, user-visible content of that URL last changed. Nothing else moves it.**

```
lastmod MUST move on:      body copy edit, title/meta edit, image swap, price change,
                           opening-hours change, new/removed section, translation update
lastmod MUST NOT move on:  deploy, template/CSS change, footer year rollover, republish
                           with identical content, sitemap regeneration, cache purge,
                           a change in a DIFFERENT locale of the same page
```

Implementation: a content hash, not a timestamp, is the source of truth.

```sql
-- 0010, additive
ALTER TABLE page_translations ADD COLUMN render_sha256      TEXT;    -- hash of the RENDERED semantic content
ALTER TABLE page_translations ADD COLUMN content_changed_at INTEGER; -- lastmod, ms
```

```ts
// at publish, per (page, locale):
const semantic = canonicalJson({            // deliberately excludes anything cosmetic
  title, meta_description, blocks: stripStyling(tree), jsonld, images: imageIds,
});
const sha = await sha256Hex(semantic);
if (sha !== row.render_sha256) {
  await db.prepare(
    `UPDATE page_translations SET render_sha256=?, content_changed_at=?, updated_at=? WHERE id=?`
  ).bind(sha, now, now, row.id).run();
}
// lastmod  = content_changed_at
// index lastmod = MAX(content_changed_at) over that sitemap's URLs
```

Format: W3C Datetime with an offset — `2026-09-04T09:12:31+02:00`. Date-only (`2026-09-04`) is legal but throws away the intraday signal; use full precision. Never emit a future timestamp.

Blog posts: `lastmod` = `MAX(datePublished, dateModified)`, and `dateModified` in the JSON-LD must equal it (§3.7). An inconsistency between the two is a quality signal Google actively checks.

### 2.3 robots.txt — per host, per state

`robots.txt` is scoped to **scheme + host + port**. `bakkerij-jansen.mijnsaas.com/robots.txt` is a completely separate file from `mijnsaas.com/robots.txt` and from `bakkerijjansen.nl/robots.txt`. The Worker must synthesise one per `Host` header. Three states:

**(a) `sites.status IN ('onboarding','generating','draft')` — never been public:**

```
User-agent: *
Disallow: /
```
plus, on **every** response from that host:
```
X-Robots-Tag: noindex, nofollow, noarchive
```
plus Cloudflare Access or a signed preview token on `*.preview.mijnsaas.com`. Belt, braces, and a lock.

**(b) `sites.status = 'published'` and `index_state = 'index'`:**

```
User-agent: *
Allow: /

# Never crawl these — they are not content and produce soft-404 noise.
Disallow: /api/
Disallow: /_edit/
Disallow: /*?utm_
Disallow: /*?fbclid

Sitemap: https://bakkerijjansen.nl/sitemap.xml
```

Two details: the `Sitemap:` line must use the **canonical host** (custom domain once primary, §6.4), and there is exactly one `Sitemap:` line — pointing at the index, not at each child.

**(c) De-indexing a site that was public (churned, suspended, downgraded):**

This is the trap almost everyone falls into. **`Disallow` does not de-index.** If you block crawling, Googlebot can no longer fetch the page, therefore cannot see your `noindex`, therefore the URL stays in the index (often as a "Indexed, though blocked by robots.txt" entry with a scraped SERP snippet — the worst possible outcome for your apex's reputation).

Correct sequence:

```
Phase 1 (day 0 – 30):  robots.txt ALLOWS crawling.
                       Every page: 200 OK, X-Robots-Tag: noindex, follow
                       Sitemaps still served, lastmod bumped once, so Google recrawls fast.
Phase 2 (day 30+):     Every content URL: 410 Gone (not 404 — 410 drops faster and
                       signals intent). robots.txt may now Disallow.
                       sitemap.xml: 410.
```

Never leave a churned tenant serving a live-looking page — that is how the apex becomes a farm of abandoned thin sites (§6).

### 2.4 Generated on publish, materialised to R2

**Decision: materialise at publish. Do not generate per request.**

Per-request generation means every one of ~10 000 tenants × every bot fetch runs a D1 query set, and worse, means `lastmod` is computed at read time, which is precisely how you end up with "lastmod is always now" and get your sitemaps ignored.

Publish pipeline (runs inside the existing `deployments` flow):

```ts
// src/worker/publish/sitemaps.ts
async function materialiseSitemaps(env: Env, site: Site, version: SiteVersion) {
  const locales = await enabledLocales(env.DB, site.id);
  const index: IndexEntry[] = [];

  for (const l of locales) {
    const rows = await env.DB.prepare(`
      SELECT pt.path, pt.content_changed_at, p.page_key, p.is_indexable
      FROM page_translations pt
      JOIN pages p ON p.id = pt.page_id
      WHERE pt.site_version_id = ?1 AND pt.locale = ?2 AND p.is_indexable = 1
      ORDER BY p.sort_order, pt.path
    `).bind(version.id, l.locale).all<Row>();

    const xml   = renderUrlset(rows.results, clusterIndex, site.canonical_host);
    const body  = await brotli(xml, 11);                       // pre-compressed, quality 11
    const key   = `sites/${site.id}/${version.id}/sitemaps/${l.url_segment}.xml.br`;
    await env.BLOBS.put(key, body, {
      httpMetadata: { contentType: 'application/xml; charset=utf-8', contentEncoding: 'br' },
    });
    index.push({ loc: `/sitemaps/${l.url_segment}.xml`, lastmod: maxLastmod(rows.results) });
  }

  await env.BLOBS.put(
    `sites/${site.id}/${version.id}/sitemaps/index.xml.br`,
    await brotli(renderIndex(index, site.canonical_host), 11),
    { httpMetadata: { contentType: 'application/xml; charset=utf-8', contentEncoding: 'br' } },
  );
}
```

Serving: the R2 key contains `version.id`, so **publishing is the cache purge** — the Worker resolves `sites.published_version_id` (cached in KV, 60 s) and reads a different key. No purge API call, no propagation delay, no stale-sitemap window.

```
GET /sitemap.xml
  Content-Type: application/xml; charset=utf-8
  Content-Encoding: br
  Cache-Control: public, max-age=600
  Cloudflare-CDN-Cache-Control: public, max-age=3600, stale-while-revalidate=86400
  X-Robots-Tag: noindex        # sitemaps should not appear in results
```

**On publish, also ping IndexNow** (Google killed its sitemap ping endpoint in June 2023; Bing/Yandex/Seznam/Naver honour IndexNow, and Cloudflare's Crawler Hints does it for you if enabled — but do it explicitly so you control the URL list):

```ts
await fetch('https://api.indexnow.org/IndexNow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: site.canonical_host,
    key: env.INDEXNOW_KEY,                                        // served at /<key>.txt
    keyLocation: `https://${site.canonical_host}/${env.INDEXNOW_KEY}.txt`,
    urlList: changedUrls.slice(0, 10_000),                        // ONLY changed URLs
  }),
});
```

Only submit URLs whose `render_sha256` actually changed. Submitting everything on every publish gets your key throttled.

**Image sitemaps** are worth it for local businesses (image results drive real foot traffic for restaurants/salons). **Video sitemaps / `VideoObject` are not** — the hero loop is decorative b-roll with no title, description, or standalone value. Marking it up as a video is at best ignored and at worst a "misleading structured data" quality problem. Only emit `VideoObject` when the tenant uploads a real video with a title, and gate it behind that condition in the emitter.

---

## 3. Structured data

### 3.1 One `@graph` per page, stable `@id`s

One `<script type="application/ld+json">` per page. Not five. A single `@graph` with `@id` cross-references de-duplicates the entity, is ~40% smaller, and makes the "which node is the primary entity" question unambiguous.

**`@id` scoping rule — this is the multilingual subtlety:**

| node | `@id` | scope |
|---|---|---|
| `Organization` / `LocalBusiness` | `https://host/#business` | **one per site**, no locale — it is the same real-world business in every language |
| `WebSite` | `https://host/#website` | one per site |
| `WebPage` | `https://host/nl/diensten/#webpage` | **per locale**, equals the canonical URL |
| `BreadcrumbList` | `https://host/nl/diensten/#breadcrumb` | per locale |
| `ImageObject` | `https://host/#logo`, `…/_a/x.avif#image` | per asset |

Putting the locale in the business `@id` splits one entity into six, which is the opposite of what you want in the Knowledge Graph.

### 3.2 `@type` refinement per industry

`industries.schema_org_type` already exists and defaults to `LocalBusiness`. Seed it, and **validate against a compiled allowlist at emit time** — an invented type (`PhotographyBusiness`, `DJService`) silently disables every rich result on the page.

```sql
-- 0010 seed / update. Emit as ["LocalBusiness", "<specific>"] where <specific> is a
-- LocalBusiness subtype; emit a single type when it already IS LocalBusiness.
UPDATE industries SET schema_org_type = 'Restaurant'            WHERE key = 'restaurant';
UPDATE industries SET schema_org_type = 'CafeOrCoffeeShop'      WHERE key = 'cafe';
UPDATE industries SET schema_org_type = 'Bakery'                WHERE key = 'bakery';
UPDATE industries SET schema_org_type = 'BarOrPub'              WHERE key = 'bar';
UPDATE industries SET schema_org_type = 'NightClub'             WHERE key = 'nightclub';
UPDATE industries SET schema_org_type = 'FastFoodRestaurant'    WHERE key = 'takeaway';
UPDATE industries SET schema_org_type = 'IceCreamShop'          WHERE key = 'ice_cream';
UPDATE industries SET schema_org_type = 'Brewery'               WHERE key = 'brewery';
UPDATE industries SET schema_org_type = 'HairSalon'             WHERE key = 'hairdresser';
UPDATE industries SET schema_org_type = 'BeautySalon'           WHERE key = 'beauty_salon';
UPDATE industries SET schema_org_type = 'NailSalon'             WHERE key = 'nail_salon';
UPDATE industries SET schema_org_type = 'DaySpa'                WHERE key = 'spa';
UPDATE industries SET schema_org_type = 'TattooParlor'          WHERE key = 'tattoo';
UPDATE industries SET schema_org_type = 'HealthClub'            WHERE key = 'gym';
UPDATE industries SET schema_org_type = 'ExerciseGym'           WHERE key = 'fitness';
UPDATE industries SET schema_org_type = 'Dentist'               WHERE key = 'dentist';
UPDATE industries SET schema_org_type = 'Physician'             WHERE key = 'doctor';
UPDATE industries SET schema_org_type = 'MedicalClinic'         WHERE key = 'clinic';
UPDATE industries SET schema_org_type = 'Optician'              WHERE key = 'optician';
UPDATE industries SET schema_org_type = 'Pharmacy'              WHERE key = 'pharmacy';
UPDATE industries SET schema_org_type = 'VeterinaryCare'        WHERE key = 'vet';
UPDATE industries SET schema_org_type = 'Plumber'               WHERE key = 'plumber';
UPDATE industries SET schema_org_type = 'Electrician'           WHERE key = 'electrician';
UPDATE industries SET schema_org_type = 'HVACBusiness'          WHERE key = 'hvac';
UPDATE industries SET schema_org_type = 'RoofingContractor'     WHERE key = 'roofer';
UPDATE industries SET schema_org_type = 'HousePainter'          WHERE key = 'painter';
UPDATE industries SET schema_org_type = 'Locksmith'             WHERE key = 'locksmith';
UPDATE industries SET schema_org_type = 'MovingCompany'         WHERE key = 'movers';
UPDATE industries SET schema_org_type = 'GeneralContractor'     WHERE key = 'contractor';
UPDATE industries SET schema_org_type = 'AutoRepair'            WHERE key = 'garage';
UPDATE industries SET schema_org_type = 'AutoDealer'            WHERE key = 'car_dealer';
UPDATE industries SET schema_org_type = 'AutoWash'              WHERE key = 'car_wash';
UPDATE industries SET schema_org_type = 'RealEstateAgent'       WHERE key = 'estate_agent';
UPDATE industries SET schema_org_type = 'Attorney'              WHERE key = 'lawyer';
UPDATE industries SET schema_org_type = 'Notary'                WHERE key = 'notary';
UPDATE industries SET schema_org_type = 'AccountingService'     WHERE key = 'accountant';
UPDATE industries SET schema_org_type = 'InsuranceAgency'       WHERE key = 'insurance';
UPDATE industries SET schema_org_type = 'TravelAgency'          WHERE key = 'travel_agency';
UPDATE industries SET schema_org_type = 'ChildCare'             WHERE key = 'childcare';
UPDATE industries SET schema_org_type = 'Florist'               WHERE key = 'florist';
UPDATE industries SET schema_org_type = 'ClothingStore'         WHERE key = 'clothing';
UPDATE industries SET schema_org_type = 'JewelryStore'          WHERE key = 'jeweller';
UPDATE industries SET schema_org_type = 'PetStore'              WHERE key = 'pet_shop';
UPDATE industries SET schema_org_type = 'BookStore'             WHERE key = 'bookshop';
UPDATE industries SET schema_org_type = 'HardwareStore'         WHERE key = 'hardware';
UPDATE industries SET schema_org_type = 'BikeStore'             WHERE key = 'bike_shop';
UPDATE industries SET schema_org_type = 'GroceryStore'          WHERE key = 'grocery';
UPDATE industries SET schema_org_type = 'Hotel'                 WHERE key = 'hotel';
UPDATE industries SET schema_org_type = 'BedAndBreakfast'       WHERE key = 'bnb';
UPDATE industries SET schema_org_type = 'DryCleaningOrLaundry'  WHERE key = 'laundry';
UPDATE industries SET schema_org_type = 'SelfStorage'           WHERE key = 'storage';
UPDATE industries SET schema_org_type = 'EmploymentAgency'      WHERE key = 'recruitment';
UPDATE industries SET schema_org_type = 'ArtGallery'            WHERE key = 'gallery';
-- No LocalBusiness subtype exists for these. ProfessionalService is the correct fallback.
UPDATE industries SET schema_org_type = 'ProfessionalService'
  WHERE key IN ('dj','photographer','videographer','wedding_planner','event_agency',
                'personal_trainer','coach','consultant','designer','translator',
                'cleaning','gardener','catering','music_teacher','driving_school');
```

The DJ from the blueprint is `ProfessionalService`. Do **not** invent `DJService`. Optionally add a second `@type` from a *non*-LocalBusiness branch where it is genuinely true — a DJ who performs is also a `MusicGroup`:

```json
"@type": ["LocalBusiness", "ProfessionalService"]
```

Emit-time guard:

```ts
import { LOCALBUSINESS_SUBTYPES } from './schema-allowlist';   // generated from schema.org JSON-LD context
export function businessType(key: string): string | string[] {
  const t = INDUSTRY_TYPE[key] ?? 'LocalBusiness';
  if (t === 'LocalBusiness') return 'LocalBusiness';
  if (!LOCALBUSINESS_SUBTYPES.has(t)) {
    throw new Error(`schema_org_type "${t}" for industry "${key}" is not a LocalBusiness subtype`);
  }
  return ['LocalBusiness', t];
}
```

### 3.3 The home-page `@graph` (complete, real)

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://bakkerij-jansen.mijnsaas.com/#website",
      "url": "https://bakkerij-jansen.mijnsaas.com/",
      "name": "Bakkerij Jansen",
      "publisher": { "@id": "https://bakkerij-jansen.mijnsaas.com/#business" },
      "inLanguage": ["nl", "en", "de"],
      "potentialAction": {
        "@type": "SearchAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": "https://bakkerij-jansen.mijnsaas.com/nl/zoeken/?q={search_term_string}"
        },
        "query-input": "required name=search_term_string"
      }
    },
    {
      "@type": ["LocalBusiness", "Bakery"],
      "@id": "https://bakkerij-jansen.mijnsaas.com/#business",
      "name": "Bakkerij Jansen",
      "legalName": "Bakkerij Jansen B.V.",
      "url": "https://bakkerij-jansen.mijnsaas.com/nl/",
      "description": "Ambachtelijke bakkerij in Amsterdam-Oost sinds 1962. Dagelijks vers desembrood, taarten op bestelling en koffie.",
      "image": [
        "https://bakkerij-jansen.mijnsaas.com/_a/gevel-1x1-3f9a1c.avif",
        "https://bakkerij-jansen.mijnsaas.com/_a/gevel-4x3-3f9a1c.avif",
        "https://bakkerij-jansen.mijnsaas.com/_a/gevel-16x9-3f9a1c.avif"
      ],
      "logo": {
        "@type": "ImageObject",
        "@id": "https://bakkerij-jansen.mijnsaas.com/#logo",
        "url": "https://bakkerij-jansen.mijnsaas.com/_a/logo-8b21e0.png",
        "width": 512, "height": 512,
        "caption": "Bakkerij Jansen"
      },
      "telephone": "+31205551234",
      "email": "info@bakkerijjansen.nl",
      "vatID": "NL812345678B01",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "Javastraat 118",
        "addressLocality": "Amsterdam",
        "addressRegion": "NH",
        "postalCode": "1094 HP",
        "addressCountry": "NL"
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": 52.3624,
        "longitude": 4.9328
      },
      "hasMap": "https://www.google.com/maps/place/?q=place_id:ChIJdXXXXXXXXXXXXXX",
      "sameAs": [
        "https://www.google.com/maps/place/?q=place_id:ChIJdXXXXXXXXXXXXXX",
        "https://www.instagram.com/bakkerijjansen",
        "https://www.facebook.com/bakkerijjansen"
      ],
      "priceRange": "€€",
      "currenciesAccepted": "EUR",
      "paymentAccepted": "Cash, Debit Card, iDEAL, Credit Card",
      "openingHoursSpecification": [
        { "@type": "OpeningHoursSpecification",
          "dayOfWeek": ["Tuesday","Wednesday","Thursday","Friday"],
          "opens": "07:00", "closes": "18:00" },
        { "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Saturday", "opens": "07:00", "closes": "17:00" },
        { "@type": "OpeningHoursSpecification",
          "dayOfWeek": "Sunday", "opens": "09:00", "closes": "13:00" },
        { "@type": "OpeningHoursSpecification",
          "dayOfWeek": ["Monday"], "opens": "00:00", "closes": "00:00" }
      ],
      "specialOpeningHoursSpecification": [
        { "@type": "OpeningHoursSpecification",
          "opens": "00:00", "closes": "00:00",
          "validFrom": "2026-12-25", "validThrough": "2026-12-26" }
      ],
      "areaServed": [
        { "@type": "City", "name": "Amsterdam",
          "containedInPlace": { "@type": "AdministrativeArea", "name": "Noord-Holland" } },
        { "@type": "City", "name": "Diemen" }
      ],
      "knowsLanguage": ["nl", "en", "de"],
      "parentOrganization": { "@id": "https://bakkerij-jansen.mijnsaas.com/#business" },
      "makesOffer": [
        { "@type": "Offer",
          "itemOffered": { "@type": "Service", "@id": "https://bakkerij-jansen.mijnsaas.com/#svc-taarten" } }
      ]
    },
    {
      "@type": "WebPage",
      "@id": "https://bakkerij-jansen.mijnsaas.com/nl/#webpage",
      "url": "https://bakkerij-jansen.mijnsaas.com/nl/",
      "name": "Bakkerij Jansen — Ambachtelijk desembrood in Amsterdam-Oost",
      "description": "Dagelijks vers desembrood, taarten op bestelling en koffie. Javastraat 118, Amsterdam. Open di t/m zo.",
      "isPartOf": { "@id": "https://bakkerij-jansen.mijnsaas.com/#website" },
      "about":    { "@id": "https://bakkerij-jansen.mijnsaas.com/#business" },
      "inLanguage": "nl",
      "datePublished": "2026-03-11T10:00:00+01:00",
      "dateModified":  "2026-09-04T09:12:31+02:00",
      "primaryImageOfPage": {
        "@type": "ImageObject",
        "url": "https://bakkerij-jansen.mijnsaas.com/_a/hero-land-3f9a1c.avif",
        "width": 1920, "height": 1080
      },
      "breadcrumb": { "@id": "https://bakkerij-jansen.mijnsaas.com/nl/#breadcrumb" }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://bakkerij-jansen.mijnsaas.com/nl/#breadcrumb",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home",
          "item": "https://bakkerij-jansen.mijnsaas.com/nl/" }
      ]
    }
  ]
}
</script>
```

### 3.4 `openingHoursSpecification` from the onboarding form

`sites.opening_hours` is a JSON TEXT column. Canonical internal shape:

```json
{
  "tz": "Europe/Amsterdam",
  "days": {
    "mo": [],
    "tu": [["07:00","18:00"]],
    "we": [["07:00","18:00"]],
    "th": [["07:00","18:00"]],
    "fr": [["07:00","18:00"]],
    "sa": [["07:00","17:00"]],
    "su": [["09:00","13:00"]]
  },
  "exceptions": [
    { "from": "2026-12-25", "to": "2026-12-26", "closed": true },
    { "from": "2026-07-15", "to": "2026-08-05", "closed": true, "note": "zomersluiting" }
  ]
}
```

Emitter rules — every one of these is a real bug someone ships:

| case | markup |
|---|---|
| Normal day | one spec, `opens`/`closes` in **`HH:MM`, 24-hour, no timezone suffix** |
| Split shift (lunch closure) | **two** specs for the same day: `["12:00"→"14:00"]` gap means `09:00–12:00` and `14:00–18:00` |
| Closed all day | `"opens": "00:00", "closes": "00:00"` — this is Google's documented way to say "closed". Omitting the day is also accepted but is ambiguous; emit it explicitly. |
| Open 24 h | `"opens": "00:00", "closes": "23:59"` |
| Crosses midnight (club open till 04:00) | `"opens": "22:00", "closes": "04:00"` — a `closes` earlier than `opens` is understood as next-day |
| Identical hours on several days | collapse into one spec with a `dayOfWeek` **array** — smaller and equally valid |
| Seasonal | `validFrom` / `validThrough` on an `openingHoursSpecification` |
| Holidays | `specialOpeningHoursSpecification` (a property of `Place`), *not* `openingHours` |

`dayOfWeek` values must be the schema.org enumeration URLs or their short names: `Monday`…`Sunday` (also accepted: `https://schema.org/Monday`). Never `Mo`, `MON`, or a locale-translated name — the JSON-LD stays English even on `/de/`.

The visible HTML must show the same hours (Google cross-checks); render them with `<time>` and locale-formatted day names.

### 3.5 `geo`, `areaServed`, `sameAs`

- **`geo`: only emit real coordinates.** `sites.latitude`/`longitude` are nullable with `CHECK` ranges — good. If geocoding failed, **omit `geo` entirely**. A guessed city-centre coordinate for a business that is 4 km away is worse than nothing: it contradicts the address and can suppress the local pack. Geocode at onboarding (server-side, from `address_line1 + postal_code + country`), then show the user a map pin they can drag; store `geo_source ∈ ('geocoded','user_pin','gbp','none')` and only emit for the first three.
- **`areaServed`** is for who you serve; **`address` + `geo`** is where you are. A plumber with no storefront should emit `areaServed` plus:
  ```json
  "areaServed": {
    "@type": "GeoCircle",
    "geoMidpoint": { "@type": "GeoCoordinates", "latitude": 52.3676, "longitude": 4.9041 },
    "geoRadius": "25000"
  }
  ```
  (`geoRadius` is metres, as a string.) For service-area businesses that hide their address, *still* provide `address` with at least `addressLocality` + `addressCountry`, and consider `Organization` rather than `LocalBusiness` — Google requires an address for local rich results, so this is a conscious trade-off the onboarding should surface.
- **`sameAs`**: the Google Business Profile URL from onboarding, plus socials. Normalise the GBP link — users paste `https://g.page/xyz` or `https://maps.app.goo.gl/abc`, which are shorteners. Resolve them once at onboarding (follow the redirect server-side), extract the `place_id` or `cid`, and store the stable form `https://www.google.com/maps/place/?q=place_id:ChIJ…`. Put that same URL in `hasMap`. Never put a shortener in `sameAs`.
- Do **not** put the tenant's own URL in `sameAs` (that is `url`), and do not put `mijnsaas.com` in it.

### 3.6 `aggregateRating` — what is legal to emit

**Default: emit no `aggregateRating` and no `review` on `LocalBusiness`. Ever. Unless a hard gate passes.**

Three independent reasons, all of which bind:

1. **Google policy.** Since September 2019, *self-serving reviews* — reviews about a `LocalBusiness` or `Organization` collected or hosted by that entity on its own site — are **not eligible for review rich results**. So the best case for a hand-typed testimonial with 5 stars is that it does nothing. The realistic case is a "Review snippets" structured-data warning, and the bad case is a manual action for spammy structured markup.
2. **EU consumer law.** Directive (EU) 2019/2161 ("Omnibus"), transposed into the UCP Directive Annex I points 23b/23c, makes it a *per se* unfair commercial practice to state that reviews are from consumers who used the product without taking reasonable steps to verify it, and to submit or commission fake reviews. Penalties are up to 4% of annual turnover in the Member State. In NL this is Art. 6:193g BW; DE §5b UWG; FR Art. L121-4 Code de la consommation. Traders must also disclose *whether and how* they verify reviews (UCP Art. 7(6)). A website builder that auto-emits `"ratingValue": "4.8", "reviewCount": "127"` for a business with zero reviews is manufacturing a criminal-adjacent liability for its customer.
3. **Scraping GBP is a licence breach.** Copying Google reviews into your own `aggregateRating` violates Google Maps Platform terms and is also self-serving-by-proxy.

**The gate, in code:**

```ts
// src/shared/seo/reviews.ts
type ReviewsSource = 'none' | 'manual_testimonial' | 'verified_platform';

export function aggregateRatingNode(site: Site, rows: SiteReview[]): object | undefined {
  if (site.reviews_source !== 'verified_platform') return undefined;   // hard gate
  const rated = rows.filter(r => r.rating != null && r.is_published && r.verified_at != null);
  if (rated.length < 1) return undefined;
  const sum = rated.reduce((a, r) => a + r.rating!, 0);
  const value = +(sum / rated.length).toFixed(1);
  if (!(value >= 1 && value <= 5)) throw new Error('ratingValue out of range');
  return {
    '@type': 'AggregateRating',
    ratingValue: value,
    reviewCount: rated.length,          // reviewCount = has text; ratingCount = rating only
    bestRating: 5, worstRating: 1,
  };
}
```

- `reviews_source = 'none'` → nothing. This is the default for every generated site.
- `reviews_source = 'manual_testimonial'` → render the testimonials as **plain visible HTML** (`<figure><blockquote>…<figcaption>`), with **no** `Review` and **no** `aggregateRating` markup, plus the Omnibus-required disclosure line ("Deze reviews zijn door de ondernemer aangeleverd en niet onafhankelijk geverifieerd.").
- `reviews_source = 'verified_platform'` → only when the tenant has connected a real review platform (Trustpilot / Kiyoh / Feedback Company) whose terms permit republishing with markup, we store individual rows in `site_reviews` with `verified_at` and `external_id`, and we display every one of them on the page. Aggregate must be computed from displayed reviews, never entered by hand.
- The live editor must not expose a free-text "rating" field. If a user pastes stars into a heading, that's their content, but we never mark it up.

`0010` additions: `sites.reviews_source TEXT NOT NULL DEFAULT 'none' CHECK (…)`, and on `site_reviews`: `verified_at INTEGER`, `external_id TEXT`, `source TEXT`.

### 3.7 The other node types

**BreadcrumbList** — locale root is always position 1, and its `name` is the localised word for "Home", not the business name:

```json
{
  "@type": "BreadcrumbList",
  "@id": "https://bakkerij-jansen.mijnsaas.com/nl/blog/desem-bewaren/#breadcrumb",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home",
      "item": "https://bakkerij-jansen.mijnsaas.com/nl/" },
    { "@type": "ListItem", "position": 2, "name": "Blog",
      "item": "https://bakkerij-jansen.mijnsaas.com/nl/blog/" },
    { "@type": "ListItem", "position": 3, "name": "Desembrood goed bewaren" }
  ]
}
```

Last item: **no `item`** (it is the current page). Every crumb must correspond to a real, crawlable URL and to the visible breadcrumb nav.

**BlogPosting** — the author question is where AI-generated sites get it wrong:

```json
{
  "@type": "BlogPosting",
  "@id": "https://bakkerij-jansen.mijnsaas.com/nl/blog/desem-bewaren/#article",
  "isPartOf": { "@id": "https://bakkerij-jansen.mijnsaas.com/nl/blog/desem-bewaren/#webpage" },
  "mainEntityOfPage": { "@id": "https://bakkerij-jansen.mijnsaas.com/nl/blog/desem-bewaren/#webpage" },
  "headline": "Desembrood goed bewaren: 5 tips van onze bakker",
  "description": "Zo blijft je desembrood vier dagen vers — zonder plastic, zonder vriezer.",
  "image": {
    "@type": "ImageObject",
    "url": "https://bakkerij-jansen.mijnsaas.com/_a/blog-desem-16x9-a71f04.avif",
    "width": 1600, "height": 900
  },
  "datePublished": "2026-04-02T08:00:00+02:00",
  "dateModified":  "2026-08-28T14:03:00+02:00",
  "inLanguage": "nl",
  "wordCount": 812,
  "author":    { "@id": "https://bakkerij-jansen.mijnsaas.com/#business" },
  "publisher": { "@id": "https://bakkerij-jansen.mijnsaas.com/#business" },
  "articleSection": "Bakkerstips"
}
```

- `author` is the **Organization**, not an invented person. Never generate `"author": {"@type":"Person","name":"Sarah de Vries"}` for a person who does not exist — that is fabricated E-E-A-T and is precisely what Google's scaled-content-abuse policy targets. If the tenant supplies a real owner name during onboarding, upgrade to a `Person` node with a matching visible byline and an `/nl/over-ons/` page as `mainEntityOfPage`.
- `headline` ≤ 110 characters.
- `dateModified` must equal `page_translations.content_changed_at` (§2.2). Do not bump it on republish.
- `image` must be ≥ 1200 px wide and actually appear on the page.

**FAQPage** — be honest about the value:

```json
{
  "@type": "FAQPage",
  "@id": "https://bakkerij-jansen.mijnsaas.com/nl/veelgestelde-vragen/#faq",
  "inLanguage": "nl",
  "mainEntity": [
    { "@type": "Question",
      "name": "Kan ik een taart online bestellen?",
      "acceptedAnswer": { "@type": "Answer",
        "text": "Ja. Bestel minimaal 48 uur van tevoren via het contactformulier of bel +31 20 555 1234. Wij bevestigen dezelfde dag." } }
  ]
}
```

Since August 2023 Google restricts FAQ rich results to well-known authoritative government and health sites, so **a bakery will not get FAQ rich results from this**. Emit it anyway — it is ~600 bytes, it is a clean semantic signal for AI Overviews / LLM retrieval / Bing, and it costs nothing. But do not let the generator create an FAQ *section* purely to farm markup: emit `FAQPage` **only when a visible Q&A block exists on that page**, and never on a page that also emits `Article`/`BlogPosting` unless the FAQ is a real section of it. Same for `HowTo` — the rich result was retired in September 2023; do not generate HowTo pages for the markup.

**Service** — one node per service, referenced from `LocalBusiness.makesOffer`, emitted on `/nl/diensten/`:

```json
{
  "@type": "Service",
  "@id": "https://bakkerij-jansen.mijnsaas.com/#svc-taarten",
  "name": "Taarten op bestelling",
  "serviceType": "Bakery — custom cakes",
  "description": "Verjaardags-, bruilofts- en bedrijfstaarten, glutenvrij op aanvraag.",
  "provider":   { "@id": "https://bakkerij-jansen.mijnsaas.com/#business" },
  "areaServed": { "@type": "City", "name": "Amsterdam" },
  "availableChannel": {
    "@type": "ServiceChannel",
    "serviceUrl": "https://bakkerij-jansen.mijnsaas.com/nl/contact/",
    "servicePhone": { "@type": "ContactPoint", "telephone": "+31205551234" }
  },
  "offers": {
    "@type": "Offer",
    "priceCurrency": "EUR",
    "priceSpecification": {
      "@type": "PriceSpecification",
      "minPrice": 27.50, "maxPrice": 195.00, "priceCurrency": "EUR",
      "valueAddedTaxIncluded": true
    },
    "availability": "https://schema.org/InStock",
    "url": "https://bakkerij-jansen.mijnsaas.com/nl/diensten/taarten/"
  }
}
```

Prices in JSON-LD **must** match visible prices. If the tenant has no prices, omit `offers` entirely — do not emit `"price": "0"`.

**Marketing site** (`mijnsaas.com`) gets `Organization` + `WebSite` + a `SoftwareApplication` on the pricing page:

```json
{
  "@type": "SoftwareApplication",
  "@id": "https://mijnsaas.com/#app",
  "name": "aibuilder",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "Web",
  "offers": {
    "@type": "Offer",
    "price": "119.88",
    "priceCurrency": "EUR",
    "priceValidUntil": "2027-09-06",
    "url": "https://mijnsaas.com/nl/prijzen/",
    "availability": "https://schema.org/InStock",
    "priceSpecification": {
      "@type": "UnitPriceSpecification",
      "price": "9.99",
      "priceCurrency": "EUR",
      "unitCode": "MON",
      "billingIncrement": 12,
      "billingDuration": 12,
      "referenceQuantity": { "@type": "QuantitativeValue", "value": 1, "unitCode": "MON" },
      "valueAddedTaxIncluded": false
    }
  }
}
```

`€9,99/month billed annually` = `119.88` charged once. Emit **both**: the headline `price` is what the customer is actually charged, the `UnitPriceSpecification` carries the €9,99/month framing. Emitting only `9.99` as `price` when the charge is `119.88` is a price mismatch. Also note: `SoftwareApplication` needs `aggregateRating` for its rich result — see §3.6; the same gate applies to our own product.

**Note on `WebSite.potentialAction` / SearchAction:** Google retired the sitelinks searchbox rich result in November 2023. Keep the node (it is still a valid entity signal and other consumers use it), but do not expect a rendered searchbox, and do not build a site search feature *for* it.

### 3.8 Emission mechanics

```ts
// NEVER string-concatenate JSON-LD. NEVER let user text near a template literal.
export function ldScript(graph: unknown): string {
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    .replace(/</g, '\\u003c')    // kills </script> and <!-- breakouts
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/ld+json">${json}</script>`;
}
```

`page_translations.jsonld` already exists with a 16 KB cap and `json_valid()` — store the **built graph** there at publish so the render path does zero assembly work.

CI gate (`test/seo/schema.spec.ts`): for each of ~50 industry fixtures, build the graph, assert every `@type` is in the allowlist, every `@id` referenced exists as a node, every URL is absolute + https + canonical-host, `aggregateRating` is absent unless the gate passed, dates are ISO 8601 with offset, and the whole thing round-trips through a JSON-LD 1.1 expansion without warnings.

---

## 4. Core Web Vitals 100/100 with a full-screen video hero

Field targets (p75, CrUX, mobile): **LCP ≤ 2.0 s** (headroom under the 2.5 s threshold), **INP ≤ 130 ms**, **CLS ≤ 0.02**, TTFB ≤ 250 ms. Lab (Lighthouse mobile, Moto G Power throttle): 100/100/100/100.

### 4.1 The central problem, stated precisely

A `<video>` element **is an LCP candidate**. Chrome reports the video's first painted frame (and its `poster`) as LCP candidates. LCP is not "the first big paint" — it is the **largest** contentful paint seen so far, and it keeps updating until the first user interaction or until the page is hidden.

So the naive "show a poster, then fade in the video" gives you:

```
t=0.9s   poster <img> paints          → LCP candidate, size = min(intrinsic, displayed)
t=3.4s   video first frame paints     → if LARGER, a NEW LCP candidate at 3.4s
                                       → reported LCP = 3.4s. Score: fail.
```

The fix is **not** timing. Timing cannot save you, because LCP stays open until interaction and many users do not interact for 5 seconds. The fix is a **size invariant**:

> **The video's LCP size must never exceed the poster's LCP size.**

LCP size for an image/video = the area of the intersection with the viewport, **capped by the element's intrinsic (natural) size**. So:

```
poster intrinsic ≥ video intrinsic     at every breakpoint
```

Concretely: poster 1920×1080 AVIF, desktop video 1920×1080 → equal, and the algorithm only fires a new entry when the new candidate is *strictly larger*. Equal never supersedes. Add margin anyway: **poster 2400×1350, video 1920×1080** on desktop; **poster 1170×2080, video 720×1280** on mobile. Now the video is 0.64× the poster's area and can never win.

Secondary guards, in order of reliability:

1. **Size invariant** (above) — the actual guarantee. Assert it in the publish pipeline.
2. **`opacity: 0` until mounted** — Chrome excludes fully transparent elements from LCP. Covers the window before the cross-fade.
3. **Mount after LCP is observed on the poster** — cheap, and covers unusual UA behaviour.
4. **Never put `poster=` on the `<video>`.** A video with a poster makes the *video element* the LCP candidate; you then cannot control the two sizes independently, and Lighthouse attributes LCP to the video, where "video did not have a preload" audits kick in.

### 4.2 The hero markup

```html
<section class="hero" id="hero">
  <picture class="hero__media">
    <source
      media="(max-width: 767px)"
      type="image/avif"
      srcset="/_a/hero-p-780.3f9a1c.avif 780w, /_a/hero-p-1170.3f9a1c.avif 1170w"
      sizes="100vw">
    <source
      media="(max-width: 767px)"
      type="image/webp"
      srcset="/_a/hero-p-780.3f9a1c.webp 780w, /_a/hero-p-1170.3f9a1c.webp 1170w"
      sizes="100vw">
    <source
      type="image/avif"
      srcset="/_a/hero-l-1280.3f9a1c.avif 1280w, /_a/hero-l-1920.3f9a1c.avif 1920w, /_a/hero-l-2400.3f9a1c.avif 2400w"
      sizes="100vw">
    <source
      type="image/webp"
      srcset="/_a/hero-l-1280.3f9a1c.webp 1280w, /_a/hero-l-1920.3f9a1c.webp 1920w, /_a/hero-l-2400.3f9a1c.webp 2400w"
      sizes="100vw">
    <img
      class="hero__poster"
      src="/_a/hero-l-1920.3f9a1c.jpg"
      alt=""
      width="1920" height="1080"
      fetchpriority="high"
      decoding="sync">
  </picture>

  <video
    class="hero__video"
    muted loop playsinline disablepictureinpicture disableremoteplayback
    preload="none"
    aria-hidden="true"
    tabindex="-1"
    width="1920" height="1080"
    data-src-desktop-av1="/_a/hero-1920.av1.9c22d1.webm"
    data-src-desktop-h264="/_a/hero-1920.h264.9c22d1.mp4"
    data-src-mobile-av1="/_a/hero-720x1280.av1.9c22d1.webm"
    data-src-mobile-h264="/_a/hero-720x1280.h264.9c22d1.mp4"></video>

  <div class="hero__scrim" aria-hidden="true"></div>

  <div class="hero__copy">
    <h1>Ambachtelijk desembrood,<br>elke ochtend vers</h1>
    <p>Javastraat 118, Amsterdam-Oost · Open di t/m zo</p>
    <a class="btn btn--primary" href="/nl/contact/">Bestel een taart</a>
  </div>
</section>
```

Key decisions:

- `alt=""` on the poster. It is decorative; the `<h1>` carries the meaning. An `alt` describing the b-roll is screen-reader noise. **`alt=""` does not disqualify it from being the LCP element.**
- `decoding="sync"` (not `async`) on the LCP image. `async` lets the browser defer decode past the frame; for the single LCP element you want it decoded in the same frame it paints.
- No `loading` attribute → defaults to `eager`. Never `loading="lazy"` on the LCP image; it delays discovery and is an automatic Lighthouse failure.
- `preload="none"` on the video and **no `src`** — the element exists in the DOM for layout stability but generates zero network activity until JS attaches sources.
- `aria-hidden="true" tabindex="-1"` — the video is decorative; keep it out of the a11y tree and the tab order.
- `width`/`height` on both media elements → aspect ratio known before load.

### 4.3 The CSS (CLS-proof, zero reflow when the video mounts)

```css
.hero{
  position:relative;
  /* 100svh = SMALL viewport height: the value when the mobile URL bar is EXPANDED.
     It never changes as the bar collapses, so there is no resize-driven shift.
     100dvh is the trap: it changes on scroll and produces layout shifts.
     100vh is the other trap: on iOS it's the LARGE viewport, so the hero overflows
     and the CTA sits under the browser chrome. */
  min-height:100vh;                 /* fallback for very old UAs */
  min-height:100svh;
  display:grid;
  place-items:center;
  overflow:clip;
  isolation:isolate;
  background:var(--hero-bg);        /* dominant colour from media_assets.dominant_color:
                                       paints instantly, so there is no white flash and
                                       no low-entropy LCP candidate */
}

/* Poster and video occupy the EXACT same box. Mounting the video reflows nothing. */
.hero__media,
.hero__video{
  position:absolute;
  inset:0;
  z-index:-2;
  width:100%;
  height:100%;
}
.hero__poster{
  width:100%; height:100%;
  object-fit:cover;
  object-position:var(--hero-focal, 50% 50%);
}
.hero__video{
  object-fit:cover;
  object-position:var(--hero-focal, 50% 50%);
  opacity:0;                                   /* excluded from LCP while transparent */
  transition:opacity .6s ease-out;
  z-index:-1;                                  /* above poster, below scrim */
  pointer-events:none;
}
.hero__video[data-ready="1"]{ opacity:1 }

.hero__scrim{
  position:absolute; inset:0; z-index:-1;
  background:linear-gradient(180deg, rgb(0 0 0 / .28) 0%, rgb(0 0 0 / .10) 45%, rgb(0 0 0 / .45) 100%);
}
.hero__copy{ position:relative; z-index:1; text-align:center; max-width:56ch; padding:2rem 1.25rem }

/* Never animate the video in for users who asked not to see motion. */
@media (prefers-reduced-motion: reduce){
  .hero__video{ display:none !important }
  .hero__video[data-ready="1"]{ opacity:0 }
}

/* Everything below the fold: skip layout/paint until it approaches the viewport.
   contain-intrinsic-size MUST be a real estimate or you reintroduce CLS on scroll. */
.section{ content-visibility:auto; contain-intrinsic-size:auto 720px }
```

`background: var(--hero-bg)` deserves a note: `media_assets.dominant_color` already exists in the schema. Setting it as the hero background means the first paint is a full-bleed brand-coloured screen at ~200 ms, and the poster then replaces it. Chrome's low-entropy-image heuristic ignores solid-colour paints as LCP candidates, so this does not create a fake early LCP — it just removes the white flash.

### 4.4 Video attach — the exact script

```js
// src/site/js/hero-video.js  — ~980 bytes minified+brotli. No dependencies.
(() => {
  const v = document.querySelector('.hero__video');
  const img = document.querySelector('.hero__poster');
  if (!v || !img) return;

  // ---- Gate 1: user preference. Non-negotiable, checked first. ----
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches) { v.remove(); return; }

  // ---- Gate 2: connection & device. ----
  const c = navigator.connection || {};
  if (c.saveData === true) { v.remove(); return; }                       // Save-Data: on
  if (c.effectiveType && !/^(4g|5g)$/.test(c.effectiveType)) { v.remove(); return; }
  if (typeof c.downlink === 'number' && c.downlink < 1.5) { v.remove(); return; }
  if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4) { v.remove(); return; }

  // ---- Gate 3: LCP must have been recorded on the POSTER before we mount. ----
  let lcpSeen = false;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.element === img) lcpSeen = true;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { lcpSeen = true; }                                            // Safari/Firefox: no LCP API

  const mount = () => {
    if (document.visibilityState !== 'visible') return;                  // don't burn bandwidth in a bg tab
    const portrait = innerWidth < 768;
    const d = v.dataset;
    const add = (src, type) => { const s = document.createElement('source'); s.src = src; s.type = type; v.appendChild(s); };
    // AV1/WebM first (Chrome, Edge, Firefox), H.264/MP4 fallback (Safari, older).
    add(portrait ? d.srcMobileAv1  : d.srcDesktopAv1,  'video/webm; codecs="av01.0.05M.08"');
    add(portrait ? d.srcMobileH264 : d.srcDesktopH264, 'video/mp4; codecs="avc1.640028"');
    v.load();
    v.play().then(() => {
      // Only NOW does the element become visible — and only after a real frame exists.
      requestAnimationFrame(() => { v.dataset.ready = '1'; });
    }).catch(() => {
      // iOS Low Power Mode, autoplay policy, decode failure. Poster stays. No layout change.
      v.remove();
    });
  };

  // Fire after load + idle, but never before LCP was attributed to the poster.
  addEventListener('load', () => {
    const go = () => (lcpSeen ? mount() : setTimeout(go, 250));
    ('requestIdleCallback' in window)
      ? requestIdleCallback(go, { timeout: 2500 })
      : setTimeout(go, 800);
  }, { once: true });

  // Respect a mid-session preference change.
  mq.addEventListener('change', e => { if (e.matches) { v.pause(); v.remove(); } });

  // Stop decoding when scrolled away — saves battery, keeps INP clean.
  const io = new IntersectionObserver(([e]) => {
    if (!v.isConnected) return io.disconnect();
    e.isIntersecting ? v.play().catch(() => {}) : v.pause();
  }, { rootMargin: '0px' });
  io.observe(v);
})();
```

The script is inlined at the end of `<body>` inside a `<script>` (no `src`, no extra request). At <1 KB it is cheaper inline than as a cached file.

### 4.5 Encoding and serving the media

```bash
# ---------- POSTER (2400×1350 desktop, 1170×2080 portrait) ----------
# AVIF is the primary; WebP is the Safari-15-and-below fallback; JPEG is the <img src>.
avifenc --min 0 --max 40 --speed 4 --jobs 8 --yuv 420 --depth 8 \
        --cicp 1/13/6 hero-l-1920.png hero-l-1920.avif        # target ≤ 42 KB
cwebp -q 72 -m 6 -sharp_yuv hero-l-1920.png -o hero-l-1920.webp
cjpeg -quality 74 -progressive -optimize -sample 2x2 -outfile hero-l-1920.jpg hero-l-1920.ppm

# ---------- VIDEO, desktop: 1920×1080, ≤ 1.4 MB, 8 s loop, NO AUDIO TRACK ----------
ffmpeg -i master.mov -an -t 8 -vf "scale=1920:1080:flags=lanczos,fps=25" \
  -c:v libsvtav1 -crf 38 -preset 6 -svtav1-params "tune=0:film-grain=0" \
  -g 50 -pix_fmt yuv420p hero-1920.av1.webm

ffmpeg -i master.mov -an -t 8 -vf "scale=1920:1080:flags=lanczos,fps=25" \
  -c:v libx264 -profile:v high -level 4.0 -crf 27 -preset slower -tune film \
  -g 50 -pix_fmt yuv420p -movflags +faststart hero-1920.h264.mp4

# ---------- VIDEO, mobile: 720×1280 portrait crop, ≤ 550 KB ----------
ffmpeg -i master.mov -an -t 8 \
  -vf "crop=ih*9/16:ih,scale=720:1280:flags=lanczos,fps=24" \
  -c:v libsvtav1 -crf 40 -preset 6 -g 48 -pix_fmt yuv420p hero-720x1280.av1.webm
ffmpeg -i master.mov -an -t 8 \
  -vf "crop=ih*9/16:ih,scale=720:1280:flags=lanczos,fps=24" \
  -c:v libx264 -profile:v main -level 3.1 -crf 28 -preset slower \
  -g 48 -pix_fmt yuv420p -movflags +faststart hero-720x1280.h264.mp4
```

Non-obvious but load-bearing:

- **`-an` (strip audio).** Removes 15–25% of the bytes *and* removes every autoplay-policy edge case. A muted video with an audio track can still be blocked by some UA heuristics; a video with no audio track cannot.
- **`-movflags +faststart`** puts the `moov` atom at the front. Without it Safari downloads the *entire* file before the first frame.
- **Fixed 8 s and GOP = 2× fps** so the loop point is a keyframe and looping does not stutter.
- **Assert the size invariant in CI:** `poster.width * poster.height >= video.width * video.height` for each breakpoint pair, per site, at publish. Fail the publish otherwise.

**Range requests from R2** — Safari *requires* `206` support or it will not play:

```ts
// src/worker/routes/media.ts
export async function serveMedia(req: Request, env: Env, key: string): Promise<Response> {
  const range = req.headers.get('range');
  const obj = await env.MEDIA.get(key, range ? { range: req.headers } : undefined);
  if (!obj) return new Response('Not found', { status: 404 });

  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'public, max-age=31536000, immutable');   // hashed key
  h.set('cross-origin-resource-policy', 'same-origin');
  h.set('x-content-type-options', 'nosniff');

  if (obj.range && 'offset' in obj.range) {
    const start = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - start;
    h.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
    h.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers: h });
}
```

Serve media from the **same origin** as the HTML (`/_a/…`, routed by the Worker). A separate `cdn.` host costs a DNS + TLS handshake before the LCP image can even start.

### 4.6 CLS to ~0

| source | fix |
|---|---|
| Hero height on mobile | `100svh`, never `dvh`, never bare `vh` (§4.3) |
| Video mount | absolutely positioned into the poster's box, `opacity` only |
| Every image | `width`+`height` attributes; CSS `aspect-ratio` on any element whose box is CSS-driven |
| Font swap | metric-overridden fallback (§4.8) |
| Cookie banner | `position: fixed` — out of flow, so showing it shifts nothing (§5) |
| Language hint bar | `position: fixed`, same reasoning |
| Sticky WhatsApp button | `position: fixed`, present in the initial HTML, never JS-injected |
| Lazy sections | `content-visibility: auto` **with a realistic `contain-intrinsic-size`**; a wrong estimate creates shift on scroll. Compute it at publish from the rendered block heights and emit it as an inline style per section. |
| Ads / embeds | none (§4.9) |
| `@font-face` `unicode-range` splits | preload only the `latin` subset; `latin-ext` loads on demand and, because the fallback is metric-matched, its arrival shifts nothing |

### 4.7 INP with a sticky WhatsApp widget and a cookie banner

**The WhatsApp button ships zero JavaScript.**

```html
<a class="wa" 
   href="https://wa.me/31205551234?text=Hallo%20Bakkerij%20Jansen%2C%20ik%20heb%20een%20vraag"
   target="_blank" rel="noopener"
   aria-label="Stuur een WhatsApp-bericht naar Bakkerij Jansen">
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96..."/>
  </svg>
  <span class="wa__label">WhatsApp</span>
</a>
```

```css
.wa{
  position:fixed;
  inset-block-end:max(1rem, env(safe-area-inset-bottom));
  inset-inline-end:1rem;
  z-index:60;
  display:inline-flex; align-items:center; gap:.5rem;
  min-block-size:48px; min-inline-size:48px;      /* tap target */
  padding:.75rem 1rem;
  border-radius:999px;
  background:var(--brand-600);                     /* SITE colours, not WhatsApp green */
  color:var(--brand-contrast);
  box-shadow:0 6px 20px rgb(0 0 0 / .22);
  text-decoration:none; font-weight:600;
  /* Promote to its own layer so it never repaints the page during scroll. */
  will-change:transform;
  contain:layout paint;
}
@media (max-width:640px){ .wa__label{ display:none } }   /* icon-only on phones */
@media print{ .wa{ display:none } }
```

- `https://wa.me/<E.164 without +>` is the official universal link: on Android/iOS it opens the installed app directly; on desktop it lands on WhatsApp Web. **Never use `whatsapp://send`** — it fails hard on desktop and in in-app browsers.
- Inline SVG, not an icon font, not an `<img>` — zero extra request, zero FOIT, `currentColor` picks up the theme token.
- No JS ⇒ **no INP contribution at all**. A native anchor activation is not measured as an interaction with a long processing time.
- The button sits at `z-index: 60`; the cookie banner at `z-index: 70` and reserves space via `padding-block-end` on the banner container so they never overlap. When the banner is visible, `.wa { inset-block-end: calc(var(--banner-h) + 1rem) }` — set with a CSS custom property on `:root` from the same 300-byte inline script, so it is a style change on a fixed element (no CLS).

**INP budget for the whole tenant site: 5 interactive behaviours, all under 50 ms.**

| interaction | implementation | JS |
|---|---|---|
| Mobile nav | `<dialog>` + `showModal()`, or a pure-CSS `:has()`/checkbox pattern | 0–180 B |
| Gallery lightbox | native `<dialog>`, images already in DOM with `loading="lazy"` | ~400 B |
| FAQ accordion | `<details><summary>` — native, zero JS, zero INP | 0 |
| Language switcher | plain `<a>` links | 0 |
| Contact form | native `<form method=post action=/api/leads>`; progressive `fetch()` enhancement | ~500 B |
| Cookie banner | 2 buttons, one `document.cookie` write | ~900 B |
| Hero video | §4.4 | ~980 B |

Rules that keep it there:

```js
// Every listener passive where possible.
el.addEventListener('touchstart', fn, { passive: true });

// No scroll handlers. Sticky nav uses position:sticky; reveal animations use IntersectionObserver.

// Any handler that could exceed ~40ms yields before painting:
async function onSubmit(e){
  e.preventDefault();
  ui.setBusy(true);                       // ~1ms — paint this FIRST
  await (scheduler?.yield?.() ?? new Promise(r => setTimeout(r, 0)));
  await postLead(new FormData(e.target)); // network, off the interaction path
}
```

Hard bans on tenant sites: no `requestAnimationFrame` loops, no scroll-linked parallax, no `MutationObserver` on `document`, no `unload`/`beforeunload` listeners (they disqualify bfcache, and bfcache-restored navigations are where your best LCP numbers come from).

### 4.8 Fonts

**Self-hosted, subset, one file, variable, preloaded, metric-matched fallback.**

```bash
# One variable font, weight 400–700, latin + latin-ext (nl needs ĳ U+0133, de ß, fr œ,
# es ñ, pt ã/õ — latin alone is NOT enough for these six locales).
pyftsubset Inter-Variable.ttf \
  --output-file=inter-latin.woff2 --flavor=woff2 --layout-features='*' \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
pyftsubset Inter-Variable.ttf \
  --output-file=inter-latin-ext.woff2 --flavor=woff2 --layout-features='*' \
  --unicodes="U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"
```

```css
/* 1. The real face, split by unicode-range: only the subset a page needs is fetched. */
@font-face{
  font-family:"Inter";
  src:url("/_a/inter-latin.7c1e9a.woff2") format("woff2-variations");
  font-weight:400 700; font-style:normal; font-display:swap;
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,
                U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD;
}
@font-face{
  font-family:"Inter";
  src:url("/_a/inter-latin-ext.b4402f.woff2") format("woff2-variations");
  font-weight:400 700; font-style:normal; font-display:swap;
  unicode-range:U+0100-02AF,U+1E00-1E9F,U+1EF2-1EFF,U+20A0-20AB,U+2C60-2C7F,U+A720-A7FF;
}

/* 2. THE CLS FIX: a locally-available fallback whose metrics are overridden to match
      Inter exactly. font-display:swap then swaps glyphs with ~zero reflow.
      Values are computed with the Fontaine/capsize algorithm from the real font's
      hhea/OS-2 tables — do not hand-wave them. */
@font-face{
  font-family:"Inter Fallback";
  src:local("Arial"), local("Helvetica Neue"), local("Liberation Sans");
  ascent-override:90.00%;
  descent-override:22.43%;
  line-gap-override:0%;
  size-adjust:107.12%;
}

:root{ --font-sans:"Inter","Inter Fallback",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }
body{ font-family:var(--font-sans) }
```

```html
<!-- Preload ONLY the latin subset, ONLY the one file used above the fold.
     crossorigin is MANDATORY on font preloads (fonts are CORS-fetched even same-origin);
     omitting it causes a double download. -->
<link rel="preload" as="font" type="font/woff2" href="/_a/inter-latin.7c1e9a.woff2" crossorigin>
```

`font-display: swap` + metric-matched fallback beats `optional` here: `optional` gives literally zero CLS but on a slow first visit the tenant's brand font never appears, which for a "high-end corporate feel" product is unacceptable. With `size-adjust` the swap costs ~0.001 CLS.

**Never** `@import url(fonts.googleapis.com)`. It is a render-blocking request to a third origin, needs `preconnect` to two origins, and in Germany a court has already found embedding Google Fonts to be an unlawful IP transfer under GDPR (LG München I, 20 January 2022, 3 O 17493/20). Self-hosting solves performance and legal exposure in one move.

Cap the generator at **one typeface family** per site (two only if the industry preset demands a display face for headings, and then the display face is preloaded only if it is used in the `<h1>`).

### 4.9 Third-party script policy

**Tenant sites: zero third-party origins. This is enforced by CSP, not by policy.**

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline';        /* inline only; no external script host exists */
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  media-src 'self' blob:;
  font-src 'self';
  connect-src 'self';
  frame-src 'none';
  form-action 'self';
  base-uri 'none';
  object-src 'none';
  frame-ancestors 'none';
  upgrade-insecure-requests
```

(Move to hashed inline scripts + `'strict-dynamic'` once the inline set is frozen; the three inline blocks are stable so `'sha256-…'` is achievable in Phase 2.)

- **Analytics:** default is **Workers Analytics Engine, written server-side from the Worker**. Zero client bytes, zero cookies, zero consent question, and it cannot be blocked. Write one data point per HTML response with blobs `[host, path, locale, country, referrer_host, device]` and doubles `[1]`. For CWV field data, optionally add the Cloudflare Web Analytics beacon (~7 KB, cookieless, no fingerprinting) — but only for tenants who opt in, and load it with `defer` after `load`.
- **Maps:** never a Google Maps iframe. It pulls ~900 KB across 6 origins and single-handedly costs ~25 points. Instead, at publish time render a **static map image** into R2 (MapTiler/Geoapify static-map API with attribution, or a pre-rendered tile composite), display it as a normal `<img loading="lazy" width height>`, and wrap it in a link to `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>` which opens the native maps app on mobile. If a tenant insists on an interactive map, use a **facade**: the static image with a play-style overlay, and the iframe is injected on click — after consent (§5).
- **Booking calendar:** if the tenant uses an external booking provider, the same facade rule applies. Our own booking form is first-party.
- **Forms/spam:** Cloudflare Turnstile in **invisible** mode, and the script is injected only on the first `focusin` inside the form — so it never touches the initial load or LCP. Not reCAPTCHA (heavier, and a US data transfer with no consent basis).
- **Fonts, icons, CSS frameworks:** self-hosted or inlined. No CDN.
- **If a tenant enables GA4** (a paid-plan toggle): it loads only after consent, in Consent Mode Basic (§5.4), `async`, after `load`, and the site's `usesNonEssential` flag flips on, which is what makes the cookie banner appear at all.

Marketing site: the only permitted third party is `js.stripe.com`, and only on `/checkout/` and `/nl/prijzen/` (for the Payment Element), loaded on interaction with the CTA — not on the home page.

### 4.10 Critical CSS

**Target: the entire CSS for a tenant page is ≤ 11 KB brotli, and 100% of it is inlined in `<head>`. There is no external stylesheet.**

This is achievable because we generate the page and therefore know exactly which of ~40 components it uses:

```ts
// at publish, per (page, locale)
const used = collectComponentKeys(tree);                   // Set<'hero'|'reviews'|'footer'|…>
const css  = [BASE_TOKENS, RESET, ...used.map(k => COMPONENT_CSS[k])].join('');
const themed = applyTheme(css, site.theme_tokens);         // CSS custom properties only
const min = lightningcss(themed, { targets: browserslist, minify: true });
if (brotliSize(min) > 11 * 1024) throw new PublishError('CSS budget exceeded');
```

Inlining beats an external file here because:
- 11 KB brotli fits comfortably in the initial congestion window alongside the HTML → **zero render-blocking round-trips**, which is worth ~300–500 ms of LCP on mobile.
- The HTML is edge-cached anyway, so the "you lose cross-page CSS caching" argument costs a few KB per navigation, not a round trip — and Speculation Rules prerendering (§4.11) makes that free.
- It removes an entire class of FOUC bugs and the `media="print" onload` hack.

Theme changes are **CSS custom properties only** (`--brand-600`, `--radius`, `--font-sans`), so the live editor's colour picker rewrites ~30 declarations in a `:root{}` block, not the whole sheet.

The marketing site is bigger; there, inline the ~7 KB above-the-fold critical set and load the remainder as a normal `<link rel="stylesheet">` placed **in `<head>` after the inline block** — render-blocking, but by then the critical styles already painted, and the file is cached across the whole marketing site.

### 4.11 The exact HTTP headers a Worker should set

```ts
// src/worker/http/headers.ts
const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), browsing-topics=(), interest-cohort=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
} as const;

export function htmlHeaders(ctx: RenderCtx): Headers {
  const h = new Headers(SEC);
  h.set('content-type', 'text/html; charset=utf-8');

  // ---- Caching -------------------------------------------------------------
  // Browser: revalidate every time (so an edit is visible immediately) but NOT no-store,
  // because no-store disqualifies the page from bfcache and bfcache restores are the
  // cheapest "navigation" a user can have.
  h.set('cache-control', 'public, max-age=0, must-revalidate');
  // Edge: Cloudflare-specific, stripped before it reaches the client, wins over the above.
  h.set(
    'cloudflare-cdn-cache-control',
    'public, max-age=86400, stale-while-revalidate=604800, stale-if-error=86400',
  );
  // Other CDNs / tenant-side proxies.
  h.set('cdn-cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
  h.set('vary', 'Accept-Encoding');          // ONLY this. Never Cookie. Never User-Agent.
  h.set('etag', `W/"${ctx.versionId}-${ctx.renderSha.slice(0, 16)}"`);

  // ---- Early Hints (Cloudflare emits 103 from these on cached responses) ----
  h.append('link', '</_a/inter-latin.7c1e9a.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin');
  h.append('link', `<${ctx.heroLandscapeAvif}>; rel=preload; as=image; fetchpriority=high`);

  // ---- Indexing: header is authoritative, meta is the mirror ----------------
  if (ctx.indexState !== 'index') h.set('x-robots-tag', ROBOTS[ctx.indexState]);

  h.set('content-security-policy', CSP);
  h.set('content-language', ctx.locale);
  h.set('timing-allow-origin', '*');          // lets RUM read resource timings
  return h;
}

const ROBOTS = {
  noindex:  'noindex, nofollow, noarchive',
  deindex:  'noindex, follow',                // §2.3 phase 1
} as const;
```

**Hashed assets** (`/_a/<name>.<sha8>.<ext>`):

```
cache-control: public, max-age=31536000, immutable
cloudflare-cdn-cache-control: public, max-age=31536000, immutable
vary: Accept-Encoding
access-control-allow-origin: *          # fonts only
cross-origin-resource-policy: same-origin
```

`immutable` is safe *only* because the content hash is in the filename. Never put `immutable` on HTML.

**Compression.** Pre-compress at publish; do not let the Worker burn CPU per request:

```ts
// publish: store three encodings per text asset
await env.BLOBS.put(`${base}.br`,  await brotli(bytes, 11),  { httpMetadata: { contentEncoding: 'br'  }});
await env.BLOBS.put(`${base}.zst`, await zstd(bytes, 19),    { httpMetadata: { contentEncoding: 'zstd'}});
await env.BLOBS.put(`${base}.gz`,  await gzip(bytes, 9),     { httpMetadata: { contentEncoding: 'gzip'}});

// serve: negotiate, never double-compress
const ae = req.headers.get('accept-encoding') ?? '';
const enc = ae.includes('zstd') ? 'zst' : ae.includes('br') ? 'br' : ae.includes('gzip') ? 'gz' : null;
```

Brotli **quality 11** offline is 15–20% smaller than Cloudflare's on-the-fly quality (which is tuned for latency). For HTML rendered inside the Worker, do *not* set `content-encoding` — let Cloudflare compress it, and never compress AVIF/WebP/WebM/MP4/WOFF2 (already compressed; re-compressing wastes CPU and can grow the payload).

**Edge cache with versioned keys — "publish is the purge":**

```ts
const cache = caches.default;
// Cache key includes the published version id, so a publish makes every old key unreachable.
// No purge API call, no propagation delay, no risk of a partial purge.
const cacheKey = new Request(
  `https://cache.internal/${site.id}/${site.published_version_id}${url.pathname}`,
  { method: 'GET' },
);
let res = await cache.match(cacheKey);
if (!res) {
  res = await render(ctx);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
}
return res;
```

**Early Hints (103):** enable in the zone (Speed → Optimization → Early Hints). Cloudflare harvests `Link: rel=preload|preconnect` headers from cached responses and replays them as a `103` on subsequent requests. Realistic gain here is modest — everything is same-origin and TTFB from cache is ~30 ms — so emit it for the font and the desktop hero, measure, and do not over-invest. Note the `media` attribute is unreliable in `Link` headers, which is why the *responsive* hero preload lives in the HTML (§4.12) and only the landscape variant goes in the header.

**Speculation Rules** — this is where the real navigation win is:

```html
<script type="speculationrules">
{
  "prerender": [{
    "where": {
      "and": [
        { "href_matches": "/*" },
        { "not": { "href_matches": "/*\\?*" } },
        { "not": { "selector_matches": "[data-no-prerender]" } },
        { "not": { "selector_matches": ".wa" } },
        { "not": { "href_matches": "/api/*" } }
      ]
    },
    "eagerness": "moderate"
  }],
  "prefetch": [{
    "where": { "href_matches": "/*" },
    "eagerness": "conservative"
  }]
}
</script>
```

`moderate` = on hover ≥ 200 ms or pointerdown. Same-origin prerender makes the next navigation an instant paint — LCP effectively 0 for those users, which pulls the whole p75 down. Two required accommodations:

```js
// Do not double-count analytics on a prerendered page, and do not start the video
// while prerendering (Chrome throttles media there anyway).
if (document.prerendering) {
  document.addEventListener('prerenderingchange', () => activate(), { once: true });
} else { activate(); }
```

Exclude the WhatsApp link (cross-origin, not prerenderable) and anything with side effects. On the marketing site, exclude `/checkout/`.

Also enable in the zone: **HTTP/3**, **0-RTT** (safe: our Worker only honours 0-RTT for `GET`/`HEAD` on cacheable paths), **Brotli**, **Early Hints**. Disable Rocket Loader, Mirage, and Auto Minify — Rocket Loader in particular reorders scripts and reliably breaks the LCP-observer gating in §4.4.

### 4.12 The complete `<head>` order

Order matters — the preload scanner reads top-down and starts fetches before the parser reaches them.

```html
<!doctype html>
<html lang="nl" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<!-- 1. LCP CANDIDATES FIRST. Art-directed, so the browser fetches exactly one. -->
<link rel="preload" as="image" fetchpriority="high" media="(max-width: 767px)"
      href="/_a/hero-p-1170.3f9a1c.avif" type="image/avif">
<link rel="preload" as="image" fetchpriority="high" media="(min-width: 768px)"
      href="/_a/hero-l-1920.3f9a1c.avif" type="image/avif">
<link rel="preload" as="font" type="font/woff2" href="/_a/inter-latin.7c1e9a.woff2" crossorigin>

<!-- 2. ALL CSS, inline. Nothing render-blocking follows. -->
<style>/* 10.4 KB brotli */</style>

<!-- 3. The 300-byte consent bootstrap. Blocking on purpose: it must run before paint
        so a consented visitor never sees the banner flash. -->
<script>!function(){try{if(!/(?:^|;\s*)cc=/.test(document.cookie))document.documentElement.dataset.cc="ask"}catch(e){}}()</script>

<!-- 4. Metadata. No fetches, so order below CSS is fine. -->
<title>Diensten — Bakkerij Jansen | Amsterdam</title>
<meta name="description" content="Taarten op bestelling, dagelijks vers desembrood en catering in Amsterdam-Oost. Bestel online of bel +31 20 555 1234.">
<link rel="canonical" href="https://bakkerij-jansen.mijnsaas.com/nl/diensten/">
<!-- hreflang cluster: §1.5 -->
<link rel="icon" href="/_a/icon-32.8b21e0.png" sizes="32x32">
<link rel="icon" href="/_a/icon.8b21e0.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/_a/icon-180.8b21e0.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#8a5a2b">
<!-- OG/Twitter -->
<!-- JSON-LD @graph: §3.3 -->
</head>
```

Non-obvious: `viewport-fit=cover` is required for `env(safe-area-inset-*)` on notched iPhones, and there is **no `maximum-scale` / `user-scalable=no`** — that is an automatic Lighthouse accessibility failure and a WCAG 1.4.4 violation.

### 4.13 Performance budgets (enforced at publish, fail the build)

| metric | tenant page | marketing page |
|---|---|---|
| HTML (brotli) | ≤ 16 KB | ≤ 24 KB |
| CSS (brotli, inlined) | ≤ 11 KB | ≤ 9 KB critical + 22 KB deferred |
| JS (brotli, total) | ≤ 14 KB | ≤ 30 KB |
| LCP image (AVIF) | ≤ 55 KB | ≤ 55 KB |
| Fonts | ≤ 1 file preloaded, ≤ 34 KB | same |
| Requests before LCP | ≤ 3 (HTML, hero, font) | ≤ 3 |
| Third-party origins | **0** | 1 (`js.stripe.com`, `/checkout/` only) |
| DOM nodes | ≤ 1 500 | ≤ 2 200 |
| Video (deferred, post-LCP) | ≤ 1.4 MB desktop / ≤ 550 KB mobile | same |

CI runs Lighthouse (mobile preset, `--throttling-method=devtools`) against three fixture sites per industry preset on every PR and fails below 100/100/100/100. A separate nightly job pulls CrUX for the top 200 published tenant hosts and alerts on any p75 regression.

---

## 5. Cookie banner and consent

### 5.1 The best banner is no banner

The legal trigger is ePrivacy Art. 5(3) (NL: Telecommunicatiewet 11.7a; DE: TDDDG §25; FR: CPCE L.34-5 + CNIL guidance; ES: LSSI Art. 22.2; PT: Lei 41/2004 Art. 5) — consent is required for **any storing of, or access to, information on the user's terminal equipment** that is not strictly necessary. That includes `localStorage` and `sessionStorage`, not just cookies.

Because the default tenant site has **zero third parties, zero analytics cookies, zero `localStorage`**, and server-side Analytics Engine (which never touches the device), the strictly-necessary exemption covers everything it does. **So the generator's default output shows no cookie banner at all.** That is simultaneously the most GDPR-correct outcome, the best UX, and worth ~2 KB and ~20 ms of INP.

```ts
// The banner is a function of what the site actually uses. Not a checkbox.
site.usesNonEssential =
     site.analytics_provider !== 'none'          // GA4, Plausible-with-cookies, Matomo…
  || site.embeds.some(e => e.origin !== 'self')  // Maps iframe, booking iframe, YouTube
  || site.pixels.length > 0;                     // Meta, LinkedIn, TikTok
```

`0010`: `ALTER TABLE sites ADD COLUMN uses_non_essential INTEGER NOT NULL DEFAULT 0;` and a publish-time assertion that it is `1` whenever the rendered tree contains a cross-origin `script`/`iframe`/`img` — computed from the tree, so a user cannot pasted-HTML their way around it.

Note: the **privacy policy and the cookie statement are still generated and linked** regardless. No banner ≠ no disclosure.

### 5.2 When it is needed: the implementation

Rendered server-side into the static, fully-cacheable HTML. Never injected by JS after paint.

```html
<div id="cc" class="cc" role="region" aria-label="Cookie-instellingen">
  <div class="cc__box">
    <h2 class="cc__title">Cookies</h2>
    <p class="cc__text">
      Wij gebruiken alleen noodzakelijke cookies om deze site te laten werken.
      Met uw toestemming plaatsen wij ook statistiekcookies om de site te verbeteren.
      Lees ons <a href="/nl/cookiebeleid/">cookiebeleid</a>.
    </p>
    <div class="cc__actions">
      <button type="button" class="cc__btn" data-cc="reject">Alleen noodzakelijk</button>
      <button type="button" class="cc__btn" data-cc="accept">Alles accepteren</button>
    </div>
    <button type="button" class="cc__link" data-cc="prefs">Voorkeuren aanpassen</button>
  </div>
</div>
```

```css
.cc{
  position:fixed;                        /* out of flow -> showing it causes ZERO layout shift */
  inset-inline:0; inset-block-end:0;
  z-index:70;
  padding:1rem max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-bottom));
  background:var(--surface-1);
  border-block-start:1px solid var(--border);
  box-shadow:0 -8px 30px rgb(0 0 0 / .12);
  max-block-size:32vh; overflow:auto;    /* never an interstitial covering the content */
  display:none;
}
html[data-cc="ask"] .cc{ display:block }               /* set by the 300-byte head script */
html[data-cc="ask"]{ --banner-h:9rem }                 /* the WhatsApp button lifts, §4.7 */

/* EDPB / CNIL: reject must be as easy as accept. Identical size, weight, contrast, layer. */
.cc__actions{ display:flex; gap:.75rem; flex-wrap:wrap }
.cc__btn{
  flex:1 1 12rem; min-block-size:48px;
  font:inherit; font-weight:600;
  border:1px solid var(--brand-600); border-radius:.5rem;
  background:var(--brand-600); color:var(--brand-contrast);
  cursor:pointer;
}
.cc__btn[data-cc="reject"]{ background:transparent; color:var(--brand-700) }  /* same size, same prominence */
```

```js
// src/site/js/consent.js — ~900 bytes brotli.
(() => {
  const NAME = 'cc', VERSION = 2, MAXAGE = 60 * 60 * 24 * 182;   // 6 months (CNIL guidance)
  const el = document.getElementById('cc');
  if (!el) return;

  const write = (cats) => {
    const v = btoa(JSON.stringify({ v: VERSION, t: Date.now(), c: cats }))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    document.cookie = `${NAME}=${v}; Max-Age=${MAXAGE}; Path=/; SameSite=Lax; Secure`;
    document.documentElement.removeAttribute('data-cc');
    apply(cats);
    // Accountability record (GDPR Art. 7(1)). Fire-and-forget, never blocks the click.
    navigator.sendBeacon?.('/api/consent', JSON.stringify({ v: VERSION, c: cats }));
  };

  const apply = (cats) => {
    for (const s of document.querySelectorAll('script[type="text/plain"][data-consent]')) {
      if (!cats[s.dataset.consent]) continue;
      const n = document.createElement('script');
      for (const a of s.attributes) if (a.name !== 'type') n.setAttribute(a.name, a.value);
      n.type = 'text/javascript'; n.text = s.text;
      s.replaceWith(n);
    }
    if (window.gtag) gtag('consent', 'update', {
      analytics_storage:    cats.analytics  ? 'granted' : 'denied',
      ad_storage:           cats.marketing  ? 'granted' : 'denied',
      ad_user_data:         cats.marketing  ? 'granted' : 'denied',
      ad_personalization:   cats.marketing  ? 'granted' : 'denied',
    });
  };

  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-cc]')?.dataset.cc;
    if (a === 'accept') write({ analytics: 1, marketing: 1, functional: 1 });
    else if (a === 'reject') write({ analytics: 0, marketing: 0, functional: 0 });
    else if (a === 'prefs') el.classList.toggle('cc--expanded');
  });

  // Withdrawal must be as easy as giving. Footer link, present on every page.
  document.getElementById('cc-reopen')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.documentElement.dataset.cc = 'ask';
  });

  // Already consented at an older policy version -> re-ask.
  try {
    const m = document.cookie.match(/(?:^|;\s*)cc=([^;]+)/);
    if (m) {
      const p = JSON.parse(atob(m[1].replace(/-/g,'+').replace(/_/g,'/')));
      if (p.v !== VERSION) document.documentElement.dataset.cc = 'ask';
      else apply(p.c);
    }
  } catch { document.documentElement.dataset.cc = 'ask'; }
})();
```

### 5.3 Why this does not wreck CWV or SEO

| risk | mitigation |
|---|---|
| CLS from the banner appearing | `position: fixed`, out of flow. Showing it shifts nothing. Measured CLS contribution: 0. |
| Flash of banner for consented users | The 300-byte **blocking** head script sets `data-cc="ask"` *before* first paint, only when the cookie is absent. Consented users never see it, non-consented users see it in the very first frame. |
| INP from the buttons | One cookie write + one `sendBeacon`. `sendBeacon` is non-blocking. Measured: < 15 ms. |
| Third-party CMP (Cookiebot/OneTrust/Usercentrics) | **Banned.** They add 60–180 KB, 2–4 origins, and typically render *after* first paint (guaranteed CLS + a render-blocking dependency). We build our own; it is ~2 KB total. |
| `Vary: Cookie` killing edge cache | We never vary the HTML on the consent cookie. The banner's visibility is decided client-side by the head script, so a single cached HTML object serves everyone. |
| Intrusive-interstitial penalty | Google exempts *legally required* cookie notices, but only if they use a "reasonable amount of screen space". `max-block-size: 32vh`, bottom bar, never a full-screen overlay, never `overflow: hidden` on `<body>`. |
| Content gated behind consent (cloaking / soft-404 risk) | Content is **never** gated. The banner is an overlay on a fully rendered page. No cookie wall. |
| Focus theft hurting a11y and INP | The banner does **not** call `focus()` on load. It is `role="region"`, keyboard-reachable in DOM order, and `Esc` does nothing (dismissing by `Esc` would be an ambiguous non-consent). |

### 5.4 GDPR correctness checklist

- **No pre-ticked boxes.** All non-essential categories default to `0`. (CJEU *Planet49*, C-673/17: pre-ticked ≠ consent.)
- **Reject is as easy as accept:** one click, same layer, same size, same visual weight. (EDPB Guidelines 03/2022 on deceptive design; CNIL délibération 2020-091.)
- **No legitimate interest for tracking.** Art. 5(3) ePrivacy requires *consent*; LI is not an alternative for terminal-equipment access.
- **No cookie wall.** The site is fully usable after "Alleen noodzakelijk".
- **Granular:** at minimum `analytics` and `marketing` as separate toggles behind "Voorkeuren aanpassen".
- **Withdrawal:** a persistent "Cookie-instellingen" link in the footer on every page, in every locale, that reopens the banner. Required by Art. 7(3).
- **Proof of consent** (Art. 7(1) accountability): `POST /api/consent` writes to D1.
  ```sql
  CREATE TABLE consent_log (
    id            TEXT PRIMARY KEY,
    site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    policy_version INTEGER NOT NULL,
    categories    TEXT NOT NULL CHECK (json_valid(categories)),
    ip_hash       TEXT,     -- HMAC-SHA256(ip, monthly_rotating_salt), truncated to 16 bytes
    ua_hash       TEXT,     -- HMAC of the UA string. Never the raw UA.
    country       TEXT,
    method        TEXT NOT NULL CHECK (method IN ('accept_all','reject_all','custom','withdraw'))
  ) STRICT;
  CREATE INDEX idx_consent_site ON consent_log(site_id, created_at DESC);
  ```
  Never store the raw IP or raw UA — storing PII to prove a consent that was about avoiding PII is a classic own-goal. Retain 24 months, then delete via cron.
- **Re-ask at 6 months** (`Max-Age`) and on `policy_version` bump.
- **Consent applies per site**, not per apex. Cookie is set on the tenant's own host, `Path=/`, no `Domain=` attribute — so it never leaks across tenants. (§6.2's PSL entry makes this structurally guaranteed.)
- The auto-generated **cookie statement** must list each cookie: name, purpose, provider, duration, category. Generate it from the same `site.embeds`/`site.analytics_provider` config so it can never drift from reality.

### 5.5 Google Consent Mode v2, if GA is ever added

```html
<!-- Runs BEFORE gtag.js. Denied defaults for everything except security_storage. -->
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'denied',
    personalization_storage: 'denied',
    security_storage: 'granted',
    wait_for_update: 500
  });
  gtag('set', 'url_passthrough', true);
  gtag('set', 'ads_data_redaction', true);
</script>
<!-- Loaded ONLY after consent, by the consent module rewriting this tag. -->
<script type="text/plain" data-consent="analytics" async
        src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX"></script>
```

**Recommend Consent Mode *Basic*, not Advanced.** In Advanced mode, `gtag.js` loads and sends cookieless pings *before* consent. Several EU DPAs (and the EDPB's cookie-banner taskforce) treat that pre-consent transmission — which includes the IP and page URL, to a US processor — as an Art. 5(3)/Chapter V problem. Basic mode (nothing loads until consent) is both the defensible position and strictly better for CWV, because the 100 KB+ of `gtag.js` never loads for the ~40–60% of EU visitors who decline. The cost is losing Google's behavioural modelling — which for a bakery with 900 sessions/month is worthless anyway (modelling requires volume thresholds this segment will never hit).

---

## 6. Per-tenant SEO hygiene at scale

### 6.1 Split the apex (do this before launch, it is nearly free now and very expensive later)

Right now `mijnsaas.com` is proposed to host both the marketing site and every tenant subdomain. Do not do that. Put the marketing site on its **own registrable domain** and keep `mijnsaas.com` purely as the tenant-hosting domain:

```
aibuilder.com          → marketing, dashboard, editor, blog, docs, Stripe   (the money site)
mijnsaas.com           → tenant hosting only. Apex = a 5-line explainer + noindex.
*.mijnsaas.com         → tenant sites
*.preview.mijnsaas.com → drafts, behind Cloudflare Access
cname.mijnsaas.com     → the CNAME target for Cloudflare for SaaS (already in the schema)
```

Reason: reputation is largely a domain-level property. If 400 abandoned trial sites on `mijnsaas.com` get algorithmically classified as scaled content abuse, that assessment must not be able to touch the domain your paid acquisition lands on. This is exactly why Automattic uses `wordpress.com` + `wpcomstaging.com`, Shopify uses `myshopify.com` separate from `shopify.com`, and Wix uses `wixsite.com` separate from `wix.com`.

### 6.2 Get `mijnsaas.com` onto the Public Suffix List

Submit a PR to `publicsuffix/list` adding `mijnsaas.com` to the **PRIVATE DOMAIN** section. Precedent: `blogspot.com`, `myshopify.com`, `wixsite.com`, `pages.dev`, `github.io`, `vercel.app`.

What it buys:

- **Cookie isolation is enforced by the browser.** No tenant can ever set a cookie on `.mijnsaas.com` and read another tenant's session. Today that is prevented only by our own discipline; with a PSL entry it is prevented by every browser's cookie jar.
- **Search Console and site-level signals treat each subdomain as its own site** more readily, which is the whole point.
- Browsers stop offering `mijnsaas.com` as a same-site scope in permission and storage-partitioning decisions.

Cost: you can no longer share a cookie across `*.mijnsaas.com` (you shouldn't) and `Strict-Transport-Security: includeSubDomains` on the apex still works (HSTS is unaffected by the PSL). Submit early — the list is baked into browser releases, so propagation takes months.

### 6.3 Duplicate content and the "scaled content abuse" gate

Thousands of AI-generated sites from ~40 templates. Shared *structure* is fine — Wix and Squarespace prove that. Shared *text* is not, and Google's March 2024 spam policy on **scaled content abuse** targets "generating many pages primarily for manipulating search rankings rather than helping users", explicitly including AI generation.

So: **a site does not get `index` until it earns it.** The gate, run at publish:

```ts
// src/worker/publish/quality-gate.ts
export interface GateResult { pass: boolean; reasons: string[] }

export async function indexabilityGate(env: Env, site: Site, version: SiteVersion): Promise<GateResult> {
  const r: string[] = [];

  // (1) Real, tenant-specific facts. AI cannot invent these; the onboarding collected them.
  const facts = [site.address_line1, site.city, site.phone_e164, site.opening_hours].filter(Boolean);
  if (facts.length < 3) r.push('insufficient_business_facts');

  // (2) Substance, per indexable page, in the DEFAULT locale.
  for (const p of await indexablePages(env, version.id, site.default_locale)) {
    if (p.wordCount < 300) r.push(`thin_page:${p.page_key}`);
    if (!p.title || p.title.length > 65) r.push(`bad_title:${p.page_key}`);
    if (!p.meta_description || p.meta_description.length < 70) r.push(`bad_meta:${p.page_key}`);
  }

  // (3) Titles + metas unique WITHIN the site.
  if (hasDuplicates(pages.map(p => p.title)))            r.push('duplicate_titles');
  if (hasDuplicates(pages.map(p => p.meta_description))) r.push('duplicate_metas');

  // (4) Near-duplicate ACROSS tenants. 5-gram MinHash, 64 x 32-bit signature,
  //     compared against the last 500 published sites in the same industry.
  const sig = minhash(shingles(homeBodyText(version), 5), 64);
  const worst = await maxJaccard(env.DB, site.industry_key, sig, site.id);
  if (worst > 0.35) r.push(`near_duplicate:${worst.toFixed(2)}`);

  // (5) At least one tenant-owned image (not stock) above the fold or in the gallery.
  if (!(await hasOwnedMedia(env.DB, site.id))) r.push('no_owned_media');

  // (6) Doorway-page guard: no more than 2 location pages, and each must have
  //     >=250 unique words and a distinct address or service list.
  if (locationPages(version).length > 2) r.push('doorway_pattern');

  return { pass: r.length === 0, reasons: r };
}
```

```sql
-- 0010
ALTER TABLE sites ADD COLUMN content_signature TEXT;   -- 64 x uint32 minhash, base64
ALTER TABLE sites ADD COLUMN gate_result TEXT;         -- JSON, shown in the dashboard
CREATE INDEX idx_sites_sig ON sites(industry_key, published_at DESC) WHERE content_signature IS NOT NULL;
```

Failing the gate does **not** block publishing — the site goes live, the customer is happy, the WhatsApp button works — it blocks *indexing*, and the dashboard shows a friendly "Zichtbaar in Google: nog niet — voeg 2 eigen foto's en een langere bedrijfsomschrijving toe" checklist. That converts a spam-prevention mechanism into an onboarding-completion driver.

Generator-side reinforcement:
- Section **order and component set vary per industry preset** and per a deterministic hash of `site.id`, so the HTML structure differs too.
- The Anthropic prompt injects the tenant's own `short_description`, hours, address, and media captions as the *substrate*, with an explicit instruction that every paragraph must reference at least one tenant-specific fact. Use `output_config: { effort: "high" }` for the home and services copy, `"medium"` for legal pages, and cache the stable industry/system prefix with `cache_control: { type: "ephemeral", ttl: "1h" }` so the per-tenant variable content is the only uncached suffix.
- **Never generate location-permutation pages.** `/nl/loodgieter-amsterdam/`, `/nl/loodgieter-haarlem/`, ×200 is the textbook doorway pattern and is the single fastest way to get the apex manually actioned.

### 6.4 The index-state machine

One column drives everything. The Worker derives the `X-Robots-Tag` from it, the sitemap includes/excludes from it, the meta tag mirrors it.

```sql
-- 0010
ALTER TABLE sites ADD COLUMN index_state TEXT NOT NULL DEFAULT 'noindex'
  CHECK (index_state IN ('noindex','index','deindex','gone'));
ALTER TABLE sites ADD COLUMN index_state_at INTEGER;
ALTER TABLE sites ADD COLUMN canonical_host TEXT;   -- custom domain once primary, else <slug>.mijnsaas.com
```

| `sites.status` | trial / subscription | `index_state` | Worker behaviour |
|---|---|---|---|
| `onboarding`, `generating`, `draft` | any | `noindex` | `X-Robots-Tag: noindex, nofollow, noarchive`; `robots.txt` = `Disallow: /`; not in sitemap; preview host behind Access |
| `published`, gate **failed** | any | `noindex` | same, plus a dashboard checklist |
| `published`, gate passed, **no card on file** | — | `noindex` | The card is the spam filter. No card, no index. |
| `published`, gate passed, `trialing` (Stripe trial started, card captured) | 7-day trial | **`index`** | Fully indexable. Rationale below. |
| `published`, gate passed, `active`/`past_due` | paid | **`index`** | Fully indexable |
| `canceled` / `unpaid` / trial expired, day 0–30 | — | `deindex` | `200` + `X-Robots-Tag: noindex, follow`; robots.txt still **allows crawling** (§2.3); lastmod bumped once so Google recrawls fast |
| day 31+, or `suspended` | — | `gone` | `410` on every content URL, `410` on `sitemap.xml`, robots.txt now `Disallow: /` |

**Why index during the trial rather than after the first payment:** the 7-day Stripe trial requires a card. A card is the strongest anti-spam signal available and costs a spammer real money and real identity. Waiting until day 8 to allow indexing throws away a week of Google's discovery/evaluation runway on exactly the sites most likely to convert (a business that sees Google traffic in week one converts). The gate that matters is *card + quality*, not *money received*.

Enforcement — the header is produced in one place and is authoritative; the meta tag is a mirror for tools that only parse HTML:

```ts
const state = site.index_state;
if (state !== 'index') {
  headers.set('x-robots-tag', state === 'deindex' ? 'noindex, follow' : 'noindex, nofollow, noarchive');
  head += `<meta name="robots" content="${state === 'deindex' ? 'noindex, follow' : 'noindex, nofollow'}">`;
} else {
  head += `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">`;
}
```

`max-image-preview:large` is worth real CTR for local businesses and is a one-line win most builders forget.

Also always: `X-Robots-Tag: noindex` on `/api/*`, `/_edit/*`, `/sitemaps/*`, and every response from the dashboard/editor origin.

### 6.5 Subdomain → custom domain migration

The schema already has `custom_domains` with `is_primary`, `redirect_to_primary`, and `ssl_status`. The migration is six ordered steps; getting the order wrong loses rankings.

**Step 1 — provision.** Create the custom hostname via Cloudflare for SaaS, `ssl.method = 'txt'` (works before DNS is pointed, so the cert is ready when the CNAME flips). Poll until `ssl_status = 'active'` and `status = 'active'`. Nothing changes for search yet.

**Step 2 — overlap window (24–72 h).** Both hosts serve `200` with **identical content**, and **both canonicalise to the custom domain**:

```
https://bakkerij-jansen.mijnsaas.com/nl/diensten/
  200 OK
  Link: <https://bakkerijjansen.nl/nl/diensten/>; rel="canonical"
  <link rel="canonical" href="https://bakkerijjansen.nl/nl/diensten/">
  hreflang cluster: ALL URLs already on bakkerijjansen.nl
```

This lets Googlebot discover and fetch the new host before the old one starts redirecting, which makes the consolidation nearly instant instead of taking weeks. Do **not** 301 yet.

**Step 3 — verify in Search Console, on the new host.** The tenant owns the DNS (they created the CNAME), so a **Domain property** with a DNS TXT record is possible and is the right choice — it covers `www`, apex, http, https in one property. For tenants who cannot edit TXT records, fall back to a URL-prefix property verified by an HTML file we serve:

```ts
// 0010: ALTER TABLE custom_domains ADD COLUMN gsc_verification_token TEXT;
// Worker route, before the page router:
if (url.pathname.match(/^\/google[0-9a-f]{16}\.html$/) && url.pathname.slice(1, -5) === domain.gsc_token) {
  return new Response(`google-site-verification: ${url.pathname.slice(1)}`, {
    headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
  });
}
```
Also expose a `<meta name="google-site-verification">` slot fed from the same column, and the equivalent `msvalidate.01` for Bing.

**Step 4 — flip.** Set `is_primary = 1`, `redirect_to_primary = 1`, `sites.canonical_host = 'bakkerijjansen.nl'`. From this instant:

```ts
// Path-, locale-, and query-preserving. Exactly ONE hop. Never a chain.
if (host !== site.canonical_host && domain?.redirect_to_primary) {
  return Response.redirect(`https://${site.canonical_host}${url.pathname}${url.search}`, 301);
}
```

Non-negotiable properties of this redirect:
- **One hop.** `slug.mijnsaas.com/nl/diensten/` → `bakkerijjansen.nl/nl/diensten/`. Not via `/`, not via `www` first, not via a trailing-slash normaliser. Compose the normalisation and the host change into a single `Location`.
- **Path preserved exactly.** Redirecting every old URL to the new home page is the single most common site-move mistake and it discards every deep-link's equity. Google treats mass-redirect-to-home as a soft 404.
- **301, not 302.** Permanent.
- **Forever.** The redirect is never removed, and the slug is never reused — add `retired_at` to `reserved_slugs` and insert the slug there on migration, so `uq_sites_slug` can never hand it to another business.

**Step 5 — republish artefacts.** Sitemaps regenerate with the new host, `robots.txt` `Sitemap:` line updates, JSON-LD `@id`/`url`/`sameAs` update, `og:url` updates, hreflang cluster updates. All of this happens automatically because every one of them derives from `sites.canonical_host` — which is why that column must be the *only* source of the host, and why internal links in the page tree must be stored **root-relative** (`/nl/diensten/`) so they are host-agnostic and require no rewriting at all.

**Step 6 — Search Console Change of Address.** Both properties must be verified and both must be *the site being moved* — that holds here (`slug.mijnsaas.com` is a URL-prefix property containing only this tenant's content; the destination is a Domain property). Submit Change of Address on the source property. Caveats to encode in the runbook:
- It requires the source to 301 to the target and Google to be able to fetch both.
- It does **not** work for subdirectory moves, only host-level moves — which is exactly our case.
- Keep the source property verified for at least 180 days afterwards so the tool keeps working and you can watch "Page indexing → Page with redirect" climb and "Indexed" on the old host fall to zero.
- Do **not** change URL structure at the same time. One variable per move.

Monitoring: a cron job checks, for each recently migrated site, that (a) a sample of old URLs returns exactly one 301 to the matching new URL, (b) the new host returns 200 with a self-canonical, (c) `site:` coverage on the old host trends to zero. Alert on regressions.

### 6.6 Not becoming a spam farm

Beyond §6.1–6.3:

**No sitewide followed backlinks.** A "Gemaakt met aibuilder" badge in the footer of 10 000 tenant sites, all linking to `aibuilder.com` with the same anchor text, is a textbook link scheme and the classic way SaaS builders earn a manual action. Options, in order of preference:
1. No link at all — the badge is plain text with the brand mark.
2. `rel="nofollow sponsored"` on the badge link.
3. Paid plans remove the badge entirely (which is also a conversion lever).

Never `rel="dofollow"`, and never vary the anchor text to "look natural" — that is worse.

**No cross-tenant interlinking.** No "other bakeries near you", no public directory of tenant sites, no `mijnsaas.com/sites/` index. A crawlable list of 10 000 auto-generated sites is the single artefact that most efficiently gets the apex classified as a farm. If you want a showcase for marketing, curate ≤ 30 hand-picked examples on `aibuilder.com`, each with real permission, each `rel="nofollow"`.

**Signup and generation abuse controls.** The `RL_GENERATE` and `RL_LEADS` rate-limit bindings already in `wrangler.toml` are the right shape. Add:
- Turnstile on signup.
- Disposable-email blocklist.
- Card required before the first *regeneration* (already the product's paywall — it doubles as the anti-abuse gate).
- Hard cap: 1 site per organisation on trial, N per paid seat.
- A **policy classifier at generation time**: before dispatching the site-build prompt, run a cheap `claude-opus-5` call with `output_config: { effort: "low" }` and a `zodOutputFormat` schema `{ allowed: boolean, category: string, reason: string }` over the onboarding payload, blocking prohibited verticals (pharmacy without licence, gambling, adult, crypto/financial advice, replica goods, essay mills, debt relief). Store the verdict in `generation_jobs`. Cache the policy rubric with `cache_control: { type: "ephemeral", ttl: "1h" }` since it is identical for every call.
- A **nightly re-scan cron** over published sites: sample text, count outbound external links per page (cap at 8; anything more is `noindex` + review), detect injected `<script>`/`<iframe>` in user-editable fields (the CSP already blocks execution, but detect it and flag the account), detect keyword-stuffing (any 2-gram > 3% density), detect cloaking (compare the bot-served body hash to the human-served body hash — they must be identical).
- **Force `rel="ugc nofollow noopener"` on every user-entered external link.** The editor sanitises on save; the renderer sanitises again on publish. Two layers, because the first one will have a bug.

**Slug policy.** `reserved_slugs` exists; extend it with:
- Trademark-lookalike blocking (Levenshtein ≤ 1 against a list of top EU brands).
- Homoglyph/confusable normalisation (`rn` vs `m`, Cyrillic `а`, etc.) before the uniqueness check.
- Reject pure-keyword slugs (`goedkope-loodgieter-amsterdam-24-7`): default the slug from `business_name`, and reject if it contains ≥ 2 tokens from an industry-keyword list without matching the business name.
- Never reuse a retired slug.

**Observability.** Verify `mijnsaas.com` and `aibuilder.com` as Domain properties in Search Console and watch **Manual Actions** and **Security Issues** weekly — automate an alert. Register both in Bing Webmaster Tools. Keep an internal dashboard of: sites by `index_state`, gate-failure reasons histogram, near-duplicate score distribution per industry, and the count of `deindex`/`gone` sites (a rising ratio of dead-to-live sites is the leading indicator of a reputation problem).

---

## 7. Additive migration `0010_seo_i18n.sql`

Everything the plan above needs that the current schema lacks. All additive; no applied migration is edited.

```sql
-- ---------- sitemaps / lastmod discipline (§2.2) ----------
ALTER TABLE page_translations ADD COLUMN render_sha256      TEXT;
ALTER TABLE page_translations ADD COLUMN content_changed_at INTEGER;
CREATE INDEX idx_page_tr_lastmod ON page_translations(site_version_id, locale, content_changed_at DESC);

ALTER TABLE blog_post_translations ADD COLUMN render_sha256      TEXT;
ALTER TABLE blog_post_translations ADD COLUMN content_changed_at INTEGER;

-- ---------- canonical host + index state machine (§6.4) ----------
ALTER TABLE sites ADD COLUMN canonical_host   TEXT;
ALTER TABLE sites ADD COLUMN index_state      TEXT NOT NULL DEFAULT 'noindex'
  CHECK (index_state IN ('noindex','index','deindex','gone'));
ALTER TABLE sites ADD COLUMN index_state_at   INTEGER;
CREATE INDEX idx_sites_index_state ON sites(index_state, index_state_at) WHERE deleted_at IS NULL;

-- ---------- quality gate (§6.3) ----------
ALTER TABLE sites ADD COLUMN content_signature TEXT;   -- base64 minhash, 64 x uint32
ALTER TABLE sites ADD COLUMN gate_result       TEXT CHECK (gate_result IS NULL OR json_valid(gate_result));
CREATE INDEX idx_sites_sig ON sites(industry_key, published_at DESC) WHERE content_signature IS NOT NULL;

-- ---------- reviews legality (§3.6) ----------
ALTER TABLE sites ADD COLUMN reviews_source TEXT NOT NULL DEFAULT 'none'
  CHECK (reviews_source IN ('none','manual_testimonial','verified_platform'));
ALTER TABLE site_reviews ADD COLUMN verified_at  INTEGER;
ALTER TABLE site_reviews ADD COLUMN external_id  TEXT;
ALTER TABLE site_reviews ADD COLUMN platform     TEXT;

-- ---------- geo provenance (§3.5) ----------
ALTER TABLE sites ADD COLUMN geo_source TEXT NOT NULL DEFAULT 'none'
  CHECK (geo_source IN ('none','geocoded','user_pin','gbp'));
ALTER TABLE sites ADD COLUMN gbp_place_id TEXT;

-- ---------- consent (§5) ----------
ALTER TABLE sites ADD COLUMN uses_non_essential INTEGER NOT NULL DEFAULT 0
  CHECK (uses_non_essential IN (0,1));
ALTER TABLE sites ADD COLUMN analytics_provider TEXT NOT NULL DEFAULT 'server'
  CHECK (analytics_provider IN ('none','server','cf_web_analytics','ga4','matomo','plausible'));
ALTER TABLE sites ADD COLUMN consent_policy_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE consent_log (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  categories     TEXT NOT NULL CHECK (json_valid(categories)),
  method         TEXT NOT NULL CHECK (method IN ('accept_all','reject_all','custom','withdraw')),
  ip_hash        TEXT,   -- HMAC-SHA256(ip, monthly salt), 16 bytes hex. NEVER the raw IP.
  ua_hash        TEXT,
  country        TEXT CHECK (country IS NULL OR country GLOB '[A-Z][A-Z]'),
  CHECK (id GLOB 'cns_[0-7]*' AND length(id) = 30)
) STRICT;
CREATE INDEX idx_consent_site ON consent_log(site_id, created_at DESC);
CREATE INDEX idx_consent_gc   ON consent_log(created_at);   -- 24-month retention cron

-- ---------- domain migration (§6.5) ----------
ALTER TABLE custom_domains ADD COLUMN gsc_verification_token TEXT;
ALTER TABLE custom_domains ADD COLUMN bing_verification_token TEXT;
ALTER TABLE custom_domains ADD COLUMN migrated_at            INTEGER;
ALTER TABLE reserved_slugs ADD COLUMN retired_at             INTEGER;

-- ---------- locale hreflang aliases (§1.5) ----------
ALTER TABLE locales ADD COLUMN hreflang_aliases TEXT
  CHECK (hreflang_aliases IS NULL OR json_valid(hreflang_aliases));   -- e.g. ["pt-BR"]

-- ---------- path canonicalisation (§1.4) ----------
CREATE TRIGGER trg_page_tr_path_canonical_ins
BEFORE INSERT ON page_translations BEGIN
  SELECT RAISE(ABORT, 'path must be /…/ with no double slashes')
  WHERE NEW.path NOT GLOB '/*' OR NEW.path NOT GLOB '*/' OR NEW.path GLOB '*//*';
END;
CREATE TRIGGER trg_page_tr_path_canonical_upd
BEFORE UPDATE OF path ON page_translations BEGIN
  SELECT RAISE(ABORT, 'path must be /…/ with no double slashes')
  WHERE NEW.path NOT GLOB '/*' OR NEW.path NOT GLOB '*/' OR NEW.path GLOB '*//*';
END;

-- ---------- Only one thing may set index_state to 'index' ----------
CREATE TRIGGER trg_sites_index_requires_gate
BEFORE UPDATE OF index_state ON sites
WHEN NEW.index_state = 'index' BEGIN
  SELECT RAISE(ABORT, 'index_state=index requires a passing gate_result and a canonical_host')
  WHERE NEW.canonical_host IS NULL
     OR NEW.gate_result IS NULL
     OR json_extract(NEW.gate_result, '$.pass') IS NOT 1;
END;
```

---

## 8. Code layout and CI gates

```
/home/user/aibuilder/
  src/shared/seo/
    canonical.ts        canonicalUrl() — the ONLY producer of a canonical URL
    hreflang.ts         hreflangCluster()
    robots.ts           robotsTxt(site), robotsDirective(indexState)
    sitemap.ts          renderIndex(), renderUrlset()
    schema/
      graph.ts          buildGraph(page, site, locale) -> @graph
      allowlist.ts      LOCALBUSINESS_SUBTYPES (generated from schema.org, committed)
      hours.ts          openingHoursSpecification(sites.opening_hours)
      reviews.ts        aggregateRatingNode() — the legality gate
      ld.ts             ldScript() — the only serialiser
  src/shared/i18n/
    registry.ts         locale registry loader (D1 -> module cache, 60s TTL)
    slugify.ts          per-locale transliteration
    en.json nl.json de.json fr.json es.json pt.json
  src/worker/
    http/headers.ts     htmlHeaders(), assetHeaders(), csp.ts
    routes/
      normalize.ts      I1–I5 enforcement, one-hop 308
      media.ts          R2 + Range/206
      sitemap.ts        R2 passthrough
      robots.ts
      consent.ts        POST /api/consent
    publish/
      quality-gate.ts   indexabilityGate()
      sitemaps.ts       materialiseSitemaps()
      assets.ts         AVIF/WebP/video transcode + br/zst/gz precompress + hashing
      budgets.ts        the §4.13 table, throws on breach
  src/site/
    css/                design tokens + per-component CSS, assembled at publish
    js/hero-video.js  js/consent.js  js/lang-hint.js  js/form.js
  test/seo/
    hreflang.spec.ts    reciprocity, x-default uniqueness, omission-not-substitution
    canonical.spec.ts   self-reference, no cross-language, pagination
    schema.spec.ts      50 industry fixtures, allowlist, @id resolution, no fake ratings
    sitemap.spec.ts     lastmod stability across a no-op republish
    robots.spec.ts      state machine x 4 states x 3 hosts
  test/perf/
    lighthouse.spec.ts  3 fixtures x mobile preset, fail < 100
    lcp-invariant.spec.ts  poster area >= video area at every breakpoint
```

CI blocks a merge on: Lighthouse < 100 in any category on any fixture; any §4.13 budget breach; the LCP size invariant; hreflang non-reciprocity; a schema `@type` outside the allowlist; an `aggregateRating` emitted without `reviews_source = 'verified_platform'`; a `lastmod` that moved on a no-op republish; any cross-origin URL appearing in a tenant fixture's rendered HTML.

---

## The ten things that actually decide whether this works

1. **`/` is an unconditional 308 to the default locale. Never geo-redirect.** (§1.2, §1.3)
2. **Every content URL is `/{locale}/…/`, with a trailing slash, and a self-referencing canonical.** No unprefixed URLs, ever. (§1.1)
3. **hreflang omits missing locales; it never substitutes a fallback.** One non-reciprocal entry drops the whole cluster. (§1.5)
4. **`lastmod` moves on content hash change, never on deploy.** A sitemap that always says "now" gets ignored. (§2.2)
5. **The poster image's intrinsic area must be ≥ the video's, at every breakpoint.** This — not timing — is what stops the video from stealing LCP. (§4.1)
6. **`100svh`, never `dvh`, never bare `vh`.** (§4.3)
7. **Zero third-party origins on tenant sites, enforced by CSP, not by policy.** No third-party CMP, no Google Fonts, no Maps iframe. (§4.9, §5.3)
8. **Emit no `aggregateRating` by default.** Self-serving LocalBusiness reviews are rich-result-ineligible under Google policy and a 4%-of-turnover liability under the EU Omnibus Directive. (§3.6)
9. **Card-on-file + a passing content-uniqueness gate is what unlocks `index`, not payment received.** (§6.3, §6.4)
10. **Put the marketing site on a different registrable domain from the tenant subdomains, and get the tenant domain into the Public Suffix List.** Both are nearly free today and impossible to retrofit cheaply. (§6.1, §6.2)