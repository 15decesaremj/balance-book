import { describe, expect, it } from 'vitest';
import {
  buildAccountPositionReadModel,
  buildCardPositionReadModel,
  calculatedPositionCue,
  sourceFreshness,
} from '../apps/desktop/src/renderer/financial-read-models';

describe('reported and calculated current-position read models', () => {
  it('keeps the source date separate from the calculated-through date', () => {
    const account = buildAccountPositionReadModel({
      id: 'checking',
      name: 'Checking',
      balanceCents: 125_000,
      sourceBalanceCents: 100_000,
      sourceBalanceDate: '2026-07-01',
      calculatedThroughDate: '2026-07-20',
      postSourceChangeCents: 25_000,
      hardFloorCents: 0,
    });
    expect(account).toMatchObject({
      sourceBalanceCents: 100_000,
      sourceBalanceDate: '2026-07-01',
      calculatedBalanceCents: 125_000,
      calculatedThroughDate: '2026-07-20',
      postSourceChangeCents: 25_000,
      freshness: 'stale',
      sourceAgeDays: 19,
    });
    expect(calculatedPositionCue(account)).toContain('source balance reported 2026-07-01');
  });

  it('labels undated issuer balances unavailable and uses quiet aging thresholds', () => {
    expect(
      buildCardPositionReadModel({
        cardId: 'card',
        calculatedThroughDate: '2026-07-20',
        currentBalanceCents: 10_000,
        latestStatementCents: 0,
        amountCurrentlyDueCents: 0,
        actualOpenCycleCents: 10_000,
        unreconciledPostCloseActivityCents: 0,
        projectedOpenCycleCents: 10_000,
        carryingBalanceCents: 0,
        projectedCarryingBalanceCents: 0,
        overdue: false,
        source: 'cycle-derived',
        reportedBalanceHasUnresolvedSameCycleActivity: false,
      }).freshness,
    ).toBe('unavailable');
    expect(sourceFreshness('2026-07-13', '2026-07-20')).toEqual({
      freshness: 'current',
      ageDays: 7,
    });
    expect(sourceFreshness('2026-07-12', '2026-07-20')).toEqual({
      freshness: 'aging',
      ageDays: 8,
    });
  });
});
