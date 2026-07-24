import { describe, expect, it } from 'vitest';
import { receivableSchema } from '@balance-book/domain';
import { buildReceivableAccrualDailyEvents } from '../apps/desktop/src/receivable-accrual-events';

describe('forecast labels for money-owed accruals', () => {
  it('labels each recurring contribution and preserves its forecast-view scope', () => {
    const rent = receivableSchema.parse({
      id: 'shared-rent',
      userId: 'profile-a',
      source: 'Household member',
      description: 'Rent contribution',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-08-01',
      destinationAccountId: 'checking',
      certainty: 'confirmed',
    });
    const car = receivableSchema.parse({
      id: 'shared-car',
      userId: 'profile-a',
      source: 'Household member',
      description: 'Shared automobile expenses',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-08-01',
      destinationAccountId: 'checking',
      certainty: 'expected',
    });
    const rentAccrual = {
      receivableId: rent.id,
      occurrenceDate: '2026-08-01' as const,
      source: rent.source,
      description: rent.description,
      cents: 100_000,
    };
    const carAccrual = {
      receivableId: car.id,
      occurrenceDate: '2026-08-01' as const,
      source: car.source,
      description: car.description,
      cents: 28_816,
    };

    expect(
      buildReceivableAccrualDailyEvents({
        date: '2026-08-01',
        expectedAccruals: [rentAccrual, carAccrual],
        conservativeAccruals: [rentAccrual],
        receivables: [rent, car],
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'receivable-accrual-shared-rent@2026-08-01',
        sourceRecordId: rent.id,
        label: 'Household member: Rent contribution',
        accountName: 'Money Owed',
        amountCents: 100_000,
        kind: 'receivable-accrual',
        includedInExpected: true,
        includedInConservative: true,
      }),
      expect.objectContaining({
        id: 'receivable-accrual-shared-car@2026-08-01',
        sourceRecordId: car.id,
        label: 'Household member: Shared automobile expenses',
        accountName: 'Money Owed',
        amountCents: 28_816,
        kind: 'receivable-accrual',
        includedInExpected: true,
        includedInConservative: false,
      }),
    ]);
  });
});
