import { describe, expect, it } from 'vitest';
import type {
  ForecastSnapshotDto,
  ManagedRecordsDto,
  NotificationPresentationDto,
} from '../apps/desktop/src/shared/contracts';
import {
  generateFinancialNotifications,
  unresolvedNotificationCount,
} from '../apps/desktop/src/renderer/notifications';

const records: ManagedRecordsDto = {
  accounts: [
    {
      id: 'checking',
      userId: 'profile',
      name: 'Checking',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-06-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      showOnOverview: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    },
  ],
  events: [],
  cards: [
    {
      id: 'card',
      userId: 'profile',
      name: 'Card',
      fundingAccountId: 'checking',
      accountKind: 'credit-card',
      defaultFutureStatementCents: 10_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      interestForecastEnabled: false,
      promotionalCarryingBalance: false,
      paymentDayOfMonth: 3,
      statementCloseDayOfMonth: 20,
      status: 'active',
    },
  ],
  cardCycles: [
    {
      id: 'card-cycle',
      cardId: 'card',
      opensOn: '2026-05-21',
      closesOn: '2026-06-20',
      dueOn: '2026-07-03',
      state: 'scheduled-payment',
      defaultEstimateCents: 10_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 10_000,
      paymentOn: '2026-07-01',
    },
  ],
  loans: [],
  committedRefinancePlans: [],
  receivables: [
    {
      id: 'owed',
      userId: 'profile',
      source: 'Friend',
      description: 'Shared cost',
      originalAmountCents: 5_000,
      remainingAmountCents: 5_000,
      expectedDate: '2026-07-01',
      destinationAccountId: 'checking',
      certainty: 'confirmed',
      includeInCashForecast: true,
    },
  ],
  assets: [],
  rewardPrograms: [],
  reconciliations: [
    {
      id: 'reconciliation',
      userId: 'profile',
      accountId: 'checking',
      date: '2026-06-30',
      forecastBalanceCents: 90_000,
      actualBalanceCents: 88_000,
      varianceCents: -2_000,
      resolution: 'unresolved',
    },
  ],
  savedScenarios: [],
};

const snapshot: ForecastSnapshotDto = {
  setupComplete: true,
  startDate: '2026-07-01',
  cashAccounts: [
    {
      id: 'checking',
      name: 'Checking',
      balanceCents: 112_000,
      sourceBalanceCents: 100_000,
      sourceBalanceDate: '2026-06-01',
      calculatedThroughDate: '2026-07-01',
      postSourceChangeCents: 12_000,
      hardFloorCents: 0,
    },
  ],
  cardSpendingPower: [
    {
      cardId: 'card',
      cardName: 'Card',
      fundingAccountId: 'checking',
      fundingAccountName: 'Checking',
      statementAmountCents: 10_000,
      currentCycleAmountCents: 0,
      purchaseAdvisorEligible: false,
      spendingPowerCents: 0,
      cashBackedCapacityCents: 0,
      spendingPowerStatus: 'indeterminate-cycle-timing',
      prePaymentShortfallCents: 0,
      baselineEstimateSlackCents: 0,
      futurePositionLowCents: 0,
      futurePositionLowDate: '2026-07-01',
      futurePositionLowCashCents: 0,
      futurePositionLowReceivableCents: 0,
      futurePositionLowAccountBalances: [],
      futureAccountLows: [],
      futureCashLowCents: 0,
      futureCashLowDate: '2026-07-01',
      fundingAccountLowCents: 0,
      fundingAccountLowDate: '2026-07-01',
    },
  ],
  transferNeeds: [],
  expectedTransferNeeds: [],
};

const generate = (nextSnapshot = snapshot, presentations: NotificationPresentationDto[] = []) =>
  generateFinancialNotifications({
    snapshot: nextSnapshot,
    records,
    presentations,
    today: '2026-07-01',
    now: '2026-07-01T12:00:00.000Z',
  });

describe('deterministic financial notifications', () => {
  it('deduplicates stable conditions and counts unresolved actions independently of unread state', () => {
    const first = generate();
    const second = generate();
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
    expect(first.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'stale-account:checking',
        'card-answer-missing:card',
        'card-payment:card-cycle',
        'receivable-ready:owed',
        'reconciliation:reconciliation',
      ]),
    );

    const presentations = first.map((item): NotificationPresentationDto => ({
      notificationId: item.id,
      conditionFingerprint: item.fingerprint,
      readAt: '2026-07-01T12:05:00.000Z',
      snoozedUntil: null,
      dismissedAt: null,
      updatedAt: '2026-07-01T12:05:00.000Z',
    }));
    const read = generate(snapshot, presentations);
    expect(read.every((item) => !item.unread)).toBe(true);
    expect(unresolvedNotificationCount(read)).toBe(unresolvedNotificationCount(first));
  });

  it('makes a materially changed condition unread without changing its stable identity', () => {
    const original = generate().find((item) => item.id === 'stale-account:checking')!;
    const presentation: NotificationPresentationDto = {
      notificationId: original.id,
      conditionFingerprint: original.fingerprint,
      readAt: '2026-07-01T12:05:00.000Z',
      snoozedUntil: null,
      dismissedAt: null,
      updatedAt: '2026-07-01T12:05:00.000Z',
    };
    const changedSnapshot: ForecastSnapshotDto = {
      ...snapshot,
      cashAccounts: snapshot.cashAccounts?.map((account) => ({
        ...account,
        balanceCents: 109_000,
        postSourceChangeCents: 9_000,
      })),
    };
    const changed = generate(changedSnapshot, [presentation]).find(
      (item) => item.id === original.id,
    )!;
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(changed.unread).toBe(true);
  });

  it('re-alerts once when the notification presentation contract advances', () => {
    const current = generate().find((item) => item.id === 'stale-account:checking')!;
    const legacyPresentation: NotificationPresentationDto = {
      notificationId: current.id,
      conditionFingerprint: current.fingerprint.replace(/^v2:/, 'v1:'),
      readAt: '2026-07-01T12:05:00.000Z',
      snoozedUntil: null,
      dismissedAt: null,
      updatedAt: '2026-07-01T12:05:00.000Z',
    };

    const refreshed = generate(snapshot, [legacyPresentation]).find(
      (item) => item.id === current.id,
    )!;
    expect(current.fingerprint).toMatch(/^v2:/);
    expect(refreshed.unread).toBe(true);
  });

  it('resolves conditions only when canonical state changes', () => {
    const resolved = generateFinancialNotifications({
      snapshot: {
        ...snapshot,
        cashAccounts: snapshot.cashAccounts?.map((account) => ({
          ...account,
          sourceBalanceDate: '2026-07-01',
          sourceBalanceCents: account.balanceCents,
          postSourceChangeCents: 0,
        })),
        cardSpendingPower: snapshot.cardSpendingPower?.map((card) => ({
          ...card,
          spendingPowerStatus: 'determinate',
        })),
      },
      records: {
        ...records,
        cardCycles: records.cardCycles.map((cycle) => ({
          ...cycle,
          state: 'paid',
          actualPaymentCents: cycle.lockedStatementCents,
          actualPaymentAccountId: 'checking',
        })),
        receivables: records.receivables.map((receivable) => ({
          ...receivable,
          remainingAmountCents: 0,
        })),
        reconciliations: records.reconciliations.map((reconciliation) => ({
          ...reconciliation,
          resolution: 'explained',
        })),
      },
      today: '2026-07-01',
    });
    expect(resolved.filter((item) => item.section === 'needs-action')).toHaveLength(0);
    expect(resolved.map((item) => item.id)).toContain('card-payment-recorded:card-cycle');
  });

  it('states account warnings as exact cash shortfalls and keeps receivable coverage secondary', () => {
    const fundingNotification = generate({
      ...snapshot,
      cashAccounts: snapshot.cashAccounts?.map((account) => ({
        ...account,
        hardFloorCents: 10_000,
      })),
      expectedTransferNeeds: [
        {
          accountId: 'checking',
          accountName: 'Checking',
          date: '2026-07-15',
          shortfallCents: 56_390,
          horizonDeepestShortfallCents: 70_860,
          horizonDeepestShortfallDate: '2026-07-17',
          receivableReleaseNeededCents: 28_800,
          uncoveredAfterReceivablesCents: 27_590,
        },
      ],
    }).find((item) => item.id === 'funding-need:checking');

    expect(fundingNotification).toMatchObject({
      title: 'Cash shortfall',
      subject: 'Checking',
      amountCents: 56_390,
      date: '2026-07-15',
    });
    expect(fundingNotification?.explanation).toContain('Cash is projected to close at -$463.90');
    expect(fundingNotification?.explanation).toContain('$563.90 below the $100.00 account minimum');
    expect(fundingNotification?.explanation).toContain('$708.60 cash shortfall');
    expect(fundingNotification?.explanation).toContain('Releasing $288.00 of dated Money Owed');
  });
});
