import { aiTranscriptKey } from '@aibuilder/core';
import type { ZodType } from 'zod';

import { ArtifactError } from './errors';

/**
 * Step artefacts — the reason a Workflow step can hand a 400 KB document to the next one.
 *
 * A non-streaming `step.do()` return is capped at 1 MiB and is stored durably for the life of the
 * instance, so a step that returned a `SiteStructureGen` plus a `LocaleBundleGen` would be one
 * verbose bakery away from an instance that cannot be resumed. Every step therefore writes its
 * output to R2 and returns a KEY plus whatever small counts the next step needs to branch on
 * (architecture §6.1). Re-running a step overwrites the same key, which is what makes the write
 * idempotent and the retry free.
 *
 * WHY THIS KEY SHAPE IS NOT IN `@aibuilder/core/keys.ts`. That module is the registry of key shapes
 * that CROSS a Worker boundary — a renderer reads what a publish step wrote, a media Worker reads
 * what the pipeline wrote — and its value is that both sides derive the string from one function.
 * `runs/` has exactly one reader and one writer, both in this Worker, and nothing outside the
 * generator may address it. Keeping it here is what makes that statement enforceable.
 *
 * The `runs/` prefix carries the same 90-day R2 lifecycle rule as `transcripts/`: a step artefact
 * holds tenant business copy, so it is never public, never leaves the EU jurisdiction, and does not
 * outlive the cost investigation it exists for.
 */

/** The artefacts one run produces, in pipeline order. */
export const RUN_ARTIFACTS = [
  'intake',
  'media',
  'structure',
  'copy',
  'blog',
  'legal',
  'sitedoc',
  'audit',
] as const;

/** One artefact kind. */
export type RunArtifact = (typeof RUN_ARTIFACTS)[number];

/** A single safe path segment: no separators, no traversal, no control characters. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Key for one step artefact.
 *
 * `index` distinguishes the members of a fan-out (`blog.0`, `blog.1`). It is validated as an
 * integer rather than interpolated, because a key is the only thing standing between one run's
 * objects and another's.
 *
 * @throws ArtifactError when `jobId` is not a safe single path segment.
 */
export function runArtifactKey(jobId: string, artifact: RunArtifact, index?: number): string {
  if (!SEGMENT_PATTERN.test(jobId)) {
    throw new ArtifactError('artifact_invalid', jobId, 'job id is not a safe path segment');
  }
  const suffix =
    index === undefined
      ? ''
      : Number.isInteger(index) && index >= 0 && index < 100
        ? `.${String(index)}`
        : (() => {
            throw new ArtifactError('artifact_invalid', jobId, `artefact index ${String(index)}`);
          })();
  return `runs/${jobId}/${artifact}${suffix}.json`;
}

/** What a written artefact is described by. Small enough to be a `step.do()` return value. */
export interface ArtifactRef {
  readonly key: string;
  readonly bytes: number;
}

/**
 * Writes one artefact as JSON.
 *
 * Guarantees the object carries an explicit `application/json` content type — R2 does not infer one
 * and a wrong type on a private object is the kind of detail that only bites once something else
 * starts serving it — and returns the key and size for the ledger.
 */
export async function putArtifact(
  bucket: R2Bucket,
  key: string,
  value: unknown,
): Promise<ArtifactRef> {
  const body = JSON.stringify(value);
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  // `length` is code points; the object is UTF-8. The count is for the ledger, not for a range
  // request, so the cheaper measure is the right one.
  return { key, bytes: new TextEncoder().encode(body).byteLength };
}

/**
 * Reads one artefact back and validates it against its schema.
 *
 * Validating on the way IN as well as out is not belt-and-braces: the writing step may have run
 * minutes ago on another isolate, under a previous deploy, against a previous schema. An artefact
 * that no longer parses must surface as a named, retryable error at the read — not as an
 * `undefined` three functions deeper in `genToDoc`.
 *
 * @throws ArtifactError when the object is absent, unparseable, or fails the schema.
 */
export async function readArtifact<T>(
  bucket: R2Bucket,
  key: string,
  schema: ZodType<T>,
): Promise<T> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new ArtifactError('artifact_missing', key, 'no object at this key');
  }

  let raw: unknown;
  try {
    raw = await object.json();
  } catch {
    throw new ArtifactError('artifact_invalid', key, 'body is not JSON');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? 'unknown' : first.path.join('.');
    throw new ArtifactError('artifact_invalid', key, `schema mismatch at ${where}`);
  }
  return parsed.data;
}

/**
 * Writes one model call's transcript.
 *
 * One object per `(job, step, attempt)`, because Workflow steps are retried and every attempt is
 * billed — an overwritten transcript is a lost cost investigation (§10 risk 2). Best-effort: a
 * transcript that cannot be written must not fail a step whose tokens are already paid for.
 */
export async function putTranscript(
  bucket: R2Bucket,
  args: {
    readonly jobId: string;
    readonly step: string;
    readonly attempt: number;
    readonly payload: unknown;
  },
): Promise<void> {
  try {
    const key = aiTranscriptKey({ jobId: args.jobId, step: args.step, attempt: args.attempt });
    await bucket.put(key, JSON.stringify(args.payload), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
  } catch {
    // Swallowed on purpose: see the JSDoc.
  }
}
