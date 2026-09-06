/**
 * The single plan.
 *
 * EU price transparency (Prijzenwet / UCPD as amended by the Omnibus Directive) requires the total
 * a customer will actually be charged to be shown as prominently as the headline rate. A "€9,99 per
 * maand" that silently bills €119,88 once a year is exactly the practice those rules target — so
 * the annual total, the VAT basis and what happens when the trial ends are all first-class fields
 * here and all rendered, not footnoted.
 */

export interface Plan {
  readonly name: string;
  /** Headline rate, per month, in euros. */
  readonly monthlyEur: number;
  /** What is actually charged, once, per year, in euros. */
  readonly annualTotalEur: number;
  readonly currency: 'EUR';
  /** False: the target market is businesses, so amounts are quoted excluding VAT and say so. */
  readonly vatIncluded: boolean;
  readonly trialDays: number;
  readonly includes: readonly string[];
}

export const plan: Plan = {
  name: 'Compleet',
  monthlyEur: 9.99,
  annualTotalEur: 119.88,
  currency: 'EUR',
  vatIncluded: false,
  trialDays: 7,
  includes: [
    'Een complete website, in één keer voor je opgebouwd',
    'Eigen webadres, direct online',
    'Gestructureerde bedrijfsgegevens voor zoekmachines',
    'Automatische sitemap en nette URL’s',
    'WhatsApp-knop, telefoonlink en contactformulier',
    'Openingstijden, ook met pauzes en afwijkende dagen',
    'Tot tien eigen foto’s, automatisch op maat gemaakt',
    'Privacyverklaring en cookieverklaring voor je eigen site',
    'Hosting en beveiligd certificaat inbegrepen',
    'Servers en opslag in de Europese Unie',
  ],
};

/**
 * Guards the one arithmetic relationship a reader can check for themselves. A headline rate that
 * does not multiply out to the advertised annual total is a misleading price, so it fails the build
 * rather than reaching a page.
 */
function assertAnnualTotalMatches(candidate: Plan): void {
  const expected = Math.round(candidate.monthlyEur * 12 * 100) / 100;
  if (expected !== candidate.annualTotalEur) {
    throw new Error(
      `Pricing inconsistency: ${candidate.monthlyEur}/month x 12 = ${expected}, ` +
        `but annualTotalEur is ${candidate.annualTotalEur}.`,
    );
  }
}

assertAnnualTotalMatches(plan);

const euroFormatter = new Intl.NumberFormat('nl-NL', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
});

/**
 * Formats an amount in Dutch convention (`€ 9,99`).
 *
 * @param amount Amount in euros.
 * @returns The amount with a euro sign, a non-breaking space and a decimal comma.
 */
export function formatEuro(amount: number): string {
  return euroFormatter.format(amount);
}
