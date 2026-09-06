import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { budgetStub, jobHubStub, quotaStub } from '../do/jurisdiction';

/**
 * Durable Object ids are minted in exactly one place, and always through `.jurisdiction('eu')`.
 *
 * §9 one-way door 3: the jurisdiction is not a filter over an existing id, it CHANGES the id. An
 * object addressed as `NS.idFromName('ip:9f3c…')` and one addressed as
 * `NS.jurisdiction('eu').idFromName('ip:9f3c…')` are two different objects with two different
 * storage volumes. Adding or removing it later does not migrate anything: it silently resets every
 * quota counter, orphans every open budget reservation, and disconnects every live SSE stream from
 * the log it was reading.
 *
 * A test rather than a comment, because the failure is silent in every environment where it
 * matters: local development has one jurisdiction, so a missing call is invisible until the day it
 * has zeroed production's counters.
 */

/** Records what a namespace was asked for. */
interface Recorder {
  readonly jurisdictions: string[];
  readonly names: string[];
  readonly namespace: DurableObjectNamespace;
}

/**
 * A namespace double that records `jurisdiction()` and `idFromName()`.
 *
 * Structural rather than a mock library: the two methods under test are the whole surface, and a
 * double this small cannot drift from the thing it stands in for.
 */
function recorder(): Recorder {
  const jurisdictions: string[] = [];
  const names: string[] = [];

  const namespace = {
    jurisdiction(value: string) {
      jurisdictions.push(value);
      return namespace;
    },
    idFromName(name: string) {
      names.push(name);
      return { toString: () => name };
    },
    get(id: unknown) {
      return { id };
    },
  };

  return { jurisdictions, names, namespace: namespace as unknown as DurableObjectNamespace };
}

/** Builds an `Env` carrying only the three namespaces these helpers touch. */
function envWith(job: Recorder, budget: Recorder, quota: Recorder): Env {
  return {
    JOB_HUB: job.namespace,
    BUDGET: budget.namespace,
    QUOTA: quota.namespace,
  } as unknown as Env;
}

describe('DO id minting', () => {
  it('applies the EU jurisdiction to every namespace', () => {
    const job = recorder();
    const budget = recorder();
    const quota = recorder();
    const env = envWith(job, budget, quota);

    jobHubStub(env, 'job_01ABC');
    budgetStub(env);
    quotaStub(env, 'ip', '9f3c');

    expect(job.jurisdictions).toEqual(['eu']);
    expect(budget.jurisdictions).toEqual(['eu']);
    expect(quota.jurisdictions).toEqual(['eu']);
  });

  it('names the job hub after the job, so authorisation and identity share one value', () => {
    const job = recorder();
    jobHubStub(envWith(job, recorder(), recorder()), 'job_01ABC');

    expect(job.names).toEqual(['job_01ABC']);
  });

  it('gives the budget exactly one instance, never derived from a request value', () => {
    const budget = recorder();
    const env = envWith(recorder(), budget, recorder());

    budgetStub(env);
    budgetStub(env);

    // Spend is one number for the whole product, so it is one object.
    expect(new Set(budget.names)).toEqual(new Set(['global']));
  });

  it('keeps quota subjects of different types apart', () => {
    const quota = recorder();
    const env = envWith(recorder(), recorder(), quota);

    quotaStub(env, 'ip', 'same');
    quotaStub(env, 'email', 'same');

    // An IP hash and an e-mail hash that happened to collide as strings are still two limits.
    expect(quota.names).toEqual(['ip:same', 'email:same']);
  });
});
