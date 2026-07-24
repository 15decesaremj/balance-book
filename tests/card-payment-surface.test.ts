import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('apps/desktop/src/renderer/CorePages.tsx'), 'utf8');
const cardsStart = source.indexOf('export const CardsPage =');
const loansStart = source.indexOf('export const LoansPage =', cardsStart + 1);
if (cardsStart < 0 || loansStart < 0) throw new Error('Could not isolate CardsPage');
const cardsPage = source.slice(cardsStart, loansStart);

describe('credit-card payment control surface', () => {
  it('keeps stale planned payments correctable from Cards', () => {
    expect(cardsPage).toContain('Past planned date — update or cancel this record.');
    expect(cardsPage).toContain('min={editingScheduledPayment ? undefined : asOfDate}');
    expect(cardsPage).toContain("{payment.status !== 'paid' && (");
    expect(cardsPage).not.toMatch(
      /payment\.status !== 'paid'\s*&&\s*compareDates\(payment\.date, asOfDate\) >= 0/,
    );
  });

  it('makes recurring-series edits and cancellation scope explicit', () => {
    expect(cardsPage).toContain('Edit recurring payment series');
    expect(cardsPage).toContain('Apply these changes to the entire recurring payment series');
    expect(cardsPage).toContain('Edit entire series');
    expect(cardsPage).toContain('Cancel entire series');
    expect(cardsPage).toContain('Confirm cancel series');
    expect(cardsPage).toContain('Keep series');
  });

  it('selects and displays the cash account used for a recorded statement payment', () => {
    expect(cardsPage).toContain('name="actualPaymentAccountId"');
    expect(cardsPage).toContain('Only this account receives the recorded cash outflow.');
    expect(cardsPage).toContain('latestStatement.actualPaymentAccountId');
    expect(cardsPage).toContain('cycle.actualPaymentAccountId');
  });

  it('labels promotion timing as informational instead of implying modeled interest', () => {
    expect(cardsPage).toContain('Promotion ends (reference only)');
    expect(cardsPage).toContain(
      'This date does not add interest or change forecast payments automatically.',
    );
  });

  it('shows carried-balance interest and keeps experimental forecasting double-gated', () => {
    expect(cardsPage).toContain('Est. monthly interest');
    expect(cardsPage).toContain('No balance carried');
    expect(cardsPage).toContain('Add an APR to estimate');
    expect(cardsPage).toContain('name="promotionalCarryingBalance"');
    expect(cardsPage).toContain('Enter 0.00 for a 0% promotion.');
    expect(cardsPage).toContain('experimentalCardInterestForecastEnabled &&');
    expect(cardsPage).toContain('name="interestForecastEnabled"');
    expect(cardsPage).toContain(
      'Include carried-balance interest in experimental forecasts for this card',
    );
  });
});
