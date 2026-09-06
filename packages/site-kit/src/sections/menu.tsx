import type { MenuItemTag, SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { uiStrings } from '../ui';

/**
 * Food verticals. Nested groups are containment, not recursion.
 *
 * Each group is an `<h3>` plus a `<dl>`: a menu is a name → (price, description) association list,
 * and a `<table>` would imply a grid the design does not have. Tags render as chips with a `.vh`
 * prefix, so "vegan" is announced as "Diet: vegan" rather than as a bare word after a price.
 */
const TAG_LABELS: Readonly<Record<MenuItemTag, Readonly<Record<string, string>>>> = {
  vegan: { nl: 'vegan', en: 'vegan', de: 'vegan', fr: 'végan', es: 'vegano', pt: 'vegano' },
  vegetarian: {
    nl: 'vegetarisch',
    en: 'vegetarian',
    de: 'vegetarisch',
    fr: 'végétarien',
    es: 'vegetariano',
    pt: 'vegetariano',
  },
  gluten_free: {
    nl: 'glutenvrij',
    en: 'gluten free',
    de: 'glutenfrei',
    fr: 'sans gluten',
    es: 'sin gluten',
    pt: 'sem glúten',
  },
  spicy: { nl: 'pittig', en: 'spicy', de: 'scharf', fr: 'épicé', es: 'picante', pt: 'picante' },
  new: { nl: 'nieuw', en: 'new', de: 'neu', fr: 'nouveau', es: 'nuevo', pt: 'novo' },
};

export function Menu(props: SectionProps<SectionOf<'menu'>>): Markup {
  const { section, doc, scope } = props;
  const strings = uiStrings(scope.locale);

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-menu">
      <div class="wrap">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        <div class="s-menu__groups stack">
          {section.groups.map((group, groupIndex) => (
            <div class="s-menu__group">
              <h3>{slot(doc, scope, section.id, 'groups', groupIndex, 'title')}</h3>
              <dl class="s-menu__list">
                {group.items.map((item, itemIndex) => [
                  <dt>
                    {slot(doc, scope, section.id, 'groups', groupIndex, 'items', itemIndex, 'name')}
                  </dt>,
                  <dd class="s-menu__price">
                    {slot(
                      doc,
                      scope,
                      section.id,
                      'groups',
                      groupIndex,
                      'items',
                      itemIndex,
                      'price',
                    )}
                  </dd>,
                  item.showDescription ? (
                    <dd class="s-menu__desc">
                      {slot(
                        doc,
                        scope,
                        section.id,
                        'groups',
                        groupIndex,
                        'items',
                        itemIndex,
                        'description',
                      )}
                    </dd>
                  ) : null,
                  item.tags.length === 0 ? null : (
                    <dd class="s-menu__tags">
                      <ul role="list" class="cluster">
                        {item.tags.map((tag) => (
                          <li>
                            <span class="chip">
                              <span class="vh">{strings.dietTagPrefix}</span>
                              {TAG_LABELS[tag][scope.locale] ?? tag}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  ),
                ])}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}
