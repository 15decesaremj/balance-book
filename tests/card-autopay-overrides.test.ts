import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
} from '@balance-book/domain';
import {
  calculateCardPurchaseCashImpact,
  materializeForecastEvents,
  projectCardDebtSchedule,
} from '@balance-book/financial-engine';

const account = cashAccountSchema.parse({
  id: 'synthetic-checking',
  userId: 'synthetic-user',
  name: 'Synthetic checking',
  type: 'checking',
  openingBalanceCents: 500_000,
  balanceAsOf: '2032-01-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  transferDelayDays: 0,
});

const card = (
  paymentTerms:
    | { paymentPolicy: 'full-statement' | 'manual' }
    | { paymentPolicy: 'minimum'; minimumPaymentCents: number }
    | { paymentPolicy: 'fixed'; fixedPaymentCents: number },
  overrides: Partial<CreditCard> = {},
): CreditCard =>
  creditCardSchema.parse({
    id: 'synthetic-card',
    userId: 'synthetic-user',
    name: 'Synthetic card',
    fundingAccountId: account.id,
    defaultFutureStatementCents: 0,
    estimatePolicy: 'actual-reset',
    ...paymentTerms,
    ...overrides,
  });

const cycle = (
  id: string,
  dueOn: string,
  overrides: Partial<CreditCardCycle> = {},
): CreditCardCycle =>
  creditCardCycleSchema.parse({
    id,
    cardId: 'synthetic-card',
    opensOn: `${dueOn.slice(0, 7)}-01`,
    closesOn: `${dueOn.slice(0, 7)}-10`,
    dueOn,
    paymentOn: dueOn,
    state: 'open',
    defaultEstimateCents: 0,
    actualActivityCents: 10_000,
    plannedActivityCents: 0,
    ...overrides,
  });

describe('card autopay and dated payment overrides', () => {
  it.each([
    {
      terms: { paymentPolicy: 'full-statement' as const },
      generatedPaymentCents: 8_000,
      carryingBalanceAfterPaymentCents: 0,
    },
    {
      terms: { paymentPolicy: 'minimum' as const, minimumPaymentCents: 3_000 },
      generatedPaymentCents: 1_000,
      carryingBalanceAfterPaymentCents: 7_000,
    },
    {
      terms: { paymentPolicy: 'fixed' as const, fixedPaymentCents: 5_000 },
      generatedPaymentCents: 3_000,
      carryingBalanceAfterPaymentCents: 5_000,
    },
    {
      terms: { paymentPolicy: 'manual' as const },
      generatedPaymentCents: 0,
      carryingBalanceAfterPaymentCents: 8_000,
    },
  ])(
    'combines a dated payment with $terms.paymentPolicy policy without double counting',
    ({ terms, generatedPaymentCents, carryingBalanceAfterPaymentCents }) => {
      const [result] = projectCardDebtSchedule({
        card: card(terms),
        cardCycles: [cycle('policy-cycle', '2032-02-15')],
        asOfDate: '2032-01-20',
        scheduledPayments: [
          {
            id: 'early-payment',
            date: '2032-02-10',
            amountCents: 2_000,
          },
        ],
      });

      expect(result).toMatchObject({
        obligationCents: 10_000,
        explicitPaymentCents: 2_000,
        generatedPaymentCents,
        paymentCents: 10_000 - carryingBalanceAfterPaymentCents,
        carryingBalanceAfterPaymentCents,
      });
    },
  );

  it('keeps multiple explicit cash dates and generates only the full-statement remainder', () => {
    const fullPayCard = card({ paymentPolicy: 'full-statement' });
    const statement = cycle('multi-payment-statement', '2032-02-20', {
      opensOn: '2032-01-01',
      closesOn: '2032-01-31',
      state: 'scheduled-payment',
      actualActivityCents: 0,
      lockedStatementCents: 10_000,
    });
    const payments = [
      forecastEventSchema.parse({
        id: 'first-partial-payment',
        userId: fullPayCard.userId,
        accountId: account.id,
        date: '2032-02-05',
        kind: 'card-payment',
        direction: 'outflow',
        amountCents: 1_500,
        certainty: 'confirmed',
        status: 'scheduled',
        label: 'First partial payment',
        paymentMethod: 'cash-account',
        cardId: fullPayCard.id,
      }),
      forecastEventSchema.parse({
        id: 'second-partial-payment',
        userId: fullPayCard.userId,
        accountId: account.id,
        date: '2032-02-12',
        kind: 'card-payment',
        direction: 'outflow',
        amountCents: 2_500,
        certainty: 'confirmed',
        status: 'scheduled',
        label: 'Second partial payment',
        paymentMethod: 'cash-account',
        cardId: fullPayCard.id,
      }),
    ];

    const cashPayments = materializeForecastEvents({
      accounts: [account],
      events: payments,
      cards: [fullPayCard],
      cardCycles: [statement],
      loans: [],
      startDate: '2032-02-01',
      endDate: '2032-02-28',
    })
      .filter((event) => event.kind === 'card-payment')
      .map((event) => ({ id: event.id, date: event.date, amountCents: event.amountCents }))
      .sort((left, right) => left.date.localeCompare(right.date));

    expect(cashPayments).toEqual([
      { id: 'first-partial-payment', date: '2032-02-05', amountCents: 1_500 },
      { id: 'second-partial-payment', date: '2032-02-12', amountCents: 2_500 },
      { id: `card-payment-${statement.id}`, date: '2032-02-20', amountCents: 6_000 },
    ]);
  });

  it('creates carry only for an actual statement underpayment and preserves paid-in-full history', () => {
    const manualCard = card({ paymentPolicy: 'manual' });
    const next = cycle('next-open-cycle', '2032-03-15', {
      opensOn: '2032-02-01',
      closesOn: '2032-02-28',
      actualActivityCents: 0,
    });
    const releasedStatement = (actualPaymentCents: number): CreditCardCycle =>
      cycle('released-statement', '2032-02-15', {
        opensOn: '2032-01-01',
        closesOn: '2032-01-31',
        state: 'paid',
        actualActivityCents: 0,
        lockedStatementCents: 10_000,
        actualPaymentCents,
      });

    const underpaid = projectCardDebtSchedule({
      card: manualCard,
      cardCycles: [releasedStatement(4_000), next],
      asOfDate: '2032-02-16',
    });
    expect(underpaid[0]).toMatchObject({
      paymentCents: 4_000,
      carryingBalanceAfterPaymentCents: 6_000,
    });
    expect(underpaid[1]).toMatchObject({
      obligationCents: 6_000,
      carryingBalanceAfterPaymentCents: 6_000,
    });

    const paidInFull = projectCardDebtSchedule({
      card: manualCard,
      cardCycles: [releasedStatement(10_000), next],
      asOfDate: '2032-02-16',
    });
    expect(paidInFull[0]).toMatchObject({
      paymentCents: 10_000,
      carryingBalanceAfterPaymentCents: 0,
    });
    expect(paidInFull[1]).toMatchObject({
      obligationCents: 0,
      carryingBalanceAfterPaymentCents: 0,
    });

    const legacyPaid = projectCardDebtSchedule({
      card: manualCard,
      cardCycles: [
        cycle('legacy-paid-statement', '2032-02-15', {
          opensOn: '2032-01-01',
          closesOn: '2032-01-31',
          state: 'paid',
        }),
        next,
      ],
      asOfDate: '2032-02-16',
    });
    expect(legacyPaid[0]).toMatchObject({
      obligationCents: 0,
      paymentCents: 0,
      carryingBalanceAfterPaymentCents: 0,
    });
    expect(legacyPaid[1]).toMatchObject({
      obligationCents: 0,
      carryingBalanceAfterPaymentCents: 0,
    });
  });

  it('materializes the exact recorded cash release for a paid cycle without duplicating linked cash evidence', () => {
    const fullPayCard = card({ paymentPolicy: 'full-statement' });
    const paidCycle = (actualPaymentCents: number): CreditCardCycle =>
      cycle('cash-recorded-paid-cycle', '2032-02-15', {
        opensOn: '2032-01-01',
        closesOn: '2032-01-31',
        state: 'paid',
        actualActivityCents: 0,
        lockedStatementCents: 10_000,
        actualPaymentCents,
      });
    const cashEventsFor = (cardCycles: CreditCardCycle[], events: ForecastEvent[] = []) =>
      materializeForecastEvents({
        accounts: [account],
        events,
        cards: [fullPayCard],
        cardCycles,
        loans: [],
        startDate: '2032-02-01',
        endDate: '2032-02-28',
      }).filter((event) => event.kind === 'card-payment');

    expect(cashEventsFor([paidCycle(4_000)])).toContainEqual(
      expect.objectContaining({
        id: 'card-payment-cash-recorded-paid-cycle',
        date: '2032-02-15',
        amountCents: 4_000,
        certainty: 'confirmed',
        status: 'paid',
      }),
    );
    expect(cashEventsFor([paidCycle(15_000)])).toContainEqual(
      expect.objectContaining({ amountCents: 15_000, status: 'paid' }),
    );

    const linkedCash = forecastEventSchema.parse({
      id: 'linked-paid-cash-evidence',
      userId: fullPayCard.userId,
      accountId: account.id,
      date: '2032-02-15',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'paid',
      label: 'Issuer payment evidence',
      sourceRecordId: 'cash-recorded-paid-cycle',
      paymentMethod: 'cash-account',
      cardId: fullPayCard.id,
    });
    expect(cashEventsFor([paidCycle(10_000)], [linkedCash])).toEqual([linkedCash]);
  });

  it.each([
    { actualPaymentCents: 4_000, expectedCarryCents: 6_000 },
    { actualPaymentCents: 15_000, expectedCarryCents: 0 },
  ])(
    'lets a recorded $actualPaymentCents paid-cycle release supersede its stale scheduled instruction',
    ({ actualPaymentCents, expectedCarryCents }) => {
      const fullPayCard = card({ paymentPolicy: 'full-statement' });
      const paidStatement = cycle('paid-overrides-scheduled', '2032-02-15', {
        opensOn: '2032-01-01',
        closesOn: '2032-01-31',
        state: 'paid',
        actualActivityCents: 0,
        lockedStatementCents: 10_000,
        actualPaymentCents,
      });
      const staleInstruction = forecastEventSchema.parse({
        id: 'stale-linked-payment-instruction',
        userId: fullPayCard.userId,
        accountId: account.id,
        date: '2032-02-15',
        kind: 'card-payment',
        direction: 'outflow',
        amountCents: 10_000,
        certainty: 'confirmed',
        status: 'scheduled',
        label: 'Original forecast instruction',
        sourceRecordId: paidStatement.id,
        paymentMethod: 'cash-account',
        cardId: fullPayCard.id,
      });

      const [debt] = projectCardDebtSchedule({
        card: fullPayCard,
        cardCycles: [paidStatement],
        asOfDate: '2032-02-16',
        scheduledPayments: [
          {
            id: staleInstruction.id,
            date: staleInstruction.date,
            amountCents: staleInstruction.amountCents,
            status: staleInstruction.status,
            cycleId: paidStatement.id,
          },
        ],
      });
      expect(debt).toMatchObject({
        explicitPaymentCents: 0,
        paymentCents: Math.min(10_000, actualPaymentCents),
        excessPaymentCents: Math.max(0, actualPaymentCents - 10_000),
        carryingBalanceAfterPaymentCents: expectedCarryCents,
      });

      const cash = materializeForecastEvents({
        accounts: [account],
        events: [staleInstruction],
        cards: [fullPayCard],
        cardCycles: [paidStatement],
        loans: [],
        startDate: '2032-02-01',
        endDate: '2032-02-28',
      }).filter((event) => event.kind === 'card-payment');
      expect(cash).toEqual([
        expect.objectContaining({
          id: `card-payment-${paidStatement.id}`,
          amountCents: actualPaymentCents,
          status: 'paid',
        }),
      ]);
    },
  );

  it('uses confirmed partial cash evidence and generates only the missing recorded remainder', () => {
    const fullPayCard = card({ paymentPolicy: 'full-statement' });
    const paidStatement = cycle('paid-with-partial-evidence', '2032-02-15', {
      opensOn: '2032-01-01',
      closesOn: '2032-01-31',
      state: 'paid',
      actualActivityCents: 0,
      lockedStatementCents: 10_000,
      actualPaymentCents: 10_000,
    });
    const confirmedPartial = forecastEventSchema.parse({
      id: 'confirmed-partial-payment-evidence',
      userId: fullPayCard.userId,
      accountId: account.id,
      date: '2032-02-10',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 4_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Confirmed issuer payment',
      sourceRecordId: paidStatement.id,
      paymentMethod: 'cash-account',
      cardId: fullPayCard.id,
    });

    expect(
      materializeForecastEvents({
        accounts: [account],
        events: [confirmedPartial],
        cards: [fullPayCard],
        cardCycles: [paidStatement],
        loans: [],
        startDate: '2032-02-01',
        endDate: '2032-02-28',
      })
        .filter((event) => event.kind === 'card-payment')
        .map((event) => ({ id: event.id, date: event.date, amountCents: event.amountCents })),
    ).toEqual([
      { id: confirmedPartial.id, date: '2032-02-10', amountCents: 4_000 },
      { id: `card-payment-${paidStatement.id}`, date: '2032-02-15', amountCents: 6_000 },
    ]);
  });

  it('does not let a post-due payment clear the prior statement at its due date', () => {
    const manualCard = card({ paymentPolicy: 'manual' });
    const dueStatement = cycle('due-before-late-payment', '2032-02-15', {
      opensOn: '2032-01-01',
      closesOn: '2032-01-31',
      state: 'closed-statement',
      actualActivityCents: 0,
      lockedStatementCents: 10_000,
    });
    const next = cycle('cycle-after-late-payment', '2032-03-15', {
      opensOn: '2032-02-01',
      closesOn: '2032-02-29',
      actualActivityCents: 0,
    });

    const result = projectCardDebtSchedule({
      card: manualCard,
      cardCycles: [dueStatement, next],
      asOfDate: '2032-02-01',
      scheduledPayments: [
        {
          id: 'payment-after-due-date',
          date: '2032-02-20',
          amountCents: 10_000,
          status: 'scheduled',
          cycleId: dueStatement.id,
        },
      ],
    });

    expect(result[0]).toMatchObject({
      explicitPaymentCents: 0,
      paymentCents: 0,
      carryingBalanceAfterPaymentCents: 10_000,
    });
    expect(result[1]).toMatchObject({
      obligationCents: 10_000,
      explicitPaymentCents: 10_000,
      paymentCents: 10_000,
      carryingBalanceAfterPaymentCents: 0,
    });
  });

  it('uses the full projected debt schedule for purchase impact, including explicit cash and credit', () => {
    const fullPayCard = card({ paymentPolicy: 'full-statement' });
    const statement = cycle('purchase-impact-statement', '2032-02-15', {
      opensOn: '2032-01-01',
      closesOn: '2032-01-31',
      state: 'open',
      actualActivityCents: 10_000,
    });
    const coveringPayment = forecastEventSchema.parse({
      id: 'purchase-impact-covering-payment',
      userId: fullPayCard.userId,
      accountId: account.id,
      date: '2032-02-15',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 15_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Known future card payment',
      sourceRecordId: statement.id,
      paymentMethod: 'cash-account',
      cardId: fullPayCard.id,
    });

    expect(
      calculateCardPurchaseCashImpact({
        card: fullPayCard,
        cardCycles: [statement],
        cardActivities: [coveringPayment],
        purchaseDate: '2032-01-20',
        amountCents: 2_000,
      }),
    ).toMatchObject({
      baselineScheduledPaymentCents: 15_000,
      afterPurchaseScheduledPaymentCents: 15_000,
      incrementalCashPaymentCents: 0,
    });

    const prior = cycle('purchase-impact-prior-credit', '2032-02-15', {
      opensOn: '2032-01-01',
      closesOn: '2032-01-31',
      state: 'scheduled-payment',
      actualActivityCents: 0,
      lockedStatementCents: 10_000,
    });
    const current = cycle('purchase-impact-after-credit', '2032-03-15', {
      opensOn: '2032-02-01',
      closesOn: '2032-02-29',
      actualActivityCents: 8_000,
    });
    const overpayment = forecastEventSchema.parse({
      ...coveringPayment,
      id: 'purchase-impact-prior-overpayment',
      sourceRecordId: prior.id,
    });
    expect(
      calculateCardPurchaseCashImpact({
        card: fullPayCard,
        cardCycles: [prior, current],
        cardActivities: [overpayment],
        purchaseDate: '2032-02-20',
        amountCents: 2_000,
      }),
    ).toMatchObject({
      owningCycle: { id: current.id },
      baselineScheduledPaymentCents: 3_000,
      afterPurchaseScheduledPaymentCents: 5_000,
      incrementalCashPaymentCents: 2_000,
    });
  });

  it('uses a statement overpayment to reduce the next open cycle without negative carry', () => {
    const fullPayCard = card({ paymentPolicy: 'full-statement' });
    const statement = cycle('overpaid-statement', '2032-02-15', {
      opensOn: '2032-01-01',
      closesOn: '2032-01-31',
      state: 'scheduled-payment',
      actualActivityCents: 0,
      lockedStatementCents: 10_000,
    });
    const next = cycle('open-after-overpayment', '2032-03-15', {
      opensOn: '2032-02-01',
      closesOn: '2032-02-29',
      actualActivityCents: 8_000,
    });
    const result = projectCardDebtSchedule({
      card: fullPayCard,
      cardCycles: [statement, next],
      asOfDate: '2032-02-01',
      scheduledPayments: [
        {
          id: 'total-balance-payment',
          date: '2032-02-15',
          amountCents: 15_000,
          cycleId: statement.id,
        },
      ],
    });

    expect(result[0]).toMatchObject({
      obligationCents: 10_000,
      explicitPaymentCents: 15_000,
      generatedPaymentCents: 0,
      excessPaymentCents: 5_000,
      carryingBalanceAfterPaymentCents: 0,
      balanceCreditAfterPaymentCents: 5_000,
    });
    expect(result[1]).toMatchObject({
      obligationCents: 3_000,
      generatedPaymentCents: 3_000,
      carryingBalanceAfterPaymentCents: 0,
      balanceCreditAfterPaymentCents: 0,
    });
  });

  it('supports multiple zero-interest installment payments without amortizing card debt as a loan', () => {
    const installmentCard = card({ paymentPolicy: 'manual' }, { aprBasisPoints: 0 });
    const cycles = [
      cycle('installment-one', '2032-02-15', { actualActivityCents: 0 }),
      cycle('installment-two', '2032-03-15', {
        opensOn: '2032-02-01',
        closesOn: '2032-02-28',
        actualActivityCents: 0,
      }),
      cycle('installment-three', '2032-04-15', {
        opensOn: '2032-03-01',
        closesOn: '2032-03-31',
        actualActivityCents: 0,
      }),
    ];
    const result = projectCardDebtSchedule({
      card: installmentCard,
      cardCycles: cycles,
      asOfDate: '2032-01-20',
      openingCarryingBalance: { cents: 30_000, asOfDate: '2032-01-20' },
      scheduledPayments: cycles.map((item, index) => ({
        id: `installment-payment-${index + 1}`,
        date: item.paymentOn ?? item.dueOn,
        amountCents: 10_000,
      })),
    });

    expect(
      result.map((item) => ({
        obligationCents: item.obligationCents,
        interestOnCarryCents: item.interestOnCarryCents,
        explicitPaymentCents: item.explicitPaymentCents,
        generatedPaymentCents: item.generatedPaymentCents,
        carryingBalanceAfterPaymentCents: item.carryingBalanceAfterPaymentCents,
      })),
    ).toEqual([
      {
        obligationCents: 30_000,
        interestOnCarryCents: 0,
        explicitPaymentCents: 10_000,
        generatedPaymentCents: 0,
        carryingBalanceAfterPaymentCents: 20_000,
      },
      {
        obligationCents: 20_000,
        interestOnCarryCents: 0,
        explicitPaymentCents: 10_000,
        generatedPaymentCents: 0,
        carryingBalanceAfterPaymentCents: 10_000,
      },
      {
        obligationCents: 10_000,
        interestOnCarryCents: 0,
        explicitPaymentCents: 10_000,
        generatedPaymentCents: 0,
        carryingBalanceAfterPaymentCents: 0,
      },
    ]);
  });
});
