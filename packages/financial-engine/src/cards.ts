import { Temporal } from '@js-temporal/polyfill';
import Decimal from 'decimal.js';
import {
  compareDates,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  moneyCentsSchema,
  plainDateSchema,
  toPlainDate,
  toPlainDateString,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import { expandRecurrence } from './recurrence';

const constrainedDate = (year: number, month: number, day: number): PlainDateString => {
  const first = Temporal.PlainDate.from({ year, month, day: 1 });
  return toPlainDateString(first.with({ day }, { overflow: 'constrain' }));
};

/** A closed account may retain debt and history, but cannot fund activity on or after closure. */
export const cardAllowsPurchasesOnDate = (
  cardInput: CreditCard,
  dateInput: PlainDateString,
): boolean => {
  const card = creditCardSchema.parse(cardInput);
  const date = plainDateSchema.parse(dateInput);
  return card.status !== 'closed' || compareDates(date, card.closedOn!) < 0;
};

const syntheticCycle = (input: { card: CreditCard; dueOn: PlainDateString }): CreditCardCycle => {
  const due = toPlainDate(input.dueOn);
  const closeMonth = due.subtract({ months: 1 }).with({ day: 1 });
  const closesOn = constrainedDate(
    closeMonth.year,
    closeMonth.month,
    input.card.statementCloseDayOfMonth ?? 1,
  );
  const priorCloseMonth = closeMonth.subtract({ months: 1 });
  const opensOn = toPlainDateString(
    toPlainDate(
      constrainedDate(
        priorCloseMonth.year,
        priorCloseMonth.month,
        input.card.statementCloseDayOfMonth ?? 1,
      ),
    ).add({ days: 1 }),
  );
  return creditCardCycleSchema.parse({
    id: `generated-cycle-${input.card.id}-${input.dueOn.slice(0, 7)}`,
    cardId: input.card.id,
    opensOn,
    closesOn,
    dueOn: input.dueOn,
    paymentOn: input.dueOn,
    state: 'future-estimated',
    defaultEstimateCents: input.card.defaultFutureStatementCents,
    actualActivityCents: 0,
    plannedActivityCents: 0,
  });
};

/**
 * Resolves the date-driven part of the card lifecycle without rewriting stored
 * history. An unopened estimate becomes an effective open cycle on its opening
 * date, which is what makes the actual-reset policy release its baseline at the
 * right time. Locked, scheduled, and paid states always remain explicit user or
 * statement facts. A future row already past close retains its estimate so the
 * forecast does not drop the obligation while the UI asks for the missing
 * locked statement.
 */
export const resolveCardCyclesAsOf = (input: {
  cardCycles: CreditCardCycle[];
  asOfDate: PlainDateString;
}): CreditCardCycle[] => {
  const asOfDate = plainDateSchema.parse(input.asOfDate);
  return input.cardCycles.map((rawCycle) => {
    const cycle = creditCardCycleSchema.parse(rawCycle);
    if (
      cycle.state !== 'future-estimated' ||
      compareDates(cycle.opensOn, asOfDate) > 0 ||
      compareDates(cycle.closesOn, asOfDate) < 0
    ) {
      return cycle;
    }
    return creditCardCycleSchema.parse({ ...cycle, state: 'open' });
  });
};

/**
 * Fills missing monthly card cycles using the card's native close/payment
 * timing. Two due-months beyond the requested horizon are generated because a
 * purchase after this month's close belongs to a cycle that closes next month
 * and is paid the month after that. Stored cycles always win for their due
 * month.
 */
export const generateCardCyclesThroughHorizon = (input: {
  card: CreditCard;
  cardCycles: CreditCardCycle[];
  startDate: PlainDateString;
  endDate: PlainDateString;
}): CreditCardCycle[] => {
  const card = creditCardSchema.parse(input.card);
  const startDate = plainDateSchema.parse(input.startDate);
  const endDate = plainDateSchema.parse(input.endDate);
  if (compareDates(endDate, startDate) < 0)
    throw new Error('Card cycle horizon ends before it starts');
  const cycles = input.cardCycles.map((cycle) => creditCardCycleSchema.parse(cycle));
  if (card.paymentDayOfMonth === undefined || card.statementCloseDayOfMonth === undefined) {
    return cycles;
  }
  const storedMonths = new Set(cycles.map((cycle) => `${cycle.cardId}:${cycle.dueOn.slice(0, 7)}`));
  const lastDueMonth = toPlainDate(endDate).with({ day: 1 }).add({ months: 2 });
  for (
    let month = toPlainDate(startDate).with({ day: 1 });
    Temporal.PlainDate.compare(month, lastDueMonth) <= 0;
    month = month.add({ months: 1 })
  ) {
    const monthKey = `${card.id}:${month.toString().slice(0, 7)}`;
    if (storedMonths.has(monthKey)) continue;
    const dueOn = constrainedDate(month.year, month.month, card.paymentDayOfMonth ?? 1);
    // Never infer a statement whose payment date is already behind the requested
    // forecast window. Only stored issuer history can establish overdue debt;
    // otherwise a missing prior cycle would become invented carry in the next one.
    if (compareDates(dueOn, startDate) < 0) continue;
    const candidate = syntheticCycle({ card, dueOn });
    if (card.status === 'closed' && compareDates(candidate.opensOn, card.closedOn!) >= 0) continue;
    cycles.push(candidate);
  }
  return cycles;
};

const cardActivityDates = (event: ForecastEvent, endDate: PlainDateString): PlainDateString[] => {
  const recurrenceEnd =
    event.recurrenceEndDate && compareDates(event.recurrenceEndDate, endDate) < 0
      ? event.recurrenceEndDate
      : endDate;
  if (compareDates(event.date, recurrenceEnd) > 0) return [];
  // A materialized occurrence keeps its parent's recurrence rule for audit
  // lineage. It is nevertheless one dated occurrence; expanding it again would
  // duplicate that occurrence and every later one when both parent and generated
  // rows are supplied to the engine.
  const isMaterializedOccurrence =
    event.sourceRecordId !== undefined && event.sourceRecordId !== event.id;
  return event.recurrenceRule && !isMaterializedOccurrence
    ? expandRecurrence({
        startDate: event.date,
        endDate: recurrenceEnd,
        rule: event.recurrenceRule,
      })
    : [event.date];
};

/**
 * Adds detailed, card-funded forecast records to the one open/future cycle that
 * owns each occurrence. The activity remains non-cash until the resulting card
 * payment, so it is represented once in the cash forecast. A cycle's manually
 * entered planned activity is treated as additional aggregate activity. Detailed
 * records are additive unless explicitly marked as already included in the cycle
 * total, and duplicate input occurrences are ignored by ID/date.
 */
export const enrichCardCyclesWithActivities = (input: {
  cardCycles: CreditCardCycle[];
  cardActivities: ForecastEvent[];
  /** When supplied, lifecycle dates truncate recurring card-funded activity. */
  cards?: CreditCard[];
  endDate: PlainDateString;
  /**
   * When supplied, confirmed occurrences through this date are posted actual
   * activity. Expected or future occurrences remain planned projections.
   * Omitting it preserves the legacy projection-only behavior.
   */
  asOfDate?: PlainDateString;
}): CreditCardCycle[] => {
  const cycles = input.cardCycles.map((cycle) => creditCardCycleSchema.parse(cycle));
  const asOfDate = input.asOfDate === undefined ? undefined : plainDateSchema.parse(input.asOfDate);
  const actualAdditions = new Map<string, number>();
  const plannedAdditions = new Map<string, number>();
  const seenOccurrences = new Set<string>();
  const cardById = new Map(
    (input.cards ?? []).map((card) => {
      const parsed = creditCardSchema.parse(card);
      return [parsed.id, parsed] as const;
    }),
  );

  const activities = input.cardActivities
    .map((activity) => forecastEventSchema.parse(activity))
    .sort((left, right) => {
      const evidenceRank = (activity: ForecastEvent): number =>
        (activity.sourceRecordId && activity.sourceRecordId !== activity.id ? 8 : 0) +
        (activity.status === 'paid' ? 4 : activity.status === 'confirmed' ? 3 : 0) +
        (activity.certainty === 'confirmed' ? 2 : activity.certainty === 'expected' ? 1 : 0);
      return evidenceRank(right) - evidenceRank(left) || left.id.localeCompare(right.id);
    });
  for (const activity of activities) {
    if (
      activity.paymentMethod !== 'credit-card' ||
      !activity.cardId ||
      activity.cardActivityTreatment === 'included-in-cycle-total' ||
      activity.direction !== 'outflow' ||
      activity.status === 'cancelled' ||
      activity.status === 'skipped' ||
      (activity.hypothetical && !activity.accepted)
    ) {
      continue;
    }
    for (const date of cardActivityDates(activity, input.endDate)) {
      const activityCard = cardById.get(activity.cardId);
      if (activityCard && !cardAllowsPurchasesOnDate(activityCard, date)) continue;
      const lineageId = activity.sourceRecordId ?? activity.id;
      const occurrenceKey = `${lineageId}:${activity.cardId}:${date}`;
      if (seenOccurrences.has(occurrenceKey)) continue;
      seenOccurrences.add(occurrenceKey);
      const cycle = cycles
        .filter(
          (candidate) =>
            candidate.cardId === activity.cardId &&
            (candidate.state === 'open' || candidate.state === 'future-estimated') &&
            compareDates(date, candidate.opensOn) >= 0 &&
            compareDates(date, candidate.closesOn) <= 0,
        )
        .sort((left, right) => {
          if (left.state !== right.state) return left.state === 'open' ? -1 : 1;
          return compareDates(left.closesOn, right.closesOn);
        })[0];
      if (!cycle) continue;
      const isPostedActual =
        asOfDate !== undefined &&
        compareDates(date, asOfDate) <= 0 &&
        (activity.certainty === 'confirmed' ||
          activity.status === 'confirmed' ||
          activity.status === 'paid');
      const additions = isPostedActual ? actualAdditions : plannedAdditions;
      additions.set(cycle.id, (additions.get(cycle.id) ?? 0) + activity.amountCents);
    }
  }

  return cycles.map((cycle) => {
    const actualAddition = actualAdditions.get(cycle.id) ?? 0;
    const plannedAddition = plannedAdditions.get(cycle.id) ?? 0;
    const totalAddition = actualAddition + plannedAddition;
    return creditCardCycleSchema.parse({
      ...cycle,
      actualActivityCents: moneyCentsSchema.parse(cycle.actualActivityCents + actualAddition),
      plannedActivityCents: moneyCentsSchema.parse(cycle.plannedActivityCents + plannedAddition),
      projectionOverrideCents:
        cycle.projectionOverrideCents === undefined
          ? undefined
          : moneyCentsSchema.parse(cycle.projectionOverrideCents + totalAddition),
    });
  });
};

export const assignPurchaseToCycle = (input: {
  purchaseDate: PlainDateString;
  postedDate?: PlainDateString;
  cycles: CreditCardCycle[];
}): { cycle: CreditCardCycle; assumedPostedOnPurchaseDate: boolean } => {
  const effectiveDate = plainDateSchema.parse(input.postedDate ?? input.purchaseDate);
  const cycles = input.cycles
    .map((cycle) => creditCardCycleSchema.parse(cycle))
    .sort((left, right) => compareDates(left.closesOn, right.closesOn));
  const cycle =
    cycles.find(
      (candidate) =>
        (candidate.state === 'open' || candidate.state === 'future-estimated') &&
        compareDates(effectiveDate, candidate.opensOn) >= 0 &&
        compareDates(effectiveDate, candidate.closesOn) <= 0,
    ) ?? cycles.find((candidate) => compareDates(candidate.opensOn, effectiveDate) > 0);
  if (!cycle) throw new Error(`No card cycle covers ${effectiveDate}`);
  return { cycle, assumedPostedOnPurchaseDate: input.postedDate === undefined };
};

export const projectedCycleObligation = (
  cardInput: CreditCard,
  cycleInput: CreditCardCycle,
): MoneyCents => {
  const card = creditCardSchema.parse(cardInput);
  const cycle = creditCardCycleSchema.parse(cycleInput);
  if (cycle.state === 'closed-statement' || cycle.state === 'scheduled-payment') {
    return moneyCentsSchema.parse(cycle.lockedStatementCents);
  }
  if (cycle.state === 'paid') {
    return moneyCentsSchema.parse(cycle.lockedStatementCents ?? 0);
  }
  if (card.status === 'closed' && compareDates(cycle.opensOn, card.closedOn!) >= 0) {
    // Preserve issuer-posted debt after closure, but do not carry a baseline,
    // planned card spend, or a projection override into a cycle that cannot open.
    return moneyCentsSchema.parse(cycle.actualActivityCents);
  }
  if (cycle.projectionOverrideCents !== undefined) return cycle.projectionOverrideCents;
  const activity = moneyCentsSchema.parse(cycle.actualActivityCents + cycle.plannedActivityCents);
  if (cycle.state === 'future-estimated') {
    return moneyCentsSchema.parse(Math.max(cycle.defaultEstimateCents, activity));
  }
  return card.estimatePolicy === 'actual-reset'
    ? activity
    : moneyCentsSchema.parse(Math.max(cycle.defaultEstimateCents, activity));
};

export const scheduledCardPayment = (
  cardInput: CreditCard,
  cycleInput: CreditCardCycle,
): MoneyCents => {
  const card = creditCardSchema.parse(cardInput);
  const obligation = projectedCycleObligation(card, cycleInput);
  if (obligation <= 0) return 0;
  switch (card.paymentPolicy) {
    case 'full-statement':
      return obligation;
    case 'minimum': {
      if (card.minimumPaymentCents === undefined) {
        throw new Error('Minimum payment amount is unresolved');
      }
      return moneyCentsSchema.parse(Math.min(obligation, card.minimumPaymentCents));
    }
    case 'fixed': {
      if (card.fixedPaymentCents === undefined) {
        throw new Error('Fixed payment amount is unresolved');
      }
      return moneyCentsSchema.parse(Math.min(obligation, card.fixedPaymentCents));
    }
    case 'manual':
      return 0;
  }
};

export interface ProjectedCardDebtCycle {
  cycle: CreditCardCycle;
  obligationCents: MoneyCents;
  interestOnCarryCents: MoneyCents;
  /** Explicit dated cash payments assigned to this cycle. */
  explicitPaymentCents: MoneyCents;
  /** Policy-driven cash still generated on the cycle's payment date. */
  generatedPaymentCents: MoneyCents;
  /** Explicit cash above the modeled debt, retained as credit against later open activity. */
  excessPaymentCents: MoneyCents;
  paymentCents: MoneyCents;
  carryingBalanceAfterPaymentCents: MoneyCents;
  balanceCreditAfterPaymentCents: MoneyCents;
}

export interface ScheduledCardPayment {
  id: string;
  date: PlainDateString;
  amountCents: MoneyCents;
  /** Planned/scheduled rows are forecast instructions; confirmed/paid rows are cash evidence. */
  status?: ForecastEvent['status'];
  /** Optional exact statement/cycle target. Unlinked payments are assigned by payment date. */
  cycleId?: string;
}

/**
 * Rolls a revolving residual through future cycles. A real locked statement supersedes the prior
 * modeled carry because the issuer statement already contains it. Open/future cycle estimates are
 * new activity, so any unpaid residual and one monthly interest period are added. This is a debt
 * schedule only; cash still moves through the dated payment events built from its payment amounts.
 */
export const projectCardDebtSchedule = (input: {
  card: CreditCard;
  cardCycles: CreditCardCycle[];
  asOfDate?: PlainDateString;
  openingCarryingBalance?: { cents: MoneyCents; asOfDate: PlainDateString };
  scheduledPayments?: readonly ScheduledCardPayment[];
  /** @deprecated Prefer dated `scheduledPayments`; retained for pure-model compatibility. */
  explicitPaymentCentsByCycleId?: Readonly<Record<string, MoneyCents>>;
}): ProjectedCardDebtCycle[] => {
  const card = creditCardSchema.parse(input.card);
  const asOfDate = input.asOfDate === undefined ? undefined : plainDateSchema.parse(input.asOfDate);
  const openingCarryingBalance =
    input.openingCarryingBalance === undefined
      ? undefined
      : {
          cents: moneyCentsSchema.nonnegative().parse(input.openingCarryingBalance.cents),
          asOfDate: plainDateSchema.parse(input.openingCarryingBalance.asOfDate),
        };
  const cycles = input.cardCycles
    .map((cycle) => creditCardCycleSchema.parse(cycle))
    .filter((cycle) => cycle.cardId === card.id)
    .sort(
      (left, right) =>
        compareDates(left.closesOn, right.closesOn) ||
        compareDates(left.dueOn, right.dueOn) ||
        left.id.localeCompare(right.id),
    );
  const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  const paymentDateFor = (cycle: CreditCardCycle): PlainDateString =>
    cycle.paymentOn ?? cycle.dueOn;
  const scheduledPayments: ScheduledCardPayment[] = [
    ...(input.scheduledPayments ?? []).map((payment) => ({
      id: payment.id,
      date: plainDateSchema.parse(payment.date),
      amountCents: moneyCentsSchema.nonnegative().parse(payment.amountCents),
      ...(payment.status === undefined ? {} : { status: payment.status }),
      ...(payment.cycleId === undefined ? {} : { cycleId: payment.cycleId }),
    })),
    ...Object.entries(input.explicitPaymentCentsByCycleId ?? {}).flatMap(
      ([cycleId, amountCents]): ScheduledCardPayment[] => {
        const cycle = cycleById.get(cycleId);
        if (!cycle) return [];
        return [
          {
            id: `legacy-explicit-card-payment:${cycleId}`,
            cycleId,
            date: paymentDateFor(cycle),
            amountCents: moneyCentsSchema.nonnegative().parse(amountCents),
          },
        ];
      },
    ),
  ].sort(
    (left, right) =>
      compareDates(left.date, right.date) ||
      (left.cycleId ?? '').localeCompare(right.cycleId ?? '') ||
      left.id.localeCompare(right.id),
  );
  if (new Set(scheduledPayments.map((payment) => payment.id)).size !== scheduledPayments.length) {
    throw new Error('Scheduled card payment IDs must be unique');
  }
  const paymentsByCycleId = new Map<string, ScheduledCardPayment[]>();
  for (const payment of scheduledPayments) {
    const linkedCycle = payment.cycleId ? cycleById.get(payment.cycleId) : undefined;
    // An exact cycle link cannot make a later payment retroactively satisfy an earlier due date.
    // Once that date has passed, apply the payment to the first subsequent modeled cycle instead.
    const eligibleLinkedCycle =
      linkedCycle && compareDates(payment.date, paymentDateFor(linkedCycle)) <= 0
        ? linkedCycle
        : undefined;
    const exactDateCycle = cycles.find((cycle) => paymentDateFor(cycle) === payment.date);
    const nextPaymentCycle = cycles.find(
      (cycle) => compareDates(paymentDateFor(cycle), payment.date) >= 0,
    );
    const targetCycle = eligibleLinkedCycle ?? exactDateCycle ?? nextPaymentCycle;
    if (!targetCycle) continue;
    paymentsByCycleId.set(targetCycle.id, [
      ...(paymentsByCycleId.get(targetCycle.id) ?? []),
      payment,
    ]);
  }
  let carryCents: MoneyCents = 0;
  let balanceCreditCents: MoneyCents = 0;
  let openingBalanceApplied = false;
  return cycles.map((cycle) => {
    if (
      openingCarryingBalance !== undefined &&
      !openingBalanceApplied &&
      compareDates(cycle.closesOn, openingCarryingBalance.asOfDate) > 0
    ) {
      carryCents = openingCarryingBalance.cents;
      balanceCreditCents = 0;
      openingBalanceApplied = true;
    }
    const locked = cycle.lockedStatementCents;
    if (locked !== undefined) {
      // An issuer statement is authoritative for debt at its close. It already reflects older
      // residuals and credits, so neither may be replayed into the locked amount.
      carryCents = 0;
      balanceCreditCents = 0;
    }
    const interestOnCarryCents =
      locked !== undefined || carryCents === 0 || card.aprBasisPoints === undefined
        ? 0
        : moneyCentsSchema.parse(
            new Decimal(carryCents)
              .mul(card.aprBasisPoints)
              .div(10_000)
              .div(12)
              .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
              .toNumber(),
          );
    const beforeCreditCents = moneyCentsSchema.parse(
      locked !== undefined
        ? locked
        : projectedCycleObligation(card, cycle) + carryCents + interestOnCarryCents,
    );
    const creditAppliedCents = moneyCentsSchema.parse(
      Math.min(beforeCreditCents, balanceCreditCents),
    );
    const obligationCents = moneyCentsSchema.parse(beforeCreditCents - creditAppliedCents);
    balanceCreditCents = moneyCentsSchema.parse(balanceCreditCents - creditAppliedCents);
    const policyPaymentCents = scheduledCardPayment(
      card,
      creditCardCycleSchema.parse({
        ...cycle,
        projectionOverrideCents: obligationCents,
      }),
    );
    const paymentDate = paymentDateFor(cycle);
    const assignedExplicitPayments = paymentsByCycleId.get(cycle.id) ?? [];
    // Once a statement is recorded as paid, its actualPaymentCents is the authoritative debt fact.
    // A still-planned/scheduled event is only a superseded forecast instruction. Confirmed/paid
    // rows remain useful cash evidence, so they can suppress an otherwise generated cash record.
    const explicitPayments =
      cycle.state === 'paid'
        ? assignedExplicitPayments.filter(
            (payment) => payment.status === 'confirmed' || payment.status === 'paid',
          )
        : assignedExplicitPayments;
    const explicitPaymentCents = moneyCentsSchema.parse(
      explicitPayments.reduce((total, payment) => total + payment.amountCents, 0),
    );
    const explicitOnOrBeforePaymentCents = moneyCentsSchema.parse(
      explicitPayments
        .filter((payment) => compareDates(payment.date, paymentDate) <= 0)
        .reduce((total, payment) => total + payment.amountCents, 0),
    );
    const overdueWithoutRecordedPayment =
      asOfDate !== undefined && compareDates(paymentDate, asOfDate) < 0 && cycle.state !== 'paid';
    const actualStatementPaymentCents =
      cycle.state === 'paid'
        ? moneyCentsSchema
            .nonnegative()
            .parse(cycle.actualPaymentCents ?? cycle.lockedStatementCents ?? obligationCents)
        : 0;
    const generatedPaymentCents = moneyCentsSchema.parse(
      cycle.state === 'paid' || overdueWithoutRecordedPayment
        ? 0
        : Math.max(
            0,
            policyPaymentCents - Math.min(obligationCents, explicitOnOrBeforePaymentCents),
          ),
    );
    // A paid statement and its confirmed cash rows are representations of the same release. The
    // recorded statement amount controls carry/credit; explicit evidence is used by the cash-event
    // materializer only to generate any missing remainder rather than being added again here.
    const totalCashPaymentCents = moneyCentsSchema.parse(
      cycle.state === 'paid'
        ? actualStatementPaymentCents
        : explicitPaymentCents + generatedPaymentCents,
    );
    const paymentCents = moneyCentsSchema.parse(Math.min(obligationCents, totalCashPaymentCents));
    const excessPaymentCents = moneyCentsSchema.parse(
      Math.max(0, totalCashPaymentCents - obligationCents),
    );
    carryCents = moneyCentsSchema.parse(obligationCents - paymentCents);
    balanceCreditCents = moneyCentsSchema.parse(balanceCreditCents + excessPaymentCents);
    return {
      cycle,
      obligationCents,
      interestOnCarryCents,
      explicitPaymentCents,
      generatedPaymentCents,
      excessPaymentCents,
      paymentCents,
      carryingBalanceAfterPaymentCents: carryCents,
      balanceCreditAfterPaymentCents: balanceCreditCents,
    };
  });
};

export interface CardSpendingPowerDay {
  date: PlainDateString;
  consolidatedCashCents: MoneyCents;
  minimumConsolidatedCashCents?: MoneyCents;
  receivableCents?: MoneyCents;
  totalPositionCents: MoneyCents;
  accountBalances: Array<{
    accountId: string;
    endingBalanceCents: MoneyCents;
    minimumBalanceCents?: MoneyCents;
  }>;
}

export interface CardSpendingPower {
  cardId: string;
  cardName: string;
  fundingAccountId: string;
  statementCycleId?: string;
  statementAmountCents: MoneyCents;
  statementDueOn?: PlainDateString;
  statementState?: CreditCardCycle['state'];
  currentCycleId?: string;
  currentCycleAmountCents: MoneyCents;
  currentCycleClosesOn?: PlainDateString;
  currentCyclePaymentOn?: PlainDateString;
  spendingPowerCents: MoneyCents;
  cashBackedCapacityCents: MoneyCents;
  spendingPowerStatus:
    | 'determinate'
    | 'conditional-existing-shortfall'
    | 'indeterminate-overdue-payment-timing'
    | 'indeterminate-payment-policy'
    | 'indeterminate-cycle-timing'
    | 'indeterminate-payment-outside-horizon'
    | 'indeterminate-account-balances';
  prePaymentShortfallCents: MoneyCents;
  prePaymentShortfallDate?: PlainDateString;
  prePaymentShortfallAccountId?: string;
  baselineEstimateSlackCents: MoneyCents;
  futurePositionLowCents: MoneyCents;
  futurePositionLowDate: PlainDateString;
  futurePositionLowCashCents: MoneyCents;
  futurePositionLowReceivableCents: MoneyCents;
  futurePositionLowAccountBalances: Array<{
    accountId: string;
    endingBalanceCents: MoneyCents;
  }>;
  futureAccountLows: Array<{
    accountId: string;
    endingBalanceCents: MoneyCents;
    date: PlainDateString;
  }>;
  paymentDatePositionCents?: MoneyCents;
  paymentDateCashCents?: MoneyCents;
  paymentDateReceivableCents?: MoneyCents;
  paymentDateAccountBalances?: Array<{
    accountId: string;
    endingBalanceCents: MoneyCents;
  }>;
  futureCashLowCents: MoneyCents;
  futureCashLowDate: PlainDateString;
  fundingAccountLowCents: MoneyCents;
  fundingAccountLowDate: PlainDateString;
}

/**
 * Spending Power is total-position runway, never available credit. For each card,
 * locate the cycle a purchase made on the as-of date would enter, then report the
 * lowest projected bank-cash-plus-receivables position from that cycle's due date
 * forward. Per-account lows use the current-cycle risk window: due date through the
 * later of the limiting total-position date or actual payment date. This keeps a
 * later, unrelated account episode with its future cycle/funding action.
 */
export const calculateCardSpendingPower = (input: {
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  cardActivities?: ForecastEvent[];
  days: CardSpendingPowerDay[];
  asOfDate: PlainDateString;
  hardFloorCents?: MoneyCents;
  accountHardFloorCentsById?: Record<string, MoneyCents>;
  includedAccountIds?: string[];
}): CardSpendingPower[] => {
  if (input.days.length === 0) return [];
  const eligibleCards = input.cards
    .map((card) => creditCardSchema.parse(card))
    .filter((card) => card.status === 'active');
  const daysInDateOrder = [...input.days].sort((left, right) =>
    compareDates(left.date, right.date),
  );
  const horizonEndDate = daysInDateOrder.at(-1)!.date;
  const cycleGenerationEndDate =
    compareDates(horizonEndDate, input.asOfDate) >= 0 ? horizonEndDate : input.asOfDate;
  let generatedCycles = input.cardCycles.map((cycle) => creditCardCycleSchema.parse(cycle));
  for (const rawCard of eligibleCards) {
    generatedCycles = generateCardCyclesThroughHorizon({
      card: rawCard,
      cardCycles: generatedCycles,
      startDate: input.asOfDate,
      endDate: cycleGenerationEndDate,
    });
  }
  const cardCycles = enrichCardCyclesWithActivities({
    cardCycles: resolveCardCyclesAsOf({
      cardCycles: generatedCycles,
      asOfDate: input.asOfDate,
    }),
    cardActivities: input.cardActivities ?? [],
    cards: eligibleCards,
    endDate: horizonEndDate,
  });
  const cashBalance = (day: CardSpendingPowerDay): MoneyCents =>
    day.minimumConsolidatedCashCents ?? day.consolidatedCashCents;
  const receivableBalance = (day: CardSpendingPowerDay): MoneyCents =>
    moneyCentsSchema.parse(
      day.receivableCents ?? day.totalPositionCents - day.consolidatedCashCents,
    );
  const positionAccountBalances = (
    day: CardSpendingPowerDay,
  ): CardSpendingPower['futurePositionLowAccountBalances'] =>
    day.accountBalances.map((account) => ({
      accountId: account.accountId,
      endingBalanceCents: account.endingBalanceCents,
    }));
  const accountBalance = (day: CardSpendingPowerDay, accountId: string): MoneyCents | undefined => {
    const balance = day.accountBalances.find((account) => account.accountId === accountId);
    // Card runway answers a daily planning question (the balance carried after the payment day),
    // while the forecast exposes intraday minima separately for conservative diagnostics.
    return balance?.endingBalanceCents;
  };
  const hardFloorCents = input.hardFloorCents ?? 0;
  const configuredAccountFloors = Object.entries(input.accountHardFloorCentsById ?? {});
  const includedAccountIds = [
    ...new Set(
      input.includedAccountIds ??
        (configuredAccountFloors.length > 0
          ? configuredAccountFloors.map(([accountId]) => accountId)
          : daysInDateOrder.flatMap((day) =>
              day.accountBalances.map((account) => account.accountId),
            )),
    ),
  ];
  const closingAccountLows = (
    days: CardSpendingPowerDay[],
  ): CardSpendingPower['futureAccountLows'] =>
    includedAccountIds.flatMap((accountId) => {
      const availableDays = days.filter((day) =>
        day.accountBalances.some((account) => account.accountId === accountId),
      );
      if (availableDays.length === 0) return [];
      const lowest = availableDays.reduce((current, candidate) => {
        const currentBalance = current.accountBalances.find(
          (account) => account.accountId === accountId,
        )!.endingBalanceCents;
        const candidateBalance = candidate.accountBalances.find(
          (account) => account.accountId === accountId,
        )!.endingBalanceCents;
        return candidateBalance < currentBalance ? candidate : current;
      });
      return {
        accountId,
        endingBalanceCents: lowest.accountBalances.find(
          (account) => account.accountId === accountId,
        )!.endingBalanceCents,
        date: lowest.date,
      };
    });
  return eligibleCards
    .map((rawCard): CardSpendingPower | undefined => {
      const card = creditCardSchema.parse(rawCard);
      const cycles = cardCycles
        .filter((cycle) => cycle.cardId === card.id)
        .map((cycle) => creditCardCycleSchema.parse(cycle))
        .sort((left, right) => compareDates(left.dueOn, right.dueOn));
      const statementCandidates = cycles.filter(
        (cycle) =>
          cycle.state !== 'paid' &&
          ((cycle.state !== 'open' && cycle.state !== 'future-estimated') ||
            compareDates(cycle.closesOn, input.asOfDate) < 0),
      );
      const overdueStatementWithUnknownTiming = statementCandidates.find(
        (cycle) =>
          !cycle.id.startsWith('generated-cycle-') &&
          cycle.state !== 'scheduled-payment' &&
          compareDates(cycle.paymentOn ?? cycle.dueOn, input.asOfDate) < 0,
      );
      const upcomingStatement = statementCandidates.find(
        (cycle) => compareDates(cycle.paymentOn ?? cycle.dueOn, input.asOfDate) >= 0,
      );
      const sameDayPaidStatement = cycles.find(
        (cycle) => cycle.dueOn === input.asOfDate && cycle.state === 'paid',
      );
      const latestLockedStatement = cycles
        .filter(
          (cycle) =>
            cycle.lockedStatementCents !== undefined &&
            compareDates(cycle.closesOn, input.asOfDate) <= 0,
        )
        .sort((left, right) => compareDates(right.closesOn, left.closesOn))[0];
      const statement =
        overdueStatementWithUnknownTiming ??
        upcomingStatement ??
        latestLockedStatement ??
        sameDayPaidStatement;
      const currentCycle =
        cycles.find(
          (cycle) =>
            (cycle.state === 'open' || cycle.state === 'future-estimated') &&
            compareDates(cycle.opensOn, input.asOfDate) <= 0 &&
            compareDates(cycle.closesOn, input.asOfDate) >= 0,
        ) ?? cycles.find((cycle) => compareDates(cycle.opensOn, input.asOfDate) > 0);
      if (!currentCycle) {
        const positionLow = daysInDateOrder.reduce((lowest, day) =>
          day.totalPositionCents < lowest.totalPositionCents ? day : lowest,
        );
        const cashLow = daysInDateOrder.reduce((lowest, day) =>
          cashBalance(day) < cashBalance(lowest) ? day : lowest,
        );
        const fundingLow = daysInDateOrder.reduce((lowest, day) => {
          const candidate = accountBalance(day, card.fundingAccountId);
          const current = accountBalance(lowest, card.fundingAccountId);
          if (candidate === undefined || current === undefined) return lowest;
          return candidate < current ? day : lowest;
        });
        return {
          cardId: card.id,
          cardName: card.name,
          fundingAccountId: card.fundingAccountId,
          statementCycleId: statement?.id,
          statementAmountCents: statement ? projectedCycleObligation(card, statement) : 0,
          statementDueOn: statement?.dueOn,
          statementState: statement?.state,
          currentCycleAmountCents: 0,
          spendingPowerCents: 0,
          cashBackedCapacityCents: 0,
          spendingPowerStatus: overdueStatementWithUnknownTiming
            ? 'indeterminate-overdue-payment-timing'
            : 'indeterminate-cycle-timing',
          prePaymentShortfallCents: 0,
          baselineEstimateSlackCents: 0,
          futurePositionLowCents: positionLow.totalPositionCents,
          futurePositionLowDate: positionLow.date,
          futurePositionLowCashCents: positionLow.consolidatedCashCents,
          futurePositionLowReceivableCents: receivableBalance(positionLow),
          futurePositionLowAccountBalances: positionAccountBalances(positionLow),
          futureAccountLows: [],
          futureCashLowCents: cashBalance(cashLow),
          futureCashLowDate: cashLow.date,
          fundingAccountLowCents: moneyCentsSchema.parse(
            accountBalance(fundingLow, card.fundingAccountId) ?? cashBalance(fundingLow),
          ),
          fundingAccountLowDate: fundingLow.date,
        };
      }
      const runwayStartDate = currentCycle.dueOn;
      const paymentDate = currentCycle.paymentOn ?? currentCycle.dueOn;
      const paymentDateDay = daysInDateOrder.find((day) => day.date === paymentDate);
      const runwayEligibleDays = daysInDateOrder.filter(
        (day) => compareDates(day.date, runwayStartDate) >= 0,
      );
      const runwayDays =
        runwayEligibleDays.length > 0 ? runwayEligibleDays : [daysInDateOrder.at(-1)!];
      const paymentEligibleDays = daysInDateOrder.filter(
        (day) => compareDates(day.date, paymentDate) >= 0,
      );
      const positionLow = runwayDays.reduce((lowest, day) =>
        day.totalPositionCents < lowest.totalPositionCents ? day : lowest,
      );
      const riskWindowEndDate =
        compareDates(positionLow.date, paymentDate) >= 0 ? positionLow.date : paymentDate;
      const riskWindowDays = runwayDays.filter(
        (day) => compareDates(day.date, riskWindowEndDate) <= 0,
      );
      const riskWindowPaymentDays = paymentEligibleDays.filter(
        (day) => compareDates(day.date, riskWindowEndDate) <= 0,
      );
      const diagnosticDays =
        riskWindowPaymentDays.length > 0
          ? riskWindowPaymentDays
          : paymentEligibleDays.length > 0
            ? [paymentEligibleDays[0]!]
            : [daysInDateOrder.at(-1)!];
      const cashLow = diagnosticDays.reduce((lowest, day) =>
        cashBalance(day) < cashBalance(lowest) ? day : lowest,
      );
      const fundingLow = diagnosticDays.reduce((lowest, day) => {
        const candidate = accountBalance(day, card.fundingAccountId);
        const current = accountBalance(lowest, card.fundingAccountId);
        if (candidate === undefined || current === undefined) return lowest;
        return candidate < current ? day : lowest;
      });
      const fundingAccountLowCents = moneyCentsSchema.parse(
        accountBalance(fundingLow, card.fundingAccountId) ?? cashBalance(fundingLow),
      );
      const fundingAccountFloorCents =
        input.accountHardFloorCentsById?.[card.fundingAccountId] ?? 0;
      const hasMissingAccountBalance = riskWindowDays.some((day) =>
        configuredAccountFloors.some(([accountId]) => accountBalance(day, accountId) === undefined),
      );
      const accountMargins = configuredAccountFloors.flatMap(([accountId, floorCents]) =>
        diagnosticDays.flatMap((day) => {
          const balance = accountBalance(day, accountId);
          return balance === undefined ? [] : [balance - floorCents];
        }),
      );
      const hasFundingAccountBalance = diagnosticDays.every(
        (day) => accountBalance(day, card.fundingAccountId) !== undefined,
      );
      const cashMarginCents = cashBalance(cashLow) - hardFloorCents;
      const fundingAccountMarginCents = fundingAccountLowCents - fundingAccountFloorCents;
      const baselineRespectsFloors =
        cashMarginCents >= 0 &&
        fundingAccountMarginCents >= 0 &&
        accountMargins.every((margin) => margin >= 0);
      const maximumIncrementalCashPaymentCents = baselineRespectsFloors
        ? Math.min(cashMarginCents, fundingAccountMarginCents)
        : 0;
      const projectedAmountCents = projectedCycleObligation(card, currentCycle);
      const detailedActivityCents = moneyCentsSchema.parse(
        currentCycle.actualActivityCents + currentCycle.plannedActivityCents,
      );
      const baselineEstimateSlackCents = moneyCentsSchema.parse(
        currentCycle.projectionOverrideCents === undefined
          ? Math.max(0, projectedAmountCents - detailedActivityCents)
          : 0,
      );
      const prerequisiteDays = daysInDateOrder.filter(
        (day) => compareDates(day.date, paymentDate) < 0,
      );
      let prePaymentShortfall:
        { cents: MoneyCents; date: PlainDateString; accountId?: string } | undefined;
      for (const day of prerequisiteDays) {
        const candidates: Array<{ cents: number; accountId?: string }> = [
          { cents: Math.max(0, hardFloorCents - cashBalance(day)) },
          ...configuredAccountFloors.flatMap(([accountId, floorCents]) => {
            const balance = accountBalance(day, accountId);
            return balance === undefined
              ? []
              : [{ cents: Math.max(0, floorCents - balance), accountId }];
          }),
        ];
        const worst = candidates.reduce((largest, candidate) =>
          candidate.cents > largest.cents ? candidate : largest,
        );
        if (worst.cents > 0) {
          if (!prePaymentShortfall || worst.cents > prePaymentShortfall.cents) {
            prePaymentShortfall = {
              cents: moneyCentsSchema.parse(worst.cents),
              date: day.date,
              ...(worst.accountId === undefined ? {} : { accountId: worst.accountId }),
            };
          }
        }
      }
      const spendingPowerStatus: CardSpendingPower['spendingPowerStatus'] =
        overdueStatementWithUnknownTiming
          ? 'indeterminate-overdue-payment-timing'
          : card.paymentPolicy !== 'full-statement'
            ? 'indeterminate-payment-policy'
            : runwayEligibleDays.length === 0 || paymentEligibleDays.length === 0
              ? 'indeterminate-payment-outside-horizon'
              : !hasFundingAccountBalance || hasMissingAccountBalance
                ? 'indeterminate-account-balances'
                : prePaymentShortfall
                  ? 'conditional-existing-shortfall'
                  : 'determinate';
      const hasCalculatedCapacity =
        spendingPowerStatus === 'determinate' ||
        spendingPowerStatus === 'conditional-existing-shortfall';
      const cashBackedCapacityCents =
        hasCalculatedCapacity && baselineRespectsFloors
          ? maximumIncrementalCashPaymentCents + baselineEstimateSlackCents
          : 0;
      const spendingPowerCents = hasCalculatedCapacity
        ? Math.max(0, positionLow.totalPositionCents - hardFloorCents)
        : 0;
      return {
        cardId: card.id,
        cardName: card.name,
        fundingAccountId: card.fundingAccountId,
        statementCycleId: statement?.id,
        statementAmountCents: statement ? projectedCycleObligation(card, statement) : 0,
        statementDueOn: statement?.dueOn,
        statementState: statement?.state,
        currentCycleId: currentCycle.id,
        currentCycleAmountCents: projectedCycleObligation(card, currentCycle),
        currentCycleClosesOn: currentCycle.closesOn,
        currentCyclePaymentOn: currentCycle.paymentOn ?? currentCycle.dueOn,
        spendingPowerCents: moneyCentsSchema.parse(spendingPowerCents),
        cashBackedCapacityCents: moneyCentsSchema.parse(cashBackedCapacityCents),
        spendingPowerStatus,
        prePaymentShortfallCents: prePaymentShortfall?.cents ?? 0,
        prePaymentShortfallDate: prePaymentShortfall?.date,
        prePaymentShortfallAccountId: prePaymentShortfall?.accountId,
        baselineEstimateSlackCents,
        futurePositionLowCents: positionLow.totalPositionCents,
        futurePositionLowDate: positionLow.date,
        futurePositionLowCashCents: positionLow.consolidatedCashCents,
        futurePositionLowReceivableCents: receivableBalance(positionLow),
        futurePositionLowAccountBalances: positionAccountBalances(positionLow),
        futureAccountLows: closingAccountLows(riskWindowDays),
        ...(paymentDateDay === undefined
          ? {}
          : {
              paymentDatePositionCents: paymentDateDay.totalPositionCents,
              paymentDateCashCents: paymentDateDay.consolidatedCashCents,
              paymentDateReceivableCents: receivableBalance(paymentDateDay),
              paymentDateAccountBalances: positionAccountBalances(paymentDateDay),
            }),
        futureCashLowCents: cashBalance(cashLow),
        futureCashLowDate: cashLow.date,
        fundingAccountLowCents,
        fundingAccountLowDate: fundingLow.date,
      };
    })
    .filter((card): card is CardSpendingPower => card !== undefined);
};
