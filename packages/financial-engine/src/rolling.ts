import {
  addDays,
  compareDates,
  type CashAccount,
  type CashFloorPolicy,
  type CreditCard,
  type CreditCardCycle,
  type CommittedRefinancePlan,
  type ForecastEvent,
  type Loan,
  type PlainDateString,
  type Receivable,
} from '@balance-book/domain';
import { buildForecastBundle } from './forecast';
import { materializeCommittedRefinanceEvents } from './committed-refinance';
import { materializeForecastEvents } from './schedule';

export interface RollingForecastInput {
  accounts: CashAccount[];
  events: ForecastEvent[];
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  loans: Loan[];
  committedRefinancePlans?: CommittedRefinancePlan[];
  receivables: Receivable[];
  includeCardInterest?: boolean;
  policy: CashFloorPolicy;
  requestedStartDate: PlainDateString;
  requiredEndDate?: PlainDateString;
}

export interface RollingForecastContext {
  accounts: CashAccount[];
  startDate: PlainDateString;
  endDate: PlainDateString;
  replayStartDate: PlainDateString;
}

/**
 * Rolls dated account snapshots through the native expected ledger before starting a current
 * forecast. This is shared by the production snapshot and every before/after preview so they cannot
 * disagree once a stored balance is older than today's financial date.
 */
export const prepareRollingForecastContext = (
  input: RollingForecastInput,
): RollingForecastContext => {
  if (input.accounts.length === 0) throw new Error('At least one cash account is required');
  const replayStartDate = input.accounts.map((account) => account.balanceAsOf).sort()[0]!;
  const startDate =
    compareDates(input.requestedStartDate, replayStartDate) > 0
      ? input.requestedStartDate
      : replayStartDate;
  const policyEndDate = addDays(startDate, input.policy.horizonDays - 1);
  const endDate =
    input.requiredEndDate && compareDates(input.requiredEndDate, policyEndDate) > 0
      ? input.requiredEndDate
      : policyEndDate;
  let accounts = input.accounts;

  if (compareDates(replayStartDate, startDate) < 0) {
    const priorDate = addDays(startDate, -1);
    const replayScheduleInput = {
      accounts: input.accounts,
      events: input.events,
      cards: input.cards,
      cardCycles: input.cardCycles,
      loans: input.loans,
      receivables: input.receivables,
      includeCardInterest: input.includeCardInterest,
      startDate: replayStartDate,
      endDate: priorDate,
      plannedReceivableStartDate: startDate,
    };
    const replayEvents = input.committedRefinancePlans
      ? materializeCommittedRefinanceEvents({
          ...replayScheduleInput,
          plans: input.committedRefinancePlans,
        })
      : materializeForecastEvents(replayScheduleInput);
    const replay = buildForecastBundle({
      accounts: input.accounts,
      events: replayEvents,
      policy: input.policy,
      startDate: replayStartDate,
      endDate: priorDate,
    });
    const priorDay = replay.expected.days.at(-1)!;
    accounts = input.accounts.map((account) => {
      if (compareDates(account.balanceAsOf, startDate) >= 0) return account;
      const priorBalance = priorDay.accounts.find((item) => item.accountId === account.id);
      if (!priorBalance) throw new Error(`Missing replay balance for account ${account.id}`);
      return {
        ...account,
        openingBalanceCents: priorBalance.endingBalanceCents,
        availableBalanceCents: undefined,
        balanceAsOf: priorDate,
      };
    });
  }

  return { accounts, startDate, endDate, replayStartDate };
};
