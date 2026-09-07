import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoSite } from './demo-sites';
import { DEMO_SITES } from './demo-sites';
import { OUTPUT_DIR, buildAssetTable, buildFontTable } from './media';

/**
 * A static server over `.preview/`, one port per demo site.
 *
 * WHY ONE PORT EACH, AND NOT ONE SERVER WITH FOUR PREFIXES. Every internal link a rendered page
 * carries is an absolute path built from `PageDoc.perLocale[locale].path` — `/nl/`, `/nl/agenda/`.
 * That is what a published tenant site emits, and rewriting it to `/club-neonkaai/nl/` would mean
 * screenshotting bytes the publish pipeline never produces. Giving each site its own origin keeps
 * the HTML untouched and makes the nav, the footer and the anchors actually work.
 *
 * Media and fonts are answered from `media.ts` in memory rather than from disk, so editing a
 * composition and reloading is enough; the files `render.ts` wrote are for anything else that
 * wants to serve the directory.
 */

/**
 * Where this harness and the repository live.
 *
 * `run.mjs` bundles each entry point into `scripts/preview/dist/`, so `import.meta.url` in the
 * *bundle* points one directory deeper than the source. The runner therefore exports both paths;
 * the fallback keeps the modules correct when they are executed from source instead.
 */
const HERE = process.env['PREVIEW_HARNESS_DIR'] ?? path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env['PREVIEW_REPO_ROOT'] ?? path.resolve(HERE, '..', '..');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  // The hero footage. `type` on a <source> is matched against the DECLARED string, so serving a
  // WebM as octet-stream makes the browser skip the AV1 rendition and fall through to H.264.
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** One running site server. */
export interface SiteServer {
  readonly site: DemoSite;
  readonly port: number;
  readonly origin: string;
}

/** Everything `serve` started. */
export interface PreviewServers {
  readonly indexPort: number;
  readonly indexOrigin: string;
  readonly sites: readonly SiteServer[];
  close(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** A readable 404. Blog-post paths land here: the teaser links to them, but they are not pages. */
function notFoundHtml(pathname: string): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<title>404 — niet in de preview</title>
<style>body{margin:0;padding:4rem 1.5rem;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;color:#16181d;background:#f6f7f9}
main{max-width:38rem;margin:0 auto}code{background:#e6e9ee;padding:.1em .35em;border-radius:.25em}</style>
</head><body><main>
<h1>404 — <code>${escapeHtml(pathname)}</code></h1>
<p>Deze URL hoort niet bij de gerenderde preview. Twee veelvoorkomende gevallen:</p>
<ul>
<li><strong>Blogposts</strong> (<code>/nl/blog/…/</code>). De <em>blog_teaser</em>-sectie linkt ernaar,
maar een blogpost is geen <code>PageDoc</code>: de renderer bouwt die pagina elders. In deze
harnas worden alleen de pagina's uit <code>doc.pages</code> gerenderd.</li>
<li><strong>Formulier-endpoints</strong> (<code>/api/leads</code>, <code>/api/bookings</code>).
Die horen bij de API-worker en draaien hier niet.</li>
</ul>
<p><a href="/nl/">Terug naar de homepage van deze demo-site</a></p>
</main></body></html>`;
}

/** The index the base port serves: the four sites, with links that actually work. */
function indexHtml(servers: readonly SiteServer[]): string {
  const cards = servers
    .map((entry) => {
      const pages = entry.site.doc.pages
        .filter((page) => page.perLocale['nl'] !== undefined)
        .map((page) => {
          const routing = page.perLocale['nl'];
          const url = `${entry.origin}${routing?.path ?? '/'}`;
          return `<li><a href="${escapeHtml(url)}">${escapeHtml(routing?.path ?? '/')}</a> <span class="muted">${escapeHtml(routing?.title ?? '')}</span></li>`;
        })
        .join('');
      return `<section class="card">
<h2><a href="${escapeHtml(entry.origin)}/nl/">${escapeHtml(entry.site.label)}</a></h2>
<p class="dna">${escapeHtml(entry.site.archetype)} · ${escapeHtml(entry.origin)}</p>
<p>${escapeHtml(entry.site.blurb)}</p>
<ul>${pages}</ul></section>`;
    })
    .join('');

  return `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aibuilder — designpreview (server)</title>
<style>
:root{color-scheme:light dark;--fg:#16181d;--muted:#5c6270;--bg:#f6f7f9;--card:#fff;--line:#e2e5ea}
@media (prefers-color-scheme:dark){:root{--fg:#eef0f4;--muted:#a2a9b8;--bg:#14161a;--card:#1c1f25;--line:#2c313a}}
body{margin:0;padding:2.5rem 1.25rem 4rem;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:64rem;margin:0 auto}h1{font-size:1.9rem;margin:0 0 .25rem;letter-spacing:-.02em}
.lede{color:var(--muted);max-width:44rem}
.grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));margin-top:1.5rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1.25rem 1.4rem}
.card h2{font-size:1.15rem;margin:0 0 .15rem}
.dna{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;color:var(--muted);margin:0 0 .75rem}
ul{padding-left:1.1rem}a{color:inherit}.muted{color:var(--muted);font-size:.85rem}
footer{margin-top:2.5rem;color:var(--muted);font-size:.85rem;max-width:44rem}
</style></head><body><main>
<h1>Designpreview — vier demo-sites</h1>
<p class="lede">Elke demo-site draait op een eigen poort, zodat de interne links
(<code>/nl/</code>, <code>/nl/agenda/</code>) precies de paden zijn die de publicatiepijplijn
schrijft. Alle bedrijven, adressen, telefoonnummers en reviews zijn verzonnen; alle beelden zijn
gegenereerde placeholders.</p>
<div class="grid">${cards}</div>
<footer><p>Bewijst layout, kleur, typografie en de HTML van de componentbibliotheek. Bewijst geen
Lighthouse-scores: de echte mediapijplijn en de edge-cache zitten niet in deze lus.</p></footer>
</main></body></html>`;
}

/** The web app manifest `<head>` links to. Generated, so the preview has no dangling reference. */
function webManifest(site: DemoSite): string {
  return JSON.stringify(
    {
      name: site.doc.facts.businessName,
      short_name: site.doc.facts.businessName,
      start_url: '/nl/',
      display: 'standalone',
      background_color: site.doc.theme.colorMode === 'dark' ? '#101010' : '#ffffff',
      icons: [
        { src: `/_m/${site.key}/icon-32.png`, sizes: '32x32', type: 'image/png' },
        { src: `/_m/${site.key}/icon-180.png`, sizes: '180x180', type: 'image/png' },
        { src: `/_m/${site.key}/icon.svg`, sizes: 'any', type: 'image/svg+xml' },
      ],
    },
    null,
    2,
  );
}

/** Resolves a URL path inside one site's output directory, or `null`. */
function fileFor(siteDir: string, pathname: string): string | null {
  const relative = pathname.replace(/^\/+/u, '');
  const candidate = path.resolve(siteDir, relative);
  // Path traversal: a `..` in the URL must not escape the site directory, even in a dev server.
  if (candidate !== siteDir && !candidate.startsWith(`${siteDir}${path.sep}`)) return null;
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const index = path.join(candidate, 'index.html');
    return existsSync(index) ? index : null;
  }
  return existsSync(candidate) ? candidate : null;
}

/** Starts one server and resolves once it is listening. */
async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return address.port;
}

/**
 * Starts one server per demo site plus the index server.
 *
 * `basePort: 0` asks the OS for free ports, which is what `shoot.ts` wants; any other value places
 * the index at `basePort` and the sites at `basePort + 1 …`.
 */
export async function startServers(
  options: { readonly basePort?: number } = {},
): Promise<PreviewServers> {
  const basePort = options.basePort ?? 4321;
  const assets = buildAssetTable(DEMO_SITES);
  const { table: fonts } = buildFontTable();
  const servers: Server[] = [];
  const sites: SiteServer[] = [];

  for (const [index, site] of DEMO_SITES.entries()) {
    const siteDir = path.join(OUTPUT_DIR, site.key);
    const server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);

      const asset = assets.get(pathname);
      if (asset !== undefined) {
        response.writeHead(200, {
          'content-type': asset.contentType,
          'cache-control': 'no-store',
        });
        response.end(asset.body);
        return;
      }
      const font = fonts.get(pathname);
      if (font !== undefined) {
        response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'no-store' });
        response.end(readFileSync(font));
        return;
      }
      if (pathname === '/site.webmanifest') {
        response.writeHead(200, { 'content-type': CONTENT_TYPES['.webmanifest'] ?? 'text/plain' });
        response.end(webManifest(site));
        return;
      }

      const file = fileFor(siteDir, pathname);
      if (file === null) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        response.end(notFoundHtml(pathname));
        return;
      }
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(readFileSync(file));
    });
    const port = await listen(server, basePort === 0 ? 0 : basePort + 1 + index);
    servers.push(server);
    sites.push({ site, port, origin: `http://127.0.0.1:${String(port)}` });
  }

  const indexServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/' && pathname !== '/index.html') {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(notFoundHtml(pathname));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(indexHtml(sites));
  });
  const indexPort = await listen(indexServer, basePort);
  servers.push(indexServer);

  return {
    indexPort,
    indexOrigin: `http://127.0.0.1:${String(indexPort)}`,
    sites,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => {
                resolve();
              });
            }),
        ),
      );
    },
  };
}

/** `node run.mjs serve [--port=4321]`. Runs until interrupted. */
export async function main(argv: readonly string[] = []): Promise<void> {
  if (!existsSync(path.join(OUTPUT_DIR, 'manifest.json'))) {
    console.error(
      `nothing rendered yet: ${path.relative(ROOT, OUTPUT_DIR)}/manifest.json is missing.\n` +
        'run `node scripts/preview/run.mjs render` first.',
    );
    process.exitCode = 1;
    return;
  }
  const portArgument = argv.find((argument) => argument.startsWith('--port='));
  const basePort = portArgument === undefined ? 4321 : Number(portArgument.slice('--port='.length));
  const servers = await startServers({ basePort });
  console.log(`index   ${servers.indexOrigin}`);
  for (const entry of servers.sites) {
    console.log(`${entry.site.key.padEnd(26)} ${entry.origin}/nl/`);
  }
  console.log('\nCtrl-C to stop.');
  process.on('SIGINT', () => {
    void servers.close().then(() => {
      process.exit(0);
    });
  });
}
