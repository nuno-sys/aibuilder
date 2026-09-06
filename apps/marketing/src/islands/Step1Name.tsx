/**
 * Step 1 — the business name, and nothing else.
 *
 * ONE FIELD, BECAUSE THE FIRST KEYSTROKE IS THE CONVERSION EVENT. Everything about this step is
 * arranged to get a character typed as fast as possible: one XL input, `Enter` advances, the
 * optional Google link sits *below* a hairline divider so it is offered without competing, and the
 * slug preview appears under the field as a reward rather than as another decision.
 *
 * THE KEYBOARD IS NOT OPENED ON TOUCH. The field takes focus so the caret is where it should be,
 * but the input is `readOnly` until the first tap, which suppresses the software keyboard. An
 * unrequested keyboard on step 1 covers two thirds of a phone screen — including the reassurance
 * copy — before the user has decided to engage, and it is the single most common mobile-modal
 * mistake. The first tap releases it, and the keyboard opens on the same gesture.
 *
 * THE SLUG CHECK IS A POSITIVE SIGNAL ONLY. It runs live (400 ms after typing stops) because a tick
 * appearing mid-typing is encouragement; it never blocks Continue and it never shows a red state
 * while the user is still typing. A taken slug is reported with the server's suggestion, which is
 * `kapsalon-jansen-amsterdam` rather than `kapsalon-jansen-2` — one reads like a business.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { checkSlug } from '../lib/api';
import { SITES_ROOT_DOMAIN } from '../lib/config';
import { copyFor } from '../lib/copy';
import { interpolate, slugPreview, tenantHost } from '../lib/format';
import type { Draft, DraftValues } from '../lib/types';
import {
  slugFailure,
  validateBusinessName,
  validateGbpUrl,
  validationMessage,
} from '../lib/validation';

import FieldMessage from './FieldMessage';
import fields from './fields.module.css';
import styles from './Step1Name.module.css';

/** Debounce before the availability check. Matches the local autosave, so they fire together. */
const SLUG_DEBOUNCE_MS = 400;

/** Shortest name worth checking; the slug rules require three characters anyway. */
const MIN_SLUG_LENGTH = 3;

export interface Step1NameProps {
  readonly draft: Draft;
  readonly locale: Locale;
  /** Message for `businessName`, or `null`. Owned by the modal so the summary and field agree. */
  readonly error: string | null;
  readonly setValues: (patch: Partial<DraftValues>) => void;
  /** Validates the field on blur and clears a shown error on input. */
  readonly onValidate: (field: string, message: string | null) => void;
  readonly onAnnounce: (message: string) => void;
  /** `Enter` in the field advances, exactly as the Continue button does. */
  readonly onAdvance: () => void;
  /** True once the entrance animation has finished; focus is not taken before then. */
  readonly focusReady: boolean;
}

/** The live availability state of the slug. */
type SlugState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly slug: string }
  | { readonly kind: 'available'; readonly slug: string }
  | { readonly kind: 'unavailable'; readonly slug: string; readonly message: string };

/**
 * Renders step 1.
 *
 * Guarantees the slug written into the draft is always the one the server said was available, and
 * that a failed availability check never blocks the step: the submit re-derives and re-validates
 * the slug server-side anyway.
 */
export default function Step1Name({
  draft,
  locale,
  error,
  setValues,
  onValidate,
  onAnnounce,
  onAdvance,
  focusReady,
}: Step1NameProps) {
  const copy = copyFor(locale);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const gbpId = useId();
  const [slugState, setSlugState] = useState<SlugState>({ kind: 'idle' });
  const [gbpError, setGbpError] = useState<string | null>(null);

  // Coarse pointers get a focused-but-readonly field; see the module header.
  const [suppressKeyboard, setSuppressKeyboard] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  );

  const name = draft.values.businessName ?? '';

  useEffect(() => {
    if (focusReady) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [focusReady]);

  useEffect(() => {
    const candidate = slugPreview(name, locale);
    if (candidate.length < MIN_SLUG_LENGTH) {
      setSlugState({ kind: 'idle' });
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSlugState({ kind: 'checking', slug: candidate });
      void (async () => {
        try {
          const result = await checkSlug(
            {
              slug: candidate,
              locale,
              city: draft.values.address.city ?? undefined,
              businessName: name,
              industryKey: draft.values.industryKey ?? undefined,
            },
            controller.signal,
          );
          if (result.available) {
            setSlugState({ kind: 'available', slug: result.normalized });
            setValues({ slug: result.normalized });
            onAnnounce(
              interpolate(copy.step1.slugAvailable, { host: tenantHost(result.normalized) }),
            );
            return;
          }
          const failure = slugFailure(result.reason ?? 'invalid', result.suggestion ?? null);
          setSlugState({
            kind: 'unavailable',
            slug: result.normalized,
            message: validationMessage(failure.code, locale, failure.params),
          });
          // The suggestion is stored, not merely displayed: it is a valid, free slug, and letting
          // the user reach submit with a slug we know is taken is a 409 at the worst moment.
          setValues({ slug: result.suggestion ?? null });
        } catch {
          // A failed check is silent. The slug is re-derived and re-validated server-side at
          // submit, and a red state here would punish the user for our outage.
          setSlugState({ kind: 'idle' });
        }
      })();
    }, SLUG_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // Every dependency below is either the typed name itself or a value that is stable for the
    // life of the step (the copy table is a module constant; the setters are `useCallback`s from
    // `useDraft`). The check therefore fires once per pause in typing, not once per render.
  }, [
    name,
    locale,
    draft.values.address.city,
    draft.values.industryKey,
    copy,
    setValues,
    onAnnounce,
  ]);

  const describedBy = ['businessName-hint', error === null ? null : 'businessName-err']
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div>
      <div className={fields.field}>
        <label className={fields.label} htmlFor="businessName">
          {copy.step1.label}
        </label>
        <p id="businessName-hint" className={fields.hint}>
          {copy.step1.helper}
        </p>
        <input
          ref={inputRef}
          id="businessName"
          name="businessName"
          type="text"
          className={`${fields.input} ${fields.inputLarge}`}
          value={name}
          placeholder={copy.step1.placeholder}
          autoComplete="organization"
          autoCapitalize="words"
          spellCheck={false}
          enterKeyHint="next"
          inputMode="text"
          maxLength={120}
          readOnly={suppressKeyboard}
          aria-describedby={describedBy}
          aria-invalid={error === null ? undefined : true}
          onPointerDown={() => {
            setSuppressKeyboard(false);
          }}
          onChange={(event) => {
            setValues({ businessName: event.target.value });
            if (error !== null) {
              // Once a field has errored it re-validates on input, so the message clears the
              // instant it is fixed rather than at the next blur.
              const failure = validateBusinessName(event.target.value);
              onValidate(
                'businessName',
                failure === null ? null : validationMessage(failure.code, locale),
              );
            }
          }}
          onBlur={(event) => {
            const failure = validateBusinessName(event.target.value);
            onValidate(
              'businessName',
              failure === null ? null : validationMessage(failure.code, locale),
            );
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onAdvance();
            }
          }}
        />

        {error !== null ? (
          <FieldMessage fieldId="businessName" tone="error">
            {error}
          </FieldMessage>
        ) : null}

        {slugState.kind !== 'idle' ? (
          <p className={styles.slug}>
            <span className={styles.slugLabel}>{copy.step1.slugLabel}</span>{' '}
            <span className={styles.slugValue}>
              <span className={styles.slugName}>{slugState.slug}</span>
              <span className={styles.slugDomain}>.{SITES_ROOT_DOMAIN}</span>
            </span>
            {slugState.kind === 'available' ? (
              <svg
                className={styles.tick}
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 8.5 6.5 12 13 4.5" />
              </svg>
            ) : null}
            {slugState.kind === 'checking' ? (
              <span className={styles.slugChecking}>{copy.step1.slugChecking}</span>
            ) : null}
          </p>
        ) : null}

        {slugState.kind === 'unavailable' ? (
          <FieldMessage fieldId="slug" tone="error">
            {slugState.message}
          </FieldMessage>
        ) : null}
      </div>

      <hr className={fields.divider} />

      <div className={fields.field}>
        <label className={fields.label} htmlFor={gbpId}>
          {copy.step5.gbp}
        </label>
        <p className={fields.hint}>{copy.step1.gbpTeaser}</p>
        <input
          id={gbpId}
          name="gbpUrl"
          type="url"
          className={fields.input}
          value={draft.values.gbpUrl ?? ''}
          placeholder="https://maps.app.goo.gl/…"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          enterKeyHint="go"
          aria-invalid={gbpError === null ? undefined : true}
          {...(gbpError === null ? {} : { 'aria-describedby': 'gbpUrl-err' })}
          onChange={(event) => {
            setValues({ gbpUrl: event.target.value.length === 0 ? null : event.target.value });
            if (gbpError !== null) {
              const failure = validateGbpUrl(event.target.value);
              setGbpError(failure === null ? null : validationMessage(failure.code, locale));
            }
          }}
          onBlur={(event) => {
            const failure = validateGbpUrl(event.target.value);
            setGbpError(failure === null ? null : validationMessage(failure.code, locale));
          }}
        />
        {gbpError !== null ? (
          <FieldMessage fieldId="gbpUrl" tone="error">
            {gbpError}
          </FieldMessage>
        ) : null}
      </div>
    </div>
  );
}
