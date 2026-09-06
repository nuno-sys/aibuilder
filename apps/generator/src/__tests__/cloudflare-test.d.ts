import type { BudgetDO } from '../do/BudgetDO';
import type { JobHub } from '../do/JobHub';
import type { QuotaDO } from '../do/QuotaDO';

/**
 * The bindings the test pool provides, as `cloudflare:test`'s `env`.
 *
 * `@cloudflare/vitest-pool-workers` v0.22 types `env` as `Cloudflare.Env` — the global interface
 * `wrangler types` generates — rather than the `ProvidedEnv` interface earlier versions exported.
 * Augmenting `ProvidedEnv` therefore has no effect and the declaration has to land in the global
 * `Cloudflare` namespace instead. This file has imports, so it is a module, so the augmentation
 * must be wrapped in `declare global`.
 *
 * Only what `vitest.config.ts` actually configures is declared. Declaring the full production `Env`
 * here would type bindings that are `undefined` at runtime as present, and the first test to touch
 * one would fail with a `TypeError` instead of a compile error.
 *
 * The namespaces are PARAMETERISED by their class, which is what lets `runInDurableObject()` infer
 * the instance type and hand a test the real object rather than an opaque stub. That works because
 * the three classes extend `DurableObject` from `cloudflare:workers` and therefore carry the brand
 * `DurableObjectNamespace<T>` requires.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      readonly JOB_HUB: DurableObjectNamespace<JobHub>;
      readonly BUDGET: DurableObjectNamespace<BudgetDO>;
      readonly QUOTA: DurableObjectNamespace<QuotaDO>;
      readonly ENVIRONMENT: string;
    }
  }
}

export {};
