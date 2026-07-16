import { expandRecurrence } from '@balance-book/financial-engine';
import {
  addDays,
  compareDates,
  type ForecastEvent,
  type PlainDateString,
} from '@balance-book/domain';
import Decimal from 'decimal.js';
import { dollarsToCents } from './utils';

export interface IncomePlanSummary {
  id: string;
  streamId: string;
  events: ForecastEvent[];
  first: ForecastEvent;
  totalCents: number;
}

export interface IncomeStreamSummary {
  id: string;
  phases: IncomePlanSummary[];
  first: ForecastEvent;
}

export function sortIncomePlanEvents<
  T extends Pick<ForecastEvent, 'incomeArrivalOffsetDays' | 'accountId'>,
>(events: T[]): T[] {
  return [...events].sort(
    (left, right) =>
      (left.incomeArrivalOffsetDays ?? 0) - (right.incomeArrivalOffsetDays ?? 0) ||
      left.accountId.localeCompare(right.accountId),
  );
}

export const summarizeIncomePlans = (events: ForecastEvent[]): IncomePlanSummary[] => {
  const grouped = new Map<string, ForecastEvent[]>();
  for (const event of events) {
    if (!event.incomePlanId) continue;
    grouped.set(event.incomePlanId, [...(grouped.get(event.incomePlanId) ?? []), event]);
  }
  return [...grouped.entries()]
    .map(([id, planEvents]) => {
      const sorted = sortIncomePlanEvents(planEvents);
      const first =
        sorted.find((event) => event.incomeAllocationRule === 'remainder') ?? sorted[0]!;
      return {
        id,
        streamId: first.incomeStreamId ?? id,
        events: sorted,
        first,
        totalCents: first.incomePlanTotalCents!,
      };
    })
    .sort(
      (left, right) =>
        (left.first.incomeNominalDate ?? left.first.date).localeCompare(
          right.first.incomeNominalDate ?? right.first.date,
        ) || left.first.label.localeCompare(right.first.label),
    );
};

export const summarizeIncomeStreams = (plans: IncomePlanSummary[]): IncomeStreamSummary[] => {
  const grouped = new Map<string, IncomePlanSummary[]>();
  for (const plan of plans) {
    grouped.set(plan.streamId, [...(grouped.get(plan.streamId) ?? []), plan]);
  }
  return [...grouped.entries()]
    .map(([id, phases]) => {
      const sorted = [...phases].sort((left, right) =>
        (left.first.incomeNominalDate ?? left.first.date).localeCompare(
          right.first.incomeNominalDate ?? right.first.date,
        ),
      );
      return { id, phases: sorted, first: sorted[0]!.first };
    })
    .sort((left, right) =>
      (left.first.incomeNominalDate ?? left.first.date).localeCompare(
        right.first.incomeNominalDate ?? right.first.date,
      ),
    );
};

const isActiveIncomeRecord = (event: ForecastEvent): boolean =>
  event.status !== 'cancelled' && event.status !== 'skipped';

/**
 * Raise plans are compensation changes attached to an employer stream, not separate income
 * sources. Keep this distinction in one view-model helper so every UI surface groups them the
 * same way.
 */
export const summarizeBaseIncomeStreams = (plans: IncomePlanSummary[]): IncomeStreamSummary[] =>
  summarizeIncomeStreams(
    plans.filter(
      (plan) => plan.first.incomeType !== 'raise-adjustment' && isActiveIncomeRecord(plan.first),
    ),
  );

export const linkedRaisePlansForStream = (
  plans: IncomePlanSummary[],
  stream: IncomeStreamSummary,
): IncomePlanSummary[] => {
  const basePlanIds = new Set(stream.phases.map((phase) => phase.id));
  return plans.filter(
    (plan) =>
      plan.first.incomeType === 'raise-adjustment' &&
      plan.first.parentIncomePlanId !== undefined &&
      basePlanIds.has(plan.first.parentIncomePlanId),
  );
};

export const relatedOneTimeIncomeForStream = (
  events: ForecastEvent[],
  stream: IncomeStreamSummary,
): ForecastEvent[] => {
  const sourceIds = new Set([
    ...stream.phases.map((phase) => phase.id),
    ...stream.phases.flatMap((phase) => phase.events.map((event) => event.id)),
  ]);
  return events.filter(
    (event) =>
      event.kind === 'income' &&
      event.recurrenceRule === undefined &&
      event.sourceRecordId !== undefined &&
      sourceIds.has(event.sourceRecordId),
  );
};

export const incomeStreamMemberEvents = (
  events: ForecastEvent[],
  plans: IncomePlanSummary[],
  stream: IncomeStreamSummary,
): ForecastEvent[] => [
  ...new Map(
    [
      ...stream.phases.flatMap((phase) => phase.events),
      ...linkedRaisePlansForStream(plans, stream).flatMap((plan) => plan.events),
      ...relatedOneTimeIncomeForStream(events, stream),
    ].map((event) => [event.id, event]),
  ).values(),
];

/**
 * Returns expected take-home on a payday: the phase's base amount plus every permanent raise that
 * has started by then. A raise's stored end date mirrors the phase on which it was entered, but the
 * compensation change itself follows the employer stream through later routing phases.
 */
export const effectiveIncomeStreamTotalCents = (
  stream: IncomeStreamSummary,
  plans: IncomePlanSummary[],
  date: PlainDateString,
): number => {
  const phase = incomePhaseForDate(stream, date) ?? effectiveIncomePhase(stream, date);
  if (!incomePhaseForDate(stream, date)) return phase.totalCents;
  const activeRaiseCents = linkedRaisePlansForStream(plans, stream)
    .filter(
      (plan) =>
        compareDates(plan.first.incomeNominalDate ?? plan.first.date, date) <= 0 &&
        isActiveIncomeRecord(plan.first),
    )
    .reduce((total, plan) => total + plan.totalCents, 0);
  return phase.totalCents + activeRaiseCents;
};

export type RaiseEntryMode = 'new-net' | 'additional' | 'percent';

export const calculateRaiseAdjustmentCents = (
  effectiveTotalCents: number,
  mode: RaiseEntryMode,
  enteredValue: string,
): number => {
  if (mode === 'new-net') return dollarsToCents(enteredValue) - effectiveTotalCents;
  if (mode === 'additional') return dollarsToCents(enteredValue);
  return new Decimal(effectiveTotalCents)
    .mul(enteredValue)
    .div(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
};

export const effectiveIncomePhase = (
  stream: IncomeStreamSummary,
  asOfDate: PlainDateString,
): IncomePlanSummary => {
  const active = incomePhaseForDate(stream, asOfDate);
  if (active) return active;
  return (
    stream.phases.find(
      (phase) => compareDates(phase.first.incomeNominalDate ?? phase.first.date, asOfDate) > 0,
    ) ?? stream.phases.at(-1)!
  );
};

export const incomePhaseForDate = (
  stream: IncomeStreamSummary,
  date: PlainDateString,
): IncomePlanSummary | undefined =>
  stream.phases.find((phase) => {
    const startDate = phase.first.incomeNominalDate ?? phase.first.date;
    return (
      compareDates(startDate, date) <= 0 &&
      (!phase.first.recurrenceEndDate || compareDates(phase.first.recurrenceEndDate, date) >= 0)
    );
  });

export const nextIncomePhaseStart = (phase: IncomePlanSummary): PlainDateString | undefined => {
  const first = phase.first;
  if (
    !first.recurrenceRule ||
    first.recurrenceRule.frequency === 'once' ||
    !first.recurrenceEndDate
  ) {
    return undefined;
  }
  return expandRecurrence({
    startDate: first.incomeNominalDate ?? first.date,
    endDate: addDays(first.recurrenceEndDate, 730),
    rule: first.recurrenceRule,
  }).find((date) => compareDates(date, first.recurrenceEndDate!) > 0);
};
