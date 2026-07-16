import {
  addDays,
  assetSchema,
  cashAccountSchema,
  cashFloorPolicySchema,
  committedRefinancePlanInputSchema,
  committedRefinancePlanSchema,
  compareDates,
  daysBetween,
  forecastEventSchema,
  loanSchema,
  moneyCentsSchema,
  plainDateSchema,
  type CashAccount,
  type Asset,
  type CashFloorPolicy,
  type CommittedRefinancePlan,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
  type Loan,
  type MoneyCents,
  type PlainDateString,
  type Receivable,
  type RefinancePayoff,
} from '@balance-book/domain';
import { buildForecastBundle, type ForecastBundle } from './forecast';
import {
  projectLoanBalanceAtEndOfDate,
  projectLoanPayoffAtDate,
  type LoanPayoffProjection,
} from './loans';
import { prepareRollingForecastContext } from './rolling';
import { materializeForecastEvents } from './schedule';

export interface ResolvedCommittedRefinancePlan extends CommittedRefinancePlan {
  totalPayoffCents: MoneyCents;
  unfinancedClosingCostsCents: MoneyCents;
  bankOutflowAtClosingCents: MoneyCents;
}

export interface ResolvedCommittedRefinances {
  plans: ResolvedCommittedRefinancePlan[];
  loans: Loan[];
}

export interface CommittedRefinanceForecastInput {
  accounts: CashAccount[];
  events: ForecastEvent[];
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  loans: Loan[];
  receivables: Receivable[];
  policy: CashFloorPolicy;
  requestedStartDate: PlainDateString;
  existingPlans?: CommittedRefinancePlan[];
  plan: CommittedRefinancePlan;
}

export interface CommittedRefinanceForecastEvaluation {
  baseline: ForecastBundle;
  proposed: ForecastBundle;
  startDate: PlainDateString;
  originalHorizonEndDate: PlainDateString;
  endDate: PlainDateString;
  horizonExtended: boolean;
  firstReplacementPaymentEventId: string;
  closingCashEventIds: string[];
}

export interface ProjectedRefinancePayoff extends RefinancePayoff {
  projection: LoanPayoffProjection;
}

/** Builds the payoff defaults for an offer from the loan schedule effective on the payoff date. */
export const projectRefinancePayoffsAtDate = (input: {
  loans: Loan[];
  sourceLoanIds: string[];
  payoffDate: PlainDateString;
  existingPlans?: CommittedRefinancePlan[];
  loanPaymentEvents?: readonly ForecastEvent[];
  actualThroughDate?: PlainDateString;
}): ProjectedRefinancePayoff[] => {
  const payoffDate = plainDateSchema.parse(input.payoffDate);
  const loans = input.loans.map((loan) => loanSchema.parse(loan));
  const loanById = new Map(loans.map((loan) => [loan.id, loan]));
  if (loanById.size !== loans.length) throw new Error('Loan IDs must be unique');
  const sourceLoanIds = new Set(input.sourceLoanIds);
  if (sourceLoanIds.size !== input.sourceLoanIds.length) {
    throw new Error('Each payoff loan may be selected only once');
  }
  const plans = (input.existingPlans ?? [])
    .map((plan) => committedRefinancePlanSchema.parse(plan))
    .filter((plan) => plan.status === 'committed');
  const creatorByLoanId = new Map(plans.map((plan) => [plan.replacementLoan.id, plan]));
  const retirementByLoanId = new Map(
    plans.flatMap((plan) =>
      plan.payoffs.map((payoff) => [payoff.sourceLoanId, plan.payoffDate] as const),
    ),
  );

  return input.sourceLoanIds.map((sourceLoanId) => {
    const loan = loanById.get(sourceLoanId);
    if (!loan) throw new Error(`Unknown refinance payoff loan ${sourceLoanId}`);
    const existingRetirementDate = retirementByLoanId.get(sourceLoanId);
    if (existingRetirementDate) {
      throw new Error(
        `Loan ${sourceLoanId} is already assigned to a committed payoff on ${existingRetirementDate}`,
      );
    }
    const creator = creatorByLoanId.get(sourceLoanId);
    if (creator && compareDates(creator.payoffDate, payoffDate) >= 0) {
      throw new Error(
        'A replacement loan cannot be refinanced again before its source payoff settles',
      );
    }
    const projection = projectLoanPayoffAtDate(loan, payoffDate, {
      loanPaymentEvents: input.loanPaymentEvents,
      actualThroughDate: input.actualThroughDate,
    });
    return {
      sourceLoanId,
      payoffAmountCents: projection.payoffCents,
      ...(creator === undefined ? {} : { sourceRefinancePlanId: creator.id }),
      projection,
    };
  });
};

const ensureAccountForAmount = (input: {
  accountId?: string;
  amountCents: MoneyCents;
  userId: string;
  role: string;
  accountsById: Map<string, CashAccount>;
}): void => {
  if (input.amountCents > 0 && !input.accountId) {
    throw new Error(`${input.role} account is required when its amount is greater than zero`);
  }
  if (!input.accountId) return;
  const account = input.accountsById.get(input.accountId);
  if (!account) throw new Error(`Unknown ${input.role.toLowerCase()} account ${input.accountId}`);
  if (account.userId !== input.userId) {
    throw new Error(`${input.role} account and refinance must belong to the same user`);
  }
};

/**
 * Validates settlement accounting and refinance lineage, and returns the complete loan set needed
 * for a forecast. A replacement loan may be a payoff source in a later plan, but a loan can be
 * retired only once and circular/same-instant refinance chains are rejected.
 */
export const resolveCommittedRefinances = (input: {
  accounts: CashAccount[];
  loans: Loan[];
  plans: CommittedRefinancePlan[];
}): ResolvedCommittedRefinances => {
  const accounts = input.accounts.map((account) => cashAccountSchema.parse(account));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  if (accountsById.size !== accounts.length) throw new Error('Cash account IDs must be unique');

  const baseLoans = input.loans.map((loan) => loanSchema.parse(loan));
  const baseLoanById = new Map<string, Loan>();
  for (const loan of baseLoans) {
    if (baseLoanById.has(loan.id)) throw new Error(`Duplicate loan ID ${loan.id}`);
    baseLoanById.set(loan.id, loan);
  }

  const plans = input.plans.map((plan) => committedRefinancePlanSchema.parse(plan));
  const planIds = new Set<string>();
  const creatorByLoanId = new Map<string, CommittedRefinancePlan>();
  const allReplacementLoanIds = new Set<string>();
  for (const plan of plans) {
    if (!plan.id.trim()) throw new Error('Committed refinance ID is required');
    if (planIds.has(plan.id)) throw new Error(`Duplicate committed refinance ID ${plan.id}`);
    planIds.add(plan.id);
    const replacementLoan = loanSchema.parse(plan.replacementLoan);
    if (allReplacementLoanIds.has(replacementLoan.id)) {
      throw new Error(`Replacement loan ${replacementLoan.id} is created by more than one plan`);
    }
    allReplacementLoanIds.add(replacementLoan.id);
    if (plan.status === 'committed') creatorByLoanId.set(replacementLoan.id, plan);
  }

  const availableLoansById = new Map(
    baseLoans
      .filter((loan) => !allReplacementLoanIds.has(loan.id))
      .map((loan) => [loan.id, loan] as const),
  );
  for (const plan of plans) {
    if (plan.status !== 'committed') continue;
    const replacementLoan = loanSchema.parse(plan.replacementLoan);
    availableLoansById.set(replacementLoan.id, replacementLoan);
  }

  const dependenciesByPlanId = new Map<string, string[]>();
  for (const plan of plans) {
    if (plan.status !== 'committed') continue;
    dependenciesByPlanId.set(
      plan.id,
      plan.payoffs.flatMap((payoff) => {
        const creator = creatorByLoanId.get(payoff.sourceLoanId);
        return creator ? [creator.id] : [];
      }),
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitPlan = (planId: string): void => {
    if (visiting.has(planId)) throw new Error('Committed refinance lineage cannot contain a cycle');
    if (visited.has(planId)) return;
    visiting.add(planId);
    for (const dependencyId of dependenciesByPlanId.get(planId) ?? []) visitPlan(dependencyId);
    visiting.delete(planId);
    visited.add(planId);
  };
  for (const planId of dependenciesByPlanId.keys()) visitPlan(planId);

  const retiredByPlanId = new Map<string, string>();
  const resolvedPlans: ResolvedCommittedRefinancePlan[] = [];
  for (const rawPlan of plans) {
    if (rawPlan.status !== 'committed') continue;
    const closingDate = plainDateSchema.parse(rawPlan.closingDate);
    const payoffDate = plainDateSchema.parse(rawPlan.payoffDate);
    const firstPaymentDate = plainDateSchema.parse(rawPlan.firstPaymentDate);
    if (compareDates(payoffDate, closingDate) < 0) {
      throw new Error('Refinance payoff date cannot be before its closing date');
    }
    if (compareDates(firstPaymentDate, closingDate) <= 0) {
      throw new Error('First replacement payment must be after the refinance closing date');
    }
    if (rawPlan.payoffs.length === 0) {
      throw new Error('A committed refinance must pay off at least one loan');
    }

    const replacementLoan = loanSchema.parse(rawPlan.replacementLoan);
    if (replacementLoan.id === '' || replacementLoan.userId !== rawPlan.userId) {
      throw new Error('Replacement loan and refinance must belong to the same user');
    }
    const paymentAccount = accountsById.get(replacementLoan.fundingAccountId);
    if (!paymentAccount) {
      throw new Error(`Unknown replacement payment account ${replacementLoan.fundingAccountId}`);
    }
    if (paymentAccount.userId !== rawPlan.userId) {
      throw new Error('Replacement payment account and refinance must belong to the same user');
    }

    const sourceLoanIds = new Set<string>();
    let totalPayoffCents = 0;
    for (const payoff of rawPlan.payoffs) {
      if (sourceLoanIds.has(payoff.sourceLoanId)) {
        throw new Error(`Loan ${payoff.sourceLoanId} appears more than once in one refinance`);
      }
      sourceLoanIds.add(payoff.sourceLoanId);
      if (payoff.sourceLoanId === replacementLoan.id) {
        throw new Error('A refinance cannot replace and pay off the same loan ID');
      }
      const sourceLoan = availableLoansById.get(payoff.sourceLoanId);
      if (!sourceLoan) throw new Error(`Unknown refinance payoff loan ${payoff.sourceLoanId}`);
      if (sourceLoan.userId !== rawPlan.userId) {
        throw new Error('Payoff loans and refinance must belong to the same user');
      }
      if (sourceLoan.includeInCashForecast === false) {
        throw new Error(
          'Payoff loan payments must be included in the cash forecast before refinancing',
        );
      }
      if (projectLoanPayoffAtDate(sourceLoan, payoffDate).payoffCents === 0) {
        throw new Error(`Loan ${sourceLoan.id} has no modeled debt on the refinance payoff date`);
      }
      const priorRetirement = retiredByPlanId.get(sourceLoan.id);
      if (priorRetirement) {
        throw new Error(`Loan ${sourceLoan.id} is already retired by refinance ${priorRetirement}`);
      }
      const sourceCreator = creatorByLoanId.get(sourceLoan.id);
      if (sourceCreator) {
        if (sourceCreator.id === rawPlan.id) {
          throw new Error('A refinance cannot pay off its own replacement loan');
        }
        if (compareDates(sourceCreator.payoffDate, closingDate) >= 0) {
          throw new Error('A stacked refinance must close after its source payoff settles');
        }
        if (
          payoff.sourceRefinancePlanId !== undefined &&
          payoff.sourceRefinancePlanId !== sourceCreator.id
        ) {
          throw new Error(`Incorrect source refinance lineage for loan ${sourceLoan.id}`);
        }
      } else if (payoff.sourceRefinancePlanId !== undefined) {
        throw new Error(`Loan ${sourceLoan.id} was not created by a committed refinance`);
      }
      const payoffAmountCents = moneyCentsSchema.positive().parse(payoff.payoffAmountCents);
      totalPayoffCents += payoffAmountCents;
      retiredByPlanId.set(sourceLoan.id, rawPlan.id);
    }

    totalPayoffCents = moneyCentsSchema.parse(totalPayoffCents);
    const principalCashContributionCents = moneyCentsSchema
      .nonnegative()
      .parse(rawPlan.principalCashContributionCents);
    const closingCostsCents = moneyCentsSchema.nonnegative().parse(rawPlan.closingCostsCents);
    const financedFeesCents = moneyCentsSchema.nonnegative().parse(rawPlan.financedFeesCents);
    const excessProceedsCents = moneyCentsSchema.nonnegative().parse(rawPlan.excessProceedsCents);
    if (financedFeesCents > closingCostsCents) {
      throw new Error('Financed refinance fees cannot exceed total closing costs');
    }
    if (principalCashContributionCents > totalPayoffCents) {
      throw new Error('Principal cash contribution cannot exceed total loan payoffs');
    }
    const unfinancedClosingCostsCents = moneyCentsSchema.parse(
      closingCostsCents - financedFeesCents,
    );
    const bankOutflowAtClosingCents = moneyCentsSchema.parse(
      principalCashContributionCents + unfinancedClosingCostsCents,
    );
    ensureAccountForAmount({
      accountId: rawPlan.cashSourceAccountId,
      amountCents: bankOutflowAtClosingCents,
      userId: rawPlan.userId,
      role: 'Closing cash source',
      accountsById,
    });
    ensureAccountForAmount({
      accountId: rawPlan.excessProceedsAccountId,
      amountCents: excessProceedsCents,
      userId: rawPlan.userId,
      role: 'Excess proceeds destination',
      accountsById,
    });

    resolvedPlans.push({
      ...rawPlan,
      closingDate,
      payoffDate,
      firstPaymentDate,
      replacementLoan,
      principalCashContributionCents,
      closingCostsCents,
      financedFeesCents,
      excessProceedsCents,
      totalPayoffCents,
      unfinancedClosingCostsCents,
      bankOutflowAtClosingCents,
    });
  }

  const sourceLoanIds = new Set(
    resolvedPlans.flatMap((plan) => plan.payoffs.map((payoff) => payoff.sourceLoanId)),
  );
  const scheduleLoans = [...availableLoansById.values()].map((loan) =>
    sourceLoanIds.has(loan.id) ? loanSchema.parse({ ...loan, status: 'active' }) : loan,
  );
  return {
    plans: resolvedPlans.sort(
      (left, right) =>
        compareDates(left.closingDate, right.closingDate) || left.id.localeCompare(right.id),
    ),
    loans: scheduleLoans,
  };
};

export const activeLoansForDate = (input: {
  accounts: CashAccount[];
  loans: Loan[];
  plans: CommittedRefinancePlan[];
  loanPaymentEvents?: readonly ForecastEvent[];
  date: PlainDateString;
}): Loan[] => {
  const date = plainDateSchema.parse(input.date);
  const resolved = resolveCommittedRefinances(input);
  const creationDateByLoanId = new Map(
    resolved.plans.map((plan) => [plan.replacementLoan.id, plan.closingDate]),
  );
  const payoffDateByLoanId = new Map(
    resolved.plans.flatMap((plan) =>
      plan.payoffs.map((payoff) => [payoff.sourceLoanId, plan.payoffDate] as const),
    ),
  );
  const payoffSourceIds = new Set(payoffDateByLoanId.keys());
  const creatorByLoanId = new Map(
    resolved.plans.map((plan) => [plan.replacementLoan.id, plan] as const),
  );

  return resolved.loans.flatMap((storedLoan) => {
    const creator = creatorByLoanId.get(storedLoan.id);
    const loan =
      creator?.replacementLoanSnapshot && compareDates(date, storedLoan.balanceDate) < 0
        ? creator.replacementLoanSnapshot
        : storedLoan;
    const creationDate = creationDateByLoanId.get(loan.id);
    if (creationDate && compareDates(date, creationDate) < 0) return [];
    const payoffDate = payoffDateByLoanId.get(loan.id);
    if (payoffDate && compareDates(date, payoffDate) >= 0) return [];
    if ((loan.status ?? 'active') !== 'active' && !payoffSourceIds.has(loan.id)) return [];
    if (compareDates(date, loan.balanceDate) < 0) return [];
    const projection = projectLoanBalanceAtEndOfDate(loan, date, {
      loanPaymentEvents: input.loanPaymentEvents,
      actualThroughDate: date,
    });
    if (projection.totalCents === 0) return [];
    return [
      loanSchema.parse({
        ...loan,
        principalCents: projection.principalCents,
        accruedInterestCents: projection.accruedInterestCents,
        balanceDate: date,
      }),
    ];
  });
};

/** Resolves a secured asset's linked liability only when each committed closing becomes effective. */
export const effectiveAssetsForDate = (input: {
  assets: Asset[];
  plans: CommittedRefinancePlan[];
  date: PlainDateString;
}): Asset[] => {
  const date = plainDateSchema.parse(input.date);
  const assetsById = new Map(
    input.assets.map((asset) => {
      const parsed = assetSchema.parse(asset);
      return [parsed.id, parsed] as const;
    }),
  );
  const futurePlans = input.plans
    .map((plan) => committedRefinancePlanSchema.parse(plan))
    .filter((plan) => plan.status === 'committed' && compareDates(plan.closingDate, date) > 0)
    .sort(
      (left, right) =>
        compareDates(right.closingDate, left.closingDate) || right.id.localeCompare(left.id),
    );
  for (const plan of futurePlans) {
    for (const relink of plan.assetRelinks ?? []) {
      const asset = assetsById.get(relink.assetId);
      if (asset?.linkedLiabilityId !== relink.replacementLoanId) continue;
      assetsById.set(
        asset.id,
        assetSchema.parse({ ...asset, linkedLiabilityId: relink.sourceLoanId }),
      );
    }
  }
  return [...assetsById.values()];
};

/** Restricted lender settlement funds offset overlapping old/new liabilities until payoff posts. */
export const pendingRefinanceSettlementCentsForDate = (input: {
  plans: CommittedRefinancePlan[];
  date: PlainDateString;
}): MoneyCents => {
  const date = plainDateSchema.parse(input.date);
  return moneyCentsSchema.parse(
    input.plans
      .map((plan) => committedRefinancePlanSchema.parse(plan))
      .filter(
        (plan) =>
          plan.status === 'committed' &&
          compareDates(date, plan.closingDate) >= 0 &&
          compareDates(date, plan.payoffDate) < 0,
      )
      .reduce(
        (total, plan) =>
          total +
          plan.payoffs.reduce((payoffTotal, payoff) => payoffTotal + payoff.payoffAmountCents, 0),
        0,
      ),
  );
};

/** Economic settlement offset only follows payoff debt that is not already netted in an asset. */
export const pendingRefinanceEconomicSettlementCentsForDate = (input: {
  plans: CommittedRefinancePlan[];
  loans: Loan[];
  date: PlainDateString;
}): MoneyCents => {
  const date = plainDateSchema.parse(input.date);
  const loanById = new Map(input.loans.map((loan) => [loan.id, loanSchema.parse(loan)]));
  return moneyCentsSchema.parse(
    input.plans
      .map((plan) => committedRefinancePlanSchema.parse(plan))
      .filter(
        (plan) =>
          plan.status === 'committed' &&
          compareDates(date, plan.closingDate) >= 0 &&
          compareDates(date, plan.payoffDate) < 0,
      )
      .reduce(
        (total, plan) =>
          total +
          plan.payoffs.reduce((payoffTotal, payoff) => {
            const sourceLoan = loanById.get(payoff.sourceLoanId);
            return sourceLoan?.excludeFromEconomicNetWorthDoubleCount
              ? payoffTotal
              : payoffTotal + payoff.payoffAmountCents;
          }, 0),
        0,
      ),
  );
};

export const materializeCommittedRefinanceEvents = (input: {
  accounts: CashAccount[];
  events: ForecastEvent[];
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  loans: Loan[];
  receivables?: Receivable[];
  plans: CommittedRefinancePlan[];
  startDate: PlainDateString;
  endDate: PlainDateString;
  plannedReceivableStartDate?: PlainDateString;
}): ForecastEvent[] => {
  const resolved = resolveCommittedRefinances({
    accounts: input.accounts,
    loans: input.loans,
    plans: input.plans,
  });
  const derivedClosingEventIds = new Set(
    resolved.plans.flatMap((plan) => [
      `refinance-excess-proceeds-${plan.id}`,
      `refinance-closing-cash-${plan.id}`,
    ]),
  );
  const closingEvents = resolved.plans.flatMap((plan): ForecastEvent[] => {
    const events: ForecastEvent[] = [];
    // Settlement is simultaneous. Credit excess proceeds before applying closing cash so the
    // consolidated intraday trough does not manufacture a temporary funding deficit.
    if (plan.excessProceedsCents > 0) {
      events.push(
        forecastEventSchema.parse({
          id: `refinance-excess-proceeds-${plan.id}`,
          userId: plan.userId,
          accountId: plan.excessProceedsAccountId,
          date: plan.closingDate,
          kind: 'manual-adjustment',
          direction: 'inflow',
          amountCents: plan.excessProceedsCents,
          certainty: 'confirmed',
          status: 'scheduled',
          label: `${plan.name} excess refinance proceeds`,
          manualOrder: 80,
          sourceRecordId: plan.id,
          accepted: true,
          paymentMethod: 'cash-account',
        }),
      );
    }
    if (plan.bankOutflowAtClosingCents > 0) {
      events.push(
        forecastEventSchema.parse({
          id: `refinance-closing-cash-${plan.id}`,
          userId: plan.userId,
          accountId: plan.cashSourceAccountId,
          date: plan.closingDate,
          kind: 'manual-adjustment',
          direction: 'outflow',
          amountCents: plan.bankOutflowAtClosingCents,
          certainty: 'confirmed',
          status: 'scheduled',
          label: `${plan.name} cash due at closing`,
          manualOrder: 90,
          sourceRecordId: plan.id,
          accepted: true,
          paymentMethod: 'cash-account',
        }),
      );
    }
    return events;
  });
  const baseEvents = input.events.filter((event) => !derivedClosingEventIds.has(event.id));
  const materialized = materializeForecastEvents({
    accounts: input.accounts,
    events: [...baseEvents, ...closingEvents],
    cards: input.cards,
    cardCycles: input.cardCycles,
    loans: resolved.loans,
    ...(input.receivables === undefined ? {} : { receivables: input.receivables }),
    startDate: input.startDate,
    endDate: input.endDate,
    ...(input.plannedReceivableStartDate === undefined
      ? {}
      : { plannedReceivableStartDate: input.plannedReceivableStartDate }),
  });
  const payoffDateByLoanId = new Map(
    resolved.plans.flatMap((plan) =>
      plan.payoffs.map((payoff) => [payoff.sourceLoanId, plan.payoffDate] as const),
    ),
  );
  const loanById = new Map(resolved.loans.map((loan) => [loan.id, loan]));
  return materialized.filter((event) => {
    if (event.kind !== 'loan-payment' || !event.sourceRecordId) return true;
    const payoffDate = payoffDateByLoanId.get(event.sourceRecordId);
    if (payoffDate && compareDates(event.date, payoffDate) >= 0) return false;
    const maturityDate = loanById.get(event.sourceRecordId)?.maturityDate;
    return !maturityDate || compareDates(event.date, maturityDate) <= 0;
  });
};

/**
 * Previews the exact canonical plan that can subsequently be committed. Baseline and proposal use
 * one horizon, extended through the later of payoff and first replacement payment when necessary,
 * so neither side of an independently timed transition can disappear from the comparison.
 */
export const evaluateCommittedRefinanceForecast = (
  input: CommittedRefinanceForecastInput,
): CommittedRefinanceForecastEvaluation => {
  committedRefinancePlanInputSchema.parse(input.plan);
  const plan = committedRefinancePlanSchema.parse(input.plan);
  if (plan.status !== 'committed')
    throw new Error('Only a committed refinance plan can be previewed');
  const requestedStartDate = plainDateSchema.parse(input.requestedStartDate);
  if (compareDates(plan.closingDate, requestedStartDate) < 0) {
    throw new Error('Refinance closing date cannot precede the forecast start date');
  }
  if (daysBetween(requestedStartDate, plan.closingDate) > 3_650) {
    throw new Error('Refinance closing date must be within 10 years of the forecast start date');
  }
  const policy = cashFloorPolicySchema.parse(input.policy);
  const existingPlans = (input.existingPlans ?? []).map((existingPlan) =>
    committedRefinancePlanSchema.parse(existingPlan),
  );
  const proposedPlans = [...existingPlans, plan];
  const baselineLoans = input.loans.filter((loan) => loan.id !== plan.replacementLoan.id);
  const proposedResolution = resolveCommittedRefinances({
    accounts: input.accounts,
    loans: baselineLoans,
    plans: proposedPlans,
  });
  const resolvedPlan = proposedResolution.plans.find((candidate) => candidate.id === plan.id);
  if (!resolvedPlan) throw new Error('The proposed refinance could not be resolved');
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const requireEventAfterAccountSnapshot = (
    accountId: string,
    eventDate: PlainDateString,
    role: string,
  ): void => {
    const account = accountById.get(accountId);
    if (!account || compareDates(eventDate, account.balanceAsOf) <= 0) {
      throw new Error(`${role} must occur after that account's recorded balance date`);
    }
  };
  requireEventAfterAccountSnapshot(
    plan.replacementLoan.fundingAccountId,
    plan.firstPaymentDate,
    'The first replacement payment',
  );
  if (resolvedPlan.bankOutflowAtClosingCents > 0 && plan.cashSourceAccountId) {
    requireEventAfterAccountSnapshot(plan.cashSourceAccountId, plan.closingDate, 'Closing cash');
  }
  if (plan.excessProceedsCents > 0 && plan.excessProceedsAccountId) {
    requireEventAfterAccountSnapshot(
      plan.excessProceedsAccountId,
      plan.closingDate,
      'Excess refinance proceeds',
    );
  }
  const context = prepareRollingForecastContext({
    accounts: input.accounts,
    events: input.events,
    cards: input.cards,
    cardCycles: input.cardCycles,
    loans: baselineLoans,
    committedRefinancePlans: existingPlans,
    receivables: input.receivables,
    policy,
    requestedStartDate: input.requestedStartDate,
    requiredEndDate:
      compareDates(plan.firstPaymentDate, plan.payoffDate) >= 0
        ? plan.firstPaymentDate
        : plan.payoffDate,
  });
  const commonSchedule = {
    accounts: context.accounts,
    events: input.events,
    cards: input.cards,
    cardCycles: input.cardCycles,
    receivables: input.receivables,
    startDate: context.startDate,
    endDate: context.endDate,
  };
  const baselineEvents =
    existingPlans.length === 0
      ? materializeForecastEvents({
          ...commonSchedule,
          loans: baselineLoans,
        })
      : materializeCommittedRefinanceEvents({
          ...commonSchedule,
          loans: baselineLoans,
          plans: existingPlans,
        });
  const proposedEvents = materializeCommittedRefinanceEvents({
    ...commonSchedule,
    loans: baselineLoans,
    plans: proposedPlans,
  });
  const firstReplacementPaymentEventId = `loan-payment-${plan.replacementLoan.id}@${plan.firstPaymentDate}`;
  if (!proposedEvents.some((event) => event.id === firstReplacementPaymentEventId)) {
    throw new Error('The first replacement payment was not included in the refinance forecast');
  }

  const commonForecast = {
    accounts: context.accounts,
    policy,
    startDate: context.startDate,
    endDate: context.endDate,
  };
  const originalHorizonEndDate = addDays(context.startDate, policy.horizonDays - 1);
  const closingCashEventIds = [
    `refinance-excess-proceeds-${plan.id}`,
    `refinance-closing-cash-${plan.id}`,
  ].filter((id) => proposedEvents.some((event) => event.id === id));
  return {
    baseline: buildForecastBundle({ ...commonForecast, events: baselineEvents }),
    proposed: buildForecastBundle({ ...commonForecast, events: proposedEvents }),
    startDate: context.startDate,
    originalHorizonEndDate,
    endDate: context.endDate,
    horizonExtended: compareDates(context.endDate, originalHorizonEndDate) > 0,
    firstReplacementPaymentEventId,
    closingCashEventIds,
  };
};
