import { describe, expect, it } from 'vitest';
import { creditCardCycleSchema, forecastEventSchema } from '@balance-book/domain';
import {
  confirmExpectedEventRequest,
  confirmScheduledCardPaymentRequest,
  receiveMoneyOwedRequest,
} from '../apps/desktop/src/renderer/notification-actions';

describe('notification canonical action requests', () => {
  it('confirms the exact scheduled statement payment and funding account', () => {
    const cycle = creditCardCycleSchema.parse({
      id: 'cycle',
      cardId: 'card',
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-20',
      state: 'scheduled-payment',
      defaultEstimateCents: 20_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 18_500,
      paymentOn: '2026-07-18',
    });
    expect(
      confirmScheduledCardPaymentRequest({
        cycle,
        amountCents: 18_500,
        paymentDate: '2026-07-18',
        fundingAccountId: 'checking',
      }),
    ).toEqual({
      entityType: 'card-cycle',
      payload: expect.objectContaining({
        id: 'cycle',
        state: 'paid',
        paymentOn: '2026-07-18',
        actualPaymentCents: 18_500,
        actualPaymentAccountId: 'checking',
      }),
    });
  });

  it('marks one expected event complete without changing its financial facts', () => {
    const event = forecastEventSchema.parse({
      id: 'expected',
      userId: 'profile',
      accountId: 'checking',
      date: '2026-07-18',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 4_200,
      certainty: 'expected',
      status: 'scheduled',
      label: 'One-time bill',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'cash-account',
    });
    expect(confirmExpectedEventRequest(event)).toEqual({
      entityType: 'forecast-event',
      payload: { ...event, certainty: 'confirmed', status: 'confirmed' },
    });
  });

  it('builds the existing atomic receivable settlement command', () => {
    expect(
      receiveMoneyOwedRequest({
        receivableId: 'owed',
        amountCents: 28_800,
        date: '2026-08-01',
        occurrenceDate: '2026-08-01',
        destinationAccountId: 'pnc',
      }),
    ).toEqual({
      receivableId: 'owed',
      amountCents: 28_800,
      date: '2026-08-01',
      occurrenceDate: '2026-08-01',
      destinationAccountId: 'pnc',
    });
  });
});
