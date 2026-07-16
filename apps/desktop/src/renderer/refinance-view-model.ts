import {
  compareDates,
  moneyCentsSchema,
  type CommittedRefinancePlan,
  type ForecastEvent,
  type Loan,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import {
  projectLoanBalanceAtEndOfDate,
  type ProjectedRefinancePayoff,
} from '@balance-book/financial-engine';

export interface RefinanceSettlementBreakdown {
  totalPayoffCents: MoneyCents;
  principalCashContributionCents: MoneyCents;
  cashPaidClosingCostsCents: MoneyCents;
  totalBankOutflowCents: MoneyCents;
  excessProceedsCents: MoneyCents;
}

export interface RefinanceLoanPayoffPair {
  loan: Loan;
  payoff: ProjectedRefinancePayoff;
}

/**
 * Joins payoff projections to their source loans by durable ID. Candidate display order and the
 * order in which checkboxes were selected are intentionally independent.
 */
export const pairRefinanceLoansWithPayoffs = (input: {
  loans: Loan[];
  payoffs: ProjectedRefinancePayoff[];
}): RefinanceLoanPayoffPair[] => {
  const loanIds = new Set(input.loans.map((loan) => loan.id));
  if (loanIds.size !== input.loans.length) {
    throw new Error('Duplicate loans cannot be compared in one refinance');
  }
  const payoffByLoanId = new Map<string, ProjectedRefinancePayoff>();
  for (const payoff of input.payoffs) {
    if (payoffByLoanId.has(payoff.sourceLoanId)) {
      throw new Error(`Duplicate refinance payoff projection for ${payoff.sourceLoanId}`);
    }
    payoffByLoanId.set(payoff.sourceLoanId, payoff);
  }
  if (payoffByLoanId.size !== loanIds.size) {
    throw new Error('Refinance payoff projections do not match the selected loans');
  }
  return input.loans.map((loan) => {
    const payoff = payoffByLoanId.get(loan.id);
    if (!payoff) throw new Error(`Missing refinance payoff projection for ${loan.id}`);
    return { loan, payoff };
  });
};

/**
 * Reconciles every dollar of a refinance settlement. Financed fees are already inside the new
 * principal, so only their unfinanced portion leaves a bank account. A principal smaller than the
 * payoff plus financed fees requires cash; a larger principal produces true cash-out proceeds.
 */
export const calculateRefinanceSettlement = (input: {
  payoffAmountsCents: MoneyCents[];
  newPrincipalCents: MoneyCents;
  closingCostsCents: MoneyCents;
  financedFeesCents: MoneyCents;
}): RefinanceSettlementBreakdown => {
  const totalPayoffCents = moneyCentsSchema.parse(
    input.payoffAmountsCents.reduce((total, value) => total + value, 0),
  );
  if (totalPayoffCents <= 0) throw new Error('Select at least one positive loan payoff');
  const newPrincipalCents = moneyCentsSchema.positive().parse(input.newPrincipalCents);
  const closingCostsCents = moneyCentsSchema.nonnegative().parse(input.closingCostsCents);
  const financedFeesCents = moneyCentsSchema.nonnegative().parse(input.financedFeesCents);
  if (financedFeesCents > closingCostsCents) {
    throw new Error('Financed fees cannot exceed total closing costs');
  }

  const principalDifferenceCents = newPrincipalCents - totalPayoffCents - financedFeesCents;
  const principalCashContributionCents = moneyCentsSchema.parse(
    Math.max(0, -principalDifferenceCents),
  );
  if (principalCashContributionCents > totalPayoffCents) {
    throw new Error('Principal cash contribution cannot exceed the loan payoffs');
  }
  const excessProceedsCents = moneyCentsSchema.parse(Math.max(0, principalDifferenceCents));
  const cashPaidClosingCostsCents = moneyCentsSchema.parse(closingCostsCents - financedFeesCents);
  return {
    totalPayoffCents,
    principalCashContributionCents,
    cashPaidClosingCostsCents,
    totalBankOutflowCents: moneyCentsSchema.parse(
      principalCashContributionCents + cashPaidClosingCostsCents,
    ),
    excessProceedsCents,
  };
};

export type RefinancePlanLifecycle =
  | 'cancelled'
  | 'upcoming'
  | 'settling'
  | 'active'
  | 'completed'
  | 'scheduled-to-refinance'
  | 'refinanced-again';

export const refinancePlanLifecycle = (input: {
  plan: CommittedRefinancePlan;
  plans: CommittedRefinancePlan[];
  loanPaymentEvents?: readonly ForecastEvent[];
  asOfDate: PlainDateString;
}): RefinancePlanLifecycle => {
  if (input.plan.status === 'cancelled') return 'cancelled';
  if (compareDates(input.asOfDate, input.plan.closingDate) < 0) return 'upcoming';
  if (compareDates(input.asOfDate, input.plan.payoffDate) < 0) return 'settling';
  const nextPlan = input.plans.find(
    (candidate) =>
      candidate.status === 'committed' &&
      candidate.payoffs.some((payoff) => payoff.sourceLoanId === input.plan.replacementLoan.id),
  );
  if (!nextPlan) {
    const replacementLoan =
      input.plan.replacementLoanSnapshot &&
      compareDates(input.asOfDate, input.plan.replacementLoan.balanceDate) < 0
        ? input.plan.replacementLoanSnapshot
        : input.plan.replacementLoan;
    return projectLoanBalanceAtEndOfDate(replacementLoan, input.asOfDate, {
      loanPaymentEvents: input.loanPaymentEvents,
      actualThroughDate: input.asOfDate,
    }).totalCents === 0
      ? 'completed'
      : 'active';
  }
  return compareDates(input.asOfDate, nextPlan.payoffDate) >= 0
    ? 'refinanced-again'
    : 'scheduled-to-refinance';
};

export interface RefinanceLoanCandidate {
  loan: Loan;
  availableOn: PlainDateString;
  sourceRefinancePlanId?: string;
}

/**
 * Returns debts that can be selected for a new committed plan. A future replacement is selectable
 * so users can model a later refinance now, but a loan already assigned to another committed
 * payoff cannot be scheduled twice.
 */
export const refinanceLoanCandidates = (input: {
  loans: Loan[];
  plans: CommittedRefinancePlan[];
  loanPaymentEvents?: readonly ForecastEvent[];
  asOfDate?: PlainDateString;
}): RefinanceLoanCandidate[] => {
  const committedPlans = input.plans.filter((plan) => plan.status === 'committed');
  const cancelledReplacementIds = new Set(
    input.plans
      .filter((plan) => plan.status === 'cancelled')
      .map((plan) => plan.replacementLoan.id),
  );
  const scheduledPayoffIds = new Set(
    committedPlans.flatMap((plan) => plan.payoffs.map((payoff) => payoff.sourceLoanId)),
  );
  const originByLoanId = new Map(
    committedPlans.map((plan) => [plan.replacementLoan.id, plan] as const),
  );

  return input.loans
    .filter(
      (loan) =>
        !cancelledReplacementIds.has(loan.id) &&
        !scheduledPayoffIds.has(loan.id) &&
        (loan.status ?? 'active') === 'active' &&
        (!input.asOfDate ||
          compareDates(input.asOfDate, loan.balanceDate) < 0 ||
          projectLoanBalanceAtEndOfDate(loan, input.asOfDate, {
            loanPaymentEvents: input.loanPaymentEvents,
            actualThroughDate: input.asOfDate,
          }).totalCents > 0),
    )
    .map((loan) => {
      const origin = originByLoanId.get(loan.id);
      return {
        loan,
        availableOn: origin?.payoffDate ?? loan.balanceDate,
        ...(origin ? { sourceRefinancePlanId: origin.id } : {}),
      };
    })
    .sort(
      (left, right) =>
        compareDates(left.availableOn, right.availableOn) ||
        left.loan.name.localeCompare(right.loan.name),
    );
};
