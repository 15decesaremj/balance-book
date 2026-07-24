import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  committedRefinancePlanSchema,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  loanSchema,
} from '@balance-book/domain';
import {
  forecastSnapshotSchema,
  managedRecordsSchema,
  type ForecastSnapshotDto,
  type ManagedRecordsDto,
} from '../apps/desktop/src/shared/contracts';
import {
  buildChartsViewModel,
  calculateAverageMonthlyCarryCents,
} from '../apps/desktop/src/renderer/charts-view-model';

const account = cashAccountSchema.parse({
  id: 'checking-a',
  userId: 'profile-a',
  name: 'Checking A',
  type: 'checking',
  openingBalanceCents: 100_000,
  balanceAsOf: '2026-06-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  hardFloorCents: 0,
  transferDelayDays: 0,
});

const card = creditCardSchema.parse({
  id: 'card-a',
  userId: 'profile-a',
  name: 'Card A',
  fundingAccountId: account.id,
  accountKind: 'credit-card',
  creditLimitCents: 500_000,
  reportedBalanceCents: 0,
  reportedBalanceDate: '2026-07-01',
  reportedCarryingBalanceCents: 0,
  reportedCarryingBalanceDate: '2026-07-01',
  defaultFutureStatementCents: 10_000,
  estimatePolicy: 'actual-reset',
  paymentPolicy: 'full-statement',
  paymentDayOfMonth: 25,
  statementCloseDayOfMonth: 31,
  status: 'active',
});

const paidInFullCycle = creditCardCycleSchema.parse({
  id: 'cycle-pif',
  cardId: card.id,
  opensOn: '2026-05-01',
  closesOn: '2026-05-31',
  dueOn: '2026-06-25',
  state: 'paid',
  defaultEstimateCents: 10_000,
  actualActivityCents: 10_000,
  plannedActivityCents: 0,
  lockedStatementCents: 10_000,
  paymentOn: '2026-06-25',
});

const loan = loanSchema.parse({
  id: 'loan-a',
  userId: 'profile-a',
  name: 'Loan A',
  principalCents: 100_000,
  accruedInterestCents: 0,
  balanceDate: '2026-07-01',
  annualRateBasisPoints: 0,
  accrualConvention: 'monthly',
  paymentCents: 10_000,
  nextPaymentDate: '2026-07-15',
  originalPrincipalCents: 120_000,
  originalDate: '2026-05-01',
  originalTermMonths: 12,
  amortizationStructure: 'fully-amortizing',
  fundingAccountId: account.id,
  excludeFromEconomicNetWorthDoubleCount: false,
  paymentFrequency: 'monthly',
  includeInCashForecast: true,
  status: 'active',
});

const records = managedRecordsSchema.parse({
  accounts: [account],
  events: [],
  cards: [card],
  cardCycles: [paidInFullCycle],
  loans: [loan],
  committedRefinancePlans: [],
  receivables: [],
  assets: [
    {
      id: 'asset-a',
      userId: 'profile-a',
      name: 'Investment A',
      type: 'investment',
      valueCents: 50_000,
      valuationDate: '2026-06-30',
      includedInNetWorth: true,
      includedInLiquidity: false,
    },
  ],
  rewardPrograms: [],
  reconciliations: [
    {
      id: 'reconcile-a',
      userId: 'profile-a',
      accountId: account.id,
      date: '2026-06-15',
      forecastBalanceCents: 90_000,
      actualBalanceCents: 95_000,
      varianceCents: 5_000,
      resolution: 'explained',
      note: 'Synthetic reconciliation',
    },
  ],
  savedScenarios: [],
});

const dailyPoint = (
  date: string,
  cashCents: number,
  owedCents: number,
): NonNullable<ForecastSnapshotDto['dailyCash']>[number] => ({
  date,
  conservativeCashCents: cashCents,
  expectedCashCents: cashCents,
  conservativeInTransitCents: 0,
  expectedInTransitCents: 0,
  conservativeReceivableCents: owedCents,
  expectedReceivableCents: owedCents,
  conservativePositionCents: cashCents + owedCents,
  expectedPositionCents: cashCents + owedCents,
  accountBalances: [
    {
      accountId: account.id,
      accountName: account.name,
      available: true,
      conservativeCashCents: cashCents,
      expectedCashCents: cashCents,
    },
  ],
  events: [],
});

const forecast = forecastSnapshotSchema.parse({
  setupComplete: true,
  startDate: '2026-07-01',
  endDate: '2026-09-30',
  currentConsolidatedCashCents: 100_000,
  currentReceivableCents: 0,
  currentTotalPositionCents: 100_000,
  totalCarryingDebtCents: 0,
  contractualNetWorthCents: 200_000,
  dailyCash: [
    dailyPoint('2026-07-01', 100_000, 0),
    dailyPoint('2026-07-31', 110_000, 10_000),
    dailyPoint('2026-08-31', 120_000, 20_000),
    dailyPoint('2026-09-30', 130_000, 20_000),
  ],
});

describe('charts view model', () => {
  it('uses dated evidence for history, pure projections for the future, and leaves unavailable history blank', () => {
    const model = buildChartsViewModel({
      records: records as ManagedRecordsDto,
      forecast,
      asOfDate: '2026-07-01',
    });

    expect(model.windowStartDate).toBe('2025-07-01');
    expect(model.windowEndDate).toBe('2027-07-01');
    expect(model.actualEndDate).toBe('2026-09-30');

    const position = model.series.find((series) => series.id === 'total-position')!;
    expect(position.points.every((point) => point.date >= '2026-07-01')).toBe(true);
    expect(position.points.every((point) => point.provenance === 'projected')).toBe(true);

    const checking = model.series.find((series) => series.id === `cash:${account.id}`)!;
    expect(checking.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026-06-01', cents: 100_000, provenance: 'reported' }),
        expect.objectContaining({ date: '2026-06-15', cents: 95_000, provenance: 'observed' }),
        expect.objectContaining({ date: '2026-08-31', cents: 120_000, provenance: 'projected' }),
      ]),
    );

    const asset = model.series.find((series) => series.id === 'asset:asset-a')!;
    expect(asset.points).toEqual(
      expect.arrayContaining([
        { date: '2026-06-30', cents: 50_000, provenance: 'valuation' },
        { date: '2026-09-30', cents: 50_000, provenance: 'modeled' },
      ]),
    );
    expect(model.availabilityNotes.join(' ')).toMatch(/does not backfill missing/i);
    expect(model.availabilityNotes.join(' ')).toMatch(
      /explicit growth.*assets without assumptions remain flat/i,
    );

    const modelWithInvestmentAssumptions = buildChartsViewModel({
      records: managedRecordsSchema.parse({
        ...records,
        assets: records.assets.map((candidate) => ({
          ...candidate,
          annualGrowthRateBasisPoints: 1_000,
          contributionGrossAnnualIncomeCents: 1_000_000,
          contributionRateBasisPoints: 400,
          employerMatchBasisPoints: 400,
        })),
      }),
      forecast,
      asOfDate: '2026-07-01',
    });
    const projectedInvestment = modelWithInvestmentAssumptions.series
      .find((series) => series.id === 'asset:asset-a')!
      .points.find((point) => point.date === '2026-09-30')!;
    expect(projectedInvestment.cents).toBeGreaterThan(50_000);
    expect(projectedInvestment.provenance).toBe('modeled');

    const loanSeries = model.series.find((series) => series.id === `loan:${loan.id}`)!;
    const currentLoan = loanSeries.points.find((point) => point.date === '2026-07-01')!;
    const futureLoan = loanSeries.points.find((point) => point.date === '2026-09-30')!;
    expect(futureLoan.cents).toBeLessThan(currentLoan.cents);
    expect(futureLoan.provenance).toBe('modeled');

    expect(model.metrics.averageMonthlyCarryCents).toBe(0);
    expect(model.metrics.currentCarryCents).toBe(0);
    expect(model.metrics.totalPositionTrajectory?.changeCents).toBeGreaterThan(0);
    expect(model.metrics.netWorthTrajectory).not.toBeNull();

    const cardSeries = model.series.find((series) => series.id === `card:${card.id}`)!;
    expect(cardSeries.points).toContainEqual({
      date: '2026-08-31',
      cents: 10_000,
      provenance: 'modeled',
    });
  });

  it('reports nonzero average carry when a paid statement was underpaid', () => {
    const underpaid = creditCardCycleSchema.parse({
      ...paidInFullCycle,
      id: 'cycle-underpaid',
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-25',
      paymentOn: '2026-07-25',
      lockedStatementCents: 10_000,
      actualPaymentCents: 6_000,
    });

    expect(
      calculateAverageMonthlyCarryCents({
        cycles: [underpaid],
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      }),
    ).toBe(4_000);
    expect(
      calculateAverageMonthlyCarryCents({
        cycles: [paidInFullCycle],
        startDate: '2026-06-01',
        endDate: '2026-08-31',
      }),
    ).toBe(0);
  });

  it('keeps an underpaid residual in every later month until that card is paid in full', () => {
    const underpaid = creditCardCycleSchema.parse({
      ...paidInFullCycle,
      id: 'cycle-underpaid-persistent',
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-25',
      paymentOn: '2026-07-25',
      lockedStatementCents: 10_000,
      actualPaymentCents: 6_000,
    });
    const laterPaidInFull = creditCardCycleSchema.parse({
      ...paidInFullCycle,
      id: 'cycle-clears-carry',
      opensOn: '2026-08-01',
      closesOn: '2026-08-31',
      dueOn: '2026-09-25',
      paymentOn: '2026-09-25',
      lockedStatementCents: 12_000,
      actualPaymentCents: 12_000,
    });

    expect(
      calculateAverageMonthlyCarryCents({
        cycles: [underpaid],
        startDate: '2026-07-01',
        endDate: '2026-09-30',
      }),
    ).toBe(4_000);
    expect(
      calculateAverageMonthlyCarryCents({
        cycles: [laterPaidInFull, underpaid],
        startDate: '2026-07-01',
        endDate: '2026-10-31',
      }),
    ).toBe(2_000);
  });

  it('tracks each card carry independently when another card is paid in full', () => {
    const cardAUnderpaid = creditCardCycleSchema.parse({
      ...paidInFullCycle,
      id: 'cycle-card-a-underpaid',
      opensOn: '2025-12-01',
      closesOn: '2025-12-31',
      dueOn: '2026-01-25',
      paymentOn: '2026-01-25',
      lockedStatementCents: 10_000,
      actualPaymentCents: 6_000,
    });
    const cardBUnderpaid = creditCardCycleSchema.parse({
      ...paidInFullCycle,
      id: 'cycle-card-b-underpaid',
      cardId: 'card-b',
      opensOn: '2026-01-01',
      closesOn: '2026-01-31',
      dueOn: '2026-02-25',
      paymentOn: '2026-02-25',
      lockedStatementCents: 5_000,
      actualPaymentCents: 3_000,
    });
    const cardAPaidInFull = creditCardCycleSchema.parse({
      ...paidInFullCycle,
      id: 'cycle-card-a-paid-in-full',
      opensOn: '2026-02-01',
      closesOn: '2026-02-28',
      dueOn: '2026-03-25',
      paymentOn: '2026-03-25',
      lockedStatementCents: 9_000,
      actualPaymentCents: 9_000,
    });

    expect(
      calculateAverageMonthlyCarryCents({
        cycles: [cardAPaidInFull, cardBUnderpaid, cardAUnderpaid],
        startDate: '2026-01-01',
        endDate: '2026-04-30',
      }),
    ).toBe(3_500);
  });

  it('keeps a reported current carry in the monthly average even when another card has paid history', () => {
    expect(
      calculateAverageMonthlyCarryCents({
        cycles: [paidInFullCycle],
        startDate: '2026-07-01',
        endDate: '2026-08-31',
        asOfDate: '2026-07-01',
        currentCarryCentsByCard: { [card.id]: 0, 'card-b': 5_000 },
        currentCarryCents: 5_000,
      }),
    ).toBe(5_000);
  });

  it('uses the scalar current carry when no per-card snapshot is available', () => {
    expect(
      calculateAverageMonthlyCarryCents({
        cycles: [],
        startDate: '2026-07-01',
        endDate: '2026-08-31',
        asOfDate: '2026-07-01',
        currentCarryCents: 5_000,
      }),
    ).toBe(5_000);
  });

  it('sorts daily forecast evidence before deriving the available chart horizon', () => {
    const model = buildChartsViewModel({
      records,
      forecast: forecastSnapshotSchema.parse({
        ...forecast,
        dailyCash: [
          dailyPoint('2026-09-30', 130_000, 20_000),
          dailyPoint('2026-07-01', 100_000, 0),
        ],
      }),
      asOfDate: '2026-07-01',
    });

    expect(model.actualEndDate).toBe('2026-09-30');
    expect(model.series.find((series) => series.id === 'total-position')?.points).toEqual([
      expect.objectContaining({ date: '2026-07-01' }),
      expect.objectContaining({ date: '2026-09-30' }),
    ]);
  });

  it('uses the card debt schedule so an explicit overpayment credits the next projected statement', () => {
    const futureOverpayment = forecastEventSchema.parse({
      id: 'future-card-overpayment',
      userId: 'profile-a',
      accountId: account.id,
      cardId: card.id,
      date: '2026-09-25',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 15_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Future card overpayment',
      paymentMethod: 'cash-account',
    });
    const model = buildChartsViewModel({
      records: managedRecordsSchema.parse({ ...records, events: [futureOverpayment] }),
      forecast,
      asOfDate: '2026-07-01',
    });

    const cardSeries = model.series.find((series) => series.id === `card:${card.id}`)!;
    expect(cardSeries.points).toContainEqual({
      date: '2026-09-30',
      cents: 5_000,
      provenance: 'modeled',
    });
  });

  it('preserves net worth when a card payment creates an excess issuer credit', () => {
    const overpaidCard = creditCardSchema.parse({
      ...card,
      id: 'overpaid-card',
      name: 'Overpaid card',
      reportedBalanceCents: 10_000,
      defaultFutureStatementCents: 0,
    });
    const dueCycle = creditCardCycleSchema.parse({
      id: 'overpaid-card-cycle',
      cardId: overpaidCard.id,
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-25',
      paymentOn: '2026-07-25',
      state: 'closed-statement',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 10_000,
    });
    const overpayment = forecastEventSchema.parse({
      id: 'overpaid-card-payment',
      userId: 'profile-a',
      accountId: account.id,
      cardId: overpaidCard.id,
      date: '2026-07-25',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 15_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Card overpayment',
      sourceRecordId: dueCycle.id,
      paymentMethod: 'cash-account',
    });
    const overpaymentRecords = managedRecordsSchema.parse({
      ...records,
      events: [overpayment],
      cards: [overpaidCard],
      cardCycles: [dueCycle],
      loans: [],
      assets: [],
      reconciliations: [],
    });
    const overpaymentForecast = forecastSnapshotSchema.parse({
      ...forecast,
      endDate: '2026-07-31',
      contractualNetWorthCents: 90_000,
      dailyCash: [dailyPoint('2026-07-01', 100_000, 0), dailyPoint('2026-07-31', 85_000, 0)],
    });

    const model = buildChartsViewModel({
      records: overpaymentRecords,
      forecast: overpaymentForecast,
      asOfDate: '2026-07-01',
      historyMonths: 0,
      futureMonths: 1,
    });
    const cardSeries = model.series.find((series) => series.id === `card:${overpaidCard.id}`)!;

    expect(cardSeries.points).toContainEqual({
      date: '2026-07-25',
      cents: 0,
      provenance: 'modeled',
    });
    expect(model.metrics.netWorthTrajectory).toMatchObject({
      startCents: 90_000,
      endCents: 90_000,
      changeCents: 0,
    });
  });

  it('clears current carry on the modeled full-statement payment and keeps net worth invariant', () => {
    const carryingCard = creditCardSchema.parse({
      ...card,
      id: 'carrying-card',
      name: 'Carrying card',
      reportedBalanceCents: 4_000,
      reportedCarryingBalanceCents: 4_000,
      defaultFutureStatementCents: 0,
    });
    const carryingRecords = managedRecordsSchema.parse({
      ...records,
      cards: [carryingCard],
      cardCycles: [],
      loans: [],
      assets: [],
      reconciliations: [],
    });
    const carryingForecast = forecastSnapshotSchema.parse({
      ...forecast,
      endDate: '2026-10-01',
      totalCarryingDebtCents: 4_000,
      contractualNetWorthCents: 96_000,
      dailyCash: [
        dailyPoint('2026-07-01', 100_000, 0),
        dailyPoint('2026-07-31', 100_000, 0),
        dailyPoint('2026-08-31', 96_000, 0),
        dailyPoint('2026-09-30', 96_000, 0),
        dailyPoint('2026-10-01', 96_000, 0),
      ],
    });

    const model = buildChartsViewModel({
      records: carryingRecords,
      forecast: carryingForecast,
      asOfDate: '2026-07-01',
      historyMonths: 0,
      futureMonths: 3,
    });
    const cardSeries = model.series.find((series) => series.id === `card:${carryingCard.id}`)!;

    expect(cardSeries.points).toContainEqual({
      date: '2026-08-25',
      cents: 0,
      provenance: 'modeled',
    });
    expect(model.metrics.currentCarryCents).toBe(4_000);
    expect(model.metrics.averageMonthlyCarryCents).toBe(1_000);
    expect(model.metrics.netWorthTrajectory).toMatchObject({
      startCents: 96_000,
      endCents: 96_000,
      changeCents: 0,
    });
  });

  it('uses paid-cycle status so a stale scheduled instruction cannot erase real residual debt', () => {
    const paidCard = creditCardSchema.parse({
      ...card,
      id: 'status-aware-card',
      name: 'Status-aware card',
      reportedBalanceCents: 10_000,
      reportedCarryingBalanceCents: 0,
      defaultFutureStatementCents: 0,
    });
    const paidCycle = creditCardCycleSchema.parse({
      id: 'status-aware-paid-cycle',
      cardId: paidCard.id,
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-25',
      paymentOn: '2026-07-25',
      state: 'paid',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 10_000,
      actualPaymentCents: 6_000,
    });
    const staleInstruction = forecastEventSchema.parse({
      id: 'stale-status-aware-instruction',
      userId: 'profile-a',
      accountId: account.id,
      cardId: paidCard.id,
      date: '2026-07-25',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Stale full-payment instruction',
      sourceRecordId: paidCycle.id,
      paymentMethod: 'cash-account',
    });
    const statusRecords = managedRecordsSchema.parse({
      ...records,
      events: [staleInstruction],
      cards: [paidCard],
      cardCycles: [paidCycle],
      loans: [],
      assets: [],
      reconciliations: [],
    });
    const statusForecast = forecastSnapshotSchema.parse({
      ...forecast,
      endDate: '2026-07-31',
      contractualNetWorthCents: 90_000,
      dailyCash: [dailyPoint('2026-07-01', 100_000, 0), dailyPoint('2026-07-31', 94_000, 0)],
    });

    const model = buildChartsViewModel({
      records: statusRecords,
      forecast: statusForecast,
      asOfDate: '2026-07-01',
      historyMonths: 0,
      futureMonths: 1,
    });
    const cardSeries = model.series.find((series) => series.id === `card:${paidCard.id}`)!;

    expect(cardSeries.points).toContainEqual({
      date: '2026-07-25',
      cents: 4_000,
      provenance: 'modeled',
    });
    expect(model.metrics.netWorthTrajectory).toMatchObject({
      startCents: 90_000,
      endCents: 90_000,
      changeCents: 0,
    });
  });

  it('honors committed refinance lifecycle and extra principal in loan chart points', () => {
    const source = loanSchema.parse({
      ...loan,
      id: 'source-refinanced-loan',
      name: 'Source refinanced loan',
      principalCents: 100_000,
      balanceDate: '2026-07-01',
      nextPaymentDate: '2026-08-15',
    });
    const replacement = loanSchema.parse({
      ...loan,
      id: 'replacement-loan',
      name: 'Replacement loan',
      principalCents: 100_000,
      balanceDate: '2026-07-20',
      originalDate: '2026-07-20',
      originalPrincipalCents: 100_000,
      nextPaymentDate: '2026-08-15',
    });
    const plan = committedRefinancePlanSchema.parse({
      id: 'committed-refinance',
      userId: 'profile-a',
      name: 'Committed refinance',
      status: 'committed',
      closingDate: '2026-07-20',
      payoffDate: '2026-07-25',
      firstPaymentDate: '2026-08-15',
      payoffs: [{ sourceLoanId: source.id, payoffAmountCents: 100_000 }],
      replacementLoan: replacement,
      replacementLoanSnapshot: replacement,
      assetRelinks: [],
      principalCashContributionCents: 0,
      closingCostsCents: 0,
      financedFeesCents: 0,
      excessProceedsCents: 0,
    });
    const extraPrincipal = forecastEventSchema.parse({
      id: 'replacement-extra-principal',
      userId: 'profile-a',
      accountId: account.id,
      date: '2026-07-27',
      kind: 'loan-payment',
      direction: 'outflow',
      amountCents: 20_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Replacement extra principal',
      sourceRecordId: replacement.id,
      paymentMethod: 'cash-account',
      loanPaymentTreatment: 'additional-principal',
    });
    const refinanceRecords = managedRecordsSchema.parse({
      ...records,
      events: [extraPrincipal],
      loans: [source, replacement],
      committedRefinancePlans: [plan],
    });
    const refinanceForecast = forecastSnapshotSchema.parse({
      ...forecast,
      startDate: '2026-07-19',
      endDate: '2026-07-31',
      dailyCash: [dailyPoint('2026-07-19', 100_000, 0), dailyPoint('2026-07-31', 80_000, 0)],
    });

    const model = buildChartsViewModel({
      records: refinanceRecords,
      forecast: refinanceForecast,
      asOfDate: '2026-07-19',
      historyMonths: 1,
      futureMonths: 1,
    });
    const sourceSeries = model.series.find((series) => series.id === `loan:${source.id}`)!;
    const replacementSeries = model.series.find(
      (series) => series.id === `loan:${replacement.id}`,
    )!;

    expect(sourceSeries.points).toContainEqual(
      expect.objectContaining({ date: '2026-07-19', provenance: 'modeled' }),
    );
    expect(sourceSeries.points.some((point) => point.date === '2026-07-31')).toBe(false);
    expect(replacementSeries.points.some((point) => point.date === '2026-07-19')).toBe(false);
    expect(replacementSeries.points).toContainEqual({
      date: '2026-07-31',
      cents: 80_000,
      provenance: 'modeled',
    });
  });
});
