/**
 * The eleven lines of JavaScript that make a colour change instant.
 *
 * WHAT IT DOES. Listens for one message from the dashboard and writes CSS custom properties onto
 * `document.documentElement`. Because every component in `site-kit` reads colour only through those
 * names — that package's `assembleCss` lint fails the build otherwise — one style recalculation
 * restyles the whole page. No re-render, no reload, no network request.
 *
 * WHY IT IS A FROZEN STRING AND NOT A MODULE. It runs inside the preview document, which is a
 * different origin with its own asset pipeline; there is nothing to bundle it into. `site-kit` ships
 * its three inline scripts the same way and for the same reason (`src/js/site.ts`).
 *
 * THE ORIGIN CHECK IS THE SECURITY BOUNDARY, and it is checked first, before the payload is looked
 * at. A preview document is framed by the dashboard and by nothing else (`frame-ancestors`), but
 * `window.postMessage` can be called by any window that has a handle to this one — including an
 * opener. `event.origin !== ORIGIN` is what makes this a channel from the editor rather than from
 * anyone.
 *
 * THE NAME AND VALUE ARE VALIDATED, in the same shapes `@aibuilder/ui`'s `isSafeThemeToken` uses,
 * because `setProperty` is the one DOM API on this path that accepts an arbitrary string and the
 * message crossed an origin boundary to get here.
 */

/** Must equal `THEME_MESSAGE_TYPE` in `@aibuilder/ui`. Asserted by `app/__tests__/patch.test.ts`. */
const MESSAGE_TYPE = 'aibuilder.preview.theme';

/**
 * Builds the bridge script for one dashboard origin.
 *
 * The origin is interpolated as a JSON string literal, so a malformed `DASHBOARD_ORIGIN` var
 * produces a broken comparison rather than an injection — and the value comes from `wrangler.jsonc`,
 * not from a request, so it is ours either way.
 */
export function previewBridgeScript(dashboardOrigin: string): string {
  return `(function(){
var O=${JSON.stringify(dashboardOrigin)},T=${JSON.stringify(MESSAGE_TYPE)},
N=/^--[a-z0-9-]+$/,V=/[<>{};]/;
addEventListener("message",function(e){
if(e.origin!==O)return;
var d=e.data;
if(!d||d.type!==T||typeof d.tokens!=="object"||d.tokens===null)return;
var s=document.documentElement.style,k;
for(k in d.tokens){var v=d.tokens[k];
if(typeof v==="string"&&v.length>0&&v.length<=200&&N.test(k)&&!V.test(v))s.setProperty(k,v);}
});
parent.postMessage({type:"aibuilder.preview.ready"},O);
})();`;
}

/**
 * Splices the bridge into a rendered document.
 *
 * String concatenation rather than a DOM pass: the document is already serialised HTML from
 * `renderPage`, and re-parsing a tenant page in order to insert one script would mean owning a
 * parser on the path that renders attacker-influenced markup. Appending is what the publish
 * pipeline does too.
 *
 * The script goes before `</body>` so it exists once the document has parsed, and after the page's
 * own inline scripts so it cannot change their execution order.
 */
export function withPreviewBridge(html: string, dashboardOrigin: string): string {
  const script = `<script>${previewBridgeScript(dashboardOrigin)}</script>`;
  const index = html.lastIndexOf('</body>');
  if (index === -1) {
    // A document without a closing body tag is not something `renderPage` produces, but appending
    // is a correct fallback: the browser's parser puts a trailing script in the body anyway.
    return `${html}${script}`;
  }
  return `${html.slice(0, index)}${script}${html.slice(index)}`;
}
