import { describe, expect, it } from 'vitest';
import {
  assertValidIncomePlanGroups,
  cashAccountSchema,
  cashFloorPolicySchema,
  forecastEventSchema,
  type CashAccount,
  type ForecastEvent,
} from '@balance-book/domain';
import { buildForecastBundle, materializeForecastEvents } from '@balance-book/financial-engine';

const userId = 'paycheck-routing-user';
const planId = 'acme-split-pay';
const streamId = 'acme-paycheck-stream';

const account = (overrides: Partial<CashAccount>): CashAccount =>
  cashAccountSchema.parse({
    id: 'early-checking',
    userId,
    name: 'Early Access Checking',
    type: 'checking',
    openingBalanceCents: 100_000,
    balanceAsOf: '2026-07-14',
    includedInLiquidity: true,
    canFundOtherAccounts: true,
    transferDelayDays: 0,
    ...overrides,
  });

const accounts = [
  account({}),
  account({
    id: 'primary-checking',
    name: 'Primary Checking',
    openingBalanceCents: 50_000,
  }),
];

const allocation = ({
  id,
  accountId,
  ...overrides
}: Partial<ForecastEvent> & Pick<ForecastEvent, 'id' | 'accountId'>): ForecastEvent =>
  forecastEventSchema.parse({
    id,
    userId,
    accountId,
    date: '2026-07-17',
    kind: 'income',
    direction: 'inflow',
    amountCents: 155_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Acme payroll',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'cash-account',
    incomeType: 'paycheck',
    incomePlanId: planId,
    incomeStreamId: streamId,
    incomePlanTotalCents: 200_000,
    incomeNominalDate: '2026-07-17',
    incomeArrivalOffsetDays: 0,
    incomeAllocationRule: 'remainder',
    ...overrides,
  });

const paycheckPlan = (
  overrides: Partial<ForecastEvent> = {},
  includeRecurrence = false,
): ForecastEvent[] => [
  allocation({
    id: 'early-allocation',
    accountId: 'early-checking',
    date: '2026-07-15',
    amountCents: 45_000,
    incomeArrivalOffsetDays: -2,
    incomeAllocationRule: 'fixed',
    recurrenceRule: includeRecurrence ? { frequency: 'biweekly' } : undefined,
    ...overrides,
  }),
  allocation({
    id: 'primary-allocation',
    accountId: 'primary-checking',
    recurrenceRule: includeRecurrence ? { frequency: 'biweekly' } : undefined,
    ...overrides,
  }),
];

const policy = cashFloorPolicySchema.parse({
  hardConsolidatedFloorCents: 0,
  horizonDays: 90,
  includeConfirmedReceivablesConservatively: true,
});

describe('grouped paycheck routing', () => {
  it('accepts durable unique allocation order while keeping legacy unordered plans valid', () => {
    expect(() => assertValidIncomePlanGroups(paycheckPlan())).not.toThrow();

    const [early, primary] = paycheckPlan();
    const ordered = [
      forecastEventSchema.parse({ ...early!, incomeAllocationOrder: 0 }),
      forecastEventSchema.parse({ ...primary!, incomeAllocationOrder: 1 }),
    ];
    expect(() => assertValidIncomePlanGroups(ordered)).not.toThrow();
    expect(ordered.map((event) => event.incomeAllocationOrder)).toEqual([0, 1]);

    for (const invalidOrder of [-1, 0.5]) {
      expect(() =>
        forecastEventSchema.parse({ ...early!, incomeAllocationOrder: invalidOrder }),
      ).toThrow();
    }
  });

  it('materializes every split from the nominal biweekly payday with stable account arrival dates', () => {
    const first = materializeForecastEvents({
      accounts,
      events: paycheckPlan({}, true),
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-07-14',
      endDate: '2026-08-01',
    });
    const second = materializeForecastEvents({
      accounts,
      events: paycheckPlan({}, true),
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-07-14',
      endDate: '2026-08-01',
    });

    expect(
      first.map(({ id, accountId, date, amountCents }) => ({ id, accountId, date, amountCents })),
    ).toEqual([
      {
        id: 'early-allocation@2026-07-17->2026-07-15',
        accountId: 'early-checking',
        date: '2026-07-15',
        amountCents: 45_000,
      },
      {
        id: 'early-allocation@2026-07-31->2026-07-29',
        accountId: 'early-checking',
        date: '2026-07-29',
        amountCents: 45_000,
      },
      {
        id: 'primary-allocation@2026-07-17->2026-07-17',
        accountId: 'primary-checking',
        date: '2026-07-17',
        amountCents: 155_000,
      },
      {
        id: 'primary-allocation@2026-07-31->2026-07-31',
        accountId: 'primary-checking',
        date: '2026-07-31',
        amountCents: 155_000,
      },
    ]);
    expect(second).toEqual(first);
  });

  it('changes only the receiving account on each arrival day and preserves the exact total', () => {
    const events = materializeForecastEvents({
      accounts,
      events: paycheckPlan(),
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-07-14',
      endDate: '2026-07-18',
    });
    const forecast = buildForecastBundle({
      accounts,
      events,
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-18',
    }).expected;

    const earlyDay = forecast.days.find((day) => day.date === '2026-07-15')!;
    expect(earlyDay.inTransitCents).toBe(0);
    expect(earlyDay.consolidatedCashCents).toBe(195_000);
    expect(
      earlyDay.accounts.find((item) => item.accountId === 'early-checking')?.endingBalanceCents,
    ).toBe(145_000);
    expect(
      earlyDay.accounts.find((item) => item.accountId === 'primary-checking')?.endingBalanceCents,
    ).toBe(50_000);

    const payday = forecast.days.find((day) => day.date === '2026-07-17')!;
    expect(payday.inTransitCents).toBe(0);
    expect(payday.consolidatedCashCents).toBe(350_000);
    expect(
      payday.accounts.find((item) => item.accountId === 'early-checking')?.endingBalanceCents,
    ).toBe(145_000);
    expect(
      payday.accounts.find((item) => item.accountId === 'primary-checking')?.endingBalanceCents,
    ).toBe(205_000);
  });

  it('includes an early account arrival when its nominal payday is just beyond the horizon', () => {
    const events = materializeForecastEvents({
      accounts,
      events: paycheckPlan({}, true),
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-07-29',
      endDate: '2026-07-29',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'early-allocation@2026-07-31->2026-07-29',
      accountId: 'early-checking',
      date: '2026-07-29',
      amountCents: 45_000,
    });
  });

  it('derives a semimonthly early deposit across a month boundary from the official payday', () => {
    const crossMonthPlan = [
      allocation({
        id: 'cross-month-early',
        accountId: 'early-checking',
        date: '2026-02-27',
        amountCents: 45_000,
        incomeNominalDate: '2026-03-01',
        incomeArrivalOffsetDays: -2,
        incomeAllocationRule: 'fixed',
        recurrenceRule: { frequency: 'semimonthly', daysOfMonth: [1, 15] },
      }),
      allocation({
        id: 'cross-month-primary',
        accountId: 'primary-checking',
        date: '2026-03-01',
        incomeNominalDate: '2026-03-01',
        recurrenceRule: { frequency: 'semimonthly', daysOfMonth: [1, 15] },
      }),
    ];

    const events = materializeForecastEvents({
      accounts,
      events: crossMonthPlan,
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-02-27',
      endDate: '2026-03-01',
    });

    expect(events.map((event) => [event.accountId, event.date, event.incomeNominalDate])).toEqual([
      ['early-checking', '2026-02-27', '2026-03-01'],
      ['primary-checking', '2026-03-01', '2026-03-01'],
    ]);
  });

  it('rejects a semimonthly plan when the declared next official payday is not on its schedule', () => {
    expect(() =>
      assertValidIncomePlanGroups(
        paycheckPlan({
          recurrenceRule: { frequency: 'semimonthly', daysOfMonth: [15, 30] },
        }),
      ),
    ).toThrow(/official payday.*semimonthly|semimonthly.*official payday/i);
  });

  it('keeps expected pay out of the conservative forecast while preserving both account legs', () => {
    const events = materializeForecastEvents({
      accounts,
      events: paycheckPlan({ certainty: 'expected' }),
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-07-14',
      endDate: '2026-07-18',
    });
    const forecast = buildForecastBundle({
      accounts,
      events,
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-18',
    });

    expect(forecast.conservative.days.at(-1)?.consolidatedCashCents).toBe(150_000);
    expect(forecast.expected.days.at(-1)?.consolidatedCashCents).toBe(350_000);
    expect(forecast.expected.dependencies).toEqual(
      expect.arrayContaining(['early-allocation', 'primary-allocation']),
    );
  });

  it('applies a routed raise from its official payday while preserving that account timing', () => {
    const raise = allocation({
      id: 'routed-raise',
      accountId: 'early-checking',
      date: '2026-07-29',
      amountCents: 20_000,
      label: 'Acme payroll raise adjustment',
      incomeType: 'raise-adjustment',
      incomePlanId: 'acme-raise-plan',
      incomeStreamId: 'acme-raise-plan',
      incomePlanTotalCents: 20_000,
      incomeNominalDate: '2026-07-31',
      incomeArrivalOffsetDays: -2,
      incomeAllocationRule: 'remainder',
      parentIncomePlanId: planId,
      recurrenceRule: { frequency: 'biweekly' },
    });
    const events = materializeForecastEvents({
      accounts,
      events: [...paycheckPlan({}, true), raise],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-07-15',
      endDate: '2026-07-31',
    });

    expect(events.filter((event) => event.sourceRecordId === 'routed-raise')).toEqual([
      expect.objectContaining({
        id: 'routed-raise@2026-07-31->2026-07-29',
        date: '2026-07-29',
        incomeNominalDate: '2026-07-31',
        accountId: 'early-checking',
        amountCents: 20_000,
      }),
    ]);
    const forecast = buildForecastBundle({
      accounts,
      events,
      policy,
      startDate: '2026-07-15',
      endDate: '2026-07-31',
    }).expected;
    const raisedEarlyDay = forecast.days.find((day) => day.date === '2026-07-29')!;
    expect(
      raisedEarlyDay.accounts.find((item) => item.accountId === 'early-checking')
        ?.endingBalanceCents,
    ).toBe(210_000);
    expect(forecast.days.at(-1)?.consolidatedCashCents).toBe(570_000);
  });

  it('moves one paycheck stream from a two-account phase to one account without double counting', () => {
    const currentPhase = paycheckPlan({ recurrenceEndDate: '2026-09-25' }, true);
    const futurePhase = [
      allocation({
        id: 'future-primary-allocation',
        accountId: 'primary-checking',
        date: '2026-10-09',
        amountCents: 200_000,
        incomePlanId: 'acme-primary-only-phase',
        incomeStreamId: streamId,
        incomeNominalDate: '2026-10-09',
        incomeArrivalOffsetDays: 0,
        incomeAllocationRule: 'remainder',
        recurrenceRule: { frequency: 'biweekly' },
      }),
    ];
    expect(() => assertValidIncomePlanGroups([...currentPhase, ...futurePhase])).not.toThrow();

    const events = materializeForecastEvents({
      accounts,
      events: [...currentPhase, ...futurePhase],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-09-23',
      endDate: '2026-10-09',
    });
    expect(events.map((event) => [event.accountId, event.date, event.amountCents])).toEqual([
      ['early-checking', '2026-09-23', 45_000],
      ['primary-checking', '2026-09-25', 155_000],
      ['primary-checking', '2026-10-09', 200_000],
    ]);

    const forecast = buildForecastBundle({
      accounts,
      events,
      policy,
      startDate: '2026-09-23',
      endDate: '2026-10-09',
    }).expected;
    expect(forecast.days.at(-1)?.consolidatedCashCents).toBe(550_000);
    expect(
      forecast.days
        .find((day) => day.date === '2026-09-25')
        ?.accounts.find((item) => item.accountId === 'primary-checking')?.endingBalanceCents,
    ).toBe(205_000);
  });

  it('carries a permanent raise through a later routing phase exactly once and skips schedule gaps', () => {
    const currentPhase = paycheckPlan({ recurrenceEndDate: '2026-09-25' }, true);
    const futurePhase = [
      allocation({
        id: 'future-primary-allocation',
        accountId: 'primary-checking',
        date: '2026-10-23',
        amountCents: 200_000,
        incomePlanId: 'acme-primary-only-phase',
        incomeStreamId: streamId,
        incomeNominalDate: '2026-10-23',
        incomeArrivalOffsetDays: 0,
        incomeAllocationRule: 'remainder',
        recurrenceRule: { frequency: 'biweekly' },
      }),
    ];
    const raise = allocation({
      id: 'persistent-routed-raise',
      accountId: 'early-checking',
      date: '2026-07-29',
      amountCents: 20_000,
      label: 'Acme payroll raise adjustment',
      incomeType: 'raise-adjustment',
      incomePlanId: 'persistent-raise-plan',
      incomeStreamId: 'persistent-raise-plan',
      incomePlanTotalCents: 20_000,
      incomeNominalDate: '2026-07-31',
      incomeArrivalOffsetDays: -2,
      incomeAllocationRule: 'remainder',
      parentIncomePlanId: planId,
      recurrenceRule: { frequency: 'biweekly' },
      recurrenceEndDate: '2026-09-25',
      certainty: 'expected',
    });

    const events = materializeForecastEvents({
      accounts,
      events: [...currentPhase, ...futurePhase, raise],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: '2026-09-23',
      endDate: '2026-10-23',
    });

    expect(
      events
        .filter((event) => event.sourceRecordId === 'persistent-routed-raise')
        .map((event) => [event.accountId, event.date, event.amountCents]),
    ).toEqual([
      ['early-checking', '2026-09-23', 20_000],
      ['primary-checking', '2026-10-23', 20_000],
    ]);
    expect(
      events.some(
        (event) =>
          event.sourceRecordId === 'persistent-routed-raise' &&
          event.incomeNominalDate === '2026-10-09',
      ),
    ).toBe(false);
    const forecast = buildForecastBundle({
      accounts,
      events,
      policy,
      startDate: '2026-09-23',
      endDate: '2026-10-23',
    });
    expect(forecast.expected.days.at(-1)?.consolidatedCashCents).toBe(590_000);
    expect(forecast.conservative.days.at(-1)?.consolidatedCashCents).toBe(550_000);
  });

  it('rejects effective-dated routing phases that claim the same payday', () => {
    const currentPhase = paycheckPlan({ recurrenceEndDate: '2026-09-25' }, true);
    const overlappingPhase = [
      allocation({
        id: 'overlapping-primary-allocation',
        accountId: 'primary-checking',
        date: '2026-09-25',
        amountCents: 200_000,
        incomePlanId: 'acme-overlapping-phase',
        incomeStreamId: streamId,
        incomeNominalDate: '2026-09-25',
        incomeArrivalOffsetDays: 0,
        incomeAllocationRule: 'remainder',
        recurrenceRule: { frequency: 'biweekly' },
      }),
    ];

    expect(() => assertValidIncomePlanGroups([...currentPhase, ...overlappingPhase])).toThrow(
      /overlapping routing phases/i,
    );
  });

  it.each([
    {
      name: 'allocation sum mismatch',
      events: () => paycheckPlan({ incomePlanTotalCents: 210_000 }),
      message: /allocations total 200000 cents, expected 210000 cents/,
    },
    {
      name: 'duplicate destination account',
      events: () => {
        const [early, primary] = paycheckPlan();
        return [early!, forecastEventSchema.parse({ ...primary!, accountId: early!.accountId })];
      },
      message: /may allocate to each account only once/,
    },
    {
      name: 'multiple remainder allocations',
      events: () => paycheckPlan({ incomeAllocationRule: 'remainder' }),
      message: /may contain only one remainder allocation/,
    },
    {
      name: 'duplicate allocation order',
      events: () => paycheckPlan({ incomeAllocationOrder: 0 }),
      message: /duplicate allocation order/i,
    },
  ])('rejects $name', ({ events, message }) => {
    expect(() => assertValidIncomePlanGroups(events())).toThrow(message);
  });
});
