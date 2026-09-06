import type { Env } from '../env';
import type { SiteDraftDO } from './SiteDraftDO';

/**
 * The only place in this Worker that mints a Durable Object id.
 *
 * THIS IS A ONE-WAY DOOR (architecture §9, one-way door 3), and it is the same one
 * `apps/generator/src/do/jurisdiction.ts` documents. `.jurisdiction('eu')` is not a filter applied
 * to an existing id — it changes the id itself. `NS.idFromName('ste_…')` and
 * `NS.jurisdiction('eu').idFromName('ste_…')` are two different objects with two different storage
 * volumes, so adding the jurisdiction after the fact does not move a draft: it silently makes every
 * existing customer's unsaved work unreachable.
 *
 * Which is why there is one function and no exported helper that takes a namespace: a call site
 * cannot forget the jurisdiction, because a call site never sees a namespace.
 *
 * The EU jurisdiction is also what makes the residency claim in architecture §1.3 true for draft
 * content — which is customer copy, and therefore the most identifying data this Worker holds.
 */

/** The jurisdiction every Durable Object in this product lives in. Never a parameter. */
const JURISDICTION = 'eu';

/**
 * The draft object for one site.
 *
 * Named after the site id, so a draft's identity and the authorisation that reaches it are derived
 * from the same value: `requireSiteAccess` proves membership for that id, and this addresses the
 * object for that id. There is no second mapping to get wrong.
 */
export function siteDraftStub(env: Env, siteId: string): DurableObjectStub<SiteDraftDO> {
  const namespace = env.SITE_DRAFT.jurisdiction(JURISDICTION);
  return namespace.get(namespace.idFromName(siteId));
}
