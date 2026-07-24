import { describe, expect, it } from 'vitest';
import type { ForecastSnapshotDto, ManagedRecordsDto } from '../apps/desktop/src/shared/contracts';
import {
  buildBalanceGlanceModel,
  buildUpcomingBillsModel,
} from '../apps/desktop/src/renderer/financial-hub-model';

const records: ManagedRecordsDto = {
  accounts: [
    {
      id: 'checking',
      userId: 'profile',
      name: 'Checking',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-07-20',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      showOnOverview: true,
      hardFloorCents: 20_000,
      transferDelayDays: 0,
    },
  ],
  events: [],
  cards: [
    {
      id: 'card',
      userId: 'profile',
      name: 'Everyday Card',
      fundingAccountId: 'checking',
      accountKind: 'credit-card',
      creditLimitCents: 200_000,
      defaultFutureStatementCents: 25_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      interestForecastEnabled: false,
      promotionalCarryingBalance: false,
      paymentDayOfMonth: 12,
      statementCloseDayOfMonth: 22,
      status: 'active',
    },
  ],
  cardCycles: [],
  loans: [],
  committedRefinancePlans: [],
  receivables: [],
  assets: [],
  rewardPrograms: [],
  reconciliations: [],
  savedScenarios: [],
};

const snapshot: ForecastSnapshotDto = {
  setupComplete: true,
  startDate: '2026-07-22',
  cashAccounts: [
    {
      id: 'checking',
      name: 'Checking',
      balanceCents: 112_500,
      sourceBalanceCents: 100_000,
      sourceBalanceDate: '2026-07-20',
      calculatedThroughDate: '2026-07-22',
      postSourceChangeCents: 12_500,
      hardFloorCents: 20_000,
    },
  ],
  upcomingEvents: [
    {
      id: 'rent',
      label: 'Rent',
      accountName: 'Checking',
      date: '2026-08-01',
      amountCents: 120_000,
      direction: 'outflow',
      kind: 'expense',
      certainty: 'confirmed',
    },
    {
      id: 'paycheck',
      label: 'Paycheck',
      accountName: 'Checking',
      date: '2026-07-30',
      amountCents: 250_000,
      direction: 'inflow',
      kind: 'income',
      certainty: 'confirmed',
    },
    {
      id: 'transfer',
      label: 'Move to savings',
      accountName: 'Checking',
      date: '2026-07-31',
      amountCents: 30_000,
      direction: 'outflow',
      kind: 'transfer-debit',
      certainty: 'confirmed',
    },
    {
      id: 'later',
      label: 'Later bill',
      accountName: 'Checking',
      date: '2026-10-01',
      amountCents: 9_000,
      direction: 'outflow',
      kind: 'expense',
      certainty: 'estimated',
    },
  ],
  cardSpendingPower: [
    {
      cardId: 'card',
      cardName: 'Everyday Card',
      fundingAccountId: 'checking',
      fundingAccountName: 'Checking',
      statementAmountCents: 35_000,
      statementDueOn: '2026-08-12',
      currentCycleAmountCents: 12_500,
      purchaseAdvisorEligible: true,
      spendingPowerCents: 50_000,
      cashBackedCapacityCents: 50_000,
      spendingPowerStatus: 'determinate',
      prePaymentShortfallCents: 0,
      baselineEstimateSlackCents: 0,
      futurePositionLowCents: 50_000,
      futurePositionLowDate: '2026-08-12',
      futurePositionLowCashCents: 50_000,
      futurePositionLowReceivableCents: 0,
      futurePositionLowAccountBalances: [],
      futureAccountLows: [],
      futureCashLowCents: 50_000,
      futureCashLowDate: '2026-08-12',
      fundingAccountLowCents: 50_000,
      fundingAccountLowDate: '2026-08-12',
    },
  ],
  revolvingDebtByCard: [
    {
      cardId: 'card',
      reportedBalanceCents: 47_500,
      reportedBalanceDate: '2026-07-21',
      calculatedThroughDate: '2026-07-22',
      postSourceActivityCents: 2_500,
      latestStatementCents: 35_000,
      latestStatementDate: '2026-07-22',
      amountCurrentlyDueCents: 35_000,
      actualOpenCycleCents: 12_500,
      unreconciledPostCloseActivityCents: 0,
      projectedOpenCycleCents: 12_500,
      currentBalanceCents: 47_500,
      availableCreditCents: 152_500,
      carryingBalanceCents: 0,
      projectedCarryingBalanceCents: 0,
      overdue: false,
      source: 'reported',
      reportedBalanceHasUnresolvedSameCycleActivity: false,
    },
  ],
};

describe('financial center read models', () => {
  it('shows only real upcoming outflows and excludes income, internal transfers, and later dates', () => {
    const result = buildUpcomingBillsModel(snapshot, '2026-07-22', 45);

    expect(result.bills).toEqual([
      expect.objectContaining({
        id: 'rent',
        label: 'Rent',
        date: '2026-08-01',
        amountCents: 120_000,
      }),
    ]);
    expect(result.totalCents).toBe(120_000);
  });

  it('prefers the complete expected daily ledger when the compact upcoming list is truncated', () => {
    const result = buildUpcomingBillsModel(
      {
        ...snapshot,
        upcomingEvents: [],
        dailyCash: [
          {
            date: '2026-08-20',
            conservativeCashCents: 50_000,
            expectedCashCents: 50_000,
            conservativeInTransitCents: 0,
            expectedInTransitCents: 0,
            conservativeReceivableCents: 0,
            expectedReceivableCents: 0,
            conservativePositionCents: 50_000,
            expectedPositionCents: 50_000,
            accountBalances: [],
            events: [
              {
                id: 'insurance',
                label: 'Insurance',
                accountName: 'Checking',
                amountCents: 14_500,
                direction: 'outflow',
                kind: 'expense',
                certainty: 'confirmed',
                status: 'scheduled',
                hypothetical: false,
                displayState: 'locked',
                includedInExpected: true,
                includedInConservative: true,
              },
              {
                id: 'what-if',
                label: 'What-if purchase',
                accountName: 'Checking',
                amountCents: 9_000,
                direction: 'outflow',
                kind: 'expense',
                certainty: 'expected',
                status: 'planned',
                hypothetical: true,
                displayState: 'hypothetical',
                includedInExpected: true,
                includedInConservative: false,
              },
            ],
          },
        ],
      },
      '2026-07-22',
      45,
    );

    expect(result.bills).toEqual([
      expect.objectContaining({ id: 'insurance', date: '2026-08-20', amountCents: 14_500 }),
    ]);
  });

  it('uses the canonical calculated account and card positions without re-running a ledger', () => {
    const result = buildBalanceGlanceModel(snapshot, records);

    expect(result.totalCashCents).toBe(112_500);
    expect(result.totalCardBalanceCents).toBe(47_500);
    expect(result.cash[0]).toMatchObject({
      name: 'Checking',
      balanceCents: 112_500,
      hardFloorCents: 20_000,
      calculatedThroughDate: '2026-07-22',
      openPath: '/?detail=account:checking',
    });
    expect(result.cards[0]).toMatchObject({
      name: 'Everyday Card',
      balanceCents: 47_500,
      availableCreditCents: 152_500,
      latestStatementCents: 35_000,
      nextDueOn: '2026-08-12',
      openPath: '/?detail=card:card',
    });
  });
});
