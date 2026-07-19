import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  type Asset,
  type CashAccount,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
  type Loan,
  type Receivable,
} from '@balance-book/domain';
import {
  applyReceivableSettlement,
  assignPurchaseToCycle,
  buildForecast,
  buildForecastBundle,
  calculateCardSpendingPower,
  calculateCardPurchaseCashImpact,
  calculateNetWorth,
  compareRefinance,
  evaluateScenarios,
  expandRecurrence,
  findDoubleCountRisks,
  levelMonthlyPaymentCents,
  materializeForecastEvents,
  projectReceivableBalances,
  projectedCycleObligation,
  projectLoanPayoff,
  scheduledCardPayment,
  sharedExpenseEconomics,
} from '@balance-book/financial-engine';

const userId = 'synthetic-user';

const account = (overrides: Partial<CashAccount> = {}): CashAccount =>
  cashAccountSchema.parse({
    id: 'cash-primary',
    userId,
    name: 'Primary cash',
    type: 'checking',
    openingBalanceCents: 100_000,
    balanceAsOf: '2026-01-01',
    includedInLiquidity: true,
    canFundOtherAccounts: true,
    hardFloorCents: 0,
    transferDelayDays: 0,
    ...overrides,
  });

const event = (overrides: Partial<ForecastEvent> & Pick<ForecastEvent, 'id'>): ForecastEvent =>
  forecastEventSchema.parse({
    userId,
    accountId: 'cash-primary',
    date: '2026-01-05',
    kind: 'direct-commitment',
    direction: 'outflow',
    amountCents: 10_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Synthetic event',
    hypothetical: false,
    accepted: false,
    ...overrides,
  });

const policy = (overrides: Record<string, unknown> = {}) =>
  cashFloorPolicySchema.parse({
    hardConsolidatedFloorCents: 0,
    preferredConsolidatedFloorCents: 20_000,
    horizonDays: 90,
    includeConfirmedReceivablesConservatively: true,
    ...overrides,
  });

const forecast = (events: ForecastEvent[], overrides: { accounts?: CashAccount[] } = {}) =>
  buildForecast({
    accounts: overrides.accounts ?? [account()],
    events,
    policy: policy(),
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    mode: 'conservative',
  });

describe('native schedule materialization', () => {
  it('expands recurring cash, replaces card estimates with locked statements, and schedules loans', () => {
    const cash = account();
    const card = creditCardSchema.parse({
      id: 'card-native',
      userId,
      name: 'Native card',
      fundingAccountId: cash.id,
      defaultFutureStatementCents: 12_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 20,
    });
    const cycle = creditCardCycleSchema.parse({
      id: 'cycle-native',
      cardId: card.id,
      opensOn: '2025-12-21',
      closesOn: '2026-01-20',
      dueOn: '2026-02-15',
      paymentOn: '2026-02-14',
      state: 'scheduled-payment',
      defaultEstimateCents: 12_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 18_765,
    });
    const loan: Loan = {
      id: 'loan-native',
      userId,
      name: 'Native loan',
      principalCents: 500_000,
      accruedInterestCents: 0,
      balanceDate: '2026-01-01',
      annualRateBasisPoints: 600,
      accrualConvention: 'actual-365',
      paymentCents: 25_000,
      nextPaymentDate: '2026-02-28',
      amortizationStructure: 'fully-amortizing',
      fundingAccountId: cash.id,
      excludeFromEconomicNetWorthDoubleCount: false,
      paymentFrequency: 'monthly',
      includeInCashForecast: true,
      status: 'active',
    };
    const scheduled = materializeForecastEvents({
      accounts: [cash],
      events: [
        event({
          id: 'monthly-rent',
          date: '2026-01-31',
          amountCents: 90_000,
          recurrenceRule: { frequency: 'monthly', dayOfMonth: 31, interval: 1 },
        }),
        event({
          id: 'card-subscription',
          cardId: card.id,
          paymentMethod: 'credit-card',
          date: '2026-01-08',
          amountCents: 2_100,
          recurrenceRule: { frequency: 'monthly', dayOfMonth: 8, interval: 1 },
        }),
      ],
      cards: [card],
      cardCycles: [cycle],
      loans: [loan],
      startDate: '2026-02-01',
      endDate: '2026-03-31',
    });
    expect(
      scheduled.filter((item) => item.sourceRecordId === 'monthly-rent').map((item) => item.date),
    ).toEqual(['2026-02-28', '2026-03-31']);
    expect(scheduled.find((item) => item.id === 'card-payment-cycle-native')).toMatchObject({
      date: '2026-02-14',
      amountCents: 18_765,
    });
    expect(
      scheduled.filter((item) => item.kind === 'loan-payment').map((item) => item.date),
    ).toEqual(['2026-02-28', '2026-03-28']);
    expect(scheduled.some((item) => item.id.startsWith('card-subscription'))).toBe(false);
  });

  it('rolls active card-funded records into stored cycles once and excludes inactive activity', () => {
    const cash = account();
    const card = creditCardSchema.parse({
      id: 'card-with-records',
      userId,
      name: 'Card with detailed records',
      fundingAccountId: cash.id,
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      paymentDayOfMonth: 10,
      statementCloseDayOfMonth: 31,
    });
    const openCycle = creditCardCycleSchema.parse({
      id: 'stored-open-cycle',
      cardId: card.id,
      opensOn: '2026-01-01',
      closesOn: '2026-01-31',
      dueOn: '2026-02-10',
      state: 'open',
      defaultEstimateCents: 0,
      actualActivityCents: 500,
      plannedActivityCents: 200,
      projectionOverrideCents: 900,
    });
    const futureCycle = creditCardCycleSchema.parse({
      id: 'stored-future-cycle',
      cardId: card.id,
      opensOn: '2026-02-01',
      closesOn: '2026-02-28',
      dueOn: '2026-03-10',
      state: 'future-estimated',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 100,
    });
    const activities = [
      event({
        id: 'recurring-card-record',
        cardId: card.id,
        paymentMethod: 'credit-card',
        date: '2026-01-05',
        amountCents: 300,
        recurrenceRule: { frequency: 'monthly', dayOfMonth: 5, interval: 1 },
      }),
      event({
        id: 'one-time-card-record',
        cardId: card.id,
        paymentMethod: 'credit-card',
        date: '2026-01-20',
        amountCents: 250,
      }),
      event({
        id: 'already-in-cycle-total',
        cardId: card.id,
        paymentMethod: 'credit-card',
        cardActivityTreatment: 'included-in-cycle-total',
        date: '2026-01-25',
        amountCents: 7_777,
      }),
      event({
        id: 'cancelled-card-record',
        cardId: card.id,
        paymentMethod: 'credit-card',
        date: '2026-01-20',
        amountCents: 9_999,
        status: 'cancelled',
      }),
      event({
        id: 'skipped-card-record',
        cardId: card.id,
        paymentMethod: 'credit-card',
        date: '2026-02-20',
        amountCents: 8_888,
        status: 'skipped',
      }),
    ];
    expect(activities[0]?.cardActivityTreatment).toBe('additional');
    const scheduled = materializeForecastEvents({
      accounts: [cash],
      events: activities,
      cards: [card],
      cardCycles: [openCycle, futureCycle],
      loans: [],
      startDate: '2026-01-15',
      endDate: '2026-03-15',
    });

    expect(projectedCycleObligation(card, openCycle)).toBe(900);
    expect(scheduled.filter((item) => item.kind === 'card-payment')).toMatchObject([
      { id: 'card-payment-stored-open-cycle', amountCents: 1_450, date: '2026-02-10' },
      { id: 'card-payment-stored-future-cycle', amountCents: 400, date: '2026-03-10' },
    ]);
    expect(
      scheduled.some((item) =>
        [
          'recurring-card-record',
          'one-time-card-record',
          'already-in-cycle-total',
          'cancelled-card-record',
          'skipped-card-record',
        ].some((id) => item.id.startsWith(id)),
      ),
    ).toBe(false);

    const overview = calculateCardSpendingPower({
      cards: [card],
      cardCycles: [openCycle, futureCycle],
      cardActivities: activities,
      asOfDate: '2026-01-15',
      days: [
        {
          date: '2026-02-10',
          consolidatedCashCents: 98_750,
          totalPositionCents: 98_750,
          accountBalances: [{ accountId: cash.id, endingBalanceCents: 98_750 }],
        },
        {
          date: '2026-03-10',
          consolidatedCashCents: 98_350,
          totalPositionCents: 98_350,
          accountBalances: [{ accountId: cash.id, endingBalanceCents: 98_350 }],
        },
      ],
    });
    expect(overview[0]).toMatchObject({
      currentCycleId: openCycle.id,
      currentCycleAmountCents: 1_450,
    });
  });

  it('materializes recurring receivables as expected cash without treating tracked balances as cash', () => {
    const recurring: Receivable = {
      id: 'receivable-recurring',
      userId,
      source: 'Synthetic partner',
      description: 'Shared monthly cost',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 27_413,
      expectedDate: '2026-01-28',
      destinationAccountId: 'cash-primary',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      includeInCashForecast: true,
    };
    const trackedOnly: Receivable = {
      id: 'receivable-tracked',
      userId,
      source: 'Synthetic partner',
      description: 'Unscheduled balance',
      originalAmountCents: 12_345,
      remainingAmountCents: 12_345,
      expectedDate: '2026-02-10',
      destinationAccountId: 'cash-primary',
      certainty: 'expected',
      includeInCashForecast: false,
    };
    const scheduled = materializeForecastEvents({
      accounts: [account()],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [recurring, trackedOnly],
      startDate: '2026-02-01',
      endDate: '2026-04-30',
    });
    expect(scheduled.map((item) => [item.date, item.amountCents, item.sourceRecordId])).toEqual([
      ['2026-02-28', 27_413, 'receivable-recurring'],
      ['2026-03-28', 27_413, 'receivable-recurring'],
      ['2026-04-28', 27_413, 'receivable-recurring'],
    ]);
    const bundle = buildForecastBundle({
      accounts: [account()],
      events: scheduled,
      policy: policy({ includeConfirmedReceivablesConservatively: false }),
      startDate: '2026-02-01',
      endDate: '2026-04-30',
    });
    expect(bundle.conservative.days.at(-1)?.consolidatedCashCents).toBe(100_000);
    expect(bundle.expected.days.at(-1)?.consolidatedCashCents).toBe(182_239);
  });

  it('does not regenerate the first recurring receivable occurrence after an actual settlement', () => {
    const receivable: Receivable = {
      id: 'receivable-settled-occurrence',
      userId,
      source: 'Synthetic partner',
      description: 'Settled shared cost',
      originalAmountCents: 10_000,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-02-28',
      destinationAccountId: 'cash-primary',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      includeInCashForecast: true,
    };
    const recordedSettlement = event({
      id: 'recorded-receivable-settlement',
      date: '2026-02-27',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'confirmed',
      sourceRecordId: receivable.id,
      paymentMethod: 'cash-account',
    });
    const scheduled = materializeForecastEvents({
      accounts: [account()],
      events: [recordedSettlement],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-02-01',
      endDate: '2026-03-31',
    });

    expect(
      scheduled
        .filter((item) => item.sourceRecordId === receivable.id)
        .map((item) => [item.date, item.amountCents]),
    ).toEqual([
      ['2026-02-27', 10_000],
      ['2026-03-28', 10_000],
    ]);
  });
});

describe('cycle-native card purchase cash impact', () => {
  const impactCard = (overrides: Partial<CreditCard> = {}): CreditCard =>
    creditCardSchema.parse({
      id: 'impact-card',
      userId,
      name: 'Impact card',
      fundingAccountId: 'cash-primary',
      defaultFutureStatementCents: 1_000,
      estimatePolicy: 'baseline-guardrail',
      paymentPolicy: 'full-statement',
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 31,
      ...overrides,
    });

  const impactCycle = (overrides: Partial<CreditCardCycle> = {}): CreditCardCycle =>
    creditCardCycleSchema.parse({
      id: 'impact-cycle',
      cardId: 'impact-card',
      opensOn: '2026-01-01',
      closesOn: '2026-01-31',
      dueOn: '2026-02-15',
      state: 'open',
      defaultEstimateCents: 1_000,
      actualActivityCents: 600,
      plannedActivityCents: 0,
      ...overrides,
    });

  it('keeps a within-guardrail purchase at zero incremental cash', () => {
    const result = calculateCardPurchaseCashImpact({
      card: impactCard(),
      cardCycles: [impactCycle()],
      purchaseDate: '2026-01-20',
      amountCents: 300,
    });

    expect(result).toMatchObject({
      owningCycle: { id: 'impact-cycle' },
      paymentDate: '2026-02-15',
      baselineScheduledPaymentCents: 1_000,
      afterPurchaseScheduledPaymentCents: 1_000,
      incrementalCashPaymentCents: 0,
    });
  });

  it('charges only the excess when a purchase crosses the baseline guardrail', () => {
    expect(
      calculateCardPurchaseCashImpact({
        card: impactCard(),
        cardCycles: [impactCycle()],
        purchaseDate: '2026-01-20',
        amountCents: 700,
      }),
    ).toMatchObject({
      baselineScheduledPaymentCents: 1_000,
      afterPurchaseScheduledPaymentCents: 1_300,
      incrementalCashPaymentCents: 300,
    });
  });

  it('adds the full purchase under actual-reset for an open cycle', () => {
    expect(
      calculateCardPurchaseCashImpact({
        card: impactCard({ estimatePolicy: 'actual-reset' }),
        cardCycles: [impactCycle()],
        purchaseDate: '2026-01-20',
        amountCents: 700,
      }),
    ).toMatchObject({
      baselineScheduledPaymentCents: 600,
      afterPurchaseScheduledPaymentCents: 1_300,
      incrementalCashPaymentCents: 700,
    });
  });

  it.each([
    {
      name: 'minimum',
      card: { paymentPolicy: 'minimum' as const, minimumPaymentCents: 1_000 },
      baseline: 600,
      after: 1_000,
      incremental: 400,
    },
    {
      name: 'fixed',
      card: { paymentPolicy: 'fixed' as const, fixedPaymentCents: 800 },
      baseline: 600,
      after: 800,
      incremental: 200,
    },
    {
      name: 'manual',
      card: { paymentPolicy: 'manual' as const },
      baseline: 0,
      after: 0,
      incremental: 0,
    },
  ])('honors the $name payment policy', ({ card, baseline, after, incremental }) => {
    expect(
      calculateCardPurchaseCashImpact({
        card: impactCard({ estimatePolicy: 'actual-reset', ...card }),
        cardCycles: [impactCycle()],
        purchaseDate: '2026-01-20',
        amountCents: 700,
      }),
    ).toMatchObject({
      baselineScheduledPaymentCents: baseline,
      afterPurchaseScheduledPaymentCents: after,
      incrementalCashPaymentCents: incremental,
    });
  });

  it('evaluates combined card purchases against the rolling cycle state', () => {
    const card = impactCard({
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'minimum',
      minimumPaymentCents: 1_000,
    });
    const first = calculateCardPurchaseCashImpact({
      card,
      cardCycles: [impactCycle()],
      purchaseDate: '2026-01-20',
      amountCents: 700,
    });
    const acceptedFirstPurchase = event({
      id: 'accepted-first-card-scenario',
      date: '2026-01-20',
      amountCents: 700,
      paymentMethod: 'credit-card',
      cardId: card.id,
      hypothetical: true,
      accepted: true,
    });
    const second = calculateCardPurchaseCashImpact({
      card,
      cardCycles: [impactCycle()],
      cardActivities: [acceptedFirstPurchase],
      purchaseDate: '2026-01-21',
      amountCents: 700,
    });

    expect(first.incrementalCashPaymentCents).toBe(400);
    expect(second).toMatchObject({
      paymentDate: '2026-02-15',
      baselineScheduledPaymentCents: 1_000,
      afterPurchaseScheduledPaymentCents: 1_000,
      incrementalCashPaymentCents: 0,
    });
  });

  it('assigns a purchase on close to that cycle and the next day to the next cycle', () => {
    const card = impactCard({
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      statementCloseDayOfMonth: 15,
    });
    const first = impactCycle({
      id: 'boundary-first',
      closesOn: '2026-01-15',
      dueOn: '2026-02-10',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
    });
    const second = impactCycle({
      id: 'boundary-second',
      opensOn: '2026-01-16',
      closesOn: '2026-02-15',
      dueOn: '2026-03-10',
      state: 'future-estimated',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
    });

    expect(
      calculateCardPurchaseCashImpact({
        card,
        cardCycles: [first, second],
        purchaseDate: '2026-01-15',
        amountCents: 500,
      }),
    ).toMatchObject({ owningCycle: { id: 'boundary-first' }, paymentDate: '2026-02-10' });
    expect(
      calculateCardPurchaseCashImpact({
        card,
        cardCycles: [first, second],
        purchaseDate: '2026-01-16',
        amountCents: 500,
      }),
    ).toMatchObject({ owningCycle: { id: 'boundary-second' }, paymentDate: '2026-03-10' });
  });

  it('uses forecast-generated cycles when no stored cycle exists', () => {
    const card = impactCard({
      id: 'generated-impact-card',
      defaultFutureStatementCents: 1_000,
      statementCloseDayOfMonth: 20,
      paymentDayOfMonth: 15,
    });
    const result = calculateCardPurchaseCashImpact({
      card,
      cardCycles: [],
      purchaseDate: '2026-01-21',
      amountCents: 1_500,
    });
    const purchase = event({
      id: 'generated-impact-purchase',
      cardId: card.id,
      paymentMethod: 'credit-card',
      date: '2026-01-21',
      amountCents: 1_500,
    });
    const scheduled = materializeForecastEvents({
      accounts: [account()],
      events: [purchase],
      cards: [card],
      cardCycles: [],
      loans: [],
      startDate: '2026-01-21',
      endDate: '2026-03-15',
    });

    expect(result).toMatchObject({
      owningCycle: {
        id: 'generated-cycle-generated-impact-card-2026-03',
        opensOn: '2026-01-21',
        closesOn: '2026-02-20',
      },
      paymentDate: '2026-03-15',
      baselineScheduledPaymentCents: 1_000,
      afterPurchaseScheduledPaymentCents: 1_500,
      incrementalCashPaymentCents: 500,
    });
    expect(scheduled).toContainEqual(
      expect.objectContaining({
        id: 'card-payment-generated-cycle-generated-impact-card-2026-03',
        date: result.paymentDate,
        amountCents: result.afterPurchaseScheduledPaymentCents,
      }),
    );
  });
});

describe('receivable asset roll-forward', () => {
  it('accrues and settles expected receivables without improving the conservative position', () => {
    const confirmed: Receivable = {
      id: 'receivable-confirmed',
      userId,
      source: 'Confirmed source',
      description: 'Confirmed opening receivable',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-02-15',
      destinationAccountId: 'cash-primary',
      certainty: 'confirmed',
      includeInCashForecast: true,
    };
    const expectedRecurring: Receivable = {
      id: 'receivable-expected-recurring',
      userId,
      source: 'Expected source',
      description: 'Expected monthly shared cost',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-02-28',
      destinationAccountId: 'cash-primary',
      certainty: 'expected',
      recurringAmountCents: 27_413,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 27_413,
      accrualDate: '2026-02-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    };

    const conservative = projectReceivableBalances({
      receivables: [confirmed, expectedRecurring],
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      mode: 'conservative',
      includeConfirmedReceivablesConservatively: true,
    });
    const expected = projectReceivableBalances({
      receivables: [confirmed, expectedRecurring],
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });

    expect(conservative.find((day) => day.date === '2026-02-01')).toMatchObject({
      openingOutstandingCents: 10_000,
      accruedCents: 0,
      settledCents: 0,
      endingOutstandingCents: 10_000,
    });
    expect(expected.find((day) => day.date === '2026-02-01')).toMatchObject({
      openingOutstandingCents: 10_000,
      accruedCents: 27_413,
      settledCents: 0,
      endingOutstandingCents: 37_413,
    });
    expect(conservative.find((day) => day.date === '2026-02-15')).toMatchObject({
      openingOutstandingCents: 10_000,
      accruedCents: 0,
      settledCents: 10_000,
      endingOutstandingCents: 0,
    });
    expect(expected.find((day) => day.date === '2026-02-15')).toMatchObject({
      openingOutstandingCents: 37_413,
      accruedCents: 0,
      settledCents: 10_000,
      endingOutstandingCents: 27_413,
    });
    expect(conservative.at(-1)).toMatchObject({
      date: '2026-02-28',
      settledCents: 0,
      endingOutstandingCents: 0,
    });
    expect(expected.at(-1)).toMatchObject({
      date: '2026-02-28',
      settledCents: 27_413,
      endingOutstandingCents: 0,
    });
  });

  it('keeps a confirmed receipt outstanding when conservative cash excludes it', () => {
    const confirmed: Receivable = {
      id: 'receivable-policy-confirmed',
      userId,
      source: 'Confirmed source',
      description: 'Policy-controlled receipt',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-02-15',
      destinationAccountId: 'cash-primary',
      certainty: 'confirmed',
      includeInCashForecast: true,
    };
    const scheduled = materializeForecastEvents({
      accounts: [account()],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [confirmed],
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    const bundle = buildForecastBundle({
      accounts: [account()],
      events: scheduled,
      policy: policy({ includeConfirmedReceivablesConservatively: false }),
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    const conservative = projectReceivableBalances({
      receivables: [confirmed],
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      mode: 'conservative',
      includeConfirmedReceivablesConservatively: false,
    });
    const expected = projectReceivableBalances({
      receivables: [confirmed],
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: false,
    });

    const conservativeCash = bundle.conservative.days.at(-1)!.consolidatedCashCents;
    const expectedCash = bundle.expected.days.at(-1)!.consolidatedCashCents;
    const conservativeOwed = conservative.at(-1)!.endingOutstandingCents;
    const expectedOwed = expected.at(-1)!.endingOutstandingCents;
    expect(conservative.find((day) => day.date === confirmed.expectedDate)).toMatchObject({
      settledCents: 0,
      endingOutstandingCents: 10_000,
    });
    expect(expected.find((day) => day.date === confirmed.expectedDate)).toMatchObject({
      settledCents: 10_000,
      endingOutstandingCents: 0,
    });
    expect([conservativeCash, conservativeOwed, conservativeCash + conservativeOwed]).toEqual([
      100_000, 10_000, 110_000,
    ]);
    expect([expectedCash, expectedOwed, expectedCash + expectedOwed]).toEqual([
      110_000, 0, 110_000,
    ]);
  });
});

describe('dated account snapshots', () => {
  it('activates each opening balance on its own as-of date and ignores prior account events', () => {
    const early = account({ id: 'cash-early', openingBalanceCents: 100_000 });
    const later = account({
      id: 'cash-later',
      name: 'Later snapshot',
      openingBalanceCents: 50_000,
      balanceAsOf: '2026-01-10',
      hardFloorCents: 10_000,
    });
    const result = buildForecast({
      accounts: [early, later],
      events: [
        event({ id: 'early-current-event', accountId: early.id, date: '2026-01-02' }),
        event({ id: 'later-history', accountId: later.id, date: '2026-01-05' }),
        event({ id: 'later-as-of-history', accountId: later.id, date: '2026-01-10' }),
        event({ id: 'later-current-event', accountId: later.id, date: '2026-01-11' }),
      ],
      policy: policy(),
      startDate: '2026-01-01',
      endDate: '2026-01-12',
      mode: 'conservative',
    });
    const laterBalance = (date: string) =>
      result.days
        .find((day) => day.date === date)!
        .accounts.find((candidate) => candidate.accountId === later.id)!;

    expect(result.days.find((day) => day.date === '2026-01-05')).toMatchObject({
      consolidatedCashCents: 90_000,
      appliedEventIds: [],
    });
    expect(laterBalance('2026-01-05')).toMatchObject({
      openingBalanceCents: 0,
      endingBalanceCents: 0,
      appliedEventIds: [],
    });
    expect(result.days.find((day) => day.date === '2026-01-10')).toMatchObject({
      consolidatedCashCents: 140_000,
      appliedEventIds: [],
    });
    expect(laterBalance('2026-01-10')).toMatchObject({
      openingBalanceCents: 50_000,
      endingBalanceCents: 50_000,
      appliedEventIds: [],
    });
    expect(result.days.find((day) => day.date === '2026-01-11')).toMatchObject({
      consolidatedCashCents: 130_000,
      appliedEventIds: ['later-current-event'],
    });
    expect(laterBalance('2026-01-11')).toMatchObject({
      openingBalanceCents: 50_000,
      endingBalanceCents: 40_000,
      appliedEventIds: ['later-current-event'],
    });
    expect(result.excludedEventIds).toEqual(
      expect.arrayContaining(['later-history', 'later-as-of-history']),
    );
    expect(result.accountShortfalls.some((shortfall) => shortfall.accountId === later.id)).toBe(
      false,
    );
    expect(result.accountTroughs.find((trough) => trough.accountId === later.id)).toMatchObject({
      balanceCents: 40_000,
      date: '2026-01-11',
      eventIds: ['later-current-event'],
    });
  });
});

describe('per-card spending power', () => {
  it('uses each card payment date and reports its own future cash and funding-account lows', () => {
    const cards = [
      creditCardSchema.parse({
        id: 'card-early',
        userId,
        name: 'Early-settling card',
        fundingAccountId: 'cash-early',
        defaultFutureStatementCents: 20_000,
        estimatePolicy: 'actual-reset',
        paymentPolicy: 'full-statement',
      }),
      creditCardSchema.parse({
        id: 'card-late',
        userId,
        name: 'Late-settling card',
        fundingAccountId: 'cash-late',
        defaultFutureStatementCents: 20_000,
        estimatePolicy: 'actual-reset',
        paymentPolicy: 'full-statement',
      }),
    ];
    const cardCycles = cards.map((card, index) =>
      creditCardCycleSchema.parse({
        id: `cycle-${card.id}`,
        cardId: card.id,
        opensOn: '2026-01-01',
        closesOn: '2026-01-31',
        dueOn: index === 0 ? '2026-02-10' : '2026-02-20',
        paymentOn: index === 0 ? '2026-02-10' : '2026-02-20',
        state: 'open',
        defaultEstimateCents: 20_000,
        actualActivityCents: index === 0 ? 5_000 : 7_500,
        plannedActivityCents: 0,
      }),
    );
    const accountBalances = (
      early: number,
      late: number,
      earlyMinimum = early,
      lateMinimum = late,
    ) => [
      { accountId: 'cash-early', endingBalanceCents: early, minimumBalanceCents: earlyMinimum },
      { accountId: 'cash-late', endingBalanceCents: late, minimumBalanceCents: lateMinimum },
    ];

    const result = calculateCardSpendingPower({
      cards,
      cardCycles,
      asOfDate: '2026-01-15',
      hardFloorCents: 10_000,
      accountHardFloorCentsById: { 'cash-early': 5_000, 'cash-late': 15_000 },
      days: [
        {
          date: '2026-02-10',
          consolidatedCashCents: 80_000,
          totalPositionCents: 90_000,
          accountBalances: accountBalances(30_000, 50_000),
        },
        {
          date: '2026-02-15',
          consolidatedCashCents: 25_000,
          minimumConsolidatedCashCents: 23_000,
          totalPositionCents: 30_000,
          accountBalances: accountBalances(10_000, 15_000, 8_000, 15_000),
        },
        {
          date: '2026-02-20',
          consolidatedCashCents: 110_000,
          totalPositionCents: 120_000,
          accountBalances: accountBalances(60_000, 50_000),
        },
        {
          date: '2026-02-25',
          consolidatedCashCents: 45_000,
          minimumConsolidatedCashCents: 43_000,
          totalPositionCents: 55_000,
          accountBalances: accountBalances(25_000, 20_000, 25_000, 18_000),
        },
      ],
    });

    expect(result.find((card) => card.cardId === 'card-early')).toMatchObject({
      currentCyclePaymentOn: '2026-02-10',
      currentCycleAmountCents: 5_000,
      spendingPowerCents: 20_000,
      cashBackedCapacityCents: 5_000,
      futurePositionLowCents: 30_000,
      futurePositionLowDate: '2026-02-15',
      futureCashLowCents: 23_000,
      futureCashLowDate: '2026-02-15',
      fundingAccountLowCents: 10_000,
      fundingAccountLowDate: '2026-02-15',
    });
    expect(result.find((card) => card.cardId === 'card-late')).toMatchObject({
      currentCyclePaymentOn: '2026-02-20',
      currentCycleAmountCents: 7_500,
      spendingPowerCents: 45_000,
      cashBackedCapacityCents: 5_000,
      futurePositionLowCents: 55_000,
      futurePositionLowDate: '2026-02-25',
      futureCashLowCents: 43_000,
      futureCashLowDate: '2026-02-25',
      fundingAccountLowCents: 20_000,
      fundingAccountLowDate: '2026-02-25',
    });
  });

  it('generates the cycle that owns today and clears its actual-reset baseline on open', () => {
    const currentCard = creditCardSchema.parse({
      id: 'card-continuity',
      userId,
      name: 'Continuous card',
      fundingAccountId: 'cash-primary',
      defaultFutureStatementCents: 10_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 20,
    });
    const stalePaidCycle = creditCardCycleSchema.parse({
      id: 'stale-paid-cycle',
      cardId: currentCard.id,
      opensOn: '2025-12-21',
      closesOn: '2026-01-20',
      dueOn: '2026-02-15',
      paymentOn: '2026-02-15',
      state: 'paid',
      defaultEstimateCents: 10_000,
      lockedStatementCents: 10_000,
    });

    const [result] = calculateCardSpendingPower({
      cards: [currentCard],
      cardCycles: [stalePaidCycle],
      asOfDate: '2026-07-21',
      hardFloorCents: 20_000,
      accountHardFloorCentsById: { 'cash-primary': 10_000 },
      days: [
        {
          date: '2026-08-15',
          consolidatedCashCents: 95_000,
          minimumConsolidatedCashCents: 90_000,
          totalPositionCents: 90_000,
          accountBalances: [
            {
              accountId: 'cash-primary',
              endingBalanceCents: 95_000,
              minimumBalanceCents: 80_000,
            },
          ],
        },
        {
          date: '2026-09-15',
          consolidatedCashCents: 90_000,
          minimumConsolidatedCashCents: 88_000,
          totalPositionCents: 88_000,
          accountBalances: [
            {
              accountId: 'cash-primary',
              endingBalanceCents: 90_000,
              minimumBalanceCents: 70_000,
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      cardId: currentCard.id,
      currentCycleId: 'generated-cycle-card-continuity-2026-09',
      currentCycleClosesOn: '2026-08-20',
      currentCyclePaymentOn: '2026-09-15',
      currentCycleAmountCents: 0,
      baselineEstimateSlackCents: 0,
      spendingPowerStatus: 'determinate',
      spendingPowerCents: 68_000,
      cashBackedCapacityCents: 68_000,
    });
  });

  it('adds reserved estimate slack to the exact incremental payment capacity', () => {
    const reservedCard = creditCardSchema.parse({
      id: 'card-reserved-estimate',
      userId,
      name: 'Reserved estimate card',
      fundingAccountId: 'cash-primary',
      defaultFutureStatementCents: 20_000,
      estimatePolicy: 'baseline-guardrail',
      paymentPolicy: 'full-statement',
    });
    const openCycle = creditCardCycleSchema.parse({
      id: 'reserved-open-cycle',
      cardId: reservedCard.id,
      opensOn: '2026-01-01',
      closesOn: '2026-01-31',
      dueOn: '2026-02-10',
      paymentOn: '2026-02-10',
      state: 'open',
      defaultEstimateCents: 20_000,
      actualActivityCents: 5_000,
    });
    const common = {
      cards: [reservedCard],
      cardCycles: [openCycle],
      asOfDate: '2026-01-15' as const,
      hardFloorCents: 10_000,
      days: [
        {
          date: '2026-02-10' as const,
          consolidatedCashCents: 30_000,
          minimumConsolidatedCashCents: 23_000,
          totalPositionCents: 23_000,
          accountBalances: [
            {
              accountId: 'cash-primary',
              endingBalanceCents: 30_000,
              minimumBalanceCents: 8_000,
            },
            {
              accountId: 'cash-secondary',
              endingBalanceCents: 15_000,
              minimumBalanceCents: 15_000,
            },
          ],
        },
      ],
    };

    const [safe] = calculateCardSpendingPower({
      ...common,
      accountHardFloorCentsById: { 'cash-primary': 5_000, 'cash-secondary': 15_000 },
    });
    expect(safe).toMatchObject({
      baselineEstimateSlackCents: 15_000,
      spendingPowerStatus: 'determinate',
      spendingPowerCents: 13_000,
      cashBackedCapacityCents: 28_000,
    });
    expect(
      calculateCardPurchaseCashImpact({
        card: reservedCard,
        cardCycles: [openCycle],
        purchaseDate: '2026-01-15',
        amountCents: safe!.cashBackedCapacityCents,
      }),
    ).toMatchObject({
      baselineScheduledPaymentCents: 20_000,
      afterPurchaseScheduledPaymentCents: 33_000,
      incrementalCashPaymentCents: 13_000,
    });
    expect(
      calculateCardPurchaseCashImpact({
        card: reservedCard,
        cardCycles: [openCycle],
        purchaseDate: '2026-01-15',
        amountCents: safe!.cashBackedCapacityCents + 1,
      }).incrementalCashPaymentCents,
    ).toBe(13_001);

    const [baselineAlreadyUnsafe] = calculateCardSpendingPower({
      ...common,
      accountHardFloorCentsById: { 'cash-primary': 5_000, 'cash-secondary': 15_001 },
    });
    expect(baselineAlreadyUnsafe).toMatchObject({
      baselineEstimateSlackCents: 15_000,
      spendingPowerStatus: 'determinate',
      spendingPowerCents: 13_000,
      cashBackedCapacityCents: 0,
    });
  });

  it.each([
    { paymentPolicy: 'minimum' as const, minimumPaymentCents: 1_000 },
    { paymentPolicy: 'fixed' as const, fixedPaymentCents: 1_000 },
    { paymentPolicy: 'manual' as const },
  ])(
    'marks $paymentPolicy payment-policy capacity indeterminate instead of inferring safety from a zero incremental payment',
    (paymentTerms) => {
      const revolvingCard = creditCardSchema.parse({
        id: `card-${paymentTerms.paymentPolicy}`,
        userId,
        name: `${paymentTerms.paymentPolicy} card`,
        fundingAccountId: 'cash-primary',
        defaultFutureStatementCents: 20_000,
        estimatePolicy: 'baseline-guardrail',
        ...paymentTerms,
      });
      const openCycle = creditCardCycleSchema.parse({
        id: `cycle-${paymentTerms.paymentPolicy}`,
        cardId: revolvingCard.id,
        opensOn: '2026-01-01',
        closesOn: '2026-01-31',
        dueOn: '2026-02-10',
        state: 'open',
        defaultEstimateCents: 20_000,
        actualActivityCents: 20_000,
      });
      const [result] = calculateCardSpendingPower({
        cards: [revolvingCard],
        cardCycles: [openCycle],
        asOfDate: '2026-01-15',
        days: [
          {
            date: '2026-02-10',
            consolidatedCashCents: 100_000,
            totalPositionCents: 100_000,
            accountBalances: [{ accountId: 'cash-primary', endingBalanceCents: 100_000 }],
          },
        ],
      });

      expect(result).toMatchObject({
        spendingPowerStatus: 'indeterminate-payment-policy',
        spendingPowerCents: 0,
      });
    },
  );

  it('marks capacity indeterminate when the owning cycle payment is outside the cash horizon', () => {
    const currentCard = creditCardSchema.parse({
      id: 'card-short-horizon',
      userId,
      name: 'Short horizon card',
      fundingAccountId: 'cash-primary',
      defaultFutureStatementCents: 10_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 20,
    });
    const [result] = calculateCardSpendingPower({
      cards: [currentCard],
      cardCycles: [],
      asOfDate: '2026-07-21',
      days: [
        {
          date: '2026-08-31',
          consolidatedCashCents: 100_000,
          totalPositionCents: 100_000,
          accountBalances: [{ accountId: 'cash-primary', endingBalanceCents: 100_000 }],
        },
      ],
    });

    expect(result).toMatchObject({
      currentCycleId: 'generated-cycle-card-short-horizon-2026-09',
      currentCyclePaymentOn: '2026-09-15',
      spendingPowerStatus: 'indeterminate-payment-outside-horizon',
      spendingPowerCents: 0,
    });
  });
});

const cycles = [
  creditCardCycleSchema.parse({
    id: 'cycle-a',
    cardId: 'card-a',
    opensOn: '2026-01-01',
    closesOn: '2026-01-15',
    dueOn: '2026-02-10',
    state: 'open',
    defaultEstimateCents: 50_000,
  }),
  creditCardCycleSchema.parse({
    id: 'cycle-b',
    cardId: 'card-a',
    opensOn: '2026-01-16',
    closesOn: '2026-02-15',
    dueOn: '2026-03-10',
    state: 'future-estimated',
    defaultEstimateCents: 50_000,
  }),
];

const card = (overrides: Partial<CreditCard> = {}): CreditCard =>
  creditCardSchema.parse({
    id: 'card-a',
    userId,
    name: 'Synthetic card',
    fundingAccountId: 'cash-primary',
    defaultFutureStatementCents: 50_000,
    estimatePolicy: 'baseline-guardrail',
    paymentPolicy: 'full-statement',
    ...overrides,
  });

describe('committed synthetic golden cases', () => {
  it('1. expands a normal two-paycheck month', () => {
    expect(
      expandRecurrence({
        startDate: '2026-01-09',
        endDate: '2026-01-31',
        rule: { frequency: 'biweekly' },
      }),
    ).toEqual(['2026-01-09', '2026-01-23']);
  });

  it('2. expands a three-paycheck month', () => {
    expect(
      expandRecurrence({
        startDate: '2026-01-02',
        endDate: '2026-01-31',
        rule: { frequency: 'biweekly' },
      }),
    ).toEqual(['2026-01-02', '2026-01-16', '2026-01-30']);
  });

  it('3. exposes the trough before a later reimbursement', () => {
    const result = buildForecastBundle({
      accounts: [account()],
      events: [
        event({ id: 'major-payment', amountCents: 90_000 }),
        event({
          id: 'later-reimbursement',
          date: '2026-01-10',
          kind: 'receivable-settlement',
          direction: 'inflow',
          amountCents: 90_000,
          certainty: 'expected',
        }),
      ],
      policy: policy(),
      startDate: '2026-01-01',
      endDate: '2026-01-15',
    });
    expect(result.expected.consolidatedTroughCents).toBe(10_000);
    expect(result.expected.days.at(-1)?.consolidatedCashCents).toBe(100_000);
    expect(result.conservative.days.at(-1)?.consolidatedCashCents).toBe(10_000);
  });

  it('4. preserves gross liquidity burden and personal economics for shared card spending', () => {
    expect(
      sharedExpenseEconomics({
        grossExpenseCents: 60_000,
        userEconomicShareCents: 20_000,
        settledReceivableCents: 0,
      }),
    ).toEqual({
      receivableCreatedCents: 40_000,
      temporaryLiquidityBurdenCents: 60_000,
      remainingReceivableCents: 40_000,
      finalPersonalEconomicBurdenCents: 20_000,
    });
    const result = forecast([
      event({
        id: 'shared-card-payment',
        date: '2026-01-20',
        kind: 'card-payment',
        amountCents: 60_000,
      }),
      event({
        id: 'shared-repayment',
        date: '2026-01-25',
        kind: 'receivable-settlement',
        direction: 'inflow',
        amountCents: 40_000,
      }),
    ]);
    expect(result.consolidatedTroughCents).toBe(40_000);
  });

  it('5. respects an internal transfer before a loan payment', () => {
    const source = account({ id: 'cash-source', openingBalanceCents: 200_000 });
    const destination = account({
      id: 'cash-payment',
      openingBalanceCents: 10_000,
      hardFloorCents: 0,
    });
    const result = forecast(
      [
        event({
          id: 'transfer-out',
          accountId: source.id,
          kind: 'transfer-debit',
          amountCents: 50_000,
        }),
        event({
          id: 'transfer-in',
          accountId: destination.id,
          date: '2026-01-06',
          kind: 'transfer-credit',
          direction: 'inflow',
          amountCents: 50_000,
        }),
        event({
          id: 'loan-payment',
          accountId: destination.id,
          date: '2026-01-07',
          kind: 'loan-payment',
          amountCents: 40_000,
        }),
      ],
      { accounts: [source, destination] },
    );
    expect(result.accountShortfalls).toEqual([]);
    expect(
      result.accountTroughs.find((item) => item.accountId === destination.id)?.balanceCents,
    ).toBe(10_000);
  });

  it('6. assigns a purchase before close to the current cycle', () => {
    expect(assignPurchaseToCycle({ purchaseDate: '2026-01-10', cycles }).cycle.id).toBe('cycle-a');
  });

  it('7. assigns a purchase after close to the next cycle', () => {
    expect(assignPurchaseToCycle({ purchaseDate: '2026-01-16', cycles }).cycle.id).toBe('cycle-b');
  });

  it('8. replaces an estimate with a locked actual statement', () => {
    const locked = creditCardCycleSchema.parse({
      ...cycles[0],
      state: 'closed-statement',
      defaultEstimateCents: 100_000,
      lockedStatementCents: 70_000,
    });
    expect(projectedCycleObligation(card(), locked)).toBe(70_000);
  });

  it('8a. rejects unresolved closed and scheduled card obligations', () => {
    for (const state of ['closed-statement', 'scheduled-payment'] as const) {
      expect(() =>
        projectedCycleObligation(card(), {
          ...cycles[0],
          state,
          lockedStatementCents: undefined,
        } as CreditCardCycle),
      ).toThrow(/locked statement amount is required/i);
    }
  });

  it('8b. accepts a locked statement credit without scheduling an outflow', () => {
    const credit = creditCardCycleSchema.parse({
      ...cycles[0],
      state: 'scheduled-payment',
      lockedStatementCents: -2_500,
    });
    expect(projectedCycleObligation(card(), credit)).toBe(-2_500);
    expect(scheduledCardPayment(card(), credit)).toBe(0);
  });

  it('9. distinguishes actual-reset from baseline-guardrail projection', () => {
    const open = creditCardCycleSchema.parse({
      ...cycles[0],
      defaultEstimateCents: 100_000,
      actualActivityCents: 30_000,
    });
    expect(projectedCycleObligation(card({ estimatePolicy: 'actual-reset' }), open)).toBe(30_000);
    expect(projectedCycleObligation(card({ estimatePolicy: 'baseline-guardrail' }), open)).toBe(
      100_000,
    );
  });

  it('9a. keeps the future-cycle estimate as a guardrail when planned detail is smaller', () => {
    const future = creditCardCycleSchema.parse({
      ...cycles[1],
      defaultEstimateCents: 100_000,
      actualActivityCents: 0,
      plannedActivityCents: 30_000,
    });
    expect(projectedCycleObligation(card({ estimatePolicy: 'actual-reset' }), future)).toBe(
      100_000,
    );
    expect(
      projectedCycleObligation(card({ estimatePolicy: 'actual-reset' }), {
        ...future,
        plannedActivityCents: 120_000,
      }),
    ).toBe(120_000);
  });

  it('9b. rejects minimum and fixed policies without positive configured amounts', () => {
    const open = cycles[0];
    expect(() =>
      scheduledCardPayment(
        { ...card(), paymentPolicy: 'minimum', minimumPaymentCents: undefined },
        open,
      ),
    ).toThrow(/minimum payment amount is required/i);
    expect(() =>
      scheduledCardPayment({ ...card(), paymentPolicy: 'fixed', fixedPaymentCents: 0 }, open),
    ).toThrow(/positive fixed payment amount is required/i);
  });

  it('10. evaluates individually affordable purchases together', () => {
    const accounts = [account({ hardFloorCents: 20_000 })];
    const scenarioA = event({ id: 'purchase-a', kind: 'scenario', amountCents: 50_000 });
    const scenarioB = event({ id: 'purchase-b', kind: 'scenario', amountCents: 40_000 });
    const base = {
      accounts,
      baseEvents: [],
      policy: policy({ hardConsolidatedFloorCents: 20_000 }),
      startDate: '2026-01-01',
    };
    expect(evaluateScenarios({ ...base, scenarioEvents: [scenarioA] }).verdict).toBe(
      'affordable-under-current-assumptions',
    );
    expect(evaluateScenarios({ ...base, scenarioEvents: [scenarioB] }).verdict).toBe(
      'affordable-under-current-assumptions',
    );
    expect(evaluateScenarios({ ...base, scenarioEvents: [scenarioA, scenarioB] }).verdict).toBe(
      'breaches-protected-floor',
    );
  });

  it('11. keeps a delayed refund on its actual expected date', () => {
    const result = buildForecastBundle({
      accounts: [account()],
      events: [
        event({ id: 'purchase', amountCents: 70_000 }),
        event({
          id: 'refund',
          date: '2026-01-20',
          kind: 'receivable-settlement',
          direction: 'inflow',
          amountCents: 70_000,
          certainty: 'expected',
        }),
      ],
      policy: policy(),
      startDate: '2026-01-01',
      endDate: '2026-01-20',
    });
    expect(result.expected.days.at(-2)?.consolidatedCashCents).toBe(30_000);
    expect(result.expected.days.at(-1)?.consolidatedCashCents).toBe(100_000);
  });

  it('12. flags an underfunded account despite positive consolidated cash', () => {
    const funded = account({ id: 'funded', openingBalanceCents: 200_000 });
    const payment = account({ id: 'payment', openingBalanceCents: 10_000 });
    const result = forecast([event({ id: 'debit', accountId: payment.id, amountCents: 30_000 })], {
      accounts: [funded, payment],
    });
    expect(result.consolidatedTroughCents).toBe(180_000);
    expect(result.accountShortfalls[0]?.accountId).toBe(payment.id);
    expect(result.transferNeeds[0]?.suggestedSourceAccountId).toBe(funded.id);
  });

  it('13. shows a refinance that lowers payment but raises total cost', () => {
    const comparison = compareRefinance({
      currentPayoffCents: 500_000,
      currentPaymentCents: 50_000,
      currentRemainingPayments: 12,
      newPrincipalCents: 500_000,
      newPaymentCents: 35_000,
      newTermMonths: 24,
      feesCents: 10_000,
      cashAtClosingCents: 0,
    });
    expect(comparison.monthlyPaymentChangeCents).toBeLessThan(0);
    expect(comparison.totalCostChangeCents).toBeGreaterThan(0);
  });

  it('14. shows a refinance that raises payment but lowers total cost', () => {
    const comparison = compareRefinance({
      currentPayoffCents: 900_000,
      currentPaymentCents: 50_000,
      currentRemainingPayments: 24,
      newPrincipalCents: 900_000,
      newPaymentCents: 60_000,
      newTermMonths: 15,
      feesCents: 0,
      cashAtClosingCents: 0,
    });
    expect(comparison.monthlyPaymentChangeCents).toBeGreaterThan(0);
    expect(comparison.totalCostChangeCents).toBeLessThan(0);
  });

  it('calculates an amortizing refinance payment from principal, APR, and term', () => {
    expect(
      levelMonthlyPaymentCents({
        principalCents: 1_000_000,
        annualRateBasisPoints: 600,
        termMonths: 60,
      }),
    ).toBe(19_333);
    const comparison = compareRefinance({
      currentPayoffCents: 1_000_000,
      currentPaymentCents: 22_000,
      currentRemainingPayments: 52,
      currentAnnualRateBasisPoints: 800,
      newPrincipalCents: 1_000_000,
      newAnnualRateBasisPoints: 600,
      newTermMonths: 60,
      feesCents: 10_000,
      cashAtClosingCents: 0,
    });
    expect(comparison.effectiveNewPaymentCents).toBe(19_333);
    expect(comparison.currentRemainingInterestCents).toBeGreaterThan(0);
    expect(comparison.newRemainingInterestCents).toBeGreaterThan(0);
    expect(comparison.newResidualBalanceCents).toBeLessThanOrEqual(100);
  });

  it('surfaces a residual balance when a quoted refinance payment does not amortize', () => {
    const comparison = compareRefinance({
      currentPayoffCents: 1_000_000,
      currentPaymentCents: 25_000,
      currentRemainingPayments: 48,
      currentAnnualRateBasisPoints: 700,
      newPrincipalCents: 1_000_000,
      newAnnualRateBasisPoints: 1_200,
      newPaymentCents: 10_000,
      newTermMonths: 60,
      feesCents: 0,
      cashAtClosingCents: 0,
    });
    expect(comparison.newResidualBalanceCents).toBeGreaterThan(900_000);
  });

  it('projects loan payoff term and remaining modeled interest', () => {
    const payoff = projectLoanPayoff({
      principalCents: 1_000_000,
      annualRateBasisPoints: 600,
      paymentCents: 50_000,
    });
    expect(payoff.payoffMonths).toBe(22);
    expect(payoff.remainingInterestCents).toBeGreaterThan(0);
    expect(
      projectLoanPayoff({
        principalCents: 1_000_000,
        annualRateBasisPoints: 6_000,
        paymentCents: 10_000,
      }).payoffMonths,
    ).toBeNull();
  });

  it('15. does not let a later reward hide settlement-day liquidity risk', () => {
    const result = buildForecastBundle({
      accounts: [account()],
      events: [
        event({
          id: 'card-settlement',
          date: '2026-01-10',
          kind: 'card-payment',
          amountCents: 60_000,
        }),
        event({
          id: 'reward',
          date: '2026-01-20',
          kind: 'reward-deposit',
          direction: 'inflow',
          amountCents: 5_000,
          certainty: 'expected',
        }),
      ],
      policy: policy(),
      startDate: '2026-01-01',
      endDate: '2026-01-20',
    });
    expect(result.expected.consolidatedTroughCents).toBe(40_000);
    expect(result.expected.days.at(-1)?.consolidatedCashCents).toBe(45_000);
  });

  it('16. keeps a floor breach visible despite positive month-end cash', () => {
    const result = buildForecast({
      accounts: [account({ openingBalanceCents: 50_000 })],
      events: [
        event({ id: 'early-outflow', amountCents: 45_000 }),
        event({
          id: 'late-income',
          date: '2026-01-31',
          kind: 'income',
          direction: 'inflow',
          amountCents: 50_000,
        }),
      ],
      policy: policy({ hardConsolidatedFloorCents: 10_000 }),
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      mode: 'conservative',
    });
    expect(result.hardFloorMarginCents).toBe(-5_000);
    expect(result.days.at(-1)?.consolidatedCashCents).toBe(55_000);
  });

  it('17. applies a partial receivable settlement without losing the remainder', () => {
    const receivable: Receivable = {
      id: 'receivable-a',
      userId,
      source: 'Synthetic counterparty',
      description: 'Shared expense',
      originalAmountCents: 100_000,
      remainingAmountCents: 100_000,
      expectedDate: '2026-01-10',
      destinationAccountId: 'cash-primary',
      certainty: 'expected',
    };
    expect(applyReceivableSettlement(receivable, 40_000)).toEqual({
      appliedCents: 40_000,
      remainingAmountCents: 60_000,
      overpaymentCents: 0,
    });
  });

  it('18. separates contractual and economic treatment of a retirement-plan loan', () => {
    const asset: Asset = {
      id: 'retirement',
      userId,
      name: 'Retirement asset',
      type: 'investment',
      valueCents: 1_000_000,
      valuationDate: '2026-01-01',
      includedInNetWorth: true,
      includedInLiquidity: false,
    };
    const loan: Loan = {
      id: 'plan-loan',
      userId,
      name: 'Plan loan',
      principalCents: 200_000,
      accruedInterestCents: 0,
      balanceDate: '2026-01-01',
      annualRateBasisPoints: 500,
      accrualConvention: 'actual-365',
      paymentCents: 10_000,
      nextPaymentDate: '2026-01-15',
      amortizationStructure: 'fully-amortizing',
      fundingAccountId: 'cash-primary',
      excludeFromEconomicNetWorthDoubleCount: true,
    };
    const result = calculateNetWorth({
      cashAccounts: [account()],
      assets: [asset],
      receivables: [],
      loans: [loan],
    });
    expect(result.contractualNetWorthCents).toBe(900_000);
    expect(result.economicNetWorthCents).toBe(1_100_000);
  });

  it('18a. includes explicitly liquid assets once and excludes paid-off loans', () => {
    const liquidAsset: Asset = {
      id: 'money-market-asset',
      userId,
      name: 'Immediately available investment',
      type: 'investment',
      valueCents: 25_000,
      valuationDate: '2026-01-01',
      includedInNetWorth: true,
      includedInLiquidity: true,
    };
    const paidOffLoan: Loan = {
      id: 'historical-loan',
      userId,
      name: 'Historical paid-off loan',
      principalCents: 75_000,
      accruedInterestCents: 500,
      balanceDate: '2025-12-31',
      annualRateBasisPoints: 500,
      accrualConvention: 'actual-365',
      paymentCents: 0,
      nextPaymentDate: '2025-12-31',
      amortizationStructure: 'fully-amortizing',
      fundingAccountId: 'cash-primary',
      excludeFromEconomicNetWorthDoubleCount: false,
      status: 'paid-off',
    };
    const result = calculateNetWorth({
      cashAccounts: [account()],
      assets: [liquidAsset],
      receivables: [],
      loans: [paidOffLoan],
    });
    expect(result.liquidNetPositionCents).toBe(125_000);
    expect(result.contractualNetWorthCents).toBe(125_000);
    expect(result.economicNetWorthCents).toBe(125_000);
    expect(result.contractualLiabilitiesCents).toBe(0);
  });

  it('18b. uses the rolled current cash and owed balances shared with the daily forecast', () => {
    const result = calculateNetWorth({
      cashAccounts: [account()],
      assets: [],
      receivables: [],
      loans: [],
      liquidCashCentsOverride: 160_000,
      receivablesCentsOverride: 27_500,
    });
    expect(result.liquidNetPositionCents).toBe(160_000);
    expect(result.contractualNetWorthCents).toBe(187_500);
    expect(result.economicNetWorthCents).toBe(187_500);
  });

  it('18c. keeps non-liquid cash in owned assets while excluding it from liquid position', () => {
    const restrictedCash: CashAccount = {
      ...account(),
      id: 'restricted-savings',
      name: 'Restricted savings',
      openingBalanceCents: 500_000,
      includedInLiquidity: false,
      canFundOtherAccounts: false,
    };
    const result = calculateNetWorth({
      cashAccounts: [account(), restrictedCash],
      assets: [],
      receivables: [],
      loans: [],
    });
    expect(result.liquidNetPositionCents).toBe(100_000);
    expect(result.contractualNetWorthCents).toBe(600_000);
    expect(result.economicNetWorthCents).toBe(600_000);
  });

  it('19. detects a payroll contribution already represented in net pay', () => {
    const related = [
      event({ id: 'net-pay', kind: 'income', direction: 'inflow', sourceRecordId: 'payroll-a' }),
      event({
        id: 'payroll-contribution',
        kind: 'investment-contribution',
        sourceRecordId: 'payroll-a',
      }),
    ];
    expect(findDoubleCountRisks(related)[0]?.reason).toBe('net-pay-and-payroll-deduction');
    expect(() => forecast(related)).toThrow(/double counting/i);
  });

  it('20. prevents the same expense from being both direct cash and card payment', () => {
    const related = [
      event({ id: 'cash-assumption', kind: 'direct-commitment', sourceRecordId: 'obligation-a' }),
      event({ id: 'card-assumption', kind: 'card-payment', sourceRecordId: 'obligation-a' }),
    ];
    expect(findDoubleCountRisks(related)[0]?.reason).toBe('cash-and-card');
    expect(() => forecast(related)).toThrow(/double counting/i);
  });

  it('21. orders a same-day payment before an untimed paycheck', () => {
    const result = forecast(
      [
        event({ id: 'same-day-pay', kind: 'income', direction: 'inflow', amountCents: 100_000 }),
        event({ id: 'same-day-payment', amountCents: 50_000 }),
      ],
      { accounts: [account({ openingBalanceCents: 10_000 })] },
    );
    expect(result.days[4]?.consolidatedCashCents).toBe(60_000);
    expect(result.days[4]?.minimumConsolidatedCashCents).toBe(-40_000);
    expect(result.accountShortfalls[0]?.balanceCents).toBe(-40_000);
    expect(result.transferNeeds).toEqual([]);
  });

  it('22. excludes an uncertain receivable from conservative and expected cash', () => {
    const uncertain = event({
      id: 'uncertain-receivable',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 50_000,
      certainty: 'uncertain',
    });
    const result = buildForecastBundle({
      accounts: [account()],
      events: [uncertain],
      policy: policy(),
      startDate: '2026-01-01',
      endDate: '2026-01-10',
    });
    expect(result.conservative.days.at(-1)?.consolidatedCashCents).toBe(100_000);
    expect(result.expected.days.at(-1)?.consolidatedCashCents).toBe(100_000);
    expect(result.conservative.excludedEventIds).toContain(uncertain.id);
  });

  it('23. extends a scenario through settlement beyond the visible horizon', () => {
    const result = evaluateScenarios({
      accounts: [account()],
      baseEvents: [],
      scenarioEvents: [
        event({
          id: 'future-settlement',
          date: '2026-02-15',
          kind: 'scenario',
          amountCents: 30_000,
        }),
      ],
      policy: policy({ horizonDays: 10 }),
      startDate: '2026-01-01',
      endDate: '2026-01-10',
    });
    expect(result.after.conservative.endDate).toBe('2026-02-15');
    expect(result.after.conservative.consolidatedTroughCents).toBe(70_000);
  });
});
