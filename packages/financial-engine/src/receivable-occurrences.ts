import {
  addDays,
  compareDates,
  daysBetween,
  forecastEventSchema,
  plainDateSchema,
  receivableSchema,
  toPlainDate,
  toPlainDateString,
  type ForecastEvent,
  type PlainDateString,
  type Receivable,
} from '@balance-book/domain';
import { expandRecurrence } from './recurrence';

const receivableOccurrenceNotePrefix = 'balance-book:receivable-occurrence=';

export const formatReceivableOccurrenceNote = (date: PlainDateString): string =>
  `${receivableOccurrenceNotePrefix}${toPlainDateString(toPlainDate(date))}`;

export const parseReceivableOccurrenceNote = (
  notes: string | undefined,
): PlainDateString | undefined => {
  const line = notes
    ?.split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(receivableOccurrenceNotePrefix));
  if (!line) return undefined;
  const parsed = line.slice(receivableOccurrenceNotePrefix.length);
  try {
    return toPlainDateString(toPlainDate(parsed));
  } catch {
    return undefined;
  }
};

export const receivableSettlementUserNotes = (notes: string | undefined): string | undefined => {
  const visible = notes
    ?.split(/\r?\n/u)
    .filter((line) => !line.startsWith(receivableOccurrenceNotePrefix))
    .join('\n')
    .trim();
  return visible || undefined;
};

export const mergeReceivableSettlementUserNotes = (
  existingNotes: string | undefined,
  userNotes: string | undefined,
): string | undefined => {
  const occurrenceDate = parseReceivableOccurrenceNote(existingNotes);
  const visible = receivableSettlementUserNotes(userNotes);
  const merged = [
    occurrenceDate ? formatReceivableOccurrenceNote(occurrenceDate) : undefined,
    visible,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
  return merged || undefined;
};

export const receivableSettlementSourceOccurrenceDate = (
  receivableId: string,
  sourceRecordId: string | undefined,
): PlainDateString | undefined => {
  if (!sourceRecordId || sourceRecordId === receivableId) return undefined;
  if (!sourceRecordId.startsWith(`${receivableId}@`)) return undefined;
  const parsed = plainDateSchema.safeParse(sourceRecordId.slice(receivableId.length + 1));
  return parsed.success ? parsed.data : undefined;
};

/** Resolves legacy `receivable-id@date` links without stealing an exact ID from another record. */
export const receivableForSettlementSource = (
  receivables: readonly Receivable[],
  sourceRecordId: string | undefined,
): Receivable | undefined =>
  receivableForSettlementSourceFromIndex(
    new Map(receivables.map((receivable) => [receivable.id, receivable])),
    sourceRecordId,
  );

export const receivableForSettlementSourceFromIndex = (
  receivableById: ReadonlyMap<string, Receivable>,
  sourceRecordId: string | undefined,
): Receivable | undefined => {
  if (!sourceRecordId) return undefined;
  const exact = receivableById.get(sourceRecordId);
  if (exact) return exact;
  const legacy = sourceRecordId.match(/^(.*)@(\d{4}-\d{2}-\d{2})$/u);
  if (!legacy || !plainDateSchema.safeParse(legacy[2]).success) return undefined;
  return receivableById.get(legacy[1]);
};

const requireSettlementAnchor = (
  receivable: Receivable,
  events: readonly ForecastEvent[],
): ForecastEvent => {
  if (!receivable.settlementAnchorEventId) {
    throw new Error(`Receivable ${receivable.id} does not have a settlement anchor`);
  }
  const anchor = events.find((event) => event.id === receivable.settlementAnchorEventId);
  if (!anchor || anchor.userId !== receivable.userId) {
    throw new Error(`Settlement anchor for receivable ${receivable.id} is unavailable`);
  }
  const parsed = forecastEventSchema.parse(anchor);
  if (
    parsed.direction !== 'outflow' ||
    !parsed.recurrenceRule ||
    parsed.recurrenceRule.frequency === 'once' ||
    parsed.hypothetical
  ) {
    throw new Error('A settlement anchor must be a non-hypothetical recurring bill outflow');
  }
  if (parsed.status === 'cancelled' || parsed.status === 'skipped') {
    throw new Error('A cancelled or skipped bill cannot anchor a receivable schedule');
  }
  return parsed;
};

export const firstAnchoredReceivableSettlementDate = (input: {
  anchorEvent: ForecastEvent;
  settlementOffsetDays: number;
  onOrAfter: PlainDateString;
}): PlainDateString => {
  const anchorEvent = forecastEventSchema.parse(input.anchorEvent);
  const settlementOffsetDays = input.settlementOffsetDays;
  if (!Number.isInteger(settlementOffsetDays) || Math.abs(settlementOffsetDays) > 366) {
    throw new Error('Settlement offset must be a whole number of calendar days from -366 to 366');
  }
  const onOrAfter = plainDateSchema.parse(input.onOrAfter);
  if (
    anchorEvent.direction !== 'outflow' ||
    !anchorEvent.recurrenceRule ||
    anchorEvent.recurrenceRule.frequency === 'once' ||
    anchorEvent.hypothetical ||
    anchorEvent.status === 'cancelled' ||
    anchorEvent.status === 'skipped'
  ) {
    throw new Error('A settlement anchor must be a non-hypothetical active recurring bill outflow');
  }
  const unconstrainedEnd = addDays(onOrAfter, 800 + Math.abs(settlementOffsetDays));
  const endDate =
    anchorEvent.recurrenceEndDate &&
    compareDates(anchorEvent.recurrenceEndDate, unconstrainedEnd) < 0
      ? anchorEvent.recurrenceEndDate
      : unconstrainedEnd;
  const first = expandRecurrence({
    startDate: anchorEvent.date,
    endDate,
    rule: anchorEvent.recurrenceRule,
  })
    .map((date) => addDays(date, settlementOffsetDays))
    .find((date) => compareDates(date, onOrAfter) >= 0);
  if (!first) throw new Error('Anchor bill has no receipt occurrence on or after this date');
  return first;
};

/**
 * Returns the one authoritative receipt schedule. Bill-relative timing overrides no other timing:
 * the domain makes it mutually exclusive with a manual recurrence, while expectedDate remains the
 * first/fallback date for legacy rows and activation of an anchored series.
 */
export const receivableSettlementDates = (input: {
  receivable: Receivable;
  events?: readonly ForecastEvent[];
  endDate: PlainDateString;
}): PlainDateString[] => {
  const receivable = receivableSchema.parse(input.receivable);
  const endDate = plainDateSchema.parse(input.endDate);
  if (compareDates(receivable.expectedDate, endDate) > 0) return [];
  if (!receivable.settlementAnchorEventId) {
    const recurrenceEnd =
      receivable.recurrenceEndDate && compareDates(receivable.recurrenceEndDate, endDate) < 0
        ? receivable.recurrenceEndDate
        : endDate;
    return receivable.recurrenceRule
      ? expandRecurrence({
          startDate: receivable.expectedDate,
          endDate: recurrenceEnd,
          rule: receivable.recurrenceRule,
        })
      : [receivable.expectedDate];
  }

  const anchor = requireSettlementAnchor(receivable, input.events ?? []);
  const offsetDays = receivable.settlementOffsetDays!;
  const anchorExpansionEnd = addDays(endDate, Math.max(0, -offsetDays));
  const anchorEnd =
    anchor.recurrenceEndDate && compareDates(anchor.recurrenceEndDate, anchorExpansionEnd) < 0
      ? anchor.recurrenceEndDate
      : anchorExpansionEnd;
  return [
    ...new Set(
      expandRecurrence({
        startDate: anchor.date,
        endDate: anchorEnd,
        rule: anchor.recurrenceRule!,
      })
        .map((date) => addDays(date, offsetDays))
        .filter(
          (date) =>
            compareDates(date, receivable.expectedDate) >= 0 &&
            compareDates(date, endDate) <= 0 &&
            (!receivable.recurrenceEndDate ||
              compareDates(date, receivable.recurrenceEndDate) <= 0),
        ),
    ),
  ].sort(compareDates);
};

export const hasRecurringReceivableSchedule = (receivable: Receivable): boolean =>
  receivable.settlementAnchorEventId !== undefined ||
  (receivable.recurrenceRule !== undefined && receivable.recurrenceRule.frequency !== 'once');

/**
 * Resolves an actual receipt date to the nearest generated occurrence. The
 * explicit occurrence is persisted separately from the cash date so an early
 * or late receipt replaces one planned recurrence without moving either date.
 */
export const resolveReceivableOccurrenceDate = (input: {
  expectedDate: PlainDateString;
  settlementDate: PlainDateString;
  recurrenceRule: NonNullable<Receivable['recurrenceRule']>;
  recurrenceEndDate?: PlainDateString;
}): PlainDateString => {
  const expectedDate = toPlainDateString(toPlainDate(input.expectedDate));
  const settlementDate = toPlainDateString(toPlainDate(input.settlementDate));
  const searchAnchor =
    compareDates(settlementDate, expectedDate) > 0 ? settlementDate : expectedDate;
  const unconstrainedSearchEnd = addDays(searchAnchor, 800);
  const searchEnd =
    input.recurrenceEndDate && compareDates(input.recurrenceEndDate, unconstrainedSearchEnd) < 0
      ? input.recurrenceEndDate
      : unconstrainedSearchEnd;
  const occurrences = expandRecurrence({
    startDate: expectedDate,
    endDate: searchEnd,
    rule: input.recurrenceRule,
  });
  if (occurrences.length === 0) throw new Error('Receivable recurrence has no valid occurrence');
  return occurrences.reduce((closest, candidate) => {
    const closestDistance = Math.abs(daysBetween(settlementDate, closest));
    const candidateDistance = Math.abs(daysBetween(settlementDate, candidate));
    if (candidateDistance < closestDistance) return candidate;
    if (candidateDistance > closestDistance) return closest;
    const candidateIsUpcoming = compareDates(candidate, settlementDate) >= 0;
    const closestIsUpcoming = compareDates(closest, settlementDate) >= 0;
    if (candidateIsUpcoming !== closestIsUpcoming) return candidateIsUpcoming ? candidate : closest;
    return compareDates(candidate, closest) < 0 ? candidate : closest;
  });
};

export const resolveReceivableScheduleOccurrenceDate = (input: {
  receivable: Receivable;
  events?: readonly ForecastEvent[];
  settlementDate: PlainDateString;
}): PlainDateString => {
  const receivable = receivableSchema.parse(input.receivable);
  const settlementDate = plainDateSchema.parse(input.settlementDate);
  if (!hasRecurringReceivableSchedule(receivable)) return receivable.expectedDate;
  if (!receivable.settlementAnchorEventId) {
    return resolveReceivableOccurrenceDate({
      expectedDate: receivable.expectedDate,
      settlementDate,
      recurrenceRule: receivable.recurrenceRule!,
      recurrenceEndDate: receivable.recurrenceEndDate,
    });
  }
  const searchEnd = addDays(
    compareDates(settlementDate, receivable.expectedDate) > 0
      ? settlementDate
      : receivable.expectedDate,
    800,
  );
  const occurrences = receivableSettlementDates({
    receivable,
    events: input.events,
    endDate: searchEnd,
  });
  if (occurrences.length === 0) throw new Error('Receivable schedule has no valid occurrence');
  return occurrences.reduce((closest, candidate) => {
    const closestDistance = Math.abs(daysBetween(settlementDate, closest));
    const candidateDistance = Math.abs(daysBetween(settlementDate, candidate));
    if (candidateDistance < closestDistance) return candidate;
    if (candidateDistance > closestDistance) return closest;
    const candidateIsUpcoming = compareDates(candidate, settlementDate) >= 0;
    const closestIsUpcoming = compareDates(closest, settlementDate) >= 0;
    if (candidateIsUpcoming !== closestIsUpcoming) return candidateIsUpcoming ? candidate : closest;
    return compareDates(candidate, closest) < 0 ? candidate : closest;
  });
};

/**
 * Keeps a recorded cash receipt attached to the revised recurring schedule without rewriting its
 * historical cash date or stored occurrence note. An occurrence annotation is the shared identity
 * for every installment of a receipt. If a later schedule edit moves that occurrence, all of those
 * installments follow the revised occurrence nearest to the original annotation.
 */
export const resolveRecordedReceivableOccurrenceDate = (input: {
  receivable: Receivable;
  events?: readonly ForecastEvent[];
  settlementEvent: ForecastEvent;
}): PlainDateString => {
  const receivable = receivableSchema.parse(input.receivable);
  const settlementEvent = forecastEventSchema.parse(input.settlementEvent);
  if (!hasRecurringReceivableSchedule(receivable)) return receivable.expectedDate;

  const sourceOccurrence = receivableSettlementSourceOccurrenceDate(
    receivable.id,
    settlementEvent.sourceRecordId,
  );
  const explicitOccurrence =
    settlementEvent.receivableOccurrenceDate ??
    parseReceivableOccurrenceNote(settlementEvent.notes) ??
    sourceOccurrence;

  if (explicitOccurrence) {
    try {
      return resolveReceivableScheduleOccurrenceDate({
        receivable,
        events: input.events,
        settlementDate: explicitOccurrence,
      });
    } catch {
      // A malformed or exhausted revised schedule can still fall back to the cash date below.
    }
  }

  return resolveReceivableScheduleOccurrenceDate({
    receivable,
    events: input.events,
    settlementDate: settlementEvent.date,
  });
};
