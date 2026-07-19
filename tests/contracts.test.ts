import { describe, expect, it } from 'vitest';
import { forecastEventSchema } from '@balance-book/domain';
import {
  cancelRefinancePlanRequestSchema,
  commitRefinancePlanRequestSchema,
  dailyCashPointSchema,
  displayStateForForecastEvent,
  forecastDailyEventSchema,
  forecastRequestSchema,
  forecastSnapshotSchema,
  scenarioRequestSchema,
  upsertManagedEntityRequestSchema,
  verticalSliceInputSchema,
} from '../apps/desktop/src/shared/contracts';

describe('desktop request contracts', () => {
  const minimalSetup = {
    balanceAsOf: '2026-07-14',
    accountName: 'Synthetic checking',
    openingBalanceCents: 10_000,
    hardFloorCents: 0,
  };

  it('keeps saved scenarios conservative by default while allowing Overview to request expected mode', () => {
    const request = {
      description: 'Synthetic purchase',
      amountCents: 15_000,
      settlementDate: '2026-07-20',
      fundingType: 'cash' as const,
      accountId: 'synthetic-account',
    };
    expect(scenarioRequestSchema.parse(request).forecastMode).toBe('conservative');
    expect(scenarioRequestSchema.parse({ ...request, forecastMode: 'expected' }).forecastMode).toBe(
      'expected',
    );
  });

  it('allows Charts to request a longer read-only forecast horizon', () => {
    expect(forecastRequestSchema.parse({})).toEqual({});
    expect(forecastRequestSchema.parse({ requiredEndDate: '2027-07-20' })).toEqual({
      requiredEndDate: '2027-07-20',
    });
  });

  it('accepts a first forecast without fabricated optional records', () => {
    expect(verticalSliceInputSchema.parse(minimalSetup)).toEqual(minimalSetup);
    expect(
      verticalSliceInputSchema.parse({ ...minimalSetup, openingBalanceCents: -5_000 }),
    ).toMatchObject({ openingBalanceCents: -5_000 });
  });

  it('requires optional onboarding groups to be complete when started', () => {
    const partialGroups = [
      [{ incomeLabel: 'Synthetic income' }, /complete every income field/i],
      [{ commitmentLabel: 'Synthetic bill' }, /complete every commitment field/i],
      [{ cardName: 'Synthetic card' }, /card identity and policies/i],
    ] as const;
    for (const [partial, message] of partialGroups) {
      expect(() => verticalSliceInputSchema.parse({ ...minimalSetup, ...partial })).toThrow(
        message,
      );
    }
  });

  it('allows a truthful manual card with unknown timing but requires timing for full-statement guidance', () => {
    const manualCard = {
      cardName: 'Synthetic manual card',
      cardEstimateCents: 0,
      cardEstimatePolicy: 'actual-reset' as const,
      cardPaymentPolicy: 'manual' as const,
    };
    expect(verticalSliceInputSchema.parse({ ...minimalSetup, ...manualCard })).toMatchObject(
      manualCard,
    );
    expect(() =>
      verticalSliceInputSchema.parse({
        ...minimalSetup,
        ...manualCard,
        cardPaymentPolicy: 'full-statement',
      }),
    ).toThrow(/complete card timing/i);
    expect(() =>
      verticalSliceInputSchema.parse({
        ...minimalSetup,
        ...manualCard,
        cardPaymentDayOfMonth: 15,
      }),
    ).toThrow(/both source timing days/i);
  });

  it('accepts every onboarding payment policy and requires policy-specific amounts', () => {
    const automaticCard = {
      cardName: 'Synthetic automatic card',
      cardEstimateCents: 10_000,
      cardEstimatePolicy: 'actual-reset' as const,
      cardPaymentDayOfMonth: 15,
      cardStatementCloseDayOfMonth: 25,
    };
    expect(
      verticalSliceInputSchema.parse({
        ...minimalSetup,
        ...automaticCard,
        cardPaymentPolicy: 'full-statement',
      }),
    ).toMatchObject({ cardPaymentPolicy: 'full-statement' });
    expect(
      verticalSliceInputSchema.parse({
        ...minimalSetup,
        ...automaticCard,
        cardPaymentPolicy: 'minimum',
        cardMinimumPaymentCents: 2_500,
      }),
    ).toMatchObject({ cardPaymentPolicy: 'minimum', cardMinimumPaymentCents: 2_500 });
    expect(
      verticalSliceInputSchema.parse({
        ...minimalSetup,
        ...automaticCard,
        cardPaymentPolicy: 'fixed',
        cardFixedPaymentCents: 7_500,
      }),
    ).toMatchObject({ cardPaymentPolicy: 'fixed', cardFixedPaymentCents: 7_500 });
    expect(() =>
      verticalSliceInputSchema.parse({
        ...minimalSetup,
        ...automaticCard,
        cardPaymentPolicy: 'minimum',
      }),
    ).toThrow(/minimum payment policy requires/i);
    expect(() =>
      verticalSliceInputSchema.parse({
        ...minimalSetup,
        ...automaticCard,
        cardPaymentPolicy: 'fixed',
      }),
    ).toThrow(/fixed payment policy requires/i);
  });

  it('rejects card payment policies whose required amount is unresolved', () => {
    const card = {
      id: 'synthetic-card',
      name: 'Synthetic card',
      fundingAccountId: 'synthetic-account',
      defaultFutureStatementCents: 10_000,
      estimatePolicy: 'actual-reset' as const,
    };
    expect(() =>
      upsertManagedEntityRequestSchema.parse({
        entityType: 'credit-card',
        payload: { ...card, paymentPolicy: 'minimum' },
      }),
    ).toThrow(/minimum payment amount is required/i);
    expect(() =>
      upsertManagedEntityRequestSchema.parse({
        entityType: 'credit-card',
        payload: { ...card, paymentPolicy: 'fixed', fixedPaymentCents: 0 },
      }),
    ).toThrow(/positive fixed payment amount is required/i);
  });

  it('rejects closed and scheduled card cycles without a locked statement amount', () => {
    const cycle = {
      id: 'synthetic-cycle',
      cardId: 'synthetic-card',
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-15',
      defaultEstimateCents: 10_000,
      actualActivityCents: 10_000,
      plannedActivityCents: 0,
    };
    for (const state of ['closed-statement', 'scheduled-payment'] as const) {
      expect(() =>
        upsertManagedEntityRequestSchema.parse({
          entityType: 'card-cycle',
          payload: { ...cycle, state },
        }),
      ).toThrow(/locked statement amount is required/i);
    }
  });

  it('accepts an actual card payment above the statement balance', () => {
    expect(
      upsertManagedEntityRequestSchema.parse({
        entityType: 'card-cycle',
        payload: {
          id: 'synthetic-overpaid-cycle',
          cardId: 'synthetic-card',
          opensOn: '2026-06-01',
          closesOn: '2026-06-30',
          dueOn: '2026-07-15',
          paymentOn: '2026-07-15',
          state: 'paid',
          defaultEstimateCents: 10_000,
          actualActivityCents: 10_000,
          plannedActivityCents: 0,
          lockedStatementCents: 10_000,
          actualPaymentCents: 15_000,
        },
      }),
    ).toMatchObject({ payload: { actualPaymentCents: 15_000 } });
  });

  it('requires every cash card payment to identify the card liability it reduces', () => {
    const payment = {
      entityType: 'forecast-event' as const,
      payload: {
        id: 'synthetic-card-payment',
        accountId: 'synthetic-checking',
        date: '2026-07-15',
        kind: 'card-payment' as const,
        direction: 'outflow' as const,
        amountCents: 12_345,
        certainty: 'confirmed' as const,
        status: 'paid' as const,
        label: 'Synthetic card payment',
        paymentMethod: 'cash-account' as const,
        cardId: 'synthetic-card',
      },
    };

    expect(upsertManagedEntityRequestSchema.parse(payment)).toMatchObject(payment);
    expect(() =>
      upsertManagedEntityRequestSchema.parse({
        ...payment,
        payload: { ...payment.payload, cardId: undefined },
      }),
    ).toThrow(/identify the card/i);
    expect(() =>
      upsertManagedEntityRequestSchema.parse({
        ...payment,
        payload: { ...payment.payload, paymentMethod: 'credit-card' },
      }),
    ).toThrow(/cash account/i);
  });

  it('requires new loan payments to carry durable loan lineage while reading legacy rows', () => {
    const payment = {
      entityType: 'forecast-event' as const,
      payload: {
        id: 'synthetic-loan-payment',
        accountId: 'synthetic-checking',
        date: '2026-07-15',
        kind: 'loan-payment' as const,
        direction: 'outflow' as const,
        amountCents: 12_345,
        certainty: 'confirmed' as const,
        status: 'paid' as const,
        label: 'Synthetic loan payment',
        paymentMethod: 'cash-account' as const,
        sourceRecordId: 'synthetic-loan',
      },
    };

    expect(upsertManagedEntityRequestSchema.parse(payment)).toMatchObject(payment);
    expect(() =>
      upsertManagedEntityRequestSchema.parse({
        ...payment,
        payload: { ...payment.payload, sourceRecordId: undefined },
      }),
    ).toThrow(/identify the installment loan/i);

    expect(
      forecastEventSchema.parse({
        ...payment.payload,
        userId: 'legacy-profile',
        sourceRecordId: undefined,
      }),
    ).toMatchObject({ id: payment.payload.id, kind: 'loan-payment' });
  });

  it('makes dated account-balance availability explicit in daily forecast responses', () => {
    const point = {
      date: '2026-07-14',
      conservativeCashCents: 10_000,
      expectedCashCents: 10_000,
      conservativeInTransitCents: 0,
      expectedInTransitCents: 0,
      conservativeReceivableCents: 0,
      expectedReceivableCents: 0,
      conservativePositionCents: 10_000,
      expectedPositionCents: 10_000,
      accountBalances: [
        {
          accountId: 'later-account',
          accountName: 'Later account',
          available: false,
          conservativeCashCents: 0,
          expectedCashCents: 0,
        },
      ],
      events: [],
    };

    expect(dailyCashPointSchema.parse(point).accountBalances[0]?.available).toBe(false);
    expect(() =>
      dailyCashPointSchema.parse({
        ...point,
        accountBalances: [
          {
            accountId: 'later-account',
            accountName: 'Later account',
            conservativeCashCents: 0,
            expectedCashCents: 0,
          },
        ],
      }),
    ).toThrow();
  });

  it('requires dated independent account lows for every card runway response', () => {
    const cardPower = {
      cardId: 'synthetic-card',
      cardName: 'Synthetic card',
      fundingAccountId: 'synthetic-checking',
      fundingAccountName: 'Synthetic checking',
      statementAmountCents: 0,
      currentCycleAmountCents: 0,
      spendingPowerCents: 10_000,
      cashBackedCapacityCents: 10_000,
      spendingPowerStatus: 'determinate' as const,
      prePaymentShortfallCents: 0,
      baselineEstimateSlackCents: 0,
      futurePositionLowCents: 10_000,
      futurePositionLowDate: '2026-08-11',
      futurePositionLowCashCents: 8_000,
      futurePositionLowReceivableCents: 2_000,
      futurePositionLowAccountBalances: [
        {
          accountId: 'synthetic-checking',
          accountName: 'Synthetic checking',
          endingBalanceCents: 8_000,
        },
      ],
      futureAccountLows: [
        {
          accountId: 'synthetic-checking',
          accountName: 'Synthetic checking',
          endingBalanceCents: -500,
          date: '2026-08-12',
        },
      ],
      futureCashLowCents: 8_000,
      futureCashLowDate: '2026-08-11',
      fundingAccountLowCents: -750,
      fundingAccountLowDate: '2026-08-12',
    };

    expect(
      forecastSnapshotSchema.parse({ setupComplete: true, cardSpendingPower: [cardPower] })
        .cardSpendingPower?.[0]?.futureAccountLows,
    ).toEqual(cardPower.futureAccountLows);
    expect(() =>
      forecastSnapshotSchema.parse({
        setupComplete: true,
        cardSpendingPower: [{ ...cardPower, futureAccountLows: undefined }],
      }),
    ).toThrow();
  });

  it('derives and validates explainable daily event states', () => {
    const planned = {
      certainty: 'confirmed' as const,
      status: 'planned' as const,
      hypothetical: false,
    };
    expect(displayStateForForecastEvent({ ...planned, status: 'paid' })).toBe('actual');
    expect(displayStateForForecastEvent({ ...planned, status: 'scheduled' })).toBe('locked');
    expect(displayStateForForecastEvent({ ...planned, certainty: 'expected' })).toBe('estimated');
    expect(displayStateForForecastEvent({ ...planned, hypothetical: true })).toBe('hypothetical');
    expect(displayStateForForecastEvent(planned)).toBe('planned');

    const event = {
      id: 'locked-payment',
      label: 'Synthetic locked payment',
      accountName: 'Checking',
      amountCents: 10_000,
      direction: 'outflow' as const,
      kind: 'card-payment',
      certainty: 'confirmed' as const,
      status: 'scheduled' as const,
      hypothetical: false,
      displayState: 'locked' as const,
      includedInExpected: true,
      includedInConservative: true,
    };
    expect(forecastDailyEventSchema.parse(event)).toEqual(event);
    expect(() => forecastDailyEventSchema.parse({ ...event, displayState: 'estimated' })).toThrow(
      /display state must be locked/i,
    );
  });

  it('accepts a complete effective-dated refinance commitment and rejects unsafe timing', () => {
    const request = {
      id: 'synthetic-refinance',
      name: 'Synthetic refinance',
      closingDate: '2026-09-01',
      payoffDate: '2026-09-03',
      firstPaymentDate: '2026-10-15',
      payoffs: [{ sourceLoanId: 'old-loan', payoffAmountCents: 100_000 }],
      replacementLoan: {
        id: 'replacement-loan',
        name: 'Replacement loan',
        principalCents: 105_000,
        accruedInterestCents: 0,
        balanceDate: '2026-09-01',
        annualRateBasisPoints: 650,
        accrualConvention: 'actual-365' as const,
        paymentCents: 10_000,
        nextPaymentDate: '2026-10-15',
        fundingAccountId: 'checking',
        excludeFromEconomicNetWorthDoubleCount: false,
        paymentFrequency: 'monthly' as const,
        includeInCashForecast: true,
        status: 'active' as const,
      },
      principalCashContributionCents: 0,
      closingCostsCents: 5_000,
      financedFeesCents: 5_000,
      excessProceedsCents: 0,
    };

    expect(commitRefinancePlanRequestSchema.parse(request)).toEqual({
      ...request,
      replacementLoan: {
        ...request.replacementLoan,
        amortizationStructure: 'fully-amortizing',
      },
    });
    expect(() =>
      commitRefinancePlanRequestSchema.parse({
        ...request,
        firstPaymentDate: '2026-09-01',
        replacementLoan: { ...request.replacementLoan, nextPaymentDate: '2026-09-01' },
      }),
    ).toThrow(/first payment/i);
    expect(
      commitRefinancePlanRequestSchema.parse({
        ...request,
        userId: 'must-not-cross-the-trust-boundary',
      }),
    ).not.toHaveProperty('userId');
  });

  it('requires explicit confirmation to cancel a committed refinance', () => {
    expect(
      cancelRefinancePlanRequestSchema.parse({ planId: 'synthetic-refinance', confirmed: true }),
    ).toEqual({ planId: 'synthetic-refinance', confirmed: true });
    expect(() =>
      cancelRefinancePlanRequestSchema.parse({
        planId: 'synthetic-refinance',
        confirmed: false,
      }),
    ).toThrow();
  });
});
