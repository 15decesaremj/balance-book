import { describe, expect, it } from 'vitest';
import { cashAccountSchema, creditCardCycleSchema, creditCardSchema } from '@balance-book/domain';
import {
  assertCashBackedCardPurchaseEligibility,
  calculateCardSpendingPower,
  materializeForecastEvents,
  projectedCycleObligation,
  resolveCardCyclesAsOf,
} from '@balance-book/financial-engine';

const card = (overrides: Partial<ReturnType<typeof creditCardSchema.parse>> = {}) =>
  creditCardSchema.parse({
    id: 'card-a',
    userId: 'user-a',
    name: 'Everyday card',
    fundingAccountId: 'checking',
    defaultFutureStatementCents: 54_321,
    estimatePolicy: 'actual-reset',
    paymentPolicy: 'full-statement',
    paymentDayOfMonth: 13,
    statementCloseDayOfMonth: 19,
    ...overrides,
  });

const futureCycle = (overrides: Partial<ReturnType<typeof creditCardCycleSchema.parse>> = {}) =>
  creditCardCycleSchema.parse({
    id: 'cycle-a',
    cardId: 'card-a',
    opensOn: '2026-07-20',
    closesOn: '2026-08-19',
    dueOn: '2026-09-13',
    paymentOn: '2026-09-14',
    state: 'future-estimated',
    defaultEstimateCents: 54_321,
    actualActivityCents: 0,
    plannedActivityCents: 0,
    ...overrides,
  });

describe('date-driven card lifecycle', () => {
  it('limits cash-backed card purchase guidance to full-statement payment cards', () => {
    expect(() => assertCashBackedCardPurchaseEligibility(card())).not.toThrow();
    for (const paymentPolicy of ['minimum', 'fixed', 'manual'] as const) {
      expect(() =>
        assertCashBackedCardPurchaseEligibility(
          card({
            paymentPolicy,
            minimumPaymentCents: paymentPolicy === 'minimum' ? 2_500 : undefined,
            fixedPaymentCents: paymentPolicy === 'fixed' ? 10_000 : undefined,
          }),
        ),
      ).toThrow(/full-statement payment policy/i);
    }
  });

  it('reserves a future baseline until the opening date, then actual-reset uses entered activity', () => {
    const exampleCard = card();
    const cycle = futureCycle();
    const beforeOpen = resolveCardCyclesAsOf({
      cardCycles: [cycle],
      asOfDate: '2026-07-19',
    })[0]!;
    const onOpen = resolveCardCyclesAsOf({
      cardCycles: [cycle],
      asOfDate: '2026-07-20',
    })[0]!;

    expect(beforeOpen.state).toBe('future-estimated');
    expect(projectedCycleObligation(exampleCard, beforeOpen)).toBe(54_321);
    expect(onOpen.state).toBe('open');
    expect(projectedCycleObligation(exampleCard, onOpen)).toBe(0);
  });

  it('keeps a smaller activity snapshot behind the future baseline and reveals it on open', () => {
    const exampleCard = card({ defaultFutureStatementCents: 21_000 });
    const cycle = futureCycle({
      defaultEstimateCents: 21_000,
      actualActivityCents: 8_750,
    });
    const beforeOpen = resolveCardCyclesAsOf({
      cardCycles: [cycle],
      asOfDate: '2026-07-19',
    })[0]!;
    const onOpen = resolveCardCyclesAsOf({
      cardCycles: [cycle],
      asOfDate: '2026-07-20',
    })[0]!;

    expect(projectedCycleObligation(exampleCard, beforeOpen)).toBe(21_000);
    expect(projectedCycleObligation(exampleCard, onOpen)).toBe(8_750);
  });

  it('retains the estimate when a supposedly future cycle is already past close', () => {
    const stale = futureCycle({
      opensOn: '2026-06-20',
      closesOn: '2026-07-19',
      dueOn: '2026-08-13',
    });
    const resolved = resolveCardCyclesAsOf({
      cardCycles: [stale],
      asOfDate: '2026-07-20',
    })[0]!;

    expect(resolved.state).toBe('future-estimated');
    expect(projectedCycleObligation(card(), resolved)).toBe(54_321);

    const spendingPower = calculateCardSpendingPower({
      cards: [card()],
      cardCycles: [stale],
      asOfDate: '2026-07-20',
      days: [
        {
          date: '2026-07-20',
          consolidatedCashCents: 100_000,
          totalPositionCents: 100_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 100_000 }],
        },
      ],
    })[0]!;
    expect(spendingPower.statementCycleId).toBe(stale.id);
    expect(spendingPower.statementAmountCents).toBe(54_321);
    expect(spendingPower.statementDueOn).toBe('2026-08-13');
    expect(spendingPower.statementState).toBe('future-estimated');
  });

  it('surfaces a past-close open cycle as an unresolved statement coming due', () => {
    const staleOpen = futureCycle({
      opensOn: '2026-06-20',
      closesOn: '2026-07-19',
      dueOn: '2026-08-13',
      state: 'open',
      actualActivityCents: 50_000,
    });
    const result = calculateCardSpendingPower({
      cards: [card()],
      cardCycles: [staleOpen],
      asOfDate: '2026-07-20',
      days: [
        {
          date: '2026-07-20',
          consolidatedCashCents: 100_000,
          totalPositionCents: 100_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 100_000 }],
        },
      ],
    })[0]!;

    expect(result.statementCycleId).toBe(staleOpen.id);
    expect(result.statementAmountCents).toBe(50_000);
    expect(result.statementState).toBe('open');
  });

  it('keeps later capacity conditional when an account breaches its floor before payment', () => {
    const result = calculateCardSpendingPower({
      cards: [
        card({
          defaultFutureStatementCents: 0,
          paymentDayOfMonth: 14,
          statementCloseDayOfMonth: 13,
        }),
      ],
      cardCycles: [
        futureCycle({
          opensOn: '2026-07-14',
          closesOn: '2026-08-13',
          dueOn: '2026-09-14',
          defaultEstimateCents: 0,
          paymentOn: '2026-09-14',
        }),
      ],
      asOfDate: '2026-07-15',
      hardFloorCents: 0,
      accountHardFloorCentsById: { checking: 0, savings: 0 },
      days: [
        {
          date: '2026-08-15',
          consolidatedCashCents: 150_000,
          totalPositionCents: 150_000,
          accountBalances: [
            { accountId: 'checking', endingBalanceCents: -7_500 },
            { accountId: 'savings', endingBalanceCents: 157_500 },
          ],
        },
        {
          date: '2026-09-14',
          consolidatedCashCents: 164_000,
          totalPositionCents: 164_000,
          accountBalances: [
            { accountId: 'checking', endingBalanceCents: 64_000 },
            { accountId: 'savings', endingBalanceCents: 100_000 },
          ],
        },
      ],
    })[0]!;

    expect(result.spendingPowerStatus).toBe('conditional-existing-shortfall');
    expect(result.prePaymentShortfallCents).toBe(7_500);
    expect(result.prePaymentShortfallDate).toBe('2026-08-15');
    expect(result.prePaymentShortfallAccountId).toBe('checking');
    expect(result.spendingPowerCents).toBe(164_000);
    expect(result.cashBackedCapacityCents).toBe(64_000);
  });

  it('reports the deepest prerequisite shortfall instead of stopping at the first breach', () => {
    const result = calculateCardSpendingPower({
      cards: [
        card({
          defaultFutureStatementCents: 0,
          paymentDayOfMonth: 14,
          statementCloseDayOfMonth: 13,
        }),
      ],
      cardCycles: [
        futureCycle({
          opensOn: '2026-07-14',
          closesOn: '2026-08-13',
          dueOn: '2026-09-14',
          defaultEstimateCents: 0,
          paymentOn: '2026-09-14',
        }),
      ],
      asOfDate: '2026-07-15',
      accountHardFloorCentsById: { checking: 0 },
      days: [
        {
          date: '2026-08-01',
          consolidatedCashCents: 99_000,
          totalPositionCents: 99_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: -1_000 }],
        },
        {
          date: '2026-08-15',
          consolidatedCashCents: 90_000,
          totalPositionCents: 90_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: -10_000 }],
        },
        {
          date: '2026-09-14',
          consolidatedCashCents: 120_000,
          totalPositionCents: 120_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 120_000 }],
        },
      ],
    })[0]!;

    expect(result.spendingPowerStatus).toBe('conditional-existing-shortfall');
    expect(result.prePaymentShortfallCents).toBe(10_000);
    expect(result.prePaymentShortfallDate).toBe('2026-08-15');
    expect(result.prePaymentShortfallAccountId).toBe('checking');
  });

  it('does not invent card-cycle timing for a manual account with no source dates', () => {
    const incomplete = card({
      name: 'Manual account',
      paymentPolicy: 'manual',
      paymentDayOfMonth: undefined,
      statementCloseDayOfMonth: undefined,
    });
    const result = calculateCardSpendingPower({
      cards: [incomplete],
      cardCycles: [],
      asOfDate: '2026-07-15',
      days: [
        {
          date: '2026-07-15',
          consolidatedCashCents: 100_000,
          totalPositionCents: 100_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 100_000 }],
        },
      ],
    })[0]!;

    expect(result.cardName).toBe('Manual account');
    expect(result.spendingPowerStatus).toBe('indeterminate-cycle-timing');
    expect(result.spendingPowerCents).toBe(0);
    expect(result.currentCycleId).toBeUndefined();
    expect(result.currentCyclePaymentOn).toBeUndefined();
  });

  it('keeps a past-due statement visible when its scheduled payment date is still ahead', () => {
    const scheduledStatement = futureCycle({
      id: 'scheduled-past-due',
      opensOn: '2026-05-11',
      closesOn: '2026-06-10',
      dueOn: '2026-07-10',
      paymentOn: '2026-07-20',
      state: 'scheduled-payment',
      lockedStatementCents: 50_000,
      defaultEstimateCents: 0,
    });
    const account = cashAccountSchema.parse({
      id: 'checking',
      userId: 'user-a',
      name: 'Checking',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-07-14',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 0,
    });
    const events = materializeForecastEvents({
      accounts: [account],
      events: [],
      cards: [card()],
      cardCycles: [scheduledStatement],
      loans: [],
      receivables: [],
      startDate: '2026-07-15',
      endDate: '2026-09-30',
    });
    expect(events.find((event) => event.id === 'card-payment-scheduled-past-due')).toMatchObject({
      date: '2026-07-20',
      amountCents: 50_000,
      status: 'scheduled',
    });

    const result = calculateCardSpendingPower({
      cards: [card()],
      cardCycles: [scheduledStatement],
      asOfDate: '2026-07-15',
      days: [
        {
          date: '2026-07-15',
          consolidatedCashCents: 100_000,
          totalPositionCents: 100_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 100_000 }],
        },
        {
          date: '2026-09-13',
          consolidatedCashCents: 50_000,
          totalPositionCents: 50_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 50_000 }],
        },
      ],
    })[0]!;
    expect(result).toMatchObject({
      statementCycleId: 'scheduled-past-due',
      statementAmountCents: 50_000,
      statementDueOn: '2026-07-10',
      statementState: 'scheduled-payment',
    });
  });

  it('makes capacity indeterminate when a locked past-due statement has no payment timing', () => {
    const overdueStatement = futureCycle({
      id: 'overdue-without-payment-date',
      opensOn: '2026-05-11',
      closesOn: '2026-06-10',
      dueOn: '2026-07-10',
      paymentOn: undefined,
      state: 'closed-statement',
      lockedStatementCents: 50_000,
      defaultEstimateCents: 0,
    });
    const result = calculateCardSpendingPower({
      cards: [card()],
      cardCycles: [overdueStatement],
      asOfDate: '2026-07-15',
      days: [
        {
          date: '2026-07-15',
          consolidatedCashCents: 100_000,
          totalPositionCents: 100_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 100_000 }],
        },
        {
          date: '2026-09-13',
          consolidatedCashCents: 100_000,
          totalPositionCents: 100_000,
          accountBalances: [{ accountId: 'checking', endingBalanceCents: 100_000 }],
        },
      ],
    })[0]!;

    expect(result).toMatchObject({
      statementCycleId: 'overdue-without-payment-date',
      statementAmountCents: 50_000,
      statementDueOn: '2026-07-10',
      spendingPowerStatus: 'indeterminate-overdue-payment-timing',
      spendingPowerCents: 0,
    });
  });
});
