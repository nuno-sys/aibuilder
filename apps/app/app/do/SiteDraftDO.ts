import { DurableObject } from 'cloudflare:workers';
import { parseSiteDoc } from '@aibuilder/site-schema';
import type { SiteDoc, ThemeDoc } from '@aibuilder/site-schema';

import { applyPatch, parsePatch } from './patch';
import { sha256Hex } from '../lib/bytes';
import type { PatchRejection } from './patch';
import type { Env } from '../env';

/**
 * `SiteDraftDO` — one object per site, holding that site's unsaved draft and its undo ring.
 *
 * THE ONE RULE THIS CLASS EXISTS TO ENFORCE: **every patch is written to storage before the call
 * returns, and this object holds no in-memory copy of the document at all.**
 *
 * That is not defensive coding, it is the product. A Durable Object hibernates when idle and is
 * evicted when the colo needs the memory; neither event is observable to the customer and neither
 * is rare. An editor that kept the draft in a field would lose an afternoon's work to a lunch break
 * — in the one product whose entire promise is "what you see is your site". So: `applyPatch` reads
 * the document out of SQLite, transforms it, and writes it back inside `transactionSync`, and the
 * class has no mutable document field for an eviction to take. The eviction test in
 * `app/__tests__/site-draft-do.test.ts` asserts this by reading the row straight out of
 * `ctx.storage.sql`, bypassing every method on this class.
 *
 * WHY SQLITE AND NOT THE KEY-VALUE STORAGE API. The undo ring is a range query ("everything after
 * the cursor"), the trim is a range delete, and the redo branch is a range truncate. All three are
 * one statement in SQL and a read-modify-write of a JSON array in KV — and a read-modify-write is
 * where the ring loses an entry under concurrency, which a Durable Object's single thread would
 * otherwise have made impossible.
 *
 * THE UNDO MODEL is a cursor over an append-only log, not a stack:
 *
 *   history: seq 1 … 5, cursor = 5        five edits, all applied
 *   undo  →  cursor = 4                    entry 5 is now redoable, and still on disk
 *   undo  →  cursor = 3
 *   edit  →  entries 4 and 5 deleted, entry 4 inserted, cursor = 4
 *
 * A new edit destroys the redo branch, which is what every editor does and what users expect. The
 * ring bound is applied after the insert: entries at or below `cursor - UNDO_RING_SIZE` are
 * deleted, so the log is O(1) in storage regardless of how long a session runs.
 *
 * `rev` is a separate monotonic counter that increments on every mutation INCLUDING undo and redo.
 * The editor sends it back with each patch so a second tab's stale write is refused rather than
 * silently applied over an edit it never saw.
 */

/** How many edits can be undone. Fifty is roughly an hour of copy editing. */
export const UNDO_RING_SIZE = 50;

/** How long a preview handshake token is valid. It is redeemed within a page load or not at all. */
export const PREVIEW_GRANT_TTL_MS = 60_000;

/** How long a redeemed preview session lasts before the editor must hand out a new grant. */
export const PREVIEW_SESSION_TTL_MS = 1_800_000;

/** Bytes of entropy in a preview handshake token. 256 bits, from the platform CSPRNG. */
const GRANT_TOKEN_BYTES = 32;

/* ── Wire shapes ─────────────────────────────────────────────────────────────────────────────── */

/** What a loader learns about a draft without paying for the whole document. */
export interface DraftSummary {
  readonly siteId: string;
  readonly baseVersionId: string;
  readonly rev: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly updatedAt: number;
  /** True when the site has been regenerated since this draft was seeded. */
  readonly stale: boolean;
}

/** A draft, in full. Returned once per editor page load and never on the patch path. */
export interface DraftState extends DraftSummary {
  readonly doc: SiteDoc;
}

/** The answer to a patch, an undo or a redo. Deliberately small: this is the hot path. */
export type MutationResult =
  | {
      readonly ok: true;
      readonly rev: number;
      readonly canUndo: boolean;
      readonly canRedo: boolean;
      /** Server-resolved tokens when the theme moved, `null` otherwise. */
      readonly tokens: ThemeDoc['tokens'] | null;
      /**
       * The whole document, on undo and redo only — `null` for an ordinary patch.
       *
       * A patch's effect is already known to the client, which computed it with the same
       * `applyPatch`. An UNDO's effect is not: the inverse lives in this object's history and
       * nowhere else, so the client would have to guess. Sending the document back on the two
       * operations a customer performs by hand, and never on the one they perform by typing, keeps
       * the hot path small without making the editor lie about what undo did.
       */
      readonly doc: SiteDoc | null;
    }
  | { readonly ok: false; readonly reason: MutationRejection; readonly rev: number };

/** Why a mutation was refused. */
export type MutationRejection =
  PatchRejection | 'no_draft' | 'malformed_patch' | 'stale_rev' | 'nothing_to_do';

/** A one-time preview handshake token and its deadline. */
export interface PreviewGrant {
  readonly token: string;
  readonly expiresAt: number;
}

/* ── Row shapes ──────────────────────────────────────────────────────────────────────────────── */

interface DraftRow {
  readonly [column: string]: SqlStorageValue;
  readonly site_id: string;
  readonly base_version_id: string;
  readonly doc: string;
  readonly rev: number;
  readonly cursor: number;
  readonly updated_at: number;
}

interface HistoryRow {
  readonly [column: string]: SqlStorageValue;
  readonly seq: number;
  readonly patch: string;
  readonly inverse: string;
}

/* ── The object ──────────────────────────────────────────────────────────────────────────────── */

export class SiteDraftDO extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The schema is the only thing established up front, and it is idempotent, so it runs on every
    // construction rather than being guarded by a version key. Nothing else is hydrated: there is
    // no in-memory state for a fresh instance to rebuild.
    void this.ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await Promise.resolve();
    });
  }

  /** Creates the tables. Idempotent. */
  private migrate(): void {
    const sql = this.ctx.storage.sql;
    // `CHECK (id = 1)` makes "one draft per object" a constraint rather than a convention: a second
    // insert fails loudly instead of producing two documents and a coin flip about which is read.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS draft (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        site_id         TEXT    NOT NULL,
        org_id          TEXT    NOT NULL,
        shard_id        INTEGER NOT NULL,
        base_version_id TEXT    NOT NULL,
        doc             TEXT    NOT NULL,
        rev             INTEGER NOT NULL,
        cursor          INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS history (
        seq        INTEGER PRIMARY KEY,
        patch      TEXT    NOT NULL,
        inverse    TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    // The preview handshake ledger. Single-use is enforced by `used_at IS NULL` in the UPDATE and
    // by asserting the write count — the same shape every single-use consume in this system has.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS preview_grants (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_grants_expiry ON preview_grants(expires_at)`);
  }

  /** Reads the single draft row, or `null`. Every method starts here; nothing is cached. */
  private row(): DraftRow | null {
    const rows = this.ctx.storage.sql
      .exec<DraftRow>(
        `SELECT site_id, base_version_id, doc, rev, cursor, updated_at FROM draft WHERE id = 1`,
      )
      .toArray();
    return rows[0] ?? null;
  }

  /** The highest history sequence on disk, or 0. */
  private maxSeq(): number {
    const rows = this.ctx.storage.sql
      .exec<{ readonly [k: string]: SqlStorageValue; readonly m: number | null }>(
        `SELECT max(seq) AS m FROM history`,
      )
      .toArray();
    return rows[0]?.m ?? 0;
  }

  private summaryFrom(row: DraftRow, currentVersionId: string | null): DraftSummary {
    return {
      siteId: row.site_id,
      baseVersionId: row.base_version_id,
      rev: row.rev,
      canUndo: row.cursor > 0,
      canRedo: this.maxSeq() > row.cursor,
      updatedAt: row.updated_at,
      stale: currentVersionId !== null && currentVersionId !== row.base_version_id,
    };
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────────────────────────────── */

  /**
   * The whole draft. One call per editor page load.
   *
   * `currentVersionId` is the version the control plane says is live right now; passing it in — as
   * opposed to this object reading D1 — keeps the Durable Object free of database bindings and
   * makes `stale` a pure comparison the caller can also make.
   *
   * NAMED `readState` AND NOT `state`, and `applyEdit` and not `apply`, for a runtime reason rather
   * than a stylistic one: a Durable Object RPC stub is a callable proxy, so a method whose name
   * collides with a member of `Function.prototype` (`apply`, `call`, `bind`) is reached through the
   * function's own property rather than through the proxy. The failure is silent and confusing, so
   * the names avoid the whole class of it.
   */
  public async readState(currentVersionId: string | null): Promise<DraftState | null> {
    await Promise.resolve();
    const row = this.row();
    if (row === null) {
      return null;
    }
    const parsed = parseSiteDoc(JSON.parse(row.doc));
    if (!parsed.ok) {
      // A stored document that no longer validates is a schema migration that has not run, not a
      // user error. Refusing to serve it is right: the editor's form model IS the `SiteDoc`, and
      // rendering half of one produces edits that cannot be saved.
      return null;
    }
    return { ...this.summaryFrom(row, currentVersionId), doc: parsed.doc };
  }

  /**
   * Seeds the draft from a published document, or leaves an existing draft alone.
   *
   * IDEMPOTENT, AND THAT IS THE POINT: two tabs opening the editor at once must not race to
   * overwrite each other's starting point, and a reload must never be the thing that discards an
   * hour of edits. Replacing an existing draft is `reseed()`, which is a deliberate act with a
   * confirmation in front of it.
   */
  public async initialise(args: {
    readonly siteId: string;
    readonly orgId: string;
    readonly shardId: number;
    readonly baseVersionId: string;
    readonly doc: SiteDoc;
    readonly now: number;
  }): Promise<DraftState> {
    await Promise.resolve();
    const existing = this.row();
    if (existing !== null) {
      const parsed = parseSiteDoc(JSON.parse(existing.doc));
      if (parsed.ok) {
        return { ...this.summaryFrom(existing, args.baseVersionId), doc: parsed.doc };
      }
      // The stored draft no longer validates — see `state()`. Re-seeding is the only way forward
      // and it loses nothing that could have been saved anyway.
    }

    const serialised = JSON.stringify(args.doc);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(`DELETE FROM history`);
      sql.exec(
        `INSERT INTO draft (id, site_id, org_id, shard_id, base_version_id, doc, rev, cursor,
                            created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, 1, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           site_id = excluded.site_id, org_id = excluded.org_id, shard_id = excluded.shard_id,
           base_version_id = excluded.base_version_id, doc = excluded.doc,
           rev = draft.rev + 1, cursor = 0, updated_at = excluded.updated_at`,
        args.siteId,
        args.orgId,
        args.shardId,
        args.baseVersionId,
        serialised,
        args.now,
        args.now,
      );
    });

    const row = this.row();
    if (row === null) {
      throw new Error('SiteDraftDO.initialise: the draft row did not persist');
    }
    return { ...this.summaryFrom(row, args.baseVersionId), doc: args.doc };
  }

  /**
   * Throws the draft away and starts again from a freshly published document.
   *
   * The escape hatch for the one case the editor cannot resolve on its own: the site was
   * regenerated while a draft existed, so the draft describes sections the new version does not
   * have. The UI puts a confirmation in front of this and says, in words, that unsaved edits are
   * discarded — because they are.
   */
  public async reseed(args: {
    readonly baseVersionId: string;
    readonly doc: SiteDoc;
    readonly now: number;
  }): Promise<DraftState> {
    await Promise.resolve();
    const existing = this.row();
    if (existing === null) {
      throw new Error('SiteDraftDO.reseed: no draft to replace');
    }
    const serialised = JSON.stringify(args.doc);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(`DELETE FROM history`);
      sql.exec(
        `UPDATE draft SET base_version_id = ?, doc = ?, rev = rev + 1, cursor = 0, updated_at = ?
         WHERE id = 1`,
        args.baseVersionId,
        serialised,
        args.now,
      );
    });
    const row = this.row();
    if (row === null) {
      throw new Error('SiteDraftDO.reseed: the draft row disappeared');
    }
    return { ...this.summaryFrom(row, args.baseVersionId), doc: args.doc };
  }

  /* ── Editing ───────────────────────────────────────────────────────────────────────────────── */

  /**
   * Applies one edit.
   *
   * ORDER, AND WHY IT IS THIS ORDER: parse the patch, read the document, transform it in memory,
   * and only then open the transaction that writes the document, the history entry and the cursor
   * together. Validation before the transaction means a rejected patch costs no write at all; one
   * transaction for the three writes means an undo entry can never exist for a document change that
   * did not land, nor a document change without the entry that undoes it.
   *
   * `expectedRev` is optimistic concurrency, not a formality. Two tabs on the same site are a
   * normal thing for a customer to do, and the second tab's patch is computed against a document
   * the first tab has already changed. Refusing it with `stale_rev` lets the editor reload rather
   * than write an edit that means something different from what the user saw.
   */
  public async applyEdit(input: {
    readonly patch: unknown;
    readonly expectedRev: number | null;
    readonly now: number;
  }): Promise<MutationResult> {
    await Promise.resolve();
    const patch = parsePatch(input.patch);
    if (patch === null) {
      return { ok: false, reason: 'malformed_patch', rev: this.row()?.rev ?? 0 };
    }

    const row = this.row();
    if (row === null) {
      return { ok: false, reason: 'no_draft', rev: 0 };
    }
    if (input.expectedRev !== null && input.expectedRev !== row.rev) {
      return { ok: false, reason: 'stale_rev', rev: row.rev };
    }

    const parsed = parseSiteDoc(JSON.parse(row.doc));
    if (!parsed.ok) {
      return { ok: false, reason: 'no_draft', rev: row.rev };
    }

    const outcome = applyPatch(parsed.doc, patch);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, rev: row.rev };
    }

    const nextRev = row.rev + 1;
    const nextSeq = row.cursor + 1;
    const serialised = JSON.stringify(outcome.doc);

    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      // A new edit destroys the redo branch. Entries above the cursor describe a future that no
      // longer exists, and keeping them would let a redo apply a patch against a document it was
      // never computed from.
      sql.exec(`DELETE FROM history WHERE seq > ?`, row.cursor);
      sql.exec(
        `INSERT INTO history (seq, patch, inverse, created_at) VALUES (?, ?, ?, ?)`,
        nextSeq,
        JSON.stringify(patch),
        JSON.stringify(outcome.inverse),
        input.now,
      );
      // The ring. Bounded storage regardless of session length, and the bound is on the OLD end,
      // so the fifty most recent edits are always the undoable ones.
      sql.exec(`DELETE FROM history WHERE seq <= ?`, nextSeq - UNDO_RING_SIZE);
      sql.exec(
        `UPDATE draft SET doc = ?, rev = ?, cursor = ?, updated_at = ? WHERE id = 1`,
        serialised,
        nextRev,
        nextSeq,
        input.now,
      );
    });

    return {
      ok: true,
      rev: nextRev,
      canUndo: true,
      canRedo: false,
      tokens: patch.op === 'set_theme' ? outcome.doc.theme.tokens : null,
      doc: null,
    };
  }

  /** Undoes the most recent edit that has not already been undone. */
  public async undo(now: number): Promise<MutationResult> {
    return this.step('undo', now);
  }

  /** Re-applies the most recently undone edit. */
  public async redo(now: number): Promise<MutationResult> {
    return this.step('redo', now);
  }

  /**
   * The shared body of undo and redo.
   *
   * They differ in exactly two things — which history entry is read, and which of its two patches
   * is applied — so they are one function. Written twice, the second copy is where the cursor
   * arithmetic goes wrong.
   */
  private async step(direction: 'undo' | 'redo', now: number): Promise<MutationResult> {
    await Promise.resolve();
    const row = this.row();
    if (row === null) {
      return { ok: false, reason: 'no_draft', rev: 0 };
    }

    const seq = direction === 'undo' ? row.cursor : row.cursor + 1;
    if (direction === 'undo' && row.cursor === 0) {
      return { ok: false, reason: 'nothing_to_do', rev: row.rev };
    }
    const entries = this.ctx.storage.sql
      .exec<HistoryRow>(`SELECT seq, patch, inverse FROM history WHERE seq = ?`, seq)
      .toArray();
    const entry = entries[0];
    if (entry === undefined) {
      // For `undo` this means the ring has trimmed past this point: the edit is on the document
      // and is no longer reversible, which is the documented cost of a bounded ring.
      return { ok: false, reason: 'nothing_to_do', rev: row.rev };
    }

    const patch = parsePatch(JSON.parse(direction === 'undo' ? entry.inverse : entry.patch));
    if (patch === null) {
      return { ok: false, reason: 'malformed_patch', rev: row.rev };
    }
    const parsed = parseSiteDoc(JSON.parse(row.doc));
    if (!parsed.ok) {
      return { ok: false, reason: 'no_draft', rev: row.rev };
    }
    const outcome = applyPatch(parsed.doc, patch);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, rev: row.rev };
    }

    const nextCursor = direction === 'undo' ? row.cursor - 1 : row.cursor + 1;
    const nextRev = row.rev + 1;
    const serialised = JSON.stringify(outcome.doc);

    // The history row is NOT rewritten. Its `patch`/`inverse` pair stays exactly as recorded, so
    // stepping back and forth across the same entry is idempotent — which it would not be if undo
    // replaced the entry with the inverse it just computed.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE draft SET doc = ?, rev = ?, cursor = ?, updated_at = ? WHERE id = 1`,
        serialised,
        nextRev,
        nextCursor,
        now,
      );
    });

    return {
      ok: true,
      rev: nextRev,
      canUndo: nextCursor > 0,
      canRedo: this.maxSeq() > nextCursor,
      tokens: patch.op === 'set_theme' ? outcome.doc.theme.tokens : null,
      doc: outcome.doc,
    };
  }

  /* ── The preview handshake ─────────────────────────────────────────────────────────────────── */

  /**
   * Mints a one-time token the editor puts in the preview iframe's `src`.
   *
   * THIS IS THE ONLY SECRET THAT EVER APPEARS IN A PREVIEW URL, and it is spent by the redirect
   * that sets the cookie — the response that consumes it renders no content, so there is no page
   * whose `Referer` could carry it to `wa.me`. Sixty seconds, single use, and the redeemed session
   * lives in an `HttpOnly` host-scoped cookie from then on (architecture §9).
   *
   * Only the SHA-256 of the token is stored, so a dump of this object's storage cannot mint a
   * preview session — the same property the session and draft cookies have.
   */
  public async mintPreviewGrant(args: {
    readonly userId: string;
    readonly now: number;
  }): Promise<PreviewGrant> {
    const now = args.now;
    const bytes = crypto.getRandomValues(new Uint8Array(GRANT_TOKEN_BYTES));
    const token = base64url(bytes);
    const hash = await sha256Hex(bytes);
    const expiresAt = now + PREVIEW_GRANT_TTL_MS;

    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      // Opportunistic prune. Grants are 60 seconds long and are minted once per editor load, so
      // this keeps the table at a handful of rows without needing an alarm of its own.
      sql.exec(`DELETE FROM preview_grants WHERE expires_at < ?`, now);
      sql.exec(
        `INSERT INTO preview_grants (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
        hash,
        args.userId,
        expiresAt,
      );
    });

    return { token, expiresAt };
  }

  /**
   * Spends a preview grant and returns the user it was minted for, or `null`.
   *
   * `null` covers unknown, expired and already-spent alike: a grant is spent by the very redirect
   * that uses it, so "already spent" is what a refresh looks like, and telling the three apart
   * would be an oracle for nothing anybody needs.
   *
   * One `UPDATE … WHERE used_at IS NULL`, and the proof that it consumed the token is
   * `rowsWritten === 1`. A read-then-write would let two concurrent redemptions of the same token
   * both succeed, which is the double-spend every single-use consume in this system is written to
   * avoid. The `SELECT` that follows is safe because the object is single-threaded and this call
   * has already won the update exclusively.
   */
  public async redeemPreviewGrant(token: string, now: number): Promise<string | null> {
    const bytes = fromBase64url(token);
    if (bytes === null || bytes.byteLength !== GRANT_TOKEN_BYTES) {
      return null;
    }
    const hash = await sha256Hex(bytes);
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE preview_grants SET used_at = ?2
       WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`,
      hash,
      now,
    );
    if (cursor.rowsWritten !== 1) {
      return null;
    }
    const rows = this.ctx.storage.sql
      .exec<{ readonly [k: string]: SqlStorageValue; readonly user_id: string }>(
        `SELECT user_id FROM preview_grants WHERE token_hash = ?`,
        hash,
      )
      .toArray();
    return rows[0]?.user_id ?? null;
  }
}

/* ── Encoding helpers ────────────────────────────────────────────────────────────────────────── */

/** base64url of raw bytes, unpadded. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Raw bytes from base64url, or `null` when the input is not base64url at all. */
function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) {
    return null;
  }
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
