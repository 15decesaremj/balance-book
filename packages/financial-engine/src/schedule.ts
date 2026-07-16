import {
  addDays,
  assertValidIncomePlanGroups,
  compareDates,
  creditCardCycleSchema,
  creditCardSchema,
  daysBetween,
  forecastEventSchema,
  loanSchema,
  moneyCentsSchema,
  plainDateSchema,
  receivableSchema,
  toPlainDate,
  toPlainDateString,
  type CashAccount,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
  type Loan,
  type MoneyCents,
  type PlainDateString,
  type Receivable,
} from '@balance-book/domain';
import {
  assignPurchaseToCycle,
  cardAllowsPurchasesOnDate,
  enrichCardCyclesWithActivities,
  generateCardCyclesThroughHorizon,
  projectCardDebtSchedule,
  resolveCardCyclesAsOf,
  scheduledCardPayment,
} from './cards';
import {
  hasRecurringReceivableSchedule,
  receivableForSettlementSourceFromIndex,
  receivableSettlementDates,
  resolveRecordedReceivableOccurrenceDate,
} from './receivable-occurrences';
import { projectLoanPayoffAtDate } from './loans';
import { expandRecurrence } from './recurrence';
import { summarizeRevolvingDebt } from './revolving-debt';

const occurrenceDates = (event: ForecastEvent, endDate: PlainDateString): PlainDateString[] => {
  const scheduleStart = event.incomeNominalDate ?? event.date;
  if (!event.recurrenceRule) return [scheduleStart];
  const scheduleEnd = event.incomePlanId
    ? addDays(endDate, Math.max(0, -(event.incomeArrivalOffsetDays ?? 0)))
    : endDate;
  const recurrenceEnd =
    event.recurrenceEndDate && compareDates(event.recurrenceEndDate, scheduleEnd) < 0
      ? event.recurrenceEndDate
      : scheduleEnd;
  return expandRecurrence({
    startDate: scheduleStart,
    endDate: recurrenceEnd,
    rule: event.recurrenceRule,
  });
};

/**
 * Reconciles a generated installment-loan draft with explicit cash records linked to the same
 * contractual payment. Partial records leave a generated remainder; an over-recorded lender
 * draft remains authoritative for cash without changing the contractual debt allocation.
 */
export const reconcileScheduledLoanDraftCash = (input: {
  loan: Loan;
  date: PlainDateString;
  generatedCashDraftCents: MoneyCents;
  loanPaymentEvents?: readonly ForecastEvent[];
}): {
  linkedOverrideCents: MoneyCents;
  generatedRemainderCents: MoneyCents;
  totalCashDraftCents: MoneyCents;
} => {
  const loan = loanSchema.parse(input.loan);
  const date = plainDateSchema.parse(input.date);
  const generatedCashDraftCents = moneyCentsSchema.parse(input.generatedCashDraftCents);
  const linkedOverrideCents = moneyCentsSchema.parse(
    (input.loanPaymentEvents ?? []).reduce((total, rawEvent) => {
      const event = forecastEventSchema.parse(rawEvent);
      if (
        event.kind !== 'loan-payment' ||
        (event.loanPaymentTreatment ?? 'scheduled-draft-override') !== 'scheduled-draft-override' ||
        event.sourceRecordId !== loan.id ||
        event.paymentMethod !== 'cash-account' ||
        event.direction !== 'outflow' ||
        event.accountId !== loan.fundingAccountId ||
        event.status === 'cancelled' ||
        event.status === 'skipped' ||
        (event.hypothetical && !event.accepted) ||
        !occurrenceDates(event, date).includes(date)
      ) {
        return total;
      }
      return total + event.amountCents;
    }, 0),
  );
  const generatedRemainderCents = moneyCentsSchema.parse(
    Math.max(0, generatedCashDraftCents - linkedOverrideCents),
  );
  return {
    linkedOverrideCents,
    generatedRemainderCents,
    totalCashDraftCents: moneyCentsSchema.parse(linkedOverrideCents + generatedRemainderCents),
  };
};

export const materializeRecurringEvents = (input: {
  events: ForecastEvent[];
  startDate: PlainDateString;
  endDate: PlainDateString;
}): ForecastEvent[] => {
  const events = input.events.map((event) => forecastEventSchema.parse(event));
  assertValidIncomePlanGroups(events);
  const baseIncomePlans = new Map<string, ForecastEvent[]>();
  for (const event of events) {
    if (!event.incomePlanId || event.incomeType === 'raise-adjustment') continue;
    baseIncomePlans.set(event.incomePlanId, [
      ...(baseIncomePlans.get(event.incomePlanId) ?? []),
      event,
    ]);
  }
  const parentPlanStreamIds = new Map<string, string>();
  const routingPhasesByStream = new Map<
    string,
    Array<{
      planId: string;
      startDate: PlainDateString;
      endDate?: PlainDateString;
      events: ForecastEvent[];
    }>
  >();
  for (const [planId, planEvents] of baseIncomePlans) {
    const first = planEvents[0]!;
    if (
      !first.incomeStreamId ||
      first.status === 'cancelled' ||
      first.status === 'skipped' ||
      !first.incomeNominalDate
    ) {
      continue;
    }
    parentPlanStreamIds.set(planId, first.incomeStreamId);
    const phases = routingPhasesByStream.get(first.incomeStreamId) ?? [];
    phases.push({
      planId,
      startDate: first.incomeNominalDate,
      endDate: first.recurrenceEndDate,
      events: planEvents,
    });
    routingPhasesByStream.set(first.incomeStreamId, phases);
  }
  for (const phases of routingPhasesByStream.values()) {
    phases.sort((left, right) => compareDates(left.startDate, right.startDate));
  }

  const materializeLinkedRaise = (event: ForecastEvent): ForecastEvent[] | undefined => {
    if (
      event.incomeType !== 'raise-adjustment' ||
      !event.parentIncomePlanId ||
      !event.incomeNominalDate ||
      !event.recurrenceRule ||
      event.recurrenceRule.frequency === 'once'
    ) {
      return undefined;
    }
    const streamId = parentPlanStreamIds.get(event.parentIncomePlanId);
    const phases = streamId ? routingPhasesByStream.get(streamId) : undefined;
    if (!phases) return undefined;

    // A raise changes compensation permanently. Its database end date mirrors the phase where the
    // change was entered, while materialization follows only actual later phases in that employer
    // stream. This preserves the raise across routing changes without creating pay in schedule gaps.
    return expandRecurrence({
      startDate: event.incomeNominalDate,
      endDate: addDays(input.endDate, 31),
      rule: event.recurrenceRule,
    }).flatMap((nominalDate) => {
      const phase = phases.find(
        (candidate) =>
          compareDates(candidate.startDate, nominalDate) <= 0 &&
          (!candidate.endDate || compareDates(candidate.endDate, nominalDate) >= 0),
      );
      if (!phase) return [];
      const destination =
        phase.events.find((candidate) => candidate.accountId === event.accountId) ??
        phase.events.find((candidate) => candidate.incomeAllocationRule === 'remainder') ??
        phase.events[0]!;
      const arrivalOffsetDays = destination.incomeArrivalOffsetDays ?? 0;
      const date = addDays(nominalDate, arrivalOffsetDays);
      if (compareDates(date, input.startDate) < 0 || compareDates(date, input.endDate) > 0) {
        return [];
      }
      return [
        forecastEventSchema.parse({
          ...event,
          id: `${event.id}@${nominalDate}->${date}`,
          accountId: destination.accountId,
          date,
          incomeNominalDate: nominalDate,
          incomeArrivalOffsetDays: arrivalOffsetDays,
          recurrenceEndDate: phase.endDate,
          sourceRecordId: event.sourceRecordId ?? event.id,
        }),
      ];
    });
  };
  const recurringTransferCredits = new Set<string>();
  const transferGroups = new Map<string, ForecastEvent[]>();
  for (const event of events) {
    if (!event.transferId) continue;
    const group = transferGroups.get(event.transferId) ?? [];
    group.push(event);
    transferGroups.set(event.transferId, group);
  }

  const pairedTransfers = [...transferGroups.entries()].flatMap(([transferId, group]) => {
    const debit = group.find(
      (event) => event.kind === 'transfer-debit' && event.recurrenceRule !== undefined,
    );
    const credit = group.find((event) => event.kind === 'transfer-credit');
    if (!debit || !credit) return [];
    recurringTransferCredits.add(debit.id);
    recurringTransferCredits.add(credit.id);
    const delayDays = daysBetween(debit.date, credit.date);
    return occurrenceDates(debit, input.endDate).flatMap((debitDate) => {
      const creditDate = addDays(debitDate, delayDays);
      const occurrenceTransferId = `${transferId}@${debitDate}`;
      const occurrences: ForecastEvent[] = [];
      if (
        compareDates(debitDate, input.startDate) >= 0 &&
        compareDates(debitDate, input.endDate) <= 0
      ) {
        occurrences.push(
          forecastEventSchema.parse({
            ...debit,
            id: `${debit.id}@${debitDate}`,
            date: debitDate,
            sourceRecordId: debit.sourceRecordId ?? debit.id,
            transferId: occurrenceTransferId,
          }),
        );
      }
      if (
        compareDates(creditDate, input.startDate) >= 0 &&
        compareDates(creditDate, input.endDate) <= 0
      ) {
        occurrences.push(
          forecastEventSchema.parse({
            ...credit,
            id: `${credit.id}@${creditDate}`,
            date: creditDate,
            sourceRecordId: credit.sourceRecordId ?? credit.id,
            transferId: occurrenceTransferId,
          }),
        );
      }
      return occurrences;
    });
  });

  const ordinaryEvents = events.flatMap((event) => {
    if (recurringTransferCredits.has(event.id)) return [];
    const linkedRaiseOccurrences = materializeLinkedRaise(event);
    if (linkedRaiseOccurrences) return linkedRaiseOccurrences;
    return occurrenceDates(event, input.endDate)
      .map((nominalDate) => ({
        nominalDate,
        date: event.incomePlanId
          ? addDays(nominalDate, event.incomeArrivalOffsetDays ?? 0)
          : nominalDate,
      }))
      .filter(
        ({ date }) =>
          compareDates(date, input.startDate) >= 0 && compareDates(date, input.endDate) <= 0,
      )
      .map(({ nominalDate, date }) =>
        event.recurrenceRule
          ? forecastEventSchema.parse({
              ...event,
              id: event.incomePlanId
                ? `${event.id}@${nominalDate}->${date}`
                : `${event.id}@${date}`,
              date,
              incomeNominalDate: event.incomePlanId ? nominalDate : event.incomeNominalDate,
              sourceRecordId: event.sourceRecordId ?? event.id,
              transferId: event.transferId ? `${event.transferId}@${date}` : undefined,
            })
          : event,
      );
  });
  return [...ordinaryEvents, ...pairedTransfers];
};

export interface CardPurchaseCashImpact {
  owningCycle: CreditCardCycle;
  paymentDate: PlainDateString;
  baselineScheduledPaymentCents: MoneyCents;
  afterPurchaseScheduledPaymentCents: MoneyCents;
  incrementalCashPaymentCents: MoneyCents;
}

export const assertCashBackedCardPurchaseEligibility = (
  cardInput: CreditCard,
  purchaseDate?: PlainDateString,
): void => {
  const card = creditCardSchema.parse(cardInput);
  if (
    card.status === 'closed' &&
    (purchaseDate === undefined || !cardAllowsPurchasesOnDate(card, purchaseDate))
  ) {
    throw new Error('A closed card or line of credit cannot fund a new purchase');
  }
  if (card.paymentPolicy !== 'full-statement') {
    throw new Error('Cash-backed card purchase guidance requires a full-statement payment policy');
  }
};

/**
 * Calculates the exact cash-payment change caused by one additional card
 * purchase. It uses the same generated cycles, detailed-activity enrichment,
 * estimate policy, and payment policy as native forecast materialization.
 */
export const calculateCardPurchaseCashImpact = (input: {
  card: CreditCard;
  cardCycles: CreditCardCycle[];
  cardActivities?: ForecastEvent[];
  purchaseDate: PlainDateString;
  amountCents: MoneyCents;
}): CardPurchaseCashImpact => {
  const card = creditCardSchema.parse(input.card);
  const purchaseDate = toPlainDateString(toPlainDate(input.purchaseDate));
  const amountCents = moneyCentsSchema.positive().parse(input.amountCents);
  if (!cardAllowsPurchasesOnDate(card, purchaseDate)) {
    throw new Error('A closed card or line of credit cannot fund a purchase on or after closure');
  }
  const cycles = generateCardCyclesThroughHorizon({
    card,
    cardCycles: input.cardCycles.filter((cycle) => cycle.cardId === card.id),
    startDate: purchaseDate,
    endDate: purchaseDate,
  });
  const enrichmentEndDate = cycles.reduce(
    (latest, cycle) => (compareDates(cycle.closesOn, latest) > 0 ? cycle.closesOn : latest),
    purchaseDate,
  );
  const baselineCycles = enrichCardCyclesWithActivities({
    cardCycles: resolveCardCyclesAsOf({
      cardCycles: cycles,
      asOfDate: purchaseDate,
    }),
    cardActivities: input.cardActivities ?? [],
    cards: [card],
    endDate: enrichmentEndDate,
  });
  const owningCycle = assignPurchaseToCycle({
    purchaseDate,
    cycles: baselineCycles,
  }).cycle;
  const purchase = forecastEventSchema.parse({
    id: `card-purchase-impact:${card.id}:${purchaseDate}:${amountCents}`,
    userId: card.userId,
    accountId: card.fundingAccountId,
    date: purchaseDate,
    kind: 'scenario',
    direction: 'outflow',
    amountCents,
    certainty: 'confirmed',
    status: 'planned',
    label: `Purchase impact on ${card.name}`,
    hypothetical: false,
    accepted: false,
    paymentMethod: 'credit-card',
    cardId: card.id,
    cardActivityTreatment: 'additional',
  });
  const afterPurchaseCycle = enrichCardCyclesWithActivities({
    cardCycles: baselineCycles,
    cardActivities: [purchase],
    cards: [card],
    endDate: enrichmentEndDate,
  }).find((cycle) => cycle.id === owningCycle.id);
  if (!afterPurchaseCycle) throw new Error(`Card cycle ${owningCycle.id} was not preserved`);
  const baselineScheduledPaymentCents = scheduledCardPayment(card, owningCycle);
  const afterPurchaseScheduledPaymentCents = scheduledCardPayment(card, afterPurchaseCycle);
  return {
    owningCycle,
    paymentDate: owningCycle.paymentOn ?? owningCycle.dueOn,
    baselineScheduledPaymentCents,
    afterPurchaseScheduledPaymentCents,
    incrementalCashPaymentCents: moneyCentsSchema.parse(
      afterPurchaseScheduledPaymentCents - baselineScheduledPaymentCents,
    ),
  };
};

const cardPaymentEvents = (input: {
  accounts: CashAccount[];
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  cardActivities: ForecastEvent[];
  startDate: PlainDateString;
  endDate: PlainDateString;
}): ForecastEvent[] => {
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  let cycles = input.cardCycles.map((cycle) => creditCardCycleSchema.parse(cycle));

  for (const rawCard of input.cards) {
    const card = creditCardSchema.parse(rawCard);
    cycles = generateCardCyclesThroughHorizon({
      card,
      cardCycles: cycles,
      startDate: input.startDate,
      endDate: input.endDate,
    });
  }

  const enrichedCycles = enrichCardCyclesWithActivities({
    cardCycles: resolveCardCyclesAsOf({
      cardCycles: cycles,
      asOfDate: input.startDate,
    }),
    cardActivities: input.cardActivities,
    cards: input.cards,
    endDate: input.endDate,
  });
  const cardById = new Map(input.cards.map((card) => [card.id, creditCardSchema.parse(card)]));
  return [...cardById.values()].flatMap((card) =>
    (() => {
      const explicitPaymentCentsByCycleId = Object.fromEntries(
        enrichedCycles
          .filter((cycle) => cycle.cardId === card.id)
          .map((cycle) => {
            const date = cycle.paymentOn ?? cycle.dueOn;
            const amountCents = input.cardActivities
              .filter(
                (event) =>
                  event.cardId === card.id &&
                  event.kind === 'card-payment' &&
                  event.paymentMethod === 'cash-account' &&
                  event.direction === 'outflow' &&
                  event.status !== 'cancelled' &&
                  event.status !== 'skipped' &&
                  (!event.hypothetical || event.accepted) &&
                  (() => {
                    const paymentAccount = accountById.get(event.accountId);
                    return (
                      paymentAccount !== undefined &&
                      compareDates(date, paymentAccount.balanceAsOf) > 0
                    );
                  })() &&
                  occurrenceDates(event, input.endDate).includes(date),
              )
              .reduce((total, event) => total + event.amountCents, 0);
            return [cycle.id, moneyCentsSchema.nonnegative().parse(amountCents)] as const;
          }),
      );
      const currentDebt = summarizeRevolvingDebt({
        card,
        cycles: enrichedCycles,
        asOfDate: input.startDate,
      });
      const openingCarryingCents =
        currentDebt.carryingBalanceCents > 0
          ? currentDebt.carryingBalanceCents
          : card.accountKind === 'line-of-credit'
            ? currentDebt.currentBalanceCents
            : 0;
      return projectCardDebtSchedule({
        card,
        cardCycles: enrichedCycles,
        asOfDate: input.startDate,
        ...(openingCarryingCents <= 0
          ? {}
          : {
              openingCarryingBalance: {
                cents: openingCarryingCents,
                asOfDate: input.startDate,
              },
            }),
        explicitPaymentCentsByCycleId,
      }).flatMap((entry) => {
        const cycle = entry.cycle;
        const account = accountById.get(card.fundingAccountId);
        if (!account) throw new Error(`Unknown funding account for card ${card.id}`);
        const date = cycle.paymentOn ?? cycle.dueOn;
        if (
          compareDates(date, input.startDate) < 0 ||
          compareDates(date, input.endDate) > 0 ||
          compareDates(date, account.balanceAsOf) <= 0
        )
          return [];
        const generatedPaymentCents = moneyCentsSchema.parse(
          Math.max(0, entry.paymentCents - explicitPaymentCentsByCycleId[cycle.id]!),
        );
        if (generatedPaymentCents <= 0) return [];
        return [
          forecastEventSchema.parse({
            id: `card-payment-${cycle.id}`,
            userId: card.userId,
            accountId: card.fundingAccountId,
            date,
            kind: 'card-payment',
            direction: 'outflow',
            amountCents: generatedPaymentCents,
            certainty:
              cycle.lockedStatementCents !== undefined ||
              cycle.state === 'closed-statement' ||
              cycle.state === 'scheduled-payment'
                ? 'confirmed'
                : 'expected',
            status:
              cycle.state === 'closed-statement' || cycle.state === 'scheduled-payment'
                ? 'scheduled'
                : 'planned',
            label: `${card.name} statement payment`,
            sourceRecordId: cycle.id,
            paymentMethod: 'cash-account',
            cardId: card.id,
          }),
        ];
      });
    })(),
  );
};

const loanPaymentEvents = (input: {
  accounts: CashAccount[];
  events: ForecastEvent[];
  loans: Loan[];
  startDate: PlainDateString;
  endDate: PlainDateString;
}): ForecastEvent[] => {
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const loanById = new Map(
    input.loans.map((rawLoan) => {
      const loan = loanSchema.parse(rawLoan);
      return [loan.id, loan] as const;
    }),
  );
  const explicitOccurrences = input.events
    .filter((event) => event.kind === 'loan-payment')
    .flatMap((source) =>
      occurrenceDates(source, input.endDate)
        .filter(
          (date) =>
            compareDates(date, input.startDate) >= 0 && compareDates(date, input.endDate) <= 0,
        )
        .map((date) => ({
          source,
          occurrence: source.recurrenceRule
            ? forecastEventSchema.parse({
                ...source,
                id: `${source.id}@${date}`,
                date,
                sourceRecordId: source.sourceRecordId ?? source.id,
              })
            : source,
        })),
    );
  const appliedAdditionalPrincipal = new Map<string, MoneyCents>();
  const generated = input.loans.flatMap((rawLoan) => {
    const loan = loanSchema.parse(rawLoan);
    if (
      (loan.status ?? 'active') !== 'active' ||
      loan.includeInCashForecast === false ||
      loan.principalCents + loan.accruedInterestCents <= 0 ||
      compareDates(loan.balanceDate, input.endDate) > 0
    )
      return [];
    const account = accountById.get(loan.fundingAccountId);
    if (!account) throw new Error(`Unknown funding account for loan ${loan.id}`);
    const projection = projectLoanPayoffAtDate(loan, addDays(input.endDate, 1), {
      loanPaymentEvents: input.events,
      actualThroughDate: addDays(input.startDate, -1),
    });
    for (const payment of projection.additionalPrincipalPayments) {
      appliedAdditionalPrincipal.set(
        `${loan.id}|${payment.sourceEventId}|${payment.date}`,
        payment.appliedPrincipalCents,
      );
    }
    return projection.scheduledPayments
      .filter(
        (payment) =>
          compareDates(payment.date, input.startDate) >= 0 &&
          compareDates(payment.date, account.balanceAsOf) > 0,
      )
      .map((payment) =>
        forecastEventSchema.parse({
          id: `loan-payment-${loan.id}@${payment.date}`,
          userId: loan.userId,
          accountId: loan.fundingAccountId,
          date: payment.date,
          kind: 'loan-payment',
          direction: 'outflow',
          amountCents: moneyCentsSchema.parse(
            payment.appliedPaymentCents +
              Math.max(0, (loan.cashPaymentCents ?? loan.paymentCents) - loan.paymentCents),
          ),
          certainty: 'confirmed',
          status: 'scheduled',
          label:
            loan.maturityDate === payment.date
              ? `${loan.name} maturity payment`
              : `${loan.name} payment`,
          sourceRecordId: loan.id,
          paymentMethod: 'cash-account',
        }),
      );
  });
  const eligibleExplicitOccurrences = (candidate: ForecastEvent) =>
    explicitOccurrences.filter(({ source, occurrence }) => {
      if (
        (source.loanPaymentTreatment ?? 'scheduled-draft-override') !==
          'scheduled-draft-override' ||
        occurrence.paymentMethod !== 'cash-account' ||
        occurrence.direction !== 'outflow' ||
        occurrence.accountId !== candidate.accountId ||
        occurrence.date !== candidate.date ||
        occurrence.status === 'cancelled' ||
        occurrence.status === 'skipped' ||
        (occurrence.hypothetical && !occurrence.accepted)
      ) {
        return false;
      }
      const account = accountById.get(occurrence.accountId);
      return account !== undefined && compareDates(candidate.date, account.balanceAsOf) > 0;
    });
  const reconciledGenerated = generated.flatMap((candidate) => {
    const explicit = eligibleExplicitOccurrences(candidate);
    const sourceLoan = candidate.sourceRecordId
      ? loanById.get(candidate.sourceRecordId)
      : undefined;
    const linkedPaymentCents = sourceLoan
      ? reconcileScheduledLoanDraftCash({
          loan: sourceLoan,
          date: candidate.date,
          generatedCashDraftCents: candidate.amountCents,
          loanPaymentEvents: input.events,
        }).linkedOverrideCents
      : 0;
    if (linkedPaymentCents > 0) {
      const remainderCents = moneyCentsSchema.parse(
        Math.max(0, candidate.amountCents - linkedPaymentCents),
      );
      return remainderCents === 0
        ? []
        : [forecastEventSchema.parse({ ...candidate, amountCents: remainderCents })];
    }
    const exactUnlinkedMatches = explicit.filter(
      ({ source, occurrence }) =>
        source.sourceRecordId === undefined && occurrence.amountCents === candidate.amountCents,
    );
    const equivalentGenerated = generated.filter(
      (other) =>
        other.accountId === candidate.accountId &&
        other.date === candidate.date &&
        other.amountCents === candidate.amountCents,
    );
    if (exactUnlinkedMatches.length === 1 && equivalentGenerated.length === 1) return [];
    return [candidate];
  });
  const explicitCash = explicitOccurrences.flatMap(({ source, occurrence }) => {
    if (occurrence.paymentMethod !== 'cash-account') return [];
    const account = accountById.get(occurrence.accountId);
    if (!account || compareDates(occurrence.date, account.balanceAsOf) <= 0) return [];
    if ((source.loanPaymentTreatment ?? 'scheduled-draft-override') !== 'additional-principal') {
      return [occurrence];
    }
    if (
      occurrence.direction !== 'outflow' ||
      occurrence.status === 'cancelled' ||
      occurrence.status === 'skipped' ||
      (occurrence.hypothetical && !occurrence.accepted)
    ) {
      return [occurrence];
    }
    const loan = source.sourceRecordId ? loanById.get(source.sourceRecordId) : undefined;
    if (!loan || occurrence.accountId !== loan.fundingAccountId) return [occurrence];
    const appliedCents = appliedAdditionalPrincipal.get(
      `${loan.id}|${source.id}|${occurrence.date}`,
    );
    if (!appliedCents) return [];
    return [forecastEventSchema.parse({ ...occurrence, amountCents: appliedCents })];
  });
  return [...explicitCash, ...reconciledGenerated];
};

const receivableSettlementEvents = (input: {
  accounts: CashAccount[];
  events: ForecastEvent[];
  receivables: Receivable[];
  startDate: PlainDateString;
  endDate: PlainDateString;
  plannedSettlementStartDate?: PlainDateString;
}): ForecastEvent[] => {
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const parsedReceivables = input.receivables.map((receivable) =>
    receivableSchema.parse(receivable),
  );
  if (
    new Set(parsedReceivables.map((receivable) => receivable.id)).size !== parsedReceivables.length
  ) {
    throw new Error('Receivable IDs must be unique before cash receipts are materialized');
  }
  const receivableById = new Map(
    parsedReceivables.map((receivable) => [receivable.id, receivable]),
  );
  return parsedReceivables.flatMap((receivable) => {
    if (receivable.includeInCashForecast === false) return [];
    const account = accountById.get(receivable.destinationAccountId);
    if (!account) throw new Error(`Unknown destination account for receivable ${receivable.id}`);
    if (account.userId !== receivable.userId) {
      throw new Error(
        `Destination account for receivable ${receivable.id} belongs to another profile`,
      );
    }
    const dates = receivableSettlementDates({
      receivable,
      events: input.events,
      endDate: input.endDate,
    });
    const repeating = hasRecurringReceivableSchedule(receivable);
    const occurrenceSet = new Set(dates);
    const recordedSettlements = new Map<PlainDateString, number>();
    const recordedTargets = new Map<PlainDateString, number>();
    if (repeating) {
      for (const event of input.events) {
        if (
          event.userId !== receivable.userId ||
          event.kind !== 'receivable-settlement' ||
          event.direction !== 'inflow' ||
          !event.sourceRecordId ||
          receivableForSettlementSourceFromIndex(receivableById, event.sourceRecordId)?.id !==
            receivable.id
        ) {
          continue;
        }
        const occurrenceDate = resolveRecordedReceivableOccurrenceDate({
          receivable,
          events: input.events,
          settlementEvent: event,
        });
        if (!occurrenceSet.has(occurrenceDate)) continue;
        const recordedTarget = event.receivableOccurrenceTargetCents;
        const existingTarget = recordedTargets.get(occurrenceDate);
        if (
          recordedTarget !== undefined &&
          existingTarget !== undefined &&
          existingTarget !== recordedTarget
        ) {
          throw new Error(
            `Recorded receipts disagree on the target for receivable ${receivable.id} occurrence ${occurrenceDate}`,
          );
        }
        if (recordedTarget !== undefined) recordedTargets.set(occurrenceDate, recordedTarget);
        if (event.status === 'confirmed' || event.status === 'paid') {
          recordedSettlements.set(
            occurrenceDate,
            (recordedSettlements.get(occurrenceDate) ?? 0) + event.amountCents,
          );
        }
      }
    }
    return dates.flatMap((date) => {
      if (
        compareDates(date, input.startDate) < 0 ||
        compareDates(date, input.endDate) > 0 ||
        compareDates(date, input.plannedSettlementStartDate ?? input.startDate) < 0 ||
        compareDates(date, account.balanceAsOf) <= 0
      )
        return [];
      let amountCents =
        recordedTargets.get(date) ??
        (repeating
          ? date === receivable.expectedDate && receivable.originalAmountCents > 0
            ? receivable.remainingAmountCents
            : (receivable.recurringAmountCents ?? receivable.originalAmountCents)
          : receivable.remainingAmountCents);
      if (repeating && (date !== receivable.expectedDate || receivable.originalAmountCents === 0)) {
        amountCents = Math.max(0, amountCents - (recordedSettlements.get(date) ?? 0));
      }
      if (amountCents <= 0) return [];
      return [
        forecastEventSchema.parse({
          id: `receivable-settlement-${receivable.id}@${date}`,
          userId: receivable.userId,
          accountId: receivable.destinationAccountId,
          date,
          kind: 'receivable-settlement',
          direction: 'inflow',
          amountCents,
          certainty: receivable.certainty,
          status: 'planned',
          label: `${receivable.source}: ${receivable.description}`,
          sourceRecordId: receivable.id,
          paymentMethod: 'cash-account',
        }),
      ];
    });
  });
};

export const materializeForecastEvents = (input: {
  accounts: CashAccount[];
  events: ForecastEvent[];
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  loans: Loan[];
  receivables?: Receivable[];
  startDate: PlainDateString;
  endDate: PlainDateString;
  plannedReceivableStartDate?: PlainDateString;
}): ForecastEvent[] => {
  const parsedEvents = input.events.map((event) => forecastEventSchema.parse(event));
  const recurring = materializeRecurringEvents({
    events: parsedEvents,
    startDate: input.startDate,
    endDate: input.endDate,
  }).filter(
    (event) =>
      event.kind !== 'loan-payment' &&
      (!event.paymentMethod || event.paymentMethod === 'cash-account'),
  );
  const cards = cardPaymentEvents({
    accounts: input.accounts,
    cards: input.cards,
    cardCycles: input.cardCycles,
    cardActivities: parsedEvents,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const loans = loanPaymentEvents({
    accounts: input.accounts,
    events: parsedEvents,
    loans: input.loans,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const receivables = receivableSettlementEvents({
    accounts: input.accounts,
    events: parsedEvents,
    receivables: input.receivables ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    ...(input.plannedReceivableStartDate === undefined
      ? {}
      : { plannedSettlementStartDate: input.plannedReceivableStartDate }),
  });
  return [...recurring, ...cards, ...loans, ...receivables];
};
