/** @jsxImportSource react */
import { useEffect, useMemo, useRef } from 'react';
import { deriveSlotInventoryForPages, textFor } from '@aibuilder/site-schema';
import type { SiteDoc, SlotDescriptor } from '@aibuilder/site-schema';
import { Field, TextArea, TextInput } from '@aibuilder/ui';

import type { DraftPatch } from '../../do/patch';
import type { Copy } from '../../lib/copy';

/**
 * The copy panel: one field per slot of the page being previewed.
 *
 * THE SLOT IDS COME FROM `deriveSlotInventoryForPages` AND NOWHERE ELSE. That function is described
 * by `site-schema/slots.ts` as "THE single derivation of every slot id in the system", and it says
 * in its own header that nothing may build a slot id by hand. This panel obeys that literally: it
 * derives the inventory from the document's pages and renders whatever comes back, in document
 * order, with each field's ceiling taken from the descriptor's own `maxLength`. A hand-built id here
 * would be a field that saves nothing, discovered by a customer.
 *
 * THE FIELDS ARE UNCONTROLLED, and that is deliberate. A controlled input on a debounced save path
 * fights the customer's cursor: every state update re-renders, and a re-render mid-composition
 * moves the caret and breaks IME input for anyone typing with one. `defaultValue` plus a debounced
 * `onChange` leaves the DOM node's value alone and sends what it holds.
 *
 * THE DEBOUNCE IS PER FIELD, not global. Typing in the headline and then in the sub-headline must
 * not have the second reset the first field's timer — the first patch would then be delayed by the
 * whole of the second field's typing, and a customer who closes the tab loses it.
 *
 * THE CEILING IS ENFORCED IN THREE PLACES, and all three are needed: `maxLength` on the input, so
 * the browser stops the typing; the count under the field, so the customer knows why; and
 * `applyPatch`, which measures code points rather than UTF-16 units and is the one that actually
 * decides. An emoji is one column in a layout and two units in a string.
 */

/** How long after the last keystroke a field's patch is queued. */
const DEBOUNCE_MS = 400;

/** Slot kinds whose copy is long enough to want a multi-line control. */
const MULTILINE_KINDS = new Set<SlotDescriptor['kind']>([
  'body',
  'item_body',
  'answer',
  'person_bio',
  'meta_description',
  'menu_item_description',
]);

/** A human label for a slot, built from what the descriptor knows. */
function slotLabel(slot: SlotDescriptor): string {
  const tail = slot.id.slice(slot.id.lastIndexOf('.') + 1);
  return slot.sectionType === null ? `${tail}` : `${slot.sectionType} · ${tail}`;
}

export interface ContentPanelProps {
  readonly copy: Copy;
  readonly doc: SiteDoc;
  /** The page whose slots are shown. Always the page the preview is displaying. */
  readonly pageId: string;
  readonly locale: string;
  readonly onPatch: (patch: DraftPatch) => void;
}

/** Renders the copy fields of one page in one locale. */
export function ContentPanel({ copy, doc, pageId, locale, onPatch }: ContentPanelProps) {
  // Derived from the pages, memoised on the identity of `doc.pages` — a copy edit does not change
  // the inventory, so this recomputes only when the structure actually moves.
  const slots = useMemo(
    () => deriveSlotInventoryForPages(doc.pages).slots.filter((slot) => slot.pageId === pageId),
    [doc.pages, pageId],
  );

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      // Unmounting with a pending timer would drop the last thing the customer typed. Flushing on
      // unmount is not possible without the element's value, which is already gone by then — so the
      // timers are cleared and the panel is never unmounted while a field has focus: the page and
      // locale pickers are the only things that swap it, and both blur first.
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const schedule = (slot: SlotDescriptor, value: string): void => {
    const existing = timers.current.get(slot.id);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    timers.current.set(
      slot.id,
      setTimeout(() => {
        timers.current.delete(slot.id);
        onPatch({ op: 'set_copy', locale, slotId: slot.id, text: value });
      }, DEBOUNCE_MS),
    );
  };

  if (slots.length === 0) {
    return <p>{copy.editor.noDraftDetail}</p>;
  }

  return (
    <section aria-labelledby="content-heading">
      <h3 id="content-heading" className="app-panel__heading">
        {copy.editor.tabContent}
      </h3>
      {slots.map((slot) => {
        const value = textFor(doc, locale, slot.id);
        const multiline = MULTILINE_KINDS.has(slot.kind);
        return (
          <Field
            // Keyed by slot AND locale so switching language remounts the field with the other
            // language's text. An uncontrolled input keeps its DOM value across a re-render, which
            // would otherwise show the previous locale's copy under the new label.
            key={`${locale}:${slot.id}`}
            id={`slot-${slot.id}`}
            label={slotLabel(slot)}
            hint={`${slot.kind} · max ${String(slot.maxLength)}`}
          >
            {(control) =>
              multiline ? (
                <TextArea
                  {...control}
                  defaultValue={value}
                  maxLength={slot.maxLength}
                  onChange={(event) => {
                    schedule(slot, event.currentTarget.value);
                  }}
                />
              ) : (
                <TextInput
                  {...control}
                  defaultValue={value}
                  maxLength={slot.maxLength}
                  onChange={(event) => {
                    schedule(slot, event.currentTarget.value);
                  }}
                />
              )
            }
          </Field>
        );
      })}
    </section>
  );
}
