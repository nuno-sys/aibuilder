/**
 * The runner: `node scripts/preview/run.mjs <command>`.
 *
 * WHY A RUNNER AND NOT `tsx`. `tsx` is not installed anywhere in this repo (`node_modules/.bin`
 * has esbuild, tsc, vitest and wrangler, and no tsx), and the root `package.json` is not this
 * task's to edit, so `npx tsx scripts/preview/render.ts` would go to the network on every run.
 * The repo already ships esbuild 0.28, so each entry point is bundled with it — through the CLI
 * shim in `node_modules/.bin`, because pnpm does not hoist `esbuild` itself into a directory the
 * Node resolver can reach from here.
 *
 * The bundle lands in `scripts/preview/dist/` and NOT in the output directory, for two reasons:
 * `playwright` is marked external and Node resolves it from the *bundle's* directory, so the
 * bundle has to sit next to the `node_modules/` that `npm install` created in here; and the root
 * eslint config already ignores every `dist` directory, so `pnpm lint` never sees 30 000 lines
 * of bundled vendor code.
 *
 * Commands:
 *   media    write the placeholder imagery and the fonts into .preview/_shared
 *   render   media + render every demo page to .preview/<site>/<locale>/…/index.html
 *   serve    render output over HTTP, one port per demo site (Ctrl-C to stop)
 *   shoot    render + start the servers in-process + screenshot every page
 *   all      render, then shoot
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD_DIR = path.join(HERE, 'dist');
const ESBUILD = path.join(ROOT, 'node_modules', '.bin', 'esbuild');

/** Entry module per command. `all` is a sequence of commands, not a module. */
const ENTRIES = {
  media: 'media.ts',
  render: 'render.ts',
  serve: 'serve.ts',
  shoot: 'shoot.ts',
};

/** Internal packages expose `"exports": { ".": "./src/index.ts" }`, which esbuild cannot follow. */
const ALIASES = {
  '@aibuilder/site-kit': path.join(ROOT, 'packages/site-kit/src/index.ts'),
  '@aibuilder/site-schema': path.join(ROOT, 'packages/site-schema/src/index.ts'),
  '@aibuilder/core': path.join(ROOT, 'packages/core/src/index.ts'),
};

/**
 * Bundles one entry module and returns the path of the bundle.
 *
 * Every entry module exports `main(argv)` and runs nothing on import, so the bundle can be
 * imported here and called — which is also what lets `render.ts` import `media.ts` as a library.
 */
function bundle(command) {
  const entry = path.join(HERE, ENTRIES[command]);
  mkdirSync(BUILD_DIR, { recursive: true });
  const outfile = path.join(BUILD_DIR, `${command}.mjs`);
  execFileSync(
    ESBUILD,
    [
      entry,
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--target=node22',
      '--jsx=automatic',
      '--jsx-import-source=hono/jsx',
      ...Object.entries(ALIASES).map(([name, target]) => `--alias:${name}=${target}`),
      '--external:playwright',
      '--sourcemap=inline',
      '--log-level=warning',
      `--outfile=${outfile}`,
    ],
    { stdio: 'inherit', cwd: HERE },
  );
  return outfile;
}

/** Bundles and runs one command in this process, so its exit code is ours. */
async function run(command, argv) {
  const outfile = bundle(command);
  // The bundle sits one directory deeper than the source, so `import.meta.url` inside it would
  // resolve `.preview/` and `node_modules/` to the wrong places. The modules read these instead.
  process.env.PREVIEW_HARNESS_DIR = HERE;
  process.env.PREVIEW_REPO_ROOT = ROOT;
  const module = await import(pathToFileURL(outfile).href);
  await module.main(argv);
}

const [command = 'all', ...argv] = process.argv.slice(2);

if (command === 'all') {
  await run('render', argv);
  await run('shoot', argv);
} else if (command in ENTRIES) {
  await run(command, argv);
} else {
  console.error(
    `unknown command "${command}"; expected one of: all, ${Object.keys(ENTRIES).join(', ')}`,
  );
  process.exitCode = 2;
}
