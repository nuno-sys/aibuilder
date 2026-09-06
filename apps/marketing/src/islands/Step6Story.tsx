/**
 * Step 6 — the story, the photos, and the e-mail address.
 *
 * THE E-MAIL IS THE LAST FIELD OF THE LAST STEP, AND IT IS FRAMED AS DELIVERY. "Waar sturen we de
 * link naartoe?" is not a signup gate; it is the answer to a question the user now wants answered,
 * asked at the moment of peak desire after five sunk investments. The same field at step 1, labelled
 * "Maak een account", converts at roughly half the rate.
 *
 * THE DESCRIPTION IS OPTIONAL AND SAYS SO. A blank textarea with a 600-character counter is the most
 * intimidating control in the flow; the helper text gives explicit permission to leave it empty,
 * because the generator writes perfectly good copy from the name, trade and city alone.
 *
 * THE TYPO CHECK NEVER CORRECTS ANYTHING. `gmial.com` is a typo and `gmail.co` might be a company's
 * real domain; only the user knows which, so the suggestion is offered with two buttons and no
 * default. Silently rewriting an e-mail address is how a customer never receives their site.
 *
 * PHOTOS NEVER BLOCK ANYTHING. Files still uploading when the button is pressed keep uploading; the
 * generation's media phase waits for them briefly and proceeds with its own imagery if they are not
 * there yet. The skip card is as prominent as the upload buttons, on purpose.
 */

import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { plan } from '../content/pricing';
import { copyFor } from '../lib/copy';
import { formatEuro, interpolate } from '../lib/format';
import type { Draft, DraftValues, MediaItem } from '../lib/types';
import {
  DESCRIPTION_MAX,
  suggestEmailCorrection,
  validateDescription,
  validateEmail,
  validationMessage,
} from '../lib/validation';

import FieldMessage from './FieldMessage';
import MediaDropzone from './MediaDropzone';
import MediaReorder from './MediaReorder';
import SkipMediaCard from './SkipMediaCard';
import fields from './fields.module.css';
import styles from './Step6Story.module.css';

/** The counter appears only once the user is close enough to the ceiling for it to be information. */
const COUNTER_VISIBLE_FROM = 480;

/** Turns amber here and red at the maximum. */
const COUNTER_WARNING_FROM = 560;

/** Tallest the textarea grows before it starts scrolling (8 rows at the body line-height). */
const MAX_TEXTAREA_PX = 8 * 24 + 24;

export interface Step6StoryProps {
  readonly draft: Draft;
  readonly locale: Locale;
  readonly errors: ReadonlyMap<string, string>;
  readonly media: readonly MediaItem[];
  readonly industryLabel: string | null;
  readonly setValues: (patch: Partial<DraftValues>) => void;
  readonly onValidate: (field: string, message: string | null) => void;
  readonly onAnnounce: (message: string) => void;
  readonly onAddFiles: (files: readonly File[]) => void;
  readonly onRemoveMedia: (clientId: string) => void;
  readonly onRetryMedia: (clientId: string) => void;
  readonly onMoveMedia: (clientId: string, toIndex: number) => void;
}

/**
 * Renders step 6.
 *
 * Guarantees the description is either empty or long enough to be useful, that the e-mail is stored
 * lower-cased and trimmed, and that consent is recorded as an explicit boolean rather than inferred
 * from a submit.
 */
export default function Step6Story({
  draft,
  locale,
  errors,
  media,
  industryLabel,
  setValues,
  onValidate,
  onAnnounce,
  onAddFiles,
  onRemoveMedia,
  onRetryMedia,
  onMoveMedia,
}: Step6StoryProps) {
  const copy = copyFor(locale);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [emailSuggestion, setEmailSuggestion] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);

  const description = draft.values.shortDescription ?? '';
  const email = draft.values.contactEmail ?? '';
  const descriptionError = errors.get('shortDescription') ?? null;
  const emailError = errors.get('contactEmail') ?? null;

  /** Grows the textarea to its content, up to eight rows. */
  const autoGrow = (): void => {
    const element = textareaRef.current;
    if (element === null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${String(Math.min(MAX_TEXTAREA_PX, element.scrollHeight))}px`;
  };

  useEffect(autoGrow, [description]);

  return (
    <div>
      <div className={fields.field}>
        <label className={fields.label} htmlFor="shortDescription">
          {copy.step6.label}
        </label>
        <p id="shortDescription-hint" className={fields.hint}>
          {copy.step6.helper}
        </p>
        <textarea
          ref={textareaRef}
          id="shortDescription"
          name="shortDescription"
          className={fields.textarea}
          value={description}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          placeholder={copy.step6.placeholder}
          spellCheck
          autoCapitalize="sentences"
          enterKeyHint="enter"
          aria-describedby={
            descriptionError === null
              ? 'shortDescription-hint'
              : 'shortDescription-hint shortDescription-err'
          }
          aria-invalid={descriptionError === null ? undefined : true}
          onChange={(event) => {
            setValues({
              shortDescription: event.target.value.length === 0 ? null : event.target.value,
            });
            if (descriptionError !== null) {
              const failure = validateDescription(event.target.value);
              onValidate(
                'shortDescription',
                failure === null ? null : validationMessage(failure.code, locale),
              );
            }
          }}
          onBlur={(event) => {
            const failure = validateDescription(event.target.value);
            onValidate(
              'shortDescription',
              failure === null ? null : validationMessage(failure.code, locale),
            );
          }}
        />

        {description.length >= COUNTER_VISIBLE_FROM ? (
          <p
            className={`${styles.counter} ${
              description.length >= COUNTER_WARNING_FROM ? styles.counterWarning : ''
            }`}
          >
            {interpolate(copy.step6.counter, {
              count: description.length,
              max: DESCRIPTION_MAX,
            })}
          </p>
        ) : null}

        {descriptionError !== null ? (
          <FieldMessage fieldId="shortDescription" tone="error">
            {descriptionError}
          </FieldMessage>
        ) : null}
      </div>

      <hr className={fields.divider} />

      <div className={fields.field}>
        <p className={fields.label}>{copy.step6.mediaLabel}</p>
        <p className={fields.hint}>{copy.step6.mediaHelper}</p>

        {/* Choosing to skip collapses the uploader rather than merely tinting a card: the promise
            is "you do not have to deal with photos", and leaving the dropzone on screen breaks it.
            The card then offers the way back. */}
        {!skipped ? (
          <MediaDropzone locale={locale} onFiles={onAddFiles} disabled={media.length >= 12} />
        ) : null}

        {media.length > 0 ? (
          <MediaReorder
            items={media}
            locale={locale}
            onMove={onMoveMedia}
            onRemove={onRemoveMedia}
            onRetry={onRetryMedia}
            onAnnounce={onAnnounce}
          />
        ) : null}

        <SkipMediaCard
          locale={locale}
          industryLabel={industryLabel}
          skipped={skipped}
          onSkip={() => {
            setSkipped(true);
          }}
          onUndo={() => {
            setSkipped(false);
          }}
        />
      </div>

      <hr className={fields.divider} />

      <div className={fields.field}>
        <label className={fields.label} htmlFor="contactEmail">
          {copy.step6.email}
        </label>
        <p id="contactEmail-hint" className={fields.hint}>
          {copy.step6.emailHelper}
        </p>
        <input
          id="contactEmail"
          name="contactEmail"
          type="email"
          className={fields.input}
          value={email}
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="done"
          maxLength={254}
          aria-describedby={
            emailError === null ? 'contactEmail-hint' : 'contactEmail-hint contactEmail-err'
          }
          aria-invalid={emailError === null ? undefined : true}
          onChange={(event) => {
            setValues({
              contactEmail: event.target.value.length === 0 ? null : event.target.value,
            });
            setEmailSuggestion(null);
            if (emailError !== null) {
              const failure = validateEmail(event.target.value);
              onValidate(
                'contactEmail',
                failure === null ? null : validationMessage(failure.code, locale),
              );
            }
          }}
          onBlur={(event) => {
            const normalised = event.target.value.trim().toLowerCase();
            if (normalised !== event.target.value) {
              setValues({ contactEmail: normalised.length === 0 ? null : normalised });
            }
            const failure = validateEmail(normalised);
            onValidate(
              'contactEmail',
              failure === null ? null : validationMessage(failure.code, locale),
            );
            setEmailSuggestion(failure === null ? suggestEmailCorrection(normalised) : null);
          }}
        />

        {emailError !== null ? (
          <FieldMessage fieldId="contactEmail" tone="error">
            {emailError}
          </FieldMessage>
        ) : null}

        {emailSuggestion !== null ? (
          <div className={styles.suggestion} role="status">
            <p className={styles.suggestionText}>
              {validationMessage('email.typo', locale, { suggestion: emailSuggestion })}
            </p>
            <div className={fields.row}>
              <button
                type="button"
                className={`${fields.button} ${fields.buttonSecondary}`}
                onClick={() => {
                  setValues({ contactEmail: emailSuggestion });
                  setEmailSuggestion(null);
                }}
              >
                {locale === 'nl' ? 'Ja' : 'Yes'}
              </button>
              <button
                type="button"
                className={`${fields.button} ${fields.buttonGhost}`}
                onClick={() => {
                  setEmailSuggestion(null);
                }}
              >
                {locale === 'nl' ? 'Nee, klopt zo' : "No, it's right"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <label className={fields.checkbox}>
        <input
          type="checkbox"
          className={fields.checkboxInput}
          checked={draft.values.marketingOptIn}
          onChange={(event) => {
            setValues({ marketingOptIn: event.target.checked });
          }}
        />
        <span>{copy.step6.consent}</span>
      </label>

      {/* The trust strip. Its middle claim used to be "no credit card"; the trial moved in front of
          the first generation (DECISIONS §D2) and it stopped being true, so the numbers are now
          interpolated from `content/pricing.ts` — the same module whose build guard asserts that the
          monthly rate multiplies out to the annual total. A trust strip cannot drift from the price. */}
      <ul className={styles.trust}>
        {copy.step6.trust.map((template) => (
          <li key={template} className={styles.trustItem}>
            <svg
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
            {interpolate(template, { days: plan.trialDays, today: formatEuro(0, locale) })}
          </li>
        ))}
      </ul>

      <p className={styles.legal}>{copy.step6.legal}</p>
    </div>
  );
}
