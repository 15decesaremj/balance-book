import { describe, expect, it } from 'vitest';
import { forecastEventSchema } from '@balance-book/domain';
import { calculateLongRunMonthlyFreeCashFlow } from '@balance-book/financial-engine';

const scheduledCardPayment = (input: {
  id: string;
  date: string;
  amountCents: number;
  cycleId: string;
  status?: 'planned' | 'scheduled' | 'cancelled';
}) =>
  forecastEventSchema.parse({
    id: input.id,
    userId: 'synthetic-user',
    accountId: 'synthetic-checking',
    date: input.date,
    kind: 'card-payment',
    direction: 'outflow',
    amountCents: input.amountCents,
    certainty: 'confirmed',
    status: input.status ?? 'scheduled',
    label: 'Synthetic scheduled payment',
    sourceRecordId: input.cycleId,
    paymentMethod: 'cash-account',
    cardId: 'synthetic-card',
  });

describe('long-run monthly free cash flow', () => {
  it('uses the weakest clean three-month run and identifies active known card schedules', () => {
    const result = calculateLongRunMonthlyFreeCashFlow({
      positionBeforeWindowCents: 0,
      positionAtWindowEndCents: 1_000_000,
      monthlyPositionCents: [0, 300_000, 400_000, 500_000, 600_000, 800_000, 1_000_000],
      events: [
        scheduledCardPayment({
          id: 'included-one',
          date: '2032-05-15',
          amountCents: 20_000,
          cycleId: 'known-cycle',
        }),
        scheduledCardPayment({
          id: 'included-two',
          date: '2032-06-15',
          amountCents: 20_000,
          cycleId: 'known-cycle',
        }),
        scheduledCardPayment({
          id: 'included-explicit',
          date: '2032-07-15',
          amountCents: 20_000,
          cycleId: 'not-a-known-cycle',
        }),
        scheduledCardPayment({
          id: 'outside-selected-run',
          date: '2032-08-15',
          amountCents: 60_000,
          cycleId: 'known-cycle',
        }),
        scheduledCardPayment({
          id: 'cancelled',
          date: '2032-06-20',
          amountCents: 60_000,
          cycleId: 'known-cycle',
          status: 'cancelled',
        }),
      ],
      scheduledCardCycleIds: new Set(['known-cycle']),
      scheduledCardPaymentEventIds: new Set(['included-explicit']),
      windowStart: '2032-04-01',
      windowEnd: '2032-09-30',
      monthCount: 6,
    });

    expect(result).toEqual({
      monthlyNetCents: 100_000,
      monthlyScheduledCardPaymentCents: 20_000,
      monthlyBeforeScheduledCardPaymentsCents: 120_000,
      windowStart: '2032-05-01',
      windowEnd: '2032-07-31',
      monthCount: 3,
    });
  });

  it('supports a negative base-budget margin and validates the measuring window', () => {
    expect(
      calculateLongRunMonthlyFreeCashFlow({
        positionBeforeWindowCents: 500_000,
        positionAtWindowEndCents: 380_000,
        events: [],
        windowStart: '2032-01-01',
        windowEnd: '2032-12-31',
        monthCount: 12,
      }).monthlyNetCents,
    ).toBe(-10_000);
    expect(() =>
      calculateLongRunMonthlyFreeCashFlow({
        positionBeforeWindowCents: 0,
        positionAtWindowEndCents: 0,
        events: [],
        windowStart: '2032-12-31',
        windowEnd: '2032-01-01',
        monthCount: 12,
      }),
    ).toThrow(/window must end/i);
    expect(() =>
      calculateLongRunMonthlyFreeCashFlow({
        positionBeforeWindowCents: 0,
        positionAtWindowEndCents: 300,
        monthlyPositionCents: [0, 100, 200],
        events: [],
        windowStart: '2032-01-01',
        windowEnd: '2032-03-31',
        monthCount: 3,
      }),
    ).toThrow(/one opening plus one value per month/i);
  });
});
