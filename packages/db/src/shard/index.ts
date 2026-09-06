/**
 * Shard statement modules, one namespace per aggregate.
 *
 * Every function here takes the D1 binding of ONE shard, resolved through
 * `shard-router.shardById(row.shard_id, env)`. None of them can reach the control plane, and none
 * of them may be handed the control-plane binding: the two databases share no table names by
 * accident, but they do share column names, and a mistaken binding would fail at the statement
 * rather than at the type. Resolving the binding from a stored `shard_id` is what keeps that
 * mistake impossible in practice.
 */
export * as blobs from './blobs';
export * as editor from './editor';
export * as generationCalls from './generation-calls';
export * as generationJobs from './generation-jobs';
export * as leads from './leads';
export * as media from './media';
export * as versions from './versions';
