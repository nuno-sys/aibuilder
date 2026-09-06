/** @jsxImportSource react */
import { useId, useState } from 'react';
import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { safeNextPath } from '@aibuilder/auth';
import { Button, ErrorSummary, Field, TextInput } from '@aibuilder/ui';

import { requestMagicLink } from '../lib/api.server';
import { copyFor, uiLocaleFor } from '../lib/copy';
import { loadViewer } from '../lib/guard.server';

/**
 * `/inloggen` — request a sign-in link.
 *
 * IT ALWAYS SAYS THE SAME THING. `POST /v1/auth/magic-link` answers 202 for an unknown address
 * exactly as it does for a known one, because a 404 is an account-existence oracle — and this page
 * must not undo that by rendering a different screen for the two cases. There is one confirmation,
 * and it is deliberately worded as a conditional ("if an account exists for this address").
 *
 * THE FORM IS A REAL FORM. `<Form method="post">` posts to this route's own action, so the page
 * works with JavaScript disabled and, more usefully, works while the client bundle is still
 * downloading on a phone on 4G. The progressive enhancement is not nostalgia: this is the screen a
 * customer reaches when something has already gone wrong.
 *
 * TURNSTILE. The API requires a token on this route (`RL_AUTH` plus a challenge), and the widget is
 * rendered client-side from the same public site key the marketing modal uses. When the widget has
 * not produced a token yet — no JavaScript, or the script blocked — the field is empty and the API
 * refuses; the copy for that case says to enable JavaScript rather than pretending the mail was
 * sent.
 */

interface ActionData {
  readonly sent: boolean;
  readonly error: 'invalid_email' | 'refused' | null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const viewer = await loadViewer(env, request, Date.now());
  if (viewer !== null) {
    // Already signed in. Sending them back to the login form would be a dead end they cannot
    // navigate out of without editing the URL.
    throw redirect('/dashboard');
  }
  const url = new URL(request.url);
  return {
    locale: uiLocaleFor({ acceptLanguage: request.headers.get('accept-language') }),
    // Validated here as well as on the token, because it is rendered into a hidden input and
    // reflected back on submit — the classic place an open redirect gets in.
    next: safeNextPath(url.searchParams.get('next')),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  };
}

/** A shape that is an e-mail address closely enough to be worth a round trip. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/u;

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionData> {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  const turnstileToken = String(form.get('cf-turnstile-response') ?? '');
  const next = safeNextPath(String(form.get('next') ?? ''));

  if (email.length === 0 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return { sent: false, error: 'invalid_email' };
  }

  const result = await requestMagicLink(context.cloudflare.env, request, {
    email,
    turnstileToken,
    next,
  });

  // 202 is the only success. Anything else — a failed challenge, a rate limit — is reported as a
  // refusal WITHOUT saying which, so the response cannot be used to probe either.
  return { sent: result.status === 202, error: result.status === 202 ? null : 'refused' };
}

export default function Login() {
  const { locale, next, turnstileSiteKey } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const copy = copyFor(locale);
  const emailId = useId();
  const [attempt, setAttempt] = useState(0);

  const busy = navigation.state === 'submitting';
  const errors =
    data?.error === 'invalid_email' ? [{ fieldId: emailId, message: copy.login.invalidEmail }] : [];

  if (data?.sent === true) {
    return (
      <main id="main-content" className="app-narrow">
        {/* `role="status"` announces the confirmation without stealing focus from wherever the
            submit left it, which on this page is the button the user just pressed. */}
        <div role="status">
          <h1>{copy.login.sent}</h1>
          <p>{copy.login.sentDetail}</p>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="app-narrow">
      <h1>{copy.login.title}</h1>
      <p>{copy.login.intro}</p>

      <ErrorSummary errors={errors} heading={copy.login.invalidEmail} attempt={attempt} />

      <Form
        method="post"
        onSubmit={() => {
          setAttempt((value) => value + 1);
        }}
      >
        <input type="hidden" name="next" value={next} />
        <Field
          id={emailId}
          label={copy.login.emailLabel}
          hint={copy.login.emailHint}
          required
          {...(data?.error === 'invalid_email' ? { error: copy.login.invalidEmail } : {})}
        >
          {(control) => (
            <TextInput
              {...control}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              required
            />
          )}
        </Field>

        {/* The Turnstile widget mounts here client-side. Rendering the container unconditionally
            keeps the layout stable whether or not the script loads. */}
        <div className="cf-turnstile" data-sitekey={turnstileSiteKey} />

        <Button type="submit" variant="primary" busy={busy} block>
          {busy ? copy.common.loading : copy.login.submit}
        </Button>
      </Form>

      {data?.error === 'refused' ? (
        <p role="alert" className="app-error-text">
          {copy.errors.generic}
        </p>
      ) : null}
    </main>
  );
}
