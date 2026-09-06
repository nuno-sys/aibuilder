/**
 * Every user-facing string in the onboarding modal, in Dutch and English.
 *
 * Dutch is the product's primary language (the target market is European small businesses, and the
 * first market is the Netherlands), so the Dutch table is written first and the English one is
 * typed against it: `type Copy = typeof NL` makes a missing English string a compile error rather
 * than a `undefined` rendered into a heading.
 *
 * VALIDATION COPY IS NOT HERE — it lives in `validation.ts`, beside the rule that produces it, so
 * that a rule and its message cannot be changed apart.
 *
 * Strings carry `{placeholders}` filled by `interpolate()` from `format.ts`. None of them contain
 * markup: several of these are announced by a screen reader as a single string, where markup is
 * either dropped or read aloud as punctuation.
 */

import type { Locale } from '@aibuilder/core';

import { copyLocale } from './validation';

const NL = {
  modal: {
    /** The one `<h1>`, visually hidden, carrying the step position (UX §6.1). */
    title: 'Maak je website — stap {step} van {total}',
    titleGenerating: 'We bouwen je website',
    stepDescription: 'Stap {step} van {total}: {name}. Nog {remaining} stappen te gaan.',
    stepDescriptionLast: 'Stap {step} van {total}: {name}. Dit is de laatste stap.',
    close: 'Sluiten en later verdergaan',
    saved: {
      title: 'Je concept is bewaard.',
      body: 'We hebben alles opgeslagen. Je kunt later verder waar je gebleven bent.',
      keepGoing: 'Verder invullen',
      close: 'Sluiten',
    },
    /* The same nested confirmation, after submit. The wording differs because the facts differ: at
       this point there is no "concept" any more — there is a reserved web address and a job that is
       waiting for a trial to start. Reusing `saved` here would tell the user something untrue about
       the state of their own site. */
    savedCheckout: {
      title: 'Je gegevens en je webadres zijn bewaard.',
      body: 'Je website is nog niet gebouwd — dat begint zodra je proefperiode loopt. Je kunt hier later verder.',
      keepGoing: 'Verder met de proefperiode',
      close: 'Sluiten',
    },
    offline: 'Geen verbinding. Je invoer is bewaard — we gaan verder zodra je weer online bent.',
    conflict: {
      body: 'Je hebt een nieuwer concept op een ander apparaat.',
      useServer: 'Dat gebruiken',
      useLocal: 'Doorgaan met dit',
    },
    resume: {
      title: 'Welkom terug.',
      body: 'Je was bij stap {step} van {total}.',
      resume: 'Verder waar je gebleven was',
      restart: 'Opnieuw beginnen',
      restartConfirm: 'Weet je het zeker? Je ingevulde gegevens worden gewist.',
    },
    genericError: 'Er ging iets mis. Probeer het zo nog eens.',
    retry: 'Opnieuw proberen',
    /* `409 trial_already_used`. Not a validation failure and not a payment failure: the request is
       fine, the identity is not eligible. The copy says which, offers the way in, and does not
       imply the person did something wrong. */
    trialUsed: {
      title: 'Met dit e-mailadres is al een proefperiode gebruikt.',
      body: 'Elke onderneming krijgt één proefperiode van {days} dagen. Log in met dit adres om verder te gaan, of gebruik het e-mailadres van je onderneming.',
      signIn: 'Inloggen',
    },
  },
  rail: {
    label: 'Voortgang',
    stepOf: 'Stap {step} van {total}',
    goToStep: 'Terug naar stap {step}: {name}',
    estimate: 'nog ±{seconds} sec',
    steps: ['Naam', 'Branche', 'Adres', 'Uren', 'Contact', 'Verhaal'],
  },
  actions: {
    continue: 'Verder',
    back: 'Terug',
    submit: 'Bouw mijn website',
    submitting: 'Bezig…',
    skipStep: 'Sla over — ik vul dit later in',
  },
  step1: {
    label: 'Hoe heet je bedrijf?',
    helper: 'Precies zoals klanten je kennen — dit komt op elke pagina.',
    placeholder: 'Bijvoorbeeld: Kapsalon Nova',
    slugLabel: 'Je webadres wordt',
    slugChecking: 'Even kijken of dit vrij is…',
    slugAvailable: '{host} is beschikbaar.',
    gbpTeaser: 'Heb je een Google-vermelding? Plak de link — dat scheelt je twee minuten.',
  },
  step2: {
    label: 'In welke branche zit je?',
    helper: 'Hiermee kiezen we je kleuren, lettertypes en pagina’s.',
    placeholder: 'Zoek je branche… bijv. kapsalon',
    popular: 'Veelgekozen',
    listLabel: 'Branches',
    results: '{count} resultaten',
    resultsOne: '1 resultaat',
    chosen: 'Gekozen: {label}',
    clear: 'Keuze wissen',
    /* The one-line design preview under the field: the second dopamine hit, and the moment the
       user learns that the output is industry-specific rather than one template with their name
       on it. Four lines, one per Phase 1 design archetype. */
    preview: {
      warm: 'Warm, met ruimte voor grote foto\u2019s \u2014 zo bouwen we sites voor {label}.',
      clean: 'Rustig, helder en vertrouwd \u2014 zo bouwen we sites voor {label}.',
      bold: 'Donker en energiek, met een grote video \u2014 zo bouwen we sites voor {label}.',
      sturdy: 'Stevig en direct, met de telefoon vooraan \u2014 zo bouwen we sites voor {label}.',
    },
  },
  step3: {
    label: 'Waar vinden klanten je?',
    helper: 'We zetten je adres, kaart en routebeschrijving automatisch op de site.',
    postcode: 'Postcode',
    houseNumber: 'Huisnummer',
    looking: 'Adres opzoeken…',
    change: 'Wijzig',
    manual: 'Handmatig invullen',
    line1: 'Straat en huisnummer',
    line2: 'Toevoeging (optioneel)',
    city: 'Plaats',
    postalCode: 'Postcode',
    country: 'Land',
    serviceToggle: 'Ik heb geen bezoekadres — ik kom naar de klant',
    serviceCity: 'Vanuit welke plaats werk je?',
    serviceRadius: 'Hoe ver reis je?',
    serviceRadiusValue: '{km} kilometer',
  },
  step4: {
    label: 'Wanneer ben je open?',
    helper: 'Kies een sjabloon en pas aan wat anders is.',
    presetLabel: 'Sjablonen',
    presets: {
      weekdays_9_17: 'Ma–vr 9–17',
      mon_sat_9_18: 'Ma–za 9–18',
      tue_sun_12_22: 'Di–zo 12–22',
      appointment: 'Op afspraak',
      always: '24/7',
    },
    summaryEmpty: 'Nog geen tijden gekozen.',
    openGrid: 'Tijden aanpassen',
    closeGrid: 'Tijden verbergen',
    gridLabel: 'Openingstijden per dag',
    open: 'Open',
    closed: 'Gesloten',
    from: 'Van',
    to: 'Tot',
    addBreak: '+ pauze',
    removeBreak: 'Blok verwijderen',
    rowMenu: 'Meer opties voor {day}',
    copyAll: 'Kopieer naar alle dagen',
    copyWeekdays: 'Kopieer naar ma–vr',
    copyWeekend: 'Kopieer naar za–zo',
    copied: '{day} {hours} gekopieerd naar {count} dagen.',
    confirmAllClosed: 'Ja, klopt',
    changeAllClosed: 'Aanpassen',
  },
  step5: {
    label: 'Hoe kunnen klanten je bereiken?',
    helper: 'Klanten bellen of appen je hiermee direct vanaf je site.',
    phone: 'Telefoonnummer',
    country: 'Land van je nummer',
    whatsapp: 'Dit nummer ook voor WhatsApp',
    whatsappOther: 'WhatsApp-nummer',
    whatsappKeep: 'Toch gebruiken',
    whatsappChange: 'Ander nummer',
    gbp: 'Google-vermelding (optioneel)',
    gbpHelper: 'Plak de link zodat we naar je vermelding kunnen verwijzen.',
  },
  step6: {
    label: 'Vertel in het kort wat je doet',
    helper: '2–3 zinnen. Geen zin? Laat dit veld gerust leeg — we schrijven zelf iets.',
    placeholder: 'Wij knippen sinds 2009 in hartje Amsterdam…',
    counter: '{count} van {max} tekens',
    mediaLabel: 'Foto’s van je zaak (optioneel)',
    mediaHelper:
      'Sleep ze hierheen of maak nu een foto. Eén goede foto maakt je site 10× persoonlijker.',
    email: 'Waar sturen we de link naartoe?',
    emailHelper:
      'Hier sturen we de link naartoe zodra je site klaar is — en je factuur en de herinnering vóór het einde van je proefperiode.',
    consent: 'Stuur me tips om meer klanten te krijgen (max 1× per maand).',
    legal: 'Door verder te gaan ga je akkoord met de Voorwaarden en de Privacyverklaring.',
    /* These three replace Phase 1's 'Gratis · Geen creditcard · Klaar in ~1 minuut'. The middle one
       became false the day the trial moved in front of the first generation (DECISIONS §D2), and a
       trust strip that lies is worse than no trust strip. `{days}` and `{today}` are filled from
       `content/pricing.ts`, so the strip cannot drift from the price the build asserts. */
    trust: ['{days} dagen gratis proberen', 'Vandaag betaal je {today}', 'Klaar in ~1 minuut'],
    /* Read immediately above the submit button, inside the sticky footer, so it is on screen at the
       moment of the irreversible action rather than scrolled away above it. */
    checkoutNotice:
      'Hierna reserveren we je webadres en start je de proefperiode bij Stripe. Vandaag betaal je {today}.',
  },
  media: {
    dropzone: 'Sleep je foto’s hierheen',
    dropzoneActive: 'Laat los om toe te voegen',
    choose: 'Bestanden kiezen',
    capture: 'Foto maken',
    hero: 'Hero',
    heroExplainer: 'De eerste foto komt bovenaan je site.',
    remove: 'Foto verwijderen',
    retry: 'Opnieuw proberen',
    moveLeft: 'Naar voren',
    moveRight: 'Naar achteren',
    reorderHint: 'Spatie om op te pakken, pijltjes om te verplaatsen.',
    states: {
      queued: 'In de wachtrij',
      compressing: 'Foto wordt verkleind',
      uploading: 'Uploaden, {percent} procent',
      verifying: 'Controleren',
      ready: 'Geüpload',
      error: 'Mislukt',
    },
    picked:
      '{name} opgepakt. Gebruik de pijltjestoetsen om te verplaatsen, spatie om neer te zetten.',
    moved: '{name}, positie {position} van {total}.',
    dropped: '{name} neergezet op positie {position}.',
    cancelled: 'Verplaatsen geannuleerd. {name} staat weer op positie {position}.',
    uploaded: 'Foto {index} van {total} geüpload.',
    skip: {
      title: 'Sla over — wij kiezen prachtige beelden voor je',
      body: 'We zoeken professionele beelden die bij {industry} passen. Later zelf foto’s toevoegen kan altijd.',
      action: 'Zonder foto’s verder',
      undo: 'Toch zelf foto’s kiezen',
    },
  },
  /* ── The hand-off to Stripe ────────────────────────────────────────────────────────────────
     THE CONVERSION POINT OF THE WHOLE PRODUCT, and the one screen where every number must be a
     number the customer will actually see on a bank statement. Four rules the copy below keeps:

       1. Every figure is stated, none is implied. The annual total, the derived monthly rate, the
          amount charged today and the VAT basis all appear together — the Omnibus-amended UCPD
          treats a monthly headline over an annual charge as a misleading omission, and burying the
          real number one screen further on would be exactly that.
       2. Cancelling is described before it is asked for, in the same weight as the price.
       3. The reason a card is needed BEFORE the build is given plainly, because from the customer's
          side that ordering is surprising and an unexplained surprise reads as a trap.
       4. No countdown, no scarcity, no pre-ticked anything, no "are you sure you want to miss out".
          The 30-minute link expiry is stated as a fact about the link, not as pressure. */
  checkout: {
    eyebrow: 'Laatste stap',
    title: 'Klaar om {name} te bouwen.',
    intro:
      'Je antwoorden staan klaar en je webadres is voor je gereserveerd. We beginnen met bouwen zodra je proefperiode loopt; daarna duurt het ongeveer een minuut.',
    reservedLabel: 'Jouw webadres',
    summaryLabel: 'Wat we gaan bouwen',
    photos: '{count} eigen foto’s',
    photosOne: '1 eigen foto',
    photosNone: 'Beelden die wij voor je uitzoeken',
    todayLabel: 'Vandaag',
    todayNote: 'Er wordt vandaag niets afgeschreven.',
    afterLabel: 'Na {days} dagen',
    afterAmount: '{annual} per jaar',
    afterNote:
      'Dat is {monthly} per maand, één keer per jaar in rekening gebracht. Bedragen zijn exclusief btw; Stripe rekent de btw uit op basis van je land en je btw-nummer.',
    cancelLabel: 'Opzeggen',
    cancelNote:
      'Zeg je binnen {days} dagen op, dan betaal je niets en stopt het abonnement meteen. Je zegt zelf op in je account — geen telefoontje, geen mail, geen opzegtermijn.',
    cardLabel: 'Waarom nu al een betaalmethode?',
    cardNote:
      'Het opbouwen van een website kost ons rekenkracht. Een betaalmethode houdt geautomatiseerd misbruik tegen, en daarom vragen we die vóór het bouwen in plaats van erna.',
    stripeNote:
      'Je vult je gegevens in op de beveiligde betaalpagina van Stripe. Wij zien je kaartnummer niet en bewaren het niet.',
    action: 'Verder naar Stripe',
    actionBusy: 'Even geduld…',
    close: 'Later verdergaan',
    closeNote: 'Je antwoorden, je foto’s en je gereserveerde webadres blijven bewaard.',
    expiresAt: 'Deze betaallink is geldig tot {time}.',
    announce:
      'Laatste stap: je proefperiode van {days} dagen starten bij Stripe. Vandaag betaal je {today}.',
    cancelled: {
      title: 'Je bent teruggekomen zonder af te ronden.',
      body: 'Er is niets afgeschreven en er is niets kwijt. Je antwoorden, je foto’s en je webadres staan nog precies zoals je ze achterliet.',
      action: 'Opnieuw naar Stripe',
    },
    expired: {
      title: 'De betaallink is verlopen.',
      body: 'Een betaallink blijft dertig minuten geldig. Je gegevens zijn bewaard — we maken een nieuwe voor je.',
      action: 'Nieuwe betaallink maken',
    },
    unavailable: {
      title: 'De betaalpagina is nu niet bereikbaar.',
      body: 'Dat ligt aan ons, niet aan jou. Je antwoorden en je webadres zijn bewaard, dus we kunnen het gewoon opnieuw proberen.',
      action: 'Opnieuw proberen',
    },
    /* Shown after the one retry this screen offers has failed. It gives the way back in rather than
       a second identical button: a third attempt against a service that just refused twice is not a
       remedy, it is a slot machine. */
    retryFailed:
      'Het lukt nu niet om een betaallink te maken. Je gegevens en je gereserveerde webadres blijven bewaard — kom later terug op deze pagina, dan pakken we het op waar we gebleven zijn.',
  },
  generation: {
    title: 'We bouwen je website',
    escapeHint: 'Sluit dit venster gerust — we mailen je de link zodra hij klaar is.',
    slow: 'Dit duurt iets langer dan normaal — we zijn er bijna.',
    release:
      'Zullen we je een mail sturen zodra je site klaar is? Je kunt dit venster dan sluiten.',
    releaseAction: 'Mail me de link',
    releaseDone: 'Afgesproken. We mailen je de link naar {email}.',
    failed: 'Het bouwen is misgegaan. We hebben je gegevens bewaard.',
    failedAction: 'Opnieuw proberen',
    /* Act 0. The `success_url` redirect is a browser navigation and not a payment guarantee, so the
       user can — and regularly will — arrive here before Stripe's webhook does (PHASE2 §2.3). The
       progress rail sits at its floor and does not move: a bar that creeps while nothing is
       happening is the one lie this rail was built not to tell. */
    payment: {
      confirmingTitle: 'Je proefperiode wordt bevestigd…',
      confirmingBody: 'Dit duurt meestal een paar seconden. Je hoeft niets te doen.',
      confirmingSlow: 'Nog even geduld — betalingen kunnen bij drukte iets langer duren.',
      confirmingAnnounce:
        'Je proefperiode wordt bevestigd. Dit duurt meestal een paar seconden. Je hoeft niets te doen.',
      pendingTitle: 'Je website wacht op je proefperiode.',
      pendingBody:
        'Alles staat klaar: je antwoorden, je foto’s en je webadres. Zodra je proefperiode loopt, beginnen we met bouwen.',
      pendingAction: 'Proefperiode starten',
      expiredTitle: 'De betaallink is verlopen.',
      expiredBody:
        'Een betaallink blijft dertig minuten geldig. Je gegevens en je webadres zijn bewaard — we maken een nieuwe link voor je.',
      expiredAction: 'Nieuwe betaallink maken',
      resumeFailed:
        'Het lukt nu niet om een betaallink te maken. Probeer het over een paar minuten opnieuw; je gegevens blijven bewaard.',
    },
    acts: {
      awaitingPayment: 'We bevestigen je proefperiode',
      queued: 'We beginnen…',
      prompt: 'We lezen alles over {name}',
      design: 'We kiezen kleuren en lettertypes voor {industry}',
      writing: 'We schrijven je pagina’s',
      layout: 'We maken je pagina’s op',
      media: 'We zoeken de mooiste beelden',
      build: 'Optimaliseren voor Google en mobiel',
      deploy: 'Live zetten op {host}',
      done: 'Je website is live.',
    },
    progressLabel: 'Voortgang van het bouwen',
    announcement: '{headline} {percent} procent.',
    doneAnnouncement: 'Klaar. Je website staat live op {spokenHost}.',
    reveal: {
      title: 'Je website is live.',
      body: 'Je site staat op {host}. We hebben de link ook naar {email} gestuurd.',
      view: 'Bekijk mijn website',
      edit: 'Aanpassen in de editor',
      editSoon: 'De editor komt binnenkort — je site blijft gewoon staan.',
    },
  },
  errorSummary: {
    headingOne: 'Er is 1 ding dat nog niet klopt',
    headingMany: 'Er zijn {count} dingen die nog niet kloppen',
  },
  a11y: {
    stepChanged: 'Stap {step} van {total}: {name}.',
    errorPrefix: 'Fout: {message}',
    required: 'verplicht',
  },
};

/** The shape both tables share. Derived from Dutch, so Dutch is the source of truth. */
export type Copy = typeof NL;

const EN: Copy = {
  modal: {
    title: 'Build your website — step {step} of {total}',
    titleGenerating: 'Building your website',
    stepDescription: 'Step {step} of {total}: {name}. {remaining} steps to go.',
    stepDescriptionLast: 'Step {step} of {total}: {name}. This is the last step.',
    close: 'Close and continue later',
    saved: {
      title: 'Your draft is saved.',
      body: "We've saved everything. You can pick up where you left off.",
      keepGoing: 'Keep going',
      close: 'Close',
    },
    savedCheckout: {
      title: 'Your answers and your web address are saved.',
      body: "Your website hasn't been built yet — that starts once your trial is running. You can pick this up later.",
      keepGoing: 'Continue with the trial',
      close: 'Close',
    },
    offline: "You're offline. Your answers are saved — we'll continue as soon as you're back.",
    conflict: {
      body: 'You have a newer draft on another device.',
      useServer: 'Use that one',
      useLocal: 'Continue with this',
    },
    resume: {
      title: 'Welcome back.',
      body: 'You were on step {step} of {total}.',
      resume: 'Continue where you left off',
      restart: 'Start over',
      restartConfirm: 'Are you sure? Everything you filled in will be cleared.',
    },
    genericError: 'Something went wrong. Please try again.',
    retry: 'Try again',
    trialUsed: {
      title: 'A trial has already been used with this e-mail address.',
      body: 'Each business gets one {days}-day trial. Sign in with this address to continue, or use your business e-mail address.',
      signIn: 'Sign in',
    },
  },
  rail: {
    label: 'Progress',
    stepOf: 'Step {step} of {total}',
    goToStep: 'Back to step {step}: {name}',
    estimate: '±{seconds} sec left',
    steps: ['Name', 'Industry', 'Address', 'Hours', 'Contact', 'Story'],
  },
  actions: {
    continue: 'Continue',
    back: 'Back',
    submit: 'Build my website',
    submitting: 'Working…',
    skipStep: "Skip — I'll fill this in later",
  },
  step1: {
    label: "What's your business called?",
    helper: 'Exactly as customers know you — this goes on every page.',
    placeholder: 'For example: Nova Hair Studio',
    slugLabel: 'Your web address will be',
    slugChecking: 'Checking whether this is free…',
    slugAvailable: '{host} is available.',
    gbpTeaser: 'Got a Google listing? Paste the link — it saves you two minutes.',
  },
  step2: {
    label: 'What kind of business is it?',
    helper: 'This decides your colours, fonts and pages.',
    placeholder: 'Search your industry… e.g. hair salon',
    popular: 'Popular',
    listLabel: 'Industries',
    results: '{count} results',
    resultsOne: '1 result',
    chosen: 'Selected: {label}',
    clear: 'Clear selection',
    preview: {
      warm: 'Warm, with room for big photography \u2014 this is how we build sites for {label}.',
      clean: 'Calm, clear and reassuring \u2014 this is how we build sites for {label}.',
      bold: 'Dark and energetic, with a big video \u2014 this is how we build sites for {label}.',
      sturdy:
        'Sturdy and direct, phone number first \u2014 this is how we build sites for {label}.',
    },
  },
  step3: {
    label: 'Where do customers find you?',
    helper: "We'll add your address, a map and directions automatically.",
    postcode: 'Postcode',
    houseNumber: 'House number',
    looking: 'Looking up your address…',
    change: 'Edit',
    manual: 'Enter it manually',
    line1: 'Street and number',
    line2: 'Addition (optional)',
    city: 'Town or city',
    postalCode: 'Postcode',
    country: 'Country',
    serviceToggle: "I don't have a visitable address — I travel to customers",
    serviceCity: 'Which town do you work from?',
    serviceRadius: 'How far do you travel?',
    serviceRadiusValue: '{km} kilometres',
  },
  step4: {
    label: 'When are you open?',
    helper: "Pick a template, then change what's different.",
    presetLabel: 'Templates',
    presets: {
      weekdays_9_17: 'Mon–Fri 9–17',
      mon_sat_9_18: 'Mon–Sat 9–18',
      tue_sun_12_22: 'Tue–Sun 12–22',
      appointment: 'By appointment',
      always: '24/7',
    },
    summaryEmpty: 'No hours chosen yet.',
    openGrid: 'Adjust hours',
    closeGrid: 'Hide hours',
    gridLabel: 'Opening hours per day',
    open: 'Open',
    closed: 'Closed',
    from: 'From',
    to: 'To',
    addBreak: '+ break',
    removeBreak: 'Remove block',
    rowMenu: 'More options for {day}',
    copyAll: 'Copy to all days',
    copyWeekdays: 'Copy to Mon–Fri',
    copyWeekend: 'Copy to Sat–Sun',
    copied: '{day} {hours} copied to {count} days.',
    confirmAllClosed: "Yes, that's right",
    changeAllClosed: 'Change',
  },
  step5: {
    label: 'How can customers reach you?',
    helper: 'Customers call or WhatsApp you straight from your site.',
    phone: 'Phone number',
    country: 'Country of your number',
    whatsapp: 'Use this number for WhatsApp too',
    whatsappOther: 'WhatsApp number',
    whatsappKeep: 'Use anyway',
    whatsappChange: 'Use another',
    gbp: 'Google Business Profile (optional)',
    gbpHelper: 'Paste the link so we can point visitors at your listing.',
  },
  step6: {
    label: 'Tell us briefly what you do',
    helper: "2–3 sentences. Not in the mood? Leave it empty — we'll write something.",
    placeholder: "We've been cutting hair in the centre of town since 2009…",
    counter: '{count} of {max} characters',
    mediaLabel: 'Photos of your business (optional)',
    mediaHelper: 'Drag them in or take one now. One good photo makes your site 10× more personal.',
    email: 'Where should we send the link?',
    emailHelper:
      "This is where we'll send the link once your site is ready — plus your invoice and the reminder before your trial ends.",
    consent: 'Send me tips for getting more customers (once a month at most).',
    legal: 'By continuing you agree to the Terms and the Privacy statement.',
    trust: ['{days}-day free trial', 'You pay {today} today', 'Ready in ~1 minute'],
    checkoutNotice:
      'Next we reserve your web address and you start the trial at Stripe. You pay {today} today.',
  },
  media: {
    dropzone: 'Drag your photos here',
    dropzoneActive: 'Drop to add',
    choose: 'Choose files',
    capture: 'Take a photo',
    hero: 'Hero',
    heroExplainer: 'The first photo goes at the top of your site.',
    remove: 'Remove photo',
    retry: 'Try again',
    moveLeft: 'Move earlier',
    moveRight: 'Move later',
    reorderHint: 'Space to pick up, arrow keys to move.',
    states: {
      queued: 'Queued',
      compressing: 'Resizing photo',
      uploading: 'Uploading, {percent} percent',
      verifying: 'Checking',
      ready: 'Uploaded',
      error: 'Failed',
    },
    picked: '{name} picked up. Use the arrow keys to move it, space to drop it.',
    moved: '{name}, position {position} of {total}.',
    dropped: '{name} dropped at position {position}.',
    cancelled: 'Move cancelled. {name} is back at position {position}.',
    uploaded: 'Photo {index} of {total} uploaded.',
    skip: {
      title: "Skip — we'll pick beautiful imagery for you",
      body: "We'll find professional imagery that suits {industry}. You can add your own photos any time.",
      action: 'Continue without photos',
      undo: "I'll choose photos after all",
    },
  },
  checkout: {
    eyebrow: 'Last step',
    title: 'Ready to build {name}.',
    intro:
      'Your answers are ready and your web address is reserved for you. We start building the moment your trial is running — it takes about a minute from there.',
    reservedLabel: 'Your web address',
    summaryLabel: "What we'll build",
    photos: '{count} of your own photos',
    photosOne: '1 of your own photos',
    photosNone: "Imagery we'll pick for you",
    todayLabel: 'Today',
    todayNote: 'Nothing is charged today.',
    afterLabel: 'After {days} days',
    afterAmount: '{annual} per year',
    afterNote:
      'That works out at {monthly} per month, charged once a year. Amounts exclude VAT; Stripe calculates VAT from your country and your VAT number.',
    cancelLabel: 'Cancelling',
    cancelNote:
      'Cancel within {days} days and you pay nothing — the subscription stops straight away. You cancel it yourself in your account: no phone call, no e-mail, no notice period.',
    cardLabel: 'Why a payment method now?',
    cardNote:
      'Building a website costs us real compute. A payment method is what keeps automated abuse out, which is why we ask for it before the build rather than after it.',
    stripeNote:
      "You enter your details on Stripe's secure payment page. We never see your card number and never store it.",
    action: 'Continue to Stripe',
    actionBusy: 'One moment…',
    close: 'Continue later',
    closeNote: 'Your answers, your photos and your reserved web address stay saved.',
    expiresAt: 'This payment link is valid until {time}.',
    announce: 'Last step: starting your {days}-day trial at Stripe. You pay {today} today.',
    cancelled: {
      title: 'You came back without finishing.',
      body: 'Nothing was charged and nothing is lost. Your answers, your photos and your web address are exactly where you left them.',
      action: 'Back to Stripe',
    },
    expired: {
      title: 'The payment link has expired.',
      body: "A payment link stays valid for thirty minutes. Your details are saved — we'll make a new one for you.",
      action: 'Make a new payment link',
    },
    unavailable: {
      title: 'The payment page is unreachable right now.',
      body: "That's on us, not on you. Your answers and your web address are saved, so we can simply try again.",
      action: 'Try again',
    },
    retryFailed:
      "We can't create a payment link right now. Your details and your reserved web address stay saved — come back to this page later and we'll pick up where we left off.",
  },
  generation: {
    title: 'Building your website',
    escapeHint: "Feel free to close this window — we'll email you the link when it's ready.",
    slow: "This is taking a little longer than usual — we're almost there.",
    release: 'Shall we email you when your site is ready? You can close this window then.',
    releaseAction: 'Email me the link',
    releaseDone: "Done. We'll email the link to {email}.",
    failed: "The build failed. We've kept everything you filled in.",
    failedAction: 'Try again',
    payment: {
      confirmingTitle: 'Confirming your trial…',
      confirmingBody: 'This usually takes a few seconds. Nothing for you to do.',
      confirmingSlow: 'Hang on a moment — payments can take a little longer when it is busy.',
      confirmingAnnounce:
        'Confirming your trial. This usually takes a few seconds. Nothing for you to do.',
      pendingTitle: 'Your website is waiting for your trial.',
      pendingBody:
        'Everything is ready: your answers, your photos and your web address. We start building as soon as your trial is running.',
      pendingAction: 'Start the trial',
      expiredTitle: 'The payment link has expired.',
      expiredBody:
        "A payment link stays valid for thirty minutes. Your details and your web address are saved — we'll make a new link for you.",
      expiredAction: 'Make a new payment link',
      resumeFailed:
        "We can't create a payment link right now. Try again in a few minutes; your details stay saved.",
    },
    acts: {
      awaitingPayment: 'Confirming your trial',
      queued: 'Getting started…',
      prompt: 'Reading everything about {name}',
      design: 'Choosing colours and type for {industry}',
      writing: 'Writing your pages',
      layout: 'Laying out your pages',
      media: 'Finding your best imagery',
      build: 'Optimising for Google and mobile',
      deploy: 'Publishing to {host}',
      done: 'Your website is live.',
    },
    progressLabel: 'Build progress',
    announcement: '{headline} {percent} percent.',
    doneAnnouncement: 'Done. Your website is live at {spokenHost}.',
    reveal: {
      title: 'Your website is live.',
      body: "Your site is at {host}. We've emailed the link to {email} as well.",
      view: 'View my website',
      edit: 'Edit in the editor',
      editSoon: 'The editor is coming soon — your site stays online in the meantime.',
    },
  },
  errorSummary: {
    headingOne: 'There is 1 thing that needs fixing',
    headingMany: 'There are {count} things that need fixing',
  },
  a11y: {
    stepChanged: 'Step {step} of {total}: {name}.',
    errorPrefix: 'Error: {message}',
    required: 'required',
  },
};

/** Both tables, by locale. */
const COPY: Readonly<Record<'nl' | 'en', Copy>> = { nl: NL, en: EN };

/** The copy table for a locale. Anything outside nl falls back to English (Phase 2 adds the rest). */
export function copyFor(locale: Locale): Copy {
  return COPY[copyLocale(locale)];
}
