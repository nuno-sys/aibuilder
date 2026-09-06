/**
 * The two web globals this package uses, declared with exactly the surface it calls.
 *
 * `tsconfig.json` sets `"types": []` and `lib` is ES2022 only, so nothing ambient exists here by
 * default. That is the point: site-kit must not be able to reach for `document`, `window`,
 * `process` or a Node builtin, and the cheapest enforcement is to never declare them. Both globals
 * below are Web-standard and behave identically in Node 22 and in workerd.
 */

interface SiteKitSubtleCrypto {
  digest(algorithm: 'SHA-256', data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
}

declare const crypto: { readonly subtle: SiteKitSubtleCrypto };

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
