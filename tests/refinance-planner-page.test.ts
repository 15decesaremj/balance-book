import { describe, expect, it } from 'vitest';
import { forecastEventSchema, loanSchema } from '@balance-book/domain';
import { projectRefinancePayoffsAtDate } from '@balance-book/financial-engine';
import {
  analyzeCurrentRefinanceContinuations,
  averageMonthlyLoanPayments,
  replacementLoanPaymentMetadata,
} from '../apps/desktop/src/renderer/RefinancePlannerPage';
import { pairRefinanceLoansWithPayoffs } from '../apps/desktop/src/renderer/refinance-view-model';

describe('refinance planner loan metadata', () => {
  it('keeps cash drafts separate from debt service and normalizes biweekly loans', () => {
    expect(
      averageMonthlyLoanPayments([
        {
          paymentCents: 100_000,
          cashPaymentCents: 125_000,
          paymentFrequency: 'monthly',
        },
        {
          paymentCents: 10_000,
          cashPaymentCents: 12_000,
          paymentFrequency: 'biweekly',
        },
      ]),
    ).toEqual({
      debtServiceCents: 121_667,
      cashDraftCents: 151_000,
    });
  });

  it('persists the selected original term and defaults the cash draft to debt service', () => {
    expect(
      replacementLoanPaymentMetadata({
        debtPaymentCents: 54_321,
        originalTermMonths: 72,
      }),
    ).toEqual({
      paymentCents: 54_321,
      cashPaymentCents: 54_321,
      originalTermMonths: 72,
    });
  });

  it('preserves a larger total cash draft without treating it as debt service', () => {
    expect(
      replacementLoanPaymentMetadata({
        debtPaymentCents: 54_321,
        cashPaymentCents: 72_000,
        originalTermMonths: 360,
      }),
    ).toEqual({
      paymentCents: 54_321,
      cashPaymentCents: 72_000,
      originalTermMonths: 360,
    });
  });

  it('rejects a cash draft below the amount applied to debt', () => {
    expect(() =>
      replacementLoanPaymentMetadata({
        debtPaymentCents: 54_321,
        cashPaymentCents: 54_320,
        originalTermMonths: 60,
      }),
    ).toThrow(/cash draft cannot be below the debt payment/i);
  });

  it('includes a future extra-principal plan in the keep-current refinance comparison', () => {
    const loan = loanSchema.parse({
      id: 'refinance-current-loan',
      userId: 'profile-a',
      name: 'Synthetic current loan',
      principalCents: 1_000_000,
      accruedInterestCents: 0,
      balanceDate: '2026-01-01',
      annualRateBasisPoints: 1_200,
      accrualConvention: 'actual-365',
      paymentCents: 100_000,
      nextPaymentDate: '2026-02-01',
      fundingAccountId: 'cash-a',
    });
    const extra = forecastEventSchema.parse({
      id: 'refinance-extra-principal',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-03-01',
      kind: 'loan-payment',
      direction: 'outflow',
      amountCents: 500_000,
      certainty: 'confirmed',
      status: 'planned',
      label: 'Synthetic future extra principal',
      sourceRecordId: loan.id,
      paymentMethod: 'cash-account',
      loanPaymentTreatment: 'additional-principal',
    });
    const payoffDate = '2026-01-15';
    const payoffs = projectRefinancePayoffsAtDate({
      loans: [loan],
      sourceLoanIds: [loan.id],
      payoffDate,
      loanPaymentEvents: [extra],
      actualThroughDate: '2026-01-01',
    });
    const loanPayoffPairs = pairRefinanceLoansWithPayoffs({ loans: [loan], payoffs });
    const withExtra = analyzeCurrentRefinanceContinuations({
      loanPayoffPairs,
      payoffDate,
      loanPaymentEvents: [extra],
      actualThroughDate: '2026-01-01',
    })[0]!;
    const withoutExtra = analyzeCurrentRefinanceContinuations({
      loanPayoffPairs,
      payoffDate,
      loanPaymentEvents: [],
      actualThroughDate: '2026-01-01',
    })[0]!;

    expect(withExtra.totalPaymentsCents).toBeLessThan(withoutExtra.totalPaymentsCents);
    expect(withExtra.remainingInterestCents).toBeLessThan(withoutExtra.remainingInterestCents!);
    expect(withExtra.remainingTermMonths).toBeLessThan(withoutExtra.remainingTermMonths!);
  });
});
