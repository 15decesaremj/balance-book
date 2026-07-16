import { describe, expect, it } from 'vitest';
import { forecastEventSchema, type ForecastEvent } from '@balance-book/domain';
import {
  calculateRaiseAdjustmentCents,
  effectiveIncomePhase,
  effectiveIncomeStreamTotalCents,
  incomeStreamMemberEvents,
  incomePhaseForDate,
  nextIncomePhaseStart,
  summarizeBaseIncomeStreams,
  summarizeIncomePlans,
  summarizeIncomeStreams,
} from '../apps/desktop/src/renderer/income-view-model';

const allocation = (overrides: Partial<ForecastEvent>): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'current-primary',
    userId: 'income-view-user',
    accountId: 'primary-checking',
    date: '2026-07-24',
    kind: 'income',
    direction: 'inflow',
    amountCents: 180_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Paycheck to primary checking',
    hypothetical: false,
    accepted: false,
    recurrenceRule: { frequency: 'biweekly' },
    recurrenceEndDate: '2026-09-29',
    paymentMethod: 'cash-account',
    incomeType: 'paycheck',
    incomePlanId: 'current-routing',
    incomeStreamId: 'main-paycheck',
    incomePlanTotalCents: 220_000,
    incomeNominalDate: '2026-07-24',
    incomeArrivalOffsetDays: 0,
    incomeAllocationRule: 'remainder',
    incomeAllocationOrder: 1,
    ...overrides,
  });

describe('income stream view model', () => {
  it('presents effective-dated routing as one paycheck and resolves a phase-two raise payday', () => {
    const events = [
      allocation({
        id: 'current-early',
        accountId: 'early-checking',
        date: '2026-07-22',
        amountCents: 40_000,
        label: 'Paycheck savings split',
        incomeArrivalOffsetDays: -2,
        incomeAllocationRule: 'fixed',
        incomeAllocationOrder: 0,
      }),
      allocation({}),
      allocation({
        id: 'future-primary',
        date: '2026-10-02',
        amountCents: 220_000,
        recurrenceEndDate: undefined,
        incomePlanId: 'future-routing',
        incomeNominalDate: '2026-10-02',
        incomeAllocationOrder: 0,
      }),
    ];

    const plans = summarizeIncomePlans(events);
    const streams = summarizeIncomeStreams(plans);

    expect(plans).toHaveLength(2);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.phases.map((phase) => phase.id)).toEqual([
      'current-routing',
      'future-routing',
    ]);
    expect(streams[0]?.phases[0]?.first.id).toBe('current-primary');
    expect(effectiveIncomePhase(streams[0]!, '2026-07-15').id).toBe('current-routing');
    expect(incomePhaseForDate(streams[0]!, '2026-10-02')?.id).toBe('future-routing');
    expect(effectiveIncomePhase(streams[0]!, '2026-10-15').id).toBe('future-routing');
    expect(incomePhaseForDate(streams[0]!, '2026-09-30')).toBeUndefined();
    expect(nextIncomePhaseStart(streams[0]!.phases[0]!)).toBe('2026-10-02');
  });

  it('computes sequential raises from effective pay and keeps them inside one employer stream', () => {
    const baseEvents = [
      allocation({
        id: 'current-early',
        accountId: 'early-checking',
        date: '2026-07-22',
        amountCents: 40_000,
        incomeArrivalOffsetDays: -2,
        incomeAllocationRule: 'fixed',
        incomeAllocationOrder: 0,
      }),
      allocation({}),
      allocation({
        id: 'future-primary',
        date: '2026-10-02',
        amountCents: 220_000,
        recurrenceEndDate: undefined,
        incomePlanId: 'future-routing',
        incomeNominalDate: '2026-10-02',
        incomeAllocationOrder: 0,
      }),
    ];
    const firstRaise = allocation({
      id: 'first-raise',
      accountId: 'primary-checking',
      date: '2026-08-07',
      amountCents: 20_000,
      label: 'Salary raise adjustment',
      incomeType: 'raise-adjustment',
      incomePlanId: 'first-raise-plan',
      incomeStreamId: 'first-raise-plan',
      incomePlanTotalCents: 20_000,
      incomeNominalDate: '2026-08-07',
      incomeArrivalOffsetDays: 0,
      incomeAllocationOrder: 0,
      parentIncomePlanId: 'current-routing',
    });
    const plansBeforeSecondRaise = summarizeIncomePlans([...baseEvents, firstRaise]);
    const streams = summarizeBaseIncomeStreams(plansBeforeSecondRaise);

    expect(streams).toHaveLength(1);
    expect(effectiveIncomeStreamTotalCents(streams[0]!, plansBeforeSecondRaise, '2026-08-21')).toBe(
      240_000,
    );
    expect(calculateRaiseAdjustmentCents(240_000, 'new-net', '2500')).toBe(10_000);
    expect(calculateRaiseAdjustmentCents(240_000, 'percent', '10')).toBe(24_000);

    const secondRaise = allocation({
      ...firstRaise,
      id: 'second-raise',
      date: '2026-08-21',
      amountCents: 10_000,
      incomePlanId: 'second-raise-plan',
      incomeStreamId: 'second-raise-plan',
      incomePlanTotalCents: 10_000,
      incomeNominalDate: '2026-08-21',
    });
    const bonus = allocation({
      id: 'linked-bonus',
      date: '2026-08-28',
      amountCents: 50_000,
      label: 'Salary bonus',
      recurrenceRule: undefined,
      recurrenceEndDate: undefined,
      incomeType: 'bonus',
      incomePlanId: undefined,
      incomeStreamId: undefined,
      incomePlanTotalCents: undefined,
      incomeNominalDate: undefined,
      incomeArrivalOffsetDays: undefined,
      incomeAllocationRule: undefined,
      incomeAllocationOrder: undefined,
      sourceRecordId: 'current-routing',
    });
    const allEvents = [...baseEvents, firstRaise, secondRaise, bonus];
    const allPlans = summarizeIncomePlans(allEvents);
    const oneSource = summarizeBaseIncomeStreams(allPlans)[0]!;

    expect(effectiveIncomeStreamTotalCents(oneSource, allPlans, '2026-08-21')).toBe(250_000);
    expect(effectiveIncomeStreamTotalCents(oneSource, allPlans, '2026-10-02')).toBe(250_000);
    expect(
      incomeStreamMemberEvents(allEvents, allPlans, oneSource).map((event) => event.id),
    ).toEqual(expect.arrayContaining(['first-raise', 'second-raise', 'linked-bonus']));
  });
});
