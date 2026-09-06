import { randomToken, utf8ToBase64Url } from '../encoding';

import { assertRpId } from './rpid';
import type { RpIdConfig } from './rpid';

/**
 * The two ceremony option objects, built by hand.
 *
 * WHY BY HAND HERE, WHEN §6.1 CHOSE `@simplewebauthn/server`. The library is chosen for
 * VERIFICATION — COSE key decoding, CBOR attestation parsing, ES256/RS256/EdDSA signature checks —
 * because that is a security-critical parser and writing one is a bad trade. Generating options is
 * the other half of the ceremony and it is not a parser: it is a JSON object with a random
 * challenge in it. Building it here keeps the challenge lifecycle, the RP ID assertion and the
 * `residentKey`/`userVerification` policy in one auditable place, and it means the options endpoint
 * has no dependency to be unavailable.
 *
 * The verification half is declared as a port in `./verifier.ts` and is not implemented in this
 * change; the routes that would call it answer 503 and say why.
 */

/** Bytes of entropy in a ceremony challenge. */
export const CHALLENGE_BYTES = 32;

/** How long a browser is given to complete a ceremony, in milliseconds. */
export const CEREMONY_TIMEOUT_MS = 300_000;

/**
 * The COSE algorithms we accept, in preference order.
 *
 * `-7` ES256 is universal. `-257` RS256 is what Windows Hello's TPM path produces. `-8` EdDSA is
 * what several hardware keys prefer. Offering all three is what makes "register a passkey" work on
 * the first try rather than on the second device.
 */
export const SUPPORTED_ALGORITHMS: readonly number[] = [-7, -257, -8];

/** A credential the browser should skip (registration) or accept (authentication). */
export interface CredentialDescriptorJson {
  readonly type: 'public-key';
  /** base64url of the raw credential id. */
  readonly id: string;
  readonly transports?: readonly string[] | undefined;
}

/** The `PublicKeyCredentialCreationOptions` JSON the browser is handed. */
export interface RegistrationOptionsJson {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: 'none';
  readonly excludeCredentials: readonly CredentialDescriptorJson[];
  readonly authenticatorSelection: {
    readonly residentKey: 'required';
    readonly requireResidentKey: true;
    readonly userVerification: 'preferred';
  };
}

/** The `PublicKeyCredentialRequestOptions` JSON the browser is handed. */
export interface AuthenticationOptionsJson {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: 'preferred';
  /**
   * Deliberately empty.
   *
   * Discoverable credentials only: the platform picks the account, so the server never has to be
   * told which user is logging in before they have proved anything. Naming credentials here would
   * turn the login form into an account-existence oracle, which is the same thing §6.2 refuses to
   * build into `POST /v1/auth/magic-link`.
   */
  readonly allowCredentials: readonly CredentialDescriptorJson[];
}

/** What a registration ceremony is bound to. */
export interface RegistrationOptionsArgs extends RpIdConfig {
  /** Shown in the browser's UI. The product name, not a hostname. */
  readonly rpName: string;
  /** `usr_…`. Encoded as base64url of its UTF-8 bytes, per §6.2. */
  readonly userId: string;
  /** The address the account is keyed on. */
  readonly userName: string;
  /** What the user sees in the platform's account picker. */
  readonly userDisplayName: string;
  /** Credentials this user already has, so the platform refuses to enrol the same key twice. */
  readonly existingCredentials: readonly CredentialDescriptorJson[];
}

/** A ceremony's options and the challenge that has to be remembered until it completes. */
export interface Ceremony<T> {
  readonly options: T;
  /** base64url of `CHALLENGE_BYTES` random bytes. Stored server-side; never trusted from a client. */
  readonly challenge: string;
}

/**
 * Builds registration options.
 *
 * @throws RpIdInvariantError before generating anything, when the configured RP ID would open the
 * one-way door. Refusing here is the whole point: a credential minted under a broadened RP ID
 * cannot be un-minted.
 */
export function registrationCeremony(
  args: RegistrationOptionsArgs,
): Ceremony<RegistrationOptionsJson> {
  assertRpId(args);
  const challenge = randomToken(CHALLENGE_BYTES);

  return {
    challenge,
    options: {
      challenge,
      rp: { id: args.rpId, name: args.rpName },
      user: {
        id: utf8ToBase64Url(args.userId),
        name: args.userName,
        displayName: args.userDisplayName,
      },
      pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
      timeout: CEREMONY_TIMEOUT_MS,
      // `none` keeps an AAGUID-level attestation statement out of the flow entirely. We do not
      // enforce an authenticator allowlist, so an attestation certificate would be a privacy cost
      // with no corresponding decision behind it — and it is the setting that keeps
      // `@simplewebauthn/server`'s X.509 path validator (and its `reflect-metadata` dependency)
      // permanently unreached (§6.1).
      attestation: 'none',
      excludeCredentials: args.existingCredentials,
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        // `preferred`, not `required`: a hardware key without a PIN still enrols, and the magic
        // link remains the recovery factor either way. Requiring UV here locks out exactly the
        // users most likely to own a security key.
        userVerification: 'preferred',
      },
    },
  };
}

/**
 * Builds authentication options.
 *
 * @throws RpIdInvariantError for the same reason as `registrationCeremony`: an assertion requested
 * under the wrong RP ID would silently never match a stored credential, and "passkeys stopped
 * working" is a much harder thing to diagnose than a 503 that names the reason.
 */
export function authenticationCeremony(config: RpIdConfig): Ceremony<AuthenticationOptionsJson> {
  assertRpId(config);
  const challenge = randomToken(CHALLENGE_BYTES);

  return {
    challenge,
    options: {
      challenge,
      rpId: config.rpId,
      timeout: CEREMONY_TIMEOUT_MS,
      userVerification: 'preferred',
      allowCredentials: [],
    },
  };
}
