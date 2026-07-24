import { describe, expect, it } from 'vitest';
import {
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
} from '@balance-book/domain';
import {
  enrichCardCyclesWithActivities,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';

const makeCard = (overrides: Partial<CreditCard> = {}): CreditCard =>
  creditCardSchema.parse({
    id: 'card-one',
    userId: 'synthetic-user',
    name: 'Synthetic card',
    fundingAccountId: 'bank-one',
    accountKind: 'credit-card',
    defaultFutureStatementCents: 0,
    estimatePolicy: 'actual-reset',
    paymentPolicy: 'full-statement',
    ...overrides,
  });

const makeCycle = (overrides: Partial<CreditCardCycle> = {}): CreditCardCycle =>
  creditCardCycleSchema.parse({
    id: 'cycle-one',
    cardId: 'card-one',
    opensOn: '2026-05-01',
    closesOn: '2026-05-31',
    dueOn: '2026-06-20',
    state: 'closed-statement',
    defaultEstimateCents: 0,
    actualActivityCents: 0,
    plannedActivityCents: 0,
    lockedStatementCents: 100_000,
    ...overrides,
  });

const makeEvent = (overrides: Partial<ForecastEvent> = {}): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'card-event-one',
    userId: 'synthetic-user',
    accountId: 'bank-one',
    date: '2026-06-10',
    kind: 'scenario',
    direction: 'outflow',
    amountCents: 1_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Synthetic card event',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'credit-card',
    cardId: 'card-one',
    cardActivityTreatment: 'additional',
    ...overrides,
  });

const makeOpenCycle = (overrides: Partial<CreditCardCycle> = {}): CreditCardCycle =>
  makeCycle({
    id: 'cycle-open',
    opensOn: '2026-06-01',
    closesOn: '2026-06-30',
    dueOn: '2026-07-20',
    state: 'open',
    lockedStatementCents: undefined,
    ...overrides,
  });

describe('revolving debt summary', () => {
  it('keeps a paid-in-full statement visible while current and carrying debt return to zero', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [makeCycle({ state: 'paid', paymentOn: '2026-06-18', actualPaymentCents: 100_000 })],
      asOfDate: '2026-06-21',
    });

    expect(summary).toEqual({
      latestStatementCents: 100_000,
      latestStatementDate: '2026-05-31',
      amountCurrentlyDueCents: 0,
      actualOpenCycleCents: 0,
      unreconciledPostCloseActivityCents: 0,
      projectedOpenCycleCents: 0,
      currentBalanceCents: 0,
      carryingBalanceCents: 0,
      projectedCarryingBalanceCents: 0,
      overdue: false,
      source: 'cycle-derived',
      reportedBalanceHasUnresolvedSameCycleActivity: false,
    });
  });

  it('treats a paid legacy cycle without an actual payment amount as paid in full', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [makeCycle({ state: 'paid', paymentOn: '2026-06-18' })],
      asOfDate: '2026-06-21',
    });

    expect(summary.amountCurrentlyDueCents).toBe(0);
    expect(summary.latestStatementCents).toBe(100_000);
    expect(summary.carryingBalanceCents).toBe(0);
  });

  it('carries an unpaid statement once it is overdue', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [makeCycle()],
      asOfDate: '2026-06-21',
    });

    expect(summary).toMatchObject({
      amountCurrentlyDueCents: 100_000,
      currentBalanceCents: 100_000,
      carryingBalanceCents: 100_000,
      projectedCarryingBalanceCents: 100_000,
      overdue: true,
    });
  });

  it('keeps financed carry after a recorded partial payment without calling it past due', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({ paymentPolicy: 'minimum', minimumPaymentCents: 25_000 }),
      cycles: [makeCycle({ state: 'paid', paymentOn: '2026-06-20', actualPaymentCents: 25_000 })],
      asOfDate: '2026-06-21',
    });

    expect(summary).toMatchObject({
      latestStatementCents: 100_000,
      amountCurrentlyDueCents: 75_000,
      currentBalanceCents: 75_000,
      carryingBalanceCents: 75_000,
      projectedCarryingBalanceCents: 75_000,
      overdue: false,
    });
  });

  it.each([
    {
      policy: 'minimum' as const,
      cardTerms: { minimumPaymentCents: 2_500 },
      expectedCarry: 97_500,
    },
    {
      policy: 'fixed' as const,
      cardTerms: { fixedPaymentCents: 30_000 },
      expectedCarry: 70_000,
    },
    { policy: 'manual' as const, cardTerms: {}, expectedCarry: 100_000 },
  ])(
    'projects the residual under a $policy payment policy',
    ({ policy, cardTerms, expectedCarry }) => {
      const summary = summarizeRevolvingDebt({
        card: makeCard({ paymentPolicy: policy, ...cardTerms }),
        cycles: [makeCycle({ state: 'scheduled-payment', paymentOn: '2026-06-20' })],
        asOfDate: '2026-06-15',
      });

      expect(summary.carryingBalanceCents).toBe(0);
      expect(summary.projectedCarryingBalanceCents).toBe(expectedCarry);
    },
  );

  it('projects zero carry for an on-time full-statement payment', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [makeCycle({ state: 'scheduled-payment', paymentOn: '2026-06-20' })],
      asOfDate: '2026-06-15',
    });

    expect(summary.amountCurrentlyDueCents).toBe(100_000);
    expect(summary.projectedCarryingBalanceCents).toBe(0);
  });

  it('uses a total-balance payment event to pay beyond the statement into open-cycle debt', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [makeCycle(), makeOpenCycle({ actualActivityCents: 8_000 })],
      events: [
        makeEvent({
          id: 'total-balance-payment',
          date: '2026-06-18',
          kind: 'card-payment',
          amountCents: 120_000,
          status: 'confirmed',
          paymentMethod: 'cash-account',
          cardActivityTreatment: undefined,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.amountCurrentlyDueCents).toBe(0);
    expect(summary.actualOpenCycleCents).toBe(8_000);
    expect(summary.currentBalanceCents).toBe(0);
  });

  it('separates actual current-cycle debt from planned and baseline projections', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        estimatePolicy: 'baseline-guardrail',
        defaultFutureStatementCents: 60_000,
      }),
      cycles: [
        makeCycle({
          state: 'paid',
          paymentOn: '2026-06-18',
          actualPaymentCents: 100_000,
        }),
        makeCycle({
          id: 'cycle-two',
          opensOn: '2026-06-01',
          closesOn: '2026-06-30',
          dueOn: '2026-07-20',
          state: 'open',
          defaultEstimateCents: 60_000,
          actualActivityCents: 12_000,
          plannedActivityCents: 25_000,
          lockedStatementCents: undefined,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.actualOpenCycleCents).toBe(12_000);
    expect(summary.projectedOpenCycleCents).toBe(60_000);
    expect(summary.currentBalanceCents).toBe(12_000);
  });

  it('lets the latest locked statement supersede older statement balances', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [
        makeCycle({
          id: 'older',
          opensOn: '2026-04-01',
          closesOn: '2026-04-30',
          dueOn: '2026-05-20',
        }),
        makeCycle({ id: 'latest', lockedStatementCents: 125_000 }),
      ],
      asOfDate: '2026-06-15',
    });

    expect(summary.latestStatementCents).toBe(125_000);
    expect(summary.latestStatementDate).toBe('2026-05-31');
    expect(summary.amountCurrentlyDueCents).toBe(125_000);
    expect(summary.currentBalanceCents).toBe(125_000);
  });

  it('uses effective reported total and carrying snapshots for their respective metrics', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedBalanceCents: 88_000,
        reportedBalanceDate: '2026-06-20',
        reportedCarryingBalanceCents: 7_000,
        reportedCarryingBalanceDate: '2026-06-19',
      }),
      cycles: [makeCycle()],
      asOfDate: '2026-06-20',
    });

    expect(summary).toMatchObject({
      amountCurrentlyDueCents: 100_000,
      currentBalanceCents: 88_000,
      carryingBalanceCents: 7_000,
      overdue: false,
      source: 'reported',
    });
  });

  it('shows available credit without treating the credit line as cash', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        creditLimitCents: 250_000,
        reportedBalanceCents: 88_000,
        reportedBalanceDate: '2026-06-20',
      }),
      cycles: [makeCycle()],
      asOfDate: '2026-06-21',
    });

    expect(summary.currentBalanceCents).toBe(88_000);
    expect(summary.availableCreditCents).toBe(162_000);
  });

  it('ignores snapshots dated after the financial as-of date', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedBalanceCents: 88_000,
        reportedBalanceDate: '2026-06-22',
        reportedCarryingBalanceCents: 7_000,
        reportedCarryingBalanceDate: '2026-06-22',
      }),
      cycles: [makeCycle()],
      asOfDate: '2026-06-21',
    });

    expect(summary.currentBalanceCents).toBe(100_000);
    expect(summary.carryingBalanceCents).toBe(100_000);
    expect(summary.source).toBe('cycle-derived');
  });

  it('keeps posted activity visible after an unlocked cycle closes', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [
        makeCycle({
          state: 'open',
          lockedStatementCents: undefined,
          actualActivityCents: 31_250,
        }),
      ],
      asOfDate: '2026-06-05',
    });

    expect(summary.currentBalanceCents).toBe(31_250);
    expect(summary.actualOpenCycleCents).toBe(31_250);
    expect(summary.unreconciledPostCloseActivityCents).toBe(31_250);
  });

  it('lets a newer locked statement supersede an older reported snapshot', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedBalanceCents: 0,
        reportedBalanceDate: '2026-04-30',
        reportedCarryingBalanceCents: 0,
        reportedCarryingBalanceDate: '2026-04-30',
      }),
      cycles: [makeCycle()],
      asOfDate: '2026-06-21',
    });

    expect(summary.source).toBe('cycle-derived');
    expect(summary.currentBalanceCents).toBe(100_000);
    expect(summary.carryingBalanceCents).toBe(100_000);
  });

  it('lets a statement become carried after a newer zero-carry snapshot', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedCarryingBalanceCents: 0,
        reportedCarryingBalanceDate: '2026-06-01',
      }),
      cycles: [makeCycle({ dueOn: '2026-06-15' })],
      asOfDate: '2026-06-16',
    });

    expect(summary.carryingBalanceCents).toBe(100_000);
    expect(summary.overdue).toBe(true);
  });

  it('rolls later paid activity against a reported current and carrying balance', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedBalanceCents: 100_000,
        reportedBalanceDate: '2026-05-31',
        reportedCarryingBalanceCents: 60_000,
        reportedCarryingBalanceDate: '2026-05-31',
      }),
      cycles: [
        makeCycle({
          opensOn: '2026-04-01',
          closesOn: '2026-04-30',
          dueOn: '2026-06-10',
          state: 'paid',
          paymentOn: '2026-06-10',
          actualPaymentCents: 25_000,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.source).toBe('reported');
    expect(summary.currentBalanceCents).toBe(75_000);
    expect(summary.carryingBalanceCents).toBe(75_000);
  });

  it('posts confirmed dated card activity while future and expected activity remain planned', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [makeOpenCycle()],
      events: [
        makeEvent({ id: 'posted-purchase', date: '2026-06-10', amountCents: 1_500 }),
        makeEvent({
          id: 'expected-purchase',
          date: '2026-06-11',
          amountCents: 2_000,
          certainty: 'expected',
        }),
        makeEvent({ id: 'future-purchase', date: '2026-06-20', amountCents: 3_000 }),
      ],
      asOfDate: '2026-06-15',
    });

    expect(summary.actualOpenCycleCents).toBe(1_500);
    expect(summary.currentBalanceCents).toBe(1_500);
    expect(summary.projectedOpenCycleCents).toBe(6_500);
  });

  it('rolls only exact later same-cycle activity from a reported balance', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedBalanceCents: 50_000,
        reportedBalanceDate: '2026-06-10',
      }),
      cycles: [makeOpenCycle({ actualActivityCents: 40_000 })],
      events: [
        makeEvent({ id: 'before-report', date: '2026-06-08', amountCents: 3_000 }),
        makeEvent({ id: 'same-day-report', date: '2026-06-10', amountCents: 4_000 }),
        makeEvent({ id: 'after-report', date: '2026-06-12', amountCents: 2_000 }),
        makeEvent({
          id: 'expected-after-report',
          date: '2026-06-13',
          amountCents: 9_000,
          certainty: 'expected',
        }),
      ],
      asOfDate: '2026-06-15',
    });

    expect(summary.source).toBe('reported');
    expect(summary.actualOpenCycleCents).toBe(49_000);
    expect(summary.currentBalanceCents).toBe(52_000);
    expect(summary.reportedBalanceHasUnresolvedSameCycleActivity).toBe(true);
  });

  it('generates the missing dated cycle for confirmed activity after persisted history', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({ paymentDayOfMonth: 15, statementCloseDayOfMonth: 20 }),
      cycles: [],
      events: [
        makeEvent({
          id: 'confirmed-after-history',
          date: '2026-07-10',
          amountCents: 1_500,
        }),
      ],
      asOfDate: '2026-07-15',
    });

    expect(summary.actualOpenCycleCents).toBe(1_500);
    expect(summary.currentBalanceCents).toBe(1_500);
    expect(summary.projectedOpenCycleCents).toBe(1_500);
  });

  it('does not treat a generated same-day payment instruction as completed debt payment', () => {
    const statement = makeCycle({ state: 'scheduled-payment', paymentOn: '2026-06-20' });
    const payment = makeEvent({
      id: `card-payment-${statement.id}`,
      sourceRecordId: statement.id,
      date: '2026-06-20',
      kind: 'card-payment',
      amountCents: 100_000,
      status: 'scheduled',
      paymentMethod: 'cash-account',
      cardActivityTreatment: undefined,
    });
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [statement],
      events: [payment],
      asOfDate: '2026-06-20',
    });

    expect(summary.latestStatementCents).toBe(100_000);
    expect(summary.amountCurrentlyDueCents).toBe(100_000);
    expect(summary.currentBalanceCents).toBe(100_000);
    expect(summary.carryingBalanceCents).toBe(0);
  });

  it('can explicitly include a projected same-day payment on a matching cash-ledger basis', () => {
    const statement = makeCycle({ state: 'scheduled-payment', paymentOn: '2026-06-20' });
    const payment = makeEvent({
      id: `card-payment-${statement.id}`,
      sourceRecordId: statement.id,
      date: '2026-06-20',
      kind: 'card-payment',
      amountCents: 100_000,
      status: 'scheduled',
      paymentMethod: 'cash-account',
      cardActivityTreatment: undefined,
    });
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [statement],
      events: [payment],
      asOfDate: '2026-06-20',
      paymentEvidenceMode: 'include-projected-payments',
    });

    expect(summary.latestStatementCents).toBe(100_000);
    expect(summary.amountCurrentlyDueCents).toBe(0);
    expect(summary.currentBalanceCents).toBe(0);
    expect(summary.carryingBalanceCents).toBe(0);
  });

  it.each(['confirmed', 'paid'] as const)(
    'subtracts only a partial $status payment while ignoring its scheduled remainder',
    (status) => {
      const statement = makeCycle({ state: 'scheduled-payment', paymentOn: '2026-06-20' });
      const partialPayment = makeEvent({
        id: `partial-${status}-payment`,
        sourceRecordId: statement.id,
        date: '2026-06-20',
        kind: 'card-payment',
        amountCents: 25_000,
        status,
        paymentMethod: 'cash-account',
        cardActivityTreatment: undefined,
      });
      const scheduledRemainder = makeEvent({
        id: `card-payment-${statement.id}`,
        sourceRecordId: statement.id,
        date: '2026-06-20',
        kind: 'card-payment',
        amountCents: 75_000,
        status: 'scheduled',
        paymentMethod: 'cash-account',
        cardActivityTreatment: undefined,
      });

      const summary = summarizeRevolvingDebt({
        card: makeCard(),
        cycles: [statement],
        events: [partialPayment, scheduledRemainder],
        asOfDate: '2026-06-20',
      });

      expect(summary.latestStatementCents).toBe(100_000);
      expect(summary.amountCurrentlyDueCents).toBe(75_000);
      expect(summary.currentBalanceCents).toBe(75_000);
      expect(summary.carryingBalanceCents).toBe(0);
    },
  );

  it('rolls a linked payment against later reported total and carrying snapshots', () => {
    const statement = makeCycle({
      opensOn: '2026-04-01',
      closesOn: '2026-04-30',
      dueOn: '2026-06-10',
      state: 'scheduled-payment',
      paymentOn: '2026-06-10',
      lockedStatementCents: 80_000,
    });
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedBalanceCents: 100_000,
        reportedBalanceDate: '2026-05-31',
        reportedCarryingBalanceCents: 60_000,
        reportedCarryingBalanceDate: '2026-05-31',
      }),
      cycles: [statement],
      events: [
        makeEvent({
          id: 'explicit-linked-payment',
          sourceRecordId: statement.id,
          date: '2026-06-10',
          kind: 'card-payment',
          amountCents: 25_000,
          status: 'confirmed',
          paymentMethod: 'cash-account',
          cardActivityTreatment: undefined,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.currentBalanceCents).toBe(75_000);
    expect(summary.carryingBalanceCents).toBe(55_000);
  });

  it('does not double count a generated event when cycle payment evidence exists', () => {
    const paidStatement = makeCycle({
      state: 'paid',
      paymentOn: '2026-06-10',
      actualPaymentCents: 25_000,
    });
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        reportedBalanceCents: 100_000,
        reportedBalanceDate: '2026-05-31',
        reportedCarryingBalanceCents: 60_000,
        reportedCarryingBalanceDate: '2026-05-31',
      }),
      cycles: [paidStatement],
      events: [
        makeEvent({
          id: `card-payment-${paidStatement.id}`,
          sourceRecordId: paidStatement.id,
          date: '2026-06-10',
          kind: 'card-payment',
          amountCents: 25_000,
          status: 'paid',
          paymentMethod: 'cash-account',
          cardActivityTreatment: undefined,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.currentBalanceCents).toBe(75_000);
    expect(summary.carryingBalanceCents).toBe(75_000);
  });

  it('reconciles differing same-day statement and total-balance payment evidence by overlap', () => {
    const paidStatement = makeCycle({
      state: 'paid',
      paymentOn: '2026-06-18',
      actualPaymentCents: 100_000,
    });
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [paidStatement, makeOpenCycle({ actualActivityCents: 30_000 })],
      events: [
        makeEvent({
          id: 'issuer-total-balance-payment',
          date: '2026-06-18',
          kind: 'card-payment',
          amountCents: 120_000,
          status: 'confirmed',
          paymentMethod: 'cash-account',
          cardActivityTreatment: undefined,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.amountCurrentlyDueCents).toBe(0);
    expect(summary.actualOpenCycleCents).toBe(30_000);
    expect(summary.currentBalanceCents).toBe(10_000);
  });

  it('reconciles linked payment evidence by cycle lineage when its corrected date differs', () => {
    const paidStatement = makeCycle({
      state: 'paid',
      paymentOn: '2026-06-20',
      actualPaymentCents: 100_000,
    });
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [paidStatement, makeOpenCycle({ actualActivityCents: 30_000 })],
      events: [
        makeEvent({
          id: 'corrected-linked-total-payment',
          sourceRecordId: paidStatement.id,
          date: '2026-06-18',
          kind: 'card-payment',
          amountCents: 120_000,
          status: 'paid',
          paymentMethod: 'cash-account',
          cardActivityTreatment: undefined,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.amountCurrentlyDueCents).toBe(0);
    expect(summary.currentBalanceCents).toBe(10_000);
  });

  it('preserves linked payment excess so it can reduce open-cycle debt', () => {
    const statement = makeCycle({ state: 'scheduled-payment', paymentOn: '2026-06-18' });
    const summary = summarizeRevolvingDebt({
      card: makeCard(),
      cycles: [statement, makeOpenCycle({ actualActivityCents: 30_000 })],
      events: [
        makeEvent({
          id: 'linked-total-balance-payment',
          sourceRecordId: statement.id,
          date: '2026-06-18',
          kind: 'card-payment',
          amountCents: 120_000,
          status: 'paid',
          paymentMethod: 'cash-account',
          cardActivityTreatment: undefined,
        }),
      ],
      asOfDate: '2026-06-21',
    });

    expect(summary.amountCurrentlyDueCents).toBe(0);
    expect(summary.currentBalanceCents).toBe(10_000);
  });

  it('deduplicates a recurrence parent and its materialized occurrence by lineage and date', () => {
    const june = makeOpenCycle();
    const july = makeOpenCycle({
      id: 'cycle-july',
      opensOn: '2026-07-01',
      closesOn: '2026-07-31',
      dueOn: '2026-08-20',
      state: 'future-estimated',
    });
    const parent = makeEvent({
      id: 'recurring-card-activity',
      date: '2026-06-05',
      amountCents: 300,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 5, interval: 1 },
    });
    const materializedJune = makeEvent({
      ...parent,
      id: 'recurring-card-activity@2026-06-05',
      sourceRecordId: parent.id,
      date: '2026-06-05',
      status: 'confirmed',
    });
    const enriched = enrichCardCyclesWithActivities({
      cardCycles: [june, july],
      cardActivities: [parent, materializedJune, materializedJune],
      endDate: '2026-07-31',
      asOfDate: '2026-07-10',
    });

    expect(enriched.find((cycle) => cycle.id === june.id)?.actualActivityCents).toBe(300);
    expect(enriched.find((cycle) => cycle.id === july.id)?.actualActivityCents).toBe(300);
  });

  it('treats a line of credit as revolving debt rather than amortizing it', () => {
    const summary = summarizeRevolvingDebt({
      card: makeCard({
        accountKind: 'line-of-credit',
        paymentPolicy: 'fixed',
        fixedPaymentCents: 10_000,
      }),
      cycles: [makeCycle({ state: 'scheduled-payment', paymentOn: '2026-06-20' })],
      asOfDate: '2026-06-15',
    });

    expect(summary.currentBalanceCents).toBe(100_000);
    expect(summary.projectedCarryingBalanceCents).toBe(90_000);
  });
});
