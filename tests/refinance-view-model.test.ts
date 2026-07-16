import { describe, expect, it } from 'vitest';
import {
  committedRefinancePlanSchema,
  loanSchema,
  type CommittedRefinancePlan,
} from '@balance-book/domain';
import {
  calculateRefinanceSettlement,
  pairRefinanceLoansWithPayoffs,
  refinanceLoanCandidates,
  refinancePlanLifecycle,
} from '../apps/desktop/src/renderer/refinance-view-model';
import { projectRefinancePayoffsAtDate } from '@balance-book/financial-engine';

const loan = loanSchema.parse({
  id: 'loan-a',
  userId: 'user-a',
  name: 'Loan A',
  principalCents: 1_000_000,
  accruedInterestCents: 0,
  balanceDate: '2026-01-01',
  annualRateBasisPoints: 600,
  accrualConvention: 'actual-365',
  paymentCents: 50_000,
  nextPaymentDate: '2026-02-01',
  fundingAccountId: 'checking',
  excludeFromEconomicNetWorthDoubleCount: false,
  paymentFrequency: 'monthly',
  includeInCashForecast: true,
  status: 'active',
});

const makePlan = (input: {
  id: string;
  sourceLoanId: string;
  replacementLoanId: string;
  closingDate: string;
  payoffDate?: string;
  firstPaymentDate?: string;
  sourceRefinancePlanId?: string;
}): CommittedRefinancePlan => {
  const firstPaymentDate = input.firstPaymentDate ?? '2026-03-15';
  const replacementLoan = loanSchema.parse({
    ...loan,
    id: input.replacementLoanId,
    name: `Replacement ${input.replacementLoanId}`,
    principalCents: 900_000,
    balanceDate: input.closingDate,
    nextPaymentDate: firstPaymentDate,
    originalDate: input.closingDate,
  });
  return committedRefinancePlanSchema.parse({
    id: input.id,
    userId: 'user-a',
    name: `Plan ${input.id}`,
    status: 'committed',
    closingDate: input.closingDate,
    payoffDate: input.payoffDate ?? input.closingDate,
    firstPaymentDate,
    payoffs: [
      {
        sourceLoanId: input.sourceLoanId,
        payoffAmountCents: 900_000,
        sourceRefinancePlanId: input.sourceRefinancePlanId,
      },
    ],
    replacementLoan,
    principalCashContributionCents: 0,
    closingCostsCents: 0,
    financedFeesCents: 0,
    excessProceedsCents: 0,
  });
};

describe('refinance settlement view model', () => {
  it('pairs reverse-order multi-loan payoff projections by source ID', () => {
    const expensiveLoan = loanSchema.parse({
      ...loan,
      id: 'loan-b',
      name: 'Loan B',
      principalCents: 2_000_000,
      annualRateBasisPoints: 1_200,
    });
    const payoffs = projectRefinancePayoffsAtDate({
      loans: [loan, expensiveLoan],
      sourceLoanIds: [expensiveLoan.id, loan.id],
      payoffDate: '2026-01-15',
    });
    const pairs = pairRefinanceLoansWithPayoffs({ loans: [loan, expensiveLoan], payoffs });

    expect(pairs.map(({ loan: source, payoff }) => [source.id, payoff.sourceLoanId])).toEqual([
      ['loan-a', 'loan-a'],
      ['loan-b', 'loan-b'],
    ]);
    const balanceById = new Map(
      payoffs.map((payoff) => [payoff.sourceLoanId, payoff.projection.payoffCents]),
    );
    const totalBalance = [...balanceById.values()].reduce((total, value) => total + value, 0);
    const weightedApr = Math.round(
      pairs.reduce(
        (total, pair) =>
          total + pair.loan.annualRateBasisPoints * pair.payoff.projection.payoffCents,
        0,
      ) / totalBalance,
    );
    const expectedApr = Math.round(
      (loan.annualRateBasisPoints * balanceById.get(loan.id)! +
        expensiveLoan.annualRateBasisPoints * balanceById.get(expensiveLoan.id)!) /
        totalBalance,
    );
    const indexPairedApr = Math.round(
      (loan.annualRateBasisPoints * payoffs[0]!.projection.payoffCents +
        expensiveLoan.annualRateBasisPoints * payoffs[1]!.projection.payoffCents) /
        totalBalance,
    );
    expect(weightedApr).toBe(expectedApr);
    expect(weightedApr).not.toBe(indexPairedApr);
    expect(() => pairRefinanceLoansWithPayoffs({ loans: [loan], payoffs })).toThrow(
      /do not match the selected loans/i,
    );
  });

  it('separates financed fees, principal contribution, bank outflow, and excess proceeds', () => {
    expect(
      calculateRefinanceSettlement({
        payoffAmountsCents: [600_000, 400_000],
        newPrincipalCents: 975_000,
        closingCostsCents: 30_000,
        financedFeesCents: 15_000,
      }),
    ).toEqual({
      totalPayoffCents: 1_000_000,
      principalCashContributionCents: 40_000,
      cashPaidClosingCostsCents: 15_000,
      totalBankOutflowCents: 55_000,
      excessProceedsCents: 0,
    });

    expect(
      calculateRefinanceSettlement({
        payoffAmountsCents: [1_000_000],
        newPrincipalCents: 1_115_000,
        closingCostsCents: 20_000,
        financedFeesCents: 15_000,
      }),
    ).toMatchObject({
      totalBankOutflowCents: 5_000,
      excessProceedsCents: 100_000,
    });
  });

  it('makes a committed replacement eligible for a later plan without offering its retired source', () => {
    const first = makePlan({
      id: 'plan-1',
      sourceLoanId: loan.id,
      replacementLoanId: 'loan-b',
      closingDate: '2026-02-15',
      payoffDate: '2026-02-20',
    });
    expect(
      refinanceLoanCandidates({ loans: [loan, first.replacementLoan], plans: [first] }),
    ).toEqual([
      {
        loan: first.replacementLoan,
        availableOn: '2026-02-20',
        sourceRefinancePlanId: 'plan-1',
      },
    ]);
  });

  it('shows upcoming, active, and refinanced-again lifecycle states across a chain', () => {
    const first = makePlan({
      id: 'plan-1',
      sourceLoanId: loan.id,
      replacementLoanId: 'loan-b',
      closingDate: '2026-02-15',
    });
    const second = makePlan({
      id: 'plan-2',
      sourceLoanId: 'loan-b',
      replacementLoanId: 'loan-c',
      closingDate: '2026-08-01',
      firstPaymentDate: '2026-09-15',
      sourceRefinancePlanId: 'plan-1',
    });
    const plans = [first, second];
    expect(refinancePlanLifecycle({ plan: first, plans, asOfDate: '2026-02-01' })).toBe('upcoming');
    expect(refinancePlanLifecycle({ plan: first, plans, asOfDate: '2026-04-01' })).toBe(
      'scheduled-to-refinance',
    );
    expect(refinancePlanLifecycle({ plan: first, plans, asOfDate: '2026-08-01' })).toBe(
      'refinanced-again',
    );

    const naturallyCompleted = makePlan({
      id: 'plan-completed',
      sourceLoanId: loan.id,
      replacementLoanId: 'loan-completed',
      closingDate: '2026-02-15',
    });
    naturallyCompleted.replacementLoan = {
      ...naturallyCompleted.replacementLoan,
      principalCents: 1_000,
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      paymentCents: 1_000,
      nextPaymentDate: '2026-03-15',
      maturityDate: '2026-03-15',
    };
    expect(
      refinancePlanLifecycle({
        plan: naturallyCompleted,
        plans: [naturallyCompleted],
        asOfDate: '2026-03-15',
      }),
    ).toBe('completed');
  });
});
