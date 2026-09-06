import type { SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { formatIsoDate, isoDateAttr, uiStrings } from '../ui';

/**
 * Testimonials — the only section whose text is not model copy.
 *
 * Bodies come from the shard's `reviews` table, injected through `RenderContext`. `source` gates
 * markup, not layout: `lint.ts` already errors when `source !== 'manual'` and
 * `facts.reviewsSource !== 'verified_platform'`, and the JSON-LD builder is the mirror image —
 * `aggregateRating` / `review` are emitted only for `verified_platform`.
 *
 * A `manual` section therefore renders the Omnibus disclosure as a real paragraph, not a tooltip:
 * UCPD Annex I 23b/23c makes an unverified consumer-review claim a per-se unfair practice, and a
 * disclosure a visitor has to hover to find is not a disclosure.
 */
export function Reviews(props: SectionProps<SectionOf<'reviews'>>): Markup {
  const { section, doc, scope, ctx } = props;
  const strings = uiStrings(scope.locale);
  const unverified = doc.facts.reviewsSource !== 'verified_platform';

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-reviews">
      <div class="wrap">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        <ul role="list" class="grid-auto s-reviews__list" style="--col:20rem">
          {ctx.reviews.map((review) => (
            <li class="s-reviews__item stack">
              <p class="s-reviews__stars">
                <span class="vh">{strings.ratingOutOfFive(review.rating)}</span>
                <span aria-hidden="true">
                  {'★'.repeat(Math.max(0, Math.min(5, review.rating)))}
                </span>
              </p>
              <blockquote>{review.body}</blockquote>
              <footer>
                {review.authorName}
                {review.publishedOn === '' ? null : (
                  <>
                    {' · '}
                    <time datetime={isoDateAttr(review.publishedOn)}>
                      {formatIsoDate(review.publishedOn, scope.locale)}
                    </time>
                  </>
                )}
              </footer>
            </li>
          ))}
        </ul>
        {unverified ? (
          <p class="u-fine s-reviews__disclosure">{strings.unverifiedReviews}</p>
        ) : null}
      </div>
    </SectionShell>
  );
}
