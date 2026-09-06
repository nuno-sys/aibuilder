import { readSecret } from '../env';
import type { Env } from '../env';

/**
 * Derivation of every identity this Worker counts, limits or logs against.
 *
 * The rule from architecture §8 that shapes this whole file: **an IP is never stored raw.**
 * `sha256(ip || daily_salt)` is what reaches D1, a quota counter or a rate-limit key, and the
 * result is documented as *pseudonymous personal data, not anonymous* — we hold the salt and IPv4
 * is exhaustively enumerable, so calling it anonymous would be wrong in a ROPA.
 *
 * The salt rotates daily by cron with two generations retained for lookback, which is what bounds
 * how long two signals stay correlatable. Nothing here caches a hash across requests: a per-isolate
 * cache keyed by IP would re-create the raw-IP store the salt exists to prevent.
 */

/** Bytes in a sha256 digest. */
const SHA256_BYTES = 32;

/** Hashes a string with SHA-256. */
export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Lowercase hex, for cache keys, quota subject names and log lines. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Convenience: `toHex(await sha256(input))`. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await sha256(input));
}

/**
 * Compares two byte strings in time independent of their contents.
 *
 * Used wherever a comparison decides authentication or authorisation. The length is compared first
 * and leaks only the length, which is a constant in every call site here.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    // `noUncheckedIndexedAccess` makes these `number | undefined`; the bounds are the loop's own.
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** The visitor's IP as Cloudflare resolved it, or `null` when the header is absent. */
export function clientIp(request: Request): string | null {
  const ip = request.headers.get('cf-connecting-ip');
  return ip === null || ip.length === 0 ? null : ip;
}

/** The visitor's country as Cloudflare resolved it, or `null`. Two uppercase letters or nothing. */
export function clientCountry(request: Request): string | null {
  const country = request.headers.get('cf-ipcountry');
  return country !== null && /^[A-Z]{2}$/.test(country) ? country : null;
}

/**
 * Hashes an IP with the daily salt.
 *
 * Returns exactly 32 bytes, which is what every `ip_hash BLOB CHECK (length(ip_hash) = 32)` column
 * in both migration sets requires.
 */
export async function hashIp(env: Env, ip: string): Promise<Uint8Array> {
  const salt = await readSecret(env.IP_SALT, 'IP_SALT');
  const bytes = await sha256(`ip${ip}${salt}`);
  if (bytes.byteLength !== SHA256_BYTES) {
    throw new Error('sha256 produced an unexpected digest length');
  }
  return bytes;
}

/**
 * The network an IP belongs to: IPv4 `/24` or IPv6 `/48`.
 *
 * Architecture §8 counts per network as well as per address, because a single-address limit is
 * trivially defeated by a /64 of residential IPv6. Returns `null` for anything unparseable rather
 * than guessing — a wrong network key would pool unrelated visitors into one counter.
 */
export function ipNetwork(ip: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (ip.includes(':')) {
    const expanded = expandIpv6(ip);
    if (expanded === null) {
      return null;
    }
    return `${expanded.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

/** Expands an IPv6 address to its eight hextets, or `null` when it is not one. */
function expandIpv6(ip: string): readonly string[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === undefined || halves[0] === '' ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 && halves[1] !== undefined && halves[1] !== '' ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) {
    return null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 0) {
    return null;
  }
  const hextets = [...head, ...Array.from({ length: fill }, () => '0'), ...tail];
  for (const hextet of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hextet)) {
      return null;
    }
  }
  return hextets.map((hextet) => hextet.toLowerCase().padStart(4, '0'));
}

/**
 * Normalises an e-mail address to the form stored in `users.email_normalized`.
 *
 * Lowercased always; for Gmail and Googlemail the dots in the local part are folded and everything
 * from a `+` is dropped, because those addresses are the same mailbox and the quota, prior-trial
 * and claim-binding lookups all key on this column. Non-Gmail local parts are NOT dot-folded —
 * that is a Gmail-specific behaviour, and applying it to every provider merges genuinely different
 * mailboxes.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) {
    return trimmed;
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') {
    return `${local}@${domain}`;
  }
  const plus = local.indexOf('+');
  const base = plus === -1 ? local : local.slice(0, plus);
  return `${base.replace(/\./g, '')}@gmail.com`;
}

/**
 * The business-identity subject: `sha256(nfkc(name) + postcode)`.
 *
 * Architecture §8 layer 5 limits one generation per business identity per day. NFKC plus
 * whitespace and case folding is what makes "Kapsalon  Anna" and "KAPSALON ANNA" the same
 * business; the postcode is what keeps two unrelated businesses of the same trade name apart.
 */
export async function businessIdentityHex(
  businessName: string,
  postalCode: string | null,
): Promise<string> {
  const name = businessName.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const postcode = (postalCode ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  return sha256Hex(`identity${name}${postcode}`);
}
