/**
 * Step 5 — the phone number, and the WhatsApp button that is a headline feature.
 *
 * `libphonenumber-js/max` IS LAZY-IMPORTED ON FOCUS, AND THAT IS NOT AN OPTIMISATION. The `/max`
 * metadata build is roughly 145 KB — larger than every other dependency of this island put together.
 * Loading it eagerly would regress step 1's time-to-interactive and, because the marketing page
 * shares the chunk graph, its Lighthouse score with it. It is fetched when the phone field takes
 * focus: by then the user has completed four steps, the network is idle, and the download finishes
 * long before they stop typing.
 *
 * WHY `/max` AND NOT `/min`. `/min` cannot tell a MOBILE number from a FIXED_LINE. That distinction
 * is the whole WhatsApp warning: offering a WhatsApp button on a landline produces a link that
 * silently fails for every visitor who taps it, on the feature the product leads with.
 *
 * THE FIELD IS NEVER BLOCKED BY THE DOWNLOAD. Until the module lands, typing is unformatted and
 * validation falls back to the E.164 shape. A field that refuses input while a script downloads is
 * worse than a field that formats a moment late.
 *
 * COUNTRY IS A NATIVE `<select>`. A custom searchable listbox would be a second ARIA combobox
 * implementation, for a control used once, that would still be worse than the platform's own: the
 * native select has typeahead, a full-screen picker on mobile, and correct semantics everywhere.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '@aibuilder/core';
// `import type` is fully erased under `verbatimModuleSyntax`, so this does NOT pull the 145 KB
// metadata module into the bundle — only its types, at compile time.
import type { CountryCode } from 'libphonenumber-js/max';

import { copyFor } from '../lib/copy';
import type { Draft, DraftUiState, DraftValues } from '../lib/types';
import { isE164, validateGbpUrl, validatePhone, validationMessage } from '../lib/validation';

import FieldMessage from './FieldMessage';
import fields from './fields.module.css';
import styles from './Step5Contact.module.css';

/** The metadata module, typed against the real package. Resolved only when it has been imported. */
type PhoneModule = typeof import('libphonenumber-js/max');

/**
 * Countries offered in the dial-code select, with their calling codes.
 *
 * Written out rather than derived from the phone metadata so the control renders correctly before
 * the 145 KB module has landed — which is the entire point of loading it late.
 */
const PHONE_COUNTRIES: readonly { readonly code: string; readonly dial: string }[] = [
  { code: 'NL', dial: '+31' },
  { code: 'BE', dial: '+32' },
  { code: 'DE', dial: '+49' },
  { code: 'FR', dial: '+33' },
  { code: 'ES', dial: '+34' },
  { code: 'PT', dial: '+351' },
  { code: 'AT', dial: '+43' },
  { code: 'CH', dial: '+41' },
  { code: 'DK', dial: '+45' },
  { code: 'GB', dial: '+44' },
  { code: 'IE', dial: '+353' },
  { code: 'IT', dial: '+39' },
  { code: 'LU', dial: '+352' },
  { code: 'PL', dial: '+48' },
  { code: 'SE', dial: '+46' },
  { code: 'NO', dial: '+47' },
];

/**
 * One valid-looking example per country, for the "Voorbeeld: …" half of the invalid message.
 *
 * A static table rather than `getExampleNumber()`, which needs a second metadata file of its own.
 * Every entry is a real, valid national format — the message is useless if the example is not.
 */
const EXAMPLE_NUMBERS: Readonly<Record<string, string>> = {
  NL: '06 12 34 56 78',
  BE: '0470 12 34 56',
  DE: '0151 23456789',
  FR: '06 12 34 56 78',
  ES: '612 34 56 78',
  PT: '912 345 678',
  AT: '0664 123456',
  CH: '078 123 45 67',
  DK: '20 12 34 56',
  GB: '07400 123456',
  IE: '083 123 4567',
  IT: '312 345 6789',
  LU: '621 123 456',
  PL: '512 345 678',
  SE: '070-123 45 67',
  NO: '406 12 345',
};

export interface Step5ContactProps {
  readonly draft: Draft;
  readonly locale: Locale;
  readonly errors: ReadonlyMap<string, string>;
  readonly setValues: (patch: Partial<DraftValues>) => void;
  readonly setUi: (patch: Partial<DraftUiState>) => void;
  readonly onValidate: (field: string, message: string | null) => void;
  readonly onAdvance: () => void;
}

/**
 * Renders the phone pair, the WhatsApp choice and — only if it was not already captured — the
 * Google listing field.
 *
 * Guarantees `phoneE164` is written only in E.164, that `whatsappE164` follows the phone number
 * while the "same number" box is ticked, and that the landline warning is advisory rather than
 * blocking: the customer knows their own number better than the metadata does.
 */
export default function Step5Contact({
  draft,
  locale,
  errors,
  setValues,
  setUi,
  onValidate,
  onAdvance,
}: Step5ContactProps) {
  const copy = copyFor(locale);
  const phoneModule = useRef<PhoneModule | null>(null);
  const [parserReady, setParserReady] = useState(false);
  const [national, setNational] = useState('');
  const [landlineWarning, setLandlineWarning] = useState(false);
  const [gbpError, setGbpError] = useState<string | null>(null);

  const country = draft.ui.phoneCountry;
  const dial = useMemo(
    () => PHONE_COUNTRIES.find((entry) => entry.code === country)?.dial ?? '+31',
    [country],
  );

  const countryNames = useMemo(() => {
    let display: Intl.DisplayNames | null = null;
    try {
      display = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      display = null;
    }
    return PHONE_COUNTRIES.map((entry) => ({
      ...entry,
      label: `${display?.of(entry.code) ?? entry.code} (${entry.dial})`,
    }));
  }, [locale]);

  // Rehydrate the visible field once, from a stored E.164 number (a resumed draft, a back
  // navigation). Guarded by a ref rather than by "the field is empty": the latter would refill the
  // field the moment the user cleared it, which is unusable.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current && draft.values.phoneE164 !== null) {
      hydrated.current = true;
      setNational(draft.values.phoneE164);
    }
  }, [draft.values.phoneE164]);

  /** Downloads the metadata. Idempotent, and safe to call on every focus. */
  const loadParser = async (): Promise<PhoneModule | null> => {
    if (phoneModule.current !== null) {
      return phoneModule.current;
    }
    try {
      const module = await import('libphonenumber-js/max');
      phoneModule.current = module;
      setParserReady(true);
      return module;
    } catch {
      // A blocked or failed chunk leaves the field working, unformatted, validated by shape.
      return null;
    }
  };

  /** Formats as the user types, once the metadata is available. */
  const format = (raw: string): string => {
    const module = phoneModule.current;
    if (module === null) {
      return raw;
    }
    return new module.AsYouType(asCountryCode(raw, country, module)).input(raw);
  };

  /** Parses to E.164 and reports whether the number can carry WhatsApp. */
  const commitNumber = (raw: string): void => {
    const module = phoneModule.current;
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      setValues({ phoneE164: null, ...(draft.ui.whatsappSame ? { whatsappE164: null } : {}) });
      onValidate('phoneE164', validationMessage('phone.empty', locale));
      return;
    }

    if (module === null) {
      // No metadata: accept anything already in E.164, and defer the rest to the server's own
      // validation at submit rather than rejecting a number we cannot judge.
      const candidate = trimmed.replace(/[\s-]/g, '');
      const valid = isE164(candidate);
      setValues({
        phoneE164: valid ? candidate : null,
        ...(draft.ui.whatsappSame && valid ? { whatsappE164: candidate } : {}),
      });
      const failure = validatePhone({
        e164: candidate,
        valid: null,
        countryLabel: country,
        example: EXAMPLE_NUMBERS[country] ?? '',
      });
      onValidate(
        'phoneE164',
        failure === null ? null : validationMessage(failure.code, locale, failure.params),
      );
      return;
    }

    const parsed = module.parsePhoneNumberFromString(
      trimmed,
      asCountryCode(trimmed, country, module),
    );
    const e164 = parsed?.isValid() === true ? parsed.number : null;

    setValues({
      phoneE164: e164,
      ...(draft.ui.whatsappSame ? { whatsappE164: e164 } : {}),
    });

    const failure = validatePhone({
      e164: e164 ?? trimmed,
      valid: parsed?.isValid() ?? false,
      countryLabel: countryNames.find((entry) => entry.code === country)?.label ?? country,
      example: EXAMPLE_NUMBERS[country] ?? '',
    });
    onValidate(
      'phoneE164',
      failure === null ? null : validationMessage(failure.code, locale, failure.params),
    );

    // The one thing `/max` is here for: MOBILE vs FIXED_LINE.
    const type = parsed?.getType();
    setLandlineWarning(
      draft.ui.whatsappSame &&
        parsed?.isValid() === true &&
        type !== 'MOBILE' &&
        type !== undefined,
    );
  };

  const phoneError = errors.get('phoneE164') ?? null;

  return (
    <div>
      <div className={fields.field}>
        <label className={fields.label} htmlFor="phoneE164">
          {copy.step5.phone}
        </label>
        <p id="phoneE164-hint" className={fields.hint}>
          {copy.step5.helper}
        </p>

        <div className={styles.phoneRow}>
          <label className="sr-only" htmlFor="phoneCountry">
            {copy.step5.country}
          </label>
          <select
            id="phoneCountry"
            name="phoneCountry"
            className={`${fields.select} ${styles.country}`}
            value={country}
            autoComplete="tel-country-code"
            onChange={(event) => {
              setUi({ phoneCountry: event.target.value });
              commitNumber(national);
            }}
          >
            {countryNames.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </select>

          <input
            id="phoneE164"
            name="phone"
            type="tel"
            className={`${fields.input} ${styles.number}`}
            value={national}
            placeholder={EXAMPLE_NUMBERS[country] ?? dial}
            inputMode="tel"
            autoComplete="tel-national"
            enterKeyHint="next"
            aria-describedby={
              phoneError === null ? 'phoneE164-hint' : 'phoneE164-hint phoneE164-err'
            }
            aria-invalid={phoneError === null ? undefined : true}
            onFocus={() => {
              void loadParser();
            }}
            onChange={(event) => {
              setNational(parserReady ? format(event.target.value) : event.target.value);
            }}
            onBlur={(event) => {
              commitNumber(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitNumber(national);
                onAdvance();
              }
            }}
          />
        </div>

        {phoneError !== null ? (
          <FieldMessage fieldId="phoneE164" tone="error">
            {phoneError}
          </FieldMessage>
        ) : null}
      </div>

      <label className={fields.checkbox}>
        <input
          type="checkbox"
          className={fields.checkboxInput}
          checked={draft.ui.whatsappSame}
          onChange={(event) => {
            setUi({ whatsappSame: event.target.checked });
            setValues({ whatsappE164: event.target.checked ? draft.values.phoneE164 : null });
            if (!event.target.checked) {
              setLandlineWarning(false);
            }
          }}
        />
        <span>{copy.step5.whatsapp}</span>
      </label>

      {landlineWarning ? (
        <div className={styles.warning} role="status">
          <p className={styles.warningText}>
            {validationMessage('phone.whatsappLandline', locale)}
          </p>
          <div className={fields.row}>
            <button
              type="button"
              className={`${fields.button} ${fields.buttonSecondary}`}
              onClick={() => {
                // "Use another number" reveals the second field rather than clearing the first: the
                // landline is still the number customers should call.
                setUi({ whatsappSame: false });
                setValues({ whatsappE164: null });
                setLandlineWarning(false);
              }}
            >
              {copy.step5.whatsappChange}
            </button>
            <button
              type="button"
              className={`${fields.button} ${fields.buttonGhost}`}
              onClick={() => {
                setLandlineWarning(false);
              }}
            >
              {copy.step5.whatsappKeep}
            </button>
          </div>
        </div>
      ) : null}

      {!draft.ui.whatsappSame ? (
        <div className={fields.field}>
          <label className={fields.label} htmlFor="whatsappE164">
            {copy.step5.whatsappOther}
          </label>
          <input
            id="whatsappE164"
            name="whatsapp"
            type="tel"
            className={fields.input}
            value={draft.values.whatsappE164 ?? ''}
            inputMode="tel"
            autoComplete="tel"
            onChange={(event) => {
              const candidate = event.target.value.replace(/[\s-]/g, '');
              setValues({ whatsappE164: isE164(candidate) ? candidate : null });
            }}
          />
        </div>
      ) : null}

      {draft.values.gbpUrl === null ? (
        <>
          <hr className={fields.divider} />
          <div className={fields.field}>
            <label className={fields.label} htmlFor="gbpUrlLate">
              {copy.step5.gbp}
            </label>
            <p className={fields.hint}>{copy.step5.gbpHelper}</p>
            <input
              id="gbpUrlLate"
              name="gbpUrlLate"
              type="url"
              className={fields.input}
              defaultValue=""
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              aria-invalid={gbpError === null ? undefined : true}
              onBlur={(event) => {
                const failure = validateGbpUrl(event.target.value);
                setGbpError(failure === null ? null : validationMessage(failure.code, locale));
                if (failure === null && event.target.value.trim().length > 0) {
                  setValues({ gbpUrl: event.target.value.trim() });
                }
              }}
            />
            {gbpError !== null ? (
              <FieldMessage fieldId="gbpUrlLate" tone="error">
                {gbpError}
              </FieldMessage>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The country to parse against, or `undefined` when the number already carries its own.
 *
 * A number typed with a leading `+` is international and must NOT be reinterpreted in the selected
 * country's plan — doing so turns a correct `+3247…` into an invalid Dutch number the moment the
 * select says NL.
 */
function asCountryCode(raw: string, country: string, module: PhoneModule): CountryCode | undefined {
  if (raw.trim().startsWith('+')) {
    return undefined;
  }
  // `isSupportedCountry` is declared as a type predicate by the package, so this narrows a plain
  // string to `CountryCode` without a cast.
  return module.isSupportedCountry(country) ? country : undefined;
}
