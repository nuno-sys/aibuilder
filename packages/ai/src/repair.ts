import type { BundleValidation, Repair } from '@aibuilder/site-schema';
import type { SchemaIssue, StructuredCallMeta, StructuredCallOutcome } from './call';
import { RepairExhaustedError } from './errors';
import type { Defect } from './errors';
import type { PromptMessage } from './protocol';
import type { CallUsage, TokenPrices } from './usage';
import { EMPTY_USAGE, OPUS_5_PRICES, addUsage, costUsdMicro } from './usage';

/**
 * The repair ladder: free first, one paid turn second, fail third.
 *
 * Grammar-constrained decoding all but eliminates *syntactic* failure. What is left is semantic --
 * a missing slot id, a dangling media ref, an over-long title, duplicate section ids -- and the
 * escalation is fixed, because the expensive mistake is to regenerate from scratch:
 *
 *   1. **Deterministic repair** (`normalize()` from `@aibuilder/site-schema`): free, and it fixes
 *      roughly nine defects in ten. It truncates at word boundaries, drops unknown slot ids,
 *      de-duplicates, clamps and nulls dangling refs. It never invents copy.
 *   2. **One repair turn**, only for what code cannot fix -- genuinely missing copy. It is a `user`
 *      message carrying a machine-generated `{path, problem, constraint}` list plus the document to
 *      correct. It must be a user turn: assistant prefill returns a 400 on `claude-opus-5`, and
 *      replaying the model's own output as an assistant turn additionally drags in the thinking-block
 *      continuation rules for no benefit. The cached prefix still hits, so the round is cheap.
 *   3. **Fail the step** after at most two rounds. Workflows re-runs it, which draws a fresh sample
 *      -- strictly better than pushing the same defective document through a third repair.
 */

/** Hard ceiling on paid repair turns per step, mirrored by `generation_calls.repair_rounds`. */
export const MAX_REPAIR_ROUNDS = 2;

/** What `normalize()` returns: a repaired document, or `null` when nothing publishable survived. */
export interface DeterministicRepairResult<T> {
  readonly value: T | null;
  readonly repairs: readonly Repair[];
}

/** Turns Zod issues into defects a model can act on. */
export function defectsFromSchemaIssues(issues: readonly SchemaIssue[]): readonly Defect[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path : '(root)',
    problem: issue.message,
    constraint: 'the field must match the schema supplied with this request',
  }));
}

/**
 * Turns a bundle validation into defects.
 *
 * Only `missing` and `blank` appear: `unknown`, `duplicate` and `overlong` are all repaired by
 * `normalizeLocaleBundle()` for free, and spending a model turn on them would be paying for work
 * already done.
 */
export function defectsFromBundleValidation(validation: BundleValidation): readonly Defect[] {
  const defects: Defect[] = [];
  for (const id of validation.missing) {
    defects.push({
      path: id,
      problem: 'no entry was written for this slot id',
      constraint: 'every slot id in the brief needs exactly one non-empty entry',
    });
  }
  for (const id of validation.blank) {
    defects.push({
      path: id,
      problem: 'the entry for this slot id is empty',
      constraint: 'write real copy for it, or the element renders blank on the live site',
    });
  }
  return defects;
}

/**
 * Builds the repair turn.
 *
 * The previous document is echoed in full. It costs fresh input tokens, and it buys the one thing
 * that matters: the model corrects the named defects instead of writing a different site, so the
 * work already paid for survives the round.
 */
export function repairMessage(
  defects: readonly Defect[],
  previousDocument: unknown,
  round: number,
): PromptMessage {
  const list = defects
    .slice(0, 60)
    .map(
      (defect) =>
        `- path: ${defect.path}\n  problem: ${defect.problem}\n  fix: ${defect.constraint}`,
    )
    .join('\n');
  const omitted = defects.length > 60 ? `\n(+${defects.length - 60} more of the same kind)` : '';
  return {
    role: 'user',
    content: `<task step="repair" round="${round}">
The document below is the one you just produced. It cannot be used as it stands. Emit the WHOLE
document again, corrected -- same schema, same structure, same decisions everywhere the defect list
is silent. Change only what the list names, and do not explain the changes.

Defects:
${list}${omitted}

Your previous document:
${JSON.stringify(previousDocument)}
</task>`,
  };
}

/* -- The ladder ------------------------------------------------------------------------------ */

/** Everything the ladder needs. The call itself is injected, so the ladder is model-agnostic. */
export interface RepairLadderInput<T> {
  /** Runs one call, appending `extraMessages` after the facts and task turns. */
  readonly call: (extraMessages: readonly PromptMessage[]) => Promise<StructuredCallOutcome<T>>;
  /** The free pass: `normalizeStructure`, `normalizeLocaleBundle` or `normalizeBlogPost`. */
  readonly normalize: (raw: unknown) => DeterministicRepairResult<T>;
  /** Semantic checks code can make but the schema cannot express, e.g. bundle key-set equality. */
  readonly inspect?: ((value: T) => readonly Defect[]) | undefined;
  readonly maxRounds?: number | undefined;
  readonly prices?: TokenPrices | undefined;
}

/** A document that survived the ladder, with everything the ledger and the transcript need. */
export interface RepairLadderResult<T> {
  readonly value: T;
  /** Paid repair turns actually spent: 0, 1 or 2. */
  readonly rounds: number;
  readonly usage: CallUsage;
  readonly costUsdMicro: number;
  readonly calls: readonly StructuredCallMeta[];
  /** Everything deterministic repair had to fix. A rising count here is a prompt-quality signal. */
  readonly repairs: readonly Repair[];
}

/**
 * Runs a call through the repair ladder.
 *
 * Guarantees: deterministic repair runs on every response, including a schema-valid one, so length
 * clamping and ref pruning always happen; at most `maxRounds` (default 2) paid repair turns are
 * spent; the returned usage is the sum over every round, so a document that needed two repairs is
 * costed as what it actually was; and exhaustion throws a retryable `RepairExhaustedError` carrying
 * the defects that beat it.
 */
export async function runRepairLadder<T>(
  input: RepairLadderInput<T>,
): Promise<RepairLadderResult<T>> {
  const maxRounds = input.maxRounds ?? MAX_REPAIR_ROUNDS;
  const prices = input.prices ?? OPUS_5_PRICES;
  const calls: StructuredCallMeta[] = [];
  const repairs: Repair[] = [];
  let usage: CallUsage = EMPTY_USAGE;
  let extraMessages: readonly PromptMessage[] = [];
  let rounds = 0;

  for (;;) {
    const outcome = await input.call(extraMessages);
    calls.push(outcome.meta);
    usage = addUsage(usage, outcome.meta.usage);

    const normalized = input.normalize(outcome.raw);
    repairs.push(...normalized.repairs);

    let defects: readonly Defect[];
    if (normalized.value === null) {
      defects =
        outcome.kind === 'invalid'
          ? defectsFromSchemaIssues(outcome.issues)
          : [
              {
                path: '(root)',
                problem: 'the document had no usable content after deterministic repair',
                constraint:
                  'emit a complete document with at least one page and its required fields',
              },
            ];
    } else {
      defects = input.inspect === undefined ? [] : input.inspect(normalized.value);
      if (defects.length === 0) {
        return {
          value: normalized.value,
          rounds,
          usage,
          costUsdMicro: costUsdMicro(usage, prices),
          calls,
          repairs,
        };
      }
    }

    if (rounds >= maxRounds) {
      throw new RepairExhaustedError({ defects, rounds, usage });
    }
    rounds += 1;
    extraMessages = [repairMessage(defects, outcome.raw, rounds)];
  }
}
