/**
 * The entire client-side runtime of a tenant site: hero video attach, mobile nav, form enhancement.
 *
 * **One deferred file, and it is inline.** Three concerns, one `<script>` at the end of `<body>`,
 * because at this size a request costs more than the bytes: an HTTP/2 request plus a connection
 * slot is worse than ~2 kB of inline text that the parser already has.
 *
 * The whole thing is a frozen string constant rather than a bundled module. That is deliberate:
 * the bytes below are hashed into the CSP's `script-src 'sha256-…'` and into the page's `ETag`, so
 * they must be identical on every deploy from the same source. A bundler in the publish path would
 * make the hash a function of the bundler's version.
 *
 * Nothing here is optional to understand:
 *
 *  - **The connection gate refuses on evidence, never on absence.** `saveData`, a sub-4g
 *    `effectiveType` and a downlink under 1.5 Mbps each remove the video outright. What it does
 *    NOT do any more is refuse when `navigator.connection` is simply missing: that API does not
 *    exist in Safari, so the old "unknown means desktop only" rule meant the header never moved on
 *    a single iPhone — the majority of the mobile traffic this product is built for. Mobile is
 *    affordable because it gets its OWN encode: a 720x1280 portrait file at a tighter CRF, not the
 *    1920x1080 desktop one letterboxed into a phone. Send the right file and the gate can be
 *    honest; send the wrong file and no gate saves you.
 *  - **`deviceMemory` under 2 GB still refuses.** That is a decode-cost guard for genuinely weak
 *    hardware, not a proxy for "is a phone" — 4 GB excluded most mid-range Android.
 *  - **LCP must already be attributed** before the video mounts — but the wait is BOUNDED, and that
 *    bound is load-bearing. The poster is usually the LCP element; it is not always. A short
 *    headline over a hero can hand LCP to the `<h1>` instead, and the original unbounded
 *    `seen ? mount() : retry` then span forever and the header never moved — the product's
 *    headline feature, silently absent, on exactly the pages where the copy is strongest. After
 *    2.5 s we mount regardless: LCP has been attributed to *something* by then, and a transparent,
 *    later-painting, intrinsically-smaller video cannot take an attribution away retroactively.
 *    Where the API does not exist at all we assume it happened rather than blocking.
 *  - **`prefers-reduced-motion` is checked first and never overridden**, including a live change
 *    after load.
 *  - **Turnstile is injected on the first `focusin` inside a form**, so it never touches initial
 *    load or LCP.
 */

/** The hero video attach. ~1 kB. Runs only on a page that has a hero video element. */
const HERO_VIDEO = `(()=>{const v=document.querySelector('.hero__video'),img=document.querySelector('.hero__poster');if(!v||!img)return;const mq=matchMedia('(prefers-reduced-motion: reduce)');if(mq.matches){v.remove();return}const c=navigator.connection;if(c){if(c.saveData===true){v.remove();return}if(c.effectiveType&&!/^(4g|5g)$/.test(c.effectiveType)){v.remove();return}if(typeof c.downlink==='number'&&c.downlink<1.5){v.remove();return}}if(typeof navigator.deviceMemory==='number'&&navigator.deviceMemory<2){v.remove();return}let seen=false;try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.element===img)seen=true}).observe({type:'largest-contentful-paint',buffered:true})}catch{seen=true}const mount=()=>{if(document.visibilityState!=='visible')return;const p=innerWidth<768,d=v.dataset,add=(s,t)=>{if(!s)return;const e=document.createElement('source');e.src=s;e.type=t;v.appendChild(e)};add(p?d.srcMobileAv1:d.srcDesktopAv1,'video/webm; codecs="av01.0.05M.08"');add(p?d.srcMobileH264:d.srcDesktopH264,'video/mp4; codecs="avc1.640028"');v.load();v.play().then(()=>requestAnimationFrame(()=>{v.dataset.ready='1'})).catch(()=>v.remove())};const start=()=>{const t0=Date.now(),go=()=>seen||Date.now()-t0>2500?mount():setTimeout(go,250);'requestIdleCallback'in window?requestIdleCallback(go,{timeout:2500}):setTimeout(go,800)};if(document.prerendering){document.addEventListener('prerenderingchange',()=>addEventListener('load',start,{once:true}),{once:true})}else{addEventListener('load',start,{once:true})}mq.addEventListener('change',e=>{if(e.matches){v.pause();v.remove()}});const io=new IntersectionObserver(([e])=>{if(!v.isConnected)return io.disconnect();e.isIntersecting?v.play().catch(()=>{}):v.pause()});io.observe(v)})();`;

/**
 * The mobile menu. ~180 B.
 *
 * A native `<dialog>` plus `showModal()`: the focus trap, the inert background and the Escape
 * handling are the platform's, not ours, and every hand-rolled focus trap in the wild is subtly
 * wrong. `aria-expanded` is kept in sync because the button is the thing a screen reader reads.
 */
const MOBILE_NAV = `(()=>{const d=document.getElementById('site-menu'),o=document.querySelector('[data-menu-open]');if(!d||!o||!d.showModal)return;const set=v=>o.setAttribute('aria-expanded',v?'true':'false');o.addEventListener('click',()=>{d.showModal();set(true)});d.addEventListener('close',()=>{set(false);o.focus()});d.querySelector('[data-menu-close]')?.addEventListener('click',()=>d.close())})();`;

/**
 * Form enhancement. ~500 B.
 *
 * Turnstile arrives on the first `focusin` inside a form and never before. `novalidate` is on the
 * form so the browser's own bubbles do not fight our `aria-describedby` errors; this restores
 * validation at submit time and moves focus to the first invalid control, which is what a keyboard
 * user needs and what the native bubble does not do reliably inside a scrolled section.
 */
const FORM_ENHANCE = `(()=>{const f=document.querySelector('form[action="/api/leads"]');if(!f)return;let t=false;f.addEventListener('focusin',()=>{if(t)return;t=true;const s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js';s.async=true;s.defer=true;document.head.appendChild(s)},{once:true});f.addEventListener('submit',e=>{const bad=f.querySelector(':invalid');if(bad){e.preventDefault();bad.focus()}})})();`;

/**
 * The complete inline script, in load order.
 *
 * Frozen at module scope so the value — and therefore its CSP hash — is a pure function of this
 * file.
 */
export const SITE_JS: string = `${HERO_VIDEO}${MOBILE_NAV}${FORM_ENHANCE}`;

/**
 * The stated ceiling for the inline script, in raw bytes.
 *
 * The budget in the specification is "≤ 4 KB", and raw bytes are what this package can measure —
 * `workerd` has no brotli stream API, and gzip of a 2 kB string is not a number worth gating on.
 * `__tests__/render.test.ts` asserts the real size against this constant.
 */
export const SITE_JS_CEILING = 4096;
