import type { Env } from '../env';

/**
 * `BudgetDO` — layer 6 of the funnel, and the only thing standing between a bot and the bill
 * (architecture §8, §10 risk 1).
 *
 * ONE GLOBAL INSTANCE. Spend is a single number for the whole product, so there is exactly one
 * instance, named `global`, in the EU jurisdiction. It is the serialisation point for every
 * reservation; that is the cost of counting money correctly and it is worth it at Phase 1 volume.
 *
 * STAGED DEGRADATION IS WHAT MAKES A HARD CAP SURVIVABLE. A naive cap turns a bot attack into a
 * customer outage: the attacker spends the day's budget by 09:00 and every real bakery that signs
 * up afterwards sees a failure. So the ceiling degrades instead of failing (architecture §8):
 *
 *   < 70 %   generate immediately
 *   70-85 %  require e-mail confirmation before generating — kills essentially all automated
 *            abuse, costs a real user twenty seconds
 *   85-100 % confirm and queue
 *   >= 100 % onboarding still succeeds; the lead, the media and the job row are all kept and the
 *            generation is deferred with an honest "we'll e-mail you within the hour". Nothing is
 *            lost, no money is spent, and the result is a human review queue for free.
 *
 * WHERE THE DECISION LIVES. The DO owns the numbers — it performs the atomic reservation and
 * reports spend against the cap. The thresholds are policy and live here, in one place, next to the
 * response shapes they map to. That split is deliberate: changing a threshold must not require
 * touching the object that holds the money.
 *
 * THE WIRE CONTRACT, implemented by `apps/generator/src/do/BudgetDO.ts`:
 *
 * ```
 * POST https://budget.internal/reserve  { "jobId": "job_…", "estimateMicro": 1200000 }
 *   -> 200 { "accepted": bool, "reservationId": string|null,
 *            "spentMicro": number, "capMicro": number,
 *            "generationsToday": number, "generationsCap": number }
 * POST https://budget.internal/settle   { "reservationId": "…", "actualMicro": number }
 *   -> 204
 * ```
 *
 * `reserve` includes the caller's estimate in `spentMicro` when it accepts, so the ratio below
 * already accounts for the request being decided. The generator settles the reservation against
 * real `usage` after the run; the API settles at zero when it reserved and then could not
 * dispatch, which is the only compensation path this Worker owns.
 */

/**
 * The planning figure from architecture §6.5: $1.20 per free generation, hard-ceilinged per call by
 * `output_config.task_budget`. Stored in micro-dollars because money never touches a float.
 *
 * §10 risk 2 is explicit that this number is estimated rather than measured; `generation_calls`
 * records every real call from day one so that §6.5 can be rewritten from observation before
 * Phase 2 pricing is fixed. When that happens, this constant moves and nothing else does.
 */
export const GENERATION_ESTIMATE_USD_MICRO = 1_200_000;

/** Below this share of the daily cap, generate immediately. */
const CONFIRM_THRESHOLD = 0.7;

/** At or above this share, confirm AND queue rather than generating on the spot. */
const QUEUE_THRESHOLD = 0.85;

/** What the caller may do with this request. */
export type BudgetMode = 'allow' | 'confirm_email' | 'queued';

/** The outcome of a reservation attempt. */
export interface BudgetReservation {
  readonly mode: BudgetMode;
  /** Present whenever the DO actually reserved; `settleBudget()` needs it to unwind. */
  readonly reservationId: string | null;
  /** Spend as a share of the daily cap, for the ops digest. `null` when the DO did not answer. */
  readonly spentRatio: number | null;
}

/** Base URL of the internal DO API. The host is never resolved; only the path is read. */
const BUDGET_ORIGIN = 'https://budget.internal';

/** The single instance's name. Never derived from a request value. */
const GLOBAL_INSTANCE = 'global';

/** The DO's reservation answer. */
interface ReserveResponseBody {
  readonly accepted: boolean;
  readonly reservationId: string | null;
  readonly spentMicro: number;
  readonly capMicro: number;
  readonly generationsToday: number;
  readonly generationsCap: number;
}

/** Jurisdiction is not optional and is not configurable. Architecture §9 one-way door 3. */
function stub(env: Env): DurableObjectStub {
  const namespace = env.BUDGET.jurisdiction('eu');
  return namespace.get(namespace.idFromName(GLOBAL_INSTANCE));
}

/** Narrows the DO's JSON, or returns `null` when it answered something unexpected. */
function parseReserve(value: unknown): ReserveResponseBody | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const accepted = record['accepted'];
  const spentMicro = record['spentMicro'];
  const capMicro = record['capMicro'];
  if (
    typeof accepted !== 'boolean' ||
    typeof spentMicro !== 'number' ||
    typeof capMicro !== 'number'
  ) {
    return null;
  }
  const reservationId = record['reservationId'];
  const generationsToday = record['generationsToday'];
  const generationsCap = record['generationsCap'];
  return {
    accepted,
    reservationId: typeof reservationId === 'string' ? reservationId : null,
    spentMicro,
    capMicro,
    generationsToday: typeof generationsToday === 'number' ? generationsToday : 0,
    generationsCap: typeof generationsCap === 'number' ? generationsCap : 0,
  };
}

/** Maps an accepted reservation's position against the cap onto the staged mode. */
function modeForRatio(ratio: number): BudgetMode {
  if (ratio < CONFIRM_THRESHOLD) {
    return 'allow';
  }
  return ratio < QUEUE_THRESHOLD ? 'confirm_email' : 'queued';
}

/**
 * Reserves the estimated cost of one generation and decides how far it may proceed.
 *
 * Guarantees that a returned `allow` was backed by an accepted reservation in the Durable Object,
 * and that a refusal — whether the cap was reached or the DO could not be reached at all — never
 * comes back as `allow`. Failing closed is the correct direction here and it is not a customer
 * outage: `queued` keeps the lead, the media and the job row and defers only the spend.
 */
export async function reserveBudget(
  env: Env,
  args: { readonly jobId: string; readonly estimateMicro: number },
): Promise<BudgetReservation> {
  let parsed: ReserveResponseBody | null = null;
  try {
    const response = await stub(env).fetch(`${BUDGET_ORIGIN}/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: args.jobId, estimateMicro: args.estimateMicro }),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      parsed = parseReserve(body);
    }
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    return { mode: 'queued', reservationId: null, spentRatio: null };
  }
  if (!parsed.accepted) {
    return { mode: 'queued', reservationId: parsed.reservationId, spentRatio: 1 };
  }

  const ratio = parsed.capMicro > 0 ? parsed.spentMicro / parsed.capMicro : 1;
  const generationRatio =
    parsed.generationsCap > 0 ? parsed.generationsToday / parsed.generationsCap : 0;
  // Two ceilings, one decision: 250 generations/day and $500/day are both hard caps, so the
  // stricter of the two drives the degradation. Ignoring the generation count would let a day of
  // unusually cheap runs sail past the volume ceiling.
  return {
    mode: modeForRatio(Math.max(ratio, generationRatio)),
    reservationId: parsed.reservationId,
    spentRatio: ratio,
  };
}

/**
 * Settles a reservation against what was actually spent.
 *
 * The generator calls this with real `usage` after a run. This Worker calls it with zero on exactly
 * one path — it reserved, and then failed to dispatch the Workflow — because a reservation that is
 * never settled ratchets the daily counter against a generation that never happened. The DO's
 * +10-minute alarm force-settles orphans at estimate, so this is an optimisation of a safety net
 * rather than the safety net itself.
 *
 * Best-effort: a failure here is logged by the DO's own alarm path, and blocking a user's response
 * on a compensating write would trade a correct number for a slow product.
 */
export async function settleBudget(
  env: Env,
  args: { readonly reservationId: string; readonly actualMicro: number },
): Promise<void> {
  try {
    await stub(env).fetch(`${BUDGET_ORIGIN}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservationId: args.reservationId, actualMicro: args.actualMicro }),
    });
  } catch {
    // Intentionally ignored: the DO's force-settle alarm is the guarantee, this is the fast path.
  }
}
