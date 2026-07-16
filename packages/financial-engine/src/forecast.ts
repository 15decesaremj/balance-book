import {
  addCents,
  addDays,
  cashAccountSchema,
  cashFloorPolicySchema,
  compareDates,
  enumerateDates,
  forecastEventSchema,
  moneyCentsSchema,
  type CashAccount,
  type CashFloorPolicy,
  type ForecastEvent,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import { assertNoDoubleCountRisks } from './invariants';

export type ForecastMode = 'conservative' | 'expected';

export interface DailyAccountBalance {
  accountId: string;
  openingBalanceCents: MoneyCents;
  minimumBalanceCents: MoneyCents;
  endingBalanceCents: MoneyCents;
  hardFloorCents: MoneyCents;
  preferredFloorCents?: MoneyCents;
  minimumEventIds: string[];
  appliedEventIds: string[];
}

export interface DailyForecast {
  date: PlainDateString;
  accounts: DailyAccountBalance[];
  inTransitCents: MoneyCents;
  minimumConsolidatedCashCents: MoneyCents;
  consolidatedCashCents: MoneyCents;
  minimumConsolidatedEventIds: string[];
  appliedEventIds: string[];
}

export interface AccountTrough {
  accountId: string;
  balanceCents: MoneyCents;
  date: PlainDateString;
  eventIds: string[];
}

export interface AccountShortfall {
  accountId: string;
  date: PlainDateString;
  balanceCents: MoneyCents;
  floorCents: MoneyCents;
  shortfallCents: MoneyCents;
  eventIds: string[];
}

export interface TransferNeed extends AccountShortfall {
  horizonDeepestShortfallCents: MoneyCents;
  horizonDeepestShortfallDate: PlainDateString;
  horizonAdditionalShortfallCents: MoneyCents;
  suggestedSourceAccountId?: string;
  initiationDate?: PlainDateString;
  arrivalDate?: PlainDateString;
  sourceSurplusAfterFloorsCents?: MoneyCents;
}

export interface ForecastResult {
  mode: ForecastMode;
  startDate: PlainDateString;
  endDate: PlainDateString;
  days: DailyForecast[];
  consolidatedTroughCents: MoneyCents;
  consolidatedTroughDate: PlainDateString;
  consolidatedTroughEventIds: string[];
  accountTroughs: AccountTrough[];
  accountShortfalls: AccountShortfall[];
  transferNeeds: TransferNeed[];
  effectiveHardFloorCents: MoneyCents;
  effectivePreferredFloorCents?: MoneyCents;
  accountHardFloorTotalCents: MoneyCents;
  accountPreferredFloorTotalCents?: MoneyCents;
  hardFloorMarginCents: MoneyCents;
  preferredFloorMarginCents?: MoneyCents;
  dependencies: string[];
  excludedEventIds: string[];
}

export interface ForecastBundle {
  conservative: ForecastResult;
  expected: ForecastResult;
  rawSafeToDeployMarginCents: MoneyCents;
  availableToDeployCents: MoneyCents;
}

const isInactive = (event: ForecastEvent): boolean =>
  event.status === 'cancelled' || event.status === 'skipped';

export const shouldIncludeEvent = (
  event: ForecastEvent,
  mode: ForecastMode,
  includeHypothetical = false,
  includeConfirmedReceivablesConservatively = true,
): boolean => {
  if (event.paymentMethod && event.paymentMethod !== 'cash-account') return false;
  if (isInactive(event)) return false;
  if (event.hypothetical && !event.accepted && !includeHypothetical) return false;
  // Uncertain cash leaving is still a risk; uncertain cash arriving is not a safe funding source.
  if (event.direction === 'outflow') return true;
  if (mode === 'expected') return event.certainty !== 'uncertain';
  if (event.certainty !== 'confirmed' || event.includeInConservative === false) return false;
  if (event.kind === 'receivable-settlement') {
    return includeConfirmedReceivablesConservatively;
  }
  if (event.kind === 'reward-deposit')
    return event.status === 'confirmed' || event.status === 'paid';
  return true;
};

const eventOrder = (event: ForecastEvent): number => {
  if (event.manualOrder !== undefined) return event.manualOrder;
  const kindOrder: Record<ForecastEvent['kind'], number> = {
    'direct-commitment': 100,
    payable: 110,
    'transfer-debit': 120,
    'card-payment': 130,
    'loan-payment': 140,
    'baseline-spending': 150,
    'investment-contribution': 160,
    scenario: 170,
    income: 300,
    'transfer-credit': 310,
    'receivable-settlement': 320,
    'reward-deposit': 330,
    'manual-adjustment': event.direction === 'outflow' ? 180 : 340,
  };
  return kindOrder[event.kind];
};

const sortEvents = (events: ForecastEvent[]): ForecastEvent[] =>
  [...events].sort((left, right) => {
    const dateComparison = compareDates(left.date, right.date);
    if (dateComparison !== 0) return dateComparison;
    const orderComparison = eventOrder(left) - eventOrder(right);
    return orderComparison !== 0 ? orderComparison : left.id.localeCompare(right.id);
  });

export interface EffectiveCashFloorPolicy {
  configuredHardFloorCents: MoneyCents;
  configuredPreferredFloorCents?: MoneyCents;
  accountHardFloorTotalCents: MoneyCents;
  accountPreferredFloorTotalCents?: MoneyCents;
  effectiveHardFloorCents: MoneyCents;
  effectivePreferredFloorCents?: MoneyCents;
}

/**
 * Account minima are the primary guardrails. The consolidated override remains available for a
 * larger shared reserve and, importantly, keeps existing profiles from changing merely because
 * account-level controls become visible.
 */
export const deriveEffectiveCashFloorPolicy = (input: {
  accounts: CashAccount[];
  policy: CashFloorPolicy;
}): EffectiveCashFloorPolicy => {
  const accounts = input.accounts
    .map((account) => cashAccountSchema.parse(account))
    .filter((account) => account.includedInLiquidity);
  const policy = cashFloorPolicySchema.parse(input.policy);
  const accountHardFloorTotalCents = moneyCentsSchema.parse(
    accounts.reduce((total, account) => total + (account.hardFloorCents ?? 0), 0),
  );
  const hasPreferredAccountFloor = accounts.some(
    (account) => account.preferredFloorCents !== undefined,
  );
  const accountPreferredFloorTotalCents = hasPreferredAccountFloor
    ? moneyCentsSchema.parse(
        accounts.reduce(
          (total, account) => total + (account.preferredFloorCents ?? account.hardFloorCents ?? 0),
          0,
        ),
      )
    : undefined;
  const effectiveHardFloorCents = moneyCentsSchema.parse(
    Math.max(policy.hardConsolidatedFloorCents, accountHardFloorTotalCents),
  );
  const preferredCandidates = [
    policy.preferredConsolidatedFloorCents,
    accountPreferredFloorTotalCents,
  ].filter((value): value is number => value !== undefined);
  const effectivePreferredFloorCents =
    preferredCandidates.length === 0
      ? undefined
      : moneyCentsSchema.parse(Math.max(effectiveHardFloorCents, ...preferredCandidates));
  return {
    configuredHardFloorCents: policy.hardConsolidatedFloorCents,
    configuredPreferredFloorCents: policy.preferredConsolidatedFloorCents,
    accountHardFloorTotalCents,
    accountPreferredFloorTotalCents,
    effectiveHardFloorCents,
    effectivePreferredFloorCents,
  };
};

export const buildForecast = (input: {
  accounts: CashAccount[];
  events: ForecastEvent[];
  policy: CashFloorPolicy;
  startDate: PlainDateString;
  endDate?: PlainDateString;
  mode: ForecastMode;
  includeHypothetical?: boolean;
}): ForecastResult => {
  const accounts = input.accounts.map((account) => cashAccountSchema.parse(account));
  const events = input.events.map((event) => forecastEventSchema.parse(event));
  assertNoDoubleCountRisks(events);
  const policy = cashFloorPolicySchema.parse(input.policy);
  const effectiveFloors = deriveEffectiveCashFloorPolicy({ accounts, policy });
  if (accounts.length === 0) throw new Error('At least one cash account is required');
  const userIds = new Set(accounts.map((account) => account.userId));
  if (userIds.size !== 1 || events.some((event) => !userIds.has(event.userId))) {
    throw new Error('Forecast inputs must belong to exactly one user');
  }

  const endDate = input.endDate ?? addDays(input.startDate, policy.horizonDays - 1);
  const dates = enumerateDates(input.startDate, endDate);
  if (dates.length === 0) throw new Error('Forecast end date must be on or after start date');

  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  for (const event of events) {
    if (!accountsById.has(event.accountId))
      throw new Error(`Unknown account for event ${event.id}`);
  }

  const includedEvents = sortEvents(
    events.filter(
      (event) =>
        compareDates(event.date, input.startDate) >= 0 &&
        compareDates(event.date, endDate) <= 0 &&
        // A dated opening balance already includes activity through its as-of date.
        // Earlier events are history for that account, not forecast movements.
        compareDates(event.date, accountsById.get(event.accountId)!.balanceAsOf) > 0 &&
        shouldIncludeEvent(
          event,
          input.mode,
          input.includeHypothetical,
          policy.includeConfirmedReceivablesConservatively,
        ),
    ),
  );
  const includedIds = new Set(includedEvents.map((event) => event.id));
  const excludedEventIds = events
    .filter((event) => !includedIds.has(event.id))
    .map((event) => event.id);
  const eventsByDate = new Map<PlainDateString, ForecastEvent[]>();
  for (const event of includedEvents) {
    const dayEvents = eventsByDate.get(event.date) ?? [];
    dayEvents.push(event);
    eventsByDate.set(event.date, dayEvents);
  }

  const balances = new Map(
    accounts.map((account) => [
      account.id,
      compareDates(account.balanceAsOf, input.startDate) <= 0 ? account.openingBalanceCents : 0,
    ]),
  );
  const inTransitByTransferId = new Map<string, MoneyCents>();
  const transferGroups = new Map<string, ForecastEvent[]>();
  for (const event of events) {
    if (!event.transferId) continue;
    const group = transferGroups.get(event.transferId) ?? [];
    group.push(event);
    transferGroups.set(event.transferId, group);
  }
  for (const [transferId, group] of transferGroups) {
    const debit = group.find((event) => event.kind === 'transfer-debit');
    const credit = group.find((event) => event.kind === 'transfer-credit');
    if (
      debit &&
      credit &&
      !includedIds.has(debit.id) &&
      includedIds.has(credit.id) &&
      compareDates(debit.date, credit.date) <= 0 &&
      shouldIncludeEvent(
        debit,
        input.mode,
        input.includeHypothetical,
        policy.includeConfirmedReceivablesConservatively,
      )
    ) {
      inTransitByTransferId.set(transferId, debit.amountCents);
    }
  }
  const days: DailyForecast[] = [];
  const shortfallMap = new Map<string, AccountShortfall>();
  const dependencies = new Set<string>();

  for (const date of dates) {
    for (const account of accounts) {
      if (account.balanceAsOf === date) balances.set(account.id, account.openingBalanceCents);
    }
    const openingBalances = new Map(balances);
    const appliedByAccount = new Map(accounts.map((account) => [account.id, [] as string[]]));
    const minimumBalances = new Map(balances);
    const minimumEventsByAccount = new Map(accounts.map((account) => [account.id, [] as string[]]));
    const dayEvents = eventsByDate.get(date) ?? [];

    const consolidated = (): MoneyCents =>
      addCents(
        ...accounts
          .filter(
            (account) =>
              account.includedInLiquidity && compareDates(date, account.balanceAsOf) >= 0,
          )
          .map((account) => balances.get(account.id)!),
        ...inTransitByTransferId.values(),
      );
    let minimumConsolidatedCashCents = consolidated();
    let minimumConsolidatedEventIds: string[] = [];

    const recordShortfall = (account: CashAccount, eventIds: string[]): void => {
      if (compareDates(date, account.balanceAsOf) < 0) return;
      const balance = balances.get(account.id)!;
      const floor = account.hardFloorCents ?? 0;
      if (balance >= floor) return;
      const key = `${account.id}:${date}`;
      const previous = shortfallMap.get(key);
      if (previous && previous.balanceCents <= balance) return;
      shortfallMap.set(key, {
        accountId: account.id,
        date,
        balanceCents: balance,
        floorCents: floor,
        shortfallCents: moneyCentsSchema.parse(floor - balance),
        eventIds: [...eventIds],
      });
    };

    for (const account of accounts) recordShortfall(account, []);
    for (const event of dayEvents) {
      const current = balances.get(event.accountId)!;
      const signedAmount = event.direction === 'inflow' ? event.amountCents : -event.amountCents;
      const next = moneyCentsSchema.parse(current + signedAmount);
      balances.set(event.accountId, next);
      if (event.transferId && event.kind === 'transfer-debit') {
        inTransitByTransferId.set(
          event.transferId,
          moneyCentsSchema.parse(
            (inTransitByTransferId.get(event.transferId) ?? 0) + event.amountCents,
          ),
        );
      } else if (event.transferId && event.kind === 'transfer-credit') {
        const remaining = moneyCentsSchema.parse(
          (inTransitByTransferId.get(event.transferId) ?? 0) - event.amountCents,
        );
        if (remaining === 0) inTransitByTransferId.delete(event.transferId);
        else inTransitByTransferId.set(event.transferId, remaining);
      }
      appliedByAccount.get(event.accountId)!.push(event.id);
      if (next < minimumBalances.get(event.accountId)!) {
        minimumBalances.set(event.accountId, next);
        minimumEventsByAccount.set(event.accountId, [...appliedByAccount.get(event.accountId)!]);
      }
      const account = accountsById.get(event.accountId)!;
      recordShortfall(account, appliedByAccount.get(event.accountId)!);
      const currentConsolidated = consolidated();
      if (currentConsolidated < minimumConsolidatedCashCents) {
        minimumConsolidatedCashCents = currentConsolidated;
        minimumConsolidatedEventIds = dayEvents
          .slice(0, dayEvents.indexOf(event) + 1)
          .map((candidate) => candidate.id);
      }
      if (event.certainty !== 'confirmed') dependencies.add(event.id);
    }

    const accountBalances: DailyAccountBalance[] = accounts.map((account) => {
      const endingBalance = balances.get(account.id)!;
      const floor = account.hardFloorCents ?? 0;
      return {
        accountId: account.id,
        openingBalanceCents: openingBalances.get(account.id)!,
        minimumBalanceCents: minimumBalances.get(account.id)!,
        endingBalanceCents: endingBalance,
        hardFloorCents: floor,
        preferredFloorCents: account.preferredFloorCents,
        minimumEventIds: minimumEventsByAccount.get(account.id)!,
        appliedEventIds: appliedByAccount.get(account.id)!,
      };
    });

    const consolidatedCashCents = addCents(
      ...accountBalances
        .filter(({ accountId }) => {
          const account = accountsById.get(accountId)!;
          return account.includedInLiquidity && compareDates(date, account.balanceAsOf) >= 0;
        })
        .map((account) => account.endingBalanceCents),
      ...inTransitByTransferId.values(),
    );
    days.push({
      date,
      accounts: accountBalances,
      inTransitCents: moneyCentsSchema.parse(
        [...inTransitByTransferId.values()].reduce((total, amount) => total + amount, 0),
      ),
      minimumConsolidatedCashCents,
      consolidatedCashCents,
      minimumConsolidatedEventIds,
      appliedEventIds: dayEvents.map((event) => event.id),
    });
  }

  const consolidatedTrough = days.reduce((lowest, day) =>
    day.minimumConsolidatedCashCents < lowest.minimumConsolidatedCashCents ? day : lowest,
  );
  const accountTroughs = accounts.map((account) => {
    const activeDays = days.filter((day) => compareDates(day.date, account.balanceAsOf) >= 0);
    const lowest = (activeDays.length > 0 ? activeDays : days).reduce((current, day) => {
      const balance = day.accounts.find((candidate) => candidate.accountId === account.id)!;
      const currentBalance = current.accounts.find(
        (candidate) => candidate.accountId === account.id,
      )!;
      return balance.minimumBalanceCents < currentBalance.minimumBalanceCents ? day : current;
    });
    const detail = lowest.accounts.find((candidate) => candidate.accountId === account.id)!;
    return {
      accountId: account.id,
      balanceCents: detail.minimumBalanceCents,
      date: lowest.date,
      eventIds: detail.minimumEventIds,
    };
  });

  const accountShortfalls = [...shortfallMap.values()];
  const shortfallsByAccount = new Map<string, AccountShortfall[]>();
  for (const shortfall of accountShortfalls) {
    const entries = shortfallsByAccount.get(shortfall.accountId) ?? [];
    entries.push(shortfall);
    shortfallsByAccount.set(shortfall.accountId, entries);
  }
  const consolidatedTransferNeeds = [...shortfallsByAccount.entries()]
    .map(([accountId, shortfalls]) => {
      const earliest = [...shortfalls].sort((left, right) =>
        compareDates(left.date, right.date),
      )[0]!;
      const deepest = shortfalls.reduce((largest, candidate) =>
        candidate.shortfallCents > largest.shortfallCents ? candidate : largest,
      );
      return {
        accountId,
        earliest,
        deepest,
        horizonRequiredCents: deepest.shortfallCents,
      };
    })
    .sort(
      (left, right) =>
        compareDates(left.earliest.date, right.earliest.date) ||
        left.accountId.localeCompare(right.accountId),
    );
  const sourceReservations = new Map<
    string,
    Array<{ initiationDate: PlainDateString; amountCents: MoneyCents }>
  >();
  const transferNeeds = consolidatedTransferNeeds.map(
    ({ accountId, earliest, deepest, horizonRequiredCents }) => {
      const candidates = accounts
        .filter((account) => account.id !== accountId && account.canFundOtherAccounts)
        .flatMap((account) => {
          // Arrive one day before the first modeled breach so conservative same-day ordering never
          // assumes an outflow can be cured by a later untimed transfer credit.
          const arrivalDate = addDays(earliest.date, -1);
          const initiationDate = addDays(arrivalDate, -account.transferDelayDays);
          if (
            compareDates(initiationDate, input.startDate) < 0 ||
            compareDates(initiationDate, account.balanceAsOf) < 0
          ) {
            return [];
          }
          const activeDays = days.filter((day) => compareDates(day.date, initiationDate) >= 0);
          if (activeDays.length === 0) return [];
          const reservations = sourceReservations.get(account.id) ?? [];
          const sourceSurplusAfterFloorsCents = activeDays.reduce((lowest, day) => {
            const balance = day.accounts.find((candidate) => candidate.accountId === account.id)!;
            const reservedCents = reservations.reduce(
              (total, reservation) =>
                compareDates(reservation.initiationDate, day.date) <= 0
                  ? total + reservation.amountCents
                  : total,
              0,
            );
            return Math.min(
              lowest,
              balance.minimumBalanceCents -
                (account.hardFloorCents ?? 0) -
                reservedCents -
                horizonRequiredCents,
            );
          }, Number.POSITIVE_INFINITY);
          if (sourceSurplusAfterFloorsCents < 0) return [];
          return [
            {
              account,
              arrivalDate,
              initiationDate,
              sourceSurplusAfterFloorsCents: moneyCentsSchema.parse(sourceSurplusAfterFloorsCents),
            },
          ];
        })
        .sort(
          (left, right) =>
            left.account.transferDelayDays - right.account.transferDelayDays ||
            right.sourceSurplusAfterFloorsCents - left.sourceSurplusAfterFloorsCents,
        );
      const source = candidates[0];
      if (source) {
        const reservations = sourceReservations.get(source.account.id) ?? [];
        // Reserve the account's full horizon requirement so a later recommendation cannot
        // double-promise the same source capacity. The action returned below remains the
        // smaller, dated amount needed to cure the first breach.
        reservations.push({
          initiationDate: source.initiationDate,
          amountCents: horizonRequiredCents,
        });
        sourceReservations.set(source.account.id, reservations);
      }
      return {
        ...earliest,
        horizonDeepestShortfallCents: deepest.shortfallCents,
        horizonDeepestShortfallDate: deepest.date,
        horizonAdditionalShortfallCents: moneyCentsSchema.parse(
          deepest.shortfallCents - earliest.shortfallCents,
        ),
        suggestedSourceAccountId: source?.account.id,
        initiationDate: source?.initiationDate,
        arrivalDate: source?.arrivalDate,
        sourceSurplusAfterFloorsCents: source?.sourceSurplusAfterFloorsCents,
      };
    },
  );

  return {
    mode: input.mode,
    startDate: input.startDate,
    endDate,
    days,
    consolidatedTroughCents: consolidatedTrough.minimumConsolidatedCashCents,
    consolidatedTroughDate: consolidatedTrough.date,
    consolidatedTroughEventIds: consolidatedTrough.minimumConsolidatedEventIds,
    accountTroughs,
    accountShortfalls,
    transferNeeds,
    effectiveHardFloorCents: effectiveFloors.effectiveHardFloorCents,
    effectivePreferredFloorCents: effectiveFloors.effectivePreferredFloorCents,
    accountHardFloorTotalCents: effectiveFloors.accountHardFloorTotalCents,
    accountPreferredFloorTotalCents: effectiveFloors.accountPreferredFloorTotalCents,
    hardFloorMarginCents: moneyCentsSchema.parse(
      consolidatedTrough.minimumConsolidatedCashCents - effectiveFloors.effectiveHardFloorCents,
    ),
    preferredFloorMarginCents:
      effectiveFloors.effectivePreferredFloorCents === undefined
        ? undefined
        : moneyCentsSchema.parse(
            consolidatedTrough.minimumConsolidatedCashCents -
              effectiveFloors.effectivePreferredFloorCents,
          ),
    dependencies: [...dependencies],
    excludedEventIds,
  };
};

export const buildForecastBundle = (
  input: Omit<Parameters<typeof buildForecast>[0], 'mode'>,
): ForecastBundle => {
  const conservative = buildForecast({ ...input, mode: 'conservative' });
  const expected = buildForecast({ ...input, mode: 'expected' });
  const rawSafeToDeployMarginCents = conservative.hardFloorMarginCents;
  const hasUnresolvedFunding = conservative.transferNeeds.some(
    (need) => !need.suggestedSourceAccountId,
  );
  return {
    conservative,
    expected,
    rawSafeToDeployMarginCents,
    availableToDeployCents: hasUnresolvedFunding ? 0 : Math.max(0, rawSafeToDeployMarginCents),
  };
};
