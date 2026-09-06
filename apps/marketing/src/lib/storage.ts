/**
 * A `localStorage` that cannot throw.
 *
 * EVERY access is wrapped, not just the write, and that is not defensive padding — each of the
 * three operations fails in a different real browser:
 *
 *   - **Reading** throws in Safari with "Prevent cross-site tracking" in some embedded contexts,
 *     and in any browser where the user has blocked site data. `localStorage` itself is a getter
 *     that throws, so even `typeof localStorage` can raise a `SecurityError`.
 *   - **Writing** throws `QuotaExceededError` in Safari's private mode (historically a zero-byte
 *     quota) and whenever the origin's quota is full.
 *   - **Removing** throws for the same reasons as reading.
 *
 * When storage is unavailable the module falls back to an in-memory `Map`, which lasts exactly as
 * long as the tab. That is the honest degradation: the draft still survives a step change and a
 * back button, and the SERVER copy — which is the one that actually matters for resume — is
 * untouched by any of this. The flow works with storage entirely unavailable.
 */

/** The subset of the Storage API this island uses, with every failure mode removed. */
export interface SafeStorage {
  /** The stored string, or `null` when absent or unreadable. */
  read(key: string): string | null;
  /** Stores a string. Returns `false` when the write was refused (quota, blocked storage). */
  write(key: string, value: string): boolean;
  /** Removes a key. Silent on failure. */
  remove(key: string): void;
  /** `false` when the values live only in memory and will not survive a reload. */
  readonly persistent: boolean;
}

/** In-memory storage of last resort. Its lifetime is the tab's. */
function memoryStorage(): SafeStorage {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
      return true;
    },
    remove: (key) => {
      map.delete(key);
    },
    persistent: false,
  };
}

/** Probes `localStorage` with a real round trip; a getter that throws is caught here, once. */
function probe(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    const key = '__aib_probe__';
    storage.setItem(key, '1');
    storage.removeItem(key);
    return storage;
  } catch {
    return null;
  }
}

let cached: SafeStorage | null = null;

/**
 * The storage the island writes its draft to.
 *
 * Resolved once per document: the probe costs a write and a delete, and repeating it per keystroke
 * would be a synchronous storage round trip on the typing path.
 */
export function safeStorage(): SafeStorage {
  if (cached !== null) {
    return cached;
  }
  const storage = probe();
  if (storage === null) {
    cached = memoryStorage();
    return cached;
  }
  cached = {
    read: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      try {
        storage.setItem(key, value);
        return true;
      } catch {
        // A full quota is not worth a broken flow: the server copy is the durable one.
        return false;
      }
    },
    remove: (key) => {
      try {
        storage.removeItem(key);
      } catch {
        // Nothing to do and nothing to report.
      }
    },
    persistent: true,
  };
  return cached;
}

/** Reads and parses JSON, returning `null` for absent, unreadable or malformed values. */
export function readJson<T>(key: string): T | null {
  const raw = safeStorage().read(key);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupted draft is discarded rather than repaired: half a wizard is worse than a fresh one.
    safeStorage().remove(key);
    return null;
  }
}

/** Serialises and stores a value. Returns `false` when the write was refused. */
export function writeJson(key: string, value: unknown): boolean {
  try {
    return safeStorage().write(key, JSON.stringify(value));
  } catch {
    // `JSON.stringify` throws on a cyclic value; that would be our bug, and it must not break typing.
    return false;
  }
}
