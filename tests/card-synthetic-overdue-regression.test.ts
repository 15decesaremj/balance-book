import { describe, expect, it } from 'vitest';
import { cashAccountSchema, creditCardCycleSchema, creditCardSchema } from '@balance-book/domain';
import {
  generateCardCyclesThroughHorizon,
  materializeForecastEvents,
  projectCardDebtSchedule,
} from '@balance-book/financial-engine';

const account = cashAccountSchema.parse({
  id: 'checking',
  userId: 'user-a',
  name: 'Checking',
  type: 'checking',
  openingBalanceCents: 100_000,
  balanceAsOf: '2026-01-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  transferDelayDays: 0,
});

const card = creditCardSchema.parse({
  id: 'card-a',
  userId: 'user-a',
  name: 'Everyday card',
  fundingAccountId: account.id,
  defaultFutureStatementCents: 10_000,
  estimatePolicy: 'baseline-guardrail',
  paymentPolicy: 'full-statement',
  paymentDayOfMonth: 10,
  statementCloseDayOfMonth: 15,
});

describe('synthetic card-cycle overdue protection', () => {
  it('does not invent a past-due cycle or roll its baseline into the next statement', () => {
    const cycles = generateCardCyclesThroughHorizon({
      card,
      cardCycles: [],
      startDate: '2026-01-16',
      endDate: '2026-03-31',
    });

    expect(cycles.some((cycle) => cycle.dueOn === '2026-01-10')).toBe(false);
    expect(cycles.some((cycle) => cycle.dueOn === '2026-02-10')).toBe(true);
    expect(
      generateCardCyclesThroughHorizon({
        card,
        cardCycles: [],
        startDate: '2026-01-10',
        endDate: '2026-01-31',
      }).some((cycle) => cycle.dueOn === '2026-01-10'),
    ).toBe(true);

    const payments = materializeForecastEvents({
      accounts: [account],
      events: [],
      cards: [card],
      cardCycles: [],
      loans: [],
      startDate: '2026-01-16',
      endDate: '2026-03-31',
    }).filter((event) => event.kind === 'card-payment');

    expect(payments.find((event) => event.date === '2026-02-10')).toMatchObject({
      amountCents: 10_000,
    });
  });

  it('continues to carry a real stored overdue statement into the next payment', () => {
    const overdueStatement = creditCardCycleSchema.parse({
      id: 'stored-overdue-statement',
      cardId: card.id,
      opensOn: '2025-11-16',
      closesOn: '2025-12-15',
      dueOn: '2026-01-10',
      state: 'scheduled-payment',
      defaultEstimateCents: 12_000,
      actualActivityCents: 12_000,
      plannedActivityCents: 0,
      lockedStatementCents: 12_000,
    });
    const nextCycle = creditCardCycleSchema.parse({
      id: 'next-cycle',
      cardId: card.id,
      opensOn: '2025-12-16',
      closesOn: '2026-01-15',
      dueOn: '2026-02-10',
      state: 'future-estimated',
      defaultEstimateCents: 10_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });

    const schedule = projectCardDebtSchedule({
      card,
      cardCycles: [overdueStatement, nextCycle],
      asOfDate: '2026-01-16',
    });

    expect(schedule[0]).toMatchObject({
      cycle: { id: overdueStatement.id },
      obligationCents: 12_000,
      paymentCents: 0,
      carryingBalanceAfterPaymentCents: 12_000,
    });
    expect(schedule[1]).toMatchObject({
      cycle: { id: nextCycle.id },
      obligationCents: 22_000,
      paymentCents: 22_000,
      carryingBalanceAfterPaymentCents: 0,
    });
  });
});
