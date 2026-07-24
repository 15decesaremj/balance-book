import Decimal from 'decimal.js';
import {
  addDays,
  addMonthsConstrained,
  compareDates,
  daysBetween,
  forecastEventSchema,
  loanSchema,
  moneyCentsSchema,
  plainDateSchema,
  toPlainDate,
  type Loan,
  type ForecastEvent,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import { expandRecurrence } from './recurrence';

export const accrueSimpleInterest = (input: {
  principalCents: MoneyCents;
  annualRateBasisPoints: number;
  fromDate: PlainDateString;
  toDate: PlainDateString;
  convention: Loan['accrualConvention'];
}): Decimal => {
  const days = daysBetween(input.fromDate, input.toDate);
  if (days < 0) throw new Error('Interest end date cannot be before start date');
  const principal = new Decimal(input.principalCents).div(100);
  const annualRate = new Decimal(input.annualRateBasisPoints).div(10_000);
  if (input.convention === 'monthly') {
    return principal.mul(annualRate).div(12).mul(new Decimal(days).div(30));
  }
  const denominator = input.convention === 'actual-360' ? 360 : 365;
  return principal.mul(annualRate).mul(days).div(denominator);
};

export const roundInterestToCents = (interest: Decimal): MoneyCents =>
  moneyCentsSchema.parse(interest.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber());

/**
 * Returns whether a persisted loan-payment instruction is still allowed to move cash for this
 * loan. The loan record is authoritative for lifecycle and funding-account changes; historical
 * event rows remain available for audit, but an inactive/excluded loan or an obsolete account link
 * must not leak a future cash outflow into the forecast.
 */
export const isLoanPaymentEventCashEligible = (
  loanInput: Loan,
  eventInput: ForecastEvent,
): boolean => {
  const loan = loanSchema.parse(loanInput);
  const event = forecastEventSchema.parse(eventInput);
  return (
    event.kind === 'loan-payment' &&
    event.sourceRecordId === loan.id &&
    event.direction === 'outflow' &&
    event.paymentMethod === 'cash-account' &&
    event.accountId === loan.fundingAccountId &&
    (loan.status ?? 'active') === 'active' &&
    loan.includeInCashForecast !== false &&
    event.status !== 'cancelled' &&
    event.status !== 'skipped' &&
    (!event.hypothetical || event.accepted)
  );
};

/**
 * Preserves a contractual 29th/30th/31st anchor when the next payment was constrained into a
 * shorter month. Original and maturity dates are used only when the next payment itself is at
 * month-end; otherwise the explicit next-payment day remains authoritative.
 */
export const contractualMonthlyPaymentDayFromDates = (input: {
  nextPaymentDate: PlainDateString;
  originalDate?: PlainDateString;
  maturityDate?: PlainDateString;
}): number => {
  const nextPayment = toPlainDate(input.nextPaymentDate);
  if (nextPayment.day !== nextPayment.daysInMonth) return nextPayment.day;
  return Math.max(
    nextPayment.day,
    input.originalDate ? toPlainDate(input.originalDate).day : 0,
    input.maturityDate ? toPlainDate(input.maturityDate).day : 0,
  );
};

export const contractualMonthlyPaymentDay = (loanInput: Loan): number => {
  const loan = loanSchema.parse(loanInput);
  return contractualMonthlyPaymentDayFromDates({
    nextPaymentDate: loan.nextPaymentDate,
    originalDate: loan.originalDate,
    maturityDate: loan.maturityDate,
  });
};

export const allocateLoanPayment = (input: {
  principalCents: MoneyCents;
  accruedInterestCents: MoneyCents;
  paymentCents: MoneyCents;
}): {
  interestPaidCents: MoneyCents;
  principalPaidCents: MoneyCents;
  remainingPrincipalCents: MoneyCents;
  remainingAccruedInterestCents: MoneyCents;
  unappliedPaymentCents: MoneyCents;
} => {
  const interestPaidCents = Math.min(input.paymentCents, input.accruedInterestCents);
  const afterInterest = input.paymentCents - interestPaidCents;
  const principalPaidCents = Math.min(afterInterest, input.principalCents);
  return {
    interestPaidCents,
    principalPaidCents,
    remainingPrincipalCents: moneyCentsSchema.parse(input.principalCents - principalPaidCents),
    remainingAccruedInterestCents: moneyCentsSchema.parse(
      input.accruedInterestCents - interestPaidCents,
    ),
    unappliedPaymentCents: moneyCentsSchema.parse(afterInterest - principalPaidCents),
  };
};

export const modeledLoanBalance = (
  loanInput: Loan,
  asOfDate: PlainDateString,
): { principalCents: MoneyCents; accruedInterestCents: MoneyCents; totalCents: MoneyCents } => {
  const loan = loanSchema.parse(loanInput);
  const interest = accrueSimpleInterest({
    principalCents: loan.principalCents,
    annualRateBasisPoints: loan.annualRateBasisPoints,
    fromDate: loan.balanceDate,
    toDate: asOfDate,
    convention: loan.accrualConvention,
  });
  const accruedInterestCents = moneyCentsSchema.parse(
    loan.accruedInterestCents + roundInterestToCents(interest),
  );
  return {
    principalCents: loan.principalCents,
    accruedInterestCents,
    totalCents: moneyCentsSchema.parse(loan.principalCents + accruedInterestCents),
  };
};

export interface LoanPayoffPayment {
  date: PlainDateString;
  scheduledPaymentCents: MoneyCents;
  appliedPaymentCents: MoneyCents;
  interestPaidCents: MoneyCents;
  principalPaidCents: MoneyCents;
  remainingPrincipalCents: MoneyCents;
  remainingAccruedInterestCents: MoneyCents;
}

export interface LoanPayoffProjection {
  payoffDate: PlainDateString;
  payoffCents: MoneyCents;
  principalCents: MoneyCents;
  accruedInterestCents: MoneyCents;
  scheduledPayments: LoanPayoffPayment[];
  additionalPrincipalPayments: LoanAdditionalPrincipalPayment[];
}

export interface LoanAdditionalPrincipalPayment {
  sourceEventId: string;
  date: PlainDateString;
  requestedPrincipalCents: MoneyCents;
  appliedPrincipalCents: MoneyCents;
  unappliedPrincipalCents: MoneyCents;
  remainingPrincipalCents: MoneyCents;
  remainingAccruedInterestCents: MoneyCents;
}

export interface LoanPaymentProjectionOptions {
  loanPaymentEvents?: readonly ForecastEvent[];
  /** Past planned entries are not treated as settled debt payments through this financial date. */
  actualThroughDate?: PlainDateString;
}

export interface ProjectedLoanBalance {
  principalCents: MoneyCents;
  accruedInterestCents: MoneyCents;
  totalCents: MoneyCents;
}

export interface DatedLoanScheduleAnalysis {
  payments: LoanPayoffPayment[];
  totalPaymentsCents: MoneyCents;
  remainingInterestCents: MoneyCents;
  maturityPaymentCents: MoneyCents;
  balloonCents: MoneyCents;
  paidOffDate: PlainDateString;
}

export interface LoanContinuationAnalysis {
  costKnown: boolean;
  termKnown: boolean;
  totalPaymentsCents: MoneyCents;
  remainingInterestCents: MoneyCents | null;
  remainingTermMonths: number | null;
  maturityPaymentCents: MoneyCents;
  residualBalanceCents: MoneyCents;
  paidOffDate: PlainDateString | null;
}

/**
 * Projects the debt required to retire a loan on an exact date. Interest accrues between the
 * balance snapshot, each intervening contractual payment, and the payoff date. Payments strictly
 * before payoff reduce the debt; a payment dated on the payoff day does not execute because the
 * payoff takes effect first. The returned amount is a modeled default for a lender payoff quote,
 * not a substitute for a user-entered quote when one is available.
 */
export const projectLoanPayoffAtDate = (
  loanInput: Loan,
  payoffDateInput: PlainDateString,
  options: LoanPaymentProjectionOptions = {},
): LoanPayoffProjection => {
  const loan = loanSchema.parse(loanInput);
  const payoffDate = plainDateSchema.parse(payoffDateInput);
  if (compareDates(payoffDate, loan.balanceDate) < 0) {
    throw new Error('Loan payoff date cannot be before its balance date');
  }

  let principalCents = loan.principalCents;
  let accruedInterestCents = loan.accruedInterestCents;
  let accruedThroughDate = loan.balanceDate;
  const scheduledPayments: LoanPayoffPayment[] = [];
  const additionalPrincipalPayments: LoanAdditionalPrincipalPayment[] = [];

  const accrueThrough = (date: PlainDateString): void => {
    const interestCents = roundInterestToCents(
      accrueSimpleInterest({
        principalCents,
        annualRateBasisPoints: loan.annualRateBasisPoints,
        fromDate: accruedThroughDate,
        toDate: date,
        convention: loan.accrualConvention,
      }),
    );
    accruedInterestCents = moneyCentsSchema.parse(accruedInterestCents + interestCents);
    accruedThroughDate = date;
  };

  const lastPrePayoffDate = addDays(payoffDate, -1);
  const contractualEndDate =
    loan.maturityDate && compareDates(loan.maturityDate, lastPrePayoffDate) < 0
      ? loan.maturityDate
      : lastPrePayoffDate;
  const paymentRule =
    loan.paymentFrequency === 'biweekly'
      ? ({ frequency: 'biweekly' } as const)
      : ({
          frequency: 'monthly',
          dayOfMonth: contractualMonthlyPaymentDay(loan),
          interval: 1,
        } as const);
  const paymentDates: PlainDateString[] =
    loan.paymentCents > 0 && compareDates(loan.nextPaymentDate, contractualEndDate) <= 0
      ? expandRecurrence({
          startDate: loan.nextPaymentDate,
          endDate: contractualEndDate,
          rule: paymentRule,
        }).filter((date) => compareDates(date, loan.balanceDate) > 0)
      : [];
  if (
    loan.maturityDate &&
    compareDates(loan.maturityDate, loan.balanceDate) > 0 &&
    compareDates(loan.maturityDate, lastPrePayoffDate) <= 0 &&
    !paymentDates.includes(loan.maturityDate)
  ) {
    paymentDates.push(loan.maturityDate);
    paymentDates.sort(compareDates);
  }

  const additionalPrincipalOccurrences = (options.loanPaymentEvents ?? [])
    .flatMap((rawEvent) => {
      const event = forecastEventSchema.parse(rawEvent);
      if (
        event.kind !== 'loan-payment' ||
        event.sourceRecordId !== loan.id ||
        event.loanPaymentTreatment !== 'additional-principal' ||
        event.direction !== 'outflow' ||
        event.paymentMethod !== 'cash-account' ||
        event.accountId !== loan.fundingAccountId ||
        event.amountCents <= 0 ||
        event.status === 'cancelled' ||
        event.status === 'skipped' ||
        (event.hypothetical && !event.accepted)
      ) {
        return [];
      }
      const occurrenceEnd =
        event.recurrenceEndDate && compareDates(event.recurrenceEndDate, lastPrePayoffDate) < 0
          ? event.recurrenceEndDate
          : lastPrePayoffDate;
      if (
        compareDates(event.date, occurrenceEnd) > 0 ||
        compareDates(occurrenceEnd, loan.balanceDate) <= 0
      ) {
        return [];
      }
      const dates = event.recurrenceRule
        ? expandRecurrence({
            startDate: event.date,
            endDate: occurrenceEnd,
            rule: event.recurrenceRule,
          })
        : [event.date];
      return dates
        .filter(
          (date) =>
            compareDates(date, loan.balanceDate) > 0 &&
            (!options.actualThroughDate ||
              compareDates(date, options.actualThroughDate) > 0 ||
              event.status === 'confirmed' ||
              event.status === 'paid'),
        )
        .map((date) => ({ event, date }));
    })
    .sort(
      (left, right) =>
        compareDates(left.date, right.date) || left.event.id.localeCompare(right.event.id),
    );
  const additionalPrincipalByDate = new Map<
    PlainDateString,
    typeof additionalPrincipalOccurrences
  >();
  for (const occurrence of additionalPrincipalOccurrences) {
    additionalPrincipalByDate.set(occurrence.date, [
      ...(additionalPrincipalByDate.get(occurrence.date) ?? []),
      occurrence,
    ]);
  }
  const actionDates = [...new Set([...paymentDates, ...additionalPrincipalByDate.keys()])].sort(
    compareDates,
  );

  for (const date of actionDates) {
    if (principalCents === 0 && accruedInterestCents === 0) break;
    accrueThrough(date);
    if (paymentDates.includes(date)) {
      const scheduledPaymentCents = moneyCentsSchema.parse(
        loan.maturityDate === date ? principalCents + accruedInterestCents : loan.paymentCents,
      );
      const allocation = allocateLoanPayment({
        principalCents,
        accruedInterestCents,
        paymentCents: scheduledPaymentCents,
      });
      const appliedPaymentCents = moneyCentsSchema.parse(
        scheduledPaymentCents - allocation.unappliedPaymentCents,
      );
      principalCents = allocation.remainingPrincipalCents;
      accruedInterestCents = allocation.remainingAccruedInterestCents;
      scheduledPayments.push({
        date,
        scheduledPaymentCents,
        appliedPaymentCents,
        interestPaidCents: allocation.interestPaidCents,
        principalPaidCents: allocation.principalPaidCents,
        remainingPrincipalCents: principalCents,
        remainingAccruedInterestCents: accruedInterestCents,
      });
    }
    for (const occurrence of additionalPrincipalByDate.get(date) ?? []) {
      const appliedPrincipalCents = moneyCentsSchema.parse(
        Math.min(principalCents, occurrence.event.amountCents),
      );
      const unappliedPrincipalCents = moneyCentsSchema.parse(
        occurrence.event.amountCents - appliedPrincipalCents,
      );
      principalCents = moneyCentsSchema.parse(principalCents - appliedPrincipalCents);
      additionalPrincipalPayments.push({
        sourceEventId: occurrence.event.id,
        date,
        requestedPrincipalCents: occurrence.event.amountCents,
        appliedPrincipalCents,
        unappliedPrincipalCents,
        remainingPrincipalCents: principalCents,
        remainingAccruedInterestCents: accruedInterestCents,
      });
    }
  }

  accrueThrough(payoffDate);
  return {
    payoffDate,
    payoffCents: moneyCentsSchema.parse(principalCents + accruedInterestCents),
    principalCents,
    accruedInterestCents,
    scheduledPayments,
    additionalPrincipalPayments,
  };
};

/** Returns the contractual balance after any scheduled payment on the selected calendar date. */
export const projectLoanBalanceAtEndOfDate = (
  loanInput: Loan,
  dateInput: PlainDateString,
  options: LoanPaymentProjectionOptions = {},
): ProjectedLoanBalance => {
  const loan = loanSchema.parse(loanInput);
  const date = plainDateSchema.parse(dateInput);
  const opening = projectLoanPayoffAtDate(loan, date, options);
  const throughNextDay = projectLoanPayoffAtDate(loan, addDays(date, 1), options);
  const sameDayPayment = throughNextDay.scheduledPayments.find((payment) => payment.date === date);
  const sameDayAdditionalPrincipal = throughNextDay.additionalPrincipalPayments
    .filter((payment) => payment.date === date)
    .at(-1);
  const principalCents =
    sameDayAdditionalPrincipal?.remainingPrincipalCents ??
    sameDayPayment?.remainingPrincipalCents ??
    opening.principalCents;
  const accruedInterestCents =
    sameDayAdditionalPrincipal?.remainingAccruedInterestCents ??
    sameDayPayment?.remainingAccruedInterestCents ??
    opening.accruedInterestCents;
  return {
    principalCents,
    accruedInterestCents,
    totalCents: moneyCentsSchema.parse(principalCents + accruedInterestCents),
  };
};

/** Evaluates the exact dated schedule, including a capped final payment or explicit maturity balloon. */
export const analyzeDatedLoanSchedule = (loanInput: Loan): DatedLoanScheduleAnalysis => {
  const loan = loanSchema.parse(loanInput);
  if (!loan.maturityDate) throw new Error('A dated loan analysis requires a maturity date');
  const projection = projectLoanPayoffAtDate(loan, addDays(loan.maturityDate, 1));
  const maturityPayment = projection.scheduledPayments.find(
    (payment) => payment.date === loan.maturityDate,
  );
  const totalPaymentsCents = moneyCentsSchema.parse(
    projection.scheduledPayments.reduce((total, payment) => total + payment.appliedPaymentCents, 0),
  );
  const remainingInterestCents = moneyCentsSchema.parse(
    Math.max(0, totalPaymentsCents - loan.principalCents - loan.accruedInterestCents),
  );
  return {
    payments: projection.scheduledPayments,
    totalPaymentsCents,
    remainingInterestCents,
    maturityPaymentCents: maturityPayment?.appliedPaymentCents ?? 0,
    balloonCents: moneyCentsSchema.parse(
      Math.max(0, (maturityPayment?.appliedPaymentCents ?? 0) - loan.paymentCents),
    ),
    paidOffDate: projection.scheduledPayments.at(-1)?.date ?? loan.balanceDate,
  };
};

/**
 * Prices the exact dated "keep this loan" alternative from a lender payoff quote. Loans with a
 * maturity date include the contractual maturity payoff. Open-ended loans are projected for up
 * to 100 years; a non-amortizing result is explicitly unknown instead of blocking refinancing.
 */
export const analyzeLoanContinuationFromPayoff = (input: {
  loan: Loan;
  payoffDate: PlainDateString;
  payoffAmountCents: MoneyCents;
  loanPaymentEvents?: readonly ForecastEvent[];
  actualThroughDate?: PlainDateString;
}): LoanContinuationAnalysis => {
  const loan = loanSchema.parse(input.loan);
  const payoffDate = plainDateSchema.parse(input.payoffDate);
  const payoffAmountCents = moneyCentsSchema.nonnegative().parse(input.payoffAmountCents);
  if (compareDates(payoffDate, loan.balanceDate) < 0) {
    throw new Error('Loan continuation date cannot be before its balance date');
  }
  if (payoffAmountCents === 0) {
    return {
      costKnown: true,
      termKnown: true,
      totalPaymentsCents: 0,
      remainingInterestCents: 0,
      remainingTermMonths: 0,
      maturityPaymentCents: 0,
      residualBalanceCents: 0,
      paidOffDate: payoffDate,
    };
  }
  if (loan.maturityDate && compareDates(loan.maturityDate, payoffDate) <= 0) {
    return {
      costKnown: true,
      termKnown: true,
      totalPaymentsCents: payoffAmountCents,
      remainingInterestCents: 0,
      remainingTermMonths: 0,
      maturityPaymentCents: payoffAmountCents,
      residualBalanceCents: 0,
      paidOffDate: payoffDate,
    };
  }

  const horizonEnd = loan.maturityDate ?? addMonthsConstrained(payoffDate, 1_200);
  const paymentRule =
    loan.paymentFrequency === 'biweekly'
      ? ({ frequency: 'biweekly' } as const)
      : ({
          frequency: 'monthly',
          dayOfMonth: contractualMonthlyPaymentDay(loan),
          interval: 1,
        } as const);
  const paymentDates = expandRecurrence({
    startDate: loan.nextPaymentDate,
    endDate: horizonEnd,
    rule: paymentRule,
  });
  const modeledAtPayoff = projectLoanPayoffAtDate(loan, payoffDate, {
    loanPaymentEvents: input.loanPaymentEvents,
    actualThroughDate: input.actualThroughDate,
  });
  const modeledPayoffDatePayment = projectLoanPayoffAtDate(loan, addDays(payoffDate, 1), {
    loanPaymentEvents: input.loanPaymentEvents,
    actualThroughDate: input.actualThroughDate,
  }).scheduledPayments.find((payment) => payment.date === payoffDate);
  const quotedPrincipalCents = moneyCentsSchema.parse(
    Math.min(modeledAtPayoff.principalCents, payoffAmountCents),
  );
  const quotedAccruedInterestCents = moneyCentsSchema.parse(
    payoffAmountCents - quotedPrincipalCents,
  );
  const payoffDateAllocation = allocateLoanPayment({
    principalCents: quotedPrincipalCents,
    accruedInterestCents: quotedAccruedInterestCents,
    paymentCents: modeledPayoffDatePayment?.appliedPaymentCents ?? 0,
  });
  const payoffDatePaymentCents = moneyCentsSchema.parse(
    payoffAmountCents -
      payoffDateAllocation.remainingPrincipalCents -
      payoffDateAllocation.remainingAccruedInterestCents,
  );
  const continuationPrincipalCents = payoffDateAllocation.remainingPrincipalCents;
  const continuationAccruedInterestCents = payoffDateAllocation.remainingAccruedInterestCents;
  if (continuationPrincipalCents + continuationAccruedInterestCents === 0) {
    return {
      costKnown: true,
      termKnown: true,
      totalPaymentsCents: payoffDatePaymentCents,
      remainingInterestCents: 0,
      remainingTermMonths: 0,
      maturityPaymentCents: 0,
      residualBalanceCents: 0,
      paidOffDate: payoffDate,
    };
  }
  const nextPaymentDate =
    paymentDates.find((date) => compareDates(date, payoffDate) > 0) ??
    (loan.maturityDate && compareDates(loan.maturityDate, payoffDate) > 0
      ? loan.maturityDate
      : undefined);
  if (!nextPaymentDate) {
    return {
      costKnown: false,
      termKnown: false,
      totalPaymentsCents: payoffDatePaymentCents,
      remainingInterestCents: null,
      remainingTermMonths: null,
      maturityPaymentCents: 0,
      residualBalanceCents: moneyCentsSchema.parse(
        continuationPrincipalCents + continuationAccruedInterestCents,
      ),
      paidOffDate: null,
    };
  }

  const continuation = loanSchema.parse({
    ...loan,
    principalCents: continuationPrincipalCents,
    accruedInterestCents: continuationAccruedInterestCents,
    balanceDate: payoffDate,
    nextPaymentDate,
    ...(loan.maturityDate ? { maturityDate: loan.maturityDate } : {}),
  });
  const projection = projectLoanPayoffAtDate(continuation, addDays(horizonEnd, 1), {
    loanPaymentEvents: input.loanPaymentEvents,
    actualThroughDate: input.actualThroughDate,
  });
  const totalPaymentsCents = moneyCentsSchema.parse(
    payoffDatePaymentCents +
      projection.scheduledPayments.reduce(
        (total, payment) => total + payment.appliedPaymentCents,
        0,
      ) +
      projection.additionalPrincipalPayments.reduce(
        (total, payment) => total + payment.appliedPrincipalCents,
        0,
      ),
  );
  const paidOffPayment = projection.scheduledPayments.find(
    (payment) =>
      payment.remainingPrincipalCents === 0 && payment.remainingAccruedInterestCents === 0,
  );
  const costKnown = projection.payoffCents === 0;
  const paidOffWithExtraPrincipal = projection.additionalPrincipalPayments.find(
    (payment) =>
      payment.remainingPrincipalCents === 0 && payment.remainingAccruedInterestCents === 0,
  );
  const paidOffDate = costKnown
    ? (paidOffPayment?.date ?? paidOffWithExtraPrincipal?.date ?? payoffDate)
    : null;
  const remainingTermMonths = (() => {
    if (!paidOffDate) return null;
    const start = toPlainDate(payoffDate);
    const end = toPlainDate(paidOffDate);
    const wholeCalendarMonths = (end.year - start.year) * 12 + end.month - start.month;
    return Math.max(0, wholeCalendarMonths + (end.day > start.day ? 1 : 0));
  })();
  const maturityPayment = loan.maturityDate
    ? projection.scheduledPayments.find((payment) => payment.date === loan.maturityDate)
    : undefined;
  return {
    costKnown,
    termKnown: costKnown,
    totalPaymentsCents,
    remainingInterestCents: costKnown
      ? moneyCentsSchema.parse(Math.max(0, totalPaymentsCents - payoffAmountCents))
      : null,
    remainingTermMonths,
    maturityPaymentCents: maturityPayment?.appliedPaymentCents ?? 0,
    residualBalanceCents: projection.payoffCents,
    paidOffDate,
  };
};

/** Finds the smallest regular payment that amortizes the dated loan without a maturity balloon. */
export const calculateDatedLoanPayment = (loanInput: Loan): MoneyCents => {
  const loan = loanSchema.parse(loanInput);
  if (!loan.maturityDate) throw new Error('A dated payment calculation requires a maturity date');
  const hasBalloon = (paymentCents: MoneyCents): boolean =>
    analyzeDatedLoanSchedule(
      loanSchema.parse({
        ...loan,
        paymentCents,
      }),
    ).balloonCents > 0;

  let low = 1;
  let high = Math.max(1, loan.principalCents + loan.accruedInterestCents);
  while (hasBalloon(high)) {
    high = moneyCentsSchema.positive().parse(high * 2);
  }
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (hasBalloon(midpoint)) low = midpoint + 1;
    else high = midpoint;
  }
  return moneyCentsSchema.positive().parse(low);
};

export const compareRefinance = (input: {
  currentPayoffCents: MoneyCents;
  currentPaymentCents: MoneyCents;
  currentRemainingPayments: number;
  currentAnnualRateBasisPoints?: number;
  newPrincipalCents: MoneyCents;
  newAnnualRateBasisPoints?: number;
  newPaymentCents?: MoneyCents;
  newTermMonths: number;
  feesCents: MoneyCents;
  cashAtClosingCents: MoneyCents;
  cashProceedsCents?: MoneyCents;
}): {
  monthlyPaymentChangeCents: MoneyCents;
  effectiveNewPaymentCents: MoneyCents;
  currentTotalRemainingCostCents: MoneyCents;
  newTotalCostCents: MoneyCents;
  totalCostChangeCents: MoneyCents;
  currentRemainingInterestCents: MoneyCents;
  newRemainingInterestCents: MoneyCents;
  newResidualBalanceCents: MoneyCents;
  termChangeMonths: number;
  breakEvenMonths: number | null;
} => {
  const currentRate = input.currentAnnualRateBasisPoints ?? 0;
  const newRate = input.newAnnualRateBasisPoints ?? 0;
  const cashProceedsCents = moneyCentsSchema.nonnegative().parse(input.cashProceedsCents ?? 0);
  const effectiveNewPaymentCents = moneyCentsSchema.nonnegative().parse(
    input.newPaymentCents && input.newPaymentCents > 0
      ? input.newPaymentCents
      : levelMonthlyPaymentCents({
          principalCents: input.newPrincipalCents,
          annualRateBasisPoints: newRate,
          termMonths: input.newTermMonths,
        }),
  );
  const currentSchedule = amortizeForTerm({
    principalCents: input.currentPayoffCents,
    annualRateBasisPoints: currentRate,
    paymentCents: input.currentPaymentCents,
    termMonths: input.currentRemainingPayments,
  });
  const newSchedule = amortizeForTerm({
    principalCents: input.newPrincipalCents,
    annualRateBasisPoints: newRate,
    paymentCents: effectiveNewPaymentCents,
    termMonths: input.newTermMonths,
  });
  const nativeCurrent = input.currentAnnualRateBasisPoints !== undefined;
  const nativeNew = input.newAnnualRateBasisPoints !== undefined;
  const currentTotal = moneyCentsSchema.parse(
    nativeCurrent
      ? currentSchedule.totalPaymentsCents + currentSchedule.remainingPrincipalCents
      : input.currentPaymentCents * input.currentRemainingPayments,
  );
  const newTotal = moneyCentsSchema.parse(
    (nativeNew
      ? newSchedule.totalPaymentsCents + newSchedule.remainingPrincipalCents
      : effectiveNewPaymentCents * input.newTermMonths) +
      input.feesCents +
      input.cashAtClosingCents -
      cashProceedsCents,
  );
  const monthlySavings = input.currentPaymentCents - effectiveNewPaymentCents;
  const netUpfrontCashCents = moneyCentsSchema.parse(
    input.feesCents + input.cashAtClosingCents - cashProceedsCents,
  );
  return {
    monthlyPaymentChangeCents: moneyCentsSchema.parse(
      effectiveNewPaymentCents - input.currentPaymentCents,
    ),
    effectiveNewPaymentCents,
    currentTotalRemainingCostCents: currentTotal,
    newTotalCostCents: newTotal,
    totalCostChangeCents: moneyCentsSchema.parse(newTotal - currentTotal),
    currentRemainingInterestCents: nativeCurrent
      ? currentSchedule.totalInterestCents
      : moneyCentsSchema.parse(Math.max(0, currentTotal - input.currentPayoffCents)),
    newRemainingInterestCents: nativeNew
      ? newSchedule.totalInterestCents
      : moneyCentsSchema.parse(
          Math.max(0, effectiveNewPaymentCents * input.newTermMonths - input.newPrincipalCents),
        ),
    newResidualBalanceCents: nativeNew ? newSchedule.remainingPrincipalCents : 0,
    termChangeMonths: input.newTermMonths - input.currentRemainingPayments,
    breakEvenMonths:
      monthlySavings <= 0 ? null : Math.max(0, Math.ceil(netUpfrontCashCents / monthlySavings)),
  };
};

export const levelMonthlyPaymentCents = (input: {
  principalCents: MoneyCents;
  annualRateBasisPoints: number;
  termMonths: number;
}): MoneyCents => {
  const principal = moneyCentsSchema.nonnegative().parse(input.principalCents);
  if (!Number.isInteger(input.termMonths) || input.termMonths <= 0) {
    throw new Error('Loan term must be a positive whole number of months');
  }
  if (principal === 0) return 0;
  const monthlyRate = new Decimal(input.annualRateBasisPoints).div(10_000).div(12);
  if (monthlyRate.isZero()) {
    return moneyCentsSchema.parse(
      new Decimal(principal)
        .div(input.termMonths)
        .toDecimalPlaces(0, Decimal.ROUND_CEIL)
        .toNumber(),
    );
  }
  const growth = monthlyRate.add(1).pow(input.termMonths);
  return moneyCentsSchema.parse(
    new Decimal(principal)
      .mul(monthlyRate)
      .mul(growth)
      .div(growth.sub(1))
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber(),
  );
};

const amortizeForTerm = (input: {
  principalCents: MoneyCents;
  annualRateBasisPoints: number;
  paymentCents: MoneyCents;
  termMonths: number;
}): {
  totalPaymentsCents: MoneyCents;
  totalInterestCents: MoneyCents;
  remainingPrincipalCents: MoneyCents;
} => {
  const monthlyRate = new Decimal(input.annualRateBasisPoints).div(10_000).div(12);
  let principal = new Decimal(input.principalCents);
  let totalPayments = new Decimal(0);
  let totalInterest = new Decimal(0);
  for (let month = 1; month <= input.termMonths && principal.gt(0); month += 1) {
    const interest = principal.mul(monthlyRate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const amountDue = principal.add(interest);
    const payment = Decimal.min(input.paymentCents, amountDue);
    if (payment.lte(interest) && principal.gt(0)) break;
    totalInterest = totalInterest.add(interest);
    totalPayments = totalPayments.add(payment);
    principal = Decimal.max(0, amountDue.sub(payment));
  }
  return {
    totalPaymentsCents: moneyCentsSchema.parse(totalPayments.toNumber()),
    totalInterestCents: moneyCentsSchema.parse(totalInterest.toNumber()),
    remainingPrincipalCents: moneyCentsSchema.parse(principal.toNumber()),
  };
};

export const projectLoanPayoff = (input: {
  principalCents: MoneyCents;
  annualRateBasisPoints: number;
  paymentCents: MoneyCents;
}): { payoffMonths: number | null; remainingInterestCents: MoneyCents | null } => {
  if (input.principalCents <= 0) return { payoffMonths: 0, remainingInterestCents: 0 };
  const monthlyRate = new Decimal(input.annualRateBasisPoints).div(10_000).div(12);
  let principal = new Decimal(input.principalCents);
  let interestTotal = new Decimal(0);
  for (let month = 1; month <= 1_200; month += 1) {
    const interest = principal.mul(monthlyRate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    if (new Decimal(input.paymentCents).lte(interest)) {
      return { payoffMonths: null, remainingInterestCents: null };
    }
    interestTotal = interestTotal.add(interest);
    principal = Decimal.max(0, principal.add(interest).sub(input.paymentCents));
    if (principal.isZero()) {
      return {
        payoffMonths: month,
        remainingInterestCents: moneyCentsSchema.parse(interestTotal.toNumber()),
      };
    }
  }
  return { payoffMonths: null, remainingInterestCents: null };
};
