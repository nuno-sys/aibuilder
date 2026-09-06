import { useCallback, useRef, useState } from 'react';
import type { SiteDoc, ThemeDoc } from '@aibuilder/site-schema';

import { applyPatch } from '../../do/patch';
import type { DraftPatch } from '../../do/patch';
import type { DraftResponse } from '../../routes/site.draft';

/**
 * The editor's client state: an optimistic document, and a strict FIFO queue to the server.
 *
 * THE QUEUE IS THE WHOLE POINT. Every patch is applied locally the instant it is made — so the
 * panel and the page list update with no latency — and then sent, one at a time, in the order they
 * were made. One at a time matters because the server refuses a patch whose `expectedRev` does not
 * match: two in flight at once would have the second computed against a revision the first was
 * about to change, and it would be rejected for a reason that is entirely our own fault. FIFO
 * matters because "set this slot to A" followed by "set this slot to B" must not land as B then A.
 *
 * WHY NOT `useFetcher`. React Router cancels an in-flight fetcher submission when a new one starts.
 * On any other screen that is the right behaviour; here it means a keystroke 200 ms after another
 * cancels the first patch, whose fate is then unknown — it may or may not have been written. The
 * customer sees a word they typed disappear on the next reload. So this uses plain `fetch` against
 * a resource route and owns the ordering itself.
 *
 * WHY THE LOCAL DOCUMENT IS UPDATED WITH THE SAME `applyPatch` THE SERVER RUNS. One implementation
 * of what a patch means, running in both places, so the optimistic state and the stored state
 * cannot drift by construction. It is a pure function of `(doc, patch)` and it also tells us
 * immediately when a patch is invalid — before it costs a round trip.
 *
 * A `stale_rev` IS NOT RECOVERED FROM AUTOMATICALLY. It means another tab (or another person)
 * changed this draft. Silently reloading would discard whatever the customer had half-typed here;
 * merging is not something this vocabulary can do honestly. So the queue stops, the state goes to
 * `conflict`, and the UI asks the customer to reload — which is the only answer that cannot lose
 * work without saying so.
 */

/** What the editor is doing, as one value the UI can render. */
export type DraftStatus = 'idle' | 'saving' | 'saved' | 'rejected' | 'conflict' | 'blocked';

/** Everything the editor screen needs to render and to mutate the draft. */
export interface DraftEditor {
  readonly doc: SiteDoc;
  readonly rev: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly status: DraftStatus;
  /** Why the last patch was refused, for the UI to map to copy. `null` when nothing was refused. */
  readonly rejection: string | null;
  /** Applies a patch locally and queues it. Returns false when it was invalid locally. */
  push(patch: DraftPatch): boolean;
  undo(): void;
  redo(): void;
}

/** The queue's entry: a patch, and the local revision it was computed against. */
interface QueueEntry {
  readonly kind: 'patch';
  readonly patch: DraftPatch;
}

/** An undo or redo. They carry no payload and are ordered with the patches, not around them. */
interface StepEntry {
  readonly kind: 'undo' | 'redo';
}

type Entry = QueueEntry | StepEntry;

/** What `useDraftEditor` needs to reach the server. */
export interface DraftEditorOptions {
  readonly endpoint: string;
  readonly initialDoc: SiteDoc;
  readonly initialRev: number;
  readonly initialCanUndo: boolean;
  readonly initialCanRedo: boolean;
  /** Called with the authoritative tokens whenever the server resolved a new theme. */
  readonly onTokens: (tokens: ThemeDoc['tokens']) => void;
  /** Called after a patch has been durably stored, so the preview can be refreshed. */
  readonly onStored: (rev: number) => void;
}

/** Drives one draft. */
export function useDraftEditor(options: DraftEditorOptions): DraftEditor {
  const [doc, setDoc] = useState<SiteDoc>(options.initialDoc);
  const [rev, setRev] = useState(options.initialRev);
  const [canUndo, setCanUndo] = useState(options.initialCanUndo);
  const [canRedo, setCanRedo] = useState(options.initialCanRedo);
  const [status, setStatus] = useState<DraftStatus>('idle');
  const [rejection, setRejection] = useState<string | null>(null);

  const queue = useRef<Entry[]>([]);
  const sending = useRef(false);
  // The revision the SERVER last confirmed. Distinct from `rev` in state, which React may not have
  // committed yet when the next patch is queued — and the queue must not read a stale value from a
  // render that has not happened.
  const serverRev = useRef(options.initialRev);
  const halted = useRef(false);

  const pump = useCallback(async (): Promise<void> => {
    if (sending.current || halted.current) {
      return;
    }
    const entry = queue.current.shift();
    if (entry === undefined) {
      return;
    }
    sending.current = true;
    setStatus('saving');

    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Same-origin by construction (the endpoint is a path), but stated so a future absolute URL
        // cannot silently start sending the session cookie somewhere else.
        credentials: 'same-origin',
        body: JSON.stringify(
          entry.kind === 'patch'
            ? { intent: 'patch', patch: entry.patch, expectedRev: serverRev.current }
            : { intent: entry.kind },
        ),
      });
      const result = (await response.json()) as DraftResponse;

      if (result.ok) {
        serverRev.current = result.rev;
        setRev(result.rev);
        setCanUndo(result.canUndo);
        setCanRedo(result.canRedo);
        setStatus('saved');
        setRejection(null);
        if (result.tokens !== null) {
          options.onTokens(result.tokens);
        }
        if (result.doc !== null) {
          // Undo and redo only. The server is the only holder of the inverse patch, so its document
          // is the authoritative answer to "what does undo mean here".
          setDoc(result.doc);
        }
        options.onStored(result.rev);
      } else if (result.reason === 'stale_rev') {
        // Another writer. Stop the queue rather than replaying: a patch computed against a document
        // this client has not seen is not the edit the customer made.
        halted.current = true;
        queue.current = [];
        setStatus('conflict');
      } else if (
        result.reason === 'not_entitled' ||
        result.reason === 'entitlement_lapsed' ||
        result.reason === 'org_suspended'
      ) {
        halted.current = true;
        queue.current = [];
        setStatus('blocked');
        setRejection(result.reason);
      } else {
        // A single bad patch. Drop it and carry on: one refused edit must not stop the others, and
        // the local document is already diverged for exactly this one field, which the banner says.
        setStatus('rejected');
        setRejection(result.reason);
      }
    } catch {
      // A network failure. The patch is lost from the queue but the local document still shows it,
      // so the honest state is `rejected` — the customer is told this change was not saved rather
      // than being left to discover it later.
      setStatus('rejected');
      setRejection('network');
    } finally {
      sending.current = false;
    }

    if (queue.current.length > 0) {
      void pump();
    }
  }, [options]);

  const enqueue = useCallback(
    (entry: Entry): void => {
      queue.current.push(entry);
      void pump();
    },
    [pump],
  );

  const push = useCallback(
    (patch: DraftPatch): boolean => {
      if (halted.current) {
        return false;
      }
      // Applied locally FIRST, with the same function the server runs. An invalid patch is refused
      // here, without a round trip and without the UI briefly showing a change that will be undone.
      const outcome = applyPatch(doc, patch);
      if (!outcome.ok) {
        setStatus('rejected');
        setRejection(outcome.reason);
        return false;
      }
      setDoc(outcome.doc);
      enqueue({ kind: 'patch', patch });
      return true;
    },
    [doc, enqueue],
  );

  const undo = useCallback((): void => {
    if (halted.current || !canUndo) {
      return;
    }
    // Undo is NOT applied optimistically: the inverse patch lives in the Durable Object's history
    // and nowhere else, so this client cannot compute it. The response carries the resulting
    // document, which is why `MutationResult.doc` exists. Being one round trip slower than an edit
    // is the correct trade for not guessing what undo meant.
    enqueue({ kind: 'undo' });
  }, [canUndo, enqueue]);

  const redo = useCallback((): void => {
    if (halted.current || !canRedo) {
      return;
    }
    enqueue({ kind: 'redo' });
  }, [canRedo, enqueue]);

  return { doc, rev, canUndo, canRedo, status, rejection, push, undo, redo };
}
