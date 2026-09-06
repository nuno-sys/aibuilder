// @ts-check
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

/**
 * Workspace package directory names under `packages/`. Each one is its own boundaries element type,
 * so the dependency policy below reads as the architecture's §2 sentence rather than as globs.
 */
const SITE_SCHEMA = 'site-schema';
const SITE_KIT = 'site-kit';
const CORE = 'core';
const AI = 'ai';
const AUTH = 'auth';
const DB = 'db';
const UI = 'ui';
const CONFIG = 'config';

/** Every element type that lives under `packages/`. */
const PACKAGE_TYPES = [SITE_SCHEMA, SITE_KIT, CORE, AI, AUTH, DB, UI, CONFIG];

/** The npm scope every internal package publishes under. */
const SCOPE = '@aibuilder';

/**
 * The allowed local dependency graph, straight out of architecture §2:
 *
 *   site-schema  depends on nothing — it is the contract, and it must stay loadable anywhere.
 *   site-kit     depends only on site-schema — no bindings, no `env`, renders in a plain runner.
 *   core         owns the publish pipeline, so it may read the contract, render through site-kit
 *                and write through db. It touches bindings only via an injected `Env`.
 *   ai           speaks to Anthropic in the shape of the contract, nothing else.
 *   db           is the bottom of the stack: statements and schema only.
 *   ui           shares React components with the marketing island; it may read contract types.
 *   config       is presets only.
 *
 * Apps may use any package. Packages may never import an app, and apps may never import each other.
 *
 * This object is the only place the graph is written down; the policy list below is derived from it.
 *
 * @type {Record<string, readonly string[]>}
 */
const ALLOWED_LOCAL_DEPENDENCIES = {
  [SITE_SCHEMA]: [],
  [SITE_KIT]: [SITE_SCHEMA],
  [CORE]: [SITE_SCHEMA, SITE_KIT, DB],
  // `ai` needs `core` for `redactForModel()` and the industry taxonomy that drives the
  // design-DNA mapping. `core` imports no Cloudflare runtime (rule 5 below), so this does not
  // put a binding behind the prompt builder.
  [AI]: [SITE_SCHEMA, CORE],
  // `auth` owns sessions, magic links and passkeys: it needs the id/redaction helpers from
  // `core` and the `sessions` / `auth_tokens` statements from `db`.
  [AUTH]: [CORE, DB],
  [DB]: [],
  [UI]: [SITE_SCHEMA],
  [CONFIG]: [],
  app: PACKAGE_TYPES,
};

/**
 * Builds a micromatch pattern matching the package specifiers for `types`.
 * A single-item brace expression is not expanded by micromatch, so the one-element case is special.
 *
 * @param {readonly string[]} types
 * @returns {string} e.g. `@aibuilder/{site-schema,db}`
 */
function specifierPattern(types) {
  return types.length === 1 ? `${SCOPE}/${types[0]}` : `${SCOPE}/{${types.join(',')}}`;
}

/**
 * One `boundaries/dependencies` policy allowing `from` to depend on `to`, expressed in both
 * channels the plugin can see a workspace dependency through.
 *
 * Both channels are needed and neither is redundant: a relative import (or a bare specifier the
 * resolver manages to follow into the workspace) is classified as a local *element*, while a bare
 * `@aibuilder/x` import that the node resolver cannot follow — internal packages expose only
 * `"exports": { ".": "./src/index.ts" }`, and `eslint-import-resolver-node` does not read
 * `exports` — is classified as an external *module*. Covering only one channel would leave the
 * other silently unchecked.
 *
 * @param {string} from element type doing the importing
 * @param {readonly string[]} to element types it may import
 * @returns {import('eslint-plugin-boundaries').DependenciesPolicy[]}
 */
function allowLocal(from, to) {
  if (to.length === 0) return [];
  return [
    {
      from: { element: { type: from } },
      allow: {
        to: [
          { element: { types: { anyOf: [...to] } } },
          { module: { source: specifierPattern(to) } },
        ],
      },
    },
  ];
}

/** @type {import('eslint-plugin-boundaries').DependenciesRuleOptions} */
const dependencyPolicy = {
  default: 'disallow',
  // Workspace packages imported by name are seen as external modules (see `allowLocal`), so the
  // rule has to look at external origins at all.
  checkAllOrigins: true,
  policies: [
    // 1. Third-party packages and runtime built-ins are unrestricted by default. The narrower
    //    policies below re-restrict the parts that are ours. Evaluation is last-write-wins.
    { allow: { to: { module: { origin: 'external' } } } },
    { allow: { to: { module: { origin: 'core' } } } },

    // 2. Nothing may import an app. Apps are deployables, not libraries.
    {
      disallow: { to: { element: { type: 'app' } } },
      message: 'Apps are deployables: nothing may import from apps/* (architecture §2).',
    },

    // 3. Everything in the workspace scope is denied, then granted back per element.
    {
      disallow: { to: { module: { source: `${SCOPE}/*` } } },
      message:
        'This workspace dependency is not in the boundary policy. See eslint.config.js and architecture §2.',
    },

    // 4. The allowed graph. Elements with an empty list get no policy at all, which leaves them on
    //    the `default: 'disallow'` — that is exactly the "depends on nothing" rule.
    ...Object.entries(ALLOWED_LOCAL_DEPENDENCIES).flatMap(([from, to]) => allowLocal(from, to)),

    // 5. `core` may touch bindings only through an injected `Env`, and site-schema/site-kit must
    //    render in a plain test runner. Reaching for the Workers runtime from inside a package is
    //    how that guarantee gets lost, so no package may import `cloudflare:*` at all. Apps —
    //    which own the `wrangler.jsonc` that defines those bindings — still may.
    {
      from: { element: { types: { anyOf: PACKAGE_TYPES } } },
      disallow: { to: { module: { source: 'cloudflare:*' } } },
      message:
        'Packages never import the Workers runtime: take the binding as an injected Env parameter (architecture §2).',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.astro/**',
      '**/.wrangler/**',
      '**/.turbo/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },

  // House rules that encode the quality bar the whole repo is written to.
  {
    files: ['**/*.{ts,tsx,mts}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          // `typeof import('m')` is the only way to type a module that is deliberately loaded
          // late (Step5Contact defers the 145 KB phone metadata). Banning it would force the
          // module into the eager graph, which is the opposite of the intent.
          disallowTypeAnnotations: false,
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // Architecture §4, invariant 1: no model string ever reaches the DOM except as a text node.
  // The renderer has exactly one escape hatch to lose that property, so it is closed here.
  {
    files: ['packages/site-kit/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message:
            'site-kit renders through escapeHtml() only — innerHTML breaks the injection boundary (architecture §4, invariant 1).',
        },
        {
          selector: "MemberExpression[property.name='outerHTML']",
          message:
            'site-kit renders through escapeHtml() only — outerHTML breaks the injection boundary (architecture §4, invariant 1).',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'site-kit renders through escapeHtml() only — dangerouslySetInnerHTML breaks the injection boundary (architecture §4, invariant 1).',
        },
      ],
    },
  },

  // Architectural boundaries. Scoped to the two workspace roots so that root-level tooling files
  // (this config, vitest configs) are never classified as unknown elements.
  {
    files: ['apps/**/*.{ts,tsx,mts}', 'packages/**/*.{ts,tsx,mts}'],
    plugins: { boundaries },
    settings: {
      // `partialMatch: false` anchors each pattern at the repo root, so `packages/core` cannot be
      // matched by some future `apps/x/packages/core`.
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*', partialMatch: false, capture: ['app'] },
        ...PACKAGE_TYPES.map((type) => ({
          type,
          pattern: `packages/${type}`,
          partialMatch: false,
        })),
      ],
      // The bundled node resolver only knows `.js` out of the box; without this every relative
      // TypeScript import resolves to nothing and the element channel of the policy goes quiet.
      'import/resolver': {
        node: { extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'] },
      },
    },
    rules: {
      'boundaries/dependencies': ['error', dependencyPolicy],
    },
  },
  {
    // `packages/core` carries `@types/node` for its seed-parity test, so the compiler can no longer
    // stop a source file from reaching for a Node builtin that does not exist in workerd. Tests are
    // exempt: reading a fixture from disk is exactly what they are for.
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    ignores: ['packages/*/src/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'Packages run on workerd, not Node: take the capability as an injected parameter (architecture §2).',
            },
          ],
        },
      ],
    },
  },

  {
    // Build-time scripts run in Node, not workerd. Declared explicitly rather than pulling in the
    // `globals` package for one file.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
      },
    },
  },
);
