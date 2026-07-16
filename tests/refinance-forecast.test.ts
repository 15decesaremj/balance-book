import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  loanSchema,
  type Loan,
} from '@balance-book/domain';
import { evaluateRefinanceForecast } from '@balance-book/financial-engine';

const userId = 'refinance-user';
const cash = cashAccountSchema.parse({
  id: 'checking',
  userId,
  name: 'Checking',
  type: 'checking',
  openingBalanceCents: 1_000_000,
  balanceAsOf: '2026-01-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  hardFloorCents: 0,
  transferDelayDays: 0,
});
const currentLoan: Loan = loanSchema.parse({
  id: 'current-loan',
  userId,
  name: 'Current loan',
  principalCents: 1_000_000,
  accruedInterestCents: 0,
  balanceDate: '2026-01-01',
  annualRateBasisPoints: 600,
  accrualConvention: 'monthly',
  paymentCents: 100_000,
  nextPaymentDate: '2026-01-05',
  fundingAccountId: cash.id,
  excludeFromEconomicNetWorthDoubleCount: false,
  paymentFrequency: 'monthly',
  includeInCashForecast: true,
  status: 'active',
});
const unrelatedLoan: Loan = loanSchema.parse({
  ...currentLoan,
  id: 'unrelated-loan',
  name: 'Unrelated loan',
  principalCents: 300_000,
  paymentCents: 30_000,
  nextPaymentDate: '2026-01-06',
});
const policy = cashFloorPolicySchema.parse({
  hardConsolidatedFloorCents: 0,
  horizonDays: 10,
  includeConfirmedReceivablesConservatively: true,
});
const baseInput = {
  accounts: [cash],
  events: [],
  cards: [],
  cardCycles: [],
  loans: [currentLoan],
  receivables: [],
  policy,
  requestedStartDate: '2026-01-01' as const,
  loanId: currentLoan.id,
  fundingAccountId: cash.id,
  closingDate: '2026-01-08' as const,
  firstPaymentDate: '2026-02-15' as const,
  replacementPaymentCents: 60_000,
  replacementTermMonths: 24,
  cashAtClosingCents: 0,
};

describe('refinance cash forecast', () => {
  it('extends both schedules through a first replacement payment outside the policy horizon', () => {
    const result = evaluateRefinanceForecast({
      ...baseInput,
      loans: [currentLoan, unrelatedLoan],
    });

    expect(result).toMatchObject({
      startDate: '2026-01-01',
      originalHorizonEndDate: '2026-01-10',
      endDate: '2026-02-15',
      horizonExtended: true,
    });
    expect(result.baseline.conservative.endDate).toBe('2026-02-15');
    expect(result.proposed.conservative.endDate).toBe('2026-02-15');

    const baselineAppliedIds = result.baseline.conservative.days.flatMap(
      (day) => day.appliedEventIds,
    );
    const proposedAppliedIds = result.proposed.conservative.days.flatMap(
      (day) => day.appliedEventIds,
    );
    expect(baselineAppliedIds).toEqual([
      'loan-payment-current-loan@2026-01-05',
      'loan-payment-unrelated-loan@2026-01-06',
      'loan-payment-current-loan@2026-02-05',
      'loan-payment-unrelated-loan@2026-02-06',
    ]);
    expect(proposedAppliedIds).toContain('loan-payment-current-loan@2026-01-05');
    expect(proposedAppliedIds).not.toContain('loan-payment-current-loan@2026-02-05');
    expect(proposedAppliedIds).toContain('loan-payment-unrelated-loan@2026-01-06');
    expect(proposedAppliedIds).toContain('loan-payment-unrelated-loan@2026-02-06');
    expect(proposedAppliedIds).toContain(result.replacementPaymentEventId);
    expect(result.replacementPaymentEventId).toBe('refinance-payment-current-loan@2026-02-15');
    expect(result.baseline.conservative.days.at(-1)?.consolidatedCashCents).toBe(740_000);
    expect(result.proposed.conservative.days.at(-1)?.consolidatedCashCents).toBe(780_000);
  });

  it('retires a current-loan payment on the closing date before that payment executes', () => {
    const result = evaluateRefinanceForecast({
      ...baseInput,
      closingDate: '2026-01-05',
      firstPaymentDate: '2026-01-09',
    });
    const baselineAppliedIds = result.baseline.conservative.days.flatMap(
      (day) => day.appliedEventIds,
    );
    const proposedAppliedIds = result.proposed.conservative.days.flatMap(
      (day) => day.appliedEventIds,
    );

    expect(baselineAppliedIds).toContain('loan-payment-current-loan@2026-01-05');
    expect(proposedAppliedIds).not.toContain('loan-payment-current-loan@2026-01-05');
    expect(proposedAppliedIds).toContain(result.replacementPaymentEventId);
    expect(result.endDate).toBe('2026-01-10');
    expect(result.horizonExtended).toBe(false);
  });

  it('rejects an invalid replacement schedule before removing the current loan', () => {
    expect(() =>
      evaluateRefinanceForecast({
        ...baseInput,
        firstPaymentDate: '2026-01-07',
      }),
    ).toThrow(/cannot be before the refinance closing date/i);
    expect(() =>
      evaluateRefinanceForecast({
        ...baseInput,
        firstPaymentDate: baseInput.closingDate,
      }),
    ).toThrow(/or on the closing date/i);
    expect(() =>
      evaluateRefinanceForecast({
        ...baseInput,
        replacementPaymentCents: 0,
      }),
    ).toThrow();
  });
});
