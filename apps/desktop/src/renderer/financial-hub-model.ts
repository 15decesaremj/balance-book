import { Temporal } from '@js-temporal/polyfill';
import type { ForecastSnapshotDto, ManagedRecordsDto } from '../shared/contracts';
import {
  buildAccountPositionReadModel,
  buildCardPositionReadModel,
  type SourceFreshness,
} from './financial-read-models';

type UpcomingEvent = NonNullable<ForecastSnapshotDto['upcomingEvents']>[number];

export interface UpcomingBill {
  id: string;
  label: string;
  accountName: string;
  date: string;
  amountCents: number;
  kind: string;
  certainty: string;
}

export interface UpcomingBillsModel {
  bills: UpcomingBill[];
  totalCents: number;
  horizonDays: number;
}

type BillCandidate = UpcomingBill & {
  direction: 'inflow' | 'outflow';
};

export interface CashBalanceGlance {
  kind: 'cash';
  id: string;
  name: string;
  balanceCents: number;
  hardFloorCents: number;
  sourceBalanceDate: string;
  calculatedThroughDate: string;
  freshness: SourceFreshness;
  openPath: string;
}

export interface CardBalanceGlance {
  kind: 'card';
  id: string;
  name: string;
  balanceCents: number;
  availableCreditCents?: number;
  latestStatementCents: number;
  nextDueOn?: string;
  freshness: SourceFreshness | 'unavailable';
  openPath: string;
}

export interface BalanceGlanceModel {
  cash: CashBalanceGlance[];
  cards: CardBalanceGlance[];
  totalCashCents: number;
  totalCardBalanceCents: number;
}

const isBill = (event: Pick<UpcomingEvent, 'direction' | 'kind'>): boolean =>
  event.direction === 'outflow' && event.kind !== 'transfer-debit';

export const buildUpcomingBillsModel = (
  snapshot: ForecastSnapshotDto,
  today: string,
  horizonDays = 45,
): UpcomingBillsModel => {
  const endDate = Temporal.PlainDate.from(today).add({ days: horizonDays }).toString();
  const completeDailyEvents = (snapshot.dailyCash ?? []).flatMap((day) =>
    day.events
      .filter(
        (event) =>
          event.includedInExpected &&
          !event.hypothetical &&
          event.status !== 'cancelled' &&
          event.status !== 'skipped' &&
          event.status !== 'paid',
      )
      .map((event): BillCandidate => ({ ...event, date: day.date })),
  );
  const candidates: BillCandidate[] =
    completeDailyEvents.length > 0
      ? completeDailyEvents
      : (snapshot.upcomingEvents ?? []).map((event) => ({ ...event }));
  const bills = candidates
    .filter((event) => isBill(event) && event.date >= today && event.date <= endDate)
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        right.amountCents - left.amountCents ||
        left.label.localeCompare(right.label),
    )
    .map((event) => ({
      id: event.id,
      label: event.label,
      accountName: event.accountName,
      date: event.date,
      amountCents: event.amountCents,
      kind: event.kind,
      certainty: event.certainty,
    }));

  return {
    bills,
    totalCents: bills.reduce((sum, bill) => sum + bill.amountCents, 0),
    horizonDays,
  };
};

export const buildBalanceGlanceModel = (
  snapshot: ForecastSnapshotDto,
  records: ManagedRecordsDto,
): BalanceGlanceModel => {
  const cash = (snapshot.cashAccounts ?? [])
    .map((account): CashBalanceGlance => {
      const position = buildAccountPositionReadModel(account);
      return {
        kind: 'cash',
        id: account.id,
        name: account.name,
        balanceCents: position.calculatedBalanceCents,
        hardFloorCents: account.hardFloorCents,
        sourceBalanceDate: position.sourceBalanceDate,
        calculatedThroughDate: position.calculatedThroughDate,
        freshness: position.freshness,
        openPath: `/?detail=account:${encodeURIComponent(account.id)}`,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const cardById = new Map(records.cards.map((card) => [card.id, card]));
  const powerByCardId = new Map(
    (snapshot.cardSpendingPower ?? []).map((power) => [power.cardId, power]),
  );
  const cards = (snapshot.revolvingDebtByCard ?? [])
    .flatMap((debt): CardBalanceGlance[] => {
      const card = cardById.get(debt.cardId);
      if (!card) return [];
      const position = buildCardPositionReadModel(debt);
      const power = powerByCardId.get(debt.cardId);
      return [
        {
          kind: 'card',
          id: debt.cardId,
          name: card.name,
          balanceCents: position.calculatedBalanceCents,
          availableCreditCents: debt.availableCreditCents,
          latestStatementCents: debt.latestStatementCents,
          nextDueOn: power?.statementDueOn ?? power?.nextDueOn,
          freshness: position.freshness,
          openPath: `/?detail=card:${encodeURIComponent(debt.cardId)}`,
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    cash,
    cards,
    totalCashCents: cash.reduce((sum, account) => sum + account.balanceCents, 0),
    totalCardBalanceCents: cards.reduce((sum, card) => sum + card.balanceCents, 0),
  };
};
