import type { SectionOf } from '@aibuilder/site-schema';
import { RefLink, SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { uiStrings } from '../ui';

/**
 * Booking.
 *
 * `cta_to_provider` renders one anchor to `providerLink`, which is an `external` `LinkRef` resolved
 * through the server-built allowlist. `inline_calendar` renders our own first-party form — never a
 * third-party widget. Zero third-party origins is a CSP-enforced invariant on tenant sites, not a
 * preference, so a booking iframe is not something this component could emit even if it wanted to.
 */
export function Booking(props: SectionProps<SectionOf<'booking'>>): Markup {
  const { section, doc, scope } = props;
  const strings = uiStrings(scope.locale);
  const ctaLabel = slot(doc, scope, section.id, 'ctaLabel');

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-booking">
      <div class="wrap wrap--narrow">
        <div class="s-booking__inner stack">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
          <p>{slot(doc, scope, section.id, 'body')}</p>
          {section.variant === 'cta_to_provider' && section.providerLink !== null ? (
            <div class="cluster">
              <RefLink
                target={section.providerLink}
                label={ctaLabel}
                doc={doc}
                scope={scope}
                extraClass="btn btn--primary"
              />
            </div>
          ) : (
            <form class="s-booking__form" method="post" action="/api/bookings">
              <div class="s-booking__field">
                <label for={`${section.id}-date`}>{strings.bookingDate}</label>
                <input
                  id={`${section.id}-date`}
                  name="date"
                  type="date"
                  autocomplete="off"
                  required
                />
              </div>
              <div class="s-booking__field">
                <label for={`${section.id}-email`}>{strings.bookingEmail}</label>
                <input
                  id={`${section.id}-email`}
                  name="email"
                  type="email"
                  autocomplete="email"
                  required
                />
              </div>
              <button class="btn btn--primary" type="submit">
                {ctaLabel === '' ? strings.bookingSubmit : ctaLabel}
              </button>
            </form>
          )}
        </div>
      </div>
    </SectionShell>
  );
}
