import type { ThemeDoc } from '@aibuilder/site-schema';

/**
 * Live theming: a colour change that costs zero network round trips and zero React renders.
 *
 * THE MECHANISM, AND WHY IT IS THE WHOLE FEATURE. `site-kit` resolves eight enums into ~47 CSS
 * custom properties and emits them into one `:root{}` block (`PHASE2-SITE-KIT.md` §4.7). Every
 * component reads colour only through those names — that package's `assembleCss` lint fails the
 * build otherwise — so overwriting the properties on the root element restyles the entire document
 * with one style recalculation. No re-render, no server call, no rebuild of the CSS bundle.
 *
 * On save, the same eight enums go back through `resolveTheme` on the server, so the preview and
 * the publish cannot disagree about anything except the moment they were computed. The client's
 * copy of the resolved tokens is an optimisation, never the source of truth.
 *
 * WHY THE PREVIEW IS ADDRESSED BY `postMessage` AND NOT BY TOUCHING ITS DOM. The preview iframe is
 * on a different host (`preview.<control-plane-domain>`) precisely because it renders
 * attacker-influenced content — model output and customer copy — and must not have access to the
 * dashboard's DOM or its session cookie. Cross-origin is the point, so `contentDocument` is `null`
 * by design and `postMessage` with an exact `targetOrigin` is the supported channel. It is still
 * sub-millisecond; "0 ms round-trip" is a statement about the network, and this makes no network
 * request at all.
 *
 * EVERY NAME IS VALIDATED BEFORE IT REACHES `setProperty`. The token map is server-computed today,
 * but it crosses an origin boundary on the way to the preview, and `setProperty` is the one DOM API
 * in this path that accepts an arbitrary string. A name outside `--[a-z0-9-]+` and a value
 * containing `<`, `{`, `}` or a semicolon are dropped rather than clamped: a rejected colour is a
 * colour that does not change, which the user sees immediately.
 */

/** The `type` field of every theme message. Namespaced so a stray `message` event is ignored. */
export const THEME_MESSAGE_TYPE = 'aibuilder.preview.theme';

/** What the editor posts into the preview frame. */
export interface ThemeMessage {
  readonly type: typeof THEME_MESSAGE_TYPE;
  /** The resolved custom properties, `--name` → value. */
  readonly tokens: ThemeDoc['tokens'];
}

/** A custom property name this system is willing to write. */
const TOKEN_NAME_PATTERN = /^--[a-z0-9-]+$/u;

/**
 * A token value this system is willing to write.
 *
 * Deliberately a denylist of the four characters that could end a declaration or open a construct,
 * rather than an allowlist of colour syntax: the values are `oklch(...)`, lengths, font stacks with
 * quotes and commas, and cubic-bezier timing functions, and an allowlist that has to cover all of
 * those is an allowlist that will be wrong.
 */
const TOKEN_VALUE_FORBIDDEN = /[<>{};]/u;

/** True when this name/value pair may be written to a style declaration. */
export function isSafeThemeToken(name: string, value: string): boolean {
  return (
    TOKEN_NAME_PATTERN.test(name) &&
    value.length > 0 &&
    value.length <= 200 &&
    !TOKEN_VALUE_FORBIDDEN.test(value)
  );
}

/**
 * Writes resolved theme tokens onto an element's inline style.
 *
 * Returns how many were applied, so a caller can tell "nothing changed" from "everything was
 * rejected" — the two look identical on screen and only one of them is a bug.
 *
 * Inline style rather than a `<style>` element on purpose: an inline declaration outranks every
 * rule in the `tokens` cascade layer without needing `!important`, and removing it later is one
 * `removeProperty` per name rather than a stylesheet to garbage-collect.
 */
export function applyThemeTokens(target: HTMLElement, tokens: ThemeDoc['tokens']): number {
  let applied = 0;
  for (const [name, value] of Object.entries(tokens)) {
    if (!isSafeThemeToken(name, value)) {
      continue;
    }
    target.style.setProperty(name, value);
    applied += 1;
  }
  return applied;
}

/**
 * Posts resolved tokens into the preview frame.
 *
 * `targetOrigin` is the exact preview origin and never `'*'`. `'*'` would deliver the message to
 * whatever document happens to occupy that frame — including one an open redirect put there — and
 * the tokens are not secret but the habit is what leaks the next message that is.
 *
 * A frame that has not loaded yet has a `contentWindow` of `null`; the caller re-posts on the
 * frame's `load` event rather than this function queueing, because the preview re-renders from the
 * server-resolved theme on load anyway and a queued message would apply a stale one over it.
 */
export function postThemeToFrame(
  frame: HTMLIFrameElement | null,
  previewOrigin: string,
  tokens: ThemeDoc['tokens'],
): boolean {
  const target = frame?.contentWindow ?? null;
  if (target === null) {
    return false;
  }
  const message: ThemeMessage = { type: THEME_MESSAGE_TYPE, tokens };
  target.postMessage(message, previewOrigin);
  return true;
}
