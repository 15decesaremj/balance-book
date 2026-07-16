import {
  addDays,
  compareDates,
  enumerateDates,
  forecastEventSchema,
  moneyCentsSchema,
  receivableSchema,
  type MoneyCents,
  type PlainDateString,
  type Receivable,
  type ForecastEvent,
} from '@balance-book/domain';
import {
  hasRecurringReceivableSchedule,
  receivableForSettlementSourceFromIndex,
  receivableSettlementDates,
  resolveRecordedReceivableOccurrenceDate,
} from './receivable-occurrences';
import { expandRecurrence } from './recurrence';

export const applyReceivableSettlement = (
  receivableInput: Receivable,
  settlementCents: MoneyCents,
): { appliedCents: MoneyCents; remainingAmountCents: MoneyCents; overpaymentCents: MoneyCents } => {
  const receivable = receivableSchema.parse(receivableInput);
  const requested = moneyCentsSchema.nonnegative().parse(settlementCents);
  const appliedCents = moneyCentsSchema.parse(Math.min(requested, receivable.remainingAmountCents));
  return {
    appliedCents,
    remainingAmountCents: moneyCentsSchema.parse(receivable.remainingAmountCents - appliedCents),
    overpaymentCents: moneyCentsSchema.parse(requested - appliedCents),
  };
};

export const sharedExpenseEconomics = (input: {
  grossExpenseCents: MoneyCents;
  userEconomicShareCents: MoneyCents;
  settledReceivableCents: MoneyCents;
}): {
  receivableCreatedCents: MoneyCents;
  temporaryLiquidityBurdenCents: MoneyCents;
  remainingReceivableCents: MoneyCents;
  finalPersonalEconomicBurdenCents: MoneyCents;
} => {
  const gross = moneyCentsSchema.nonnegative().parse(input.grossExpenseCents);
  const share = moneyCentsSchema.nonnegative().max(gross).parse(input.userEconomicShareCents);
  const receivableCreatedCents = moneyCentsSchema.parse(gross - share);
  const settled = Math.min(
    moneyCentsSchema.nonnegative().parse(input.settledReceivableCents),
    receivableCreatedCents,
  );
  return {
    receivableCreatedCents,
    temporaryLiquidityBurdenCents: gross,
    remainingReceivableCents: moneyCentsSchema.parse(receivableCreatedCents - settled),
    finalPersonalEconomicBurdenCents: share,
  };
};

export interface DailyReceivableBalance {
  date: PlainDateString;
  openingOutstandingCents: MoneyCents;
  accruedCents: MoneyCents;
  settledCents: MoneyCents;
  endingOutstandingCents: MoneyCents;
  receivables: Array<{
    receivableId: string;
    source: string;
    description: string;
    endingOutstandingCents: MoneyCents;
  }>;
}

const datesFor = (input: {
  receivable: Receivable;
  events?: readonly ForecastEvent[];
  startDate: PlainDateString;
  endDate: PlainDateString;
}): PlainDateString[] => {
  return receivableSettlementDates({
    receivable: input.receivable,
    events: input.events,
    endDate: input.endDate,
  }).filter(
    (date) => compareDates(date, input.startDate) >= 0 && compareDates(date, input.endDate) <= 0,
  );
};

/**
 * Rolls the non-cash receivable asset independently from cash. New shared-expense
 * obligations increase the asset on their accrual date; expected settlements reduce
 * it only when the related cash receipt is scheduled and included by the same projection
 * policy. This keeps cash, money owed, and cash-plus-owed position distinct and auditable.
 */
export const projectReceivableBalances = (input: {
  receivables: Receivable[];
  settlementEvents?: ForecastEvent[];
  startDate: PlainDateString;
  endDate: PlainDateString;
  plannedSettlementStartDate?: PlainDateString;
  currentBalancesAsOfDate?: PlainDateString;
  mode: 'conservative' | 'expected';
  includeConfirmedReceivablesConservatively: boolean;
}): DailyReceivableBalance[] => {
  const receivables = input.receivables.map((receivable) => receivableSchema.parse(receivable));
  if (new Set(receivables.map((receivable) => receivable.id)).size !== receivables.length) {
    throw new Error('Receivable IDs must be unique before owed balances are projected');
  }
  const receivableById = new Map(receivables.map((receivable) => [receivable.id, receivable]));
  const settlementEvents = (input.settlementEvents ?? []).map((event) =>
    forecastEventSchema.parse(event),
  );
  const occurrenceKey = (receivableId: string, occurrenceDate: PlainDateString): string =>
    `${receivableId}@${occurrenceDate}`;
  const balanceBuckets = new Map<string, number>();
  for (const receivable of receivables) {
    balanceBuckets.set(
      occurrenceKey(receivable.id, receivable.expectedDate),
      receivable.remainingAmountCents,
    );
  }
  const unappliedSettlementCredits = new Map<string, number>();
  const accrualsByDate = new Map<
    PlainDateString,
    Array<{ receivableId: string; occurrenceDate: PlainDateString; cents: number }>
  >();
  const settlementsByDate = new Map<
    PlainDateString,
    Array<{ receivableId: string; occurrenceDate: PlainDateString; cents: number }>
  >();
  const totalBalance = (): MoneyCents =>
    moneyCentsSchema.parse([...balanceBuckets.values()].reduce((total, cents) => total + cents, 0));
  const balanceForReceivable = (receivableId: string): MoneyCents =>
    moneyCentsSchema.parse(
      [...balanceBuckets.entries()]
        .filter(([key]) => key.startsWith(`${receivableId}@`))
        .reduce((total, [, cents]) => total + cents, 0),
    );
  const included = (receivable: Receivable): boolean =>
    input.mode === 'expected'
      ? receivable.certainty !== 'uncertain'
      : receivable.certainty === 'confirmed';

  for (const receivable of receivables) {
    if (included(receivable) && receivable.accrualDate && receivable.accrualAmountCents) {
      const accrualEndDate =
        receivable.recurrenceEndDate &&
        compareDates(receivable.recurrenceEndDate, input.endDate) < 0
          ? receivable.recurrenceEndDate
          : input.endDate;
      const accrualDates = receivable.accrualRecurrenceRule
        ? expandRecurrence({
            startDate: receivable.accrualDate,
            endDate: accrualEndDate,
            rule: receivable.accrualRecurrenceRule,
          })
        : [receivable.accrualDate];
      const occurrenceSearchEnd =
        receivable.recurrenceEndDate &&
        compareDates(receivable.recurrenceEndDate, addDays(input.endDate, 800)) < 0
          ? receivable.recurrenceEndDate
          : addDays(input.endDate, 800);
      const settlementOccurrences = receivableSettlementDates({
        receivable,
        events: settlementEvents,
        endDate:
          compareDates(occurrenceSearchEnd, receivable.expectedDate) < 0
            ? receivable.expectedDate
            : occurrenceSearchEnd,
      });
      const currentBalancesAsOfDate = input.currentBalancesAsOfDate;
      const currentBalanceAlreadyIncludesAnAccrual =
        receivable.remainingAmountCents > 0 &&
        currentBalancesAsOfDate !== undefined &&
        accrualDates.some((date) => compareDates(date, currentBalancesAsOfDate) <= 0);
      for (const [index, date] of accrualDates.entries()) {
        if (compareDates(date, input.startDate) < 0 || compareDates(date, input.endDate) > 0) {
          continue;
        }
        if (
          receivable.remainingAmountCents > 0 &&
          input.currentBalancesAsOfDate !== undefined &&
          compareDates(date, input.currentBalancesAsOfDate) <= 0
        ) {
          continue;
        }
        // A nonzero static balance normally occupies the first settlement occurrence before new
        // accruals begin. Once a past accrual has already been absorbed into that current balance,
        // however, its ordinal index has consumed that anchor; adding another offset would shift
        // every future accrual to the following month's receipt.
        const settlementOccurrenceIndex =
          index +
          (receivable.originalAmountCents > 0 && !currentBalanceAlreadyIncludesAnAccrual ? 1 : 0);
        const occurrenceDate =
          settlementOccurrences[settlementOccurrenceIndex] ??
          settlementOccurrences.at(-1) ??
          receivable.expectedDate;
        const values = accrualsByDate.get(date) ?? [];
        values.push({
          receivableId: receivable.id,
          occurrenceDate,
          cents: receivable.accrualAmountCents,
        });
        accrualsByDate.set(date, values);
      }
    }
    const settlesInCash =
      included(receivable) &&
      receivable.includeInCashForecast !== false &&
      (input.mode !== 'conservative' || input.includeConfirmedReceivablesConservatively);
    if (!settlesInCash) continue;
    const actualSettlementsByOccurrence = new Map<
      PlainDateString,
      Array<{ date: PlainDateString; cents: number; included: boolean }>
    >();
    const recordedTargetsByOccurrence = new Map<PlainDateString, number>();
    const repeating = hasRecurringReceivableSchedule(receivable);
    if (repeating) {
      for (const event of settlementEvents) {
        if (
          event.kind !== 'receivable-settlement' ||
          event.direction !== 'inflow' ||
          event.userId !== receivable.userId ||
          !event.sourceRecordId ||
          receivableForSettlementSourceFromIndex(receivableById, event.sourceRecordId)?.id !==
            receivable.id
        ) {
          continue;
        }
        const occurrenceDate = resolveRecordedReceivableOccurrenceDate({
          receivable,
          events: settlementEvents,
          settlementEvent: event,
        });
        const recordedTarget = event.receivableOccurrenceTargetCents;
        const existingTarget = recordedTargetsByOccurrence.get(occurrenceDate);
        if (
          recordedTarget !== undefined &&
          existingTarget !== undefined &&
          existingTarget !== recordedTarget
        ) {
          throw new Error(
            `Recorded receipts disagree on the target for receivable ${receivable.id} occurrence ${occurrenceDate}`,
          );
        }
        if (recordedTarget !== undefined) {
          recordedTargetsByOccurrence.set(occurrenceDate, recordedTarget);
        }
        if (event.status !== 'confirmed' && event.status !== 'paid') continue;
        const values = actualSettlementsByOccurrence.get(occurrenceDate) ?? [];
        values.push({
          date: event.date,
          cents: event.amountCents,
          included:
            input.mode === 'expected'
              ? event.certainty !== 'uncertain'
              : event.certainty === 'confirmed' && input.includeConfirmedReceivablesConservatively,
        });
        actualSettlementsByOccurrence.set(occurrenceDate, values);
      }
    }
    for (const date of datesFor({
      receivable,
      events: settlementEvents,
      startDate: input.startDate,
      endDate: input.endDate,
    })) {
      const occurrenceCents =
        recordedTargetsByOccurrence.get(date) ??
        (repeating
          ? date === receivable.expectedDate && receivable.originalAmountCents > 0
            ? receivable.remainingAmountCents
            : (receivable.recurringAmountCents ?? receivable.originalAmountCents)
          : receivable.remainingAmountCents);
      const occurrenceUsesStaticBalance =
        repeating && date === receivable.expectedDate && receivable.originalAmountCents > 0;
      const actualSettlements = actualSettlementsByOccurrence.get(date) ?? [];
      const includedActualCents = actualSettlements
        .filter((settlement) => settlement.included)
        .reduce((total, settlement) => total + settlement.cents, 0);
      const plannedCents = occurrenceUsesStaticBalance
        ? occurrenceCents
        : Math.max(0, occurrenceCents - includedActualCents);
      const plannedSettlementStartDate = input.plannedSettlementStartDate ?? input.startDate;
      if (plannedCents > 0 && compareDates(date, plannedSettlementStartDate) >= 0) {
        const values = settlementsByDate.get(date) ?? [];
        values.push({ receivableId: receivable.id, occurrenceDate: date, cents: plannedCents });
        settlementsByDate.set(date, values);
      }
      if (!occurrenceUsesStaticBalance) {
        for (const settlement of actualSettlements.filter((candidate) => candidate.included)) {
          if (
            compareDates(settlement.date, input.startDate) < 0 ||
            compareDates(settlement.date, input.endDate) > 0
          ) {
            continue;
          }
          const values = settlementsByDate.get(settlement.date) ?? [];
          values.push({
            receivableId: receivable.id,
            occurrenceDate: date,
            cents: settlement.cents,
          });
          settlementsByDate.set(settlement.date, values);
        }
      }
    }
  }

  return enumerateDates(input.startDate, input.endDate).map((date) => {
    const openingOutstandingCents = totalBalance();
    let accruedCents = 0;
    let settledCents = 0;
    for (const accrual of accrualsByDate.get(date) ?? []) {
      const key = occurrenceKey(accrual.receivableId, accrual.occurrenceDate);
      const current = balanceBuckets.get(key) ?? 0;
      const availableCredit = unappliedSettlementCredits.get(key) ?? 0;
      const creditApplied = Math.min(availableCredit, accrual.cents);
      balanceBuckets.set(key, moneyCentsSchema.parse(current + accrual.cents - creditApplied));
      if (creditApplied > 0) {
        const remainingCredit = availableCredit - creditApplied;
        if (remainingCredit === 0) unappliedSettlementCredits.delete(key);
        else unappliedSettlementCredits.set(key, remainingCredit);
        settledCents += creditApplied;
      }
      accruedCents += accrual.cents;
    }
    for (const settlement of settlementsByDate.get(date) ?? []) {
      const key = occurrenceKey(settlement.receivableId, settlement.occurrenceDate);
      const current = balanceBuckets.get(key) ?? 0;
      const applied = Math.min(current, settlement.cents);
      balanceBuckets.set(key, moneyCentsSchema.parse(current - applied));
      settledCents += applied;
      const unapplied = settlement.cents - applied;
      if (unapplied > 0) {
        unappliedSettlementCredits.set(key, (unappliedSettlementCredits.get(key) ?? 0) + unapplied);
      }
    }
    return {
      date,
      openingOutstandingCents,
      accruedCents: moneyCentsSchema.parse(accruedCents),
      settledCents: moneyCentsSchema.parse(settledCents),
      endingOutstandingCents: totalBalance(),
      receivables: receivables.map((receivable) => ({
        receivableId: receivable.id,
        source: receivable.source,
        description: receivable.description,
        endingOutstandingCents: balanceForReceivable(receivable.id),
      })),
    };
  });
};

/**
 * Replays receivable accruals and settlements from the same dated baseline used to roll cash, then
 * returns only the requested current horizon. Without the replay, an accrual that happened before
 * "today" would disappear from money owed while its later cash settlement could still remain in
 * the forecast.
 */
export const projectRollingReceivableBalances = (input: {
  receivables: Receivable[];
  settlementEvents?: ForecastEvent[];
  replayStartDate: PlainDateString;
  startDate: PlainDateString;
  endDate: PlainDateString;
  mode: 'conservative' | 'expected';
  includeConfirmedReceivablesConservatively: boolean;
}): DailyReceivableBalance[] => {
  const receivableById = new Map(
    input.receivables.map((receivable) => [receivable.id, receivable]),
  );
  const replayableReceivableIds = new Set(
    input.receivables
      .filter(
        (receivable) =>
          receivable.remainingAmountCents === 0 && hasRecurringReceivableSchedule(receivable),
      )
      .map((receivable) => receivable.id),
  );
  const replayCandidates = [
    input.replayStartDate,
    input.startDate,
    ...input.receivables.flatMap((receivable) =>
      receivable.remainingAmountCents === 0 &&
      receivable.accrualDate &&
      compareDates(receivable.accrualDate, input.endDate) <= 0
        ? [receivable.accrualDate]
        : [],
    ),
    ...(input.settlementEvents ?? []).flatMap((event) => {
      const source = receivableForSettlementSourceFromIndex(receivableById, event.sourceRecordId);
      return event.kind === 'receivable-settlement' &&
        event.direction === 'inflow' &&
        (event.status === 'confirmed' || event.status === 'paid') &&
        source !== undefined &&
        event.userId === source.userId &&
        replayableReceivableIds.has(source.id) &&
        compareDates(event.date, input.endDate) <= 0
        ? [event.date]
        : [];
    }),
  ];
  const projectionStartDate = replayCandidates.reduce((earliest, candidate) =>
    compareDates(candidate, earliest) < 0 ? candidate : earliest,
  );
  return projectReceivableBalances({
    receivables: input.receivables,
    settlementEvents: input.settlementEvents,
    startDate: projectionStartDate,
    endDate: input.endDate,
    plannedSettlementStartDate: input.startDate,
    currentBalancesAsOfDate: input.startDate,
    mode: input.mode,
    includeConfirmedReceivablesConservatively: input.includeConfirmedReceivablesConservatively,
  }).filter((day) => compareDates(day.date, input.startDate) >= 0);
};
