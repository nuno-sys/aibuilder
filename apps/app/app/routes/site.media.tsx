/** @jsxImportSource react */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { assetPath } from '@aibuilder/core';
import { shard } from '@aibuilder/db';
import type { MediaAssetId } from '@aibuilder/db';
import { Button, Field, TextInput } from '@aibuilder/ui';

import { copyFor, uiLocaleFor } from '../lib/copy';
import { checkEntitlement, requireSiteAccess } from '../lib/guard.server';

/**
 * `/sites/:siteId/media` — the site's photos, and the one property of them a customer edits.
 *
 * ALT TEXT IS THE FEATURE. Everything else about a media asset is written by the pipeline from
 * bytes it hashed itself — dimensions, format, the derivative ladder, the blurhash — and none of it
 * is a customer's to change. Alt text is the exception, and it is not a nicety: an image with no
 * accessible name is a WCAG 1.1.1 failure on the customer's own site, and the model that generated
 * the page has never seen the photograph.
 *
 * THE FILENAME IS NEVER RENDERED. Architecture §8: the uploader's filename is display-only and
 * HTML-escaped at render — and this page does not display it at all, because there is nothing
 * useful in `IMG_2931.jpeg` and every reason not to echo a user-supplied string into a page that
 * also carries a session.
 *
 * THUMBNAILS COME FROM THE CDN, not from this Worker. `apps/media` serves the content-addressed
 * derivative ladder on the tenant zone; proxying an image through the dashboard would put tenant
 * bytes on the origin that holds the session cookie, for no benefit.
 */

/** One screenful and then some. Pagination arrives when a customer has more than this. */
const MEDIA_LIMIT = 60;

/** The thumbnail rung. The smallest the ladder produces, which is all a grid cell needs. */
const THUMBNAIL_WIDTH = 400;

/** `media_assets.alt_text` is `CHECK (length(alt_text) <= 300)`. */
const ALT_TEXT_MAX = 300;

/** Extracts the content digest from a media key, so a thumbnail URL can be built from it. */
function digestOf(r2Key: string): string | null {
  const match = /^img\/([0-9a-f]{64})\/|^orig\/([0-9a-f]{64})$/u.exec(r2Key);
  return match?.[1] ?? match?.[2] ?? null;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const { viewer, site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'viewer',
    now,
  });

  const assets = await shard.editor.listSiteMedia(site.db, {
    siteId: site.siteId,
    limit: MEDIA_LIMIT,
  });

  return {
    locale: uiLocaleFor({ userLocale: viewer.user.locale }),
    canEdit: site.role !== 'viewer',
    assets: assets.flatMap((asset) => {
      const sha256 = digestOf(asset.r2_key);
      // An asset whose key is not content-addressed cannot be served by `apps/media`, so it is not
      // shown rather than rendered as a broken image. This is a pipeline bug if it ever happens.
      if (sha256 === null || asset.width === null || asset.height === null) {
        return [];
      }
      return [
        {
          id: asset.id,
          altText: asset.alt_text ?? '',
          width: asset.width,
          height: asset.height,
          thumbnail: `${env.MEDIA_CDN_ORIGIN}${assetPath({
            kind: 'image',
            sha256,
            width: THUMBNAIL_WIDTH,
            format: 'jpg',
          })}`,
        },
      ];
    }),
  };
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const { site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'editor',
    now,
  });

  // Alt text is content, so it is behind the same paywall as every other content change: an
  // organisation whose subscription lapsed keeps its site serving and stops being able to edit it.
  const refusal = checkEntitlement(site, now);
  if (refusal !== null) {
    return { saved: false, refusal } as const;
  }

  const form = await request.formData();
  const mediaId = String(form.get('mediaId') ?? '');
  const raw = String(form.get('altText') ?? '').trim();
  if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/u.test(mediaId) || raw.length > ALT_TEXT_MAX) {
    return { saved: false, refusal: null } as const;
  }

  // An empty string is stored as NULL, not as "". `site-kit` renders `altText ?? ''` as a
  // decorative image, and "the customer deliberately left it empty" and "nobody has described it"
  // are the same rendered outcome — so there is no reason to keep two representations of it.
  const saved = await shard.editor.setMediaAltText(site.db, {
    siteId: site.siteId,
    mediaId: mediaId as MediaAssetId,
    altText: raw.length === 0 ? null : raw,
    now,
  });
  return { saved, refusal: null } as const;
}

export default function SiteMedia() {
  const { locale, assets, canEdit } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const copy = copyFor(locale);
  const busy = navigation.state === 'submitting';

  return (
    <main id="main-content" className="app-shell__main">
      <h1>{copy.media.title}</h1>

      {data?.refusal !== null && data?.refusal !== undefined ? (
        <p role="alert">{copy.editor.paywall}</p>
      ) : null}
      {data?.saved === true ? <p role="status">{copy.media.altSaved}</p> : null}

      {assets.length === 0 ? (
        <p>{copy.media.empty}</p>
      ) : (
        <ul className="app-media-grid">
          {assets.map((asset) => (
            <li key={asset.id} className="app-media-card">
              {/* `alt=""` on the thumbnail, deliberately: the image is a preview of the thing the
                  adjacent field describes, so announcing it twice adds nothing. The field's label
                  carries the meaning. */}
              <img
                className="app-media-card__image"
                src={asset.thumbnail}
                alt=""
                width={asset.width}
                height={asset.height}
                loading="lazy"
                decoding="async"
              />
              <p className="app-media-card__meta">
                {copy.media.dimensions}: {asset.width}×{asset.height}
              </p>
              {canEdit ? (
                <Form method="post">
                  <input type="hidden" name="mediaId" value={asset.id} />
                  <Field
                    id={`alt-${asset.id}`}
                    label={copy.media.altLabel}
                    hint={copy.media.altHint}
                  >
                    {(control) => (
                      <TextInput
                        {...control}
                        name="altText"
                        defaultValue={asset.altText}
                        maxLength={ALT_TEXT_MAX}
                      />
                    )}
                  </Field>
                  <Button type="submit" busy={busy}>
                    {copy.common.save}
                  </Button>
                </Form>
              ) : (
                <p className="app-media-card__meta">{asset.altText}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
