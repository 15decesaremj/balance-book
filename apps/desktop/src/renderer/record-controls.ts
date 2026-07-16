import type { ForecastEvent } from '@balance-book/domain';
import type { ForecastSnapshotDto } from '../shared/contracts';

const inflowKinds: ReadonlySet<ForecastEvent['kind']> = new Set([
  'income',
  'receivable-settlement',
  'reward-deposit',
  'transfer-credit',
]);

const outflowKinds: ReadonlySet<ForecastEvent['kind']> = new Set([
  'direct-commitment',
  'payable',
  'card-payment',
  'loan-payment',
  'baseline-spending',
  'investment-contribution',
  'transfer-debit',
]);

export const fixedDirectionForEventKind = (
  kind: ForecastEvent['kind'],
): ForecastEvent['direction'] | undefined => {
  if (inflowKinds.has(kind)) return 'inflow';
  if (outflowKinds.has(kind)) return 'outflow';
  return undefined;
};

export const defaultDirectionForEventKind = (
  kind: ForecastEvent['kind'],
): ForecastEvent['direction'] => fixedDirectionForEventKind(kind) ?? 'outflow';

export const expectedAccountBalanceOn = (
  snapshot: ForecastSnapshotDto | null | undefined,
  accountId: string,
  date: string,
): number | undefined =>
  snapshot?.dailyCash
    ?.find((day) => day.date === date)
    ?.accountBalances.find((account) => account.accountId === accountId)?.expectedCashCents;

export const reconciliationResolutionLabel = (
  resolution: 'unresolved' | 'explained' | 'adjusted',
): string => {
  if (resolution === 'adjusted') return 'Marked adjusted elsewhere (record only)';
  if (resolution === 'explained') return 'Explained';
  return 'Unresolved';
};
