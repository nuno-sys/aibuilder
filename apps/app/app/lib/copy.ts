/**
 * Every string the dashboard renders, in the two locales this phase ships.
 *
 * ONE FILE, NOT A LIBRARY. The same decision `apps/marketing/src/lib/copy.ts` made and for the same
 * reasons: an i18n runtime buys plural rules and message extraction, neither of which this surface
 * needs, at the cost of a bundle and a build step. A typed object with two implementations is
 * checked by the compiler — adding a key to `nl` and forgetting it in `en` is a compile error, which
 * is the failure a translation pipeline is usually bought to catch.
 *
 * DUTCH IS THE SOURCE and English is the fallback, because the product's market is Dutch-speaking
 * small businesses and the error copy in `apps/api` is written the same way round (`message` /
 * `messageEn`).
 *
 * TONE. The rule the onboarding modal set and this inherits: never a destructive default, never a
 * question about work the user has not lost, and never a progress claim that is not true. "Je
 * wijzigingen zijn opgeslagen" is only ever shown after the write returned.
 */

/** The locales the dashboard renders. A subset of `@aibuilder/core`'s six. */
export type UiLocale = 'nl' | 'en';

export interface Copy {
  readonly common: {
    readonly skipToContent: string;
    readonly save: string;
    readonly saved: string;
    readonly saving: string;
    readonly cancel: string;
    readonly undo: string;
    readonly redo: string;
    readonly close: string;
    readonly retry: string;
    readonly loading: string;
    readonly signOut: string;
  };
  readonly nav: {
    readonly label: string;
    readonly dashboard: string;
    readonly billing: string;
    readonly settings: string;
    readonly overview: string;
    readonly editor: string;
    readonly media: string;
    readonly domain: string;
  };
  readonly login: {
    readonly title: string;
    readonly intro: string;
    readonly emailLabel: string;
    readonly emailHint: string;
    readonly submit: string;
    readonly sent: string;
    readonly sentDetail: string;
    readonly invalidEmail: string;
    readonly verifyTitle: string;
    readonly verifyIntro: string;
    readonly verifyContinue: string;
    readonly verifyExpired: string;
    readonly verifyExpiredDetail: string;
  };
  readonly dashboard: {
    readonly title: string;
    readonly empty: string;
    readonly emptyAction: string;
    readonly trialEndsOn: string;
    readonly notPublished: string;
    readonly openEditor: string;
    readonly viewSite: string;
  };
  readonly site: {
    readonly overviewTitle: string;
    readonly statusLabel: string;
    readonly addressLabel: string;
    readonly indexLabel: string;
    readonly indexNoindex: string;
    readonly indexEligible: string;
    readonly indexIndexable: string;
    readonly lastActivity: string;
    readonly noActivity: string;
    readonly regenerate: string;
    readonly regenerateHint: string;
    readonly regenerateStarted: string;
    readonly regenerateBlocked: string;
    readonly regenerateQuota: string;
    readonly regenerateFailed: string;
  };
  readonly editor: {
    readonly title: string;
    readonly panelTitle: string;
    readonly openPanel: string;
    readonly closePanel: string;
    readonly tabTheme: string;
    readonly tabContent: string;
    readonly tabPages: string;
    readonly pageLabel: string;
    readonly localeLabel: string;
    readonly previewLabel: string;
    readonly previewUnavailable: string;
    readonly colourScheme: string;
    readonly palette: string;
    readonly accentHue: string;
    readonly typeScale: string;
    readonly radius: string;
    readonly density: string;
    readonly motion: string;
    readonly mode: string;
    readonly themeApplied: string;
    readonly moveUp: string;
    readonly moveDown: string;
    readonly inNav: string;
    readonly hideFromSearch: string;
    readonly sectionsHeading: string;
    readonly noDraft: string;
    readonly noDraftDetail: string;
    readonly staleTitle: string;
    readonly staleDetail: string;
    readonly staleDiscard: string;
    readonly saveFailed: string;
    readonly saveConflict: string;
    readonly paywall: string;
    readonly paywallAction: string;
  };
  readonly media: {
    readonly title: string;
    readonly empty: string;
    readonly altLabel: string;
    readonly altHint: string;
    readonly dimensions: string;
    readonly altSaved: string;
  };
  readonly billing: {
    readonly title: string;
    readonly planLabel: string;
    readonly statusLabel: string;
    readonly renewsOn: string;
    readonly endsOn: string;
    readonly manage: string;
    readonly manageHint: string;
    readonly invoices: string;
    readonly noInvoices: string;
    readonly invoiceDate: string;
    readonly invoiceAmount: string;
    readonly invoiceStatus: string;
    readonly invoiceDownload: string;
    readonly ownerOnly: string;
    readonly portalFailed: string;
  };
  readonly domain: {
    readonly title: string;
    readonly currentLabel: string;
    readonly phaseTitle: string;
    readonly phaseDetail: string;
    readonly attachedTitle: string;
    readonly attachedEmpty: string;
  };
  readonly settings: {
    readonly title: string;
    readonly emailLabel: string;
    readonly verifiedYes: string;
    readonly verifiedNo: string;
    readonly organisationLabel: string;
    readonly roleLabel: string;
    readonly signOutEverywhere: string;
  };
  readonly errors: {
    readonly generic: string;
    readonly notFound: string;
    readonly notFoundDetail: string;
    readonly suspended: string;
  };
}

const NL: Copy = {
  common: {
    skipToContent: 'Naar de inhoud',
    save: 'Opslaan',
    saved: 'Opgeslagen',
    saving: 'Bezig met opslaan…',
    cancel: 'Annuleren',
    undo: 'Ongedaan maken',
    redo: 'Opnieuw',
    close: 'Sluiten',
    retry: 'Opnieuw proberen',
    loading: 'Laden…',
    signOut: 'Uitloggen',
  },
  nav: {
    label: 'Hoofdnavigatie',
    dashboard: 'Mijn sites',
    billing: 'Facturatie',
    settings: 'Instellingen',
    overview: 'Overzicht',
    editor: 'Editor',
    media: "Foto's",
    domain: 'Domein',
  },
  login: {
    title: 'Inloggen',
    intro: 'We sturen je een inloglink. Je hoeft geen wachtwoord te onthouden.',
    emailLabel: 'E-mailadres',
    emailHint: 'Het adres waarmee je je site hebt aangemaakt.',
    submit: 'Stuur me een inloglink',
    sent: 'Check je e-mail',
    sentDetail:
      'Als er een account bij dit adres hoort, staat er nu een inloglink in je inbox. De link is 15 minuten geldig.',
    invalidEmail: 'Vul een geldig e-mailadres in.',
    verifyTitle: 'Doorgaan met inloggen',
    verifyIntro: 'Klik op de knop om in te loggen op je dashboard.',
    verifyContinue: 'Inloggen',
    verifyExpired: 'Deze link werkt niet meer',
    verifyExpiredDetail:
      'Inloglinks zijn 15 minuten geldig en kunnen maar één keer worden gebruikt. Vraag een nieuwe aan.',
  },
  dashboard: {
    title: 'Mijn sites',
    empty: 'Je hebt nog geen site.',
    emptyAction: 'Maak je eerste site',
    trialEndsOn: 'Proefperiode loopt tot',
    notPublished: 'Nog niet gepubliceerd',
    openEditor: 'Bewerken',
    viewSite: 'Bekijk site',
  },
  site: {
    overviewTitle: 'Overzicht',
    statusLabel: 'Status',
    addressLabel: 'Adres',
    indexLabel: 'Vindbaar in Google',
    indexNoindex: 'Nog niet — je site is afgeschermd voor zoekmachines.',
    indexEligible: 'Klaar om te worden opgenomen.',
    indexIndexable: 'Ja, zoekmachines mogen je site opnemen.',
    lastActivity: 'Laatste activiteit',
    noActivity: 'Nog geen activiteit.',
    regenerate: 'Site opnieuw laten maken',
    regenerateHint: 'Je kunt dit twee keer per 30 dagen doen. Je huidige site blijft online.',
    regenerateStarted: 'We zijn begonnen. Je site blijft ondertussen gewoon online.',
    regenerateBlocked:
      'Je abonnement is niet actief. Werk je betaalgegevens bij om verder te gaan.',
    regenerateQuota: 'Je hebt je twee regeneraties van deze 30 dagen gebruikt.',
    regenerateFailed: 'Dat is niet gelukt. Probeer het over een paar minuten opnieuw.',
  },
  editor: {
    title: 'Editor',
    panelTitle: 'Bewerken',
    openPanel: 'Bewerkpaneel openen',
    closePanel: 'Bewerkpaneel sluiten',
    tabTheme: 'Kleuren',
    tabContent: 'Teksten',
    tabPages: "Pagina's",
    pageLabel: 'Pagina',
    localeLabel: 'Taal',
    previewLabel: 'Voorbeeld van je site',
    previewUnavailable: 'Het voorbeeld kan nu niet worden geladen.',
    colourScheme: 'Kleurenschema',
    palette: 'Palet',
    accentHue: 'Accentkleur',
    typeScale: 'Letterschaal',
    radius: 'Ronding',
    density: 'Ruimte',
    motion: 'Beweging',
    mode: 'Licht of donker',
    themeApplied: 'Kleuren bijgewerkt',
    moveUp: 'Naar boven',
    moveDown: 'Naar beneden',
    inNav: 'In het menu',
    hideFromSearch: 'Verbergen voor zoekmachines',
    sectionsHeading: 'Onderdelen op deze pagina',
    noDraft: 'Er is nog geen versie om te bewerken',
    noDraftDetail: 'Zodra je site klaar is, kun je hem hier aanpassen.',
    staleTitle: 'Je site is opnieuw gemaakt',
    staleDetail:
      'Er is een nieuwe versie van je site. Je onopgeslagen aanpassingen horen bij de oude versie.',
    staleDiscard: 'Aanpassingen verwijderen en verder met de nieuwe versie',
    saveFailed: 'Deze aanpassing is niet opgeslagen.',
    saveConflict:
      'Je site is in een ander tabblad aangepast. Herlaad deze pagina om verder te werken.',
    paywall: 'Je abonnement is niet actief, dus aanpassingen worden niet opgeslagen.',
    paywallAction: 'Betaalgegevens bijwerken',
  },
  media: {
    title: "Foto's",
    empty: 'Er staan nog geen foto’s op deze site.',
    altLabel: 'Omschrijving voor schermlezers',
    altHint: 'Beschrijf kort wat er op de foto staat. Laat leeg als de foto puur decoratief is.',
    dimensions: 'Formaat',
    altSaved: 'Omschrijving opgeslagen',
  },
  billing: {
    title: 'Facturatie',
    planLabel: 'Abonnement',
    statusLabel: 'Status',
    renewsOn: 'Verlengt op',
    endsOn: 'Loopt af op',
    manage: 'Betaalgegevens en abonnement beheren',
    manageHint: 'Je gaat naar de beveiligde omgeving van Stripe.',
    invoices: 'Facturen',
    noInvoices: 'Er zijn nog geen facturen.',
    invoiceDate: 'Datum',
    invoiceAmount: 'Bedrag',
    invoiceStatus: 'Status',
    invoiceDownload: 'Bekijk factuur',
    ownerOnly: 'Alleen de eigenaar van het account kan de facturatie beheren.',
    portalFailed: 'We konden de betaalomgeving niet openen. Probeer het zo opnieuw.',
  },
  domain: {
    title: 'Domein',
    currentLabel: 'Huidig adres',
    phaseTitle: 'Een eigen domein koppelen kan nog niet',
    phaseDetail:
      'Je site draait op het adres hierboven en dat blijft werken. Een eigen domein (bijvoorbeeld www.jouwbedrijf.nl) koppelen komt in een volgende versie; we hebben er nog niets voor klaarstaan, en we zeggen het liever eerlijk dan dat je op een knop drukt die niets doet.',
    attachedTitle: 'Gekoppelde domeinen',
    attachedEmpty: 'Er is nog geen eigen domein gekoppeld.',
  },
  settings: {
    title: 'Instellingen',
    emailLabel: 'E-mailadres',
    verifiedYes: 'Bevestigd',
    verifiedNo: 'Nog niet bevestigd',
    organisationLabel: 'Organisatie',
    roleLabel: 'Jouw rol',
    signOutEverywhere: 'Overal uitloggen',
  },
  errors: {
    generic: 'Er ging iets mis. Probeer het opnieuw.',
    notFound: 'Niet gevonden',
    notFoundDetail: 'Deze pagina bestaat niet, of je hebt er geen toegang toe.',
    suspended: 'Dit account is geblokkeerd. Neem contact met ons op.',
  },
};

const EN: Copy = {
  common: {
    skipToContent: 'Skip to content',
    save: 'Save',
    saved: 'Saved',
    saving: 'Saving…',
    cancel: 'Cancel',
    undo: 'Undo',
    redo: 'Redo',
    close: 'Close',
    retry: 'Try again',
    loading: 'Loading…',
    signOut: 'Sign out',
  },
  nav: {
    label: 'Main navigation',
    dashboard: 'My sites',
    billing: 'Billing',
    settings: 'Settings',
    overview: 'Overview',
    editor: 'Editor',
    media: 'Photos',
    domain: 'Domain',
  },
  login: {
    title: 'Sign in',
    intro: 'We will e-mail you a sign-in link. There is no password to remember.',
    emailLabel: 'E-mail address',
    emailHint: 'The address you created your site with.',
    submit: 'E-mail me a sign-in link',
    sent: 'Check your e-mail',
    sentDetail:
      'If an account exists for this address, a sign-in link is on its way. The link is valid for 15 minutes.',
    invalidEmail: 'Enter a valid e-mail address.',
    verifyTitle: 'Continue signing in',
    verifyIntro: 'Press the button to sign in to your dashboard.',
    verifyContinue: 'Sign in',
    verifyExpired: 'This link no longer works',
    verifyExpiredDetail:
      'Sign-in links are valid for 15 minutes and can be used once. Request a new one.',
  },
  dashboard: {
    title: 'My sites',
    empty: 'You do not have a site yet.',
    emptyAction: 'Create your first site',
    trialEndsOn: 'Trial runs until',
    notPublished: 'Not published yet',
    openEditor: 'Edit',
    viewSite: 'View site',
  },
  site: {
    overviewTitle: 'Overview',
    statusLabel: 'Status',
    addressLabel: 'Address',
    indexLabel: 'Findable in Google',
    indexNoindex: 'Not yet — your site is hidden from search engines.',
    indexEligible: 'Ready to be listed.',
    indexIndexable: 'Yes, search engines may list your site.',
    lastActivity: 'Recent activity',
    noActivity: 'Nothing has happened yet.',
    regenerate: 'Rebuild my site',
    regenerateHint: 'Twice per 30 days. Your current site stays online while we work.',
    regenerateStarted: 'We have started. Your site stays online in the meantime.',
    regenerateBlocked: 'Your subscription is not active. Update your payment details to continue.',
    regenerateQuota: 'You have used both rebuilds for this 30-day period.',
    regenerateFailed: 'That did not work. Try again in a few minutes.',
  },
  editor: {
    title: 'Editor',
    panelTitle: 'Edit',
    openPanel: 'Open the edit panel',
    closePanel: 'Close the edit panel',
    tabTheme: 'Colours',
    tabContent: 'Text',
    tabPages: 'Pages',
    pageLabel: 'Page',
    localeLabel: 'Language',
    previewLabel: 'Preview of your site',
    previewUnavailable: 'The preview cannot be loaded right now.',
    colourScheme: 'Colour scheme',
    palette: 'Palette',
    accentHue: 'Accent colour',
    typeScale: 'Type scale',
    radius: 'Corners',
    density: 'Spacing',
    motion: 'Motion',
    mode: 'Light or dark',
    themeApplied: 'Colours updated',
    moveUp: 'Move up',
    moveDown: 'Move down',
    inNav: 'In the menu',
    hideFromSearch: 'Hide from search engines',
    sectionsHeading: 'Sections on this page',
    noDraft: 'There is no version to edit yet',
    noDraftDetail: 'As soon as your site is built you can change it here.',
    staleTitle: 'Your site was rebuilt',
    staleDetail:
      'There is a newer version of your site. Your unsaved changes belong to the old one.',
    staleDiscard: 'Discard my changes and continue with the new version',
    saveFailed: 'That change was not saved.',
    saveConflict: 'Your site was changed in another tab. Reload this page to continue.',
    paywall: 'Your subscription is not active, so changes are not being saved.',
    paywallAction: 'Update payment details',
  },
  media: {
    title: 'Photos',
    empty: 'There are no photos on this site yet.',
    altLabel: 'Description for screen readers',
    altHint: 'Briefly describe what is in the photo. Leave empty if it is purely decorative.',
    dimensions: 'Size',
    altSaved: 'Description saved',
  },
  billing: {
    title: 'Billing',
    planLabel: 'Plan',
    statusLabel: 'Status',
    renewsOn: 'Renews on',
    endsOn: 'Ends on',
    manage: 'Manage payment details and subscription',
    manageHint: 'This takes you to Stripe’s secure environment.',
    invoices: 'Invoices',
    noInvoices: 'There are no invoices yet.',
    invoiceDate: 'Date',
    invoiceAmount: 'Amount',
    invoiceStatus: 'Status',
    invoiceDownload: 'View invoice',
    ownerOnly: 'Only the account owner can manage billing.',
    portalFailed: 'We could not open the payment environment. Try again shortly.',
  },
  domain: {
    title: 'Domain',
    currentLabel: 'Current address',
    phaseTitle: 'Connecting your own domain is not possible yet',
    phaseDetail:
      'Your site runs on the address above and will keep working. Connecting your own domain (for example www.yourbusiness.com) is coming in a later version; nothing is in place for it yet, and we would rather say so than give you a button that does nothing.',
    attachedTitle: 'Connected domains',
    attachedEmpty: 'No custom domain has been connected yet.',
  },
  settings: {
    title: 'Settings',
    emailLabel: 'E-mail address',
    verifiedYes: 'Confirmed',
    verifiedNo: 'Not confirmed yet',
    organisationLabel: 'Organisation',
    roleLabel: 'Your role',
    signOutEverywhere: 'Sign out everywhere',
  },
  errors: {
    generic: 'Something went wrong. Try again.',
    notFound: 'Not found',
    notFoundDetail: 'This page does not exist, or you do not have access to it.',
    suspended: 'This account is suspended. Please contact us.',
  },
};

/** Returns the copy for a locale, defaulting to Dutch. */
export function copyFor(locale: UiLocale): Copy {
  return locale === 'en' ? EN : NL;
}

/**
 * Picks the UI locale for a request.
 *
 * The signed-in user's stored `locale` wins, because it is a preference they set; `Accept-Language`
 * is only consulted for a visitor who has not signed in yet. Anything unrecognised is Dutch.
 *
 * This is a UI decision and never a routing one. Architecture §7.3 is explicit that tenant pages
 * must not redirect on `Accept-Language`; this is the dashboard, which is behind a session and is
 * not indexed, so choosing a language here costs nothing.
 */
export function uiLocaleFor(args: {
  readonly userLocale?: string | undefined;
  readonly acceptLanguage?: string | null;
}): UiLocale {
  if (args.userLocale !== undefined && args.userLocale.slice(0, 2).toLowerCase() === 'en') {
    return 'en';
  }
  if (args.userLocale !== undefined) {
    return 'nl';
  }
  const header = (args.acceptLanguage ?? '').toLowerCase();
  return header.startsWith('en') ? 'en' : 'nl';
}
