import { describe, expect, it } from 'vitest';
import {
  creditCardCycleSchema,
  creditCardSchema,
  type CreditCard,
  type CreditCardCycle,
} from '@balance-book/domain';
import { calculateCardSpendingPower } from '@balance-book/financial-engine';

const userId = 'synthetic-user';

const makeCard = (id: string, fundingAccountId = 'bank-two'): CreditCard =>
  creditCardSchema.parse({
    id,
    userId,
    name: `Synthetic ${id}`,
    fundingAccountId,
    defaultFutureStatementCents: 0,
    estimatePolicy: 'actual-reset',
    paymentPolicy: 'full-statement',
  });

const makeOpenCycle = (cardId: string, paymentOn: '2026-08-13' | '2026-08-14'): CreditCardCycle =>
  creditCardCycleSchema.parse({
    id: `cycle-${cardId}`,
    cardId,
    opensOn: '2026-07-01',
    closesOn: '2026-07-31',
    dueOn: paymentOn,
    paymentOn,
    state: 'open',
    defaultEstimateCents: 0,
    actualActivityCents: 0,
    plannedActivityCents: 0,
  });

const cards = [makeCard('card-one'), makeCard('card-two'), makeCard('card-three')];
const cardCycles = [
  makeOpenCycle(cards[0]!.id, '2026-08-13'),
  makeOpenCycle(cards[1]!.id, '2026-08-14'),
  makeOpenCycle(cards[2]!.id, '2026-08-14'),
];

const runwayDays = [
  {
    date: '2026-08-13' as const,
    consolidatedCashCents: 50_000,
    receivableCents: 55_214,
    totalPositionCents: 105_214,
    accountBalances: [
      { accountId: 'bank-one', endingBalanceCents: 30_000 },
      { accountId: 'bank-two', endingBalanceCents: 20_000 },
    ],
  },
  {
    date: '2026-08-14' as const,
    consolidatedCashCents: 25_000,
    receivableCents: 55_214,
    totalPositionCents: 80_214,
    accountBalances: [
      { accountId: 'bank-one', endingBalanceCents: 15_000 },
      { accountId: 'bank-two', endingBalanceCents: 10_000 },
    ],
  },
  {
    date: '2026-08-15' as const,
    consolidatedCashCents: -47_513,
    receivableCents: 55_214,
    totalPositionCents: 7_701,
    accountBalances: [
      { accountId: 'bank-one', endingBalanceCents: 13_347 },
      { accountId: 'bank-two', endingBalanceCents: -60_860 },
    ],
  },
  {
    date: '2026-08-16' as const,
    consolidatedCashCents: 20_000,
    receivableCents: 55_214,
    totalPositionCents: 75_214,
    accountBalances: [
      { accountId: 'bank-one', endingBalanceCents: 40_000 },
      { accountId: 'bank-two', endingBalanceCents: -20_000 },
    ],
  },
];

describe('Spending Power parity', () => {
  it('uses the same total-position runway for every card whose payment precedes the shared trough', () => {
    const result = calculateCardSpendingPower({
      cards,
      cardCycles,
      asOfDate: '2026-07-15',
      hardFloorCents: 0,
      accountHardFloorCentsById: { 'bank-one': 0, 'bank-two': 0 },
      days: runwayDays,
    });

    expect(result).toHaveLength(3);
    for (const card of result) {
      expect(card).toMatchObject({
        spendingPowerCents: 7_701,
        cashBackedCapacityCents: 0,
        spendingPowerStatus: 'determinate',
        futurePositionLowCents: 7_701,
        futurePositionLowDate: '2026-08-15',
        futurePositionLowCashCents: -47_513,
        futurePositionLowReceivableCents: 55_214,
        futurePositionLowAccountBalances: [
          { accountId: 'bank-one', endingBalanceCents: 13_347 },
          { accountId: 'bank-two', endingBalanceCents: -60_860 },
        ],
        fundingAccountLowCents: -60_860,
        fundingAccountLowDate: '2026-08-15',
      });
    }

    expect(result.map((card) => card.currentCyclePaymentOn)).toEqual([
      '2026-08-13',
      '2026-08-14',
      '2026-08-14',
    ]);
    expect(result[0]).toMatchObject({
      paymentDatePositionCents: 105_214,
      paymentDateCashCents: 50_000,
      paymentDateReceivableCents: 55_214,
      paymentDateAccountBalances: [
        { accountId: 'bank-one', endingBalanceCents: 30_000 },
        { accountId: 'bank-two', endingBalanceCents: 20_000 },
      ],
    });
    expect(result[1]).toMatchObject({
      paymentDatePositionCents: 80_214,
      paymentDateCashCents: 25_000,
      paymentDateReceivableCents: 55_214,
      paymentDateAccountBalances: [
        { accountId: 'bank-one', endingBalanceCents: 15_000 },
        { accountId: 'bank-two', endingBalanceCents: 10_000 },
      ],
    });
    expect(-47_513 + 55_214).toBe(7_701);
  });

  it('subtracts the global hard floor from total-position Spending Power', () => {
    const [result] = calculateCardSpendingPower({
      cards: [cards[0]!],
      cardCycles: [cardCycles[0]!],
      asOfDate: '2026-07-15',
      hardFloorCents: 2_000,
      accountHardFloorCentsById: { 'bank-one': 0, 'bank-two': 0 },
      days: runwayDays,
    });

    expect(result).toMatchObject({
      futurePositionLowCents: 7_701,
      spendingPowerCents: 5_701,
      cashBackedCapacityCents: 0,
    });

    const [belowFloor] = calculateCardSpendingPower({
      cards: [cards[0]!],
      cardCycles: [cardCycles[0]!],
      asOfDate: '2026-07-15',
      hardFloorCents: 10_000,
      accountHardFloorCentsById: { 'bank-one': 0, 'bank-two': 0 },
      days: runwayDays,
    });
    expect(belowFloor?.spendingPowerCents).toBe(0);
  });

  it('keeps the former cash-only and funding-floor calculation as a separate diagnostic', () => {
    const reservedCard = creditCardSchema.parse({
      id: 'card-reserved-estimate',
      userId,
      name: 'Synthetic reserved estimate card',
      fundingAccountId: 'bank-one',
      defaultFutureStatementCents: 20_000,
      estimatePolicy: 'baseline-guardrail',
      paymentPolicy: 'full-statement',
    });
    const reservedCycle = creditCardCycleSchema.parse({
      id: 'cycle-reserved-estimate',
      cardId: reservedCard.id,
      opensOn: '2026-07-01',
      closesOn: '2026-07-31',
      dueOn: '2026-08-13',
      paymentOn: '2026-08-13',
      state: 'open',
      defaultEstimateCents: 20_000,
      actualActivityCents: 5_000,
      plannedActivityCents: 0,
    });

    const [result] = calculateCardSpendingPower({
      cards: [reservedCard],
      cardCycles: [reservedCycle],
      asOfDate: '2026-07-15',
      hardFloorCents: 10_000,
      accountHardFloorCentsById: { 'bank-one': 5_000, 'bank-two': 15_000 },
      days: [
        {
          date: '2026-08-13',
          consolidatedCashCents: 30_000,
          minimumConsolidatedCashCents: 23_000,
          receivableCents: 0,
          totalPositionCents: 23_000,
          accountBalances: [
            {
              accountId: 'bank-one',
              endingBalanceCents: 30_000,
              minimumBalanceCents: 8_000,
            },
            {
              accountId: 'bank-two',
              endingBalanceCents: 15_000,
              minimumBalanceCents: 15_000,
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      baselineEstimateSlackCents: 15_000,
      futurePositionLowCents: 23_000,
      spendingPowerCents: 13_000,
      cashBackedCapacityCents: 18_000,
    });
  });
});
