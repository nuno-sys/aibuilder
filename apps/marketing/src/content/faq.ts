/**
 * Frequently asked questions, rendered as an accordion and as `FAQPage` structured data.
 *
 * Answers are plain text on purpose: the same string is used for the visible answer and for
 * `acceptedAnswer.text`, so the two can never disagree — which is the one thing Google's structured
 * data policy is unambiguous about.
 */

import { plan, formatEuro } from './pricing';
import { exampleTenantHost, sitesRootDomain } from './site';

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

export const faq: readonly FaqItem[] = [
  {
    question: 'Hoe lang duurt het voordat mijn website klaar is?',
    answer:
      'Je beantwoordt zes korte vragen; de meeste ondernemers doen daar twee tot drie minuten over. Daarna bouwen we de site op. Je ziet stap voor stap wat er gebeurt en krijgt aan het einde het adres van je site te zien.',
  },
  {
    question: 'Heb ik technische kennis nodig?',
    answer:
      'Nee. Je hoeft geen hosting te regelen, geen thema te kiezen en geen instellingen aan te passen. Als je je bedrijfsgegevens kunt opschrijven, kun je hiermee een website maken.',
  },
  {
    question: 'Op welk adres komt mijn site te staan?',
    answer: `Je site krijgt een eigen adres op ${sitesRootDomain}, afgeleid van je bedrijfsnaam — bijvoorbeeld ${exampleTenantHost}. Dat adres blijft van jou en verandert niet meer als je later iets aanpast.`,
  },
  {
    question: 'Kan ik mijn eigen domeinnaam gebruiken?',
    answer:
      'Nog niet. Het koppelen van een eigen domeinnaam staat op de planning, maar zit niet in de huidige versie. Je site is vanaf het begin bereikbaar op je eigen adres bij ons, dus je kunt meteen aan de slag.',
  },
  {
    question: 'Waarom vragen jullie een betaalmethode voordat mijn site gebouwd wordt?',
    answer: `Het opbouwen van een website kost ons rekenkracht, en zonder drempel wordt dat geautomatiseerd misbruikt. Je vult daarom eerst de zes vragen in, geeft dan een betaalmethode op via Stripe, en direct daarna bouwen we je site. Op dat moment wordt er ${formatEuro(0)} afgeschreven: de eerste ${plan.trialDays} dagen zijn gratis. Sluit je de betaalpagina zonder af te ronden, dan blijven je antwoorden, je foto's en je gereserveerde webadres gewoon staan.`,
  },
  {
    question: 'Wat gebeurt er als de proefperiode afloopt?',
    answer: `De proefperiode duurt ${plan.trialDays} dagen. Zeg je in die periode op, dan betaal je niets. Zeg je niet op, dan gaat het abonnement in en wordt ${formatEuro(plan.annualTotalEur)} exclusief btw voor twaalf maanden in één keer afgeschreven. We sturen je vóór het einde van de proefperiode een herinnering.`,
  },
  {
    question: 'Kan ik de teksten en foto’s later nog aanpassen?',
    answer:
      'Je kunt je site opnieuw laten opbouwen met aangepaste antwoorden en andere foto’s. Een editor waarin je zelf zinnen en afbeeldingen wijzigt is in ontwikkeling en nog niet beschikbaar.',
  },
  {
    question: 'Waar staan mijn gegevens?',
    answer:
      'Je bedrijfsgegevens, foto’s en de gepubliceerde site staan op servers van Cloudflare in de Europese Unie. De teksten worden geschreven door een taalmodel van Anthropic in de Verenigde Staten; daarbij sturen we nooit je e-mailadres, telefoonnummer of straatadres mee. Die gegevens voegen we pas toe als je site wordt opgebouwd.',
  },
  {
    question: 'Moet ik een cookiebanner op mijn site zetten?',
    answer:
      'Nee. Je site plaatst geen tracking­cookies, gebruikt geen statistiekenscript in de browser en laadt geen lettertypen of kaarten van andere partijen. Daarmee valt alles wat de site opslaat onder de uitzondering voor strikt noodzakelijke gegevens en is toestemming niet vereist. De privacyverklaring en cookieverklaring voor je site maken we wel voor je.',
  },
  {
    question: 'Van wie zijn de teksten en de website?',
    answer:
      'De inhoud van je site is van jou. Je mag de teksten gebruiken, aanpassen en meenemen. Controleer de gegenereerde teksten wel op feitelijke juistheid voordat je ze deelt: een taalmodel schrijft overtuigend, maar wij kennen jouw bedrijf niet.',
  },
];
