/** @jsxImportSource react */
import { useCallback, useRef, useState } from 'react';
import { Form, redirect, useLoaderData } from 'react-router';
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from 'react-router';
import { shard } from '@aibuilder/db';
import type { ThemeDoc } from '@aibuilder/site-schema';
import { Button, EditSheet, LiveRegions } from '@aibuilder/ui';
import type { LiveRegionsHandle } from '@aibuilder/ui';

import { ContentPanel } from '../components/editor/ContentPanel';
import { PagesPanel } from '../components/editor/PagesPanel';
import { PreviewFrame } from '../components/editor/PreviewFrame';
import type { PreviewHandle } from '../components/editor/PreviewFrame';
import { ThemePanel } from '../components/editor/ThemePanel';
import { useDraftEditor } from '../components/editor/useDraftEditor';
import { siteDraftStub } from '../do/stub';
import type { ThemeKnobsPatch } from '../do/patch';
import { loadSiteDoc } from '../lib/blobs.server';
import { copyFor, uiLocaleFor } from '../lib/copy';
import { checkEntitlement, requireSiteAccess } from '../lib/guard.server';

/**
 * `/sites/:siteId/editor` — the live editor.
 *
 * THE LAYOUT IS THE REQUIREMENT: the edit panel is a column on the LEFT on a desktop and a BOTTOM
 * SHEET on a phone. `EditSheet` in `@aibuilder/ui` is both, from one DOM, with the breakpoint in
 * CSS — see that file for why it is a disclosure and not a dialog (a modal would make the preview
 * inert, which is the one thing this screen cannot do).
 *
 * WHERE THE DRAFT COMES FROM, in the order the loader tries:
 *   1. `SiteDraftDO` already holds one → use it. A draft outlives the tab, the session and the
 *      object's own eviction, because every patch is in the object's SQLite (see `SiteDraftDO`).
 *   2. It does not → read `sitedoc.json` for the site's newest editable version out of R2 and seed
 *      the object with it. `initialise` is idempotent, so two tabs opening at once do not race.
 *   3. There is no editable version → the site has never finished a build, and the page says so.
 *
 * THE DRAFT CAN BE STALE, AND THE EDITOR SAYS SO RATHER THAN RESOLVING IT. If the site was
 * regenerated while a draft existed, the draft describes sections the new version may not have.
 * Auto-discarding is unthinkable — it is the customer's unsaved work — and auto-merging is not
 * something this patch vocabulary can do honestly. So a banner explains it and offers one explicit,
 * labelled action that says what it destroys.
 *
 * `shouldRevalidate` REFUSES TO RE-RUN ON A POST. The loader mints a single-use preview grant; if it
 * re-ran after every patch, every keystroke would mint a grant and change the iframe's `src`, which
 * would reload the preview from scratch. Patches go to a resource route (`routes/site.draft.tsx`)
 * and never through this route's action, so nothing is lost by the refusal.
 */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const { viewer, site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'viewer',
    now,
  });

  const locale = uiLocaleFor({ userLocale: viewer.user.locale });
  const version = await shard.editor.getEditableVersion(site.db, site.siteId);
  if (version === null) {
    return { kind: 'no_version' as const, locale };
  }

  const stub = siteDraftStub(env, site.siteId);
  let state = await stub.readState(version.id);
  if (state === null) {
    const loaded = await loadSiteDoc(env, { siteId: site.siteId, versionId: version.id });
    if (!loaded.ok) {
      return { kind: 'no_version' as const, locale };
    }
    state = await stub.initialise({
      siteId: site.siteId,
      orgId: site.orgId,
      shardId: site.shardId,
      baseVersionId: version.id,
      doc: loaded.doc,
      now,
    });
  }

  // Minted per load, single use, sixty seconds. It is spent by the redirect that sets the preview
  // cookie, and that redirect renders nothing — which is why this token in a URL is not the
  // `Referer` leak a query-string authorisation would be.
  const grant = await stub.mintPreviewGrant({ userId: viewer.userId, now });
  const authorise = new URL('/_authorise', env.PREVIEW_ORIGIN);
  authorise.searchParams.set('g', `${site.siteId}.${grant.token}`);

  const firstPage = state.doc.pages[0];
  return {
    kind: 'ready' as const,
    locale,
    siteId: site.siteId,
    canEdit: site.role !== 'viewer',
    // A lapsed subscription does not close the editor: the customer can see their site and read
    // their work. It stops the WRITES, which is what the banner says and what the resource route
    // enforces on every patch regardless of what this page decided.
    blocked: checkEntitlement(site, now) !== null,
    doc: state.doc,
    rev: state.rev,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    stale: state.stale,
    initialPageId: firstPage?.pageId ?? '',
    initialLocale: state.doc.locales.default,
    previewOrigin: env.PREVIEW_ORIGIN,
    previewAuthoriseUrl: authorise.toString(),
    previewRenderBase: new URL(`/s/${site.siteId}`, env.PREVIEW_ORIGIN).toString(),
    draftEndpoint: `/sites/${site.siteId}/draft`,
  };
}

/**
 * The ONE navigation action this route has: discard the draft and re-seed from the published
 * version.
 *
 * It is a document POST rather than a fetcher because its outcome is a different document: every
 * field, every section id and the whole undo ring change at once, and re-rendering the page from
 * the loader is both simpler and more honest than reconciling that in the client.
 */
export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const { site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'editor',
    now,
  });
  if (checkEntitlement(site, now) !== null) {
    throw redirect(`/sites/${site.siteId}/editor`);
  }

  const version = await shard.editor.getEditableVersion(site.db, site.siteId);
  if (version !== null) {
    const loaded = await loadSiteDoc(env, { siteId: site.siteId, versionId: version.id });
    if (loaded.ok) {
      await siteDraftStub(env, site.siteId).reseed({
        baseVersionId: version.id,
        doc: loaded.doc,
        now,
      });
    }
  }
  throw redirect(`/sites/${site.siteId}/editor`);
}

/**
 * Never re-run the loader on a form submission to this route.
 *
 * The loader mints a single-use preview grant, and a re-mint changes the iframe's `src`, which
 * reloads the preview. The reseed action ends in a redirect, and a redirect is a fresh navigation
 * that runs the loader anyway — so the one case that needs new data still gets it.
 */
export function shouldRevalidate({
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  return formMethod === 'POST' ? false : defaultShouldRevalidate;
}

/** Which panel the sheet is showing. Three buttons, one panel — see the comment on the group. */
type Tab = 'theme' | 'content' | 'pages';

/**
 * The loader's two shapes, named.
 *
 * Derived from the loader rather than declared beside it, so the component and the loader cannot
 * drift: adding a field to one is adding it to the other.
 */
type LoaderData = Awaited<ReturnType<typeof loader>>;
type ReadyData = Extract<LoaderData, { readonly kind: 'ready' }>;

export default function SiteEditor() {
  const data = useLoaderData<typeof loader>();
  const copy = copyFor(data.locale);

  if (data.kind === 'no_version') {
    return (
      <main id="main-content" className="app-shell__main">
        <h1>{copy.editor.noDraft}</h1>
        <p>{copy.editor.noDraftDetail}</p>
      </main>
    );
  }

  return <EditorScreen key={data.siteId} data={data} />;
}

/** The editor proper, split out so the `no_version` branch above narrows cleanly. */
function EditorScreen({ data }: { readonly data: ReadyData }) {
  const copy = copyFor(data.locale);
  const preview = useRef<PreviewHandle>(null);
  const announcer = useRef<LiveRegionsHandle>(null);
  const [tab, setTab] = useState<Tab>('theme');
  const [pageId, setPageId] = useState(data.initialPageId);
  const [locale, setLocale] = useState<string>(data.initialLocale);

  const onTokens = useCallback((tokens: ThemeDoc['tokens']) => {
    // The server's authoritative resolution, applied over the optimistic one. Identical in every
    // normal case; different only when this client is running an older bundle, which is exactly
    // when you want the server's answer to win.
    preview.current?.applyTheme(tokens);
  }, []);

  const onStored = useCallback((revision: number) => {
    preview.current?.refresh(revision);
  }, []);

  const editor = useDraftEditor({
    endpoint: data.draftEndpoint,
    initialDoc: data.doc,
    initialRev: data.rev,
    initialCanUndo: data.canUndo,
    initialCanRedo: data.canRedo,
    onTokens,
    onStored,
  });

  const knobs: ThemeKnobsPatch = {
    dnaId: editor.doc.theme.dnaId,
    paletteVariant: editor.doc.theme.paletteVariant,
    accentHueShift: editor.doc.theme.accentHueShift,
    typeScaleId: editor.doc.theme.typeScaleId,
    radiusId: editor.doc.theme.radiusId,
    densityId: editor.doc.theme.densityId,
    motionId: editor.doc.theme.motionId,
    colorMode: editor.doc.theme.colorMode,
  };

  const readOnly = !data.canEdit || data.blocked;

  return (
    <div className="app-editor">
      <LiveRegions ref={announcer} />

      <EditSheet
        title={copy.editor.panelTitle}
        expandLabel={copy.editor.openPanel}
        collapseLabel={copy.editor.closePanel}
      >
        {data.stale ? (
          <section className="app-notice" aria-labelledby="stale-heading">
            <h3 id="stale-heading">{copy.editor.staleTitle}</h3>
            <p>{copy.editor.staleDetail}</p>
            <Form method="post">
              {/* The label says what it destroys. A "Reset" button that silently discarded an
                  afternoon's work would be the single worst control in this product. */}
              <Button type="submit" variant="danger">
                {copy.editor.staleDiscard}
              </Button>
            </Form>
          </section>
        ) : null}

        {data.blocked ? (
          <p role="alert" className="app-notice">
            {copy.editor.paywall} <a href="/facturatie">{copy.editor.paywallAction}</a>
          </p>
        ) : null}
        {editor.status === 'conflict' ? (
          <p role="alert" className="app-notice">
            {copy.editor.saveConflict}
          </p>
        ) : null}
        {editor.status === 'rejected' ? (
          <p role="alert" className="app-notice">
            {copy.editor.saveFailed}
          </p>
        ) : null}

        <div className="app-editor__context">
          <label className="aib-field__label" htmlFor="editor-page">
            {copy.editor.pageLabel}
          </label>
          <select
            id="editor-page"
            className="aib-input"
            value={pageId}
            onChange={(event) => {
              setPageId(event.currentTarget.value);
            }}
          >
            {editor.doc.pages.map((page) => (
              <option key={page.pageId} value={page.pageId}>
                {page.role}
              </option>
            ))}
          </select>

          <label className="aib-field__label" htmlFor="editor-locale">
            {copy.editor.localeLabel}
          </label>
          <select
            id="editor-locale"
            className="aib-input"
            value={locale}
            onChange={(event) => {
              setLocale(event.currentTarget.value);
            }}
          >
            {editor.doc.locales.enabled.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        {/*
          Three toggle buttons, not an ARIA tablist. A real tablist owes the user roving tabindex,
          Home/End and arrow-key navigation; a group of `aria-pressed` buttons owes them nothing
          beyond what a button already does, and is announced correctly by every screen reader
          without any of it. On a three-item switch that is the better trade.
        */}
        <div className="app-editor__tabs" role="group" aria-label={copy.editor.panelTitle}>
          {(['theme', 'content', 'pages'] as const).map((candidate) => (
            <Button
              key={candidate}
              variant={tab === candidate ? 'primary' : 'secondary'}
              aria-pressed={tab === candidate}
              onClick={() => {
                setTab(candidate);
              }}
            >
              {candidate === 'theme'
                ? copy.editor.tabTheme
                : candidate === 'content'
                  ? copy.editor.tabContent
                  : copy.editor.tabPages}
            </Button>
          ))}
        </div>

        {readOnly ? null : tab === 'theme' ? (
          <ThemePanel
            copy={copy}
            knobs={knobs}
            onChange={(next, tokens) => {
              // The repaint happens FIRST, before anything is queued: this is the zero-round-trip
              // path, and putting the network call in front of it would be exactly the latency the
              // architecture asks us to remove.
              preview.current?.applyTheme(tokens);
              editor.push({ op: 'set_theme', theme: next });
              announcer.current?.throttled(copy.editor.themeApplied);
            }}
            onRefused={() => {
              announcer.current?.assertive(copy.editor.saveFailed);
            }}
          />
        ) : tab === 'content' ? (
          <ContentPanel
            copy={copy}
            doc={editor.doc}
            pageId={pageId}
            locale={locale}
            onPatch={(patch) => {
              editor.push(patch);
            }}
          />
        ) : (
          <PagesPanel
            copy={copy}
            doc={editor.doc}
            pageId={pageId}
            onPatch={(patch) => {
              editor.push(patch);
            }}
          />
        )}

        <div className="app-editor__history">
          <Button
            disabled={!editor.canUndo || readOnly}
            onClick={() => {
              editor.undo();
            }}
          >
            {copy.common.undo}
          </Button>
          <Button
            disabled={!editor.canRedo || readOnly}
            onClick={() => {
              editor.redo();
            }}
          >
            {copy.common.redo}
          </Button>
          {/* The save state is text, not an icon: "saved" is the one word a customer looks for
              before closing the tab, and a checkmark alone fails SC 1.4.1. */}
          <p className="app-editor__status" role="status">
            {editor.status === 'saving' ? copy.common.saving : ''}
            {editor.status === 'saved' ? copy.common.saved : ''}
          </p>
        </div>
      </EditSheet>

      <main id="main-content" className="app-preview">
        <PreviewFrame
          ref={preview}
          initialSrc={data.previewAuthoriseUrl}
          renderBase={data.previewRenderBase}
          previewOrigin={data.previewOrigin}
          pageId={pageId}
          locale={locale}
          title={copy.editor.previewLabel}
        />
      </main>
    </div>
  );
}
