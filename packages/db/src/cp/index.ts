/**
 * Control-plane statement modules, one namespace per aggregate.
 *
 * Namespaced rather than flattened so a statement always reads `cp.sites.getLiveSiteBySlug(...)`
 * at the call site: the database and the aggregate are visible without opening the import list,
 * which matters in a codebase where the same verb exists against two different databases.
 */
export * as drafts from './drafts';
export * as orgs from './orgs';
export * as quotas from './quotas';
export * as sites from './sites';
export * as slugs from './slugs';
export * as users from './users';
