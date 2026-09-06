/**
 * The draft: one object, two homes, and every failure mode of both handled.
 *
 * PERSISTENCE (UX §7.2, architecture §3b)
 *   local   400 ms trailing debounce  → `localStorage`, plus `visibilitychange → hidden`
 *   server  1200 ms trailing debounce → `PUT /v1/drafts/me`, plus an immediate flush on every step
 *           advance, plus a `keepalive` write on `pagehide`
 *
 * The two debounces are different numbers on purpose. 400 ms is below the threshold at which a
 * user who closes the laptop lid mid-sentence loses the sentence; 1200 ms is above the interval at
 * which a fast typist would generate a request per word. Local is cheap and must be eager; the
 * network is not and must not.
 *
 * WHY EVERY STORAGE ACCESS IS WRAPPED: see `lib/storage.ts`. The flow works with storage entirely
 * unavailable, because the durable copy is the server's.
 *
 * WHY THE DRAFT ID IS NOT MINTED HERE: `drf_…` is minted SERVER-side behind Turnstile. A
 * client-minted id would make every draft-keyed endpoint — `media/sign` above all — an open relay
 * for anyone who can guess a ULID (architecture §3b).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { ApiError, createDraft, flushDraftOnUnload, getDraft, putDraft } from '../../lib/api';
import type { DraftPatch, ServerDraft, ServerDraftValues } from '../../lib/api';
import { DRAFT_SCHEMA_VERSION, LOCAL_DRAFT_KEY } from '../../lib/config';
import { readJson, safeStorage, writeJson } from '../../lib/storage';
import type {
  Draft,
  DraftUiState,
  DraftValues,
  PersistedMedia,
  ServiceRadiusKm,
  StepIndex,
} from '../../lib/types';

/** Trailing debounce for the local write. */
const LOCAL_DEBOUNCE_MS = 400;

/** Trailing debounce for the server write. */
const SERVER_DEBOUNCE_MS = 1200;

/**
 * How far apart two copies must be before the user is asked which one to keep.
 *
 * Below this the newer one simply wins: a five-second gap is one tab that saved a moment later, and
 * asking about it would be a dialog in front of a keyboard for no decision.
 */
const CONFLICT_WINDOW_MS = 60_000;

/** An empty draft for a first-time visitor. */
export function emptyDraft(locale: Locale): Draft {
  return {
    v: DRAFT_SCHEMA_VERSION,
    draftId: null,
    locale,
    step: 1,
    furthestStep: 1,
    values: {
      businessName: null,
      slug: null,
      industryKey: null,
      defaultLocale: locale,
      extraLocales: [],
      serviceArea: null,
      address: {
        line1: null,
        line2: null,
        postalCode: null,
        city: null,
        country: null,
        latitude: null,
        longitude: null,
        geoSource: 'none',
      },
      openingHours: null,
      phoneE164: null,
      whatsappE164: null,
      gbpUrl: null,
      shortDescription: null,
      contactEmail: null,
      marketingOptIn: false,
      mediaIds: [],
    },
    ui: {
      locationMode: 'address',
      addressEntry: 'lookup',
      hoursPreset: null,
      hoursGridOpen: false,
      whatsappSame: true,
      descriptionSource: 'user',
      phoneCountry: 'NL',
    },
    media: [],
    updatedAt: 0,
  };
}

/** True when the draft holds anything worth resuming. Drives the resume card (UX §7.3). */
export function draftHasContent(draft: Draft): boolean {
  const { values } = draft;
  return (
    (values.businessName ?? '').length > 0 ||
    values.industryKey !== null ||
    values.phoneE164 !== null ||
    values.contactEmail !== null ||
    draft.media.length > 0
  );
}

/** Clamps an arbitrary number onto the six real steps. */
function toStep(value: number): StepIndex {
  const clamped = Math.min(6, Math.max(1, Math.round(value)));
  return clamped as StepIndex;
}

/** Narrows the draft route's numeric radius onto the four the UI offers. */
function toRadius(value: number): ServiceRadiusKm {
  if (value === 5 || value === 10 || value === 25 || value === 50) {
    return value;
  }
  // The column allows any integer; the UI does not. Rounding to the nearest offered value keeps a
  // draft written by a future editor readable instead of dropping the service area entirely.
  return value <= 7 ? 5 : value <= 17 ? 10 : value <= 37 ? 25 : 50;
}

/** Rebuilds the local draft from the server's copy, keeping UI-only state the server never saw. */
export function draftFromServer(server: ServerDraft, previous: Draft): Draft {
  const values: ServerDraftValues = server.values;
  const locale = (server.uiLocale as Locale | undefined) ?? previous.locale;
  return {
    v: DRAFT_SCHEMA_VERSION,
    draftId: server.draftId,
    locale,
    step: toStep(server.step),
    furthestStep: toStep(Math.max(server.furthestStep, server.step)),
    values: {
      businessName: values.businessName,
      slug: values.slug,
      industryKey: values.industryKey,
      defaultLocale: (values.defaultLocale as Locale | null) ?? locale,
      extraLocales: values.extraLocales.filter((code): code is Locale => code.length === 2),
      serviceArea:
        values.serviceArea === null
          ? null
          : { city: values.serviceArea.city, radiusKm: toRadius(values.serviceArea.radiusKm) },
      address: { ...values.address },
      openingHours: values.openingHours,
      phoneE164: values.phoneE164,
      whatsappE164: values.whatsappE164,
      gbpUrl: values.gbpUrl,
      shortDescription: values.shortDescription,
      contactEmail: values.contactEmail,
      marketingOptIn: values.marketingOptIn,
      mediaIds: [...values.mediaIds],
    },
    ui: {
      ...previous.ui,
      // Restoring "I travel to customers" from the stored shape rather than from a UI flag is what
      // SC 3.3.7 Redundant Entry actually asks for: the user must never re-answer this.
      locationMode: values.serviceArea !== null ? 'service_area' : previous.ui.locationMode,
      whatsappSame:
        values.whatsappE164 === null || values.whatsappE164 === values.phoneE164
          ? previous.ui.whatsappSame
          : false,
      phoneCountry: values.address.country ?? previous.ui.phoneCountry,
    },
    // Media tiles are re-hydrated from the ids the server knows about; the local copy carries the
    // dimensions and names, so a resumed grid looks identical before any thumbnail re-fetches.
    media: previous.media.filter(
      (item) => item.mediaId === null || values.mediaIds.includes(item.mediaId),
    ),
    updatedAt: server.updatedAt,
  };
}

/**
 * The exact `values` key set `PUT /v1/drafts/me` accepts.
 *
 * The route's schema is `.strict()`, so one extra key fails the entire autosave with a 422 that the
 * user experiences as "my answers stopped saving". Building the object explicitly — rather than
 * spreading `draft.values` — is what makes that impossible.
 */
function toServerValues(draft: Draft): Readonly<Record<string, unknown>> {
  const { values, ui } = draft;
  const serviceArea =
    ui.locationMode === 'service_area' && values.serviceArea !== null
      ? { city: values.serviceArea.city, radiusKm: values.serviceArea.radiusKm }
      : null;
  return {
    businessName: values.businessName,
    slug: values.slug,
    industryKey: values.industryKey,
    defaultLocale: values.defaultLocale,
    extraLocales: values.extraLocales,
    serviceArea,
    address: values.address,
    openingHours: values.openingHours,
    phoneE164: values.phoneE164,
    whatsappE164: values.whatsappE164,
    gbpUrl: values.gbpUrl,
    shortDescription: values.shortDescription,
    contactEmail: values.contactEmail,
    marketingOptIn: values.marketingOptIn,
    mediaIds: values.mediaIds,
  };
}

/** Builds the autosave request body for the current draft. */
function toPatch(draft: Draft): DraftPatch {
  return {
    step: draft.step,
    furthestStep: draft.furthestStep,
    updatedAt: draft.updatedAt,
    values: toServerValues(draft),
  };
}

/** Reads the stored draft, discarding one written by an incompatible version. */
function readLocalDraft(): Draft | null {
  const stored = readJson<Draft>(LOCAL_DRAFT_KEY);
  if (stored === null || stored.v !== DRAFT_SCHEMA_VERSION) {
    return null;
  }
  return stored;
}

/** What `useDraft` hands the modal. */
export interface UseDraftResult {
  readonly draft: Draft;
  /** True once `hydrate()` has settled, whether it found a server copy or not. */
  readonly ready: boolean;
  /** True while a server write is in flight. Drives nothing visible except the offline heuristic. */
  readonly saving: boolean;
  /** Two consecutive network failures. Pins the offline banner (UX §7.6). */
  readonly offline: boolean;
  /** Set when the server's copy is more than a minute newer than ours; the user chooses. */
  readonly conflict: ServerDraft | null;
  /** False when the draft lives only in memory (private mode, blocked storage). */
  readonly storagePersistent: boolean;
  /** Loads the server copy and resolves with the draft that resulted. */
  hydrate(): Promise<Draft>;
  setValues(patch: Partial<DraftValues>): void;
  setUi(patch: Partial<DraftUiState>): void;
  setMedia(update: (media: readonly PersistedMedia[]) => PersistedMedia[]): void;
  setStep(step: StepIndex): void;
  setLocale(locale: Locale): void;
  /** Creates the server-side draft if there is none. Returns its id. */
  ensureServerDraft(getToken: () => Promise<string>): Promise<string>;
  /** Writes both copies now, cancelling the pending debounces. */
  flush(): Promise<void>;
  resolveConflict(choice: 'local' | 'server'): void;
  /** Stops autosaving. Called after submit: the draft row is closed and further writes 404. */
  freeze(): void;
  /** Clears both copies and starts over. */
  reset(): void;
}

/**
 * Owns the draft and both of its persistence paths.
 *
 * Guarantees: the caller never has to think about debouncing, the local copy is written even when
 * the server is unreachable, the server copy is written even when the tab is closing, and a save
 * failure never blocks the wizard — steps advance locally and flush when connectivity returns.
 */
export function useDraft(initialLocale: Locale): UseDraftResult {
  const [draft, setDraft] = useState<Draft>(() => readLocalDraft() ?? emptyDraft(initialLocale));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [offline, setOffline] = useState(false);
  const [conflict, setConflict] = useState<ServerDraft | null>(null);

  /** Mirror of `draft` for the debounced writers, which fire long after the render that queued them. */
  const draftRef = useRef<Draft>(draft);
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const frozen = useRef(false);
  const failures = useRef(0);
  const hydrated = useRef(false);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const writeLocal = useCallback((): void => {
    writeJson(LOCAL_DRAFT_KEY, draftRef.current);
  }, []);

  const writeServer = useCallback(async (): Promise<void> => {
    const current = draftRef.current;
    if (frozen.current || current.draftId === null || !dirty.current) {
      return;
    }
    setSaving(true);
    try {
      const result = await putDraft(toPatch(current));
      dirty.current = false;
      failures.current = 0;
      setOffline(false);
      draftRef.current = { ...draftRef.current, updatedAt: result.updatedAt };
      setDraft((previous) => ({ ...previous, updatedAt: result.updatedAt }));
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        const server = error.extra['server'];
        if (typeof server === 'object' && server !== null) {
          setConflict(server as ServerDraft);
        }
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        // The cookie no longer owns a draft (expired, or cleared). The next Turnstile-gated moment
        // mints a new one; until then the local copy is the whole truth and stays dirty.
        draftRef.current = { ...draftRef.current, draftId: null };
        setDraft((previous) => ({ ...previous, draftId: null }));
        return;
      }
      failures.current += 1;
      if (failures.current >= 2) {
        setOffline(true);
      }
    } finally {
      setSaving(false);
    }
  }, []);

  const schedule = useCallback((): void => {
    dirty.current = true;
    if (localTimer.current !== null) {
      clearTimeout(localTimer.current);
    }
    localTimer.current = setTimeout(writeLocal, LOCAL_DEBOUNCE_MS);
    if (serverTimer.current !== null) {
      clearTimeout(serverTimer.current);
    }
    serverTimer.current = setTimeout(() => {
      void writeServer();
    }, SERVER_DEBOUNCE_MS);
  }, [writeLocal, writeServer]);

  /** Applies an update and starts both debounces. `updatedAt` moves so the server can order writes. */
  const update = useCallback(
    (mutate: (previous: Draft) => Draft): void => {
      setDraft((previous) => {
        const next = { ...mutate(previous), updatedAt: Date.now() };
        draftRef.current = next;
        return next;
      });
      schedule();
    },
    [schedule],
  );

  const setValues = useCallback(
    (patch: Partial<DraftValues>): void => {
      update((previous) => ({ ...previous, values: { ...previous.values, ...patch } }));
    },
    [update],
  );

  const setUi = useCallback(
    (patch: Partial<DraftUiState>): void => {
      update((previous) => ({ ...previous, ui: { ...previous.ui, ...patch } }));
    },
    [update],
  );

  const setMedia = useCallback(
    (mutate: (media: readonly PersistedMedia[]) => PersistedMedia[]): void => {
      update((previous) => {
        const media = mutate(previous.media);
        return {
          ...previous,
          media,
          values: {
            ...previous.values,
            // The intake carries ids only; the metadata is local. Order is meaningful — the first
            // id is the hero — so this is a map, never a set.
            mediaIds: media
              .filter((item) => item.mediaId !== null && item.status === 'ready')
              .map((item) => item.mediaId ?? ''),
          },
        };
      });
    },
    [update],
  );

  const setStep = useCallback(
    (step: StepIndex): void => {
      update((previous) => ({
        ...previous,
        step,
        furthestStep: Math.max(previous.furthestStep, step) as StepIndex,
      }));
    },
    [update],
  );

  const setLocale = useCallback(
    (locale: Locale): void => {
      update((previous) => ({
        ...previous,
        locale,
        values: { ...previous.values, defaultLocale: locale },
      }));
    },
    [update],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (localTimer.current !== null) {
      clearTimeout(localTimer.current);
      localTimer.current = null;
    }
    if (serverTimer.current !== null) {
      clearTimeout(serverTimer.current);
      serverTimer.current = null;
    }
    writeLocal();
    await writeServer();
  }, [writeLocal, writeServer]);

  const hydrate = useCallback(async (): Promise<Draft> => {
    if (hydrated.current) {
      return draftRef.current;
    }
    hydrated.current = true;
    try {
      const server = await getDraft();
      if (server !== null) {
        const local = draftRef.current;
        const serverIsNewer = server.updatedAt > local.updatedAt;
        const gap = Math.abs(server.updatedAt - local.updatedAt);
        if (serverIsNewer && gap > CONFLICT_WINDOW_MS && draftHasContent(local)) {
          setConflict(server);
        } else if (serverIsNewer || !draftHasContent(local)) {
          const merged = draftFromServer(server, local);
          draftRef.current = merged;
          setDraft(merged);
        } else {
          // Ours is newer: adopt the server's id so the next autosave lands on the right row, and
          // push our copy up.
          const adopted = { ...local, draftId: server.draftId };
          draftRef.current = adopted;
          setDraft(adopted);
          dirty.current = true;
          void writeServer();
        }
      }
    } catch {
      // No draft, no cookie, or no network. All three mean "carry on with what we have locally".
    } finally {
      setReady(true);
    }
    // Returned rather than read from state by the caller: the awaited continuation runs before
    // React has re-rendered, so `draft` in the caller's closure is still the pre-hydration one.
    return draftRef.current;
  }, [writeServer]);

  const ensureServerDraft = useCallback(
    async (getToken: () => Promise<string>): Promise<string> => {
      const existing = draftRef.current.draftId;
      if (existing !== null) {
        return existing;
      }
      const token = await getToken();
      const created = await createDraft({ turnstileToken: token, locale: draftRef.current.locale });
      draftRef.current = { ...draftRef.current, draftId: created.draftId };
      setDraft((previous) => ({ ...previous, draftId: created.draftId }));
      dirty.current = true;
      // The row is empty at this point; pushing immediately means a visitor who closes the tab
      // after one field still has that field on the server.
      void writeServer();
      return created.draftId;
    },
    [writeServer],
  );

  const resolveConflict = useCallback(
    (choice: 'local' | 'server'): void => {
      const server = conflict;
      setConflict(null);
      if (server === null) {
        return;
      }
      if (choice === 'server') {
        const merged = draftFromServer(server, draftRef.current);
        draftRef.current = merged;
        setDraft(merged);
        dirty.current = false;
        writeJson(LOCAL_DRAFT_KEY, merged);
      } else {
        // Keep ours, but adopt the server's clock so the next write is not rejected again.
        const forced = {
          ...draftRef.current,
          draftId: server.draftId,
          updatedAt: server.updatedAt,
        };
        draftRef.current = forced;
        setDraft(forced);
        dirty.current = true;
        void writeServer();
      }
    },
    [conflict, writeServer],
  );

  const freeze = useCallback((): void => {
    frozen.current = true;
    if (serverTimer.current !== null) {
      clearTimeout(serverTimer.current);
      serverTimer.current = null;
    }
  }, []);

  const reset = useCallback((): void => {
    safeStorage().remove(LOCAL_DRAFT_KEY);
    const fresh = emptyDraft(draftRef.current.locale);
    // The server row is deliberately NOT deleted: it is the same cookie's draft, it will be
    // overwritten by the next autosave, and a cron purges it after 30 days (GDPR minimisation).
    const kept = { ...fresh, draftId: draftRef.current.draftId };
    draftRef.current = kept;
    setDraft(kept);
    dirty.current = true;
  }, []);

  // Last-gasp saves. `pagehide` rather than `beforeunload`: `beforeunload` is not fired on iOS at
  // all, and registering it disqualifies the page from the back/forward cache on every platform.
  useEffect(() => {
    const onPageHide = (): void => {
      writeLocal();
      const current = draftRef.current;
      if (!frozen.current && dirty.current && current.draftId !== null) {
        flushDraftOnUnload(toPatch(current));
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        onPageHide();
      }
    };
    const onOnline = (): void => {
      setOffline(false);
      failures.current = 0;
      void writeServer();
    };
    const onOffline = (): void => {
      setOffline(true);
    };

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [writeLocal, writeServer]);

  // Timers must not outlive the island; a fired timer on an unmounted tree writes stale state.
  useEffect(
    () => () => {
      if (localTimer.current !== null) {
        clearTimeout(localTimer.current);
      }
      if (serverTimer.current !== null) {
        clearTimeout(serverTimer.current);
      }
    },
    [],
  );

  return {
    draft,
    ready,
    saving,
    offline,
    conflict,
    storagePersistent: safeStorage().persistent,
    hydrate,
    setValues,
    setUi,
    setMedia,
    setStep,
    setLocale,
    ensureServerDraft,
    flush,
    resolveConflict,
    freeze,
    reset,
  };
}
