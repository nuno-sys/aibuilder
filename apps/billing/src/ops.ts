/**
 * Operator-facing signals.
 *
 * WHY THIS EXISTS AS A FUNCTION AND NOT AS A `console.error` CALL SITE. Three situations in this
 * Worker are correct code paths that a human must nevertheless look at within the day: an event
 * whose organisation cannot be resolved (a real customer is being billed for nothing), a Stripe
 * subscription status we do not model (the mirror silently clamps it), and a chargeback (a site is
 * suspended and someone has to decide whether that was right). Each of them answers 200 to Stripe,
 * so nothing else in the system will ever surface them. A single shaped log line is what a Logpush
 * filter and an alert can be built on; ad-hoc strings are not.
 *
 * WHAT MUST NEVER REACH IT. Architecture §8 makes log redaction mandatory. Ids, event types and
 * amounts are fine. A card fingerprint, an e-mail address, a customer name or a raw event payload
 * are not, and no field here is free-form enough to smuggle one in by accident.
 */

/** The alerts this Worker raises. Each one names a runbook entry. */
export type AlertKind =
  /** Neither `stripe_customers` nor `client_reference_id` resolved an organisation. */
  | 'org_unresolved'
  /** Stripe reported a subscription status the schema does not model; the mirror clamped it. */
  | 'unknown_subscription_status'
  /** A chargeback. The site is suspended pending a human decision. */
  | 'dispute_opened'
  /** Radar flagged a charge as likely fraudulent. Deliberately NOT auto-actioned. */
  | 'early_fraud_warning'
  /** A completed Checkout whose job row could not be found; the customer paid and nothing ran. */
  | 'job_unresolved'
  /** The trial was granted but no membership could be created: the org has no reachable owner. */
  | 'membership_unresolved'
  /** A card whose prior trial ended in a chargeback came back. The subscription was cancelled. */
  | 'disputed_card_refused'
  /** The Workflow dispatch failed after payment. The queue drain is the fallback. */
  | 'dispatch_failed';

/** Raises one operator alert. Never throws: an alert that fails must not fail the webhook. */
export function alert(kind: AlertKind, fields: Readonly<Record<string, string | number>>): void {
  console.error('billing_alert', { kind, ...fields });
}
