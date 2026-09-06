import type { Timestamp } from '@aibuilder/db';

import type { CredentialDescriptorJson } from './options';
import type { RpIdConfig } from './rpid';

/**
 * The verification half of WebAuthn, as a PORT.
 *
 * WHY A PORT AND NOT AN IMPLEMENTATION IN THIS CHANGE. `PHASE2-BILLING-AUTH.md` §6.1 chose
 * `@simplewebauthn/server@14.0.1`, and that choice stands — hand-rolling COSE decoding, CBOR
 * attestation parsing and ES256/RS256/EdDSA signature verification is a security-critical parser
 * written from scratch for no benefit. But three of its four prerequisites are absent from the
 * repository at the time this file is written, and none of them is mine to add:
 *
 *   1. the package is not installed (no `pnpm install` from this change);
 *   2. `migrations/cp/0008_trials_passkeys.sql` — which creates `webauthn_credentials` and adds
 *      `sessions.pending_challenge` / `pending_challenge_expires_at` / `auth_method` — does not
 *      exist;
 *   3. `packages/db/src/cp/auth.ts`, which owns the statements over that table, does not exist.
 *
 * Shipping a verifier against a table that is not there would be a runtime error dressed up as a
 * feature. So the contract is written down here, exactly, and the two `verify` routes answer 503
 * `passkey_unavailable` until an adapter is supplied. Everything that does NOT depend on the three
 * missing pieces — the RP ID one-way door, options generation, the challenge lifecycle, the
 * sign-counter policy — ships and is tested now, which is what matters: the one-way door has to be
 * shut *before* the first credential exists, not after.
 *
 * An adapter is roughly forty lines: map these arguments onto
 * `verifyRegistrationResponse` / `verifyAuthenticationResponse` and map their results back.
 */

/** The browser's `PublicKeyCredential` after `.toJSON()`, as an opaque value. */
export type CredentialResponseJson = Readonly<Record<string, unknown>>;

/** What a registration verification needs beyond the browser's response. */
export interface VerifyRegistrationArgs extends RpIdConfig {
  readonly response: CredentialResponseJson;
  /** The challenge this ceremony was issued with. Never read from the client. */
  readonly expectedChallenge: string;
}

/** A verified new credential, in the shape `webauthn_credentials` stores. */
export interface VerifiedRegistration {
  readonly credentialId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[] | null;
  readonly aaguid: string | null;
  readonly backedUp: boolean;
  readonly deviceType: 'singleDevice' | 'multiDevice' | null;
  /** Recorded per credential so a future RP ID change is detectable rather than silently fatal. */
  readonly rpId: string;
}

/** What an authentication verification needs beyond the browser's response. */
export interface VerifyAuthenticationArgs extends RpIdConfig {
  readonly response: CredentialResponseJson;
  readonly expectedChallenge: string;
  /** The stored public key for the credential the browser named. */
  readonly publicKey: Uint8Array;
  /** The counter as we last stored it. See `checkSignCounter`. */
  readonly storedCounter: number;
}

/** A verified assertion. */
export interface VerifiedAuthentication {
  readonly credentialId: Uint8Array;
  /** The counter the authenticator reported. Compared against the stored one, then written. */
  readonly newCounter: number;
  readonly verifiedAt: Timestamp;
}

/**
 * The port `apps/api` wires an adapter into.
 *
 * Both methods reject rather than returning a falsy result: a failed ceremony is exceptional in the
 * literal sense — every legitimate client that reaches here has already produced a valid assertion.
 */
export interface WebAuthnVerifier {
  verifyRegistration(args: VerifyRegistrationArgs): Promise<VerifiedRegistration>;
  verifyAuthentication(args: VerifyAuthenticationArgs): Promise<VerifiedAuthentication>;
}

/** The credential fields a ceremony needs to exclude an already-enrolled authenticator. */
export interface StoredCredentialSummary extends CredentialDescriptorJson {
  readonly counter: number;
}
