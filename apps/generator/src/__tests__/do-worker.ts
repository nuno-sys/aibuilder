/**
 * The entry point the test pool loads.
 *
 * It exports the three Durable Object classes and nothing else. `src/index.ts` would work too, and
 * would drag in `src/workflow.ts`, `cloudflare:workflows` and every step file — so a typo in
 * `steps/blog.ts` would surface as "every JobHub test failed", which is the wrong signal from the
 * wrong file. The classes under test are imported from their real modules; nothing is re-declared.
 */

export { JobHub } from '../do/JobHub';
export { BudgetDO } from '../do/BudgetDO';
export { QuotaDO } from '../do/QuotaDO';

export default {
  /** No route under test reaches the Worker itself; every case addresses a stub directly. */
  fetch(): Response {
    return new Response('not found', { status: 404 });
  },
};
