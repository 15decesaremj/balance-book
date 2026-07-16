import { describe, expect, it } from 'vitest';
import { forecastEventSchema, type ForecastEvent } from '@balance-book/domain';
import {
  countLogicalSetupIncomingCash,
  countPotentialSetupDuplicateEvents,
} from '../apps/desktop/src/renderer/setup-checklist';

const setupEvent = (overrides: Partial<ForecastEvent> = {}): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'event',
    userId: 'setup-test-user',
    accountId: 'checking',
    date: '2026-08-01',
    kind: 'income',
    direction: 'inflow',
    amountCents: 100_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Salary',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'cash-account',
    incomeType: 'paycheck',
    ...overrides,
  });

const planLeg = (
  id: string,
  accountId: string,
  rule: 'fixed' | 'remainder',
  planId = 'salary-plan',
  streamId = 'salary-stream',
): ForecastEvent =>
  setupEvent({
    id,
    accountId,
    amountCents: 50_000,
    sourceRecordId: 'superseded-salary',
    incomePlanId: planId,
    incomeStreamId: streamId,
    incomePlanTotalCents: 100_000,
    incomeNominalDate: '2026-08-01',
    incomeArrivalOffsetDays: 0,
    incomeAllocationRule: rule,
  });

describe('setup checklist correctness', () => {
  it('counts routed phases as one stream and omits their superseded standalone source', () => {
    const events = [
      setupEvent({ id: 'superseded-salary', status: 'cancelled' }),
      planLeg('salary-checking', 'checking', 'remainder'),
      planLeg('salary-savings', 'savings', 'fixed'),
      {
        ...planLeg('salary-future-checking', 'checking', 'remainder', 'salary-future-plan'),
        date: '2026-09-01',
        incomeNominalDate: '2026-09-01',
      },
      {
        ...planLeg(
          'salary-raise',
          'checking',
          'remainder',
          'salary-raise-plan',
          'salary-raise-plan',
        ),
        amountCents: 10_000,
        incomePlanTotalCents: 10_000,
        incomeType: 'raise-adjustment' as const,
        parentIncomePlanId: 'salary-plan',
        sourceRecordId: undefined,
      },
      setupEvent({
        id: 'salary-bonus',
        label: 'Salary bonus',
        amountCents: 25_000,
        incomeType: 'bonus',
        sourceRecordId: 'salary-plan',
      }),
      setupEvent({ id: 'freelance', label: 'Freelance income', amountCents: 20_000 }),
      setupEvent({
        id: 'reward',
        kind: 'reward-deposit',
        amountCents: 2_500,
        label: 'Card reward',
        incomeType: undefined,
      }),
      setupEvent({ id: 'cancelled-income', status: 'cancelled' }),
      setupEvent({ id: 'skipped-income', status: 'skipped' }),
      setupEvent({
        id: 'skipped-reward',
        kind: 'reward-deposit',
        status: 'skipped',
        incomeType: undefined,
      }),
    ];

    expect(countLogicalSetupIncomingCash(events)).toBe(3);
  });

  it('does not mistake equal split legs or separate logical plans for duplicate cash records', () => {
    const equalSplit = [
      planLeg('salary-checking', 'checking', 'remainder'),
      planLeg('salary-savings', 'savings', 'fixed'),
    ];
    expect(countPotentialSetupDuplicateEvents(equalSplit)).toBe(0);

    expect(
      countPotentialSetupDuplicateEvents([
        planLeg('salary-plan-one', 'checking', 'remainder', 'salary-plan-one'),
        planLeg(
          'salary-plan-two',
          'checking',
          'remainder',
          'salary-plan-two',
          'different-salary-stream',
        ),
      ]),
    ).toBe(0);
  });

  it('still flags same-account duplicates while keeping different record types distinct', () => {
    const original = setupEvent({
      id: 'rent-one',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 150_000,
      label: 'Rent',
      incomeType: undefined,
    });
    const duplicate = setupEvent({ ...original, id: 'rent-two' });
    const payable = setupEvent({ ...original, id: 'rent-payable', kind: 'payable' });
    const cancelledCopy = setupEvent({ ...original, id: 'rent-cancelled', status: 'cancelled' });
    const skippedCopy = setupEvent({ ...original, id: 'rent-skipped', status: 'skipped' });

    expect(
      countPotentialSetupDuplicateEvents([
        original,
        duplicate,
        payable,
        cancelledCopy,
        skippedCopy,
      ]),
    ).toBe(1);
  });
});
