import { describe, expect, it } from 'vitest';
import {
  defaultDirectionForEventKind,
  expectedAccountBalanceOn,
  fixedDirectionForEventKind,
  reconciliationResolutionLabel,
} from '../apps/desktop/src/renderer/record-controls';
import type { ForecastSnapshotDto } from '../apps/desktop/src/shared/contracts';

describe('record controls', () => {
  it('locks cash-flow kinds to their financial direction and leaves adjustments flexible', () => {
    expect(fixedDirectionForEventKind('income')).toBe('inflow');
    expect(fixedDirectionForEventKind('receivable-settlement')).toBe('inflow');
    expect(fixedDirectionForEventKind('card-payment')).toBe('outflow');
    expect(fixedDirectionForEventKind('loan-payment')).toBe('outflow');
    expect(fixedDirectionForEventKind('manual-adjustment')).toBeUndefined();
    expect(fixedDirectionForEventKind('scenario')).toBeUndefined();
    expect(defaultDirectionForEventKind('manual-adjustment')).toBe('outflow');
  });

  it('finds the expected account balance for the exact reconciliation date', () => {
    const snapshot = {
      setupComplete: true,
      dailyCash: [
        {
          date: '2026-08-14',
          conservativeCashCents: 100,
          expectedCashCents: 200,
          conservativeInTransitCents: 0,
          expectedInTransitCents: 0,
          conservativeReceivableCents: 0,
          expectedReceivableCents: 0,
          conservativePositionCents: 100,
          expectedPositionCents: 200,
          accountBalances: [
            {
              accountId: 'checking',
              accountName: 'Checking',
              available: true,
              conservativeCashCents: -50,
              expectedCashCents: 12345,
            },
          ],
          events: [],
        },
      ],
    } satisfies ForecastSnapshotDto;

    expect(expectedAccountBalanceOn(snapshot, 'checking', '2026-08-14')).toBe(12345);
    expect(expectedAccountBalanceOn(snapshot, 'checking', '2026-08-15')).toBeUndefined();
    expect(expectedAccountBalanceOn(snapshot, 'savings', '2026-08-14')).toBeUndefined();
  });

  it('does not imply that an adjusted reconciliation moved cash', () => {
    expect(reconciliationResolutionLabel('adjusted')).toBe(
      'Marked adjusted elsewhere (record only)',
    );
  });
});
