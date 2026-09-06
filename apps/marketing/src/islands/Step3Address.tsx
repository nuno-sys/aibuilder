/**
 * Step 3 — where customers find you.
 *
 * TWO FLOWS, CHOSEN BY COUNTRY. In the Netherlands and Belgium a postcode and a house number
 * identify a building exactly, so the field pair resolves to a complete verified address in one
 * request — about four seconds of typing instead of thirty. Everywhere else there is no such
 * shortcut in Phase 1 (address autocomplete outside NL/BE is explicitly out of scope, architecture
 * §9), so the honest UI is the manual one rather than a lookup that fails silently.
 *
 * NO LOOKUP EVER BLOCKS CONTINUE. Every failure — not found, provider down, timeout, offline — ends
 * in the same place: the manual fields, pre-filled with whatever the user already typed, and copy
 * that says the site will be no worse for it. A geocoder outage must never be able to stop a
 * conversion.
 *
 * THE SERVICE-AREA TOGGLE IS A REAL BRANCH, not a checkbox that hides a field. A plumber who works
 * from a van has no visitable address; publishing his home address is a privacy failure, and
 * `LocalBusiness` wants `areaServed` rather than `address`. The intake enforces exactly one of the
 * two, and the JSON-LD emitter branches on which.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { ApiError, resolveNlBeAddress } from '../lib/api';
import { copyFor } from '../lib/copy';
import { interpolate } from '../lib/format';
import type { Draft, DraftUiState, DraftValues, ServiceRadiusKm } from '../lib/types';
import { SERVICE_RADII } from '../lib/types';
import {
  normalisePostcode,
  usesPostcodeLookup,
  validateHouseNumber,
  validatePostcode,
  validationMessage,
} from '../lib/validation';

import FieldMessage from './FieldMessage';
import fields from './fields.module.css';
import styles from './Step3Address.module.css';

/**
 * The country list for the manual `<select>`: the EU/EEA, then the near neighbours.
 *
 * Names come from `Intl.DisplayNames` rather than from a hard-coded table, so a Portuguese visitor
 * reads `Alemanha` and a Dutch one reads `Duitsland` without six translations shipping in the
 * bundle. The ORDER is fixed and deliberate — the target market first, alphabetical within it once
 * the names are known.
 */
const COUNTRY_CODES: readonly string[] = [
  'NL',
  'BE',
  'DE',
  'FR',
  'ES',
  'PT',
  'AT',
  'BG',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'PL',
  'RO',
  'SE',
  'SI',
  'SK',
  'CH',
  'GB',
  'NO',
  'IS',
];

/** Countries whose names lead the list because they are the first market. */
const PINNED_COUNTRIES = 6;

/** Delay before a lookup shows any progress at all. Below 250 ms a spinner reads as a glitch. */
const SKELETON_DELAY_MS = 250;

export interface Step3AddressProps {
  readonly draft: Draft;
  readonly locale: Locale;
  readonly errors: ReadonlyMap<string, string>;
  readonly setValues: (patch: Partial<DraftValues>) => void;
  readonly setUi: (patch: Partial<DraftUiState>) => void;
  readonly onValidate: (field: string, message: string | null) => void;
}

/** State of the NL/BE postcode lookup. */
type LookupState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'looking' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Renders step 3.
 *
 * Guarantees the draft always holds either a usable address or a service area — never both, and
 * never neither once the step has been completed.
 */
export default function Step3Address({
  draft,
  locale,
  errors,
  setValues,
  setUi,
  onValidate,
}: Step3AddressProps) {
  const copy = copyFor(locale);
  const { address } = draft.values;
  const serviceMode = draft.ui.locationMode === 'service_area';

  const [postcode, setPostcode] = useState(address.postalCode ?? '');
  const [houseNumber, setHouseNumber] = useState('');
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
  const [showSkeleton, setShowSkeleton] = useState(false);

  const country = address.country ?? draft.ui.phoneCountry;
  const lookupCountry = usesPostcodeLookup(country) ? country : null;
  const manual = draft.ui.addressEntry === 'manual' || lookupCountry === null;
  const resolved = address.line1 !== null && address.city !== null;

  const countryNames = useMemo(() => {
    let display: Intl.DisplayNames | null = null;
    try {
      display = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      // A runtime without `DisplayNames` falls back to the raw ISO codes, which are still usable.
      display = null;
    }
    const named = COUNTRY_CODES.map((code) => ({
      code,
      label: display?.of(code) ?? code,
    }));
    const pinned = named.slice(0, PINNED_COUNTRIES);
    const rest = [...named.slice(PINNED_COUNTRIES)].sort((a, b) =>
      a.label.localeCompare(b.label, locale),
    );
    return [...pinned, ...rest];
  }, [locale]);

  useEffect(() => {
    if (lookup.kind !== 'looking') {
      setShowSkeleton(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setShowSkeleton(true);
    }, SKELETON_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [lookup.kind]);

  /** Runs the lookup once both halves are valid. Failure always lands in the manual fields. */
  const runLookup = async (nextPostcode: string, nextHouseNumber: string): Promise<void> => {
    if (lookupCountry === null) {
      return;
    }
    if (
      validatePostcode(nextPostcode, lookupCountry) !== null ||
      validateHouseNumber(nextHouseNumber) !== null
    ) {
      return;
    }
    setLookup({ kind: 'looking' });
    try {
      const result = await resolveNlBeAddress({
        country: lookupCountry,
        postalCode: nextPostcode,
        houseNumber: nextHouseNumber,
      });
      setValues({
        address: {
          line1: `${result.addressLine1} ${nextHouseNumber}`.trim(),
          line2: null,
          postalCode: result.postalCode,
          city: result.city,
          country: result.country,
          latitude: result.latitude,
          longitude: result.longitude,
          geoSource: 'geocoded',
        },
      });
      setLookup({ kind: 'idle' });
      onValidate('address.line1', null);
    } catch (error: unknown) {
      const code =
        error instanceof ApiError && error.status === 404
          ? 'address.notFound'
          : 'address.lookupDown';
      setLookup({ kind: 'failed', message: validationMessage(code, locale) });
      // The manual fields open with whatever is already known, so nothing typed is lost.
      setUi({ addressEntry: 'manual' });
      setValues({
        address: {
          ...address,
          postalCode: nextPostcode,
          country: lookupCountry,
          geoSource: 'none',
        },
      });
    }
  };

  const radiusIndex = Math.max(0, SERVICE_RADII.indexOf(draft.values.serviceArea?.radiusKm ?? 10));

  return (
    <div>
      {!serviceMode && lookupCountry !== null && !manual ? (
        <div className={fields.split}>
          <div className={fields.field}>
            <label className={fields.label} htmlFor="address.postalCode">
              {copy.step3.postcode}
            </label>
            <input
              id="address.postalCode"
              name="postalCode"
              type="text"
              className={`${fields.input} ${styles.postcode}`}
              value={postcode}
              autoComplete="postal-code"
              inputMode="text"
              enterKeyHint="next"
              maxLength={8}
              aria-invalid={errors.has('address.postalCode') ? true : undefined}
              {...(errors.has('address.postalCode')
                ? { 'aria-describedby': 'address.postalCode-err' }
                : {})}
              onChange={(event) => {
                setPostcode(event.target.value.toUpperCase());
              }}
              onBlur={(event) => {
                const normalised = normalisePostcode(event.target.value, lookupCountry);
                setPostcode(normalised);
                const failure = validatePostcode(normalised, lookupCountry);
                onValidate(
                  'address.postalCode',
                  failure === null ? null : validationMessage(failure.code, locale),
                );
                void runLookup(normalised, houseNumber);
              }}
            />
            {errors.get('address.postalCode') !== undefined ? (
              <FieldMessage fieldId="address.postalCode" tone="error">
                {errors.get('address.postalCode') ?? ''}
              </FieldMessage>
            ) : null}
          </div>

          <div className={fields.field}>
            <label className={fields.label} htmlFor="address.houseNumber">
              {copy.step3.houseNumber}
            </label>
            <input
              id="address.houseNumber"
              name="houseNumber"
              type="text"
              className={fields.input}
              value={houseNumber}
              autoComplete="address-line2"
              inputMode="numeric"
              enterKeyHint="go"
              maxLength={10}
              aria-invalid={errors.has('address.houseNumber') ? true : undefined}
              onChange={(event) => {
                setHouseNumber(event.target.value);
              }}
              onBlur={(event) => {
                const failure = validateHouseNumber(event.target.value);
                onValidate(
                  'address.houseNumber',
                  failure === null ? null : validationMessage(failure.code, locale),
                );
                void runLookup(normalisePostcode(postcode, lookupCountry), event.target.value);
              }}
            />
            {errors.get('address.houseNumber') !== undefined ? (
              <FieldMessage fieldId="address.houseNumber" tone="error">
                {errors.get('address.houseNumber') ?? ''}
              </FieldMessage>
            ) : null}
          </div>
        </div>
      ) : null}

      {!serviceMode && showSkeleton && lookup.kind === 'looking' ? (
        <p className={styles.looking} aria-live="polite">
          {copy.step3.looking}
        </p>
      ) : null}

      {!serviceMode && lookup.kind === 'failed' ? (
        <FieldMessage fieldId="address.line1" tone="error">
          {lookup.message}
        </FieldMessage>
      ) : null}

      {!serviceMode && resolved && !manual ? (
        <div className={styles.resolved}>
          <p className={styles.resolvedText}>
            {address.line1}
            <br />
            {address.postalCode} {address.city}
          </p>
          <button
            type="button"
            className={`${fields.button} ${fields.buttonGhost}`}
            onClick={() => {
              setUi({ addressEntry: 'manual' });
            }}
          >
            {copy.step3.change}
          </button>
        </div>
      ) : null}

      {!serviceMode && !manual ? (
        <button
          type="button"
          className={`${fields.button} ${fields.buttonGhost} ${styles.manualLink}`}
          onClick={() => {
            setUi({ addressEntry: 'manual' });
          }}
        >
          {copy.step3.manual}
        </button>
      ) : null}

      {!serviceMode && manual ? (
        <div className={styles.manual}>
          <div className={fields.field}>
            <label className={fields.label} htmlFor="address.line1">
              {copy.step3.line1}
            </label>
            <input
              id="address.line1"
              name="addressLine1"
              type="text"
              className={fields.input}
              value={address.line1 ?? ''}
              autoComplete="address-line1"
              maxLength={120}
              aria-invalid={errors.has('address.line1') ? true : undefined}
              onChange={(event) => {
                setValues({
                  address: { ...address, line1: event.target.value, geoSource: 'none' },
                });
              }}
            />
            {errors.get('address.line1') !== undefined ? (
              <FieldMessage fieldId="address.line1" tone="error">
                {errors.get('address.line1') ?? ''}
              </FieldMessage>
            ) : null}
          </div>

          <div className={fields.field}>
            <label className={fields.label} htmlFor="address.line2">
              {copy.step3.line2}
            </label>
            <input
              id="address.line2"
              name="addressLine2"
              type="text"
              className={fields.input}
              value={address.line2 ?? ''}
              autoComplete="address-line2"
              maxLength={120}
              onChange={(event) => {
                setValues({
                  address: {
                    ...address,
                    line2: event.target.value.length === 0 ? null : event.target.value,
                  },
                });
              }}
            />
          </div>

          <div className={fields.split}>
            <div className={fields.field}>
              <label className={fields.label} htmlFor="address.postalCodeManual">
                {copy.step3.postalCode}
              </label>
              <input
                id="address.postalCodeManual"
                name="postalCodeManual"
                type="text"
                className={fields.input}
                value={address.postalCode ?? ''}
                autoComplete="postal-code"
                maxLength={16}
                onChange={(event) => {
                  setValues({ address: { ...address, postalCode: event.target.value } });
                }}
              />
            </div>

            <div className={fields.field}>
              <label className={fields.label} htmlFor="address.city">
                {copy.step3.city}
              </label>
              <input
                id="address.city"
                name="city"
                type="text"
                className={fields.input}
                value={address.city ?? ''}
                autoComplete="address-level2"
                maxLength={80}
                aria-invalid={errors.has('address.city') ? true : undefined}
                onChange={(event) => {
                  setValues({ address: { ...address, city: event.target.value } });
                }}
              />
              {errors.get('address.city') !== undefined ? (
                <FieldMessage fieldId="address.city" tone="error">
                  {errors.get('address.city') ?? ''}
                </FieldMessage>
              ) : null}
            </div>
          </div>

          <div className={fields.field}>
            <label className={fields.label} htmlFor="address.country">
              {copy.step3.country}
            </label>
            <select
              id="address.country"
              name="country"
              className={fields.select}
              value={country}
              autoComplete="country"
              onChange={(event) => {
                setValues({ address: { ...address, country: event.target.value } });
                // 3.3.7 Redundant Entry: the phone step must not ask for the country again.
                setUi({ phoneCountry: event.target.value });
              }}
            >
              {countryNames.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <hr className={fields.divider} />

      <label className={fields.checkbox}>
        <input
          type="checkbox"
          className={fields.checkboxInput}
          checked={serviceMode}
          onChange={(event) => {
            const nextMode = event.target.checked ? 'service_area' : 'address';
            setUi({ locationMode: nextMode });
            setValues(
              event.target.checked
                ? {
                    serviceArea: {
                      city: draft.values.serviceArea?.city ?? address.city ?? '',
                      radiusKm: draft.values.serviceArea?.radiusKm ?? 10,
                    },
                  }
                : { serviceArea: null },
            );
          }}
        />
        <span>{copy.step3.serviceToggle}</span>
      </label>

      {serviceMode ? (
        <div className={styles.service}>
          <div className={fields.field}>
            <label className={fields.label} htmlFor="serviceArea.city">
              {copy.step3.serviceCity}
            </label>
            <input
              id="serviceArea.city"
              name="serviceAreaCity"
              type="text"
              className={fields.input}
              value={draft.values.serviceArea?.city ?? ''}
              autoComplete="address-level2"
              maxLength={80}
              aria-invalid={errors.has('serviceArea.city') ? true : undefined}
              onChange={(event) => {
                setValues({
                  serviceArea: {
                    city: event.target.value,
                    radiusKm: draft.values.serviceArea?.radiusKm ?? 10,
                  },
                });
              }}
            />
            {errors.get('serviceArea.city') !== undefined ? (
              <FieldMessage fieldId="serviceArea.city" tone="error">
                {errors.get('serviceArea.city') ?? ''}
              </FieldMessage>
            ) : null}
          </div>

          <div className={fields.field}>
            <label className={fields.label} htmlFor="serviceArea.radius">
              {copy.step3.serviceRadius}
            </label>
            {/* A native range input: the slider role, the keyboard model and the touch target all
                come for free, and the four allowed radii are addressed by index so the steps are
                the real options rather than an arbitrary kilometre scale. */}
            <input
              id="serviceArea.radius"
              name="serviceAreaRadius"
              type="range"
              className={styles.radius}
              min={0}
              max={SERVICE_RADII.length - 1}
              step={1}
              value={radiusIndex}
              aria-valuetext={interpolate(copy.step3.serviceRadiusValue, {
                km: SERVICE_RADII[radiusIndex] ?? 10,
              })}
              onChange={(event) => {
                const next = SERVICE_RADII[Number(event.target.value)] ?? (10 as ServiceRadiusKm);
                setValues({
                  serviceArea: {
                    city: draft.values.serviceArea?.city ?? '',
                    radiusKm: next,
                  },
                });
              }}
            />
            <p className={styles.radiusValue}>
              {interpolate(copy.step3.serviceRadiusValue, { km: SERVICE_RADII[radiusIndex] ?? 10 })}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
