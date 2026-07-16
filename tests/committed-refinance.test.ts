import { describe, expect, it } from 'vitest';
import {
  addDays,
  assetSchema,
  cashAccountSchema,
  cashFloorPolicySchema,
  loanSchema,
  type CashAccount,
  type CommittedRefinancePlan,
  type Loan,
} from '@balance-book/domain';
import {
  analyzeDatedLoanSchedule,
  analyzeLoanContinuationFromPayoff,
  activeLoansForDate,
  buildForecastBundle,
  calculateNetWorth,
  calculateDatedLoanPayment,
  compareRefinance,
  evaluateCommittedRefinanceForecast,
  effectiveAssetsForDate,
  materializeForecastEvents,
  pendingRefinanceSettlementCentsForDate,
  pendingRefinanceEconomicSettlementCentsForDate,
  materializeCommittedRefinanceEvents,
  projectLoanPayoffAtDate,
  projectRefinancePayoffsAtDate,
  resolveCommittedRefinances,
} from '@balance-book/financial-engine';

const userId = 'refinance-owner';
const checking = cashAccountSchema.parse({
  id: 'checking',
  userId,
  name: 'Checking',
  type: 'checking',
  openingBalanceCents: 500_000,
  balanceAsOf: '2026-01-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  hardFloorCents: 0,
  transferDelayDays: 0,
});
const savings = cashAccountSchema.parse({
  ...checking,
  id: 'savings',
  name: 'Savings',
  type: 'savings',
  openingBalanceCents: 100_000,
});

const makeLoan = (overrides: Partial<Loan> & Pick<Loan, 'id' | 'name'>): Loan =>
  loanSchema.parse({
    userId,
    principalCents: 100_000,
    accruedInterestCents: 0,
    balanceDate: '2026-01-01',
    annualRateBasisPoints: 0,
    accrualConvention: 'monthly',
    paymentCents: 10_000,
    nextPaymentDate: '2026-01-05',
    fundingAccountId: checking.id,
    excludeFromEconomicNetWorthDoubleCount: false,
    paymentFrequency: 'monthly',
    includeInCashForecast: true,
    status: 'active',
    ...overrides,
  });

const monthlyLoan = makeLoan({ id: 'monthly-loan', name: 'Monthly loan' });
const biweeklyLoan = makeLoan({
  id: 'biweekly-loan',
  name: 'Biweekly loan',
  paymentFrequency: 'biweekly',
  nextPaymentDate: '2026-01-05',
});

const materialize = (input: {
  loans: Loan[];
  plans: CommittedRefinancePlan[];
  startDate?: '2026-01-01';
  endDate: '2026-02-15' | '2026-04-01';
}) =>
  materializeCommittedRefinanceEvents({
    accounts: [checking, savings],
    events: [],
    cards: [],
    cardCycles: [],
    loans: input.loans,
    plans: input.plans,
    startDate: input.startDate ?? '2026-01-01',
    endDate: input.endDate,
  });

describe('loan payoff at an exact date', () => {
  it('nets excess cash proceeds from refinance cost and fee break-even', () => {
    const comparison = compareRefinance({
      currentPayoffCents: 500_000,
      currentPaymentCents: 50_000,
      currentRemainingPayments: 12,
      newPrincipalCents: 500_000,
      newPaymentCents: 35_000,
      newTermMonths: 18,
      feesCents: 10_000,
      cashAtClosingCents: 0,
      cashProceedsCents: 50_000,
    });

    expect(comparison.currentTotalRemainingCostCents).toBe(600_000);
    expect(comparison.newTotalCostCents).toBe(590_000);
    expect(comparison.totalCostChangeCents).toBe(-10_000);
    expect(comparison.breakEvenMonths).toBe(0);
  });

  it('accrues between monthly payments and retires before a same-day payment executes', () => {
    const interestLoan = makeLoan({
      id: 'interest-loan',
      name: 'Interest loan',
      annualRateBasisPoints: 1_200,
      nextPaymentDate: '2026-01-15',
    });

    const result = projectLoanPayoffAtDate(interestLoan, '2026-02-15');

    expect(result.scheduledPayments).toHaveLength(1);
    expect(result.scheduledPayments[0]).toMatchObject({
      date: '2026-01-15',
      scheduledPaymentCents: 10_000,
      appliedPaymentCents: 10_000,
      interestPaidCents: 467,
      principalPaidCents: 9_533,
      remainingPrincipalCents: 90_467,
    });
    expect(result).toMatchObject({
      payoffDate: '2026-02-15',
      principalCents: 90_467,
      accruedInterestCents: 935,
      payoffCents: 91_402,
    });
  });

  it('applies every prior biweekly payment but not the payment on payoff day', () => {
    const result = projectLoanPayoffAtDate(biweeklyLoan, '2026-02-16');

    expect(result.scheduledPayments.map((payment) => payment.date)).toEqual([
      '2026-01-05',
      '2026-01-19',
      '2026-02-02',
    ]);
    expect(result.payoffCents).toBe(70_000);
  });

  it('prices dated keep-loan schedules and keeps refinance available when lifetime cost is unknown', () => {
    const balloon = makeLoan({
      id: 'current-balloon',
      name: 'Current balloon loan',
      principalCents: 100_000,
      annualRateBasisPoints: 1_200,
      accrualConvention: 'actual-365',
      paymentCents: 1_000,
      nextPaymentDate: '2026-02-01',
      maturityDate: '2026-04-01',
    });
    const dated = analyzeLoanContinuationFromPayoff({
      loan: balloon,
      payoffDate: '2026-01-15',
      payoffAmountCents: 100_000,
    });
    expect(dated).toMatchObject({
      costKnown: true,
      termKnown: true,
      remainingTermMonths: 3,
      residualBalanceCents: 0,
      paidOffDate: '2026-04-01',
    });
    expect(dated.maturityPaymentCents).toBeGreaterThan(90_000);
    expect(dated.remainingInterestCents).toBeGreaterThan(0);

    const bulletAfterPayoff = analyzeLoanContinuationFromPayoff({
      loan: makeLoan({
        id: 'current-bullet-after-payoff',
        name: 'Current bullet after payoff',
        principalCents: 100_000,
        annualRateBasisPoints: 1_200,
        accrualConvention: 'actual-365',
        paymentCents: 0,
        nextPaymentDate: '2026-05-01',
        maturityDate: '2026-04-01',
      }),
      payoffDate: '2026-01-15',
      payoffAmountCents: 100_000,
    });
    expect(bulletAfterPayoff).toMatchObject({
      costKnown: true,
      termKnown: true,
      paidOffDate: '2026-04-01',
      residualBalanceCents: 0,
    });
    expect(bulletAfterPayoff.maturityPaymentCents).toBeGreaterThan(100_000);

    const openEndedInterestOnly = makeLoan({
      id: 'current-interest-only',
      name: 'Current interest-only loan',
      principalCents: 100_000,
      annualRateBasisPoints: 1_200,
      paymentCents: 1_000,
      nextPaymentDate: '2026-02-01',
      maturityDate: undefined,
    });
    expect(
      analyzeLoanContinuationFromPayoff({
        loan: openEndedInterestOnly,
        payoffDate: '2026-01-15',
        payoffAmountCents: 100_000,
      }),
    ).toMatchObject({
      costKnown: false,
      termKnown: false,
      remainingInterestCents: null,
      remainingTermMonths: null,
    });
  });

  it('applies a scheduled payoff-day payment before continuing monthly and biweekly loans', () => {
    const cases = [
      {
        loan: makeLoan({
          id: 'monthly-payoff-day-continuation',
          name: 'Monthly payoff-day continuation',
          principalCents: 200_000,
          annualRateBasisPoints: 900,
          accrualConvention: 'actual-365',
          paymentCents: 25_000,
          nextPaymentDate: '2026-01-15',
          maturityDate: '2026-06-15',
        }),
        payoffDate: '2026-03-15' as const,
        followingPaymentDate: '2026-04-15' as const,
      },
      {
        loan: makeLoan({
          id: 'biweekly-payoff-day-continuation',
          name: 'Biweekly payoff-day continuation',
          principalCents: 200_000,
          annualRateBasisPoints: 900,
          accrualConvention: 'actual-365',
          paymentCents: 15_000,
          nextPaymentDate: '2026-01-05',
          maturityDate: '2026-04-13',
          paymentFrequency: 'biweekly',
        }),
        payoffDate: '2026-02-16' as const,
        followingPaymentDate: '2026-03-02' as const,
      },
    ];

    for (const { loan, payoffDate, followingPaymentDate } of cases) {
      const payoffAmountCents = projectLoanPayoffAtDate(loan, payoffDate).payoffCents;
      const continuation = analyzeLoanContinuationFromPayoff({
        loan,
        payoffDate,
        payoffAmountCents,
      });
      const payoffDayPayment = projectLoanPayoffAtDate(
        loan,
        addDays(payoffDate, 1),
      ).scheduledPayments.find((payment) => payment.date === payoffDate)!;
      const tail = analyzeDatedLoanSchedule(
        makeLoan({
          ...loan,
          principalCents: payoffDayPayment.remainingPrincipalCents,
          accruedInterestCents: payoffDayPayment.remainingAccruedInterestCents,
          balanceDate: payoffDate,
          nextPaymentDate: followingPaymentDate,
        }),
      );

      expect(continuation.totalPaymentsCents).toBe(
        payoffDayPayment.appliedPaymentCents + tail.totalPaymentsCents,
      );
      expect(continuation.remainingInterestCents).toBe(
        continuation.totalPaymentsCents - payoffAmountCents,
      );
      expect(continuation.paidOffDate).toBe(tail.paidOffDate);
    }

    const shortLoan = makeLoan({
      id: 'short-payoff-day-loan',
      name: 'Short payoff-day loan',
      principalCents: 500,
      annualRateBasisPoints: 0,
      paymentCents: 1_000,
      nextPaymentDate: '2026-01-05',
      maturityDate: '2026-02-05',
    });
    expect(
      analyzeLoanContinuationFromPayoff({
        loan: shortLoan,
        payoffDate: '2026-01-05',
        payoffAmountCents: 700,
      }),
    ).toMatchObject({
      totalPaymentsCents: 700,
      paidOffDate: '2026-02-05',
      maturityPaymentCents: 200,
    });
  });

  it('reports remaining term in calendar months across a leap year', () => {
    expect(
      analyzeLoanContinuationFromPayoff({
        loan: makeLoan({
          id: 'calendar-term-loan',
          name: 'Calendar term loan',
          principalCents: 100_000,
          annualRateBasisPoints: 0,
          paymentCents: 0,
          balanceDate: '2024-01-01',
          nextPaymentDate: '2025-02-01',
          maturityDate: '2025-01-01',
        }),
        payoffDate: '2024-01-01',
        payoffAmountCents: 100_000,
      }),
    ).toMatchObject({
      costKnown: true,
      remainingTermMonths: 12,
      paidOffDate: '2025-01-01',
    });
  });

  it('builds plural payoff defaults at the selected date', () => {
    const payoffs = projectRefinancePayoffsAtDate({
      loans: [monthlyLoan, biweeklyLoan],
      sourceLoanIds: [monthlyLoan.id, biweeklyLoan.id],
      payoffDate: '2026-01-20',
    });

    expect(
      payoffs.map(({ sourceLoanId, payoffAmountCents, projection }) => ({
        sourceLoanId,
        payoffAmountCents,
        payments: projection.scheduledPayments.map((payment) => payment.date),
      })),
    ).toEqual([
      { sourceLoanId: monthlyLoan.id, payoffAmountCents: 90_000, payments: ['2026-01-05'] },
      {
        sourceLoanId: biweeklyLoan.id,
        payoffAmountCents: 80_000,
        payments: ['2026-01-05', '2026-01-19'],
      },
    ]);
  });

  it('caps an early final payment and makes any maturity residual an explicit balloon', () => {
    const cappedLoan = makeLoan({
      id: 'capped-loan',
      name: 'Capped loan',
      principalCents: 15_000,
      paymentCents: 10_000,
      maturityDate: '2026-03-05',
    });
    const balloonLoan = makeLoan({
      id: 'balloon-loan',
      name: 'Balloon loan',
      principalCents: 25_000,
      paymentCents: 10_000,
      maturityDate: '2026-02-05',
    });
    const events = materializeForecastEvents({
      accounts: [checking],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [cappedLoan, balloonLoan],
      startDate: '2026-01-01',
      endDate: '2026-03-05',
    });

    expect(
      events
        .filter((event) => event.sourceRecordId === cappedLoan.id)
        .map((event) => ({ date: event.date, amountCents: event.amountCents })),
    ).toEqual([
      { date: '2026-01-05', amountCents: 10_000 },
      { date: '2026-02-05', amountCents: 5_000 },
    ]);
    expect(
      events
        .filter((event) => event.sourceRecordId === balloonLoan.id)
        .map((event) => ({ date: event.date, amountCents: event.amountCents, label: event.label })),
    ).toEqual([
      { date: '2026-01-05', amountCents: 10_000, label: 'Balloon loan payment' },
      { date: '2026-02-05', amountCents: 15_000, label: 'Balloon loan maturity payment' },
    ]);
    expect(projectLoanPayoffAtDate(balloonLoan, '2026-02-05').payoffCents).toBe(15_000);
    expect(projectLoanPayoffAtDate(balloonLoan, '2026-02-06').payoffCents).toBe(0);
    expect(
      activeLoansForDate({
        accounts: [checking],
        loans: [balloonLoan],
        plans: [],
        date: '2026-02-06',
      }),
    ).toEqual([]);
  });

  it('forecasts bullet maturity debt and accrued-interest-only obligations', () => {
    const bulletLoan = makeLoan({
      id: 'bullet-loan',
      name: 'Bullet loan',
      principalCents: 25_000,
      accruedInterestCents: 1_000,
      paymentCents: 0,
      maturityDate: '2026-01-20',
    });
    const accruedOnlyLoan = makeLoan({
      id: 'accrued-only-loan',
      name: 'Accrued-only loan',
      principalCents: 0,
      accruedInterestCents: 2_500,
      paymentCents: 1_000,
      nextPaymentDate: '2026-01-05',
    });
    const payments = materializeForecastEvents({
      accounts: [checking],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [bulletLoan, accruedOnlyLoan],
      receivables: [],
      startDate: '2026-01-01',
      endDate: '2026-02-05',
    }).filter((event) => event.kind === 'loan-payment');

    expect(payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'loan-payment-bullet-loan@2026-01-20',
          amountCents: 26_000,
        }),
        expect.objectContaining({
          id: 'loan-payment-accrued-only-loan@2026-01-05',
          amountCents: 1_000,
        }),
        expect.objectContaining({
          id: 'loan-payment-accrued-only-loan@2026-02-05',
          amountCents: 1_000,
        }),
      ]),
    );
  });

  it('ignores a future loan whose balance date is beyond the requested dashboard horizon', () => {
    const futureLoan = makeLoan({
      id: 'future-loan',
      name: 'Future replacement loan',
      balanceDate: '2027-01-15',
      nextPaymentDate: '2027-02-15',
    });

    expect(
      materializeForecastEvents({
        accounts: [checking],
        events: [],
        cards: [],
        cardCycles: [],
        loans: [futureLoan],
        receivables: [],
        startDate: '2026-01-01',
        endDate: '2026-04-01',
      }).filter((event) => event.kind === 'loan-payment'),
    ).toEqual([]);
  });

  it('calculates a no-balloon payment from the exact dates and accrual convention', () => {
    for (const accrualConvention of ['actual-365', 'actual-360', 'monthly'] as const) {
      const template = makeLoan({
        id: `dated-${accrualConvention}`,
        name: `Dated ${accrualConvention}`,
        principalCents: 1_000_000,
        annualRateBasisPoints: 1_200,
        accrualConvention,
        balanceDate: '2026-01-01',
        nextPaymentDate: '2026-04-01',
        maturityDate: '2027-03-01',
        paymentCents: 1,
      });
      const paymentCents = calculateDatedLoanPayment(template);
      const exact = analyzeDatedLoanSchedule({ ...template, paymentCents });
      const oneCentTooLow = analyzeDatedLoanSchedule({
        ...template,
        paymentCents: paymentCents - 1,
      });

      expect(exact.balloonCents).toBe(0);
      expect(exact.totalPaymentsCents).toBe(template.principalCents + exact.remainingInterestCents);
      expect(oneCentTooLow.balloonCents).toBeGreaterThan(0);
      expect(exact.payments[0]?.date).toBe('2026-04-01');
    }
  });
});

describe('committed refinance mechanics', () => {
  const replacementLoan = makeLoan({
    id: 'replacement-loan',
    name: 'Replacement loan',
    principalCents: 214_000,
    balanceDate: '2026-01-10',
    originalDate: '2026-01-10',
    originalPrincipalCents: 214_000,
    annualRateBasisPoints: 500,
    paymentCents: 20_000,
    nextPaymentDate: '2026-02-15',
    maturityDate: '2028-01-15',
    fundingAccountId: checking.id,
  });
  const plan: CommittedRefinancePlan = {
    id: 'first-refinance',
    userId,
    name: 'Consolidation refinance',
    status: 'committed',
    closingDate: '2026-01-10',
    payoffDate: '2026-01-20',
    firstPaymentDate: '2026-02-15',
    payoffs: [
      { sourceLoanId: monthlyLoan.id, payoffAmountCents: 150_000 },
      { sourceLoanId: biweeklyLoan.id, payoffAmountCents: 50_000 },
    ],
    replacementLoan,
    principalCashContributionCents: 20_000,
    closingCostsCents: 10_000,
    financedFeesCents: 4_000,
    cashSourceAccountId: checking.id,
    excessProceedsCents: 30_000,
    excessProceedsAccountId: savings.id,
  };

  it('validates settlement identity and exposes actual bank cash at closing', () => {
    const resolved = resolveCommittedRefinances({
      accounts: [checking, savings],
      loans: [monthlyLoan, biweeklyLoan, replacementLoan],
      plans: [plan],
    });

    expect(resolved.plans[0]).toMatchObject({
      totalPayoffCents: 200_000,
      unfinancedClosingCostsCents: 6_000,
      bankOutflowAtClosingCents: 26_000,
    });

    expect(() =>
      resolveCommittedRefinances({
        accounts: [checking, savings],
        loans: [monthlyLoan, biweeklyLoan, replacementLoan],
        plans: [
          {
            ...plan,
            payoffDate: plan.closingDate,
            firstPaymentDate: plan.closingDate,
            replacementLoan: loanSchema.parse({
              ...replacementLoan,
              nextPaymentDate: plan.closingDate,
            }),
          },
        ],
      }),
    ).toThrow(/first payment must be after the refinance closing date/i);

    expect(() =>
      resolveCommittedRefinances({
        accounts: [checking, savings],
        loans: [{ ...monthlyLoan, maturityDate: '2026-01-05' }, biweeklyLoan, replacementLoan],
        plans: [plan],
      }),
    ).toThrow(/no modeled debt/i);

    expect(() =>
      resolveCommittedRefinances({
        accounts: [checking, savings],
        loans: [{ ...monthlyLoan, includeInCashForecast: false }, biweeklyLoan, replacementLoan],
        plans: [plan],
      }),
    ).toThrow(/payments must be included in the cash forecast/i);
  });

  it('keeps secured-asset linkage effective-dated before a future closing', () => {
    const relinkedPlan: CommittedRefinancePlan = {
      ...plan,
      assetRelinks: [
        {
          assetId: 'secured-asset',
          sourceLoanId: monthlyLoan.id,
          replacementLoanId: replacementLoan.id,
        },
      ],
    };
    const persistedAsset = assetSchema.parse({
      id: 'secured-asset',
      userId,
      name: 'Secured asset',
      type: 'tangible',
      valueCents: 500_000,
      valuationDate: '2026-01-01',
      linkedLiabilityId: replacementLoan.id,
      includedInNetWorth: true,
      includedInLiquidity: false,
    });

    expect(
      effectiveAssetsForDate({
        assets: [persistedAsset],
        plans: [relinkedPlan],
        date: '2026-01-09',
      })[0]?.linkedLiabilityId,
    ).toBe(monthlyLoan.id);
    expect(
      effectiveAssetsForDate({
        assets: [persistedAsset],
        plans: [relinkedPlan],
        date: '2026-01-10',
      })[0]?.linkedLiabilityId,
    ).toBe(replacementLoan.id);
  });

  it('keeps old payments before payoff, posts closing cash, and starts the new loan on time', () => {
    const events = materialize({
      loans: [monthlyLoan, biweeklyLoan, replacementLoan],
      plans: [plan],
      endDate: '2026-02-15',
    });
    const loanPayments = events
      .filter((event) => event.kind === 'loan-payment')
      .map((event) => event.id);

    expect(loanPayments).toEqual([
      'loan-payment-monthly-loan@2026-01-05',
      'loan-payment-biweekly-loan@2026-01-05',
      'loan-payment-biweekly-loan@2026-01-19',
      'loan-payment-replacement-loan@2026-02-15',
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'refinance-closing-cash-first-refinance',
          accountId: checking.id,
          date: '2026-01-10',
          direction: 'outflow',
          amountCents: 26_000,
          hypothetical: false,
        }),
        expect.objectContaining({
          id: 'refinance-excess-proceeds-first-refinance',
          accountId: savings.id,
          date: '2026-01-10',
          direction: 'inflow',
          amountCents: 30_000,
          hypothetical: false,
        }),
      ]),
    );

    const forecast = buildForecastBundle({
      accounts: [checking, savings],
      events,
      policy: {
        hardConsolidatedFloorCents: 0,
        horizonDays: 46,
        includeConfirmedReceivablesConservatively: true,
      },
      startDate: '2026-01-01',
      endDate: '2026-02-15',
    });
    expect(forecast.expected.days.at(-1)?.consolidatedCashCents).toBe(554_000);
  });

  it('allows the new payment schedule to begin before a delayed source payoff', () => {
    const overlappingPlan: CommittedRefinancePlan = {
      ...plan,
      id: 'overlapping-refinance',
      payoffDate: '2026-02-01',
      firstPaymentDate: '2026-01-15',
      replacementLoan: {
        ...replacementLoan,
        id: 'overlapping-replacement',
        nextPaymentDate: '2026-01-15',
      },
    };
    const events = materialize({
      loans: [monthlyLoan, biweeklyLoan, overlappingPlan.replacementLoan],
      plans: [overlappingPlan],
      endDate: '2026-02-15',
    });
    const paymentIds = events
      .filter((event) => event.kind === 'loan-payment')
      .map((event) => event.id);

    expect(paymentIds).toEqual(
      expect.arrayContaining([
        'loan-payment-overlapping-replacement@2026-01-15',
        'loan-payment-biweekly-loan@2026-01-19',
      ]),
    );
    expect(paymentIds).not.toContain('loan-payment-biweekly-loan@2026-02-02');

    const evaluation = evaluateCommittedRefinanceForecast({
      accounts: [checking, savings],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [monthlyLoan, biweeklyLoan],
      receivables: [],
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        horizonDays: 10,
        includeConfirmedReceivablesConservatively: true,
      }),
      requestedStartDate: '2026-01-01',
      plan: overlappingPlan,
    });
    expect(evaluation.endDate).toBe('2026-02-01');
    expect(evaluation.proposed.expected.days.flatMap((day) => day.appliedEventIds)).toEqual(
      expect.arrayContaining([
        'loan-payment-overlapping-replacement@2026-01-15',
        'loan-payment-biweekly-loan@2026-01-19',
      ]),
    );
  });

  it('previews the canonical plural-payoff plan through the delayed first payment', () => {
    const evaluation = evaluateCommittedRefinanceForecast({
      accounts: [checking, savings],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [monthlyLoan, biweeklyLoan],
      receivables: [],
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        horizonDays: 10,
        includeConfirmedReceivablesConservatively: true,
      }),
      requestedStartDate: '2026-01-01',
      plan,
    });

    expect(evaluation).toMatchObject({
      startDate: '2026-01-01',
      originalHorizonEndDate: '2026-01-10',
      endDate: '2026-02-15',
      horizonExtended: true,
      firstReplacementPaymentEventId: 'loan-payment-replacement-loan@2026-02-15',
      closingCashEventIds: [
        'refinance-excess-proceeds-first-refinance',
        'refinance-closing-cash-first-refinance',
      ],
    });
    expect(evaluation.baseline.expected.days.flatMap((day) => day.appliedEventIds)).toContain(
      'loan-payment-monthly-loan@2026-02-05',
    );
    expect(evaluation.proposed.expected.days.flatMap((day) => day.appliedEventIds)).not.toContain(
      'loan-payment-monthly-loan@2026-02-05',
    );

    expect(() =>
      evaluateCommittedRefinanceForecast({
        accounts: [{ ...checking, balanceAsOf: plan.closingDate }, savings],
        events: [],
        cards: [],
        cardCycles: [],
        loans: [monthlyLoan, biweeklyLoan],
        receivables: [],
        policy: cashFloorPolicySchema.parse({
          hardConsolidatedFloorCents: 0,
          horizonDays: 10,
          includeConfirmedReceivablesConservatively: true,
        }),
        requestedStartDate: plan.closingDate,
        plan,
      }),
    ).toThrow(/closing cash must occur after/i);

    const farFuturePlan: CommittedRefinancePlan = {
      ...plan,
      id: 'far-future-plan',
      closingDate: '2037-01-02',
      payoffDate: '2037-01-03',
      firstPaymentDate: '2037-02-02',
      replacementLoan: {
        ...plan.replacementLoan,
        id: 'far-future-replacement',
        balanceDate: '2037-01-02',
        originalDate: '2037-01-02',
        nextPaymentDate: '2037-02-02',
        maturityDate: '2040-01-02',
      },
    };
    expect(() =>
      evaluateCommittedRefinanceForecast({
        accounts: [checking, savings],
        events: [],
        cards: [],
        cardCycles: [],
        loans: [monthlyLoan, biweeklyLoan],
        receivables: [],
        policy: cashFloorPolicySchema.parse({
          hardConsolidatedFloorCents: 0,
          horizonDays: 10,
          includeConfirmedReceivablesConservatively: true,
        }),
        requestedStartDate: '2026-01-01',
        plan: farFuturePlan,
      }),
    ).toThrow(/within 10 years/i);
  });

  it('switches the debt portfolio on the effective closing and payoff dates', () => {
    const input = {
      accounts: [checking, savings] as CashAccount[],
      loans: [monthlyLoan, biweeklyLoan, replacementLoan],
      plans: [plan],
    };
    expect(activeLoansForDate({ ...input, date: '2026-01-09' }).map((loan) => loan.id)).toEqual([
      monthlyLoan.id,
      biweeklyLoan.id,
    ]);
    expect(activeLoansForDate({ ...input, date: '2026-01-10' }).map((loan) => loan.id)).toEqual([
      monthlyLoan.id,
      biweeklyLoan.id,
      replacementLoan.id,
    ]);
    expect(pendingRefinanceSettlementCentsForDate({ plans: [plan], date: '2026-01-10' })).toBe(
      200_000,
    );
    expect(pendingRefinanceSettlementCentsForDate({ plans: [plan], date: '2026-01-20' })).toBe(0);
    expect(
      pendingRefinanceEconomicSettlementCentsForDate({
        plans: [plan],
        loans: [
          { ...monthlyLoan, excludeFromEconomicNetWorthDoubleCount: true },
          biweeklyLoan,
          replacementLoan,
        ],
        date: '2026-01-10',
      }),
    ).toBe(50_000);
    const closingLoans = activeLoansForDate({ ...input, date: '2026-01-10' });
    const closingNetWorth = calculateNetWorth({
      cashAccounts: [checking, savings],
      assets: [],
      receivables: [],
      loans: closingLoans,
      allCashCentsOverride: 584_000,
      restrictedRefinanceSettlementCents: 200_000,
    });
    expect(closingNetWorth.contractualLiabilitiesCents).toBe(394_000);
    expect(closingNetWorth.contractualNetWorthCents).toBe(390_000);
    expect(activeLoansForDate({ ...input, date: '2026-01-20' }).map((loan) => loan.id)).toEqual([
      replacementLoan.id,
    ]);
  });

  it('allows a replacement loan to be refinanced later without overlapping payments', () => {
    const secondReplacement = makeLoan({
      id: 'second-replacement',
      name: 'Second replacement',
      principalCents: 195_000,
      balanceDate: '2026-03-01',
      originalDate: '2026-03-01',
      originalPrincipalCents: 195_000,
      paymentCents: 15_000,
      nextPaymentDate: '2026-04-01',
    });
    const secondPlan: CommittedRefinancePlan = {
      id: 'second-refinance',
      userId,
      name: 'Later refinance',
      status: 'committed',
      closingDate: '2026-03-01',
      payoffDate: '2026-03-01',
      firstPaymentDate: '2026-04-01',
      payoffs: [
        {
          sourceLoanId: replacementLoan.id,
          payoffAmountCents: 190_000,
          sourceRefinancePlanId: plan.id,
        },
      ],
      replacementLoan: secondReplacement,
      principalCashContributionCents: 0,
      closingCostsCents: 5_000,
      financedFeesCents: 5_000,
      excessProceedsCents: 0,
    };

    expect(() =>
      resolveCommittedRefinances({
        accounts: [checking, savings],
        loans: [monthlyLoan, biweeklyLoan, replacementLoan, secondReplacement],
        plans: [plan, { ...secondPlan, closingDate: plan.payoffDate }],
      }),
    ).toThrow(/close after its source payoff/i);

    const events = materialize({
      loans: [monthlyLoan, biweeklyLoan, replacementLoan, secondReplacement],
      plans: [plan, secondPlan],
      endDate: '2026-04-01',
    });
    const replacementPayments = events
      .filter((event) => event.kind === 'loan-payment')
      .filter((event) =>
        [replacementLoan.id, secondReplacement.id].includes(event.sourceRecordId ?? ''),
      )
      .map((event) => event.id);
    expect(replacementPayments).toEqual([
      'loan-payment-replacement-loan@2026-02-15',
      'loan-payment-second-replacement@2026-04-01',
    ]);
    expect(
      projectLoanPayoffAtDate(replacementLoan, secondPlan.payoffDate).scheduledPayments.map(
        (payment) => payment.date,
      ),
    ).toEqual(['2026-02-15']);
    expect(
      activeLoansForDate({
        accounts: [checking, savings],
        loans: [monthlyLoan, biweeklyLoan, replacementLoan, secondReplacement],
        plans: [plan, secondPlan],
        date: '2026-04-01',
      }).map((loan) => loan.id),
    ).toEqual([secondReplacement.id]);

    const stackedPreview = evaluateCommittedRefinanceForecast({
      accounts: [checking, savings],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [monthlyLoan, biweeklyLoan, replacementLoan],
      receivables: [],
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        horizonDays: 10,
        includeConfirmedReceivablesConservatively: true,
      }),
      requestedStartDate: '2026-02-01',
      existingPlans: [plan],
      plan: secondPlan,
    });
    const baselineIds = stackedPreview.baseline.expected.days.flatMap((day) => day.appliedEventIds);
    const proposedIds = stackedPreview.proposed.expected.days.flatMap((day) => day.appliedEventIds);
    expect(baselineIds).toContain('loan-payment-replacement-loan@2026-03-15');
    expect(proposedIds).not.toContain('loan-payment-replacement-loan@2026-03-15');
    expect(proposedIds).toContain('loan-payment-second-replacement@2026-04-01');
    expect(stackedPreview.baseline.expected.days[0]?.consolidatedCashCents).toBe(574_000);
  });

  it('validates proposal economics but permits the committed loan balance to change later', () => {
    const updatedReplacement = loanSchema.parse({
      ...replacementLoan,
      principalCents: replacementLoan.principalCents - 25_000,
      balanceDate: '2026-02-15',
      nextPaymentDate: '2026-03-15',
    });
    expect(
      resolveCommittedRefinances({
        accounts: [checking, savings],
        loans: [monthlyLoan, biweeklyLoan, updatedReplacement],
        plans: [
          {
            ...plan,
            replacementLoan: updatedReplacement,
          },
        ],
      }).loans.find((loan) => loan.id === replacementLoan.id)?.principalCents,
    ).toBe(189_000);

    expect(() =>
      evaluateCommittedRefinanceForecast({
        accounts: [checking, savings],
        events: [],
        cards: [],
        cardCycles: [],
        loans: [monthlyLoan, biweeklyLoan],
        receivables: [],
        policy: cashFloorPolicySchema.parse({
          hardConsolidatedFloorCents: 0,
          horizonDays: 10,
          includeConfirmedReceivablesConservatively: true,
        }),
        requestedStartDate: '2026-01-01',
        plan: {
          ...plan,
          replacementLoan: loanSchema.parse({
            ...replacementLoan,
            principalCents: replacementLoan.principalCents + 1,
          }),
        },
      }),
    ).toThrow(/principal/i);
  });

  it('rejects attempts to retire one loan twice', () => {
    expect(() =>
      resolveCommittedRefinances({
        accounts: [checking, savings],
        loans: [monthlyLoan, biweeklyLoan, replacementLoan],
        plans: [
          plan,
          {
            ...plan,
            id: 'duplicate-payoff-plan',
            replacementLoan: loanSchema.parse({
              ...replacementLoan,
              id: 'duplicate-payoff-replacement',
            }),
          },
        ],
      }),
    ).toThrow(/already retired/i);
  });
});
