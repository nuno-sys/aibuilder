/**
 * The hand-off to Stripe Checkout — the product's conversion point.
 *
 * WHY THIS SCREEN EXISTS AT ALL, when `PHASE2-BILLING-AUTH` §8.5 says the modal may simply
 * `window.location.assign(checkoutUrl)` on the 202. It still does assign — from a button on this
 * screen. What it must not do is assign from inside the submit continuation, because the visitor
 * pressed a button that said "Bouw mijn website" and would land, with no intervening word, on a form
 * asking for a card number. That is the definition of a bait-and-switch, it is the single most
 * expensive moment in the funnel to get wrong, and no amount of correct billing behind it repairs
 * the sentence the customer says to themselves at that instant. The interstitial costs one click and
 * buys the one thing the redirect cannot: the customer knowing why.
 *
 * WHAT IT SHOWS, AND WHY EACH PART IS NOT OPTIONAL.
 *
 *  - **What has already been done for them.** The slug is reserved, the photos are uploaded, the
 *    answers are stored. Naming those first is what makes the card request feel like the last step
 *    of a thing in progress rather than a toll gate in front of one.
 *  - **Every number, together.** €0,00 today, €119,88 per year after seven days, €9,99 per month as
 *    the derived rate, VAT excluded and computed by Stripe. The Omnibus-amended UCPD treats a
 *    monthly headline over an annual charge as a misleading omission, so the annual total is stated
 *    at the same weight as the rate and on the same screen, never one tap further on.
 *  - **How to get out, before being asked to get in.** The cancellation terms are above the button,
 *    not below it and not on another page.
 *  - **Why the card is needed before the build.** From the customer's side that ordering is
 *    surprising, and an unexplained surprise reads as a trap.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No countdown timer, no "3 people are looking at this", no
 * pre-ticked upsell, no interstitial that argues when the secondary button is pressed. The
 * thirty-minute link expiry is stated as a property of the link, in the past tense of a fact, and
 * never as pressure. Everything on this screen is checkable against a bank statement.
 */

import type { Ref } from 'react';
import type { Locale } from '@aibuilder/core';

import { plan } from '../content/pricing';
import { copyFor } from '../lib/copy';
import { formatClockTime, formatEuro, interpolate } from '../lib/format';

import fields from './fields.module.css';
import styles from './Checkout.module.css';

/**
 * Why the customer is looking at this screen.
 *
 * `ready` is the first pass, straight off the submit. The other three are recoveries, and each one
 * has its own first paragraph because "you pressed Back", "the link timed out" and "our payment
 * service was unreachable" are three different things and only one of them is the customer's doing.
 */
export type CheckoutReason = 'ready' | 'cancelled' | 'expired' | 'unavailable';

export interface CheckoutHandoffProps {
  readonly locale: Locale;
  readonly businessName: string;
  readonly industryLabel: string | null;
  /** The reserved tenant host, or `null` when a cold return has not learned it yet. */
  readonly host: string | null;
  /** How many of the customer's own photos were promoted with the submit. */
  readonly photoCount: number;
  readonly reason: CheckoutReason;
  /** Epoch milliseconds at which the live Checkout Session expires, or `null`. */
  readonly deadlineAt: number | null;
  /** True while the continue action is working; the button is disabled and `aria-busy`. */
  readonly busy: boolean;
  /** Localised failure of the last attempt, or `null`. */
  readonly error: string | null;
  /**
   * True once the one retry this screen offers has been spent and failed.
   *
   * A third identical button against a service that has just refused twice is not a remedy, it is a
   * slot machine. What replaces it is the way back in: the page keeps working, the job is durable,
   * and returning later resumes it.
   */
  readonly exhausted: boolean;
  readonly onContinue: () => void;
  readonly onClose: () => void;
  /** Focus lands on the heading when the screen appears; the modal owns the timing. */
  readonly headingRef: Ref<HTMLHeadingElement>;
}

/** Renders the pre-Checkout summary and the button that performs the top-level navigation. */
export default function CheckoutHandoff({
  locale,
  businessName,
  industryLabel,
  host,
  photoCount,
  reason,
  deadlineAt,
  busy,
  error,
  exhausted,
  onContinue,
  onClose,
  headingRef,
}: CheckoutHandoffProps) {
  const copy = copyFor(locale);
  const today = formatEuro(0, locale);
  const annual = formatEuro(plan.annualTotalEur, locale);
  const monthly = formatEuro(plan.monthlyEur, locale);

  const notice =
    reason === 'cancelled'
      ? copy.checkout.cancelled
      : reason === 'expired'
        ? copy.checkout.expired
        : reason === 'unavailable'
          ? copy.checkout.unavailable
          : null;

  const photoLine =
    photoCount === 0
      ? copy.checkout.photosNone
      : photoCount === 1
        ? copy.checkout.photosOne
        : interpolate(copy.checkout.photos, { count: photoCount });

  // A deadline in the past is a link that has already expired; showing it would be worse than
  // showing nothing, because it reads as a promise the page has not noticed it broke.
  const showDeadline = deadlineAt !== null && deadlineAt > Date.now();

  return (
    <div className={styles.checkout}>
      <p className={styles.eyebrow}>{copy.checkout.eyebrow}</p>
      {/* `tabIndex={-1}`: the heading is a focus target, never a tab stop (UX §6.1). */}
      <h2 ref={headingRef} tabIndex={-1} className={styles.title}>
        {interpolate(copy.checkout.title, { name: businessName })}
      </h2>

      {notice !== null ? (
        <div className={styles.notice} role="status">
          <p className={styles.noticeTitle}>{notice.title}</p>
          <p className={styles.noticeBody}>{notice.body}</p>
        </div>
      ) : null}

      <p className={styles.intro}>{copy.checkout.intro}</p>

      <div className={styles.summary}>
        <p className={styles.summaryLabel}>{copy.checkout.summaryLabel}</p>
        <ul className={styles.summaryList}>
          <li className={styles.summaryItem}>{businessName}</li>
          {industryLabel !== null ? <li className={styles.summaryItem}>{industryLabel}</li> : null}
          <li className={styles.summaryItem}>{photoLine}</li>
        </ul>
        {host !== null ? (
          <p className={styles.reserved}>
            <span className={styles.reservedLabel}>{copy.checkout.reservedLabel}</span>
            <span className={styles.reservedHost}>{host}</span>
          </p>
        ) : null}
      </div>

      {/* The two amounts, side by side and at the same weight. Neither is a footnote to the other. */}
      <dl className={styles.prices}>
        <div className={styles.priceRow}>
          <dt className={styles.priceLabel}>{copy.checkout.todayLabel}</dt>
          <dd className={styles.priceValue}>{today}</dd>
        </div>
        <div className={styles.priceRow}>
          <dt className={styles.priceLabel}>
            {interpolate(copy.checkout.afterLabel, { days: plan.trialDays })}
          </dt>
          <dd className={styles.priceValue}>
            {interpolate(copy.checkout.afterAmount, { annual })}
          </dd>
        </div>
      </dl>
      <p className={styles.priceNote}>{copy.checkout.todayNote}</p>
      <p className={styles.priceNote}>{interpolate(copy.checkout.afterNote, { monthly })}</p>

      <div className={styles.terms}>
        <p className={styles.termsLabel}>{copy.checkout.cancelLabel}</p>
        <p className={styles.termsBody}>
          {interpolate(copy.checkout.cancelNote, { days: plan.trialDays })}
        </p>
        <p className={styles.termsLabel}>{copy.checkout.cardLabel}</p>
        <p className={styles.termsBody}>{copy.checkout.cardNote}</p>
      </div>

      {error !== null ? <p className={styles.error}>{error}</p> : null}

      {exhausted ? <p className={styles.error}>{copy.checkout.retryFailed}</p> : null}

      {/* The way out never disappears. When the retry is spent the primary button goes and the
          secondary one stays, so the screen always has an action that works. */}
      <div className={styles.actions}>
        {exhausted ? null : (
          <button
            type="button"
            className={`${fields.button} ${fields.buttonPrimary} ${styles.primary}`}
            disabled={busy}
            aria-busy={busy}
            onClick={onContinue}
          >
            {busy ? copy.checkout.actionBusy : (notice?.action ?? copy.checkout.action)}
          </button>
        )}
        <button
          type="button"
          className={`${fields.button} ${fields.buttonGhost}`}
          onClick={onClose}
        >
          {copy.checkout.close}
        </button>
      </div>

      <p className={styles.fine}>{copy.checkout.stripeNote}</p>
      {showDeadline ? (
        <p className={styles.fine}>
          {interpolate(copy.checkout.expiresAt, {
            time: formatClockTime(deadlineAt, locale),
          })}
        </p>
      ) : null}
      <p className={styles.fine}>{copy.checkout.closeNote}</p>
    </div>
  );
}
