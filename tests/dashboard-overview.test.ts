// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Temporal } from '@js-temporal/polyfill';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProfilePreferences } from '@balance-book/domain';
import {
  DashboardPage,
  forecastEventSourcePath,
  overviewBalanceUpdateRequest,
  overviewCardBalanceUpdateRequest,
  overviewCardTransactionRequest,
  overviewCashTransactionRequest,
  overviewStatementBalanceUpdateRequest,
  sortOverviewCards,
  statementBalanceEditIsUnusual,
} from '../apps/desktop/src/renderer/DashboardPage';
import { formatMoney, formatPlainDate } from '../apps/desktop/src/renderer/utils';
import type {
  BalanceBookApi,
  ForecastSnapshotDto,
  ManagedRecordsDto,
} from '../apps/desktop/src/shared/contracts';

type CardPower = NonNullable<ForecastSnapshotDto['cardSpendingPower']>[number];

const cardPower: CardPower = {
  cardId: 'atlas-card',
  cardName: 'Atlas Card',
  fundingAccountId: 'primary-checking',
  fundingAccountName: 'Primary checking',
  statementAmountCents: 84_200,
  currentCycleAmountCents: 0,
  currentCycleClosesOn: '2030-02-14',
  nextDueOn: '2030-03-28',
  nextStatementDueOn: '2030-04-28',
  nextStatementPositionCents: 102_468,
  purchaseAdvisorEligible: true,
  spendingPowerCents: 91_234,
  cashBackedCapacityCents: 0,
  spendingPowerStatus: 'conditional-existing-shortfall',
  prePaymentShortfallCents: 12_345,
  prePaymentShortfallDate: '2030-03-21',
  prePaymentShortfallAccountId: 'primary-checking',
  baselineEstimateSlackCents: 0,
  futurePositionLowCents: 91_234,
  futurePositionLowDate: '2030-04-07',
  futurePositionLowCashCents: 66_234,
  futurePositionLowReceivableCents: 25_000,
  futurePositionLowAccountBalances: [
    { accountId: 'reserve-checking', accountName: 'Reserve checking', endingBalanceCents: 45_678 },
    { accountId: 'primary-checking', accountName: 'Primary checking', endingBalanceCents: 20_556 },
  ],
  futureAccountLows: [
    {
      accountId: 'reserve-checking',
      accountName: 'Reserve checking',
      endingBalanceCents: 45_678,
      date: '2030-04-07',
    },
    {
      accountId: 'primary-checking',
      accountName: 'Primary checking',
      endingBalanceCents: -12_345,
      date: '2030-03-21',
    },
  ],
  futureCashLowCents: -4_321,
  futureCashLowDate: '2030-03-21',
  fundingAccountLowCents: -12_345,
  fundingAccountLowDate: '2030-03-21',
};

const snapshot: ForecastSnapshotDto = {
  setupComplete: true,
  startDate: '2030-02-03',
  endDate: '2031-01-27',
  currentConsolidatedCashCents: 70_000,
  currentReceivableCents: 25_000,
  currentTotalPositionCents: 95_000,
  longRunMonthlyFreeCashFlowCents: 52_500,
  longRunMonthlyScheduledCardPaymentCents: 7_500,
  longRunMonthlyBeforeScheduledCardPaymentCents: 60_000,
  longRunCashFlowWindowStart: '2030-05-01',
  longRunCashFlowWindowEnd: '2031-04-30',
  expectedPositionLowCents: 91_234,
  expectedPositionLowDate: '2030-04-07',
  conservativePositionLowCents: 91_234,
  conservativePositionLowDate: '2030-04-07',
  expectedTroughCents: -4_321,
  expectedTroughDate: '2030-03-21',
  conservativeTroughCents: -4_321,
  conservativeTroughDate: '2030-03-21',
  expectedIntradaySafetyLowCents: -4_321,
  expectedIntradaySafetyLowDate: '2030-03-21',
  conservativeIntradaySafetyLowCents: -4_321,
  conservativeIntradaySafetyLowDate: '2030-03-21',
  expectedHardFloorMarginCents: -4_321,
  conservativeHardFloorMarginCents: -4_321,
  hardFloorCents: 0,
  cashAccounts: [
    { id: 'reserve-checking', name: 'Reserve checking', balanceCents: 40_000, hardFloorCents: 0 },
    { id: 'primary-checking', name: 'Primary checking', balanceCents: 30_000, hardFloorCents: 0 },
  ],
  accountTroughs: [
    {
      accountId: 'reserve-checking',
      accountName: 'Reserve checking',
      balanceCents: 45_678,
      date: '2030-04-07',
      expectedBalanceCents: 45_678,
      expectedDate: '2030-04-07',
    },
    {
      accountId: 'primary-checking',
      accountName: 'Primary checking',
      balanceCents: -99_999,
      date: '2030-09-21',
      expectedBalanceCents: -99_999,
      expectedDate: '2030-09-21',
    },
  ],
  expectedTransferNeeds: [
    {
      accountId: 'primary-checking',
      accountName: 'Primary checking',
      date: '2030-03-21',
      shortfallCents: 12_345,
      horizonDeepestShortfallCents: 12_345,
      horizonDeepestShortfallDate: '2030-03-21',
      receivableOutstandingCents: 25_000,
      receivableReleaseNeededCents: 12_345,
      uncoveredAfterReceivablesCents: 0,
      deepestReceivableOutstandingCents: 25_000,
      deepestReceivableReleaseNeededCents: 12_345,
      deepestUncoveredAfterReceivablesCents: 0,
    },
  ],
  transferNeeds: [
    {
      accountId: 'primary-checking',
      accountName: 'Primary checking',
      date: '2030-03-21',
      shortfallCents: 12_345,
      horizonDeepestShortfallCents: 12_345,
      horizonDeepestShortfallDate: '2030-03-21',
      receivableOutstandingCents: 25_000,
      receivableReleaseNeededCents: 12_345,
      uncoveredAfterReceivablesCents: 0,
      deepestReceivableOutstandingCents: 25_000,
      deepestReceivableReleaseNeededCents: 12_345,
      deepestUncoveredAfterReceivablesCents: 0,
    },
  ],
  cardSpendingPower: [cardPower],
  conservativeCardSpendingPower: [cardPower],
  revolvingDebtByCard: [
    {
      cardId: 'atlas-card',
      latestStatementCents: 84_200,
      latestStatementDate: '2030-01-31',
      amountCurrentlyDueCents: 31_700,
      actualOpenCycleCents: 22_400,
      unreconciledPostCloseActivityCents: 0,
      projectedOpenCycleCents: 22_400,
      currentBalanceCents: 54_100,
      carryingBalanceCents: 31_700,
      projectedCarryingBalanceCents: 31_700,
      overdue: true,
      source: 'cycle-derived',
      reportedBalanceHasUnresolvedSameCycleActivity: false,
    },
  ],
};

const managedRecords: ManagedRecordsDto = {
  accounts: [
    {
      id: 'reserve-checking',
      userId: 'profile-a',
      name: 'Reserve checking',
      type: 'savings',
      openingBalanceCents: 40_000,
      availableBalanceCents: 39_500,
      balanceAsOf: '2030-01-31',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      showOnOverview: true,
      hardFloorCents: 0,
      preferredFloorCents: 10_000,
      transferDelayDays: 2,
      notes: 'Preserve account settings.',
    },
    {
      id: 'primary-checking',
      userId: 'profile-a',
      name: 'Primary checking',
      type: 'checking',
      openingBalanceCents: 30_000,
      balanceAsOf: '2030-01-31',
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
      id: 'atlas-card',
      userId: 'profile-a',
      name: 'Atlas Card',
      issuer: 'Atlas Bank',
      lastFour: '2468',
      fundingAccountId: 'primary-checking',
      accountKind: 'credit-card',
      creditLimitCents: 500_000,
      reportedBalanceCents: 54_100,
      reportedBalanceDate: '2030-02-03',
      defaultFutureStatementCents: 60_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      interestForecastEnabled: false,
      promotionalCarryingBalance: false,
      paymentDayOfMonth: 28,
      statementCloseDayOfMonth: 14,
      status: 'active',
    },
  ],
  cardCycles: [
    {
      id: 'atlas-statement',
      cardId: 'atlas-card',
      opensOn: '2030-01-01',
      closesOn: '2030-01-31',
      dueOn: '2030-02-02',
      paymentOn: '2030-02-02',
      state: 'paid',
      defaultEstimateCents: 60_000,
      actualActivityCents: 84_200,
      plannedActivityCents: 0,
      lockedStatementCents: 84_200,
      actualPaymentCents: 52_500,
      actualPaymentAccountId: 'primary-checking',
    },
  ],
  loans: [],
  committedRefinancePlans: [],
  receivables: [],
  assets: [],
  rewardPrograms: [],
  reconciliations: [],
  savedScenarios: [],
};

beforeEach(() => {
  Object.defineProperty(window, 'balanceBook', {
    configurable: true,
    value: {
      getForecast: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
      listRecords: vi.fn().mockResolvedValue({ ok: true, value: managedRecords }),
      upsertRecord: vi.fn().mockResolvedValue({ ok: true, value: managedRecords }),
      recordOverviewExpense: vi.fn().mockResolvedValue({ ok: true, value: managedRecords }),
      evaluateScenario: vi
        .fn()
        .mockImplementation(
          async (request: { fundingType: 'cash' | 'card'; accountId?: string }) => {
            const accountName =
              request.fundingType === 'card'
                ? 'Primary checking'
                : (snapshot.cashAccounts?.find((account) => account.id === request.accountId)
                    ?.name ?? 'Checking');
            return {
              ok: true,
              value: {
                verdict: 'underfunded-account',
                settlementDate: '2030-03-21',
                beforeTroughCents: 70_000,
                afterTroughCents: 55_000,
                afterHardFloorMarginCents: -12_345,
                afterAvailableToDeployCents: 0,
                resultingAvailableSpendCents: request.fundingType === 'card' ? 64_000 : 0,
                accountShortfallCount: 1,
                transferNeeds: [],
                fundingAccountName: accountName,
                cardName: request.fundingType === 'card' ? 'Atlas Card' : undefined,
                purchaseSafety: {
                  safe: true,
                  totalPositionLowCents: 75_000,
                  totalPositionLowDate: '2030-04-07',
                  totalPositionMarginCents: 75_000,
                  fundingAccountLowCents: -100,
                  fundingAccountLowDate: '2030-03-21',
                  fundingAccountFloorCents: 0,
                  fundingAccountShortfallCents: 100,
                  receivableOutstandingCents: 25_000,
                  receivableReleaseNeededCents: 100,
                  uncoveredFundingShortfallCents: 0,
                },
                baselineCardPaymentCents: request.fundingType === 'card' ? 84_200 : undefined,
                afterPurchaseCardPaymentCents: request.fundingType === 'card' ? 99_200 : undefined,
                incrementalCashPaymentCents: request.fundingType === 'card' ? 15_000 : undefined,
                owningStatementClosesOn: request.fundingType === 'card' ? '2030-02-14' : undefined,
                followingStatementDueOn: request.fundingType === 'card' ? '2030-04-28' : undefined,
                followingStatementPositionCents:
                  request.fundingType === 'card' ? 75_000 : undefined,
              },
            };
          },
        ),
    } as unknown as BalanceBookApi,
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Overview card runway presentation', () => {
  it('surfaces long-run monthly free cash flow separately from known card-payment schedules', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage, { fullForecast: true })));

    expect(await screen.findByText('Net monthly free cash flow')).toBeVisible();
    expect(screen.getByText('$525.00')).toBeVisible();
    expect(screen.getByText(/\$75\.00\/mo in known future card payments included/)).toBeVisible();
    fireEvent.click(screen.getAllByText('Explain this number')[0]!);
    expect(screen.getByText(/Before specifically scheduled card payments/)).toHaveTextContent(
      '$600.00 per month',
    );
  });

  it('traces projected occurrences to the canonical record that produced them', () => {
    const event = {
      id: 'generated-payment-occurrence',
      sourceRecordId: 'statement-cycle',
      label: 'Card payment',
      accountName: 'Checking',
      amountCents: 10_000,
      direction: 'outflow' as const,
      kind: 'card-payment',
      certainty: 'confirmed' as const,
      status: 'scheduled' as const,
      hypothetical: false,
      displayState: 'locked' as const,
      includedInExpected: true,
      includedInConservative: true,
    };
    expect(forecastEventSourcePath(event)).toBe(
      '/records?entityType=card-cycle&entityId=statement-cycle',
    );
    expect(
      forecastEventSourcePath({
        ...event,
        id: 'manual-event',
        sourceRecordId: undefined,
        kind: 'manual-adjustment',
      }),
    ).toBe('/records?entityType=forecast-event&entityId=manual-event');
  });
  it('updates a bank balance as of today and refreshes every Overview output', async () => {
    const nowSpy = vi
      .spyOn(Temporal.Now, 'plainDateISO')
      .mockReturnValue(Temporal.PlainDate.from('2030-02-05'));
    const refreshedSnapshot: ForecastSnapshotDto = {
      ...snapshot,
      currentConsolidatedCashCents: 72_550,
      currentTotalPositionCents: 97_550,
      expectedPositionLowCents: 93_784,
      conservativePositionLowCents: 93_784,
      cashAccounts: snapshot.cashAccounts?.map((account) =>
        account.id === 'reserve-checking' ? { ...account, balanceCents: 42_550 } : account,
      ),
      cardSpendingPower: snapshot.cardSpendingPower?.map((card) => ({
        ...card,
        spendingPowerCents: card.spendingPowerCents + 2_550,
      })),
      conservativeCardSpendingPower: snapshot.conservativeCardSpendingPower?.map((card) => ({
        ...card,
        spendingPowerCents: card.spendingPowerCents + 2_550,
      })),
    };
    vi.mocked(window.balanceBook.getForecast)
      .mockResolvedValueOnce({ ok: true, value: snapshot })
      .mockResolvedValueOnce({ ok: true, value: refreshedSnapshot });

    try {
      render(createElement(MemoryRouter, null, createElement(DashboardPage)));
      const accountPanel = await screen.findByLabelText('Overview cash accounts');
      const accountSummary = within(accountPanel).getByLabelText(
        'Reserve checking balance summary',
      );
      fireEvent.click(
        within(accountSummary).getByRole('button', {
          name: 'Open quick update for Reserve checking',
        }),
      );

      const dialog = await screen.findByRole('dialog');
      const balanceInput = within(dialog).getByLabelText('New balance');
      const dateInput = within(dialog).getByLabelText('Balance as of');
      expect(balanceInput).toHaveValue('400.00');
      expect(dateInput).toHaveValue('2030-02-03');
      expect(dateInput).toHaveAttribute('max', '2030-02-03');

      fireEvent.change(balanceInput, { target: { value: '425.50' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save balance' }));

      await waitFor(() => expect(window.balanceBook.upsertRecord).toHaveBeenCalledOnce());
      expect(window.balanceBook.upsertRecord).toHaveBeenCalledWith(
        overviewBalanceUpdateRequest(managedRecords.accounts[0]!, 42_550, '2030-02-03'),
      );
      const request = vi.mocked(window.balanceBook.upsertRecord).mock.calls[0]![0];
      expect(request.payload).toMatchObject({
        id: 'reserve-checking',
        type: 'savings',
        openingBalanceCents: 42_550,
        availableBalanceCents: 39_500,
        balanceAsOf: '2030-02-03',
        showOnOverview: true,
        preferredFloorCents: 10_000,
        transferDelayDays: 2,
        notes: 'Preserve account settings.',
      });
      expect(request.payload).not.toHaveProperty('userId');
      await waitFor(() => expect(window.balanceBook.getForecast).toHaveBeenCalledTimes(2));
      expect(
        within(screen.getByLabelText('Reserve checking balance summary')).getByText('$425.50'),
      ).toBeVisible();
      expect(screen.getByLabelText('Atlas Card available spend')).toHaveTextContent('$937.84');
      expect(within(accountPanel).getByRole('status')).toHaveTextContent(
        'Forecasts and spending power refreshed.',
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('logs a card expense and a shared Money Owed balance through one Overview save', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));

    fireEvent.click(await screen.findByRole('button', { name: 'Log an expense' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log an expense' });
    fireEvent.change(within(dialog).getByLabelText('Paid with'), {
      target: { value: 'credit-card:atlas-card' },
    });
    fireEvent.change(within(dialog).getByLabelText('Amount'), {
      target: { value: '100.00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Synthetic shared purchase' },
    });

    const reimbursable = within(dialog).getByRole('checkbox', {
      name: 'Reimbursable (100%)',
    });
    const shared = within(dialog).getByRole('checkbox', {
      name: 'Shared expense (50%)',
    });
    fireEvent.click(reimbursable);
    expect(reimbursable).toBeChecked();
    fireEvent.click(shared);
    expect(shared).toBeChecked();
    expect(reimbursable).not.toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('Owed by'), {
      target: { value: 'Synthetic counterparty' },
    });

    expect(within(dialog).getByText('Atlas Card current balance').nextSibling).toHaveTextContent(
      '$641.00',
    );
    expect(within(dialog).getByText('Added to Money Owed').nextSibling).toHaveTextContent('$50.00');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save expense' }));

    await waitFor(() => expect(window.balanceBook.recordOverviewExpense).toHaveBeenCalledOnce());
    expect(window.balanceBook.recordOverviewExpense).toHaveBeenCalledWith({
      paymentSource: { kind: 'credit-card', cardId: 'atlas-card' },
      amountCents: 10_000,
      date: '2030-02-03',
      label: 'Synthetic shared purchase',
      notes: undefined,
      owedTreatment: 'shared',
      owedBy: 'Synthetic counterparty',
    });
    await waitFor(() => expect(window.balanceBook.getForecast).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(
        'Synthetic shared purchase recorded on Atlas Card. $50.00 was added to Money Owed.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Log an expense' })).not.toBeInTheDocument();
  });

  it('builds narrow card balance updates without changing card terms or payment evidence', () => {
    const card = managedRecords.cards[0]!;
    const statement = managedRecords.cardCycles[0]!;

    expect(overviewCardBalanceUpdateRequest(card, 57_525, '2030-02-03')).toEqual({
      entityType: 'credit-card',
      payload: {
        ...Object.fromEntries(Object.entries(card).filter(([key]) => key !== 'userId')),
        reportedBalanceCents: 57_525,
        reportedBalanceDate: '2030-02-03',
      },
    });
    expect(overviewCardBalanceUpdateRequest(card, 57_525, '2030-02-03').payload).toMatchObject({
      paymentPolicy: 'full-statement',
      defaultFutureStatementCents: 60_000,
      creditLimitCents: 500_000,
    });
    expect(overviewCardBalanceUpdateRequest(card, 57_525, '2030-02-03').payload).not.toHaveProperty(
      'userId',
    );

    expect(overviewStatementBalanceUpdateRequest(statement, 85_000)).toEqual({
      entityType: 'card-cycle',
      payload: {
        ...statement,
        lockedStatementCents: 85_000,
      },
    });
    expect(overviewStatementBalanceUpdateRequest(statement, 85_000).payload).toMatchObject({
      state: 'paid',
      actualPaymentCents: 52_500,
      actualPaymentAccountId: 'primary-checking',
      paymentOn: '2030-02-02',
    });
  });

  it('logs a same-day deposit once without rebasing or changing account settings', async () => {
    const sameDayRecords: ManagedRecordsDto = {
      ...managedRecords,
      accounts: managedRecords.accounts.map((account) =>
        account.id === 'reserve-checking' ? { ...account, balanceAsOf: '2030-02-03' } : account,
      ),
    };
    vi.mocked(window.balanceBook.listRecords).mockResolvedValue({
      ok: true,
      value: sameDayRecords,
    });

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const origin = await screen.findByRole('button', {
      name: 'Open quick update for Reserve checking',
    });
    fireEvent.click(origin);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Transaction' }));
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'inflow' } });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '25.50' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Cash deposit' },
    });
    expect(within(dialog).getByText('Resulting account balance').nextSibling).toHaveTextContent(
      '$425.50',
    );

    const save = within(dialog).getByRole('button', { name: 'Save transaction' });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(window.balanceBook.upsertRecord).toHaveBeenCalledOnce());
    const request = vi.mocked(window.balanceBook.upsertRecord).mock.calls[0]![0];
    expect(request).toEqual(
      overviewCashTransactionRequest(sameDayRecords.accounts[0]!, {
        id: request.payload.id as string,
        direction: 'inflow',
        amountCents: 2_550,
        label: 'Cash deposit',
        date: '2030-02-03',
      }),
    );
    expect(request.payload).toMatchObject({
      accountId: 'reserve-checking',
      paymentMethod: 'cash-account',
      appliesAfterBalanceSnapshot: true,
    });
    expect(request.entityType).toBe('forecast-event');
    expect(request.payload).not.toHaveProperty('openingBalanceCents');
    await waitFor(() => expect(window.balanceBook.getForecast).toHaveBeenCalledTimes(2));
  });

  it('logs a card credit as card activity without changing cash or scheduled payments', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open quick update for Atlas Card' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Transaction' }));
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'inflow' } });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '41.00' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Merchant credit' },
    });
    expect(within(dialog).getByText('Resulting card balance').nextSibling).toHaveTextContent(
      '$500.00',
    );
    expect(within(dialog).getByText(/Current-cycle spending becomes/)).toHaveTextContent('$183.00');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save transaction' }));

    await waitFor(() => expect(window.balanceBook.upsertRecord).toHaveBeenCalledOnce());
    const request = vi.mocked(window.balanceBook.upsertRecord).mock.calls[0]![0];
    expect(request).toEqual(
      overviewCardTransactionRequest(managedRecords.cards[0]!, {
        id: request.payload.id as string,
        direction: 'inflow',
        amountCents: 4_100,
        label: 'Merchant credit',
        date: '2030-02-03',
      }),
    );
    expect(request.payload).toMatchObject({
      accountId: 'primary-checking',
      paymentMethod: 'credit-card',
      cardId: 'atlas-card',
      appliesAfterBalanceSnapshot: true,
    });
    expect(request.payload).not.toHaveProperty('actualPaymentCents');
    expect(request.payload).not.toHaveProperty('lockedStatementCents');
  });

  it('cancels a quick transaction without mutation and returns focus to its card', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const origin = await screen.findByRole('button', {
      name: 'Open quick update for Reserve checking',
    });
    origin.focus();
    fireEvent.click(origin);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Transaction' }));
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '25.50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(origin).toHaveFocus());
    expect(window.balanceBook.upsertRecord).not.toHaveBeenCalled();
  });

  it('keeps a failed transaction open with a localized error and unchanged inputs', async () => {
    vi.mocked(window.balanceBook.upsertRecord).mockResolvedValueOnce({
      ok: false,
      error: 'Synthetic persistence failure',
    });
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open quick update for Reserve checking' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Transaction' }));
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '25.50' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Failed withdrawal' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save transaction' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Synthetic persistence failure',
    );
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('25.50');
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Failed withdrawal');
    expect(window.balanceBook.getForecast).toHaveBeenCalledOnce();
  });

  it('flags a last-statement edit only after its due date', () => {
    expect(statementBalanceEditIsUnusual({ dueOn: '2030-02-02' }, '2030-02-01')).toBe(false);
    expect(statementBalanceEditIsUnusual({ dueOn: '2030-02-02' }, '2030-02-02')).toBe(false);
    expect(statementBalanceEditIsUnusual({ dueOn: '2030-02-02' }, '2030-02-03')).toBe(true);
  });

  it('updates a current card total from Overview without touching its statement or settings', async () => {
    const refreshedSnapshot: ForecastSnapshotDto = {
      ...snapshot,
      revolvingDebtByCard: snapshot.revolvingDebtByCard?.map((debt) => ({
        ...debt,
        currentBalanceCents: 57_525,
      })),
    };
    vi.mocked(window.balanceBook.getForecast)
      .mockResolvedValueOnce({ ok: true, value: snapshot })
      .mockResolvedValueOnce({ ok: true, value: refreshedSnapshot });

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const card = await screen.findByLabelText('Atlas Card safe spending summary');
    fireEvent.click(within(card).getByRole('button', { name: 'Open quick update for Atlas Card' }));

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Issuer current balance');
    expect(input).toHaveValue('541.00');
    expect(within(dialog).queryByRole('note')).toBeNull();
    fireEvent.change(input, { target: { value: '575.25' } });
    const save = within(dialog).getByRole('button', { name: 'Save balance' });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(window.balanceBook.upsertRecord).toHaveBeenCalledOnce());
    expect(window.balanceBook.upsertRecord).toHaveBeenCalledWith(
      overviewCardBalanceUpdateRequest(managedRecords.cards[0]!, 57_525, '2030-02-03'),
    );
    const request = vi.mocked(window.balanceBook.upsertRecord).mock.calls[0]![0];
    expect(request.payload).toMatchObject({
      reportedBalanceCents: 57_525,
      reportedBalanceDate: '2030-02-03',
      paymentPolicy: 'full-statement',
      defaultFutureStatementCents: 60_000,
    });
    await waitFor(() => expect(window.balanceBook.getForecast).toHaveBeenCalledTimes(2));
    expect(within(card).getByLabelText('Atlas Card current balance')).toHaveTextContent('$575.25');
    expect(within(card).getByLabelText('Atlas Card last statement balance')).toHaveTextContent(
      '$842.00',
    );
    expect(within(card).getByRole('status')).toHaveTextContent(
      'Forecasts and card details refreshed.',
    );
  });

  it('warns, then updates the latest statement without changing its recorded payment', async () => {
    const refreshedSnapshot: ForecastSnapshotDto = {
      ...snapshot,
      cardSpendingPower: snapshot.cardSpendingPower?.map((card) => ({
        ...card,
        statementAmountCents: 85_000,
        spendingPowerCents: 90_434,
      })),
      conservativeCardSpendingPower: snapshot.conservativeCardSpendingPower?.map((card) => ({
        ...card,
        statementAmountCents: 85_000,
        spendingPowerCents: 90_434,
      })),
      revolvingDebtByCard: snapshot.revolvingDebtByCard?.map((debt) => ({
        ...debt,
        latestStatementCents: 85_000,
        amountCurrentlyDueCents: 32_500,
        carryingBalanceCents: 32_500,
        projectedCarryingBalanceCents: 32_500,
      })),
    };
    vi.mocked(window.balanceBook.getForecast)
      .mockResolvedValueOnce({ ok: true, value: snapshot })
      .mockResolvedValueOnce({ ok: true, value: refreshedSnapshot });

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const card = await screen.findByLabelText('Atlas Card safe spending summary');
    fireEvent.click(within(card).getByRole('button', { name: 'Open quick update for Atlas Card' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Last statement' }));

    const warning = await screen.findByRole('note');
    const activeDialog = warning.closest<HTMLElement>('[role="dialog"]');
    expect(activeDialog).not.toBeNull();
    const input = within(activeDialog!).getByLabelText('Latest statement balance');
    expect(input).toHaveValue('842.00');
    expect(warning).toHaveTextContent('Editing it now is unusual');
    fireEvent.change(input, { target: { value: '850.00' } });
    fireEvent.click(within(activeDialog!).getByRole('button', { name: 'Save balance' }));

    await waitFor(() => expect(window.balanceBook.upsertRecord).toHaveBeenCalledOnce());
    expect(window.balanceBook.upsertRecord).toHaveBeenCalledWith(
      overviewStatementBalanceUpdateRequest(managedRecords.cardCycles[0]!, 85_000),
    );
    const request = vi.mocked(window.balanceBook.upsertRecord).mock.calls[0]![0];
    expect(request.payload).toMatchObject({
      lockedStatementCents: 85_000,
      state: 'paid',
      actualPaymentCents: 52_500,
      actualPaymentAccountId: 'primary-checking',
    });
    await waitFor(() => expect(window.balanceBook.getForecast).toHaveBeenCalledTimes(2));
    expect(within(card).getByLabelText('Atlas Card last statement balance')).toHaveTextContent(
      '$850.00',
    );
    expect(within(card).getByLabelText('Atlas Card still owed on statements')).toHaveTextContent(
      '$325.00',
    );
    expect(within(card).getByLabelText('Atlas Card available spend')).toHaveTextContent('$904.34');
  });

  it('keeps a positive total runway primary when one checking account has a negative low', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));

    await screen.findByRole('heading', { name: 'How much can I safely spend?' });
    expect(screen.getByText(/card runway, account coverage/i)).toBeVisible();
    expect(screen.getByText('How available spend works')).toBeVisible();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(`Your lowest total position is ${formatMoney(91_234)}.`);
    expect(status).not.toHaveTextContent(/liquid|funding needs attention/i);

    const card = screen.getByLabelText('Atlas Card safe spending summary');
    expect(within(card).getByText('Available this cycle')).toBeVisible();
    expect(within(card).getByLabelText('Atlas Card available spend')).toHaveTextContent(
      formatMoney(91_234),
    );
    expect(within(card).getByLabelText('Atlas Card current balance')).toHaveTextContent(
      formatMoney(54_100),
    );
    expect(within(card).getByLabelText('Atlas Card last statement balance')).toHaveTextContent(
      formatMoney(84_200),
    );
    expect(within(card).getByLabelText('Atlas Card still owed on statements')).toHaveTextContent(
      formatMoney(31_700),
    );
    expect(
      within(card).getByLabelText('Atlas Card owed to me at total position low'),
    ).toHaveTextContent(formatMoney(25_000));
    expect(
      within(card).getByLabelText('Atlas Card owed to me at total position low').parentElement,
    ).toHaveTextContent(formatPlainDate('2030-04-07'));
    expect(within(card).getByLabelText('Atlas Card next statement position')).toHaveTextContent(
      formatMoney(102_468),
    );
    expect(within(card).getByLabelText('Atlas Card next statement position')).toHaveTextContent(
      `Lowest from ${formatPlainDate('2030-04-28')} forward`,
    );
    expect(within(card).queryByText('Runway available', { exact: true })).toBeNull();
    expect(within(card).queryByText('Needs card setup', { exact: true })).toBeNull();
    expect(within(card).getByLabelText('Atlas Card next due date')).toHaveTextContent(
      `Due ${formatPlainDate('2030-03-28')}`,
    );
    expect(card).not.toHaveTextContent(/conditional|funding needed|after funding/i);

    const totalLow = within(card).getByLabelText('Atlas Card total position low');
    expect(totalLow).toHaveTextContent(formatMoney(91_234));
    expect(totalLow.parentElement).toHaveTextContent(formatPlainDate('2030-04-07'));

    const reserveLow = within(card).getByLabelText('Atlas Card Reserve checking account low');
    const primaryLow = within(card).getByLabelText('Atlas Card Primary checking account low');
    expect(reserveLow).toHaveTextContent(formatMoney(45_678));
    expect(reserveLow.parentElement).toHaveTextContent(formatPlainDate('2030-04-07'));
    expect(primaryLow).toHaveTextContent(formatMoney(-12_345));
    expect(primaryLow.parentElement).toHaveTextContent(formatPlainDate('2030-03-21'));
    expect(primaryLow.className).not.toBe(reserveLow.className);

    for (const removedLabel of [
      'Payment-date funding snapshot',
      'Cash-only capacity',
      'Funding-account low',
      'Owed to me',
      'Current cycle',
    ]) {
      expect(within(card).queryByText(removedLabel, { exact: true })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Lowest liquid cash', { exact: true })).not.toBeInTheDocument();
    expect(
      screen.getByText(`First low ${formatMoney(-12_345)} · ${formatPlainDate('2030-03-21')}`),
    ).toBeVisible();
    expect(screen.queryByText(new RegExp(formatMoney(-99_999).replace('$', '\\$')))).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'How each safe-spend limit is calculated' }),
    ).not.toBeInTheDocument();

    const upcomingHeading = screen.getByRole('heading', { name: 'Upcoming cash events' });
    const advisorHeading = screen.getByRole('heading', { name: 'Which card should I use?' });
    expect(
      upcomingHeading.compareDocumentPosition(advisorHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Conservative' }));

    expect(screen.getByText('Lowest liquid cash', { exact: true })).toBeVisible();
    expect(within(card).getByText('Cash capacity', { exact: true })).toBeVisible();
    expect(within(card).getByText('Payment account low', { exact: true })).toBeVisible();
    expect(within(card).getByText('Cash low', { exact: true })).toBeVisible();
    expect(
      screen.getByText(
        `Money owed to you can cover this run if you release ${formatMoney(12_345)} to Primary checking by ${formatPlainDate('2030-03-21')}.`,
      ),
    ).toBeVisible();
  });

  it('counts statement reset days from today instead of the forecast start date', async () => {
    const nowSpy = vi
      .spyOn(Temporal.Now, 'plainDateISO')
      .mockReturnValue(Temporal.PlainDate.from('2026-07-01'));
    const resetCard = {
      ...cardPower,
      currentCycleClosesOn: '2026-07-10' as const,
    };
    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        startDate: '2026-07-05',
        cardSpendingPower: [resetCard],
        conservativeCardSpendingPower: [resetCard],
      },
    });

    try {
      render(createElement(MemoryRouter, null, createElement(DashboardPage)));
      const card = await screen.findByLabelText('Atlas Card safe spending summary');
      expect(
        within(card).getByLabelText(/9 days until the current statement resets/i),
      ).toHaveTextContent('9');
      expect(within(card).queryByText('Resets in 9 days')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('sorts cards by period remaining by default and exposes every requested order', async () => {
    const cards: CardPower[] = [
      {
        ...cardPower,
        cardId: 'zenith',
        cardName: 'Zenith',
        currentCycleClosesOn: '2030-02-20',
        spendingPowerCents: 60_000,
      },
      {
        ...cardPower,
        cardId: 'atlas',
        cardName: 'Atlas',
        currentCycleClosesOn: '2030-02-10',
        spendingPowerCents: 20_000,
      },
      {
        ...cardPower,
        cardId: 'beacon',
        cardName: 'Beacon',
        currentCycleClosesOn: undefined,
        spendingPowerCents: 0,
        spendingPowerStatus: 'indeterminate-cycle-timing',
      },
    ];
    const debts: NonNullable<ForecastSnapshotDto['revolvingDebtByCard']> = [
      { ...snapshot.revolvingDebtByCard![0]!, cardId: 'zenith', currentBalanceCents: 60_000 },
      {
        ...snapshot.revolvingDebtByCard![0]!,
        cardId: 'atlas',
        currentBalanceCents: 20_000,
        latestStatementCents: 10_000,
      },
      {
        ...snapshot.revolvingDebtByCard![0]!,
        cardId: 'beacon',
        currentBalanceCents: 90_000,
        latestStatementCents: 120_000,
      },
    ];
    expect(sortOverviewCards(cards, debts, 'period-asc').map((card) => card.cardName)).toEqual([
      'Atlas',
      'Zenith',
      'Beacon',
    ]);
    expect(sortOverviewCards(cards, debts, 'period-desc').map((card) => card.cardName)).toEqual([
      'Zenith',
      'Atlas',
      'Beacon',
    ]);
    expect(sortOverviewCards(cards, debts, 'name-desc').map((card) => card.cardName)).toEqual([
      'Zenith',
      'Beacon',
      'Atlas',
    ]);
    expect(sortOverviewCards(cards, debts, 'balance-desc').map((card) => card.cardName)).toEqual([
      'Beacon',
      'Zenith',
      'Atlas',
    ]);
    expect(sortOverviewCards(cards, debts, 'statement-asc').map((card) => card.cardName)).toEqual([
      'Atlas',
      'Zenith',
      'Beacon',
    ]);
    expect(sortOverviewCards(cards, debts, 'available-asc').map((card) => card.cardName)).toEqual([
      'Atlas',
      'Zenith',
      'Beacon',
    ]);
    expect(sortOverviewCards(cards, debts, 'available-desc').map((card) => card.cardName)).toEqual([
      'Zenith',
      'Atlas',
      'Beacon',
    ]);

    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        cardSpendingPower: cards,
        conservativeCardSpendingPower: cards,
        revolvingDebtByCard: debts,
      },
    });
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const orderedCardNames = () =>
      screen
        .getAllByLabelText(/safe spending summary$/)
        .map((element) =>
          element.getAttribute('aria-label')!.replace(' safe spending summary', ''),
        );
    await screen.findByLabelText('Atlas safe spending summary');
    expect(orderedCardNames()).toEqual(['Atlas', 'Zenith', 'Beacon']);
    fireEvent.change(screen.getByLabelText('Overview card sort order'), {
      target: { value: 'name-desc' },
    });
    expect(orderedCardNames()).toEqual(['Zenith', 'Beacon', 'Atlas']);
    fireEvent.change(screen.getByLabelText('Overview card sort order'), {
      target: { value: 'balance-desc' },
    });
    expect(orderedCardNames()).toEqual(['Beacon', 'Zenith', 'Atlas']);
  });

  it.each([
    ['2026-06-30', `Past due ${formatPlainDate('2026-06-30')}`],
    ['2026-07-01', `Due today · ${formatPlainDate('2026-07-01')}`],
    ['2026-07-10', `Due ${formatPlainDate('2026-07-10')}`],
    [undefined, 'Due date unavailable'],
  ] as const)(
    'labels the contractual due date without substituting payment timing',
    async (dueOn, copy) => {
      const nowSpy = vi
        .spyOn(Temporal.Now, 'plainDateISO')
        .mockReturnValue(Temporal.PlainDate.from('2026-07-01'));
      vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
        ok: true,
        value: {
          ...snapshot,
          cardSpendingPower: [{ ...cardPower, nextDueOn: dueOn }],
          conservativeCardSpendingPower: [{ ...cardPower, nextDueOn: dueOn }],
        },
      });

      try {
        render(createElement(MemoryRouter, null, createElement(DashboardPage)));
        const card = await screen.findByLabelText('Atlas Card safe spending summary');
        expect(within(card).getByLabelText('Atlas Card next due date')).toHaveTextContent(copy);
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it('does not label a past recorded due date as overdue when no statement debt remains', async () => {
    const nowSpy = vi
      .spyOn(Temporal.Now, 'plainDateISO')
      .mockReturnValue(Temporal.PlainDate.from('2026-07-01'));
    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        cardSpendingPower: [{ ...cardPower, nextDueOn: '2026-06-30' }],
        conservativeCardSpendingPower: [{ ...cardPower, nextDueOn: '2026-06-30' }],
        revolvingDebtByCard: snapshot.revolvingDebtByCard?.map((debt) => ({
          ...debt,
          amountCurrentlyDueCents: 0,
          carryingBalanceCents: 0,
          projectedCarryingBalanceCents: 0,
          overdue: false,
        })),
      },
    });

    try {
      render(createElement(MemoryRouter, null, createElement(DashboardPage)));
      const dueDate = await screen.findByLabelText('Atlas Card next due date');
      expect(dueDate).toHaveTextContent(`Paid · ${formatPlainDate('2026-06-30')}`);
      expect(dueDate).not.toHaveTextContent('Past due');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not call a stale statement close date a reset today', async () => {
    const nowSpy = vi
      .spyOn(Temporal.Now, 'plainDateISO')
      .mockReturnValue(Temporal.PlainDate.from('2026-07-01'));
    const staleResetCard = {
      ...cardPower,
      currentCycleClosesOn: '2026-06-30' as const,
    };
    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        cardSpendingPower: [staleResetCard],
        conservativeCardSpendingPower: [staleResetCard],
      },
    });

    try {
      render(createElement(MemoryRouter, null, createElement(DashboardPage)));
      const card = await screen.findByLabelText('Atlas Card safe spending summary');
      expect(
        within(card).getByLabelText(/recorded statement reset date passed/i),
      ).toHaveTextContent('!');
      expect(within(card).getByText(/Reset date needs update/)).toBeVisible();
      expect(within(card).queryByText('Resets today')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('hides only the selected account card while preserving its funding warning', async () => {
    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        cashAccounts: snapshot.cashAccounts?.map((account) => ({
          ...account,
          showOnOverview: account.id !== 'primary-checking',
        })),
      },
    });

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const accountPanel = await screen.findByLabelText('Overview cash accounts');
    expect(within(accountPanel).getByText('Reserve checking')).toBeVisible();
    expect(within(accountPanel).queryByText('Primary checking')).toBeNull();
    const fundingSection = screen
      .getByRole('heading', { name: 'Funding actions' })
      .closest('section');
    expect(fundingSection).not.toBeNull();
    expect(fundingSection).toHaveTextContent('Primary checking');
  });

  it('keeps statement history, current debt, and a partial-payment remainder distinct', async () => {
    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        revolvingDebtByCard: [
          {
            ...snapshot.revolvingDebtByCard![0]!,
            latestStatementCents: 100_000,
            amountCurrentlyDueCents: 75_000,
            actualOpenCycleCents: 20_000,
            projectedOpenCycleCents: 20_000,
            currentBalanceCents: 95_000,
            carryingBalanceCents: 75_000,
            projectedCarryingBalanceCents: 75_000,
          },
        ],
      },
    });

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const card = await screen.findByLabelText('Atlas Card safe spending summary');
    expect(within(card).getByLabelText('Atlas Card current balance')).toHaveTextContent(
      formatMoney(95_000),
    );
    expect(within(card).getByLabelText('Atlas Card last statement balance')).toHaveTextContent(
      formatMoney(100_000),
    );
    expect(within(card).getByLabelText('Atlas Card still owed on statements')).toHaveTextContent(
      formatMoney(75_000),
    );
  });

  it('hides Still owed for a normal coming-due statement that is not being carried', async () => {
    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        revolvingDebtByCard: [
          {
            ...snapshot.revolvingDebtByCard![0]!,
            amountCurrentlyDueCents: 84_200,
            carryingBalanceCents: 0,
            projectedCarryingBalanceCents: 0,
            overdue: false,
          },
        ],
      },
    });

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const card = await screen.findByLabelText('Atlas Card safe spending summary');
    expect(within(card).getByLabelText('Atlas Card current balance')).toBeVisible();
    expect(within(card).getByLabelText('Atlas Card last statement balance')).toBeVisible();
    expect(within(card).queryByText('Still owed')).toBeNull();
    expect(within(card).queryByLabelText('Atlas Card still owed on statements')).toBeNull();
  });

  it('shows posted debt without inventing statement facts when no statement is recorded', async () => {
    vi.mocked(window.balanceBook.getForecast).mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        revolvingDebtByCard: [
          {
            ...snapshot.revolvingDebtByCard![0]!,
            latestStatementCents: 0,
            latestStatementDate: undefined,
            amountCurrentlyDueCents: 0,
            currentBalanceCents: 54_100,
            carryingBalanceCents: 0,
            projectedCarryingBalanceCents: 0,
          },
        ],
      },
    });

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    const card = await screen.findByLabelText('Atlas Card safe spending summary');
    expect(within(card).getByLabelText('Atlas Card current balance')).toHaveTextContent(
      formatMoney(54_100),
    );
    expect(within(card).getByLabelText('Atlas Card last statement balance')).toHaveTextContent('—');
    expect(within(card).queryByLabelText('Atlas Card still owed on statements')).toBeNull();
  });

  it('applies Overview defaults without hiding safety-critical account coverage', async () => {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(DashboardPage, {
          preferences: {
            ...defaultProfilePreferences,
            overviewForecastMode: 'conservative',
            compactLayout: false,
            reduceMotion: false,
            showOverviewDailySummary: false,
            showOverviewUpcomingEvents: false,
            showOverviewWiderPicture: false,
          },
        }),
      ),
    );

    await screen.findByRole('heading', { name: 'How much can I safely spend?' });
    expect(screen.getByRole('button', { name: 'Conservative' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByLabelText('Daily decision summary')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Upcoming cash events' })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Debt, net worth, and review status' }),
    ).toBeNull();
    expect(screen.getByLabelText('Overview cash accounts')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Funding actions' })).toBeVisible();
  });

  it('answers cash safety and card safety independently for a $150 purchase', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));

    await screen.findByRole('heading', { name: 'Which card should I use?' });
    fireEvent.click(screen.getAllByText('Test a purchase').at(-1)!);
    fireEvent.change(screen.getByLabelText('Purchase amount'), { target: { value: '150.00' } });
    fireEvent.change(screen.getByLabelText('Purchase date'), {
      target: { value: '2030-02-03' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compare every card' }));

    expect(await screen.findByRole('heading', { name: 'You can use any card' })).toBeVisible();
    expect(
      screen.getByRole('heading', {
        name: 'Cash works only after funding the account',
      }),
    ).toBeVisible();
    expect(screen.getAllByText('Can use after funding')).toHaveLength(2);
    expect(screen.getByText('Resulting available spend')).toBeVisible();
    expect(screen.getAllByText('$640.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Following statement position').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$750.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('No safe card for this purchase', { exact: true })).toBeNull();
    expect(window.balanceBook.evaluateScenario).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(window.balanceBook.evaluateScenario)
        .mock.calls.map(([request]) => request.forecastMode),
    ).toEqual(['expected', 'expected', 'expected']);

    fireEvent.click(screen.getByRole('button', { name: 'Conservative' }));
    expect(screen.queryByRole('heading', { name: 'You can use any card' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compare every card' }));
    await screen.findByRole('heading', { name: 'You can use any card' });
    expect(
      vi
        .mocked(window.balanceBook.evaluateScenario)
        .mock.calls.slice(-3)
        .map(([request]) => request.forecastMode),
    ).toEqual(['conservative', 'conservative', 'conservative']);
  });

  it('discards an in-flight advisor result when the forecast mode changes', async () => {
    type EvaluationResult = Awaited<ReturnType<BalanceBookApi['evaluateScenario']>>;
    const pendingRequests: Array<{
      mode: 'expected' | 'conservative';
      resolve: (result: EvaluationResult) => void;
    }> = [];
    vi.mocked(window.balanceBook.evaluateScenario).mockImplementation(
      (request) =>
        new Promise<EvaluationResult>((resolve) => {
          pendingRequests.push({ mode: request.forecastMode, resolve });
        }),
    );

    render(createElement(MemoryRouter, null, createElement(DashboardPage)));
    await screen.findByRole('heading', { name: 'Which card should I use?' });
    fireEvent.click(screen.getAllByText('Test a purchase').at(-1)!);
    fireEvent.change(screen.getByLabelText('Purchase amount'), { target: { value: '150.00' } });
    fireEvent.change(screen.getByLabelText('Purchase date'), {
      target: { value: '2030-02-03' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compare every card' }));
    await waitFor(() => expect(pendingRequests).toHaveLength(3));
    expect(pendingRequests.map((request) => request.mode)).toEqual([
      'expected',
      'expected',
      'expected',
    ]);
    expect(screen.getByRole('button', { name: 'Checking purchase...' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Conservative' }));
    expect(screen.getByRole('button', { name: 'Conservative' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Compare every card' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Compare every card' }));
    await waitFor(() => expect(pendingRequests).toHaveLength(6));
    expect(pendingRequests.slice(3).map((request) => request.mode)).toEqual([
      'conservative',
      'conservative',
      'conservative',
    ]);

    const freshResult: EvaluationResult = {
      ok: true,
      value: {
        verdict: 'affordable-under-current-assumptions',
        settlementDate: '2030-03-21',
        beforeTroughCents: 70_000,
        afterTroughCents: 55_000,
        afterHardFloorMarginCents: 55_000,
        afterAvailableToDeployCents: 55_000,
        accountShortfallCount: 0,
        transferNeeds: [],
        fundingAccountName: 'Primary checking',
        purchaseSafety: {
          safe: true,
          totalPositionLowCents: 55_000,
          totalPositionLowDate: '2030-03-21',
          totalPositionMarginCents: 55_000,
          fundingAccountLowCents: 20_000,
          fundingAccountLowDate: '2030-03-21',
          fundingAccountFloorCents: 0,
          fundingAccountShortfallCents: 0,
          receivableOutstandingCents: 0,
          receivableReleaseNeededCents: 0,
          uncoveredFundingShortfallCents: 0,
        },
      },
    };
    await act(async () => {
      for (const request of pendingRequests.slice(3)) request.resolve(freshResult);
      await Promise.allSettled(
        vi
          .mocked(window.balanceBook.evaluateScenario)
          .mock.results.slice(3)
          .map((result) => result.value),
      );
    });
    expect(await screen.findByRole('heading', { name: 'You can use any card' })).toBeVisible();

    const staleResult: EvaluationResult = {
      ok: true,
      value: {
        ...freshResult.value,
        verdict: 'breaches-protected-floor',
        afterHardFloorMarginCents: -25_000,
        afterAvailableToDeployCents: 0,
        purchaseSafety: {
          ...freshResult.value.purchaseSafety!,
          safe: false,
          totalPositionLowCents: -25_000,
          totalPositionMarginCents: -25_000,
        },
      },
    };
    await act(async () => {
      for (const request of pendingRequests.slice(0, 3)) request.resolve(staleResult);
      await Promise.allSettled(
        vi
          .mocked(window.balanceBook.evaluateScenario)
          .mock.results.slice(0, 3)
          .map((result) => result.value),
      );
    });

    expect(screen.getByRole('heading', { name: 'You can use any card' })).toBeVisible();
    expect(screen.queryByText('No safe card for this purchase', { exact: true })).toBeNull();
    expect(screen.getByLabelText('Cash purchase safety')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Compare every card' })).toBeEnabled();
  });
});
