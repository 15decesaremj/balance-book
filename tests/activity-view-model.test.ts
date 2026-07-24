import { describe, expect, it } from 'vitest';
import type { ManagedRecordsDto } from '../apps/desktop/src/shared/contracts';
import {
  buildActivityTimeline,
  filterActivityTimeline,
} from '../apps/desktop/src/renderer/activity-view-model';

const records: ManagedRecordsDto = {
  accounts: [
    {
      id: 'checking',
      userId: 'profile',
      name: 'Checking',
      type: 'checking',
      openingBalanceCents: 50_000,
      balanceAsOf: '2026-07-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      showOnOverview: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    },
  ],
  events: [
    {
      id: 'purchase',
      userId: 'profile',
      accountId: 'checking',
      date: '2026-07-03',
      kind: 'manual-adjustment',
      direction: 'outflow',
      amountCents: 2_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Lunch',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'credit-card',
      cardId: 'card',
      cardActivityTreatment: 'additional',
    },
    {
      id: 'reversal',
      userId: 'profile',
      accountId: 'checking',
      date: '2026-07-04',
      kind: 'manual-adjustment',
      direction: 'inflow',
      amountCents: 2_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Reversal: Lunch',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'credit-card',
      cardId: 'card',
      cardActivityTreatment: 'additional',
      sourceRecordId: 'purchase',
    },
  ],
  cards: [
    {
      id: 'card',
      userId: 'profile',
      name: 'Card',
      fundingAccountId: 'checking',
      accountKind: 'credit-card',
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'manual',
      interestForecastEnabled: false,
      promotionalCarryingBalance: false,
      status: 'active',
    },
  ],
  cardCycles: [],
  loans: [],
  committedRefinancePlans: [],
  receivables: [],
  assets: [],
  rewardPrograms: [],
  reconciliations: [],
  savedScenarios: [],
};

describe('unified activity read model', () => {
  it('presents canonical rows once, preserves reversal lineage, and filters by source', () => {
    const timeline = buildActivityTimeline(records);
    expect(timeline.map((row) => row.id)).toEqual([
      'event:reversal',
      'event:purchase',
      'balance:checking:2026-07-01',
    ]);
    expect(timeline[0]).toMatchObject({
      kind: 'reversal',
      sourceRecordIds: ['reversal', 'purchase'],
    });
    expect(filterActivityTimeline(timeline, { accountOrCardId: 'card' })).toHaveLength(2);
    expect(filterActivityTimeline(timeline, { kind: 'balance', query: 'checking' })).toHaveLength(
      1,
    );
    expect(filterActivityTimeline(timeline, { from: '2026-07-04' })).toEqual([timeline[0]]);
  });
});
