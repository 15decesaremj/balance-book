import {
  addDays,
  addMonthsConstrained,
  compareDates,
  daysBetween,
  loanSchema,
  moneyCentsSchema,
  plainDateSchema,
  toPlainDate,
  toPlainDateString,
  type Loan,
  type LoanInferredField,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import {
  accrueSimpleInterest,
  allocateLoanPayment,
  contractualMonthlyPaymentDayFromDates,
  projectLoanPayoffAtDate,
  roundInterestToCents,
} from './loans';

export type InstallmentLoanSetupStatus = 'exact' | 'approximate' | 'incomplete' | 'inconsistent';
export type InstallmentPaymentFrequency = 'monthly' | 'biweekly';
export type InstallmentAccrualConvention = Loan['accrualConvention'];
export type InstallmentAmortizationStructure = Loan['amortizationStructure'];

export interface InstallmentLoanSetupInput {
  /** The dashboard's effective financial date. This is never read from the wall clock. */
  asOfDate: PlainDateString;
  /** Principal, excluding separately reported accrued interest, at balanceDate. */
  principalCents?: MoneyCents;
  balanceDate?: PlainDateString;
  accruedInterestCents?: MoneyCents;
  annualRateBasisPoints?: number;
  /** Contractual debt service. Taxes, insurance, and other cash-only amounts belong below. */
  paymentCents?: MoneyCents;
  /** Total cash draft when it differs from contractual debt service. */
  cashPaymentCents?: MoneyCents;
  nextPaymentDate?: PlainDateString;
  maturityDate?: PlainDateString;
  originalPrincipalCents?: MoneyCents;
  originalDate?: PlainDateString;
  originalTermMonths?: number;
  paymentFrequency?: InstallmentPaymentFrequency;
  accrualConvention?: InstallmentAccrualConvention;
  amortizationStructure?: InstallmentAmortizationStructure;
  /** Contractual residual due beyond the regular payment on the maturity date. */
  expectedBalloonCents?: MoneyCents;
}

export interface ResolvedInstallmentLoanSetup extends InstallmentLoanSetupInput {
  balanceDate: PlainDateString;
  accruedInterestCents: MoneyCents;
  paymentFrequency: InstallmentPaymentFrequency;
  accrualConvention: InstallmentAccrualConvention;
  amortizationStructure: InstallmentAmortizationStructure;
}

export type InstallmentLoanSetupField = Exclude<keyof InstallmentLoanSetupInput, 'asOfDate'>;
export type InstallmentLoanInferredField = LoanInferredField;

export interface InstallmentLoanMissingAlternative {
  label: string;
  requiredFields: InstallmentLoanSetupField[];
  missingFields: InstallmentLoanSetupField[];
}

export interface InstallmentLoanReconciliation {
  check:
    | 'original-payment'
    | 'current-payment'
    | 'original-maturity'
    | 'current-balance'
    | 'current-accrued-interest'
    | 'original-principal'
    | 'original-date'
    | 'balloon';
  outcome: 'matched' | 'approximate' | 'conflict';
  message: string;
  residualCents?: number;
  residualDays?: number;
}

export interface InstallmentLoanSetupDiagnostics {
  iterations: number;
  nonAmortizing: boolean;
  inputErrors: string[];
  contradictions: string[];
  reconciliations: InstallmentLoanReconciliation[];
}

export interface ExactInstallmentLoanPayoffSummary {
  exact: true;
  payoffDate: PlainDateString;
  payoffPeriods: number;
  payoffMonths: number;
  totalRemainingPaymentsCents: MoneyCents;
  remainingInterestCents: MoneyCents;
  finalPaymentCents: MoneyCents;
  balloonCents: MoneyCents;
}

export interface InstallmentLoanSetupResult {
  status: InstallmentLoanSetupStatus;
  resolved: ResolvedInstallmentLoanSetup;
  inferredFields: InstallmentLoanInferredField[];
  assumptions: string[];
  missingAlternatives: InstallmentLoanMissingAlternative[];
  diagnostics: InstallmentLoanSetupDiagnostics;
  payoff: ExactInstallmentLoanPayoffSummary | null;
}

const MAX_RATE_BASIS_POINTS = 100_000;
const MAX_TERM_MONTHS = 1_200;
const MAX_REVERSE_PRINCIPAL_CENTS = 1_000_000_000_000;
const MAX_SCHEDULE_PERIODS = 6_400;
const syntheticLoanIdentity = {
  id: 'installment-loan-solver',
  userId: 'installment-loan-solver-user',
  name: 'Installment loan setup',
  fundingAccountId: 'installment-loan-solver-account',
} as const;

const uniquePush = <T>(values: T[], value: T): void => {
  if (!values.includes(value)) values.push(value);
};

const wholeCalendarMonths = (start: PlainDateString, end: PlainDateString): number => {
  const left = toPlainDate(start);
  const right = toPlainDate(end);
  return (right.year - left.year) * 12 + right.month - left.month;
};

const calendarMonthsCeiling = (start: PlainDateString, end: PlainDateString): number => {
  const wholeMonths = wholeCalendarMonths(start, end);
  const anniversary = addMonthsConstrained(start, wholeMonths);
  return Math.max(0, wholeMonths + (compareDates(anniversary, end) < 0 ? 1 : 0));
};

const cadenceDate = (
  anchor: PlainDateString,
  periods: number,
  frequency: InstallmentPaymentFrequency,
  monthlyPaymentDay?: number,
): PlainDateString =>
  frequency === 'biweekly'
    ? addDays(anchor, periods * 14)
    : (() => {
        const shifted = toPlainDate(anchor).add({ months: periods }, { overflow: 'constrain' });
        return toPlainDateString(
          shifted.with({
            day: Math.min(monthlyPaymentDay ?? toPlainDate(anchor).day, shifted.daysInMonth),
          }),
        );
      })();

const priorCadenceDate = (
  anchor: PlainDateString,
  periods: number,
  frequency: InstallmentPaymentFrequency,
): PlainDateString =>
  frequency === 'biweekly'
    ? addDays(anchor, periods * -14)
    : toPlainDateString(
        toPlainDate(anchor).subtract({ months: periods }, { overflow: 'constrain' }),
      );

/** Finds the next contractual occurrence while preserving the original monthly day/EOM anchor. */
const nextCadenceDate = (
  originalDate: PlainDateString,
  afterDate: PlainDateString,
  frequency: InstallmentPaymentFrequency,
): PlainDateString => {
  if (frequency === 'biweekly') {
    const periods = Math.max(1, Math.floor(daysBetween(originalDate, afterDate) / 14) + 1);
    return cadenceDate(originalDate, periods, frequency);
  }
  let periods = Math.max(1, wholeCalendarMonths(originalDate, afterDate));
  let candidate = cadenceDate(originalDate, periods, frequency);
  while (compareDates(candidate, afterDate) <= 0) {
    periods += 1;
    candidate = cadenceDate(originalDate, periods, frequency);
  }
  while (periods > 1) {
    const previous = cadenceDate(originalDate, periods - 1, frequency);
    if (compareDates(previous, afterDate) <= 0) break;
    periods -= 1;
    candidate = previous;
  }
  return candidate;
};

const monthlyPaymentDayFromExplicitFuture = (input: {
  futurePaymentDate: PlainDateString;
  originalDate?: PlainDateString;
  maturityDate?: PlainDateString;
}): number => {
  const originalDate =
    input.originalDate !== undefined &&
    toPlainDate(input.originalDate).day === toPlainDate(input.originalDate).daysInMonth
      ? input.originalDate
      : undefined;
  return contractualMonthlyPaymentDayFromDates({
    nextPaymentDate: input.futurePaymentDate,
    ...(originalDate === undefined ? {} : { originalDate }),
    ...(input.maturityDate === undefined ? {} : { maturityDate: input.maturityDate }),
  });
};

/**
 * Walks a known future payment cadence backwards to the first contractual payment after a date.
 * This keeps an explicit due day separate from the origination day (for example, a loan opened
 * on the 15th whose payments are due on the 1st).
 */
const firstCadenceAfterFromFuturePayment = (input: {
  afterDate: PlainDateString;
  futurePaymentDate: PlainDateString;
  frequency: InstallmentPaymentFrequency;
  originalDate?: PlainDateString;
  maturityDate?: PlainDateString;
}): PlainDateString => {
  if (compareDates(input.futurePaymentDate, input.afterDate) <= 0) {
    throw new Error('A future payment anchor must be after the requested date');
  }
  const monthlyPaymentDay =
    input.frequency === 'monthly'
      ? monthlyPaymentDayFromExplicitFuture({
          futurePaymentDate: input.futurePaymentDate,
          originalDate: input.originalDate,
          maturityDate: input.maturityDate,
        })
      : undefined;
  let firstAfter = input.futurePaymentDate;
  for (let periodsBack = 1; periodsBack <= MAX_SCHEDULE_PERIODS; periodsBack += 1) {
    const prior = cadenceDate(
      input.futurePaymentDate,
      -periodsBack,
      input.frequency,
      monthlyPaymentDay,
    );
    if (compareDates(prior, input.afterDate) <= 0) return firstAfter;
    firstAfter = prior;
  }
  throw new Error('Payment cadence exceeds the bounded solving horizon');
};

interface SolverPayment {
  date: PlainDateString;
  appliedPaymentCents: MoneyCents;
  remainingPrincipalCents: MoneyCents;
  remainingAccruedInterestCents: MoneyCents;
}

interface SolverProjection {
  principalCents: MoneyCents;
  accruedInterestCents: MoneyCents;
  payments: SolverPayment[];
}

const cadenceDatesThrough = (input: {
  firstPaymentDate?: PlainDateString;
  cadenceAnchor?: PlainDateString;
  endDate: PlainDateString;
  frequency: InstallmentPaymentFrequency;
  maturityDate?: PlainDateString;
}): PlainDateString[] => {
  const dates: PlainDateString[] = [];
  const monthlyPaymentDay = (() => {
    if (input.frequency !== 'monthly') return undefined;
    const referenceDate =
      input.firstPaymentDate ??
      (input.cadenceAnchor ? cadenceDate(input.cadenceAnchor, 1, input.frequency) : undefined);
    if (!referenceDate) return undefined;
    return input.firstPaymentDate === undefined
      ? contractualMonthlyPaymentDayFromDates({
          nextPaymentDate: referenceDate,
          originalDate: input.cadenceAnchor,
          maturityDate: input.maturityDate,
        })
      : monthlyPaymentDayFromExplicitFuture({
          futurePaymentDate: referenceDate,
          originalDate: input.cadenceAnchor,
          maturityDate: input.maturityDate,
        });
  })();
  if (input.firstPaymentDate !== undefined) {
    if (compareDates(input.firstPaymentDate, input.endDate) <= 0) {
      dates.push(input.firstPaymentDate);
    }
    for (let period = 1; period <= MAX_SCHEDULE_PERIODS; period += 1) {
      const date = cadenceDate(input.firstPaymentDate, period, input.frequency, monthlyPaymentDay);
      if (compareDates(date, input.endDate) > 0) break;
      dates.push(date);
    }
    if (
      compareDates(
        cadenceDate(
          input.firstPaymentDate,
          MAX_SCHEDULE_PERIODS + 1,
          input.frequency,
          monthlyPaymentDay,
        ),
        input.endDate,
      ) <= 0
    ) {
      throw new Error('Payment schedule exceeds the bounded solving horizon');
    }
  } else if (input.cadenceAnchor !== undefined) {
    for (let period = 1; period <= MAX_SCHEDULE_PERIODS; period += 1) {
      const date = cadenceDate(input.cadenceAnchor, period, input.frequency, monthlyPaymentDay);
      if (compareDates(date, input.endDate) > 0) break;
      dates.push(date);
    }
    if (
      compareDates(
        cadenceDate(
          input.cadenceAnchor,
          MAX_SCHEDULE_PERIODS + 1,
          input.frequency,
          monthlyPaymentDay,
        ),
        input.endDate,
      ) <= 0
    ) {
      throw new Error('Payment schedule exceeds the bounded solving horizon');
    }
  }
  if (
    input.maturityDate !== undefined &&
    compareDates(input.maturityDate, input.endDate) <= 0 &&
    !dates.includes(input.maturityDate)
  ) {
    dates.push(input.maturityDate);
    dates.sort(compareDates);
  }
  return dates;
};

const simulateSolverSchedule = (input: {
  principalCents: MoneyCents;
  accruedInterestCents: MoneyCents;
  balanceDate: PlainDateString;
  annualRateBasisPoints: number;
  paymentCents: MoneyCents;
  dates: PlainDateString[];
  endDate: PlainDateString;
  maturityDate?: PlainDateString;
  payBalloonAtMaturity: boolean;
  accrualConvention: InstallmentAccrualConvention;
}): SolverProjection => {
  let principalCents = input.principalCents;
  let accruedInterestCents = input.accruedInterestCents;
  let accruedThroughDate = input.balanceDate;
  const payments: SolverPayment[] = [];

  const accrueThrough = (date: PlainDateString): void => {
    const interestCents = roundInterestToCents(
      accrueSimpleInterest({
        principalCents,
        annualRateBasisPoints: input.annualRateBasisPoints,
        fromDate: accruedThroughDate,
        toDate: date,
        convention: input.accrualConvention,
      }),
    );
    accruedInterestCents = moneyCentsSchema.parse(accruedInterestCents + interestCents);
    accruedThroughDate = date;
  };

  for (const date of input.dates) {
    if (compareDates(date, input.balanceDate) <= 0 || compareDates(date, input.endDate) > 0) {
      continue;
    }
    if (principalCents === 0 && accruedInterestCents === 0) break;
    accrueThrough(date);
    const scheduledPaymentCents = moneyCentsSchema.parse(
      input.payBalloonAtMaturity && date === input.maturityDate
        ? principalCents + accruedInterestCents
        : input.paymentCents,
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
    payments.push({
      date,
      appliedPaymentCents,
      remainingPrincipalCents: principalCents,
      remainingAccruedInterestCents: accruedInterestCents,
    });
  }
  if (compareDates(accruedThroughDate, input.endDate) < 0) accrueThrough(input.endDate);
  return { principalCents, accruedInterestCents, payments };
};

const calculateAnchoredPayment = (input: {
  principalCents: MoneyCents;
  accruedInterestCents: MoneyCents;
  balanceDate: PlainDateString;
  annualRateBasisPoints: number;
  maturityDate: PlainDateString;
  firstPaymentDate?: PlainDateString;
  cadenceAnchor?: PlainDateString;
  frequency: InstallmentPaymentFrequency;
  accrualConvention: InstallmentAccrualConvention;
  targetResidualCents?: MoneyCents;
}): MoneyCents => {
  if (input.principalCents + input.accruedInterestCents === 0) return 0;
  const targetResidualCents = moneyCentsSchema.nonnegative().parse(input.targetResidualCents ?? 0);
  const dates = cadenceDatesThrough({
    ...(input.firstPaymentDate === undefined ? {} : { firstPaymentDate: input.firstPaymentDate }),
    ...(input.cadenceAnchor === undefined ? {} : { cadenceAnchor: input.cadenceAnchor }),
    endDate: input.maturityDate,
    frequency: input.frequency,
    maturityDate: input.maturityDate,
  });
  if (dates.length === 0) {
    throw new Error('A maturity-based loan calculation requires at least one payment date');
  }
  const residualByPayment = new Map<MoneyCents, MoneyCents>();
  const residualDebt = (paymentCents: MoneyCents): MoneyCents => {
    const cached = residualByPayment.get(paymentCents);
    if (cached !== undefined) return cached;
    const result = simulateSolverSchedule({
      principalCents: input.principalCents,
      accruedInterestCents: input.accruedInterestCents,
      balanceDate: input.balanceDate,
      annualRateBasisPoints: input.annualRateBasisPoints,
      paymentCents,
      dates,
      endDate: input.maturityDate,
      maturityDate: input.maturityDate,
      payBalloonAtMaturity: false,
      accrualConvention: input.accrualConvention,
    });
    const residual = moneyCentsSchema.parse(result.principalCents + result.accruedInterestCents);
    residualByPayment.set(paymentCents, residual);
    return residual;
  };
  if (residualDebt(0) <= targetResidualCents) return 0;
  let low = 0;
  let high = Math.min(
    MAX_REVERSE_PRINCIPAL_CENTS,
    Math.max(1, input.principalCents + input.accruedInterestCents),
  );
  for (
    let expansion = 0;
    expansion < 54 && residualDebt(high) > targetResidualCents;
    expansion += 1
  ) {
    high = Math.min(MAX_REVERSE_PRINCIPAL_CENTS, high * 2);
  }
  if (residualDebt(high) > targetResidualCents) {
    throw new Error('Payment search exceeded its safe bounded range');
  }
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (residualDebt(midpoint) > targetResidualCents) low = midpoint + 1;
    else high = midpoint;
  }
  const candidates = [low, Math.max(0, low - 1)];
  candidates.sort(
    (left, right) =>
      Math.abs(residualDebt(left) - targetResidualCents) -
        Math.abs(residualDebt(right) - targetResidualCents) || left - right,
  );
  return moneyCentsSchema.nonnegative().parse(candidates[0]);
};

const projectAnchoredBalanceAtDate = (input: {
  originalPrincipalCents: MoneyCents;
  originalDate: PlainDateString;
  balanceDate: PlainDateString;
  annualRateBasisPoints: number;
  paymentCents: MoneyCents;
  maturityDate?: PlainDateString;
  futurePaymentDate?: PlainDateString;
  frequency: InstallmentPaymentFrequency;
  accrualConvention: InstallmentAccrualConvention;
}): SolverProjection => {
  if (compareDates(input.balanceDate, input.originalDate) < 0) {
    throw new Error('A projected balance date cannot precede origination');
  }
  const firstPaymentDate =
    input.futurePaymentDate === undefined
      ? undefined
      : firstCadenceAfterFromFuturePayment({
          afterDate: input.originalDate,
          futurePaymentDate: input.futurePaymentDate,
          frequency: input.frequency,
          originalDate: input.originalDate,
          maturityDate: input.maturityDate,
        });
  const dates = cadenceDatesThrough({
    ...(firstPaymentDate === undefined
      ? { cadenceAnchor: input.originalDate }
      : { firstPaymentDate, cadenceAnchor: input.originalDate }),
    endDate: input.balanceDate,
    frequency: input.frequency,
    maturityDate: input.maturityDate,
  });
  return simulateSolverSchedule({
    principalCents: input.originalPrincipalCents,
    accruedInterestCents: 0,
    balanceDate: input.originalDate,
    annualRateBasisPoints: input.annualRateBasisPoints,
    paymentCents: input.paymentCents,
    dates,
    endDate: input.balanceDate,
    maturityDate: input.maturityDate,
    payBalloonAtMaturity: true,
    accrualConvention: input.accrualConvention,
  });
};

const makeLoan = (input: {
  principalCents: MoneyCents;
  accruedInterestCents?: MoneyCents;
  balanceDate: PlainDateString;
  annualRateBasisPoints: number;
  paymentCents: MoneyCents;
  cashPaymentCents?: MoneyCents;
  nextPaymentDate: PlainDateString;
  maturityDate?: PlainDateString;
  originalPrincipalCents?: MoneyCents;
  originalDate?: PlainDateString;
  originalTermMonths?: number;
  amortizationStructure?: InstallmentAmortizationStructure;
  expectedBalloonCents?: MoneyCents;
  paymentFrequency: InstallmentPaymentFrequency;
  accrualConvention: InstallmentAccrualConvention;
}): Loan =>
  loanSchema.parse({
    ...syntheticLoanIdentity,
    principalCents: input.principalCents,
    accruedInterestCents: input.accruedInterestCents ?? 0,
    balanceDate: input.balanceDate,
    annualRateBasisPoints: input.annualRateBasisPoints,
    accrualConvention: input.accrualConvention,
    paymentCents: input.paymentCents,
    ...(input.cashPaymentCents === undefined ? {} : { cashPaymentCents: input.cashPaymentCents }),
    nextPaymentDate: input.nextPaymentDate,
    ...(input.maturityDate === undefined ? {} : { maturityDate: input.maturityDate }),
    ...(input.originalPrincipalCents === undefined
      ? {}
      : { originalPrincipalCents: input.originalPrincipalCents }),
    ...(input.originalDate === undefined ? {} : { originalDate: input.originalDate }),
    ...(input.originalTermMonths === undefined
      ? {}
      : { originalTermMonths: input.originalTermMonths }),
    amortizationStructure: input.amortizationStructure ?? 'fully-amortizing',
    ...(input.expectedBalloonCents === undefined
      ? {}
      : { expectedBalloonCents: input.expectedBalloonCents }),
    paymentFrequency: input.paymentFrequency,
  });

const isValidDate = (value: unknown): value is PlainDateString =>
  typeof value === 'string' && plainDateSchema.safeParse(value).success;

const isValidNonnegativeMoney = (value: unknown): value is MoneyCents =>
  typeof value === 'number' && moneyCentsSchema.safeParse(value).success && value >= 0;

const isValidRate = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= MAX_RATE_BASIS_POINTS;

const isValidTerm = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TERM_MONTHS;

const normalizeResolvedInput = (
  input: InstallmentLoanSetupInput,
): ResolvedInstallmentLoanSetup => ({
  asOfDate: input.asOfDate,
  balanceDate: isValidDate(input.balanceDate) ? input.balanceDate : input.asOfDate,
  accruedInterestCents: isValidNonnegativeMoney(input.accruedInterestCents)
    ? input.accruedInterestCents
    : 0,
  paymentFrequency:
    input.paymentFrequency === 'monthly' || input.paymentFrequency === 'biweekly'
      ? input.paymentFrequency
      : 'monthly',
  accrualConvention: ['actual-365', 'actual-360', 'monthly'].includes(input.accrualConvention ?? '')
    ? input.accrualConvention!
    : 'actual-365',
  amortizationStructure: input.amortizationStructure === 'balloon' ? 'balloon' : 'fully-amortizing',
  ...(isValidNonnegativeMoney(input.principalCents)
    ? { principalCents: input.principalCents }
    : {}),
  ...(isValidRate(input.annualRateBasisPoints)
    ? { annualRateBasisPoints: input.annualRateBasisPoints }
    : {}),
  ...(isValidNonnegativeMoney(input.paymentCents) ? { paymentCents: input.paymentCents } : {}),
  ...(isValidNonnegativeMoney(input.cashPaymentCents)
    ? { cashPaymentCents: input.cashPaymentCents }
    : {}),
  ...(isValidDate(input.nextPaymentDate) ? { nextPaymentDate: input.nextPaymentDate } : {}),
  ...(isValidDate(input.maturityDate) ? { maturityDate: input.maturityDate } : {}),
  ...(isValidNonnegativeMoney(input.originalPrincipalCents)
    ? { originalPrincipalCents: input.originalPrincipalCents }
    : {}),
  ...(isValidDate(input.originalDate) ? { originalDate: input.originalDate } : {}),
  ...(isValidTerm(input.originalTermMonths)
    ? { originalTermMonths: input.originalTermMonths }
    : {}),
  ...(isValidNonnegativeMoney(input.expectedBalloonCents)
    ? { expectedBalloonCents: input.expectedBalloonCents }
    : {}),
});

const validateInput = (input: InstallmentLoanSetupInput): string[] => {
  const errors: string[] = [];
  const dateFields = [
    ['asOfDate', input.asOfDate],
    ['balanceDate', input.balanceDate],
    ['nextPaymentDate', input.nextPaymentDate],
    ['maturityDate', input.maturityDate],
    ['originalDate', input.originalDate],
  ] as const;
  for (const [field, value] of dateFields) {
    if (value !== undefined && !plainDateSchema.safeParse(value).success) {
      errors.push(`${field} must be an ISO financial date`);
    }
  }
  const moneyFields = [
    ['principalCents', input.principalCents],
    ['accruedInterestCents', input.accruedInterestCents],
    ['paymentCents', input.paymentCents],
    ['cashPaymentCents', input.cashPaymentCents],
    ['originalPrincipalCents', input.originalPrincipalCents],
    ['expectedBalloonCents', input.expectedBalloonCents],
  ] as const;
  for (const [field, value] of moneyFields) {
    if (value !== undefined && (!moneyCentsSchema.safeParse(value).success || value < 0)) {
      errors.push(`${field} must be a nonnegative safe integer number of cents`);
    }
  }
  if (
    input.annualRateBasisPoints !== undefined &&
    (!Number.isInteger(input.annualRateBasisPoints) ||
      input.annualRateBasisPoints < 0 ||
      input.annualRateBasisPoints > MAX_RATE_BASIS_POINTS)
  ) {
    errors.push('annualRateBasisPoints must be a whole number from 0 through 100000');
  }
  if (
    input.originalTermMonths !== undefined &&
    (!Number.isInteger(input.originalTermMonths) ||
      input.originalTermMonths < 1 ||
      input.originalTermMonths > MAX_TERM_MONTHS)
  ) {
    errors.push('originalTermMonths must be a whole number from 1 through 1200');
  }
  if (
    input.paymentFrequency !== undefined &&
    input.paymentFrequency !== 'monthly' &&
    input.paymentFrequency !== 'biweekly'
  ) {
    errors.push('paymentFrequency must be monthly or biweekly');
  }
  if (
    input.accrualConvention !== undefined &&
    !['actual-365', 'actual-360', 'monthly'].includes(input.accrualConvention)
  ) {
    errors.push('accrualConvention must be actual-365, actual-360, or monthly');
  }
  if (
    input.amortizationStructure !== undefined &&
    input.amortizationStructure !== 'fully-amortizing' &&
    input.amortizationStructure !== 'balloon'
  ) {
    errors.push('amortizationStructure must be fully-amortizing or balloon');
  }
  return errors;
};

const missingAlternatives = (
  resolved: ResolvedInstallmentLoanSetup,
): InstallmentLoanMissingAlternative[] => {
  const paths: Array<{
    label: string;
    requiredFields: InstallmentLoanSetupField[];
  }> = [
    {
      label: 'Enter a current loan snapshot',
      requiredFields: ['principalCents', 'annualRateBasisPoints', 'paymentCents'],
    },
    {
      label: 'Calculate the payment from original terms',
      requiredFields: [
        'originalPrincipalCents',
        'originalDate',
        'originalTermMonths',
        'annualRateBasisPoints',
      ],
    },
    {
      label: 'Calculate payoff and term from the original payment',
      requiredFields: [
        'originalPrincipalCents',
        'originalDate',
        'annualRateBasisPoints',
        'paymentCents',
      ],
    },
    {
      label: 'Calculate payment from current balance and maturity',
      requiredFields: ['principalCents', 'annualRateBasisPoints', 'maturityDate'],
    },
    {
      label: 'Calculate APR from current payment and maturity',
      requiredFields: ['principalCents', 'paymentCents', 'maturityDate'],
    },
    {
      label: 'Calculate a balloon-loan payment from its maturity residual',
      requiredFields: [
        'principalCents',
        'annualRateBasisPoints',
        'maturityDate',
        'expectedBalloonCents',
      ],
    },
  ];
  return paths
    .map((path) => ({
      ...path,
      missingFields: path.requiredFields.filter((field) => resolved[field] === undefined),
    }))
    .filter((path) => path.missingFields.length > 0)
    .sort(
      (left, right) =>
        left.missingFields.length - right.missingFields.length ||
        left.label.localeCompare(right.label),
    );
};

const solveInternal = (input: InstallmentLoanSetupInput): InstallmentLoanSetupResult => {
  const inputErrors = validateInput(input);
  const inferredFields: InstallmentLoanInferredField[] = [];
  const assumptions: string[] = [];
  const contradictions: string[] = [];
  const reconciliations: InstallmentLoanReconciliation[] = [];
  let iterations = 0;
  let approximate = false;
  let nonAmortizing = false;

  const resolved = normalizeResolvedInput(input);

  if (input.balanceDate === undefined) {
    uniquePush(inferredFields, 'balanceDate');
    assumptions.push('Balance date defaults to the effective financial date.');
    approximate = true;
  }
  if (input.accruedInterestCents === undefined) {
    uniquePush(inferredFields, 'accruedInterestCents');
    assumptions.push('Accrued interest defaults to zero unless an original schedule is projected.');
    approximate = true;
  }
  if (input.paymentFrequency === undefined) {
    uniquePush(inferredFields, 'paymentFrequency');
    assumptions.push('Payment frequency defaults to monthly.');
    approximate = true;
  }
  if (input.accrualConvention === undefined) {
    uniquePush(inferredFields, 'accrualConvention');
    assumptions.push('Interest accrual defaults to actual/365.');
    approximate = true;
  }

  const diagnosticResult = (
    status: InstallmentLoanSetupStatus,
    payoff: ExactInstallmentLoanPayoffSummary | null = null,
  ): InstallmentLoanSetupResult => ({
    status,
    resolved,
    inferredFields,
    assumptions,
    missingAlternatives: status === 'incomplete' ? missingAlternatives(resolved) : [],
    diagnostics: {
      iterations,
      nonAmortizing,
      inputErrors,
      contradictions,
      reconciliations,
    },
    payoff,
  });

  if (inputErrors.length > 0) return diagnosticResult('inconsistent');

  if (compareDates(resolved.balanceDate, resolved.asOfDate) > 0) {
    contradictions.push('The balance date cannot be after the effective financial date.');
  }
  if (
    resolved.originalDate !== undefined &&
    compareDates(resolved.originalDate, resolved.balanceDate) > 0
  ) {
    contradictions.push('The original date cannot be after the balance date.');
  }
  if (
    input.nextPaymentDate !== undefined &&
    compareDates(input.nextPaymentDate, resolved.balanceDate) <= 0
  ) {
    contradictions.push('The next payment date must be after the balance date.');
  }

  const firstOriginalPaymentDate = (): PlainDateString | undefined => {
    if (resolved.originalDate === undefined) return undefined;
    if (
      resolved.nextPaymentDate !== undefined &&
      compareDates(resolved.nextPaymentDate, resolved.originalDate) > 0
    ) {
      if (resolved.balanceDate === resolved.originalDate) return resolved.nextPaymentDate;
      return firstCadenceAfterFromFuturePayment({
        afterDate: resolved.originalDate,
        futurePaymentDate: resolved.nextPaymentDate,
        frequency: resolved.paymentFrequency,
        originalDate: resolved.originalDate,
        maturityDate: resolved.maturityDate,
      });
    }
    return cadenceDate(resolved.originalDate, 1, resolved.paymentFrequency);
  };

  const maturityForOriginalTerm = (termMonths: number): PlainDateString | undefined => {
    if (resolved.originalDate === undefined) return undefined;
    const firstPaymentDate = firstOriginalPaymentDate();
    return firstPaymentDate === undefined || resolved.paymentFrequency === 'biweekly'
      ? addMonthsConstrained(resolved.originalDate, termMonths)
      : cadenceDate(
          firstPaymentDate,
          termMonths - 1,
          resolved.paymentFrequency,
          monthlyPaymentDayFromExplicitFuture({
            futurePaymentDate: firstPaymentDate,
            originalDate: resolved.originalDate,
            maturityDate: resolved.maturityDate,
          }),
        );
  };

  const deriveMaturityAndTerm = (): void => {
    if (
      resolved.maturityDate === undefined &&
      resolved.originalDate !== undefined &&
      resolved.originalTermMonths !== undefined
    ) {
      resolved.maturityDate = maturityForOriginalTerm(resolved.originalTermMonths);
      uniquePush(inferredFields, 'maturityDate');
    }
    if (
      resolved.originalTermMonths === undefined &&
      resolved.originalDate !== undefined &&
      resolved.maturityDate !== undefined &&
      resolved.paymentFrequency === 'monthly'
    ) {
      const firstPaymentDate = firstOriginalPaymentDate();
      const months =
        firstPaymentDate === undefined
          ? calendarMonthsCeiling(resolved.originalDate, resolved.maturityDate)
          : wholeCalendarMonths(firstPaymentDate, resolved.maturityDate) + 1;
      if (months > 0 && months <= MAX_TERM_MONTHS) {
        resolved.originalTermMonths = months;
        uniquePush(inferredFields, 'originalTermMonths');
        const reconstructedMaturity =
          firstPaymentDate === undefined
            ? addMonthsConstrained(resolved.originalDate, months)
            : cadenceDate(
                firstPaymentDate,
                months - 1,
                resolved.paymentFrequency,
                monthlyPaymentDayFromExplicitFuture({
                  futurePaymentDate: firstPaymentDate,
                  originalDate: resolved.originalDate,
                  maturityDate: resolved.maturityDate,
                }),
              );
        if (compareDates(reconstructedMaturity, resolved.maturityDate) !== 0) {
          approximate = true;
          assumptions.push('Original term is rounded to the nearest complete payment cadence.');
        }
      }
    }
  };

  deriveMaturityAndTerm();

  const refreshNextPaymentDate = (): void => {
    if (input.nextPaymentDate !== undefined) return;
    const next =
      resolved.originalDate === undefined
        ? cadenceDate(resolved.balanceDate, 1, resolved.paymentFrequency)
        : nextCadenceDate(resolved.originalDate, resolved.balanceDate, resolved.paymentFrequency);
    if (resolved.nextPaymentDate !== next) resolved.nextPaymentDate = next;
    uniquePush(inferredFields, 'nextPaymentDate');
    approximate = true;
    if (!assumptions.some((item) => item.startsWith('Next payment date defaults'))) {
      assumptions.push(
        'Next payment date defaults to the next cadence after the available date anchor.',
      );
    }
  };

  refreshNextPaymentDate();

  const targetMaturityResidual = (): MoneyCents | null =>
    resolved.amortizationStructure === 'fully-amortizing'
      ? 0
      : (resolved.expectedBalloonCents ?? null);

  const originalPaymentByRate = new Map<number, MoneyCents | null>();
  const requiredOriginalPayment = (rate: number): MoneyCents | null => {
    if (originalPaymentByRate.has(rate)) return originalPaymentByRate.get(rate)!;
    if (
      resolved.originalPrincipalCents === undefined ||
      resolved.originalDate === undefined ||
      resolved.originalTermMonths === undefined ||
      targetMaturityResidual() === null
    ) {
      return null;
    }
    iterations += 1;
    const firstPaymentDate = firstOriginalPaymentDate();
    const maturityDate =
      resolved.maturityDate ??
      (resolved.paymentFrequency === 'monthly' && firstPaymentDate !== undefined
        ? cadenceDate(
            firstPaymentDate,
            resolved.originalTermMonths - 1,
            resolved.paymentFrequency,
            monthlyPaymentDayFromExplicitFuture({
              futurePaymentDate: firstPaymentDate,
              originalDate: resolved.originalDate,
            }),
          )
        : addMonthsConstrained(resolved.originalDate, resolved.originalTermMonths));
    const payment = calculateAnchoredPayment({
      principalCents: resolved.originalPrincipalCents,
      accruedInterestCents: 0,
      balanceDate: resolved.originalDate,
      annualRateBasisPoints: rate,
      maturityDate,
      ...(firstPaymentDate === undefined
        ? { cadenceAnchor: resolved.originalDate }
        : { firstPaymentDate, cadenceAnchor: resolved.originalDate }),
      frequency: resolved.paymentFrequency,
      accrualConvention: resolved.accrualConvention,
      targetResidualCents: targetMaturityResidual()!,
    });
    originalPaymentByRate.set(rate, payment);
    return payment;
  };

  const currentPaymentByRate = new Map<number, MoneyCents | null>();
  const requiredCurrentPayment = (rate: number): MoneyCents | null => {
    if (currentPaymentByRate.has(rate)) return currentPaymentByRate.get(rate)!;
    if (
      resolved.principalCents === undefined ||
      resolved.nextPaymentDate === undefined ||
      resolved.maturityDate === undefined ||
      compareDates(resolved.maturityDate, resolved.balanceDate) <= 0 ||
      targetMaturityResidual() === null
    ) {
      return null;
    }
    iterations += 1;
    const payment = calculateAnchoredPayment({
      principalCents: resolved.principalCents,
      accruedInterestCents: resolved.accruedInterestCents,
      balanceDate: resolved.balanceDate,
      annualRateBasisPoints: rate,
      maturityDate: resolved.maturityDate,
      ...(input.nextPaymentDate === undefined
        ? { cadenceAnchor: resolved.originalDate ?? resolved.balanceDate }
        : {
            firstPaymentDate: resolved.nextPaymentDate,
            ...(resolved.originalDate === undefined
              ? {}
              : { cadenceAnchor: resolved.originalDate }),
          }),
      frequency: resolved.paymentFrequency,
      accrualConvention: resolved.accrualConvention,
      targetResidualCents: targetMaturityResidual()!,
    });
    currentPaymentByRate.set(rate, payment);
    return payment;
  };

  const historicalPrincipalByPayment = new Map<MoneyCents, MoneyCents>();
  const historicalPrincipalAtPayment = (paymentCents: MoneyCents): MoneyCents | null => {
    if (
      input.principalCents === undefined ||
      resolved.originalPrincipalCents === undefined ||
      resolved.originalDate === undefined ||
      resolved.annualRateBasisPoints === undefined ||
      resolved.nextPaymentDate === undefined ||
      compareDates(resolved.originalDate, resolved.balanceDate) >= 0
    ) {
      return null;
    }
    const cached = historicalPrincipalByPayment.get(paymentCents);
    if (cached !== undefined) return cached;
    iterations += 1;
    const principalCents = projectAnchoredBalanceAtDate({
      originalPrincipalCents: resolved.originalPrincipalCents,
      originalDate: resolved.originalDate,
      balanceDate: resolved.balanceDate,
      annualRateBasisPoints: resolved.annualRateBasisPoints,
      paymentCents,
      maturityDate: resolved.maturityDate,
      futurePaymentDate: resolved.nextPaymentDate,
      frequency: resolved.paymentFrequency,
      accrualConvention: resolved.accrualConvention,
    }).principalCents;
    historicalPrincipalByPayment.set(paymentCents, principalCents);
    return principalCents;
  };

  const requiredHistoricalPayment = (): {
    paymentCents: MoneyCents;
    residualCents: number;
    exact: boolean;
    unique: boolean;
  } | null => {
    if (
      input.principalCents === undefined ||
      resolved.originalPrincipalCents === undefined ||
      input.principalCents <= 0 ||
      input.principalCents >= resolved.originalPrincipalCents
    ) {
      return null;
    }
    const targetPrincipalCents = input.principalCents;
    const atZero = historicalPrincipalAtPayment(0);
    if (atZero === null || atZero <= targetPrincipalCents) return null;

    let low = 0;
    let high = Math.min(MAX_REVERSE_PRINCIPAL_CENTS, Math.max(1, resolved.originalPrincipalCents));
    let projectedHigh = historicalPrincipalAtPayment(high);
    while (
      projectedHigh !== null &&
      projectedHigh > targetPrincipalCents &&
      high < MAX_REVERSE_PRINCIPAL_CENTS
    ) {
      high = Math.min(MAX_REVERSE_PRINCIPAL_CENTS, high * 2);
      projectedHigh = historicalPrincipalAtPayment(high);
    }
    if (projectedHigh === null || projectedHigh > targetPrincipalCents) return null;

    while (low < high) {
      const midpoint = Math.floor((low + high) / 2);
      const projected = historicalPrincipalAtPayment(midpoint);
      if (projected === null) return null;
      if (projected > targetPrincipalCents) low = midpoint + 1;
      else high = midpoint;
    }
    const candidates = [low, Math.max(0, low - 1), Math.min(MAX_REVERSE_PRINCIPAL_CENTS, low + 1)];
    const priced = [...new Set(candidates)].map((paymentCents) => ({
      paymentCents: moneyCentsSchema.nonnegative().parse(paymentCents),
      residualCents: historicalPrincipalAtPayment(paymentCents)! - targetPrincipalCents,
    }));
    priced.sort(
      (left, right) =>
        Math.abs(left.residualCents) - Math.abs(right.residualCents) ||
        left.paymentCents - right.paymentCents,
    );
    const best = priced[0]!;
    const tolerance = Math.max(1, Math.round(targetPrincipalCents * 0.0001));
    if (Math.abs(best.residualCents) > tolerance) return null;
    const exact = best.residualCents === 0;
    const adjacentPayments = [best.paymentCents - 1, best.paymentCents + 1].filter(
      (paymentCents) => paymentCents >= 0 && paymentCents <= MAX_REVERSE_PRINCIPAL_CENTS,
    );
    return {
      ...best,
      exact,
      unique:
        !exact ||
        adjacentPayments.every(
          (paymentCents) => historicalPrincipalAtPayment(paymentCents) !== targetPrincipalCents,
        ),
    };
  };

  const historicalPrincipalByRate = new Map<number, MoneyCents>();
  const historicalPrincipalAtRate = (rate: number): MoneyCents | null => {
    if (
      input.principalCents === undefined ||
      resolved.originalPrincipalCents === undefined ||
      resolved.originalDate === undefined ||
      resolved.paymentCents === undefined ||
      resolved.nextPaymentDate === undefined ||
      compareDates(resolved.originalDate, resolved.balanceDate) >= 0
    ) {
      return null;
    }
    const cached = historicalPrincipalByRate.get(rate);
    if (cached !== undefined) return cached;
    iterations += 1;
    const principalCents = projectAnchoredBalanceAtDate({
      originalPrincipalCents: resolved.originalPrincipalCents,
      originalDate: resolved.originalDate,
      balanceDate: resolved.balanceDate,
      annualRateBasisPoints: rate,
      paymentCents: resolved.paymentCents,
      maturityDate: resolved.maturityDate,
      futurePaymentDate: resolved.nextPaymentDate,
      frequency: resolved.paymentFrequency,
      accrualConvention: resolved.accrualConvention,
    }).principalCents;
    historicalPrincipalByRate.set(rate, principalCents);
    return principalCents;
  };

  const inferHistoricalRate = (): {
    rate: number;
    residualCents: number;
    exact: boolean;
    unique: boolean;
  } | null => {
    if (
      input.principalCents === undefined ||
      resolved.originalPrincipalCents === undefined ||
      input.principalCents <= 0 ||
      input.principalCents > resolved.originalPrincipalCents
    ) {
      return null;
    }
    const targetPrincipalCents = input.principalCents;
    const atZero = historicalPrincipalAtRate(0);
    const atMaximum = historicalPrincipalAtRate(MAX_RATE_BASIS_POINTS);
    if (
      atZero === null ||
      atMaximum === null ||
      targetPrincipalCents < atZero ||
      targetPrincipalCents > atMaximum ||
      (atZero === targetPrincipalCents && atMaximum === targetPrincipalCents)
    ) {
      return null;
    }
    let low = 0;
    let high = MAX_RATE_BASIS_POINTS;
    while (low < high) {
      const midpoint = Math.floor((low + high) / 2);
      const projected = historicalPrincipalAtRate(midpoint);
      if (projected === null) return null;
      if (projected < targetPrincipalCents) low = midpoint + 1;
      else high = midpoint;
    }
    const candidates = [low, Math.max(0, low - 1), Math.min(MAX_RATE_BASIS_POINTS, low + 1)];
    const priced = [...new Set(candidates)].map((rate) => ({
      rate,
      residualCents: historicalPrincipalAtRate(rate)! - targetPrincipalCents,
    }));
    priced.sort(
      (left, right) =>
        Math.abs(left.residualCents) - Math.abs(right.residualCents) || left.rate - right.rate,
    );
    const best = priced[0]!;
    const tolerance = Math.max(1, Math.round(targetPrincipalCents * 0.0001));
    if (Math.abs(best.residualCents) > tolerance) return null;
    const exact = best.residualCents === 0;
    const adjacentRates = [best.rate - 1, best.rate + 1].filter(
      (rate) => rate >= 0 && rate <= MAX_RATE_BASIS_POINTS,
    );
    return {
      ...best,
      exact,
      unique:
        !exact ||
        adjacentRates.every((rate) => historicalPrincipalAtRate(rate) !== targetPrincipalCents),
    };
  };

  const inferRate = (
    paymentAtRate: (rate: number) => MoneyCents | null,
    targetPaymentCents: MoneyCents,
  ): { rate: number; residualCents: number; exact: boolean; unique: boolean } | null => {
    const atZero = paymentAtRate(0);
    const atMaximum = paymentAtRate(MAX_RATE_BASIS_POINTS);
    if (atZero === null || atMaximum === null) return null;
    if (targetPaymentCents < atZero || targetPaymentCents > atMaximum) return null;
    let low = 0;
    let high = MAX_RATE_BASIS_POINTS;
    while (low < high) {
      const midpoint = Math.floor((low + high) / 2);
      const payment = paymentAtRate(midpoint);
      if (payment === null) return null;
      if (payment < targetPaymentCents) low = midpoint + 1;
      else high = midpoint;
    }
    const candidates = [low, Math.max(0, low - 1), Math.min(MAX_RATE_BASIS_POINTS, low + 1)];
    const priced = candidates.map((rate) => {
      const payment = paymentAtRate(rate)!;
      return { rate, residualCents: payment - targetPaymentCents };
    });
    priced.sort(
      (left, right) =>
        Math.abs(left.residualCents) - Math.abs(right.residualCents) || left.rate - right.rate,
    );
    const best = priced[0]!;
    const exact = best.residualCents === 0;
    const adjacentRates = [best.rate - 1, best.rate + 1].filter(
      (rate) => rate >= 0 && rate <= MAX_RATE_BASIS_POINTS,
    );
    return {
      ...best,
      exact,
      unique: !exact || adjacentRates.every((rate) => paymentAtRate(rate) !== targetPaymentCents),
    };
  };

  const inferOriginalDate = (): void => {
    if (
      resolved.originalDate !== undefined ||
      resolved.originalPrincipalCents === undefined ||
      resolved.principalCents === undefined ||
      resolved.annualRateBasisPoints === undefined ||
      resolved.paymentCents === undefined
    ) {
      return;
    }
    if (resolved.principalCents > resolved.originalPrincipalCents) {
      contradictions.push(
        'Current principal cannot exceed original principal on an amortizing loan.',
      );
      return;
    }
    const maxPeriods =
      resolved.paymentFrequency === 'monthly'
        ? MAX_TERM_MONTHS
        : Math.ceil((MAX_TERM_MONTHS * 365.2425) / 12 / 14);
    const inferredOriginalDateAtPeriods = (periods: number): PlainDateString => {
      if (resolved.nextPaymentDate === undefined) {
        return priorCadenceDate(resolved.balanceDate, periods, resolved.paymentFrequency);
      }
      const monthlyPaymentDay =
        resolved.paymentFrequency === 'monthly'
          ? monthlyPaymentDayFromExplicitFuture({
              futurePaymentDate: resolved.nextPaymentDate,
              maturityDate: resolved.maturityDate,
            })
          : undefined;
      let boundaryPeriod = -1;
      let boundary = cadenceDate(
        resolved.nextPaymentDate,
        boundaryPeriod,
        resolved.paymentFrequency,
        monthlyPaymentDay,
      );
      while (compareDates(boundary, resolved.balanceDate) > 0) {
        boundaryPeriod -= 1;
        boundary = cadenceDate(
          resolved.nextPaymentDate,
          boundaryPeriod,
          resolved.paymentFrequency,
          monthlyPaymentDay,
        );
      }
      return cadenceDate(boundary, -periods, resolved.paymentFrequency, monthlyPaymentDay);
    };
    const projectedPrincipal = (periods: number): MoneyCents => {
      iterations += 1;
      const originalDate = inferredOriginalDateAtPeriods(periods);
      return projectAnchoredBalanceAtDate({
        originalPrincipalCents: resolved.originalPrincipalCents!,
        originalDate,
        balanceDate: resolved.balanceDate,
        annualRateBasisPoints: resolved.annualRateBasisPoints!,
        paymentCents: resolved.paymentCents!,
        futurePaymentDate: resolved.nextPaymentDate,
        frequency: resolved.paymentFrequency,
        accrualConvention: resolved.accrualConvention,
      }).principalCents;
    };
    const afterFirstPeriod = projectedPrincipal(1);
    if (
      resolved.originalPrincipalCents > 0 &&
      afterFirstPeriod >= resolved.originalPrincipalCents
    ) {
      contradictions.push('The stated payment does not amortize the original principal.');
      nonAmortizing = true;
      return;
    }
    if (resolved.principalCents === resolved.originalPrincipalCents) {
      resolved.originalDate = resolved.balanceDate;
      uniquePush(inferredFields, 'originalDate');
      approximate = true;
      assumptions.push('Original date is inferred at a whole payment-cadence boundary.');
      reconciliations.push({
        check: 'original-date',
        outcome: 'matched',
        residualCents: 0,
        message: 'The unchanged principal identifies the balance date as the original date.',
      });
      return;
    }
    let low = 0;
    let high = maxPeriods;
    if (projectedPrincipal(high) > resolved.principalCents) {
      contradictions.push('No original date within 100 years reconciles the stated balances.');
      return;
    }
    while (low < high) {
      const midpoint = Math.floor((low + high) / 2);
      if (projectedPrincipal(midpoint) > resolved.principalCents) low = midpoint + 1;
      else high = midpoint;
    }
    const candidates = new Set<number>();
    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = low + offset;
      if (candidate >= 0 && candidate <= maxPeriods) candidates.add(candidate);
    }
    const matches = [...candidates].map((periods) => ({
      periods,
      residualCents: projectedPrincipal(periods) - resolved.principalCents!,
    }));
    matches.sort(
      (left, right) =>
        Math.abs(left.residualCents) - Math.abs(right.residualCents) ||
        left.periods - right.periods,
    );
    const match = matches[0]!;
    const tolerance = Math.max(100, resolved.paymentCents);
    if (Math.abs(match.residualCents) > tolerance) {
      contradictions.push('Original balance, current balance, rate, and payment do not reconcile.');
      reconciliations.push({
        check: 'original-date',
        outcome: 'conflict',
        residualCents: match.residualCents,
        message: 'Nearest whole-cadence original date misses the current principal materially.',
      });
      return;
    }
    resolved.originalDate = inferredOriginalDateAtPeriods(match.periods);
    uniquePush(inferredFields, 'originalDate');
    approximate = true;
    assumptions.push('Original date is inferred at a whole payment-cadence boundary.');
    reconciliations.push({
      check: 'original-date',
      outcome: match.residualCents === 0 ? 'matched' : 'approximate',
      residualCents: match.residualCents,
      message:
        match.residualCents === 0
          ? 'A whole-cadence original date exactly reproduces current principal.'
          : 'The nearest whole-cadence original date approximately reproduces current principal.',
    });
  };

  const inferOriginalPrincipal = (): void => {
    if (
      resolved.originalPrincipalCents !== undefined ||
      resolved.originalDate === undefined ||
      resolved.principalCents === undefined ||
      resolved.principalCents === 0 ||
      resolved.annualRateBasisPoints === undefined ||
      resolved.paymentCents === undefined ||
      compareDates(resolved.originalDate, resolved.balanceDate) > 0
    ) {
      return;
    }
    if (resolved.originalDate === resolved.balanceDate) {
      resolved.originalPrincipalCents = resolved.principalCents;
      uniquePush(inferredFields, 'originalPrincipalCents');
      reconciliations.push({
        check: 'original-principal',
        outcome: 'matched',
        residualCents: 0,
        message: 'The balance-date snapshot uniquely identifies original principal.',
      });
      return;
    }
    const projectedPrincipal = (originalPrincipalCents: MoneyCents): MoneyCents => {
      iterations += 1;
      return projectAnchoredBalanceAtDate({
        originalPrincipalCents,
        originalDate: resolved.originalDate!,
        balanceDate: resolved.balanceDate,
        annualRateBasisPoints: resolved.annualRateBasisPoints!,
        paymentCents: resolved.paymentCents!,
        futurePaymentDate: resolved.nextPaymentDate,
        frequency: resolved.paymentFrequency,
        accrualConvention: resolved.accrualConvention,
      }).principalCents;
    };
    let low = resolved.principalCents;
    let high = Math.max(1, resolved.principalCents);
    while (
      high < MAX_REVERSE_PRINCIPAL_CENTS &&
      projectedPrincipal(high) < resolved.principalCents
    ) {
      high = Math.min(MAX_REVERSE_PRINCIPAL_CENTS, high * 2);
    }
    if (projectedPrincipal(high) < resolved.principalCents) return;
    while (low < high) {
      const midpoint = Math.floor((low + high) / 2);
      if (projectedPrincipal(midpoint) < resolved.principalCents) low = midpoint + 1;
      else high = midpoint;
    }
    const candidate = low;
    const residualCents = projectedPrincipal(candidate) - resolved.principalCents;
    const lowerAlsoMatches =
      candidate > 0 && projectedPrincipal(candidate - 1) === resolved.principalCents;
    const upperAlsoMatches =
      candidate < MAX_REVERSE_PRINCIPAL_CENTS &&
      projectedPrincipal(candidate + 1) === resolved.principalCents;
    if (residualCents !== 0 || lowerAlsoMatches || upperAlsoMatches) {
      if (Math.abs(residualCents) <= 1 && !lowerAlsoMatches && !upperAlsoMatches) {
        resolved.originalPrincipalCents = candidate;
        uniquePush(inferredFields, 'originalPrincipalCents');
        approximate = true;
        assumptions.push('Original principal is reverse-solved to the nearest cent.');
        reconciliations.push({
          check: 'original-principal',
          outcome: 'approximate',
          residualCents,
          message: 'Reverse-solved original principal is within one cent of current principal.',
        });
      }
      return;
    }
    resolved.originalPrincipalCents = candidate;
    uniquePush(inferredFields, 'originalPrincipalCents');
    reconciliations.push({
      check: 'original-principal',
      outcome: 'matched',
      residualCents: 0,
      message: 'A unique original principal reproduces current principal exactly.',
    });
  };

  for (let pass = 0; pass < 4; pass += 1) {
    deriveMaturityAndTerm();
    refreshNextPaymentDate();

    if (resolved.paymentCents === undefined && resolved.annualRateBasisPoints !== undefined) {
      const structuralPayment =
        requiredOriginalPayment(resolved.annualRateBasisPoints) ??
        requiredCurrentPayment(resolved.annualRateBasisPoints);
      const historicalPayment = structuralPayment === null ? requiredHistoricalPayment() : null;
      const payment = structuralPayment ?? historicalPayment?.paymentCents ?? null;
      if (payment !== null) {
        resolved.paymentCents = payment;
        uniquePush(inferredFields, 'paymentCents');
        if (historicalPayment && (!historicalPayment.exact || !historicalPayment.unique)) {
          approximate = true;
          assumptions.push(
            historicalPayment.exact
              ? 'The two dated balances identify a range of cent-level payments; the lowest match is used.'
              : 'Debt payment is the nearest cent-level amount that reconciles the two dated balances.',
          );
        }
      }
    }

    if (resolved.annualRateBasisPoints === undefined && resolved.paymentCents !== undefined) {
      const originalRate = inferRate(requiredOriginalPayment, resolved.paymentCents);
      const currentRate =
        originalRate ??
        inferRate(requiredCurrentPayment, resolved.paymentCents) ??
        inferHistoricalRate();
      if (currentRate !== null) {
        resolved.annualRateBasisPoints = currentRate.rate;
        uniquePush(inferredFields, 'annualRateBasisPoints');
        if (!currentRate.exact || !currentRate.unique) {
          approximate = true;
          assumptions.push(
            currentRate.exact
              ? 'The payment identifies a range of whole-basis-point APRs; the lowest match is used.'
              : 'APR is rounded to the nearest whole basis point.',
          );
        }
      }
    }

    inferOriginalDate();
    refreshNextPaymentDate();
    inferOriginalPrincipal();

    if (
      resolved.principalCents === undefined &&
      resolved.originalPrincipalCents !== undefined &&
      resolved.originalDate !== undefined &&
      resolved.annualRateBasisPoints !== undefined &&
      resolved.paymentCents !== undefined
    ) {
      iterations += 1;
      const projection = projectAnchoredBalanceAtDate({
        originalPrincipalCents: resolved.originalPrincipalCents,
        originalDate: resolved.originalDate,
        balanceDate: resolved.balanceDate,
        annualRateBasisPoints: resolved.annualRateBasisPoints,
        paymentCents: resolved.paymentCents,
        maturityDate: resolved.maturityDate,
        futurePaymentDate: resolved.nextPaymentDate,
        frequency: resolved.paymentFrequency,
        accrualConvention: resolved.accrualConvention,
      });
      resolved.principalCents = projection.principalCents;
      uniquePush(inferredFields, 'principalCents');
      if (input.accruedInterestCents === undefined) {
        resolved.accruedInterestCents = projection.accruedInterestCents;
      }
    }
  }

  deriveMaturityAndTerm();
  refreshNextPaymentDate();

  if (
    resolved.amortizationStructure === 'fully-amortizing' &&
    input.expectedBalloonCents !== undefined
  ) {
    uniquePush(contradictions, 'A fully amortizing loan cannot have a contractual balloon amount.');
  }
  if (resolved.amortizationStructure === 'balloon' && resolved.maturityDate === undefined) {
    uniquePush(contradictions, 'A balloon loan requires a maturity date or original term.');
  }

  if (
    resolved.nextPaymentDate !== undefined &&
    resolved.maturityDate !== undefined &&
    (resolved.principalCents ?? resolved.originalPrincipalCents ?? 0) +
      resolved.accruedInterestCents >
      0 &&
    compareDates(resolved.nextPaymentDate, resolved.maturityDate) > 0
  ) {
    uniquePush(contradictions, 'The next payment date cannot be after the maturity date.');
  }

  if (
    resolved.annualRateBasisPoints === undefined &&
    resolved.paymentCents !== undefined &&
    ((resolved.originalPrincipalCents !== undefined &&
      resolved.originalDate !== undefined &&
      resolved.originalTermMonths !== undefined) ||
      (resolved.principalCents !== undefined && resolved.maturityDate !== undefined))
  ) {
    contradictions.push(
      'The stated payment implies no APR within the supported nonnegative range.',
    );
  }

  if (
    resolved.originalDate !== undefined &&
    resolved.originalTermMonths !== undefined &&
    input.maturityDate !== undefined
  ) {
    const expectedMaturity = maturityForOriginalTerm(resolved.originalTermMonths);
    if (expectedMaturity === undefined) {
      throw new Error('Original maturity cannot be derived without an original date');
    }
    const residualDays = daysBetween(expectedMaturity, input.maturityDate);
    if (residualDays !== 0) {
      contradictions.push('Original date, term, and maturity date disagree.');
      reconciliations.push({
        check: 'original-maturity',
        outcome: 'conflict',
        residualDays,
        message: 'Entered maturity differs from the original term on the payment cadence.',
      });
    } else {
      reconciliations.push({
        check: 'original-maturity',
        outcome: 'matched',
        residualDays: 0,
        message: 'Original term and payment cadence reproduce the entered maturity date.',
      });
    }
  }

  if (
    resolved.amortizationStructure === 'fully-amortizing' &&
    input.paymentCents !== undefined &&
    resolved.annualRateBasisPoints !== undefined &&
    resolved.originalPrincipalCents !== undefined &&
    resolved.originalDate !== undefined &&
    resolved.originalTermMonths !== undefined
  ) {
    const modeledPayment = requiredOriginalPayment(resolved.annualRateBasisPoints);
    if (modeledPayment !== null) {
      const residualCents = input.paymentCents - modeledPayment;
      const outcome =
        Math.abs(residualCents) <= 1
          ? 'matched'
          : input.annualRateBasisPoints === undefined
            ? 'approximate'
            : 'conflict';
      reconciliations.push({
        check: 'original-payment',
        outcome,
        residualCents,
        message:
          outcome === 'matched'
            ? 'Entered debt payment amortizes the original terms.'
            : outcome === 'approximate'
              ? 'Nearest whole-basis-point APR approximately reproduces the entered payment.'
              : 'Entered debt payment does not amortize the original terms by maturity.',
      });
      if (outcome === 'approximate') approximate = true;
      if (outcome === 'conflict') {
        contradictions.push('Original amount, date, term, APR, and payment do not reconcile.');
      }
    }
  }

  if (
    resolved.amortizationStructure === 'fully-amortizing' &&
    input.principalCents !== undefined &&
    resolved.originalPrincipalCents !== undefined &&
    resolved.originalDate !== undefined &&
    resolved.annualRateBasisPoints !== undefined &&
    resolved.paymentCents !== undefined
  ) {
    iterations += 1;
    const projected = projectAnchoredBalanceAtDate({
      originalPrincipalCents: resolved.originalPrincipalCents,
      originalDate: resolved.originalDate,
      balanceDate: resolved.balanceDate,
      annualRateBasisPoints: resolved.annualRateBasisPoints,
      paymentCents: resolved.paymentCents,
      maturityDate: resolved.maturityDate,
      futurePaymentDate: resolved.nextPaymentDate,
      frequency: resolved.paymentFrequency,
      accrualConvention: resolved.accrualConvention,
    });
    const residualCents = input.principalCents - projected.principalCents;
    const inferredOriginToleranceCents =
      input.originalDate === undefined && inferredFields.includes('originalDate')
        ? resolved.paymentCents
        : undefined;
    const tolerance = Math.max(
      1,
      Math.round(input.principalCents * 0.0001),
      inferredOriginToleranceCents ?? 0,
    );
    const outcome =
      residualCents === 0
        ? 'matched'
        : Math.abs(residualCents) <= tolerance
          ? 'approximate'
          : 'conflict';
    reconciliations.push({
      check: 'current-balance',
      outcome,
      residualCents,
      message:
        outcome === 'matched'
          ? 'Original schedule reproduces current principal.'
          : outcome === 'approximate'
            ? 'Original schedule is within the rounding tolerance of current principal.'
            : 'Original schedule does not reproduce current principal.',
    });
    if (outcome === 'approximate') approximate = true;
    if (outcome === 'conflict') {
      contradictions.push('Original terms and current principal do not reconcile.');
    }
    if (input.accruedInterestCents !== undefined) {
      const accruedResidualCents = input.accruedInterestCents - projected.accruedInterestCents;
      const accruedToleranceCents = Math.max(1, inferredOriginToleranceCents ?? 0);
      const accruedOutcome =
        accruedResidualCents === 0
          ? 'matched'
          : Math.abs(accruedResidualCents) <= accruedToleranceCents
            ? 'approximate'
            : 'conflict';
      reconciliations.push({
        check: 'current-accrued-interest',
        outcome: accruedOutcome,
        residualCents: accruedResidualCents,
        message:
          accruedOutcome === 'matched'
            ? 'Original schedule reproduces current accrued interest.'
            : accruedOutcome === 'approximate'
              ? input.originalDate === undefined
                ? 'The nearest whole-cadence inferred original date approximately reproduces current accrued interest.'
                : 'Original schedule is within one cent of current accrued interest.'
              : 'Original schedule does not reproduce current accrued interest.',
      });
      if (accruedOutcome === 'approximate') approximate = true;
      if (accruedOutcome === 'conflict') {
        contradictions.push('Original terms and current accrued interest do not reconcile.');
      }
    }
  }

  if (
    input.principalCents !== undefined &&
    input.paymentCents !== undefined &&
    input.annualRateBasisPoints !== undefined &&
    input.maturityDate !== undefined
  ) {
    const modeledPayment = requiredCurrentPayment(input.annualRateBasisPoints);
    if (modeledPayment !== null) {
      const residualCents = input.paymentCents - modeledPayment;
      const outcome = Math.abs(residualCents) <= 1 ? 'matched' : 'conflict';
      reconciliations.push({
        check: 'current-payment',
        outcome,
        residualCents,
        message:
          outcome === 'matched'
            ? 'Entered debt payment amortizes the current balance by maturity.'
            : 'Entered debt payment does not amortize the current balance by maturity.',
      });
      if (outcome === 'conflict') {
        contradictions.push('Current balance, maturity, APR, and payment do not reconcile.');
      }
    }
  }

  if (
    resolved.principalCents !== undefined &&
    resolved.principalCents > 0 &&
    resolved.maturityDate !== undefined &&
    compareDates(resolved.maturityDate, resolved.balanceDate) <= 0
  ) {
    contradictions.push(
      'A positive current balance cannot have a maturity on or before its balance date.',
    );
  }
  if (
    resolved.cashPaymentCents !== undefined &&
    resolved.paymentCents !== undefined &&
    resolved.cashPaymentCents < resolved.paymentCents
  ) {
    contradictions.push('Total cash payment cannot be less than contractual debt service.');
  }

  if (contradictions.length > 0) return diagnosticResult('inconsistent');

  if (resolved.principalCents === 0 && resolved.accruedInterestCents === 0) {
    const payoff: ExactInstallmentLoanPayoffSummary = {
      exact: true,
      payoffDate: resolved.balanceDate,
      payoffPeriods: 0,
      payoffMonths: 0,
      totalRemainingPaymentsCents: 0,
      remainingInterestCents: 0,
      finalPaymentCents: 0,
      balloonCents: 0,
    };
    return diagnosticResult(approximate ? 'approximate' : 'exact', payoff);
  }

  if (
    resolved.principalCents === undefined ||
    resolved.annualRateBasisPoints === undefined ||
    resolved.paymentCents === undefined ||
    resolved.nextPaymentDate === undefined
  ) {
    return diagnosticResult('incomplete');
  }

  const horizon = resolved.maturityDate ?? addMonthsConstrained(resolved.balanceDate, 1_200);
  iterations += 1;
  const scheduledPayments: SolverPayment[] =
    input.nextPaymentDate === undefined
      ? simulateSolverSchedule({
          principalCents: resolved.principalCents,
          accruedInterestCents: resolved.accruedInterestCents,
          balanceDate: resolved.balanceDate,
          annualRateBasisPoints: resolved.annualRateBasisPoints,
          paymentCents: resolved.paymentCents,
          dates: cadenceDatesThrough({
            cadenceAnchor: resolved.originalDate ?? resolved.balanceDate,
            endDate: horizon,
            frequency: resolved.paymentFrequency,
            maturityDate: resolved.maturityDate,
          }),
          endDate: horizon,
          maturityDate: resolved.maturityDate,
          payBalloonAtMaturity: true,
          accrualConvention: resolved.accrualConvention,
        }).payments
      : projectLoanPayoffAtDate(
          makeLoan({
            principalCents: resolved.principalCents,
            accruedInterestCents: resolved.accruedInterestCents,
            balanceDate: resolved.balanceDate,
            annualRateBasisPoints: resolved.annualRateBasisPoints,
            paymentCents: resolved.paymentCents,
            cashPaymentCents: resolved.cashPaymentCents,
            nextPaymentDate: resolved.nextPaymentDate,
            maturityDate: resolved.maturityDate,
            originalPrincipalCents: resolved.originalPrincipalCents,
            originalDate: resolved.originalDate,
            originalTermMonths: resolved.originalTermMonths,
            amortizationStructure: resolved.amortizationStructure,
            expectedBalloonCents: resolved.expectedBalloonCents,
            paymentFrequency: resolved.paymentFrequency,
            accrualConvention: resolved.accrualConvention,
          }),
          addDays(horizon, 1),
        ).scheduledPayments;
  const payoffPayment = scheduledPayments.find(
    (payment) =>
      payment.remainingPrincipalCents === 0 && payment.remainingAccruedInterestCents === 0,
  );
  if (payoffPayment === undefined) {
    nonAmortizing = true;
    contradictions.push('The stated debt payment does not amortize this installment loan.');
    return diagnosticResult('inconsistent');
  }

  const paymentsThroughPayoff = scheduledPayments.slice(
    0,
    scheduledPayments.indexOf(payoffPayment) + 1,
  );
  const totalRemainingPaymentsCents = moneyCentsSchema.parse(
    paymentsThroughPayoff.reduce((sum, payment) => sum + payment.appliedPaymentCents, 0),
  );
  const openingDebtCents = moneyCentsSchema.parse(
    resolved.principalCents + resolved.accruedInterestCents,
  );
  const payoff: ExactInstallmentLoanPayoffSummary = {
    exact: true,
    payoffDate: payoffPayment.date,
    payoffPeriods: paymentsThroughPayoff.length,
    payoffMonths: calendarMonthsCeiling(resolved.balanceDate, payoffPayment.date),
    totalRemainingPaymentsCents,
    remainingInterestCents: moneyCentsSchema.parse(
      Math.max(0, totalRemainingPaymentsCents - openingDebtCents),
    ),
    finalPaymentCents: payoffPayment.appliedPaymentCents,
    balloonCents: moneyCentsSchema.parse(
      Math.max(0, payoffPayment.appliedPaymentCents - resolved.paymentCents),
    ),
  };

  if (resolved.amortizationStructure === 'balloon') {
    if (payoff.balloonCents <= 0) {
      contradictions.push(
        'The stated balloon structure does not leave a positive maturity balloon.',
      );
      reconciliations.push({
        check: 'balloon',
        outcome: 'conflict',
        residualCents: payoff.balloonCents,
        message: 'The modeled schedule pays off without a maturity balloon.',
      });
      return diagnosticResult('inconsistent');
    }
    if (input.expectedBalloonCents === undefined) {
      resolved.expectedBalloonCents = payoff.balloonCents;
      uniquePush(inferredFields, 'expectedBalloonCents');
      reconciliations.push({
        check: 'balloon',
        outcome: 'matched',
        residualCents: 0,
        message: 'The contractual payment and maturity determine the balloon amount.',
      });
    } else {
      const residualCents = payoff.balloonCents - input.expectedBalloonCents;
      const outcome = residualCents === 0 ? 'matched' : 'conflict';
      reconciliations.push({
        check: 'balloon',
        outcome,
        residualCents,
        message:
          outcome === 'matched'
            ? 'The modeled maturity balloon matches the entered contractual amount.'
            : 'The modeled maturity balloon does not match the entered contractual amount.',
      });
      if (outcome === 'conflict') {
        contradictions.push('Payment, rate, maturity, and contractual balloon do not reconcile.');
        return diagnosticResult('inconsistent');
      }
    }
  }

  if (
    resolved.originalDate !== undefined &&
    input.originalTermMonths === undefined &&
    input.maturityDate === undefined
  ) {
    const firstPaymentDate = firstOriginalPaymentDate();
    resolved.maturityDate = payoff.payoffDate;
    uniquePush(inferredFields, 'maturityDate');
    if (resolved.paymentFrequency === 'monthly') {
      const originalPaymentDates = cadenceDatesThrough({
        ...(firstPaymentDate === undefined
          ? { cadenceAnchor: resolved.originalDate }
          : { firstPaymentDate, cadenceAnchor: resolved.originalDate }),
        endDate: payoff.payoffDate,
        frequency: 'monthly',
        maturityDate: payoff.payoffDate,
      });
      if (originalPaymentDates.length > 0 && originalPaymentDates.length <= MAX_TERM_MONTHS) {
        resolved.originalTermMonths = originalPaymentDates.length;
        uniquePush(inferredFields, 'originalTermMonths');
      } else {
        approximate = true;
        uniquePush(
          assumptions,
          'Exact payoff is preserved, but the original monthly term exceeds the supported term range.',
        );
      }
    } else {
      approximate = true;
      uniquePush(
        assumptions,
        `Biweekly payoff is exact after ${payoff.payoffPeriods} remaining payments; ${payoff.payoffMonths} calendar months is an approximate display conversion, so original term months is left blank.`,
      );
    }
  }

  return diagnosticResult(approximate ? 'approximate' : 'exact', payoff);
};

/**
 * Resolves an installment-loan setup from any supported partial fact set. The solver is total:
 * malformed, contradictory, and underdetermined inputs are represented in the result instead of
 * escaping as exceptions or non-finite numbers.
 */
export const solveInstallmentLoanSetup = (
  input: InstallmentLoanSetupInput,
): InstallmentLoanSetupResult => {
  try {
    return solveInternal(input);
  } catch (error) {
    const resolved = normalizeResolvedInput(input);
    return {
      status: 'inconsistent',
      resolved,
      inferredFields: [],
      assumptions: [],
      missingAlternatives: [],
      diagnostics: {
        iterations: 0,
        nonAmortizing: false,
        inputErrors: [
          error instanceof Error ? error.message : 'Loan setup could not be evaluated safely.',
        ],
        contradictions: [],
        reconciliations: [],
      },
      payoff: null,
    };
  }
};
