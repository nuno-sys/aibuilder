/**
 * The one policy decision a passkey login makes that is ours and not the verifier's.
 */

/** What the sign counter says about an assertion. */
export type SignCounterVerdict = 'ok' | 'cloned';

/**
 * Decides whether a reported sign counter indicates a cloned authenticator.
 *
 * THE RULE, AND THE TRAP INSIDE IT. An authenticator that increments a counter and reports a value
 * BELOW what we stored has either been cloned or has been rolled back; §6.2 calls for refusing the
 * login, revoking every session of that user, and alerting. But **a great many passkeys report a
 * constant `0`** — every iCloud Keychain and Google Password Manager credential does, because a
 * synced credential cannot maintain a meaningful counter across devices. Treating `0 → 0` as a
 * regression would lock out the majority of real users on the majority of real platforms, which is
 * why both counters must be non-zero for this to mean anything at all.
 *
 * EQUALITY IS DELIBERATELY NOT A SIGNAL HERE. WebAuthn §7.2 requires a strict increase, so an equal
 * non-zero counter is technically non-conforming and some implementations do refuse it. §6.2
 * defines the signal as *decreasing*, and this follows that verbatim: authenticators that increment
 * lazily or that batch their counter writes exist in the field, and a false "your account may be
 * compromised, all sessions revoked" is a worse outcome than the replay window equality leaves open
 * — a window that a fresh challenge per ceremony already closes.
 */
export function checkSignCounter(stored: number, returned: number): SignCounterVerdict {
  if (stored === 0 || returned === 0) {
    return 'ok';
  }
  return returned < stored ? 'cloned' : 'ok';
}
