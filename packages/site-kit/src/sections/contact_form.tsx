import type { ContactFieldName, SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { uiStrings } from '../ui';

/**
 * The lead form.
 *
 * Every field is a real `<label for>` plus a real control. The `autocomplete` map below is SC 1.3.5
 * (Identify Input Purpose): `message` and `date` get `off` on purpose — there is no
 * WCAG-recognised purpose token for a free-text message, and `bday` would be a lie about what the
 * date means.
 *
 * The consent checkbox's label is the whole consent sentence and it is **never** pre-checked;
 * `lint.ts` errors when the field is absent. Errors are `aria-describedby` text plus an inline-start
 * border in `--t-danger`, which is why the token set has `--color-danger` and no
 * `--color-fg-on-danger`: there is no filled danger surface anywhere in this system.
 *
 * Turnstile is injected by `js/site.ts` on the first `focusin` inside the form, so it never touches
 * initial load or LCP.
 */
const AUTOCOMPLETE: Readonly<Record<ContactFieldName, string>> = {
  name: 'name',
  email: 'email',
  phone: 'tel',
  date: 'off',
  service: 'off',
  message: 'off',
  consent: 'off',
};

export function ContactForm(props: SectionProps<SectionOf<'contact_form'>>): Markup {
  const { section, doc, scope } = props;
  const strings = uiStrings(scope.locale);

  const field = (index: number, name: ContactFieldName, required: boolean): Markup => {
    const id = `${section.id}-${name}`;
    const label = slot(doc, scope, section.id, 'fields', index, 'label');
    if (name === 'consent') {
      return (
        <div class="s-contact__field s-contact__consent">
          <input id={id} name={name} type="checkbox" required={required} />
          <label for={id}>{label}</label>
        </div>
      );
    }
    return (
      <div class="s-contact__field">
        <label for={id}>
          {label}
          {required ? <span class="s-contact__required"> ({strings.required})</span> : null}
        </label>
        {name === 'message' ? (
          <textarea
            id={id}
            name={name}
            rows={5}
            autocomplete={AUTOCOMPLETE[name]}
            required={required}
          />
        ) : (
          <input
            id={id}
            name={name}
            type={
              name === 'email'
                ? 'email'
                : name === 'phone'
                  ? 'tel'
                  : name === 'date'
                    ? 'date'
                    : 'text'
            }
            autocomplete={AUTOCOMPLETE[name]}
            required={required}
          />
        )}
      </div>
    );
  };

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-contact">
      <div class="wrap">
        <div class="s-contact__inner">
          <div class="stack">
            <SectionHeading
              sectionId={section.id}
              level={props.headingLevel}
              text={slot(doc, scope, section.id, 'headline')}
              fallback={doc.facts.businessName}
            />
            <p>{slot(doc, scope, section.id, 'body')}</p>
          </div>
          <form class="s-contact__form" method="post" action="/api/leads" novalidate>
            {section.fields.map((entry, index) => field(index, entry.name, entry.required))}
            <div class="s-contact__turnstile" data-turnstile="1" />
            <button class="btn btn--primary" type="submit">
              {slot(doc, scope, section.id, 'submitLabel')}
            </button>
          </form>
        </div>
      </div>
    </SectionShell>
  );
}
