import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { UNDO_RING_SIZE } from '../do/SiteDraftDO';
import type { SiteDraftDO } from '../do/SiteDraftDO';
import { siteDocFixture } from './fixtures';

/**
 * `SiteDraftDO` — the two properties architecture §9 made non-negotiable.
 *
 * PROPERTY 1: EVERY PATCH IS WRITTEN TO STORAGE, NOT HELD IN MEMORY. A Durable Object hibernates
 * when idle and is evicted when the colo wants the memory; an editor that kept the draft in a field
 * would lose an afternoon's work to a lunch break, in the one product whose promise is "what you see
 * is your site".
 *
 * There is no `evictDurableObject()` in the test pool, so this file proves the property in the two
 * ways that do not need one, and together they are stronger than an eviction would be:
 *
 *   (a) after `applyEdit` returns, the patched document is IN `ctx.storage.sql` — read directly,
 *       bypassing every method on the class;
 *   (b) a document written into `ctx.storage.sql` from outside is what the next method call
 *       returns. That is the decisive one: if the object held ANY in-memory copy, the external
 *       write would be invisible and the call would return the stale value. Passing it means the
 *       only place the draft lives is storage, which is exactly what surviving an eviction means.
 *
 * PROPERTY 2: THE UNDO RING IS IN STORAGE AND IS BOUNDED. Fifty entries, trimmed from the old end,
 * so a session that runs all afternoon does not grow the object without limit — and the fifty most
 * recent edits are always the undoable ones.
 */

const NOW = Date.parse('2026-09-06T09:00:00.000Z');
const SITE_ID = 'ste_01J8Z9QWERTYUIOPASDFGHJKLZ';
const ORG_ID = 'org_01J8Z9QWERTYUIOPASDFGHJKLZ';
const VERSION_ID = 'ver_01J8Z9QWERTYUIOPASDFGHJKLZ';
const HEADLINE = 's_hero.headline';

/** A fresh object per case: a draft is per site, and a shared one would leak state across tests. */
function draft(name: string) {
  return env.SITE_DRAFT.get(env.SITE_DRAFT.idFromName(name));
}

/** Seeds an object with the fixture document. */
async function seed(name: string) {
  const stub = draft(name);
  await stub.initialise({
    siteId: SITE_ID,
    orgId: ORG_ID,
    shardId: 0,
    baseVersionId: VERSION_ID,
    doc: siteDocFixture(),
    now: NOW,
  });
  return stub;
}

/** Reads the stored document straight out of SQLite, bypassing every method on the class. */
async function docFromStorage(stub: DurableObjectStub<SiteDraftDO>): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ doc: string }>(`SELECT doc FROM draft WHERE id = 1`)
      .toArray();
    const row = rows[0];
    return row === undefined ? null : (JSON.parse(row.doc) as unknown);
  });
}

describe('every patch is written to storage', () => {
  it('has the patched text in SQLite the moment `applyEdit` returns', async () => {
    const stub = await seed('durability-1');

    const result = await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'Nieuwe kop' },
      expectedRev: null,
      now: NOW + 1,
    });
    expect(result.ok).toBe(true);

    // Read from storage, not from the object. No method of `SiteDraftDO` is involved.
    const stored = (await docFromStorage(stub)) as { copy: { nl: Record<string, string> } };
    expect(stored.copy.nl[HEADLINE]).toBe('Nieuwe kop');
  });

  it('returns what storage holds, even when storage was changed behind its back', async () => {
    const stub = await seed('durability-2');
    await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'Eerste' },
      expectedRev: null,
      now: NOW + 1,
    });

    // THE EVICTION PROOF. An in-memory cache would still be holding "Eerste"; a class that reads
    // storage on every call cannot be.
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ doc: string }>(`SELECT doc FROM draft WHERE id = 1`)
        .toArray();
      const raw = rows[0]?.doc ?? '{}';
      const parsed = JSON.parse(raw) as { copy: { nl: Record<string, string> } };
      parsed.copy.nl[HEADLINE] = 'Van buitenaf';
      state.storage.sql.exec(`UPDATE draft SET doc = ? WHERE id = 1`, JSON.stringify(parsed));
    });

    const state = await stub.readState(VERSION_ID);
    expect(state?.doc.copy['nl']?.[HEADLINE]).toBe('Van buitenaf');
  });

  it('does not replace an existing draft when the editor is opened twice', async () => {
    const stub = await seed('durability-3');
    await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'Mijn werk' },
      expectedRev: null,
      now: NOW + 1,
    });

    // A second tab, or a reload. `initialise` is idempotent and must never be the thing that
    // discards an hour of edits.
    const again = await stub.initialise({
      siteId: SITE_ID,
      orgId: ORG_ID,
      shardId: 0,
      baseVersionId: VERSION_ID,
      doc: siteDocFixture(),
      now: NOW + 2,
    });

    expect(again.doc.copy['nl']?.[HEADLINE]).toBe('Mijn werk');
  });

  it('refuses a patch computed against a revision that has moved', async () => {
    const stub = await seed('durability-4');
    const first = await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'A' },
      expectedRev: null,
      now: NOW + 1,
    });
    expect(first.ok).toBe(true);

    // A second tab still believes the revision is what it was before the first tab's edit.
    const stale = await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'B' },
      expectedRev: 1,
      now: NOW + 2,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('stale_rev');
    }

    const stored = (await docFromStorage(stub)) as { copy: { nl: Record<string, string> } };
    expect(stored.copy.nl[HEADLINE]).toBe('A');
  });

  it('refuses a slot that is not in the derived inventory', async () => {
    const stub = await seed('durability-5');
    const result = await stub.applyEdit({
      // Slot ids come from `deriveSlotInventory` and only from there. A hand-built one is refused,
      // which is what makes the whole slot indirection a real check.
      patch: { op: 'set_copy', locale: 'nl', slotId: 'made.up.slot', text: 'x' },
      expectedRev: null,
      now: NOW + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_slot');
    }
  });
});

describe('the undo ring', () => {
  it('undoes the last edit and redoes it', async () => {
    const stub = await seed('undo-1');
    await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'Gewijzigd' },
      expectedRev: null,
      now: NOW + 1,
    });

    const undone = await stub.undo(NOW + 2);
    expect(undone.ok).toBe(true);
    if (undone.ok) {
      // Undo carries the resulting document, because the inverse patch lives only in this object.
      expect(undone.doc?.copy['nl']?.[HEADLINE]).toBe('Welkom bij Kapsalon Anna');
      expect(undone.canRedo).toBe(true);
    }

    const redone = await stub.redo(NOW + 3);
    expect(redone.ok).toBe(true);
    if (redone.ok) {
      expect(redone.doc?.copy['nl']?.[HEADLINE]).toBe('Gewijzigd');
    }
  });

  it('drops the redo branch when a new edit is made after an undo', async () => {
    const stub = await seed('undo-2');
    await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'Eerste' },
      expectedRev: null,
      now: NOW + 1,
    });
    await stub.undo(NOW + 2);
    await stub.applyEdit({
      patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: 'Tweede' },
      expectedRev: null,
      now: NOW + 3,
    });

    // "Eerste" is gone from the future: a new edit destroys the redo branch, which is what every
    // editor does and what a user expects.
    const redone = await stub.redo(NOW + 4);
    expect(redone.ok).toBe(false);
    if (!redone.ok) {
      expect(redone.reason).toBe('nothing_to_do');
    }
  });

  it('remembers exactly the last UNDO_RING_SIZE edits and no more', async () => {
    const stub = await seed('undo-3');
    const total = UNDO_RING_SIZE + 3;
    for (let index = 0; index < total; index += 1) {
      const applied = await stub.applyEdit({
        patch: { op: 'set_copy', locale: 'nl', slotId: HEADLINE, text: `Kop ${String(index)}` },
        expectedRev: null,
        now: NOW + index + 1,
      });
      expect(applied.ok).toBe(true);
    }

    // The ring is trimmed from the OLD end, so storage is bounded however long a session runs.
    const historyRows = await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM history`)
        .toArray();
      return rows[0]?.n ?? 0;
    });
    expect(historyRows).toBe(UNDO_RING_SIZE);

    let succeeded = 0;
    for (let index = 0; index < total; index += 1) {
      const result = await stub.undo(NOW + total + index + 1);
      if (result.ok) {
        succeeded += 1;
      } else {
        expect(result.reason).toBe('nothing_to_do');
        break;
      }
    }
    // Exactly fifty: the three oldest edits are on the document and are no longer reversible, which
    // is the documented cost of a bounded ring rather than a bug.
    expect(succeeded).toBe(UNDO_RING_SIZE);
  });

  it('keeps the history in storage, not in the instance', async () => {
    const stub = await seed('undo-4');
    await stub.applyEdit({
      patch: { op: 'set_whatsapp_enabled', value: true },
      expectedRev: null,
      now: NOW + 1,
    });

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ inverse: string }>(`SELECT inverse FROM history ORDER BY seq DESC LIMIT 1`)
        .toArray()
        .map((row) => row.inverse),
    );

    // The INVERSE is what makes undo possible after an eviction, so it is what has to be on disk.
    expect(stored[0]).toBeDefined();
    expect(JSON.parse(stored[0] ?? '{}')).toEqual({ op: 'set_whatsapp_enabled', value: false });
  });
});

describe('the preview handshake', () => {
  it('spends a grant exactly once', async () => {
    const stub = await seed('grant-1');
    const grant = await stub.mintPreviewGrant({
      userId: 'usr_01AAAAAAAAAAAAAAAAAAAAAAAA',
      now: NOW,
    });

    const first = await stub.redeemPreviewGrant(grant.token, NOW + 1);
    expect(first).toBe('usr_01AAAAAAAAAAAAAAAAAAAAAAAA');

    // A refresh of the `/_authorise` URL. Single use is enforced by `used_at IS NULL` plus the
    // asserted write count — a read-then-write would let two concurrent redemptions both succeed.
    const second = await stub.redeemPreviewGrant(grant.token, NOW + 2);
    expect(second).toBeNull();
  });

  it('refuses a grant after it expires', async () => {
    const stub = await seed('grant-2');
    const grant = await stub.mintPreviewGrant({
      userId: 'usr_01AAAAAAAAAAAAAAAAAAAAAAAA',
      now: NOW,
    });

    expect(await stub.redeemPreviewGrant(grant.token, grant.expiresAt + 1)).toBeNull();
  });

  it('refuses anything that is not a token', async () => {
    const stub = await seed('grant-3');
    expect(await stub.redeemPreviewGrant('not-base64url!!', NOW)).toBeNull();
    expect(await stub.redeemPreviewGrant('', NOW)).toBeNull();
  });
});
