// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Temporal } from '@js-temporal/polyfill';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from '../apps/desktop/src/renderer/DashboardPage';
import { formatMoney, formatPlainDate } from '../apps/desktop/src/renderer/utils';
import type { BalanceBookApi, ForecastSnapshotDto } from '../apps/desktop/src/shared/contracts';

type CardPower = NonNullable<ForecastSnapshotDto['cardSpendingPower']>[number];

const cardPower: CardPower = {
  cardId: 'atlas-card',
  cardName: 'Atlas Card',
  fundingAccountId: 'primary-checking',
  fundingAccountName: 'Primary checking',
  statementAmountCents: 84_200,
  currentCycleAmountCents: 0,
  nextDueOn: '2030-03-28',
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
};

beforeEach(() => {
  Object.defineProperty(window, 'balanceBook', {
    configurable: true,
    value: {
      getForecast: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
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
              },
            };
          },
        ),
    } as unknown as BalanceBookApi,
  });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Overview card runway presentation', () => {
  it('keeps a positive total runway primary when one checking account has a negative low', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));

    await screen.findByRole('heading', { name: 'How much can I safely spend?' });
    expect(screen.getByText(/tied to its current-cycle due date/i)).toBeVisible();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(`Your lowest total position is ${formatMoney(91_234)}.`);
    expect(status).not.toHaveTextContent(/liquid|funding needs attention/i);

    const card = screen.getByLabelText('Atlas Card safe spending summary');
    expect(within(card).getByText('Available spend in current cycle')).toBeVisible();
    expect(within(card).getByLabelText('Atlas Card available spend')).toHaveTextContent(
      formatMoney(91_234),
    );
    expect(within(card).getByText('Runway available', { exact: true })).toBeVisible();
    expect(within(card).getByLabelText('Atlas Card next due date')).toHaveTextContent(
      `Next due ${formatPlainDate('2030-03-28')}`,
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
      screen.getByText(
        `Next below minimum ${formatMoney(-12_345)} on ${formatPlainDate('2030-03-21')}`,
      ),
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
    expect(within(card).getByText('Cash-only capacity', { exact: true })).toBeVisible();
    expect(within(card).getByText('Funding-account low', { exact: true })).toBeVisible();
    expect(within(card).getByText('Future liquid cash low', { exact: true })).toBeVisible();
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
      expect(within(card).getByText('Resets in 9 days')).toBeVisible();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    ['2026-06-30', `Past due ${formatPlainDate('2026-06-30')}`],
    ['2026-07-01', `Due today · ${formatPlainDate('2026-07-01')}`],
    ['2026-07-10', `Next due ${formatPlainDate('2026-07-10')}`],
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

  it('answers cash safety and card safety independently for a $150 purchase', async () => {
    render(createElement(MemoryRouter, null, createElement(DashboardPage)));

    await screen.findByRole('heading', { name: 'Which card should I use?' });
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
});
