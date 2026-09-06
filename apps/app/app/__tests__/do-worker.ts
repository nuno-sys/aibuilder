/**
 * The entry point the test pool loads.
 *
 * It exports the Durable Object class and nothing else. `workers/app.ts` would work too, and would
 * drag in `virtual:react-router/server-build`, the whole route tree and React's server renderer — so
 * a typo in a route module would surface as "every `SiteDraftDO` test failed", which is the wrong
 * signal from the wrong file. The class under test is imported from its real module; nothing is
 * re-declared.
 */

export { SiteDraftDO } from '../do/SiteDraftDO';

export default {
  /** No route under test reaches the Worker itself; every case addresses a stub directly. */
  fetch(): Response {
    return new Response('not found', { status: 404 });
  },
};
