/** @jsxImportSource react */
import { ServerRouter } from 'react-router';
import type { AppLoadContext, EntryContext } from 'react-router';
import { renderToReadableStream } from 'react-dom/server';
import { isbot } from 'isbot';

/**
 * Server rendering, on workerd.
 *
 * `renderToReadableStream` and NOT `renderToPipeableStream`: the second is Node's, built on
 * `stream.Writable`, and this runs on a runtime whose streams are the web ones. Using the wrong one
 * is the single most common way a React Router app fails to deploy to Workers, and it fails at
 * runtime rather than at build time.
 *
 * `await stream.allReady` FOR BOTS, streaming for humans. A crawler that receives a shell and a
 * script tag indexes the shell; a person who receives the shell sees content sooner. Nothing on
 * this surface is indexed — the dashboard is `noindex` and behind a session — but the branch costs
 * one boolean and makes the behaviour correct if that ever changes.
 *
 * A RENDER ERROR IS A 500 WITH NO DETAIL. `onError` logs; the response body says nothing, because
 * a React server-render error message can carry props, and props here are tenant data.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
): Promise<Response> {
  let status = responseStatusCode;

  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        // Logged, never returned. `console.error` is the Workers Logs sink; the redaction
        // middleware in `@aibuilder/core` covers prompt and lead bodies, and nothing on this path
        // carries either.
        console.error('render error', error);
        status = 500;
      },
    },
  );

  if (isbot(request.headers.get('user-agent') ?? '')) {
    await stream.allReady;
  }

  responseHeaders.set('content-type', 'text/html; charset=utf-8');
  return new Response(stream, { status, headers: responseHeaders });
}
