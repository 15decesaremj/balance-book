import {
  addDays,
  addMonthsConstrained,
  cashAccountSchema,
  cashFloorPolicySchema,
  compareDates,
  forecastEventSchema,
  loanSchema,
  moneyCentsSchema,
  plainDateSchema,
  toPlainDate,
  type CashAccount,
  type CashFloorPolicy,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
  type Loan,
  type MoneyCents,
  type PlainDateString,
  type Receivable,
} from '@balance-book/domain';
import { buildForecastBundle, type ForecastBundle } from './forecast';
import { prepareRollingForecastContext } from './rolling';
import { materializeForecastEvents } from './schedule';

export interface RefinanceForecastInput {
  accounts: CashAccount[];
  events: ForecastEvent[];
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  loans: Loan[];
  receivables: Receivable[];
  policy: CashFloorPolicy;
  includeCardInterest?: boolean;
  requestedStartDate: PlainDateString;
  loanId: string;
  fundingAccountId: string;
  closingDate: PlainDateString;
  firstPaymentDate: PlainDateString;
  replacementPaymentCents: MoneyCents;
  replacementTermMonths: number;
  cashAtClosingCents: MoneyCents;
}

export interface RefinanceForecastEvaluation {
  baseline: ForecastBundle;
  proposed: ForecastBundle;
  startDate: PlainDateString;
  originalHorizonEndDate: PlainDateString;
  endDate: PlainDateString;
  horizonExtended: boolean;
  replacementPaymentEventId: string;
}

/**
 * Compares current and refinanced cash schedules over one identical horizon. If the first
 * replacement payment falls beyond the ordinary policy window, both schedules extend through that
 * payment. Current-loan payments strictly before closing remain in the proposal; closing takes
 * effect before any current-loan payment dated on the closing day. This prevents removing the
 * current loan too early or accidentally omitting its replacement.
 */
export const evaluateRefinanceForecast = (
  input: RefinanceForecastInput,
): RefinanceForecastEvaluation => {
  const policy = cashFloorPolicySchema.parse(input.policy);
  const closingDate = plainDateSchema.parse(input.closingDate);
  const firstPaymentDate = plainDateSchema.parse(input.firstPaymentDate);
  const replacementPaymentCents = moneyCentsSchema.positive().parse(input.replacementPaymentCents);
  const cashAtClosingCents = moneyCentsSchema.nonnegative().parse(input.cashAtClosingCents);
  if (!Number.isInteger(input.replacementTermMonths) || input.replacementTermMonths <= 0) {
    throw new Error('Replacement loan term must be a positive whole number of months');
  }
  if (compareDates(firstPaymentDate, closingDate) <= 0) {
    throw new Error(
      'First replacement payment cannot be before the refinance closing date, or on the closing date',
    );
  }

  const selectedLoanInput = input.loans.find((loan) => loan.id === input.loanId);
  if (!selectedLoanInput) throw new Error(`Unknown loan to refinance ${input.loanId}`);
  const selectedLoan = loanSchema.parse(selectedLoanInput);
  if ((selectedLoan.status ?? 'active') !== 'active') {
    throw new Error('Only an active loan can be refinanced');
  }
  const fundingAccountInput = input.accounts.find(
    (account) => account.id === input.fundingAccountId,
  );
  if (!fundingAccountInput) {
    throw new Error(`Unknown refinance funding account ${input.fundingAccountId}`);
  }
  const fundingAccount = cashAccountSchema.parse(fundingAccountInput);
  if (fundingAccount.userId !== selectedLoan.userId) {
    throw new Error('The refinance loan and funding account must belong to the same user');
  }

  const context = prepareRollingForecastContext({
    accounts: input.accounts,
    events: input.events,
    cards: input.cards,
    cardCycles: input.cardCycles,
    loans: input.loans,
    receivables: input.receivables,
    policy,
    includeCardInterest: input.includeCardInterest,
    requestedStartDate: input.requestedStartDate,
    requiredEndDate: firstPaymentDate,
  });
  if (compareDates(closingDate, context.startDate) < 0) {
    throw new Error('Refinance closing date cannot precede the forecast start date');
  }
  if (compareDates(closingDate, fundingAccount.balanceAsOf) <= 0) {
    throw new Error('Refinance closing date must be after the funding account balance date');
  }

  const originalHorizonEndDate = addDays(context.startDate, policy.horizonDays - 1);
  const offerSourceId = `refinance-offer-${selectedLoan.id}`;
  const replacementTemplateId = `refinance-payment-${selectedLoan.id}`;
  const proposedOfferEvents: ForecastEvent[] = [
    forecastEventSchema.parse({
      id: replacementTemplateId,
      userId: selectedLoan.userId,
      accountId: fundingAccount.id,
      date: firstPaymentDate,
      kind: 'loan-payment',
      direction: 'outflow',
      amountCents: replacementPaymentCents,
      certainty: 'confirmed',
      status: 'scheduled',
      label: `${selectedLoan.name} proposed refinance payment`,
      sourceRecordId: offerSourceId,
      hypothetical: true,
      accepted: true,
      recurrenceRule: {
        frequency: 'monthly',
        dayOfMonth: toPlainDate(firstPaymentDate).day,
        interval: 1,
      },
      recurrenceEndDate: addMonthsConstrained(firstPaymentDate, input.replacementTermMonths - 1),
      paymentMethod: 'cash-account',
    }),
  ];
  if (cashAtClosingCents > 0) {
    proposedOfferEvents.push(
      forecastEventSchema.parse({
        id: `refinance-closing-${selectedLoan.id}`,
        userId: selectedLoan.userId,
        accountId: fundingAccount.id,
        date: closingDate,
        kind: 'scenario',
        direction: 'outflow',
        amountCents: cashAtClosingCents,
        certainty: 'confirmed',
        status: 'scheduled',
        label: `${selectedLoan.name} refinance cash at closing`,
        sourceRecordId: offerSourceId,
        hypothetical: true,
        accepted: true,
        paymentMethod: 'cash-account',
      }),
    );
  }

  const commonSchedule = {
    accounts: context.accounts,
    cards: input.cards,
    cardCycles: input.cardCycles,
    receivables: input.receivables,
    includeCardInterest: input.includeCardInterest,
    startDate: context.startDate,
    endDate: context.endDate,
  };
  const baselineEvents = materializeForecastEvents({
    ...commonSchedule,
    events: input.events,
    loans: input.loans,
  });
  const proposedEvents = materializeForecastEvents({
    ...commonSchedule,
    events: [...input.events, ...proposedOfferEvents],
    loans: input.loans,
  }).filter(
    (event) =>
      event.kind !== 'loan-payment' ||
      event.sourceRecordId !== selectedLoan.id ||
      compareDates(event.date, closingDate) < 0,
  );
  const firstReplacementPayment = proposedEvents.find(
    (event) =>
      event.kind === 'loan-payment' &&
      event.sourceRecordId === offerSourceId &&
      event.date === firstPaymentDate,
  );
  if (!firstReplacementPayment) {
    throw new Error('The first replacement payment was not included in the refinance forecast');
  }

  const commonForecast = {
    accounts: context.accounts,
    policy,
    startDate: context.startDate,
    endDate: context.endDate,
  };
  return {
    baseline: buildForecastBundle({ ...commonForecast, events: baselineEvents }),
    proposed: buildForecastBundle({ ...commonForecast, events: proposedEvents }),
    startDate: context.startDate,
    originalHorizonEndDate,
    endDate: context.endDate,
    horizonExtended: compareDates(context.endDate, originalHorizonEndDate) > 0,
    replacementPaymentEventId: firstReplacementPayment.id,
  };
};
