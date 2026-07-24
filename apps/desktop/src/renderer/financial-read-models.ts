import { Temporal } from '@js-temporal/polyfill';
import type { ForecastSnapshotDto } from '../shared/contracts';

type SnapshotAccount = NonNullable<ForecastSnapshotDto['cashAccounts']>[number];
type SnapshotCard = NonNullable<ForecastSnapshotDto['revolvingDebtByCard']>[number];

export type SourceFreshness = 'current' | 'aging' | 'stale';

export interface AccountPositionReadModel {
  id: string;
  name: string;
  sourceBalanceCents: number;
  sourceBalanceDate: string;
  postSourceChangeCents: number;
  calculatedBalanceCents: number;
  calculatedThroughDate: string;
  freshness: SourceFreshness;
  sourceAgeDays: number;
}

export interface CardPositionReadModel {
  id: string;
  sourceBalanceCents?: number;
  sourceBalanceDate?: string;
  postSourceActivityCents?: number;
  calculatedBalanceCents: number;
  calculatedThroughDate: string;
  freshness: SourceFreshness | 'unavailable';
  sourceAgeDays?: number;
}

const sourceAgeDays = (sourceDate: string, throughDate: string): number =>
  Math.max(0, Temporal.PlainDate.from(sourceDate).until(Temporal.PlainDate.from(throughDate)).days);

export const sourceFreshness = (
  sourceDate: string,
  throughDate: string,
  staleAfterDays = 14,
): { freshness: SourceFreshness; ageDays: number } => {
  const ageDays = sourceAgeDays(sourceDate, throughDate);
  return {
    freshness:
      ageDays > staleAfterDays
        ? 'stale'
        : ageDays > Math.floor(staleAfterDays / 2)
          ? 'aging'
          : 'current',
    ageDays,
  };
};

export const buildAccountPositionReadModel = (
  account: SnapshotAccount,
  staleAfterDays = 14,
): AccountPositionReadModel => {
  const sourceBalanceCents = account.sourceBalanceCents ?? account.balanceCents;
  const sourceBalanceDate =
    account.sourceBalanceDate ?? account.calculatedThroughDate ?? '1970-01-01';
  const calculatedThroughDate = account.calculatedThroughDate ?? sourceBalanceDate;
  const source = sourceFreshness(sourceBalanceDate, calculatedThroughDate, staleAfterDays);
  return {
    id: account.id,
    name: account.name,
    sourceBalanceCents,
    sourceBalanceDate,
    postSourceChangeCents:
      account.postSourceChangeCents ?? account.balanceCents - sourceBalanceCents,
    calculatedBalanceCents: account.balanceCents,
    calculatedThroughDate,
    freshness: source.freshness,
    sourceAgeDays: source.ageDays,
  };
};

export const buildCardPositionReadModel = (
  card: SnapshotCard,
  staleAfterDays = 14,
): CardPositionReadModel => {
  const calculatedThroughDate =
    card.calculatedThroughDate ?? card.reportedBalanceDate ?? '1970-01-01';
  if (!card.reportedBalanceDate) {
    return {
      id: card.cardId,
      sourceBalanceCents: card.reportedBalanceCents,
      calculatedBalanceCents: card.currentBalanceCents,
      calculatedThroughDate,
      postSourceActivityCents: card.postSourceActivityCents,
      freshness: 'unavailable',
    };
  }
  const source = sourceFreshness(card.reportedBalanceDate, calculatedThroughDate, staleAfterDays);
  return {
    id: card.cardId,
    sourceBalanceCents: card.reportedBalanceCents,
    sourceBalanceDate: card.reportedBalanceDate,
    postSourceActivityCents: card.postSourceActivityCents,
    calculatedBalanceCents: card.currentBalanceCents,
    calculatedThroughDate,
    freshness: source.freshness,
    sourceAgeDays: source.ageDays,
  };
};

export const calculatedPositionCue = (input: {
  sourceBalanceDate?: string;
  calculatedThroughDate: string;
}): string =>
  input.sourceBalanceDate
    ? `Calculated through ${input.calculatedThroughDate}; source balance reported ${input.sourceBalanceDate}.`
    : `Calculated through ${input.calculatedThroughDate}; no authoritative source balance date is available.`;
