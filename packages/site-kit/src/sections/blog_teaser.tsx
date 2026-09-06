import type { SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { formatIsoDate, isoDateAttr } from '../ui';

/**
 * Teaser for the generated blog.
 *
 * Dates go through the table-driven formatter, never `Intl`: ICU data differs between the runtime
 * and the CI runner, and a formatted date lands in the HTML that every tenant's `ETag` is computed
 * over. `lint.ts` already errors when the site has no posts, so an empty list here is a
 * configuration this section never reaches in a published document.
 */
export function BlogTeaser(props: SectionProps<SectionOf<'blog_teaser'>>): Markup {
  const { section, doc, scope } = props;
  const posts = doc.blog.filter((post) => post.locale === scope.locale);

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-blog">
      <div class="wrap">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        <ul role="list" class="grid-auto s-blog__list" style="--col:20rem">
          {posts.map((post) => (
            <li class="s-blog__item">
              <article class="stack">
                <h3>
                  <a href={post.path}>{post.title}</a>
                </h3>
                <time datetime={isoDateAttr(post.publishedAt)}>
                  {formatIsoDate(post.publishedAt, scope.locale)}
                </time>
                {section.showExcerpts ? <p class="s-blog__excerpt">{post.excerpt}</p> : null}
              </article>
            </li>
          ))}
        </ul>
      </div>
    </SectionShell>
  );
}
