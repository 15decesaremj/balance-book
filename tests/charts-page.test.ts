// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartsPage } from '../apps/desktop/src/renderer/ChartsPage';
import type {
  BalanceBookApi,
  ForecastSnapshotDto,
  ManagedRecordsDto,
} from '../apps/desktop/src/shared/contracts';
import { formatMoney } from '../apps/desktop/src/renderer/utils';

const records: ManagedRecordsDto = {
  accounts: [
    {
      id: 'checking-a',
      userId: 'profile-a',
      name: 'Checking A',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-06-15',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      showOnOverview: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    },
  ],
  events: [],
  cards: [],
  cardCycles: [],
  loans: [],
  committedRefinancePlans: [],
  receivables: [],
  assets: [],
  rewardPrograms: [],
  reconciliations: [],
  savedScenarios: [],
};

const point = (
  date: string,
  cents: number,
): NonNullable<ForecastSnapshotDto['dailyCash']>[number] => ({
  date,
  conservativeCashCents: cents,
  expectedCashCents: cents,
  conservativeInTransitCents: 0,
  expectedInTransitCents: 0,
  conservativeReceivableCents: 0,
  expectedReceivableCents: 0,
  conservativePositionCents: cents,
  expectedPositionCents: cents,
  accountBalances: [
    {
      accountId: 'checking-a',
      accountName: 'Checking A',
      available: true,
      conservativeCashCents: cents,
      expectedCashCents: cents,
    },
  ],
  events: [],
});

const forecast: ForecastSnapshotDto = {
  setupComplete: true,
  startDate: '2026-07-01',
  endDate: '2026-08-01',
  currentTotalPositionCents: 100_000,
  currentReceivableCents: 0,
  totalCarryingDebtCents: 0,
  contractualNetWorthCents: 100_000,
  dailyCash: [point('2026-07-01', 100_000), point('2026-08-01', 110_000)],
};

beforeEach(() => {
  Object.defineProperty(window, 'balanceBook', {
    configurable: true,
    value: {
      listRecords: vi.fn().mockResolvedValue({ ok: true, value: records }),
      getForecast: vi.fn().mockResolvedValue({ ok: true, value: forecast }),
    } as unknown as BalanceBookApi,
  });
});

afterEach(() => {
  cleanup();
});

describe('Charts page', () => {
  it('loads both data sources and exposes accessible time, category, legend, and chart controls', async () => {
    render(createElement(ChartsPage));

    await screen.findByRole('heading', { name: 'Trends' });
    expect(window.balanceBook.listRecords).toHaveBeenCalledOnce();
    expect(window.balanceBook.getForecast).toHaveBeenCalledOnce();
    expect(screen.getByText(/12 months back · 12 months forward/i)).toBeVisible();
    expect(screen.getByRole('img', { name: /financial balance trends/i })).toBeVisible();

    const historical = screen.getByRole('button', { name: 'Historical' });
    const future = screen.getByRole('button', { name: 'Expected future' });
    expect(historical).toHaveAttribute('aria-pressed', 'true');
    expect(future).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(historical);
    expect(historical).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('img', { name: /financial balance trends/i })).toBeVisible();

    const cashCategory = screen.getByRole('button', { name: /cash accounts/i });
    expect(cashCategory).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(cashCategory);
    expect(cashCategory).toHaveAttribute('aria-pressed', 'false');

    const checkingLegend = screen.getByRole('button', { name: 'Checking A' });
    expect(checkingLegend).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(checkingLegend);
    expect(cashCategory).toHaveAttribute('aria-pressed', 'true');
    expect(checkingLegend).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/missing history stays blank/i)).toBeVisible();

    fireEvent.click(screen.getByText(/view chart data/i));
    expect(screen.getByRole('table', { name: 'Visible chart data' })).toBeVisible();
  });

  it('recalculates the displayed range from only the currently visible series', async () => {
    vi.mocked(window.balanceBook.listRecords).mockResolvedValue({
      ok: true,
      value: {
        ...records,
        assets: [
          {
            id: 'investment-a',
            userId: 'profile-a',
            name: 'Investment A',
            type: 'investment',
            valueCents: 900_000,
            valuationDate: '2026-07-01',
            includedInNetWorth: true,
            includedInLiquidity: false,
          },
        ],
      },
    });

    render(createElement(ChartsPage));
    const rangeLabel = await screen.findByText('Visible recorded range');
    const rangeCard = rangeLabel.parentElement;
    expect(rangeCard).not.toBeNull();
    expect(
      within(rangeCard!).getByText(`${formatMoney(0)} – ${formatMoney(900_000)}`),
    ).toBeVisible();

    fireEvent.click(
      within(screen.getByLabelText('Chart controls')).getByRole('button', {
        name: /investments & assets/i,
      }),
    );
    expect(
      within(rangeCard!).getByText(`${formatMoney(0)} – ${formatMoney(110_000)}`),
    ).toBeVisible();
  });
});
