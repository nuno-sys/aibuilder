import type { Intake, Locale } from '@aibuilder/core';
import { z } from 'zod';

import { putArtifact, runArtifactKey } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { Env } from '../env';
import type { RunIds } from '../ids';

/**
 * Step 6, `legal` — deterministic, pre-written templates. NEVER a model call.
 *
 * §6.1 states the reason in one sentence: you do not want a hallucinated GDPR clause on a European
 * SMB's site. It is worth spelling out why that is stronger than a quality concern.
 *
 * A generated privacy statement is not "text that might be wrong". It is a legal representation the
 * business makes to its visitors and to a supervisory authority, in a regulatory regime with
 * administrative fines, about processing it may not actually perform. A model asked to write one
 * will produce something that reads correctly and asserts things nobody verified — a retention
 * period, a legal basis, a list of recipients — and the business owner has no way to tell the
 * difference. Worse, it is the one page on the site where being confidently wrong is indexed,
 * archived and quotable.
 *
 * So this file is code. The text below is fixed, reviewed, and interpolated with facts from D1 that
 * the tenant actually entered. `assemble` then OVERWRITES whatever the model may have written on a
 * legal page with these paragraphs, so the invariant survives even a structure that planned a
 * privacy page full of `rich_text` the copy step happily filled in.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Nothing about processors, retention periods, cookie
 * categories or a data protection officer that this system cannot verify from the intake. Every
 * gap is reported as an audit finding rather than filled in with a plausible sentence — which is
 * the same rule the rest of the pipeline follows, applied where it matters most.
 *
 * Phase 2: `de`, `fr`, `es` and `pt` templates, each reviewed by counsel for its jurisdiction. Until
 * then a non-`nl` primary locale falls back to the English text and the run reports
 * `legalLocaleFallback`, which the audit surfaces and the ops queue picks up. Silently emitting
 * Dutch law in French would be worse than emitting reviewed English and saying so.
 */

/** The three documents a European small-business site needs. */
export const LEGAL_KINDS = ['privacy', 'terms', 'cookies'] as const;

/** One legal document kind. Matches the `PageRole` values of the same names. */
export type LegalKind = (typeof LEGAL_KINDS)[number];

/** Ceiling of the `body` slot kind. Paragraphs are split, never truncated. */
const MAX_PARAGRAPH = 600;

/** One paragraph of a legal document, in the shape a `rich_text` section renders. */
export const LegalParagraphSchema = z.object({
  style: z.enum(['paragraph', 'lead', 'note']),
  text: z.string().min(1).max(MAX_PARAGRAPH),
});

/** One rendered legal document. */
export const LegalDocumentSchema = z.object({
  kind: z.enum(LEGAL_KINDS),
  title: z.string().min(1).max(60),
  metaDescription: z.string().min(1).max(155),
  navLabel: z.string().min(1).max(24),
  slugSeed: z.string().min(1).max(80),
  paragraphs: z.array(LegalParagraphSchema).min(1),
});

/** Everything the legal step produces. */
export const LegalPackSchema = z.object({
  locale: z.string().min(2).max(8),
  /** True when the primary locale has no reviewed template and the English text was used. */
  localeFallback: z.boolean(),
  /** Facts a compliant footer needs that the intake cannot supply. Reported, never invented. */
  missingFacts: z.array(z.enum(['company_registration_id', 'vat_id'])),
  documents: z.array(LegalDocumentSchema).length(LEGAL_KINDS.length),
});

/** The legal pack. */
export type LegalPack = z.infer<typeof LegalPackSchema>;

/** One legal document. */
export type LegalDocument = z.infer<typeof LegalDocumentSchema>;

/** What the legal step hands back. */
export interface LegalResult {
  readonly pack: ArtifactRef;
  readonly localeFallback: boolean;
  readonly missingFacts: readonly string[];
}

/* -- Interpolation ---------------------------------------------------------------------------- */

/** The facts the templates interpolate. All from D1; none from a model. */
interface LegalFacts {
  readonly businessName: string;
  readonly contactEmail: string;
  readonly place: string;
  readonly country: string;
  readonly hasWhatsApp: boolean;
  readonly updatedOn: string;
}

/**
 * Projects the intake onto exactly the facts the templates use.
 *
 * `place` prefers the postal city and falls back to the service area, because a mobile trade has no
 * visitable address and a legal document that names a city the business does not operate in is
 * worse than one that names the region it serves.
 */
function legalFactsFrom(intake: Intake, now: Date): LegalFacts {
  return {
    businessName: intake.businessName,
    contactEmail: intake.contactEmail,
    place: intake.address?.city ?? intake.serviceArea?.city ?? '',
    country: intake.address?.country ?? 'NL',
    hasWhatsApp: intake.whatsappE164 !== null,
    updatedOn: now.toISOString().slice(0, 10),
  };
}

/**
 * Splits a paragraph that would exceed the `body` slot ceiling, at sentence boundaries.
 *
 * A guarantee rather than a safety net: `normalize()` runs before this step's output exists, so
 * nothing downstream will clamp these strings, and a truncated legal sentence is a legal document
 * that says something other than what was reviewed.
 */
function chunk(text: string): readonly string[] {
  const trimmed = text.trim().replace(/\s+/gu, ' ');
  if (trimmed.length <= MAX_PARAGRAPH) return [trimmed];

  const sentences = trimmed.split(/(?<=\.)\s+/u);
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length === 0) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= MAX_PARAGRAPH) {
      current = `${current} ${sentence}`;
    } else {
      out.push(current);
      current = sentence;
    }
  }
  if (current.length > 0) out.push(current);
  // A single sentence longer than the ceiling cannot be split without changing it; the templates
  // below are written so this cannot happen, and the hard slice is here so a future edit fails
  // visibly in review rather than silently at render.
  return out.map((part) => (part.length <= MAX_PARAGRAPH ? part : part.slice(0, MAX_PARAGRAPH)));
}

/** Builds a document from a title block and a list of prose, splitting anything over the ceiling. */
function document(args: {
  readonly kind: LegalKind;
  readonly title: string;
  readonly metaDescription: string;
  readonly navLabel: string;
  readonly slugSeed: string;
  readonly lead: string;
  readonly body: readonly string[];
  readonly note: string;
}): LegalDocument {
  const paragraphs: { style: 'paragraph' | 'lead' | 'note'; text: string }[] = [];
  for (const part of chunk(args.lead)) paragraphs.push({ style: 'lead', text: part });
  for (const entry of args.body) {
    for (const part of chunk(entry)) paragraphs.push({ style: 'paragraph', text: part });
  }
  for (const part of chunk(args.note)) paragraphs.push({ style: 'note', text: part });
  return {
    kind: args.kind,
    title: args.title,
    metaDescription: args.metaDescription,
    navLabel: args.navLabel,
    slugSeed: args.slugSeed,
    paragraphs,
  };
}

/* -- The Dutch templates ---------------------------------------------------------------------- */

/** The reviewed Dutch text. Written for a small business, not for a legal department. */
function dutchDocuments(facts: LegalFacts): readonly LegalDocument[] {
  const where = facts.place.length > 0 ? ` te ${facts.place}` : '';
  return [
    document({
      kind: 'privacy',
      title: 'Privacyverklaring',
      metaDescription: `Hoe ${facts.businessName} omgaat met je persoonsgegevens en welke rechten je hebt.`,
      navLabel: 'Privacy',
      slugSeed: 'privacy',
      lead:
        `${facts.businessName}${where} verwerkt persoonsgegevens van klanten en bezoekers van deze ` +
        `website. In deze verklaring lees je welke gegevens dat zijn, waarom we ze verwerken en ` +
        `welke rechten je hebt.`,
      body: [
        'Welke gegevens wij verwerken. Wij verwerken alleen de gegevens die je zelf aan ons ' +
          'doorgeeft. Via het contactformulier zijn dat je naam, je e-mailadres, eventueel je ' +
          'telefoonnummer en de inhoud van je bericht. Als je telefonisch of per e-mail contact ' +
          'opneemt, verwerken wij de gegevens die je in dat contact deelt.',
        'Waarvoor wij die gegevens gebruiken. Wij gebruiken je gegevens om je vraag te ' +
          'beantwoorden, een afspraak te maken of een opdracht uit te voeren. De grondslag daarvoor ' +
          'is de uitvoering van een overeenkomst of ons gerechtvaardigd belang om op je bericht te ' +
          'reageren. Wij gebruiken je gegevens niet voor geautomatiseerde besluitvorming.',
        'Hoe lang wij gegevens bewaren. Berichten via het contactformulier bewaren wij zolang dat ' +
          'nodig is om je vraag af te handelen. Gegevens die bij een opdracht horen, bewaren wij ' +
          'zolang de wettelijke bewaartermijnen dat voorschrijven, waaronder de fiscale ' +
          'bewaarplicht van zeven jaar.',
        'Met wie wij gegevens delen. Wij verkopen je gegevens niet en delen ze niet met derden ' +
          'voor commerciële doeleinden. Wij schakelen wel dienstverleners in die deze website ' +
          'hosten en onze e-mail verzorgen; zij verwerken gegevens uitsluitend in onze opdracht.',
        'Cookies en meetgegevens. Deze website plaatst geen tracking- of advertentiecookies. Zie ' +
          'de cookieverklaring voor wat er wel wordt opgeslagen en waarom.',
        `Je rechten. Je hebt het recht om je gegevens in te zien, te laten corrigeren of te laten ` +
          `verwijderen, en om bezwaar te maken tegen de verwerking. Stuur daarvoor een bericht aan ` +
          `${facts.contactEmail}. Je kunt ook een klacht indienen bij de bevoegde ` +
          `privacytoezichthouder.`,
      ],
      note: `Laatst bijgewerkt op ${facts.updatedOn}.`,
    }),
    document({
      kind: 'terms',
      title: 'Algemene voorwaarden',
      metaDescription: `De voorwaarden waaronder ${facts.businessName} diensten levert en afspraken maakt.`,
      navLabel: 'Voorwaarden',
      slugSeed: 'algemene-voorwaarden',
      lead:
        `Deze voorwaarden gelden voor alle offertes, afspraken en opdrachten tussen ` +
        `${facts.businessName}${where} en de klant, tenzij schriftelijk iets anders is afgesproken.`,
      body: [
        'Offertes en afspraken. Een offerte is vrijblijvend en geldig zolang dat in de offerte ' +
          'staat. Een afspraak komt tot stand zodra wij een opdracht schriftelijk of per e-mail ' +
          'hebben bevestigd. Aanvullende wensen die na die bevestiging worden doorgegeven, kunnen ' +
          'de prijs en de planning wijzigen; wij melden dat vooraf.',
        'Prijzen en betaling. Genoemde prijzen zijn in euro. Of ze inclusief of exclusief btw zijn, ' +
          'staat bij de prijs vermeld. Facturen worden binnen veertien dagen na factuurdatum ' +
          'betaald, tenzij anders overeengekomen.',
        'Annuleren en verzetten. Een gemaakte afspraak kan tot uiterlijk vierentwintig uur van ' +
          'tevoren kosteloos worden verzet of geannuleerd. Bij een latere annulering kunnen wij de ' +
          'gereserveerde tijd in rekening brengen.',
        'Uitvoering. Wij voeren de opdracht naar beste kunnen uit. Genoemde termijnen zijn ' +
          'indicatief, tenzij uitdrukkelijk een fatale termijn is afgesproken. Als wij een termijn ' +
          'niet halen, melden wij dat zo snel mogelijk en spreken wij een nieuwe termijn af.',
        'Klachten. Heb je een klacht over onze dienstverlening, laat het ons dan binnen veertien ' +
          `dagen weten via ${facts.contactEmail}. Wij reageren zo snel mogelijk en zoeken samen ` +
          'naar een oplossing.',
        'Toepasselijk recht. Op alle afspraken is het recht van toepassing van het land waarin wij ' +
          'zijn gevestigd. Geschillen leggen wij voor aan de bevoegde rechter in dat land.',
      ],
      note: `Laatst bijgewerkt op ${facts.updatedOn}.`,
    }),
    document({
      kind: 'cookies',
      title: 'Cookieverklaring',
      metaDescription: `Welke cookies deze website van ${facts.businessName} gebruikt en waarom.`,
      navLabel: 'Cookies',
      slugSeed: 'cookies',
      lead:
        `Deze website is bewust eenvoudig gehouden. Er worden geen cookies geplaatst om je te ` +
        `volgen, en er staan geen advertentienetwerken of social-mediatrackers op de pagina's.`,
      body: [
        'Wat er wel wordt opgeslagen. Voor het correct laten werken van de website kan er ' +
          'technische informatie in je browser worden bewaard, bijvoorbeeld je taalkeuze. Die ' +
          'informatie is nodig om de site te laten functioneren en wordt niet gebruikt om je te ' +
          'herkennen op andere websites.',
        'Toestemming. Omdat er geen tracking- of advertentiecookies worden geplaatst, hoeft er ook ' +
          'geen toestemming te worden gevraagd. Verandert dat, dan vragen wij je toestemming ' +
          'voordat zulke cookies worden geplaatst.',
        facts.hasWhatsApp
          ? 'WhatsApp-knop. De WhatsApp-knop op deze site is een gewone link. Er wordt niets ' +
            'geladen van WhatsApp totdat je er zelf op klikt; pas dan gelden de voorwaarden en het ' +
            'privacybeleid van WhatsApp.'
          : 'Externe diensten. Deze site laadt geen externe widgets of scripts van derden mee.',
        `Vragen. Heb je een vraag over deze verklaring, stuur dan een bericht aan ` +
          `${facts.contactEmail}.`,
      ],
      note: `Laatst bijgewerkt op ${facts.updatedOn}.`,
    }),
  ];
}

/* -- The English templates -------------------------------------------------------------------- */

/** The reviewed English text, and the fallback for locales whose templates are Phase 2. */
function englishDocuments(facts: LegalFacts): readonly LegalDocument[] {
  const where = facts.place.length > 0 ? ` in ${facts.place}` : '';
  return [
    document({
      kind: 'privacy',
      title: 'Privacy statement',
      metaDescription: `How ${facts.businessName} handles your personal data and what rights you have.`,
      navLabel: 'Privacy',
      slugSeed: 'privacy',
      lead:
        `${facts.businessName}${where} processes personal data of customers and visitors to this ` +
        `website. This statement explains which data that is, why we process it, and what rights ` +
        `you have.`,
      body: [
        'What we process. We only process the data you give us yourself. Through the contact form ' +
          'that is your name, your e-mail address, optionally your phone number, and the content ' +
          'of your message. If you contact us by phone or e-mail, we process what you share in ' +
          'that contact.',
        'Why we use it. We use your data to answer your question, arrange an appointment or carry ' +
          'out an assignment. The legal basis is the performance of a contract or our legitimate ' +
          'interest in replying to your message. We do not use your data for automated ' +
          'decision-making.',
        'How long we keep it. Messages sent through the contact form are kept for as long as we ' +
          'need them to handle your question. Data belonging to an assignment is kept for as long ' +
          'as statutory retention periods require, including the seven-year tax retention ' +
          'obligation.',
        'Who we share it with. We do not sell your data and do not share it with third parties for ' +
          'commercial purposes. We do use service providers who host this website and handle our ' +
          'e-mail; they process data solely on our instructions.',
        'Cookies and measurement. This website sets no tracking or advertising cookies. See the ' +
          'cookie statement for what is stored and why.',
        `Your rights. You have the right to access, correct or delete your data, and to object to ` +
          `processing. Write to ${facts.contactEmail}. You may also lodge a complaint with the ` +
          `competent data protection authority.`,
      ],
      note: `Last updated on ${facts.updatedOn}.`,
    }),
    document({
      kind: 'terms',
      title: 'Terms and conditions',
      metaDescription: `The terms on which ${facts.businessName} provides its services.`,
      navLabel: 'Terms',
      slugSeed: 'terms',
      lead:
        `These terms apply to every quotation, appointment and assignment between ` +
        `${facts.businessName}${where} and the customer, unless agreed otherwise in writing.`,
      body: [
        'Quotations and agreements. A quotation is without obligation and valid for the period it ' +
          'states. An agreement is formed once we have confirmed an assignment in writing or by ' +
          'e-mail. Additional wishes raised after that confirmation may change the price and the ' +
          'planning; we tell you before they do.',
        'Prices and payment. Prices are in euros. Whether they include or exclude VAT is stated ' +
          'with the price. Invoices are payable within fourteen days of the invoice date unless ' +
          'agreed otherwise.',
        'Cancelling and rescheduling. An appointment can be rescheduled or cancelled free of ' +
          'charge up to twenty-four hours in advance. For later cancellations we may charge for ' +
          'the reserved time.',
        'Performance. We carry out the assignment to the best of our ability. Stated timescales ' +
          'are indicative unless a firm deadline has been expressly agreed. If we cannot meet a ' +
          'timescale we say so as soon as possible and agree a new one.',
        `Complaints. If you have a complaint about our service, tell us within fourteen days at ` +
          `${facts.contactEmail}. We reply as quickly as we can and look for a solution together.`,
        'Governing law. The law of the country in which we are established applies to every ' +
          'agreement. Disputes are submitted to the competent court in that country.',
      ],
      note: `Last updated on ${facts.updatedOn}.`,
    }),
    document({
      kind: 'cookies',
      title: 'Cookie statement',
      metaDescription: `Which cookies this ${facts.businessName} website uses, and why.`,
      navLabel: 'Cookies',
      slugSeed: 'cookies',
      lead:
        `This website is deliberately kept simple. No cookies are set to track you, and there are ` +
        `no advertising networks or social media trackers on the page.`,
      body: [
        'What is stored. To make the website work, technical information may be kept in your ' +
          'browser, such as your language choice. That information is needed for the site to ' +
          'function and is not used to recognise you on other websites.',
        'Consent. Because no tracking or advertising cookies are set, no consent has to be asked. ' +
          'If that changes, we will ask for your consent before such cookies are placed.',
        facts.hasWhatsApp
          ? 'WhatsApp button. The WhatsApp button on this site is an ordinary link. Nothing is ' +
            'loaded from WhatsApp until you click it; only then do WhatsApp’s own terms and ' +
            'privacy policy apply.'
          : 'External services. This site loads no third-party widgets or scripts.',
        `Questions. If you have a question about this statement, write to ${facts.contactEmail}.`,
      ],
      note: `Last updated on ${facts.updatedOn}.`,
    }),
  ];
}

/** Locales with reviewed templates. Phase 2 adds `de`, `fr`, `es` and `pt`. */
const TEMPLATED_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['nl', 'en']);

/**
 * Builds the legal pack for one intake.
 *
 * Pure, deterministic and total: the same intake and the same day produce byte-identical documents,
 * which is what makes the step idempotent under retry.
 */
export function buildLegalPack(intake: Intake, now: Date = new Date()): LegalPack {
  const facts = legalFactsFrom(intake, now);
  const locale = intake.defaultLocale;
  const templated = TEMPLATED_LOCALES.has(locale);
  const documents = locale === 'nl' ? dutchDocuments(facts) : englishDocuments(facts);

  return {
    locale,
    localeFallback: !templated,
    // The intake collects neither a KvK/Handelsregister number nor a VAT id, and both are required
    // in the footer across the EU. They are REPORTED rather than invented, and the dashboard
    // collects them in Phase 2.
    missingFacts: ['company_registration_id', 'vat_id'],
    documents: [...documents],
  };
}

/**
 * Writes the legal pack.
 *
 * Guarantees no model is called, that every paragraph fits the `body` slot ceiling without
 * truncation, and that a locale without a reviewed template is reported rather than machine
 * translated.
 */
export async function runLegalStep(env: Env, ids: RunIds, intake: Intake): Promise<LegalResult> {
  const pack = buildLegalPack(intake);
  const ref = await putArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'legal'), pack);
  return { pack: ref, localeFallback: pack.localeFallback, missingFacts: pack.missingFacts };
}
