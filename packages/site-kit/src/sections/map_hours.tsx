import type { SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { routeHref } from '../links';
import { uiStrings } from '../ui';

/**
 * Address, opening hours and a route link — all from D1 facts.
 *
 * The visible hours and the `openingHoursSpecification` in the JSON-LD consume the **same**
 * `OpeningHours` value, because Google cross-checks them and a mismatch is a structured-data
 * penalty rather than a cosmetic inconsistency. `core/hours.ts` does the formatting and is injected
 * through `RenderContext`, so this component never parses a time.
 *
 * The map is a static image rendered to R2 at publish, wrapped in Google's `dir/?api=1` universal
 * link so it opens the native maps app on a phone. Never a Maps iframe: that is a third-party
 * origin, a consent problem and 900 kB of JavaScript.
 */
export function MapHours(props: SectionProps<SectionOf<'map_hours'>>): Markup {
  const { section, doc, scope, ctx } = props;
  const strings = uiStrings(scope.locale);
  const route = routeHref(doc);
  const address = doc.facts.address;
  const showMap = section.variant !== 'hours_only' && ctx.map !== null;

  const hours = (
    <table class="s-hours__table">
      <caption class="vh">{strings.openingHours}</caption>
      <tbody>
        {ctx.hoursDisplay.lines.map((line) => (
          <tr>
            <th scope="row">{line.daysLabel}</th>
            <td>
              {line.closed
                ? line.hoursLabel
                : line.intervals.map((interval, index) => (
                    <>
                      {index === 0 ? null : ' · '}
                      <time datetime={interval.opens}>{interval.opens}</time>
                      {'–'}
                      <time datetime={interval.closes}>{interval.closes}</time>
                    </>
                  ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-hours">
      <div class="wrap">
        <div class="s-hours__inner split">
          <div class="stack">
            <SectionHeading
              sectionId={section.id}
              level={props.headingLevel}
              text={slot(doc, scope, section.id, 'headline')}
              fallback={doc.facts.businessName}
            />
            <p>{slot(doc, scope, section.id, 'body')}</p>
            {address === null ? null : (
              <p class="s-hours__address">
                {address.line1}
                {address.line2 === null ? null : `, ${address.line2}`}
                {`, ${address.postalCode} ${address.city}`}
              </p>
            )}
            {hours}
            {ctx.hoursDisplay.byAppointmentLabel === null ? null : (
              <p class="s-hours__note">{ctx.hoursDisplay.byAppointmentLabel}</p>
            )}
            {section.showRouteCta && route !== null ? (
              <div class="cluster">
                <a class="btn btn--secondary" href={route} target="_blank" rel="noopener">
                  {slot(doc, scope, section.id, 'routeCtaLabel') || strings.routeCta}
                </a>
              </div>
            ) : null}
          </div>
          {showMap && ctx.map !== null ? (
            <div class="s-hours__map">
              {route === null ? (
                <img
                  src={ctx.map.src}
                  alt={strings.mapAlt(doc.facts.businessName)}
                  width={String(ctx.map.width)}
                  height={String(ctx.map.height)}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <a href={route} target="_blank" rel="noopener">
                  <img
                    src={ctx.map.src}
                    alt={strings.mapAlt(doc.facts.businessName)}
                    width={String(ctx.map.width)}
                    height={String(ctx.map.height)}
                    loading="lazy"
                    decoding="async"
                  />
                </a>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </SectionShell>
  );
}
