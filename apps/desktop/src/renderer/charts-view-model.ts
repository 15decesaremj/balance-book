import Decimal from 'decimal.js';
import { Temporal } from '@js-temporal/polyfill';
import {
  compareDates,
  daysBetween,
  moneyCentsSchema,
  plainDateSchema,
  type CreditCard,
  type CreditCardCycle,
  type PlainDateString,
} from '@balance-book/domain';
import {
  activeLoansForDate,
  enrichCardCyclesWithActivities,
  generateCardCyclesThroughHorizon,
  materializeCommittedRefinanceEvents,
  projectAssetsAtDate,
  projectCardDebtSchedule,
  resolveCardCyclesAsOf,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';
import type { ForecastSnapshotDto, ManagedRecordsDto } from '../shared/contracts';

export type ChartsCategory = 'position' | 'cash' | 'cards' | 'loans' | 'assets' | 'owed';
export type ChartsPointProvenance = 'observed' | 'reported' | 'valuation' | 'projected' | 'modeled';

export interface ChartsPoint {
  date: PlainDateString;
  cents: number;
  provenance: ChartsPointProvenance;
}

export interface ChartsSeries {
  id: string;
  label: string;
  category: ChartsCategory;
  points: ChartsPoint[];
}

export interface ChartsTrajectory {
  startDate: PlainDateString;
  endDate: PlainDateString;
  startCents: number;
  endCents: number;
  changeCents: number;
}

export interface ChartsViewModel {
  asOfDate: PlainDateString;
  windowStartDate: PlainDateString;
  windowEndDate: PlainDateString;
  actualEndDate: PlainDateString;
  series: ChartsSeries[];
  metrics: {
    rangeLowCents: number | null;
    rangeHighCents: number | null;
    averageMonthlyOwedCents: number | null;
    averageMonthlyCardBalanceCents: number | null;
    averageMonthlyCarryCents: number | null;
    currentCarryCents: number;
    totalPositionTrajectory: ChartsTrajectory | null;
    netWorthTrajectory: ChartsTrajectory | null;
  };
  availabilityNotes: string[];
}

export interface BuildChartsViewModelInput {
  records: ManagedRecordsDto;
  forecast: ForecastSnapshotDto;
  asOfDate?: PlainDateString;
  historyMonths?: number;
  futureMonths?: number;
  experimentalCardInterestForecastEnabled?: boolean;
}

const toDate = (value: PlainDateString): Temporal.PlainDate => Temporal.PlainDate.from(value);
const toDateString = (value: Temporal.PlainDate): PlainDateString =>
  plainDateSchema.parse(value.toString());
const monthKey = (date: PlainDateString): string => date.slice(0, 7);
const inRange = (
  date: PlainDateString,
  startDate: PlainDateString,
  endDate: PlainDateString,
): boolean => compareDates(date, startDate) >= 0 && compareDates(date, endDate) <= 0;

const averageCents = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return new Decimal(values.reduce((total, value) => total.plus(value), new Decimal(0)))
    .div(values.length)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
};

const monthEndDates = (startDate: PlainDateString, endDate: PlainDateString): PlainDateString[] => {
  const start = toDate(startDate).with({ day: 1 });
  const end = toDate(endDate);
  const dates: PlainDateString[] = [];
  for (
    let cursor = start;
    Temporal.PlainDate.compare(cursor, end) <= 0;
    cursor = cursor.add({ months: 1 })
  ) {
    const endOfMonth = cursor.add({ months: 1 }).subtract({ days: 1 });
    const constrained = Temporal.PlainDate.compare(endOfMonth, end) > 0 ? end : endOfMonth;
    if (Temporal.PlainDate.compare(constrained, toDate(startDate)) >= 0) {
      dates.push(toDateString(constrained));
    }
  }
  return dates;
};

const provenanceRank: Record<ChartsPointProvenance, number> = {
  observed: 5,
  reported: 4,
  valuation: 4,
  modeled: 2,
  projected: 1,
};

const normalizePoints = (points: ChartsPoint[]): ChartsPoint[] => {
  const byDate = new Map<PlainDateString, ChartsPoint>();
  for (const point of points) {
    const existing = byDate.get(point.date);
    if (!existing || provenanceRank[point.provenance] >= provenanceRank[existing.provenance]) {
      byDate.set(point.date, point);
    }
  }
  return [...byDate.values()].sort((left, right) => compareDates(left.date, right.date));
};

const latestPointOnOrBefore = (
  points: readonly ChartsPoint[],
  date: PlainDateString,
): ChartsPoint | undefined => {
  let result: ChartsPoint | undefined;
  for (const point of points) {
    if (compareDates(point.date, date) > 0) break;
    result = point;
  }
  return result;
};

const groupMonthlyAverage = (points: readonly ChartsPoint[]): number | null => {
  const months = new Map<string, number[]>();
  for (const point of points) {
    months.set(monthKey(point.date), [...(months.get(monthKey(point.date)) ?? []), point.cents]);
  }
  const monthlyAverages = [...months.values()].flatMap((values) => {
    const average = averageCents(values);
    return average === null ? [] : [average];
  });
  return averageCents(monthlyAverages);
};

const paidCycleCarryCents = (cycle: CreditCardCycle): number => {
  if (cycle.state !== 'paid' || cycle.lockedStatementCents === undefined) return 0;
  // Paid legacy rows intentionally mean paid in full when no actual amount was recorded.
  const paidCents = cycle.actualPaymentCents ?? cycle.lockedStatementCents;
  return moneyCentsSchema.nonnegative().parse(Math.max(0, cycle.lockedStatementCents - paidCents));
};

export const calculateAverageMonthlyCarryCents = (input: {
  cycles: CreditCardCycle[];
  startDate: PlainDateString;
  endDate: PlainDateString;
  asOfDate?: PlainDateString;
  currentCarryCentsByCard?: Readonly<Record<string, number>>;
  currentCarryCents?: number;
  projectedCarryPointsByCard?: Readonly<
    Record<string, readonly { date: PlainDateString; cents: number }[]>
  >;
}): number | null => {
  const monthEnds = monthEndDates(input.startDate, input.endDate);
  const paidCycles = input.cycles
    .filter(
      (cycle) =>
        cycle.state === 'paid' && compareDates(cycle.paymentOn ?? cycle.dueOn, input.endDate) <= 0,
    )
    .sort((left, right) => {
      const dateOrder = compareDates(left.paymentOn ?? left.dueOn, right.paymentOn ?? right.dueOn);
      if (dateOrder !== 0) return dateOrder;
      const closeOrder = compareDates(left.closesOn, right.closesOn);
      return closeOrder !== 0 ? closeOrder : left.id.localeCompare(right.id);
    });

  const asOfDate = input.asOfDate === undefined ? undefined : plainDateSchema.parse(input.asOfDate);
  const currentCarryEntries = Object.entries(input.currentCarryCentsByCard ?? {}).map(
    ([cardId, carryCents]) => [cardId, moneyCentsSchema.nonnegative().parse(carryCents)] as const,
  );
  if (
    currentCarryEntries.length === 0 &&
    input.currentCarryCents !== undefined &&
    input.currentCarryCents > 0
  ) {
    currentCarryEntries.push([
      'current-carry-total',
      moneyCentsSchema.nonnegative().parse(input.currentCarryCents),
    ]);
  }
  if (monthEnds.length === 0) {
    return input.currentCarryCents === undefined
      ? null
      : moneyCentsSchema.nonnegative().parse(input.currentCarryCents);
  }

  // Carry is a balance, not a one-month event. Each paid statement replaces the residual for that
  // card because a newer locked statement already includes any older unpaid amount. The latest
  // residual therefore remains in every later month until another paid statement reduces or clears
  // it. Tracking cards independently prevents one card's paid-in-full cycle from clearing another's
  // carry.
  const timeline: Array<
    | { date: PlainDateString; type: 'cycle'; cycle: CreditCardCycle }
    | { date: PlainDateString; type: 'current-snapshot' }
    | { date: PlainDateString; type: 'projected'; cardId: string; cents: number }
  > = paidCycles.map((cycle) => ({
    date: cycle.paymentOn ?? cycle.dueOn,
    type: 'cycle' as const,
    cycle,
  }));
  if (asOfDate !== undefined && currentCarryEntries.length > 0) {
    timeline.push({ date: asOfDate, type: 'current-snapshot' });
  }
  for (const [cardId, points] of Object.entries(input.projectedCarryPointsByCard ?? {})) {
    for (const point of points) {
      timeline.push({
        date: plainDateSchema.parse(point.date),
        type: 'projected',
        cardId,
        cents: moneyCentsSchema.nonnegative().parse(point.cents),
      });
    }
  }
  const timelineTypeRank = { cycle: 0, 'current-snapshot': 1, projected: 2 } as const;
  timeline.sort(
    (left, right) =>
      compareDates(left.date, right.date) ||
      timelineTypeRank[left.type] - timelineTypeRank[right.type],
  );

  const carryByCard = new Map<string, number>();
  const monthlyTotals: number[] = [];
  let timelineIndex = 0;
  for (const monthEnd of monthEnds) {
    while (timelineIndex < timeline.length) {
      const item = timeline[timelineIndex]!;
      if (compareDates(item.date, monthEnd) > 0) break;
      if (item.type === 'cycle') {
        carryByCard.set(item.cycle.cardId, paidCycleCarryCents(item.cycle));
      } else if (item.type === 'current-snapshot') {
        carryByCard.clear();
        for (const [cardId, carryCents] of currentCarryEntries) {
          carryByCard.set(cardId, carryCents);
        }
      } else {
        carryByCard.set(item.cardId, item.cents);
      }
      timelineIndex += 1;
    }
    monthlyTotals.push(
      moneyCentsSchema
        .nonnegative()
        .parse([...carryByCard.values()].reduce((total, carryCents) => total + carryCents, 0)),
    );
  }
  return averageCents(monthlyTotals);
};

const historicalCycleAmount = (cycle: CreditCardCycle): number | null => {
  if (cycle.lockedStatementCents !== undefined) return cycle.lockedStatementCents;
  if (cycle.actualActivityCents > 0) return cycle.actualActivityCents;
  return null;
};

interface CardDebtProjection {
  balancePoints: ChartsPoint[];
  netLiabilityPoints: ChartsPoint[];
  carryPoints: Array<{ date: PlainDateString; cents: number }>;
  currentBalanceCents: number;
  currentCarryCents: number;
}

const projectCardDebtTimeline = (input: {
  card: CreditCard;
  records: ManagedRecordsDto;
  materializedEvents: ManagedRecordsDto['events'];
  asOfDate: PlainDateString;
  endDate: PlainDateString;
  includeCardInterest: boolean;
  currentDebtOverride?: { currentBalanceCents: number; carryingBalanceCents: number };
}): CardDebtProjection => {
  const storedCycles = input.records.cardCycles.filter((cycle) => cycle.cardId === input.card.id);
  const generatedCycles = generateCardCyclesThroughHorizon({
    card: input.card,
    cardCycles: storedCycles,
    startDate: input.asOfDate,
    endDate: input.endDate,
  });
  const effectiveCycles = enrichCardCyclesWithActivities({
    cardCycles: resolveCardCyclesAsOf({
      cardCycles: generatedCycles,
      asOfDate: input.asOfDate,
    }),
    cardActivities: input.records.events,
    cards: [input.card],
    endDate: input.endDate,
  });
  const cycleIds = new Set(effectiveCycles.map((cycle) => cycle.id));
  const scheduledPayments = input.materializedEvents.flatMap((event) => {
    if (
      event.cardId !== input.card.id ||
      event.kind !== 'card-payment' ||
      event.direction !== 'outflow' ||
      event.paymentMethod !== 'cash-account' ||
      event.status === 'cancelled' ||
      event.status === 'skipped' ||
      (event.hypothetical && !event.accepted)
    ) {
      return [];
    }
    return [
      {
        id: event.id,
        date: event.date,
        amountCents: event.amountCents,
        status: event.status,
        ...(event.recurrenceRule === undefined &&
        event.sourceRecordId !== undefined &&
        cycleIds.has(event.sourceRecordId)
          ? { cycleId: event.sourceRecordId }
          : {}),
      },
    ];
  });
  const currentDebt = summarizeRevolvingDebt({
    card: input.card,
    cycles: storedCycles,
    events: input.records.events,
    asOfDate: input.asOfDate,
  });
  const currentBalanceCents = moneyCentsSchema
    .nonnegative()
    .parse(input.currentDebtOverride?.currentBalanceCents ?? currentDebt.currentBalanceCents);
  const currentCarryCents = moneyCentsSchema
    .nonnegative()
    .parse(input.currentDebtOverride?.carryingBalanceCents ?? currentDebt.carryingBalanceCents);
  const openingCarryingCents =
    currentCarryCents > 0
      ? currentCarryCents
      : input.card.accountKind === 'line-of-credit'
        ? currentBalanceCents
        : 0;
  const schedule = projectCardDebtSchedule({
    card: input.card,
    cardCycles: effectiveCycles,
    asOfDate: input.asOfDate,
    includeInterest: input.includeCardInterest,
    ...(openingCarryingCents > 0
      ? {
          openingCarryingBalance: {
            cents: openingCarryingCents,
            asOfDate: input.asOfDate,
          },
        }
      : {}),
    scheduledPayments,
  });

  const paymentEvents = input.materializedEvents.filter(
    (event) =>
      event.cardId === input.card.id &&
      event.kind === 'card-payment' &&
      event.direction === 'outflow' &&
      event.paymentMethod === 'cash-account' &&
      event.status !== 'cancelled' &&
      event.status !== 'skipped' &&
      (!event.hypothetical || event.accepted) &&
      compareDates(event.date, input.asOfDate) > 0 &&
      compareDates(event.date, input.endDate) <= 0,
  );
  const debtOperations: Array<
    | { date: PlainDateString; type: 'close'; cents: number }
    | { date: PlainDateString; type: 'payment'; cents: number }
    | { date: PlainDateString; type: 'scheduled-balance'; cents: number }
  > = [
    ...schedule.flatMap((entry) =>
      compareDates(entry.cycle.closesOn, input.asOfDate) > 0 &&
      compareDates(entry.cycle.closesOn, input.endDate) <= 0
        ? [
            {
              date: entry.cycle.closesOn,
              type: 'close' as const,
              cents: entry.obligationCents,
            },
          ]
        : [],
    ),
    ...paymentEvents.map((event) => ({
      date: event.date,
      type: 'payment' as const,
      cents: event.amountCents,
    })),
    ...schedule.flatMap((entry) => {
      const paymentDate = entry.cycle.paymentOn ?? entry.cycle.dueOn;
      return compareDates(paymentDate, input.asOfDate) > 0 &&
        compareDates(paymentDate, input.endDate) <= 0 &&
        (entry.obligationCents > 0 ||
          entry.paymentCents > 0 ||
          entry.carryingBalanceAfterPaymentCents > 0 ||
          entry.balanceCreditAfterPaymentCents > 0)
        ? [
            {
              date: paymentDate,
              type: 'scheduled-balance' as const,
              cents: entry.carryingBalanceAfterPaymentCents,
            },
          ]
        : [];
    }),
  ].sort(
    (left, right) =>
      compareDates(left.date, right.date) ||
      ({ close: 0, payment: 1, 'scheduled-balance': 2 } as const)[left.type] -
        ({ close: 0, payment: 1, 'scheduled-balance': 2 } as const)[right.type],
  );
  const balancePoints: ChartsPoint[] = [
    { date: input.asOfDate, cents: currentBalanceCents, provenance: 'reported' },
  ];
  let debtCents = currentBalanceCents;
  for (let index = 0; index < debtOperations.length;) {
    const date = debtOperations[index]!.date;
    while (index < debtOperations.length && debtOperations[index]!.date === date) {
      const operation = debtOperations[index]!;
      debtCents =
        operation.type === 'close'
          ? operation.cents
          : operation.type === 'scheduled-balance'
            ? operation.cents
            : moneyCentsSchema.nonnegative().parse(Math.max(0, debtCents - operation.cents));
      index += 1;
    }
    balancePoints.push({ date, cents: debtCents, provenance: 'modeled' });
  }

  const netLiabilityOperations: Array<
    | { date: PlainDateString; type: 'close'; cents: number }
    | { date: PlainDateString; type: 'payment'; cents: number }
    | { date: PlainDateString; type: 'scheduled-balance'; cents: number }
  > = [
    ...schedule.flatMap((entry) => {
      const creditBeforePaymentCents = moneyCentsSchema
        .nonnegative()
        .parse(Math.max(0, entry.balanceCreditAfterPaymentCents - entry.excessPaymentCents));
      return compareDates(entry.cycle.closesOn, input.asOfDate) > 0 &&
        compareDates(entry.cycle.closesOn, input.endDate) <= 0
        ? [
            {
              date: entry.cycle.closesOn,
              type: 'close' as const,
              cents: entry.obligationCents - creditBeforePaymentCents,
            },
          ]
        : [];
    }),
    ...paymentEvents.map((event) => ({
      date: event.date,
      type: 'payment' as const,
      cents: event.amountCents,
    })),
    ...schedule.flatMap((entry) => {
      const paymentDate = entry.cycle.paymentOn ?? entry.cycle.dueOn;
      return compareDates(paymentDate, input.asOfDate) > 0 &&
        compareDates(paymentDate, input.endDate) <= 0 &&
        (entry.obligationCents > 0 ||
          entry.paymentCents > 0 ||
          entry.carryingBalanceAfterPaymentCents > 0 ||
          entry.balanceCreditAfterPaymentCents > 0)
        ? [
            {
              date: paymentDate,
              type: 'scheduled-balance' as const,
              cents: entry.carryingBalanceAfterPaymentCents - entry.balanceCreditAfterPaymentCents,
            },
          ]
        : [];
    }),
  ].sort(
    (left, right) =>
      compareDates(left.date, right.date) ||
      ({ close: 0, payment: 1, 'scheduled-balance': 2 } as const)[left.type] -
        ({ close: 0, payment: 1, 'scheduled-balance': 2 } as const)[right.type],
  );
  const netLiabilityPoints: ChartsPoint[] = [
    { date: input.asOfDate, cents: currentBalanceCents, provenance: 'reported' },
  ];
  let netLiabilityCents = currentBalanceCents;
  for (let index = 0; index < netLiabilityOperations.length;) {
    const date = netLiabilityOperations[index]!.date;
    while (index < netLiabilityOperations.length && netLiabilityOperations[index]!.date === date) {
      const operation = netLiabilityOperations[index]!;
      netLiabilityCents =
        operation.type === 'payment' ? netLiabilityCents - operation.cents : operation.cents;
      index += 1;
    }
    netLiabilityPoints.push({ date, cents: netLiabilityCents, provenance: 'modeled' });
  }

  const carryOperations: Array<
    | { date: PlainDateString; type: 'payment'; cents: number }
    | { date: PlainDateString; type: 'scheduled-balance'; cents: number }
  > = [
    ...paymentEvents.map((event) => ({
      date: event.date,
      type: 'payment' as const,
      cents: event.amountCents,
    })),
    ...schedule.flatMap((entry) => {
      const paymentDate = entry.cycle.paymentOn ?? entry.cycle.dueOn;
      return compareDates(paymentDate, input.asOfDate) > 0 &&
        compareDates(paymentDate, input.endDate) <= 0 &&
        (entry.obligationCents > 0 ||
          entry.paymentCents > 0 ||
          entry.carryingBalanceAfterPaymentCents > 0)
        ? [
            {
              date: paymentDate,
              type: 'scheduled-balance' as const,
              cents: entry.carryingBalanceAfterPaymentCents,
            },
          ]
        : [];
    }),
  ].sort(
    (left, right) =>
      compareDates(left.date, right.date) ||
      (left.type === right.type ? 0 : left.type === 'payment' ? -1 : 1),
  );
  const carryPoints: Array<{ date: PlainDateString; cents: number }> = [
    { date: input.asOfDate, cents: currentCarryCents },
  ];
  let carryCents = currentCarryCents;
  for (let index = 0; index < carryOperations.length;) {
    const date = carryOperations[index]!.date;
    while (index < carryOperations.length && carryOperations[index]!.date === date) {
      const operation = carryOperations[index]!;
      carryCents =
        operation.type === 'scheduled-balance'
          ? operation.cents
          : moneyCentsSchema.nonnegative().parse(Math.max(0, carryCents - operation.cents));
      index += 1;
    }
    carryPoints.push({ date, cents: carryCents });
  }

  return {
    balancePoints: normalizePoints(balancePoints),
    netLiabilityPoints: normalizePoints(netLiabilityPoints),
    carryPoints,
    currentBalanceCents,
    currentCarryCents,
  };
};

const trajectoryFromPoints = (points: ChartsPoint[]): ChartsTrajectory | null => {
  if (points.length < 2) return null;
  const start = points[0]!;
  const end = points.at(-1)!;
  return {
    startDate: start.date,
    endDate: end.date,
    startCents: start.cents,
    endCents: end.cents,
    changeCents: end.cents - start.cents,
  };
};

export const buildChartsViewModel = (input: BuildChartsViewModelInput): ChartsViewModel => {
  const historyMonths = Math.max(0, Math.min(120, input.historyMonths ?? 12));
  const futureMonths = Math.max(0, Math.min(120, input.futureMonths ?? 12));
  const fallbackDate = input.records.accounts
    .map((account) => account.balanceAsOf)
    .sort(compareDates)
    .at(-1);
  const asOfDate = plainDateSchema.parse(
    input.asOfDate ??
      input.forecast.startDate ??
      fallbackDate ??
      Temporal.Now.plainDateISO().toString(),
  );
  const windowStartDate = toDateString(toDate(asOfDate).subtract({ months: historyMonths }));
  const windowEndDate = toDateString(toDate(asOfDate).add({ months: futureMonths }));
  const dailyCash = (input.forecast.dailyCash ?? [])
    .filter((point) => inRange(point.date, asOfDate, windowEndDate))
    .sort((left, right) => compareDates(left.date, right.date));
  const investmentContributionCentsOnOrBefore = (date: PlainDateString): number =>
    dailyCash
      .filter((day) => compareDates(day.date, date) <= 0)
      .flatMap((day) => day.events)
      .filter(
        (event) =>
          event.kind === 'investment-contribution' &&
          event.direction === 'outflow' &&
          event.includedInExpected,
      )
      .reduce((total, event) => total + event.amountCents, 0);
  const actualEndDate = dailyCash.at(-1)?.date ?? asOfDate;
  const futureSampleDates = [
    asOfDate,
    ...monthEndDates(asOfDate, actualEndDate).filter((date) => date !== asOfDate),
  ];
  const activeLoansByDate = new Map<PlainDateString, ReturnType<typeof activeLoansForDate>>();
  const loansOn = (date: PlainDateString): ReturnType<typeof activeLoansForDate> => {
    const existing = activeLoansByDate.get(date);
    if (existing) return existing;
    const active = activeLoansForDate({
      accounts: input.records.accounts,
      loans: input.records.loans,
      plans: input.records.committedRefinancePlans,
      loanPaymentEvents: input.records.events,
      date,
    });
    activeLoansByDate.set(date, active);
    return active;
  };
  const materializedEvents = materializeCommittedRefinanceEvents({
    accounts: input.records.accounts,
    events: input.records.events,
    cards: input.records.cards,
    cardCycles: input.records.cardCycles,
    loans: input.records.loans,
    plans: input.records.committedRefinancePlans,
    receivables: input.records.receivables,
    includeCardInterest: input.experimentalCardInterestForecastEnabled,
    startDate: asOfDate,
    endDate: actualEndDate,
  });
  const cardDebtProjections = new Map(
    input.records.cards.map((card) => {
      const forecastDebt = input.forecast.revolvingDebtByCard?.find(
        (candidate) => candidate.cardId === card.id,
      );
      return [
        card.id,
        projectCardDebtTimeline({
          card,
          records: input.records,
          materializedEvents,
          includeCardInterest: input.experimentalCardInterestForecastEnabled ?? false,
          asOfDate,
          endDate: actualEndDate,
          ...(forecastDebt === undefined
            ? {}
            : {
                currentDebtOverride: {
                  currentBalanceCents: forecastDebt.currentBalanceCents,
                  carryingBalanceCents: forecastDebt.carryingBalanceCents,
                },
              }),
        }),
      ] as const;
    }),
  );
  const series: ChartsSeries[] = [];
  const addSeries = (
    id: string,
    label: string,
    category: ChartsCategory,
    points: ChartsPoint[],
  ): void => {
    const normalized = normalizePoints(
      points.filter((point) => inRange(point.date, windowStartDate, windowEndDate)),
    );
    if (normalized.length > 0) series.push({ id, label, category, points: normalized });
  };

  addSeries(
    'total-position',
    'Total position',
    'position',
    dailyCash.map((point) => ({
      date: point.date,
      cents: point.expectedPositionCents,
      provenance: 'projected',
    })),
  );
  addSeries(
    'money-owed',
    'Money owed',
    'owed',
    dailyCash.map((point) => ({
      date: point.date,
      cents: point.expectedReceivableCents,
      provenance: 'projected',
    })),
  );

  for (const account of input.records.accounts) {
    const points: ChartsPoint[] = [
      {
        date: account.balanceAsOf,
        cents: account.openingBalanceCents,
        provenance: 'reported',
      },
      ...input.records.reconciliations
        .filter((reconciliation) => reconciliation.accountId === account.id)
        .map((reconciliation) => ({
          date: reconciliation.date,
          cents: reconciliation.actualBalanceCents,
          provenance: 'observed' as const,
        })),
      ...dailyCash.flatMap((point) => {
        const balance = point.accountBalances.find(
          (candidate) => candidate.accountId === account.id,
        );
        return balance?.available
          ? [
              {
                date: point.date,
                cents: balance.expectedCashCents,
                provenance: 'projected' as const,
              },
            ]
          : [];
      }),
    ];
    addSeries(`cash:${account.id}`, account.name, 'cash', points);
  }

  for (const card of input.records.cards) {
    const historicalPoints: ChartsPoint[] = input.records.cardCycles
      .filter((cycle) => cycle.cardId === card.id && compareDates(cycle.closesOn, asOfDate) < 0)
      .flatMap((cycle) => {
        const cents = historicalCycleAmount(cycle);
        return cents === null
          ? []
          : [{ date: cycle.closesOn, cents, provenance: 'observed' as const }];
      });
    if (card.reportedBalanceCents !== undefined && card.reportedBalanceDate !== undefined) {
      historicalPoints.push({
        date: card.reportedBalanceDate,
        cents: card.reportedBalanceCents,
        provenance: 'reported',
      });
    }
    const futurePoints = cardDebtProjections.get(card.id)!.balancePoints;
    addSeries(`card:${card.id}`, card.name, 'cards', [...historicalPoints, ...futurePoints]);
  }

  for (const loan of input.records.loans) {
    const observed: ChartsPoint[] = [
      {
        date: loan.balanceDate,
        cents: loan.principalCents + loan.accruedInterestCents,
        provenance: 'reported',
      },
    ];
    if (loan.originalPrincipalCents !== undefined && loan.originalDate !== undefined) {
      observed.push({
        date: loan.originalDate,
        cents: loan.originalPrincipalCents,
        provenance: 'observed',
      });
    }
    const projected = futureSampleDates.flatMap((date) => {
      const active = loansOn(date).find((candidate) => candidate.id === loan.id);
      return active
        ? [
            {
              date,
              cents: active.principalCents + active.accruedInterestCents,
              provenance: 'modeled' as const,
            },
          ]
        : [];
    });
    addSeries(`loan:${loan.id}`, loan.name, 'loans', [...observed, ...projected]);
  }

  for (const asset of input.records.assets) {
    addSeries(`asset:${asset.id}`, asset.name, 'assets', [
      { date: asset.valuationDate, cents: asset.valueCents, provenance: 'valuation' },
      ...futureSampleDates
        .filter((date) => compareDates(date, asset.valuationDate) >= 0)
        .map((date) => ({
          date,
          cents: projectAssetsAtDate([asset], date)[0]?.valueCents ?? asset.valueCents,
          provenance: 'modeled' as const,
        })),
    ]);
  }
  if (input.records.assets.length > 0) {
    const contributionBaseline = investmentContributionCentsOnOrBefore(asOfDate);
    addSeries(
      'assets:total',
      'Total investments & assets',
      'assets',
      futureSampleDates.map((date) => ({
        date,
        cents:
          projectAssetsAtDate(input.records.assets, date).reduce(
            (total, asset) => total + asset.valueCents,
            0,
          ) +
          investmentContributionCentsOnOrBefore(date) -
          contributionBaseline,
        provenance: 'modeled' as const,
      })),
    );
  }

  const positionSeries = series.find((candidate) => candidate.id === 'total-position');
  const owedSeries = series.find((candidate) => candidate.id === 'money-owed');
  const cardSeries = series.filter((candidate) => candidate.category === 'cards');
  const monthlyCardTotals = monthEndDates(windowStartDate, windowEndDate).flatMap((date) => {
    const latestPoints = cardSeries.flatMap((card) => {
      const point = latestPointOnOrBefore(card.points, date);
      return point ? [point] : [];
    });
    return latestPoints.length > 0
      ? [latestPoints.reduce((total, point) => total + point.cents, 0)]
      : [];
  });
  const currentCarryCentsByCard = Object.fromEntries(
    input.records.cards.map((card) => [
      card.id,
      cardDebtProjections.get(card.id)!.currentCarryCents,
    ]),
  );
  const projectedCarryPointsByCard = Object.fromEntries(
    input.records.cards.map((card) => [card.id, cardDebtProjections.get(card.id)!.carryPoints]),
  );
  const currentCarryCents = moneyCentsSchema
    .nonnegative()
    .parse(
      input.forecast.totalCarryingDebtCents ??
        input.records.cards.reduce(
          (total, card) => total + cardDebtProjections.get(card.id)!.currentCarryCents,
          0,
        ),
    );

  const positionMonthly = positionSeries
    ? monthEndDates(asOfDate, actualEndDate).flatMap((date) => {
        const point = latestPointOnOrBefore(positionSeries.points, date);
        return point ? [{ ...point, date }] : [];
      })
    : [];
  if (positionSeries && positionSeries.points[0] && positionMonthly[0]?.date !== asOfDate) {
    const current = latestPointOnOrBefore(positionSeries.points, asOfDate);
    if (current) positionMonthly.unshift({ ...current, date: asOfDate });
  }

  const baselinePositionCents = positionMonthly[0]?.cents;
  const baselineLoanCents = loansOn(asOfDate).reduce(
    (total, loan) => total + loan.principalCents + loan.accruedInterestCents,
    0,
  );
  const projectedCardLiabilityAt = (date: PlainDateString): number =>
    moneyCentsSchema.parse(
      input.records.cards.reduce((total, card) => {
        const projection = cardDebtProjections.get(card.id)!;
        return (
          total +
          (latestPointOnOrBefore(projection.netLiabilityPoints, date)?.cents ??
            projection.currentBalanceCents)
        );
      }, 0),
    );
  const baselineCardCents = projectedCardLiabilityAt(asOfDate);
  const baselineNetWorthCents =
    input.forecast.contractualNetWorthCents ?? input.forecast.economicNetWorthCents;
  const baselineInvestmentContributionCents = investmentContributionCentsOnOrBefore(asOfDate);
  const projectedIncludedAssetsAt = (date: PlainDateString): number =>
    projectAssetsAtDate(input.records.assets, date)
      .filter((asset) => asset.includedInNetWorth)
      .reduce((total, asset) => total + asset.valueCents, 0);
  const baselineIncludedAssetCents = projectedIncludedAssetsAt(asOfDate);
  const netWorthPoints: ChartsPoint[] =
    baselineNetWorthCents === undefined || baselinePositionCents === undefined
      ? []
      : positionMonthly.map((position) => {
          const loanCents = loansOn(position.date).reduce(
            (total, loan) => total + loan.principalCents + loan.accruedInterestCents,
            0,
          );
          const cardCents = projectedCardLiabilityAt(position.date);
          return {
            date: position.date,
            cents:
              baselineNetWorthCents +
              (position.cents - baselinePositionCents) -
              (baselineInvestmentContributionCents -
                investmentContributionCentsOnOrBefore(position.date)) -
              (baselineIncludedAssetCents - projectedIncludedAssetsAt(position.date)) -
              (loanCents - baselineLoanCents) -
              (cardCents - baselineCardCents),
            provenance: 'modeled' as const,
          };
        });

  const allValues = series.flatMap((candidate) => candidate.points.map((point) => point.cents));
  const availabilityNotes = [
    'Historical total position is shown only where dated evidence exists; the app does not backfill missing cash, owed, or net-worth history.',
    'Cash history uses account snapshots and reconciliations. Card history uses reported balances and locked or actual statement cycles.',
    'Future card balances follow the debt engine at statement close and on each modeled cash-payment date; projected carry clears or rolls on the same dated schedule, and excess payments remain credits in net worth.',
    'Loan futures use the dated amortization, payment-override, and committed-refinance engine. Investment futures use each asset’s explicit growth, gross-income contribution, employer-match, and fixed-contribution assumptions; assets without assumptions remain flat between valuations.',
  ];
  if (compareDates(actualEndDate, windowEndDate) < 0) {
    availabilityNotes.push(
      `The available cash forecast ends ${actualEndDate}; the chart leaves the rest of the requested 12-month future window blank.`,
    );
  }

  return {
    asOfDate,
    windowStartDate,
    windowEndDate,
    actualEndDate,
    series,
    metrics: {
      rangeLowCents: allValues.length > 0 ? Math.min(...allValues) : null,
      rangeHighCents: allValues.length > 0 ? Math.max(...allValues) : null,
      averageMonthlyOwedCents: owedSeries ? groupMonthlyAverage(owedSeries.points) : null,
      averageMonthlyCardBalanceCents: averageCents(monthlyCardTotals),
      averageMonthlyCarryCents: calculateAverageMonthlyCarryCents({
        cycles: input.records.cardCycles,
        startDate: windowStartDate,
        endDate: windowEndDate,
        asOfDate,
        currentCarryCentsByCard,
        currentCarryCents,
        projectedCarryPointsByCard,
      }),
      currentCarryCents,
      totalPositionTrajectory: trajectoryFromPoints(positionMonthly),
      netWorthTrajectory: trajectoryFromPoints(netWorthPoints),
    },
    availabilityNotes,
  };
};

export const chartsSeriesSpanDays = (series: readonly ChartsSeries[]): number => {
  const dates = series.flatMap((candidate) => candidate.points.map((point) => point.date));
  if (dates.length < 2) return 0;
  const sorted = [...dates].sort(compareDates);
  return daysBetween(sorted[0]!, sorted.at(-1)!);
};
