import {
  compareDates,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  moneyCentsSchema,
  plainDateSchema,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import {
  cardAllowsPurchasesOnDate,
  enrichCardCyclesWithActivities,
  generateCardCyclesThroughHorizon,
  projectedCycleObligation,
  resolveCardCyclesAsOf,
} from './cards';
import { expandRecurrence } from './recurrence';

export interface RevolvingDebtSummary {
  latestStatementCents: MoneyCents;
  latestStatementDate?: PlainDateString;
  amountCurrentlyDueCents: MoneyCents;
  actualOpenCycleCents: MoneyCents;
  unreconciledPostCloseActivityCents: MoneyCents;
  projectedOpenCycleCents: MoneyCents;
  currentBalanceCents: MoneyCents;
  availableCreditCents?: MoneyCents;
  carryingBalanceCents: MoneyCents;
  projectedCarryingBalanceCents: MoneyCents;
  overdue: boolean;
  source: 'reported' | 'cycle-derived';
  /**
   * True when a reported balance cuts through a cycle that also has undated
   * aggregate actual activity. Exact later events are rolled, but the aggregate
   * cannot safely be split around the snapshot date.
   */
  reportedBalanceHasUnresolvedSameCycleActivity: boolean;
}

export type RevolvingDebtPaymentEvidenceMode = 'actual-only' | 'include-projected-payments';

const nonnegativeCents = (value: number): MoneyCents =>
  moneyCentsSchema.nonnegative().parse(Math.max(0, value));

const actualPaymentThrough = (cycle: CreditCardCycle, asOfDate: PlainDateString): MoneyCents => {
  const paymentDate = cycle.paymentOn ?? cycle.dueOn;
  if (compareDates(paymentDate, asOfDate) > 0) return 0;
  if (cycle.actualPaymentCents !== undefined) {
    return nonnegativeCents(cycle.actualPaymentCents);
  }
  // Older paid rows did not store the amount received. Preserve their historical
  // meaning by treating the locked statement as paid in full once its payment
  // date has occurred.
  if (cycle.state === 'paid') return nonnegativeCents(cycle.lockedStatementCents ?? 0);
  return 0;
};

const policyPayment = (card: CreditCard, remainingStatementCents: MoneyCents): MoneyCents => {
  if (remainingStatementCents <= 0) return 0;
  switch (card.paymentPolicy) {
    case 'full-statement':
      return remainingStatementCents;
    case 'minimum':
      return nonnegativeCents(Math.min(remainingStatementCents, card.minimumPaymentCents ?? 0));
    case 'fixed':
      return nonnegativeCents(Math.min(remainingStatementCents, card.fixedPaymentCents ?? 0));
    case 'manual':
      return 0;
  }
};

const latestLockedStatement = (
  cycles: CreditCardCycle[],
  asOfDate: PlainDateString,
): CreditCardCycle | undefined =>
  cycles
    .filter(
      (cycle) =>
        cycle.lockedStatementCents !== undefined && compareDates(cycle.closesOn, asOfDate) <= 0,
    )
    .sort(
      (left, right) =>
        compareDates(right.closesOn, left.closesOn) ||
        compareDates(right.dueOn, left.dueOn) ||
        right.id.localeCompare(left.id),
    )[0];

interface DatedCardEventOccurrence {
  event: ForecastEvent;
  date: PlainDateString;
  lineageKey: string;
}

interface DatedCardPayment {
  date: PlainDateString;
  amountCents: MoneyCents;
  cycleId?: string;
  source: 'cycle' | 'event';
}

const activeEvent = (event: ForecastEvent): boolean =>
  event.status !== 'cancelled' &&
  event.status !== 'skipped' &&
  (!event.hypothetical || event.accepted);

const evidencedEventThrough = (
  event: ForecastEvent,
  date: PlainDateString,
  asOfDate: PlainDateString,
  paymentEvidenceMode: RevolvingDebtPaymentEvidenceMode = 'actual-only',
): boolean =>
  compareDates(date, asOfDate) <= 0 &&
  // A confirmed certainty locks a forecast amount/date; only an explicit payment status proves
  // that card debt was actually released. The projected mode is an explicit opt-in for callers
  // that already narrowed payment events to those applied in a matching cash ledger.
  (event.kind === 'card-payment'
    ? event.status === 'confirmed' ||
      event.status === 'paid' ||
      paymentEvidenceMode === 'include-projected-payments'
    : event.certainty === 'confirmed' || event.status === 'confirmed' || event.status === 'paid');

const eventEvidenceRank = (event: ForecastEvent): number =>
  (event.sourceRecordId && event.sourceRecordId !== event.id ? 8 : 0) +
  (event.status === 'paid' ? 4 : event.status === 'confirmed' ? 3 : 0) +
  (event.certainty === 'confirmed' ? 2 : event.certainty === 'expected' ? 1 : 0);

/**
 * Produces one occurrence per source lineage and date. Materialized recurrence
 * rows retain the parent's recurrence rule, so they must be treated as one dated
 * occurrence and preferred over their more general parent projection.
 */
const datedCardEventOccurrences = (input: {
  events: ForecastEvent[];
  card: CreditCard;
  cardId: string;
  endDate: PlainDateString;
}): DatedCardEventOccurrence[] => {
  const endDate = plainDateSchema.parse(input.endDate);
  const occurrences = new Map<string, DatedCardEventOccurrence>();
  for (const rawEvent of input.events) {
    const event = forecastEventSchema.parse(rawEvent);
    if (event.cardId !== input.cardId || !activeEvent(event)) continue;
    const recurrenceEnd =
      event.recurrenceEndDate && compareDates(event.recurrenceEndDate, endDate) < 0
        ? event.recurrenceEndDate
        : endDate;
    if (compareDates(event.date, recurrenceEnd) > 0) continue;
    const materialized = event.sourceRecordId !== undefined && event.sourceRecordId !== event.id;
    const dates =
      event.recurrenceRule && !materialized
        ? expandRecurrence({
            startDate: event.date,
            endDate: recurrenceEnd,
            rule: event.recurrenceRule,
          })
        : [event.date];
    const lineageId = event.sourceRecordId ?? event.id;
    for (const date of dates) {
      if (event.paymentMethod === 'credit-card' && !cardAllowsPurchasesOnDate(input.card, date)) {
        continue;
      }
      const lineageKey = `${lineageId}:${event.cardId}:${event.kind}:${date}`;
      const candidate = { event, date, lineageKey };
      const existing = occurrences.get(lineageKey);
      if (
        existing === undefined ||
        eventEvidenceRank(candidate.event) > eventEvidenceRank(existing.event) ||
        (eventEvidenceRank(candidate.event) === eventEvidenceRank(existing.event) &&
          candidate.event.id.localeCompare(existing.event.id) < 0)
      ) {
        occurrences.set(lineageKey, candidate);
      }
    }
  }
  return [...occurrences.values()].sort(
    (left, right) =>
      compareDates(left.date, right.date) || left.lineageKey.localeCompare(right.lineageKey),
  );
};

const cycleForActivityDate = (
  cycles: CreditCardCycle[],
  date: PlainDateString,
): CreditCardCycle | undefined =>
  cycles
    .filter(
      (cycle) => compareDates(date, cycle.opensOn) >= 0 && compareDates(date, cycle.closesOn) <= 0,
    )
    .sort(
      (left, right) =>
        compareDates(left.closesOn, right.closesOn) || left.id.localeCompare(right.id),
    )[0];

const linkedCycleIdForPaymentEvent = (
  occurrence: DatedCardEventOccurrence,
  cycles: CreditCardCycle[],
): string | undefined => {
  if (
    occurrence.event.sourceRecordId &&
    cycles.some((cycle) => cycle.id === occurrence.event.sourceRecordId)
  ) {
    return occurrence.event.sourceRecordId;
  }
  return cycles.find(
    (cycle) =>
      occurrence.event.id === `card-payment-${cycle.id}` ||
      occurrence.event.id.startsWith(`card-payment-${cycle.id}@`),
  )?.id;
};

/**
 * Reconciles two representations of the same cash payment by cycle lineage first
 * and date second. A linked event supplies the more precise cash date and may
 * carry a total-balance amount above the statement payment. Unlinked same-day
 * event/cycle totals are overlapped rather than blindly summed.
 */
const datedCardPayments = (input: {
  cycles: CreditCardCycle[];
  events: ForecastEvent[];
  card: CreditCard;
  cardId: string;
  asOfDate: PlainDateString;
  paymentEvidenceMode: RevolvingDebtPaymentEvidenceMode;
  occurrences?: DatedCardEventOccurrence[];
}): DatedCardPayment[] => {
  const cyclePayments = input.cycles.flatMap((cycle): DatedCardPayment[] => {
    const amount = actualPaymentThrough(cycle, input.asOfDate);
    if (amount <= 0) return [];
    return [
      {
        date: cycle.paymentOn ?? cycle.dueOn,
        amountCents: nonnegativeCents(Math.min(amount, cycle.lockedStatementCents ?? amount)),
        cycleId: cycle.id,
        source: 'cycle',
      },
    ];
  });
  const eventPayments = (
    input.occurrences ??
    datedCardEventOccurrences({
      events: input.events,
      card: input.card,
      cardId: input.cardId,
      endDate: input.asOfDate,
    })
  ).flatMap((occurrence) => {
    const event = occurrence.event;
    return event.kind === 'card-payment' &&
      event.paymentMethod === 'cash-account' &&
      event.direction === 'outflow' &&
      evidencedEventThrough(event, occurrence.date, input.asOfDate, input.paymentEvidenceMode)
      ? [
          {
            occurrence,
            amountCents: nonnegativeCents(event.amountCents),
            linkedCycleId: linkedCycleIdForPaymentEvent(occurrence, input.cycles),
          },
        ]
      : [];
  });
  const linkedEventsByCycleId = new Map<string, Array<(typeof eventPayments)[number]>>();
  const unlinkedEvents: typeof eventPayments = [];
  for (const eventPayment of eventPayments) {
    if (!eventPayment.linkedCycleId) {
      unlinkedEvents.push(eventPayment);
      continue;
    }
    linkedEventsByCycleId.set(eventPayment.linkedCycleId, [
      ...(linkedEventsByCycleId.get(eventPayment.linkedCycleId) ?? []),
      eventPayment,
    ]);
  }
  const lineageReconciledPayments = cyclePayments.flatMap((cyclePayment): DatedCardPayment[] => {
    const linkedEvents = cyclePayment.cycleId
      ? (linkedEventsByCycleId.get(cyclePayment.cycleId) ?? [])
      : [];
    if (linkedEvents.length === 0) return [cyclePayment];
    linkedEventsByCycleId.delete(cyclePayment.cycleId!);
    if (linkedEvents.length === 1) {
      const [linked] = linkedEvents;
      return [
        {
          date: linked!.occurrence.date,
          amountCents: nonnegativeCents(Math.max(cyclePayment.amountCents, linked!.amountCents)),
          cycleId: cyclePayment.cycleId,
          source: 'event',
        },
      ];
    }
    const linkedTotal = linkedEvents.reduce((total, payment) => total + payment.amountCents, 0);
    const residualCycleEvidence = nonnegativeCents(cyclePayment.amountCents - linkedTotal);
    return [
      ...linkedEvents.map((payment): DatedCardPayment => ({
        date: payment.occurrence.date,
        amountCents: payment.amountCents,
        cycleId: cyclePayment.cycleId,
        source: 'event',
      })),
      ...(residualCycleEvidence > 0
        ? [{ ...cyclePayment, amountCents: residualCycleEvidence }]
        : []),
    ];
  });
  // A linked payment with no stored actual-payment evidence is still exact cash
  // evidence. Preserve its full amount, including any total-balance excess.
  for (const [cycleId, linkedEvents] of linkedEventsByCycleId) {
    lineageReconciledPayments.push(
      ...linkedEvents.map((payment): DatedCardPayment => ({
        date: payment.occurrence.date,
        amountCents: payment.amountCents,
        cycleId,
        source: 'event',
      })),
    );
  }
  const eventPaymentTotalsByDate = new Map<PlainDateString, number>();
  for (const payment of unlinkedEvents) {
    eventPaymentTotalsByDate.set(
      payment.occurrence.date,
      (eventPaymentTotalsByDate.get(payment.occurrence.date) ?? 0) + payment.amountCents,
    );
  }
  const cyclePaymentTotalsByDate = new Map<PlainDateString, number>();
  for (const payment of lineageReconciledPayments) {
    cyclePaymentTotalsByDate.set(
      payment.date,
      (cyclePaymentTotalsByDate.get(payment.date) ?? 0) + payment.amountCents,
    );
  }
  const unlinkedResidualPayments = [...eventPaymentTotalsByDate.entries()].flatMap(
    ([date, eventTotalCents]): DatedCardPayment[] => {
      const residualCents = nonnegativeCents(
        eventTotalCents - (cyclePaymentTotalsByDate.get(date) ?? 0),
      );
      return residualCents <= 0 ? [] : [{ date, amountCents: residualCents, source: 'event' }];
    },
  );
  return [...lineageReconciledPayments, ...unlinkedResidualPayments].sort(
    (left, right) =>
      compareDates(left.date, right.date) ||
      (left.cycleId ?? '').localeCompare(right.cycleId ?? '') ||
      left.source.localeCompare(right.source),
  );
};

const paymentsAfter = (payments: DatedCardPayment[], date: PlainDateString): MoneyCents =>
  nonnegativeCents(
    payments
      .filter((payment) => compareDates(payment.date, date) > 0)
      .reduce((total, payment) => total + payment.amountCents, 0),
  );

/**
 * Summarizes the actual and projected debt lifecycle for a card or line of credit.
 * A locked statement is historical evidence and remains visible after payment. It
 * also supersedes earlier statements, whose unpaid amount is already represented
 * in the issuer's newer statement. Estimates belong only to projected open-cycle
 * debt; they never inflate the current actual balance.
 */
export const summarizeRevolvingDebt = (input: {
  card: CreditCard;
  /** Raw stored cycles. Do not pre-enrich these when `events` is also supplied. */
  cycles: CreditCardCycle[];
  asOfDate: PlainDateString;
  /** Dated card-funded activity and cash card-payment evidence. */
  events?: ForecastEvent[];
  /**
   * Defaults to actual payment evidence only. Projected payments may be included only when the
   * caller has already narrowed `events` to the payments applied in the matching cash ledger.
   */
  paymentEvidenceMode?: RevolvingDebtPaymentEvidenceMode;
}): RevolvingDebtSummary => {
  const card = creditCardSchema.parse(input.card);
  const asOfDate = plainDateSchema.parse(input.asOfDate);
  const storedCycles = input.cycles
    .map((cycle) => creditCardCycleSchema.parse(cycle))
    .filter((cycle) => cycle.cardId === card.id);
  const events = input.events ?? [];
  const paymentEvidenceMode = input.paymentEvidenceMode ?? 'actual-only';
  const occurrences = datedCardEventOccurrences({
    events,
    card,
    cardId: card.id,
    endDate: asOfDate,
  });
  const uncoveredEventStartDate = occurrences
    .filter(
      (occurrence) =>
        occurrence.event.paymentMethod === 'credit-card' &&
        cycleForActivityDate(storedCycles, occurrence.date) === undefined,
    )
    .reduce<PlainDateString>(
      (earliest, occurrence) =>
        compareDates(occurrence.date, earliest) < 0 ? occurrence.date : earliest,
      asOfDate,
    );
  const completeCycles = generateCardCyclesThroughHorizon({
    card,
    cardCycles: storedCycles,
    startDate: uncoveredEventStartDate,
    endDate: asOfDate,
  });
  const activityHorizonEnd = completeCycles.reduce(
    (latest, cycle) => (compareDates(cycle.closesOn, latest) > 0 ? cycle.closesOn : latest),
    asOfDate,
  );
  const effectiveCycles = enrichCardCyclesWithActivities({
    cardCycles: resolveCardCyclesAsOf({ cardCycles: completeCycles, asOfDate }),
    cardActivities: events,
    cards: [card],
    endDate: activityHorizonEnd,
    asOfDate,
  });
  const actualPayments = datedCardPayments({
    cycles: storedCycles,
    events,
    card,
    cardId: card.id,
    asOfDate,
    paymentEvidenceMode,
    occurrences,
  });
  const statement = latestLockedStatement(storedCycles, asOfDate);
  const latestStatementCents = nonnegativeCents(statement?.lockedStatementCents ?? 0);
  const amountCurrentlyDueCents = statement
    ? nonnegativeCents(latestStatementCents - paymentsAfter(actualPayments, statement.closesOn))
    : 0;

  const activityAfter = statement?.closesOn;
  const postedActivityCycles = effectiveCycles.filter(
    (cycle) =>
      cycle.lockedStatementCents === undefined &&
      cycle.state !== 'paid' &&
      compareDates(cycle.opensOn, asOfDate) <= 0 &&
      (!activityAfter || compareDates(cycle.closesOn, activityAfter) > 0),
  );
  const unassignedActualActivityCents = nonnegativeCents(
    occurrences
      .filter(
        (occurrence) =>
          occurrence.event.paymentMethod === 'credit-card' &&
          occurrence.event.cardActivityTreatment !== 'included-in-cycle-total' &&
          evidencedEventThrough(occurrence.event, occurrence.date, asOfDate) &&
          cycleForActivityDate(effectiveCycles, occurrence.date) === undefined,
      )
      .reduce(
        (total, occurrence) =>
          total +
          (occurrence.event.direction === 'outflow'
            ? occurrence.event.amountCents
            : -occurrence.event.amountCents),
        0,
      ),
  );
  const actualOpenCycleCents = nonnegativeCents(
    postedActivityCycles.reduce((total, cycle) => total + cycle.actualActivityCents, 0) +
      unassignedActualActivityCents,
  );
  const unreconciledPostCloseActivityCents = nonnegativeCents(
    postedActivityCycles
      .filter((cycle) => compareDates(cycle.closesOn, asOfDate) < 0)
      .reduce((total, cycle) => total + cycle.actualActivityCents, 0),
  );
  const projectedOpenCycleCents = nonnegativeCents(
    postedActivityCycles
      .filter((cycle) => compareDates(cycle.closesOn, asOfDate) >= 0)
      .reduce((total, cycle) => total + projectedCycleObligation(card, cycle), 0) +
      unassignedActualActivityCents,
  );

  const paymentsAgainstCycleDerivedBalanceCents = statement
    ? paymentsAfter(actualPayments, statement.closesOn)
    : nonnegativeCents(actualPayments.reduce((total, payment) => total + payment.amountCents, 0));
  const cycleDerivedCurrentBalanceCents = nonnegativeCents(
    latestStatementCents + actualOpenCycleCents - paymentsAgainstCycleDerivedBalanceCents,
  );
  const hasReportedBalance =
    card.reportedBalanceCents !== undefined &&
    card.reportedBalanceDate !== undefined &&
    compareDates(card.reportedBalanceDate, asOfDate) <= 0;
  const newerLockedStatementThanReportedBalance =
    hasReportedBalance &&
    storedCycles.some(
      (cycle) =>
        cycle.lockedStatementCents !== undefined &&
        compareDates(cycle.closesOn, card.reportedBalanceDate!) > 0 &&
        compareDates(cycle.closesOn, asOfDate) <= 0,
    );
  const paymentsAfterReportedBalanceCents = hasReportedBalance
    ? paymentsAfter(actualPayments, card.reportedBalanceDate!)
    : 0;
  const wholeCycleActivityAfterReportedBalanceCents = hasReportedBalance
    ? effectiveCycles
        .filter(
          (cycle) =>
            cycle.lockedStatementCents === undefined &&
            cycle.state !== 'paid' &&
            compareDates(cycle.opensOn, card.reportedBalanceDate!) > 0 &&
            compareDates(cycle.opensOn, asOfDate) <= 0,
        )
        .reduce((total, cycle) => total + cycle.actualActivityCents, 0)
    : 0;
  const exactSameCycleActivityAfterReportedBalanceCents = hasReportedBalance
    ? occurrences
        .filter((occurrence) => {
          const activity = occurrence.event;
          if (
            activity.paymentMethod !== 'credit-card' ||
            activity.cardActivityTreatment === 'included-in-cycle-total' ||
            !evidencedEventThrough(activity, occurrence.date, asOfDate) ||
            compareDates(occurrence.date, card.reportedBalanceDate!) < 0 ||
            (occurrence.date === card.reportedBalanceDate &&
              activity.appliesAfterBalanceSnapshot !== true)
          ) {
            return false;
          }
          const cycle = cycleForActivityDate(effectiveCycles, occurrence.date);
          // A cycle that began after the report is already safe to roll as a
          // whole. Exact events are needed only when the report fell inside the
          // same cycle (or cycle timing is unavailable), where aggregate activity
          // cannot be split without inventing a delta.
          return cycle === undefined || compareDates(cycle.opensOn, card.reportedBalanceDate!) <= 0;
        })
        .reduce(
          (total, occurrence) =>
            total +
            (occurrence.event.direction === 'outflow'
              ? occurrence.event.amountCents
              : -occurrence.event.amountCents),
          0,
        )
    : 0;
  const activityAfterReportedBalanceCents = moneyCentsSchema.parse(
    wholeCycleActivityAfterReportedBalanceCents + exactSameCycleActivityAfterReportedBalanceCents,
  );
  const useReportedBalance = hasReportedBalance && !newerLockedStatementThanReportedBalance;
  const reportedBalanceHasUnresolvedSameCycleActivity =
    useReportedBalance &&
    storedCycles.some(
      (cycle) =>
        cycle.lockedStatementCents === undefined &&
        cycle.state !== 'paid' &&
        cycle.actualActivityCents > 0 &&
        compareDates(cycle.opensOn, card.reportedBalanceDate!) <= 0 &&
        compareDates(card.reportedBalanceDate!, cycle.closesOn) < 0,
    );
  const currentBalanceCents = useReportedBalance
    ? nonnegativeCents(
        (card.reportedBalanceCents ?? 0) +
          activityAfterReportedBalanceCents -
          paymentsAfterReportedBalanceCents,
      )
    : cycleDerivedCurrentBalanceCents;

  const cycleDerivedCarryingBalanceCents =
    statement && compareDates(statement.dueOn, asOfDate) < 0 && amountCurrentlyDueCents > 0
      ? amountCurrentlyDueCents
      : 0;
  const hasReportedCarryingBalance =
    card.reportedCarryingBalanceCents !== undefined &&
    card.reportedCarryingBalanceDate !== undefined &&
    compareDates(card.reportedCarryingBalanceDate, asOfDate) <= 0;
  const newerLockedStatementThanReportedCarry =
    hasReportedCarryingBalance &&
    (storedCycles.some(
      (cycle) =>
        cycle.lockedStatementCents !== undefined &&
        compareDates(cycle.closesOn, card.reportedCarryingBalanceDate!) > 0 &&
        compareDates(cycle.closesOn, asOfDate) <= 0,
    ) ||
      (statement !== undefined &&
        compareDates(statement.dueOn, card.reportedCarryingBalanceDate!) > 0 &&
        compareDates(statement.dueOn, asOfDate) < 0));
  const paymentsAfterReportedCarryCents = hasReportedCarryingBalance
    ? paymentsAfter(actualPayments, card.reportedCarryingBalanceDate!)
    : 0;
  const useReportedCarryingBalance =
    hasReportedCarryingBalance && !newerLockedStatementThanReportedCarry;
  const carryingBalanceCents = useReportedCarryingBalance
    ? nonnegativeCents((card.reportedCarryingBalanceCents ?? 0) - paymentsAfterReportedCarryCents)
    : cycleDerivedCarryingBalanceCents;

  const projectedCarryingBalanceCents = (() => {
    if (!statement || amountCurrentlyDueCents <= 0) return 0;
    if (compareDates(statement.dueOn, asOfDate) < 0) return amountCurrentlyDueCents;
    if (
      statement.state === 'paid' &&
      compareDates(statement.paymentOn ?? statement.dueOn, asOfDate) <= 0
    ) {
      return amountCurrentlyDueCents;
    }
    const projectedPaymentDate = statement.paymentOn ?? statement.dueOn;
    if (compareDates(projectedPaymentDate, statement.dueOn) > 0) {
      return amountCurrentlyDueCents;
    }
    return nonnegativeCents(amountCurrentlyDueCents - policyPayment(card, amountCurrentlyDueCents));
  })();

  return {
    latestStatementCents,
    ...(statement ? { latestStatementDate: statement.closesOn } : {}),
    amountCurrentlyDueCents,
    actualOpenCycleCents,
    unreconciledPostCloseActivityCents,
    projectedOpenCycleCents,
    currentBalanceCents,
    ...(card.creditLimitCents === undefined
      ? {}
      : { availableCreditCents: nonnegativeCents(card.creditLimitCents - currentBalanceCents) }),
    carryingBalanceCents,
    projectedCarryingBalanceCents,
    overdue:
      statement !== undefined &&
      statement.state !== 'paid' &&
      compareDates(statement.dueOn, asOfDate) < 0 &&
      amountCurrentlyDueCents > 0,
    source: useReportedBalance ? 'reported' : 'cycle-derived',
    reportedBalanceHasUnresolvedSameCycleActivity,
  };
};

/**
 * Projects the total revolving balance on a date series without rebuilding an
 * identical card state on every quiet day. Revolving debt can change only when
 * a cycle boundary, reported snapshot, lifecycle boundary, purchase, credit, or
 * payment occurrence is crossed. Each change point still delegates to
 * `summarizeRevolvingDebt`, keeping this read model identical to the canonical
 * single-date calculation.
 */
export const projectRevolvingDebtBalancesByDate = (input: {
  cards: CreditCard[];
  cycles: CreditCardCycle[];
  dates: PlainDateString[];
  events?: ForecastEvent[];
  paymentEvidenceMode?: RevolvingDebtPaymentEvidenceMode;
}): Map<PlainDateString, MoneyCents> => {
  const requestedDates = [...new Set(input.dates.map((date) => plainDateSchema.parse(date)))].sort(
    compareDates,
  );
  const totals = new Map<PlainDateString, MoneyCents>(
    requestedDates.map((date) => [date, moneyCentsSchema.parse(0)]),
  );
  if (requestedDates.length === 0) return totals;

  const startDate = requestedDates[0]!;
  const endDate = requestedDates.at(-1)!;
  const paymentEvidenceMode = input.paymentEvidenceMode ?? 'actual-only';
  for (const rawCard of input.cards) {
    const card = creditCardSchema.parse(rawCard);
    const cycles = input.cycles
      .map((cycle) => creditCardCycleSchema.parse(cycle))
      .filter((cycle) => cycle.cardId === card.id);
    const events = (input.events ?? [])
      .map((event) => forecastEventSchema.parse(event))
      .filter((event) => event.cardId === card.id);
    const projectedCycles = generateCardCyclesThroughHorizon({
      card,
      cardCycles: cycles,
      startDate,
      endDate,
    });
    const changeDates = new Set<PlainDateString>([startDate]);
    for (const cycle of projectedCycles) {
      changeDates.add(cycle.opensOn);
      changeDates.add(cycle.closesOn);
      changeDates.add(cycle.dueOn);
      changeDates.add(cycle.paymentOn ?? cycle.dueOn);
    }
    if (card.reportedBalanceDate) changeDates.add(card.reportedBalanceDate);
    if (card.reportedCarryingBalanceDate) changeDates.add(card.reportedCarryingBalanceDate);
    if (card.closedOn) changeDates.add(card.closedOn);
    for (const occurrence of datedCardEventOccurrences({
      events,
      card,
      cardId: card.id,
      endDate,
    })) {
      changeDates.add(occurrence.date);
    }
    const orderedChangeDates = [...changeDates].sort(compareDates);

    let previousRequestedDate: PlainDateString | undefined;
    let currentBalanceCents: MoneyCents = moneyCentsSchema.parse(0);
    for (const date of requestedDates) {
      const crossedChange =
        previousRequestedDate === undefined ||
        orderedChangeDates.some(
          (changeDate) =>
            compareDates(changeDate, previousRequestedDate!) > 0 &&
            compareDates(changeDate, date) <= 0,
        );
      if (crossedChange) {
        currentBalanceCents = summarizeRevolvingDebt({
          card,
          cycles,
          asOfDate: date,
          events,
          paymentEvidenceMode,
        }).currentBalanceCents;
      }
      totals.set(date, moneyCentsSchema.parse((totals.get(date) ?? 0) + currentBalanceCents));
      previousRequestedDate = date;
    }
  }
  return totals;
};
