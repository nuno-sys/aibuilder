import type { Locale } from '@aibuilder/site-schema';

/**
 * Chrome strings and dates — the text on a tenant site that the model does **not** write.
 *
 * Two separate reasons for it to live here rather than in a copy slot:
 *
 *  - **Correctness.** "Skip to content", the nav's accessible name, the hours table caption and the
 *    EU review disclosure are accessibility and legal furniture. A model that paraphrases the
 *    Omnibus disclosure has produced a compliance defect, not a stylistic variation.
 *  - **Byte stability.** These strings are hashed into the page's `ETag`. `Intl` output depends on
 *    the ICU data bundled with the runtime, so a `workerd` upgrade would silently change every
 *    tenant's rendered bytes. `core/hours.ts` is table-driven for exactly this reason and the date
 *    formatter below follows it. There is no `Intl` anywhere in the render path.
 */

export interface UiStrings {
  readonly skipToContent: string;
  readonly mainMenu: string;
  readonly openMenu: string;
  readonly closeMenu: string;
  readonly openingHours: string;
  readonly closed: string;
  readonly routeCta: string;
  readonly whatsappAria: (business: string) => string;
  readonly whatsappPrefill: (business: string) => string;
  readonly whatsappLabel: string;
  readonly callAria: (business: string) => string;
  readonly ratingOutOfFive: (rating: number) => string;
  /** UCPD Annex I 23b/23c: unverified reviews must say so, visibly, in body text. */
  readonly unverifiedReviews: string;
  readonly vatId: string;
  readonly registrationId: string;
  readonly languageSwitcher: string;
  readonly legalLinks: string;
  readonly required: string;
  readonly galleryLabel: string;
  readonly beforeAfterLabel: string;
  readonly openImage: string;
  readonly closeDialog: string;
  readonly readMore: string;
  readonly publishedOn: string;
  readonly bookingDate: string;
  readonly bookingEmail: string;
  readonly bookingSubmit: string;
  readonly steps: string;
  readonly dietTagPrefix: string;
  readonly mapAlt: (business: string) => string;
}

/**
 * The six locales.
 *
 * Written out rather than machine-translated at build time: every one of these is short, is legally
 * or semantically load-bearing, and is reviewed by a human once. A translation memory would add a
 * moving part to the render path for eighteen sentences.
 */
export const UI_STRINGS: Readonly<Record<Locale, UiStrings>> = {
  nl: {
    skipToContent: 'Direct naar de inhoud',
    mainMenu: 'Hoofdmenu',
    openMenu: 'Menu openen',
    closeMenu: 'Menu sluiten',
    openingHours: 'Openingstijden',
    closed: 'Gesloten',
    routeCta: 'Route',
    whatsappAria: (business) => `Stuur een WhatsApp-bericht naar ${business}`,
    whatsappPrefill: (business) => `Hallo ${business}, ik heb een vraag`,
    whatsappLabel: 'WhatsApp',
    callAria: (business) => `Bel ${business}`,
    ratingOutOfFive: (rating) => `${rating} van de 5 sterren`,
    unverifiedReviews:
      'Deze beoordelingen zijn door de ondernemer verzameld en niet onafhankelijk geverifieerd.',
    vatId: 'Btw-nummer',
    registrationId: 'KvK-nummer',
    languageSwitcher: 'Taal',
    legalLinks: 'Juridisch',
    required: 'verplicht',
    galleryLabel: 'Fotogalerij',
    beforeAfterLabel: 'Voor en na vergelijken',
    openImage: 'Foto vergroten',
    closeDialog: 'Sluiten',
    readMore: 'Lees meer',
    publishedOn: 'Gepubliceerd op',
    bookingDate: 'Gewenste datum',
    bookingEmail: 'E-mailadres',
    bookingSubmit: 'Reservering aanvragen',
    steps: 'Stappen',
    dietTagPrefix: 'Dieet: ',
    mapAlt: (business) => `Kaart met de locatie van ${business}`,
  },
  en: {
    skipToContent: 'Skip to content',
    mainMenu: 'Main menu',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    openingHours: 'Opening hours',
    closed: 'Closed',
    routeCta: 'Directions',
    whatsappAria: (business) => `Send a WhatsApp message to ${business}`,
    whatsappPrefill: (business) => `Hello ${business}, I have a question`,
    whatsappLabel: 'WhatsApp',
    callAria: (business) => `Call ${business}`,
    ratingOutOfFive: (rating) => `${rating} out of 5 stars`,
    unverifiedReviews:
      'These reviews were collected by the business and have not been independently verified.',
    vatId: 'VAT number',
    registrationId: 'Company number',
    languageSwitcher: 'Language',
    legalLinks: 'Legal',
    required: 'required',
    galleryLabel: 'Photo gallery',
    beforeAfterLabel: 'Compare before and after',
    openImage: 'Enlarge photo',
    closeDialog: 'Close',
    readMore: 'Read more',
    publishedOn: 'Published on',
    bookingDate: 'Preferred date',
    bookingEmail: 'Email address',
    bookingSubmit: 'Request a booking',
    steps: 'Steps',
    dietTagPrefix: 'Diet: ',
    mapAlt: (business) => `Map showing the location of ${business}`,
  },
  de: {
    skipToContent: 'Zum Inhalt springen',
    mainMenu: 'Hauptmenü',
    openMenu: 'Menü öffnen',
    closeMenu: 'Menü schließen',
    openingHours: 'Öffnungszeiten',
    closed: 'Geschlossen',
    routeCta: 'Route',
    whatsappAria: (business) => `WhatsApp-Nachricht an ${business} senden`,
    whatsappPrefill: (business) => `Hallo ${business}, ich habe eine Frage`,
    whatsappLabel: 'WhatsApp',
    callAria: (business) => `${business} anrufen`,
    ratingOutOfFive: (rating) => `${rating} von 5 Sternen`,
    unverifiedReviews:
      'Diese Bewertungen wurden vom Unternehmen gesammelt und nicht unabhängig überprüft.',
    vatId: 'USt-IdNr.',
    registrationId: 'Handelsregisternummer',
    languageSwitcher: 'Sprache',
    legalLinks: 'Rechtliches',
    required: 'Pflichtfeld',
    galleryLabel: 'Fotogalerie',
    beforeAfterLabel: 'Vorher und nachher vergleichen',
    openImage: 'Foto vergrößern',
    closeDialog: 'Schließen',
    readMore: 'Mehr lesen',
    publishedOn: 'Veröffentlicht am',
    bookingDate: 'Wunschtermin',
    bookingEmail: 'E-Mail-Adresse',
    bookingSubmit: 'Termin anfragen',
    steps: 'Schritte',
    dietTagPrefix: 'Ernährung: ',
    mapAlt: (business) => `Karte mit dem Standort von ${business}`,
  },
  fr: {
    skipToContent: 'Aller au contenu',
    mainMenu: 'Menu principal',
    openMenu: 'Ouvrir le menu',
    closeMenu: 'Fermer le menu',
    openingHours: "Heures d'ouverture",
    closed: 'Fermé',
    routeCta: 'Itinéraire',
    whatsappAria: (business) => `Envoyer un message WhatsApp à ${business}`,
    whatsappPrefill: (business) => `Bonjour ${business}, j'ai une question`,
    whatsappLabel: 'WhatsApp',
    callAria: (business) => `Appeler ${business}`,
    ratingOutOfFive: (rating) => `${rating} étoiles sur 5`,
    unverifiedReviews:
      "Ces avis ont été recueillis par l'entreprise et n'ont pas été vérifiés de façon indépendante.",
    vatId: 'Numéro de TVA',
    registrationId: "Numéro d'entreprise",
    languageSwitcher: 'Langue',
    legalLinks: 'Mentions légales',
    required: 'obligatoire',
    galleryLabel: 'Galerie photos',
    beforeAfterLabel: 'Comparer avant et après',
    openImage: 'Agrandir la photo',
    closeDialog: 'Fermer',
    readMore: 'Lire la suite',
    publishedOn: 'Publié le',
    bookingDate: 'Date souhaitée',
    bookingEmail: 'Adresse e-mail',
    bookingSubmit: 'Demander une réservation',
    steps: 'Étapes',
    dietTagPrefix: 'Régime : ',
    mapAlt: (business) => `Carte indiquant l'emplacement de ${business}`,
  },
  es: {
    skipToContent: 'Ir al contenido',
    mainMenu: 'Menú principal',
    openMenu: 'Abrir menú',
    closeMenu: 'Cerrar menú',
    openingHours: 'Horario',
    closed: 'Cerrado',
    routeCta: 'Cómo llegar',
    whatsappAria: (business) => `Enviar un mensaje de WhatsApp a ${business}`,
    whatsappPrefill: (business) => `Hola ${business}, tengo una pregunta`,
    whatsappLabel: 'WhatsApp',
    callAria: (business) => `Llamar a ${business}`,
    ratingOutOfFive: (rating) => `${rating} de 5 estrellas`,
    unverifiedReviews:
      'Estas reseñas han sido recogidas por el negocio y no se han verificado de forma independiente.',
    vatId: 'NIF/CIF',
    registrationId: 'Número de registro',
    languageSwitcher: 'Idioma',
    legalLinks: 'Legal',
    required: 'obligatorio',
    galleryLabel: 'Galería de fotos',
    beforeAfterLabel: 'Comparar antes y después',
    openImage: 'Ampliar foto',
    closeDialog: 'Cerrar',
    readMore: 'Leer más',
    publishedOn: 'Publicado el',
    bookingDate: 'Fecha deseada',
    bookingEmail: 'Correo electrónico',
    bookingSubmit: 'Solicitar una reserva',
    steps: 'Pasos',
    dietTagPrefix: 'Dieta: ',
    mapAlt: (business) => `Mapa con la ubicación de ${business}`,
  },
  pt: {
    skipToContent: 'Ir para o conteúdo',
    mainMenu: 'Menu principal',
    openMenu: 'Abrir menu',
    closeMenu: 'Fechar menu',
    openingHours: 'Horário',
    closed: 'Encerrado',
    routeCta: 'Direções',
    whatsappAria: (business) => `Enviar uma mensagem de WhatsApp para ${business}`,
    whatsappPrefill: (business) => `Olá ${business}, tenho uma pergunta`,
    whatsappLabel: 'WhatsApp',
    callAria: (business) => `Ligar para ${business}`,
    ratingOutOfFive: (rating) => `${rating} de 5 estrelas`,
    unverifiedReviews:
      'Estas avaliações foram recolhidas pela empresa e não foram verificadas de forma independente.',
    vatId: 'NIF',
    registrationId: 'Número de registo',
    languageSwitcher: 'Idioma',
    legalLinks: 'Informação legal',
    required: 'obrigatório',
    galleryLabel: 'Galeria de fotos',
    beforeAfterLabel: 'Comparar antes e depois',
    openImage: 'Ampliar foto',
    closeDialog: 'Fechar',
    readMore: 'Ler mais',
    publishedOn: 'Publicado a',
    bookingDate: 'Data pretendida',
    bookingEmail: 'Endereço de e-mail',
    bookingSubmit: 'Pedir uma reserva',
    steps: 'Passos',
    dietTagPrefix: 'Dieta: ',
    mapAlt: (business) => `Mapa com a localização de ${business}`,
  },
};

/** Chrome strings for one locale. */
export function uiStrings(locale: Locale): UiStrings {
  return UI_STRINGS[locale];
}

/** Month names, long form, in the six locales. Indexed 0–11 by calendar month. */
const MONTH_NAMES: Readonly<Record<Locale, readonly string[]>> = {
  nl: [
    'januari',
    'februari',
    'maart',
    'april',
    'mei',
    'juni',
    'juli',
    'augustus',
    'september',
    'oktober',
    'november',
    'december',
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  de: [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ],
  fr: [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
  ],
  es: [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ],
  pt: [
    'janeiro',
    'fevereiro',
    'março',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ],
};

/** How each locale assembles day, month and year. */
const DATE_PATTERNS: Readonly<
  Record<Locale, (day: string, month: string, year: string) => string>
> = {
  nl: (d, m, y) => `${d} ${m} ${y}`,
  en: (d, m, y) => `${m} ${d}, ${y}`,
  de: (d, m, y) => `${d}. ${m} ${y}`,
  fr: (d, m, y) => `${d} ${m} ${y}`,
  es: (d, m, y) => `${d} de ${m} de ${y}`,
  pt: (d, m, y) => `${d} de ${m} de ${y}`,
};

/**
 * Formats the date part of an ISO-8601 instant for display.
 *
 * Table-driven, never `Intl` (§9.3). Input is sliced rather than parsed through `Date`, because
 * `Date` would apply the runtime's own zone and shift the day across a midnight boundary.
 * A value that is not `YYYY-MM-DD…` comes back as the empty string rather than as `Invalid Date`.
 */
export function formatIsoDate(iso: string, locale: Locale): string {
  if (!/^\d{4}-\d{2}-\d{2}/u.test(iso)) return '';
  const year = iso.slice(0, 4);
  const monthIndex = Number(iso.slice(5, 7)) - 1;
  const month = MONTH_NAMES[locale][monthIndex];
  if (month === undefined) return '';
  // The day is de-zero-padded: "1 mei" reads as a date, "01 mei" reads as a log line.
  const day = String(Number(iso.slice(8, 10)));
  return DATE_PATTERNS[locale](day, month, year);
}

/** The `datetime` attribute of a `<time>` element: the ISO date, nothing else. */
export function isoDateAttr(iso: string): string {
  return iso.slice(0, 10);
}

/** BCP-47 tag plus the OpenGraph locale for each of the six. */
export const LOCALE_META: Readonly<Record<Locale, { readonly tag: string; readonly og: string }>> =
  {
    nl: { tag: 'nl', og: 'nl_NL' },
    en: { tag: 'en', og: 'en_GB' },
    de: { tag: 'de', og: 'de_DE' },
    fr: { tag: 'fr', og: 'fr_FR' },
    es: { tag: 'es', og: 'es_ES' },
    pt: { tag: 'pt', og: 'pt_PT' },
  };
