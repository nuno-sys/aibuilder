/**
 * Step 2 — the industry combobox. ARIA 1.2, keyboard-complete, and entirely local.
 *
 * THE PATTERN (ARIA 1.2 "combobox with listbox popup"), implemented properly rather than
 * approximately, because the approximate version is what makes a screen reader silent:
 *
 *   - the INPUT owns `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`
 *     and `aria-activedescendant` — focus NEVER leaves the input, which is what keeps the typed
 *     text editable while the list is being navigated
 *   - the popup is a `role="listbox"` of `role="option"` elements, grouped by `role="group"` with
 *     `aria-labelledby` on each group's own heading
 *   - the active option is pointed at by `aria-activedescendant`, never by `document.activeElement`
 *   - `Escape` collapses the list; a second `Escape` clears the field (ARIA 1.2's two-stage escape)
 *   - `Home`/`End` jump within the list, `Alt+ArrowDown` opens it without moving the selection
 *
 * ZERO NETWORK PER KEYSTROKE. The taxonomy arrives once with `GET /v1/bootstrap` and is scored in
 * memory by `useIndustrySearch`. There is no debounce here because there is nothing to debounce.
 *
 * THE PREVIEW LINE UNDER THE FIELD is the second magic moment: it tells the user, before they have
 * seen anything, that the site they get is built for their trade and not from one template.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Locale } from '@aibuilder/core';

import type { BootstrapGroup, BootstrapIndustry } from '../lib/api';
import { copyFor } from '../lib/copy';
import { interpolate } from '../lib/format';
import type { Draft, DraftValues } from '../lib/types';
import { validateIndustry, validationMessage } from '../lib/validation';

import FieldMessage from './FieldMessage';
import { useIndustrySearch } from './hooks/useIndustrySearch';
import fields from './fields.module.css';
import styles from './Step2Industry.module.css';

/**
 * Which of the four Phase 1 design archetypes a group lands on.
 *
 * The mapping is the same one `@aibuilder/core`'s taxonomy encodes per leaf; it is restated here at
 * group granularity so the preview line costs one small object rather than the whole 104-row
 * taxonomy in the island's bundle. A group that is not listed falls back to `clean`, which is the
 * archetype that suits an unknown trade best.
 */
const GROUP_FLAVOUR: Readonly<Record<string, 'warm' | 'clean' | 'bold' | 'sturdy'>> = {
  food_drink: 'warm',
  beauty: 'bold',
  health: 'clean',
  sport: 'bold',
  trades: 'sturdy',
  automotive: 'sturdy',
  retail: 'warm',
  professional: 'clean',
  events: 'bold',
  education: 'clean',
  real_estate: 'clean',
  travel: 'warm',
  pets: 'warm',
  crafts: 'warm',
};

export interface Step2IndustryProps {
  readonly draft: Draft;
  readonly locale: Locale;
  readonly industries: readonly BootstrapIndustry[];
  readonly groups: readonly BootstrapGroup[];
  readonly country: string | null;
  readonly error: string | null;
  readonly setValues: (patch: Partial<DraftValues>) => void;
  readonly onValidate: (field: string, message: string | null) => void;
  readonly onAdvance: () => void;
}

/**
 * Renders the combobox, its grouped listbox and the design preview.
 *
 * Guarantees `industryKey` is only ever set from a real taxonomy row — free text never resolves —
 * and that exactly one option carries `aria-selected="true"` at any time.
 */
export default function Step2Industry({
  draft,
  locale,
  industries,
  groups,
  country,
  error,
  setValues,
  onValidate,
  onAdvance,
}: Step2IndustryProps) {
  const copy = copyFor(locale);
  const listboxId = 'industry-listbox';
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const selected = useMemo(
    () => industries.find((industry) => industry.key === draft.values.industryKey) ?? null,
    [industries, draft.values.industryKey],
  );

  const [query, setQuery] = useState(selected?.label ?? '');

  /**
   * The chosen key, readable from a deferred callback.
   *
   * The blur validation runs 120 ms after the field loses focus so a click on an option is not
   * cancelled by the list unmounting under the pointer — by which time the closure's `draft` is a
   * render behind, and reading the key from it would flag "pick an industry" on the industry the
   * user just picked.
   */
  const chosenKeyRef = useRef<string | null>(draft.values.industryKey);
  chosenKeyRef.current = draft.values.industryKey;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const { matches, grouped, popular } = useIndustrySearch({
    industries,
    groups,
    query,
    locale,
    country,
  });

  // The active option must stay visible while the arrow keys walk past the fold.
  useEffect(() => {
    if (!open || activeIndex < 0) {
      return;
    }
    const active = listRef.current?.querySelector(`#industry-option-${String(activeIndex)}`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const choose = (industry: BootstrapIndustry): void => {
    setValues({ industryKey: industry.key });
    setQuery(industry.label);
    setOpen(false);
    setActiveIndex(-1);
    onValidate('industryKey', null);
    inputRef.current?.focus({ preventScroll: true });
  };

  const clear = (): void => {
    setValues({ industryKey: null });
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        // `Alt+ArrowDown` opens the list without moving the selection — the ARIA 1.2 convention for
        // "show me the options" as distinct from "pick the next one".
        setActiveIndex(event.altKey ? -1 : 0);
        return;
      }
      setActiveIndex((previous) => (previous + 1) % Math.max(1, matches.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(matches.length - 1);
        return;
      }
      setActiveIndex((previous) => (previous <= 0 ? matches.length - 1 : previous - 1));
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(matches.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = activeIndex >= 0 ? matches[activeIndex] : undefined;
      if (open && active !== undefined) {
        choose(active.industry);
        return;
      }
      // No open list and a resolved industry: Enter behaves like Continue, as it does on every step.
      if (draft.values.industryKey !== null) {
        onAdvance();
        return;
      }
      const failure = validateIndustry(draft.values.industryKey, query);
      onValidate(
        'industryKey',
        failure === null ? null : validationMessage(failure.code, locale, failure.params),
      );
      return;
    }
    if (event.key === 'Escape') {
      // Two-stage escape: collapse first, clear second. A single-stage escape that wipes the field
      // is how people lose eight characters of typing by reflex.
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      } else if (query.length > 0) {
        event.preventDefault();
        clear();
      }
    }
  };

  const flatIndexOf = (industryKey: string): number =>
    matches.findIndex((match) => match.industry.key === industryKey);

  const previewFlavour = selected === null ? null : (GROUP_FLAVOUR[selected.groupKey] ?? 'clean');

  return (
    <div>
      <div className={fields.field}>
        <label className={fields.label} htmlFor="industryKey">
          {copy.step2.label}
        </label>
        <p id="industryKey-hint" className={fields.hint}>
          {copy.step2.helper}
        </p>

        <div className={styles.combobox}>
          <input
            ref={inputRef}
            id="industryKey"
            name="industryKey"
            type="text"
            className={fields.input}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-describedby={
              error === null ? 'industryKey-hint' : 'industryKey-hint industryKey-err'
            }
            aria-invalid={error === null ? undefined : true}
            {...(open && activeIndex >= 0
              ? { 'aria-activedescendant': `industry-option-${String(activeIndex)}` }
              : {})}
            value={query}
            placeholder={copy.step2.placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            inputMode="search"
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActiveIndex(event.target.value.trim().length > 0 ? 0 : -1);
              if (draft.values.industryKey !== null) {
                // Typing after a choice un-chooses it: the field must never show one industry while
                // the draft holds another.
                setValues({ industryKey: null });
              }
            }}
            onFocus={() => {
              if (query.trim().length > 0) {
                setOpen(true);
              }
            }}
            onBlur={() => {
              // The blur is deferred so a click on an option is not cancelled by the list unmounting
              // underneath the pointer.
              window.setTimeout(() => {
                setOpen(false);
                const failure = validateIndustry(chosenKeyRef.current, query);
                onValidate(
                  'industryKey',
                  failure === null ? null : validationMessage(failure.code, locale, failure.params),
                );
              }, 120);
            }}
            onKeyDown={onKeyDown}
          />

          {selected !== null ? (
            <button
              type="button"
              className={styles.clear}
              onClick={clear}
              aria-label={copy.step2.clear}
            >
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          ) : null}

          <ul
            ref={listRef}
            id={listboxId}
            className={`${styles.listbox} ${open && matches.length > 0 ? styles.listboxOpen : ''}`}
            role="listbox"
            aria-label={copy.step2.listLabel}
          >
            {grouped.map((group) => (
              <li
                key={group.group.key}
                role="group"
                aria-labelledby={`industry-group-${group.group.key}`}
                className={styles.group}
              >
                <p id={`industry-group-${group.group.key}`} className={styles.groupLabel}>
                  {group.group.label}
                </p>
                {/* `role="presentation"` so the options stay owned by the group: an
                    intervening `list` role breaks the listbox → group → option chain. */}
                <ul className={styles.groupList} role="presentation">
                  {group.matches.map((match) => {
                    const index = flatIndexOf(match.industry.key);
                    return (
                      <li
                        key={match.industry.key}
                        id={`industry-option-${String(index)}`}
                        role="option"
                        aria-selected={index === activeIndex}
                        className={`${styles.option} ${index === activeIndex ? styles.optionActive : ''}`}
                        // `onMouseDown` rather than `onClick`: the input's blur fires first
                        // otherwise, and the list is gone before the click lands.
                        onMouseDown={(event) => {
                          event.preventDefault();
                          choose(match.industry);
                        }}
                        onMouseEnter={() => {
                          setActiveIndex(index);
                        }}
                      >
                        <span className={styles.optionLabel}>{match.industry.label}</span>
                        <span className={styles.optionGroup}>{group.group.label}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>

        {/* The result count is announced politely by the input's own combobox semantics in most
            engines; this line is the visible equivalent for everyone else. */}
        {open && matches.length > 0 ? (
          <p className={styles.count}>
            {matches.length === 1
              ? copy.step2.resultsOne
              : interpolate(copy.step2.results, { count: matches.length })}
          </p>
        ) : null}

        {error !== null ? (
          <FieldMessage fieldId="industryKey" tone="error">
            {error}
          </FieldMessage>
        ) : null}

        {selected !== null && previewFlavour !== null ? (
          <p className={styles.preview}>
            {interpolate(copy.step2.preview[previewFlavour], {
              label: selected.label.toLocaleLowerCase(locale),
            })}
          </p>
        ) : null}
      </div>

      {query.trim().length === 0 && selected === null ? (
        <div className={styles.popular}>
          <p className={fields.label}>{copy.step2.popular}</p>
          <div className={fields.chips}>
            {popular.map((industry) => (
              <button
                key={industry.key}
                type="button"
                className={fields.chip}
                onClick={() => {
                  choose(industry);
                }}
              >
                {industry.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
