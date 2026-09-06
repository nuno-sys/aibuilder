/**
 * The feature grid. Every claim here has to be true of what actually ships — no capability is
 * described that Phase 1 does not deliver, and nothing is quantified that has not been measured
 * (architecture §7.13 and the UCPD: an unsubstantiated marketing claim is an unfair practice, not
 * a rounding error).
 */

export interface Feature {
  readonly title: string;
  readonly body: string;
  /** Inline SVG path data, 24x24 viewBox, stroke-based. Decorative — the title carries meaning. */
  readonly iconPath: string;
  /** Optional honest caveat, rendered smaller. Used where a capability is genuinely limited. */
  readonly note?: string;
}

export const features: readonly Feature[] = [
  {
    title: 'Zes vragen, geen bouwpakket',
    body: 'Je vult je bedrijfsnaam, branche, adres, openingstijden en contactgegevens in. Meer niet. Geen thema kiezen, geen blokken slepen, geen instellingen doorspitten.',
    iconPath: 'M4 6h16M4 12h10M4 18h7',
  },
  {
    title: 'Meteen een eigen webadres',
    body: 'Zodra je site klaar is, staat hij live op een eigen adres. Je kunt de link direct delen, op je visitekaartje zetten of in je Google-profiel plakken.',
    iconPath:
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z',
    note: 'Je eigen domeinnaam koppelen komt later; het staat op de planning en is niet inbegrepen bij de start.',
  },
  {
    title: 'Gebouwd om gevonden te worden',
    body: 'Je bedrijfsgegevens, openingstijden en veelgestelde vragen worden als gestructureerde data meegegeven aan zoekmachines. Elke pagina krijgt een eigen titel en omschrijving, en er wordt automatisch een sitemap gepubliceerd.',
    iconPath: 'M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  },
  {
    title: 'Snel op elke telefoon',
    body: 'Geen paginabouwer die je site zwaar maakt. Lettertypen staan op onze eigen servers, afbeeldingen worden vooraf op maat gezet en de opmaak wordt met de pagina meegestuurd in plaats van los nageladen.',
    iconPath: 'M13 2 4.5 13.5H12l-1 8.5L19.5 10.5H12l1-8.5Z',
  },
  {
    title: 'Klanten bereiken je in één tik',
    body: 'Een WhatsApp-knop, een klikbaar telefoonnummer, je openingstijden en een contactformulier waarvan de aanvraag rechtstreeks in je mailbox belandt.',
    iconPath: 'M20.5 12a8.5 8.5 0 0 1-12.4 7.6L3.5 21l1.5-4.4A8.5 8.5 0 1 1 20.5 12Z',
  },
  {
    title: 'Privacy zonder cookiebanner',
    body: 'Je site plaatst geen tracking­cookies en laadt niets van andere partijen. Daardoor is een cookiebanner niet nodig. De site en je gegevens staan op servers in de Europese Unie.',
    iconPath: 'M12 3l7.5 3v6c0 4.4-3 8.1-7.5 9-4.5-.9-7.5-4.6-7.5-9V6L12 3Z M9 12l2 2 4-4',
  },
];
