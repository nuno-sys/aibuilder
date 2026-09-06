/**
 * The two `node:zlib` exports the CSS budget test uses, declared here rather than pulled in with
 * `@types/node`.
 *
 * `tsconfig.json` sets `"types": []` on purpose: site-kit must not be able to reach for a Node API,
 * and adding the full ambient package would make `process`, `Buffer` and `require` available to
 * every *source* file too. eslint already exempts `__tests__` from the `node:*` import ban —
 * measuring real brotli-11 is exactly what that exemption is for — and this keeps the type side of
 * the exemption equally narrow.
 */
declare module 'node:zlib' {
  export function brotliCompressSync(
    data: Uint8Array,
    options?: { params?: Record<number, number> },
  ): Uint8Array;
  export const constants: { readonly BROTLI_PARAM_QUALITY: number };
}
