/**
 * Creates every Cloudflare resource the wrangler configs bind, and writes the ids back into them.
 *
 * WHY THIS READS THE CONFIGS INSTEAD OF A LIST. The set of resources is already stated, exactly
 * once, in `apps/*&#47;wrangler.jsonc`. A second list here would be a second thing to keep true, and the
 * failure mode is quiet: a binding added to a config and forgotten here is a Worker that deploys
 * and then throws on its first request. The README's own bootstrap section had already drifted this
 * way — it creates two KV namespaces and the configs bind three (`STOCK_CACHE` was missing), which
 * would have failed the generator's first deploy.
 *
 * IT IS IDEMPOTENT. Every resource is listed before it is created and the id is always read back
 * from the account, so a second run over a half-finished bootstrap finishes it instead of erroring.
 * That matters because this runs in CI, where "run it again" is the only recovery available.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO:
 *   · secrets — they are values, not resources, and a workflow that reads them would need them in
 *     its own environment. They go in the dashboard or through `wrangler secret put`.
 *   · zones and DNS — adding a domain needs a nameserver change at your registrar.
 *   · migrations — `pnpm migrate:*:remote` is the moment "forward-only" starts, and that is a
 *     decision someone makes after reading the SQL, not a side effect of provisioning.
 *
 *   node scripts/cloudflare/bootstrap.mjs --dry-run   # print the plan, touch nothing
 *   node scripts/cloudflare/bootstrap.mjs             # create what is missing, patch the configs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const APPS = path.join(ROOT, 'apps');

const DRY_RUN = process.argv.includes('--dry-run');

/** Residency, and a one-way door: D1 and R2 both fix it at creation with no move API. */
const JURISDICTION = 'eu';

/** The Secrets Store this account's Worker secrets live in. One store, many secrets. */
const SECRETS_STORE = 'aibuilder';

/**
 * One wrangler invocation, and it cannot outlive its usefulness.
 *
 * `timeout` is the load-bearing option. Without it a subcommand that decides to ask a question —
 * a beta feature gate, a consent prompt, an account picker — blocks on a stdin that will never
 * produce anything, and the job sits at that step until the runner's own limit kills it with no
 * output at all. That happened on the first run: eight minutes on a step that takes about one.
 * `CI=1` asks wrangler not to be interactive in the first place; the timeout is what makes it true
 * whether or not wrangler agrees.
 */
function wrangler(argv, { capture = true } = {}) {
  return execFileSync('pnpm', ['exec', 'wrangler', ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
}

/**
 * Runs a wrangler command that may legitimately fail (a `list` on an empty account, a `create` that
 * races another run), returning `null` rather than throwing.
 */
function tryWrangler(argv) {
  const started = Date.now();
  try {
    return wrangler(argv);
  } catch {
    return null;
  } finally {
    // Printed for every call, because the only thing worse than a slow step is a silent one.
    console.log(`    wrangler ${argv.join(' ')} — ${String(Date.now() - started)} ms`);
  }
}

/** The first JSON value in wrangler's output. It prints banners around it. */
function parseJson(output) {
  if (output === null) return null;
  const start = output.search(/[[{]/u);
  if (start === -1) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

/* ── What the configs actually bind ───────────────────────────────────────── */

/** Strips comments and trailing commas so `JSON.parse` can read a `.jsonc`. */
function readJsonc(file) {
  const raw = readFileSync(file, 'utf8');
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
    .replace(/,(\s*[}\]])/gu, '$1');
  return JSON.parse(withoutComments);
}

/** Every resource named by every app config, deduplicated. */
function inventory() {
  const d1 = new Set();
  const kv = new Set();
  const r2 = new Set();
  const queues = new Set();

  for (const app of readdirSync(APPS)) {
    const file = path.join(APPS, app, 'wrangler.jsonc');
    let config;
    try {
      config = readJsonc(file);
    } catch {
      continue;
    }
    for (const database of config.d1_databases ?? []) d1.add(database.database_name);
    for (const namespace of config.kv_namespaces ?? []) kv.add(namespace.binding);
    for (const bucket of config.r2_buckets ?? []) r2.add(bucket.bucket_name);
    for (const producer of config.queues?.producers ?? []) queues.add(producer.queue);
    for (const consumer of config.queues?.consumers ?? []) {
      queues.add(consumer.queue);
      if (consumer.dead_letter_queue) queues.add(consumer.dead_letter_queue);
    }
  }
  return { d1: [...d1], kv: [...kv], r2: [...r2], queues: [...queues] };
}

/**
 * The KV namespace TITLE for a binding.
 *
 * The binding is what the code says (`env.ROUTING`); the title is what the account lists. Deriving
 * one from the other keeps them from being two independent decisions.
 */
const kvTitle = (binding) => `aibuilder-${binding.toLowerCase().replaceAll('_', '-')}`;

/**
 * Turns a wrangler failure into an instruction, when it is one.
 *
 * Some Cloudflare products are off until someone accepts their terms in the dashboard, and the API
 * cannot turn them on — R2 answers `code: 10042`, Queues and Workflows need the paid plan. Those
 * are not bugs and not something to retry; they are a link to click, once. Left alone they surface
 * as a Node stack trace ending in `execFileSync`, which says nothing about what to do.
 *
 * @returns a human instruction, or `null` when the failure is not one of these.
 */
function explainFailure(error) {
  const text = `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}${String(error?.message ?? '')}`;
  if (/10042|enable R2/iu.test(text)) {
    return (
      'R2 is not enabled on this account. Turn it on once at ' +
      'https://dash.cloudflare.com → R2 → Overview (it asks you to accept the terms), then run ' +
      'this again. The API cannot enable it.'
    );
  }
  if (
    /queues|workflows/iu.test(text) &&
    /not (enabled|entitled|available)|paid|subscription/iu.test(text)
  ) {
    return (
      'This account is not on the Workers Paid plan. Queues, Workflows and SQLite-backed Durable ' +
      'Objects all require it: https://dash.cloudflare.com → Workers & Pages → Plans.'
    );
  }
  return null;
}

/** Runs a create, and fails with an instruction rather than a stack trace when it is one. */
function create(argv, what) {
  try {
    return wrangler(argv);
  } catch (error) {
    const instruction = explainFailure(error);
    if (instruction === null) throw error;
    console.error(`\n✘ cannot create ${what}\n\n  ${instruction}\n`);
    process.exit(1);
  }
}

/* ── Create, or find what is already there ────────────────────────────────── */

function ensureD1(name) {
  const existing = parseJson(tryWrangler(['d1', 'list', '--json'])) ?? [];
  const found = existing.find((database) => database.name === name);
  if (found) return { id: found.uuid ?? found.database_id, created: false };
  if (DRY_RUN) return { id: null, created: true };

  create(['d1', 'create', name, '--jurisdiction', JURISDICTION], `the D1 database ${name}`);
  const after = parseJson(tryWrangler(['d1', 'list', '--json'])) ?? [];
  const made = after.find((database) => database.name === name);
  if (!made) throw new Error(`created D1 "${name}" but it is not in the account listing`);
  return { id: made.uuid ?? made.database_id, created: true };
}

function ensureKv(binding) {
  const title = kvTitle(binding);
  const existing = parseJson(tryWrangler(['kv', 'namespace', 'list'])) ?? [];
  const found = existing.find((namespace) => namespace.title === title);
  if (found) return { id: found.id, created: false };
  if (DRY_RUN) return { id: null, created: true };

  create(['kv', 'namespace', 'create', title], `the KV namespace ${title}`);
  const after = parseJson(tryWrangler(['kv', 'namespace', 'list'])) ?? [];
  const made = after.find((namespace) => namespace.title === title);
  if (!made) throw new Error(`created KV "${title}" but it is not in the account listing`);
  return { id: made.id, created: true };
}

function ensureR2(name) {
  // `--jurisdiction` and `--location` are mutually exclusive for R2; the jurisdiction is the
  // residency control and the one that changes the S3 endpoint host, so it is the one that matters.
  const listing = tryWrangler(['r2', 'bucket', 'list', '--jurisdiction', JURISDICTION]) ?? '';
  if (listing.includes(name)) return { created: false };
  if (DRY_RUN) return { created: true };
  create(['r2', 'bucket', 'create', name, '--jurisdiction', JURISDICTION], `the R2 bucket ${name}`);
  return { created: true };
}

function ensureQueue(name) {
  const listing = tryWrangler(['queues', 'list']) ?? '';
  if (listing.includes(name)) return { created: false };
  if (DRY_RUN) return { created: true };
  create(['queues', 'create', name], `the queue ${name}`);
  return { created: true };
}

function ensureSecretsStore() {
  const existing = parseJson(tryWrangler(['secrets-store', 'store', 'list', '--remote'])) ?? [];
  const found = Array.isArray(existing)
    ? existing.find((store) => store.name === SECRETS_STORE)
    : undefined;
  if (found) return { id: found.id, created: false };
  if (DRY_RUN) return { id: null, created: true };

  create(['secrets-store', 'store', 'create', SECRETS_STORE, '--remote'], `the Secrets Store`);
  const after = parseJson(tryWrangler(['secrets-store', 'store', 'list', '--remote'])) ?? [];
  const made = Array.isArray(after)
    ? after.find((store) => store.name === SECRETS_STORE)
    : undefined;
  if (!made) throw new Error('created the Secrets Store but it is not in the account listing');
  return { id: made.id, created: true };
}

/* ── Routes, and the zones that may not exist yet ─────────────────────────── */

/**
 * Zone names present in the account, or `null` when that cannot be determined.
 *
 * `null` is deliberately not the same as "none": without a token, or when the API is unreachable,
 * the honest answer is that we do not know, and the configs are left exactly as they are. Guessing
 * "no zones" would silently strip working routes off a live production deploy.
 */
async function knownZones() {
  const token = process.env['CLOUDFLARE_API_TOKEN'];
  if (token === undefined || token === '') return null;
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.success !== true || !Array.isArray(body.result)) return null;
    return new Set(body.result.map((zone) => zone.name));
  } catch {
    return null;
  }
}

/**
 * Removes a config's `routes` and lets the Worker answer on `workers.dev` instead.
 *
 * A route names a zone, and `wrangler deploy` fails outright when that zone is not in the account —
 * so with the placeholder domains still in place, the very first deploy dies on the first Worker
 * and nothing at all goes live. Falling back to `workers.dev` means the estate deploys and is
 * reachable today; the moment the real zones are added the routes attach again on the next push,
 * with no edit here. That is the whole point of doing this at deploy time rather than in git.
 */
function withoutRoutes(source) {
  // Non-greedy to the first `],` — no `routes` entry contains a nested array.
  return source.replace(
    /^(\s*)"routes":\s*\[[\s\S]*?\],\n/mu,
    '$1// `routes` removed at deploy time: the zone it named is not in this account yet.\n' +
      '$1"workers_dev": true,\n',
  );
}

/** Every zone a config's routes depend on. */
function zonesOf(source) {
  return [...source.matchAll(/"zone_name":\s*"([^"]+)"/gu)].map((match) => match[1]);
}

/* ── Writing the ids back ─────────────────────────────────────────────────── */

/**
 * Replaces the placeholders in one config, using the line's own context to decide which id.
 *
 * Line-oriented rather than a JSON round-trip, because these files carry the reasoning for every
 * binding in their comments and `JSON.stringify` would delete all of it. The context is whatever
 * `binding` or `database_name` was seen most recently — which is on the same line for the one-line
 * bindings and a few lines up for the block ones, and both work because the context is updated
 * before the substitution on each line.
 */
/**
 * Walks one config, resolving every placeholder line against the ids this run produced.
 *
 * One traversal serves both callers — the writer and the report — so "what got filled" and "what is
 * left" can never disagree about which placeholders this script is even responsible for. The
 * context is whatever `binding` or `database_name` was seen most recently: on the same line for the
 * one-line bindings, a few lines up for the block ones, and both work because the context is
 * updated before the substitution is decided.
 *
 * Line-oriented rather than a JSON round-trip, because these files carry the reasoning for every
 * binding in their comments and `JSON.stringify` would delete all of it.
 */
function resolvePlaceholders(file, ids) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let binding = null;
  let databaseName = null;
  /** Placeholders this script owns but could not resolve — a resource that was never created. */
  const unresolved = [];
  /** Placeholders that are values rather than resources: never this script's to fill. */
  const foreign = [];
  let changed = 0;

  const out = lines.map((line) => {
    const bindingMatch = /"binding":\s*"([A-Z0-9_]+)"/u.exec(line);
    if (bindingMatch) binding = bindingMatch[1];
    const nameMatch = /"database_name":\s*"([a-z0-9-]+)"/u.exec(line);
    if (nameMatch) databaseName = nameMatch[1];

    // A comment that merely NAMES the placeholder is documentation, not a placeholder.
    if (!line.includes('REPLACE_WITH_REAL_ID') || /^\s*\/\//u.test(line)) return line;

    let value;
    let owned = true;
    if (/"database_id":/u.test(line) && databaseName !== null) value = ids.d1[databaseName];
    else if (/"id":/u.test(line) && binding !== null) value = ids.kv[binding];
    else if (/"store_id":/u.test(line)) value = ids.secretsStore;
    else if (/"R2_S3_ENDPOINT":/u.test(line)) value = ids.accountId;
    else {
      const named = /"([A-Z_]+)":\s*"REPLACE_WITH_REAL_ID"/u.exec(line)?.[1];
      if (named !== undefined && named in ids.values) value = ids.values[named];
      else owned = false;
    }

    if (!owned) {
      foreign.push(line.trim());
      return line;
    }
    if (value === null || value === undefined) {
      unresolved.push(line.trim());
      return line;
    }
    changed += 1;
    return line.replace('REPLACE_WITH_REAL_ID', value);
  });

  if (changed > 0 && !DRY_RUN) writeFileSync(file, out.join('\n'));
  return { changed, unresolved, foreign };
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

const want = inventory();
console.log(
  `configs bind: ${String(want.d1.length)} D1, ${String(want.kv.length)} KV, ` +
    `${String(want.r2.length)} R2, ${String(want.queues.length)} queues\n`,
);

const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? null;
if (accountId === null) {
  console.log('CLOUDFLARE_ACCOUNT_ID is not set — R2_S3_ENDPOINT will keep its placeholder.\n');
}

/**
 * Placeholders that are VALUES rather than resources — nothing to create, only to carry.
 *
 * They are not secrets: the Turnstile site key is rendered into the widget, the Stripe price is
 * quoted on the pricing page, and the IndexNow key is served at `/<key>.txt` by definition. So they
 * are repository VARIABLES rather than repository secrets, and this is where they land in the
 * config. A missing one leaves its placeholder and is reported, which fails loudly at the surface
 * that needs it instead of silently shipping the literal string.
 */
const values = {
  TURNSTILE_SITE_KEY: process.env['TURNSTILE_SITE_KEY'] ?? null,
  STRIPE_PRICE_ID: process.env['STRIPE_PRICE_ID'] ?? null,
  INDEXNOW_KEY: process.env['INDEXNOW_KEY'] ?? null,
};

const ids = { d1: {}, kv: {}, secretsStore: null, accountId, values };
const report = [];

for (const name of want.d1) {
  const { id, created } = ensureD1(name);
  ids.d1[name] = id;
  report.push(['D1', name, created ? 'created' : 'existed', id ?? '(dry run)']);
}
for (const binding of want.kv) {
  const { id, created } = ensureKv(binding);
  ids.kv[binding] = id;
  report.push([
    'KV',
    `${kvTitle(binding)} -> ${binding}`,
    created ? 'created' : 'existed',
    id ?? '(dry run)',
  ]);
}
for (const name of want.r2) {
  const { created } = ensureR2(name);
  report.push([
    'R2',
    `${name} [${JURISDICTION}]`,
    created ? (DRY_RUN ? 'would create' : 'created') : 'existed',
    '',
  ]);
}
// The dead-letter queue must exist before the consumer that names it, or the generator's first
// deploy fails. `inventory()` yields producers before consumers, and the DLQ with its consumer.
for (const name of want.queues) {
  const { created } = ensureQueue(name);
  report.push(['Queue', name, created ? (DRY_RUN ? 'would create' : 'created') : 'existed', '']);
}
{
  const { id, created } = ensureSecretsStore();
  ids.secretsStore = id;
  report.push(['Store', SECRETS_STORE, created ? 'created' : 'existed', id ?? '(dry run)']);
}

for (const [kind, name, state, id] of report) {
  console.log(`${kind.padEnd(6)} ${name.padEnd(42)} ${state.padEnd(8)} ${id}`);
}

const zones = await knownZones();
if (zones === null) {
  console.log('\ncould not read the account zones — routes left exactly as the configs state them');
} else {
  console.log(`\nzones in this account: ${zones.size === 0 ? '(none)' : [...zones].join(', ')}`);
}

let patched = 0;
const unresolved = [];
const foreign = [];
const unrouted = [];

for (const app of readdirSync(APPS)) {
  const file = path.join(APPS, app, 'wrangler.jsonc');

  // Routes first: a zone that is not in the account fails the deploy outright, so the Worker falls
  // back to workers.dev rather than taking the whole estate down with it.
  if (zones !== null && !DRY_RUN) {
    const source = readFileSync(file, 'utf8');
    const missing = zonesOf(source).filter((zone) => !zones.has(zone));
    if (missing.length > 0) {
      writeFileSync(file, withoutRoutes(source));
      unrouted.push(`${app} (needs ${[...new Set(missing)].join(', ')})`);
    }
  } else if (zones !== null) {
    try {
      const missing = zonesOf(readFileSync(file, 'utf8')).filter((zone) => !zones.has(zone));
      if (missing.length > 0) unrouted.push(`${app} (needs ${[...new Set(missing)].join(', ')})`);
    } catch {
      // No config for this directory.
    }
  }

  let result;
  try {
    result = resolvePlaceholders(file, ids);
  } catch {
    // A config that does not exist is not an error: not every app binds a resource.
    continue;
  }
  patched += result.changed;
  for (const line of result.unresolved) unresolved.push(`${app}: ${line}`);
  for (const line of result.foreign) foreign.push(`${app}: ${line}`);
  if (result.changed > 0) {
    console.log(
      `  ${path.relative(ROOT, file)}: ${String(result.changed)} placeholder(s) ` +
        `${DRY_RUN ? 'would be filled' : 'filled'}`,
    );
  }
}

// In a dry run the resource ids were never fetched, so every one of them lands in `unresolved`.
// That is the plan rather than a problem — but the VALUES resolve either way, so the honest total
// is both halves added together.
console.log(
  `\n${DRY_RUN ? 'would fill' : 'filled'} ` +
    `${String(DRY_RUN ? unresolved.length + patched : patched)} placeholder(s)`,
);

// In a dry run every owned placeholder lands in `unresolved`, because no id was fetched. That is
// the plan, not a problem, so it is only a warning on a real run.
if (!DRY_RUN && unresolved.length > 0) {
  console.log('\nOwned but unresolved — a resource was not created. Re-run this workflow:');
  for (const line of unresolved) console.log(`  ${line}`);
}

if (foreign.length > 0) {
  console.log('\nStill yours to fill — values, not resources this script can create:');
  for (const line of foreign) console.log(`  ${line}`);
}

if (unrouted.length > 0) {
  console.log(
    `\n${DRY_RUN ? 'would serve' : 'serving'} on workers.dev — the zone these route to is not in ` +
      'this account yet. Add the domain and the routes attach on the next deploy:',
  );
  for (const line of unrouted) console.log(`  ${line}`);
}
