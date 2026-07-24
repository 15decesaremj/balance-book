// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconciliationPage } from '../apps/desktop/src/renderer/CorePages';
import type {
  BalanceBookApi,
  ForecastSnapshotDto,
  ManagedRecordsDto,
} from '../apps/desktop/src/shared/contracts';

const account: ManagedRecordsDto['accounts'][number] = {
  id: 'checking-a',
  userId: 'profile-a',
  name: 'Checking A',
  type: 'checking',
  openingBalanceCents: 100_000,
  balanceAsOf: '2030-02-03',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  showOnOverview: true,
  hardFloorCents: 0,
  transferDelayDays: 0,
};

const plannedEvent: ManagedRecordsDto['events'][number] = {
  id: 'bill-a',
  userId: 'profile-a',
  accountId: account.id,
  date: '2030-02-03',
  kind: 'bill',
  direction: 'outflow',
  amountCents: 5_000,
  certainty: 'confirmed',
  status: 'planned',
  label: 'Synthetic bill',
  hypothetical: false,
  accepted: false,
  paymentMethod: 'cash-account',
};

const baseRecords: ManagedRecordsDto = {
  accounts: [account],
  events: [plannedEvent],
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

const forecast: ForecastSnapshotDto = {
  setupComplete: true,
  startDate: '2030-02-03',
  endDate: '2030-03-03',
  cashAccounts: [{ id: account.id, name: account.name, balanceCents: 100_000, hardFloorCents: 0 }],
  dailyCash: [
    {
      date: '2030-02-03',
      conservativeCashCents: 100_000,
      expectedCashCents: 100_000,
      conservativeInTransitCents: 0,
      expectedInTransitCents: 0,
      conservativeReceivableCents: 0,
      expectedReceivableCents: 0,
      conservativePositionCents: 100_000,
      expectedPositionCents: 100_000,
      accountBalances: [
        {
          accountId: account.id,
          accountName: account.name,
          available: true,
          conservativeCashCents: 100_000,
          expectedCashCents: 100_000,
        },
      ],
      events: [],
    },
  ],
};

const renderPage = () =>
  render(createElement(MemoryRouter, null, createElement(ReconciliationPage)));

describe('Reconciliation mutation controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'balanceBook', {
      configurable: true,
      value: {
        listRecords: vi.fn().mockResolvedValue({ ok: true, value: baseRecords }),
        getForecast: vi.fn().mockResolvedValue({ ok: true, value: forecast }),
        upsertRecord: vi.fn(),
      } as unknown as BalanceBookApi,
    });
  });

  afterEach(() => cleanup());

  it('synchronously blocks duplicate reconciliation submits and exposes the saved row', async () => {
    let resolveSave: ((value: { ok: true; value: ManagedRecordsDto }) => void) | undefined;
    const savedRecords: ManagedRecordsDto = {
      ...baseRecords,
      reconciliations: [
        {
          id: 'reconciliation-a',
          userId: 'profile-a',
          accountId: account.id,
          date: '2030-02-03',
          forecastBalanceCents: 100_000,
          actualBalanceCents: 99_000,
          varianceCents: -1_000,
          resolution: 'explained',
          note: 'Synthetic check',
        },
      ],
    };
    vi.mocked(window.balanceBook.upsertRecord).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    renderPage();
    await screen.findByRole('heading', { name: 'Financial check-in' });
    fireEvent.click(screen.getByText('Compare an actual balance'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Actual balance' }), {
      target: { value: '990.00' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note (optional)' }), {
      target: { value: 'Synthetic check' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Resolution' }), {
      target: { value: 'explained' },
    });

    const form = screen.getByRole('button', { name: 'Save balance check' }).closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(window.balanceBook.upsertRecord).toHaveBeenCalledTimes(1);
    expect(window.balanceBook.upsertRecord).toHaveBeenCalledWith({
      entityType: 'reconciliation',
      payload: expect.objectContaining({
        accountId: account.id,
        date: '2030-02-03',
        forecastBalanceCents: 100_000,
        actualBalanceCents: 99_000,
        varianceCents: -1_000,
        resolution: 'explained',
        note: 'Synthetic check',
      }),
    });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    await act(async () => resolveSave?.({ ok: true, value: savedRecords }));
    expect(await screen.findByRole('status')).toHaveTextContent('Balance check saved');
    expect(screen.getByText('Balance-check history (1)')).toBeInTheDocument();
  });

  it('refreshes forecast outputs after a status edit and keeps failures visible outside disclosures', async () => {
    const paidRecords: ManagedRecordsDto = {
      ...baseRecords,
      events: [{ ...plannedEvent, status: 'paid' }],
    };
    vi.mocked(window.balanceBook.upsertRecord)
      .mockResolvedValueOnce({ ok: true, value: paidRecords })
      .mockRejectedValueOnce(new Error('Synthetic status failure'));

    renderPage();
    await screen.findByRole('heading', { name: 'Financial check-in' });
    fireEvent.click(screen.getByText('Resolve individual forecast events'));
    const statusSelect = screen.getByRole('combobox', { name: 'Status for Synthetic bill' });
    fireEvent.change(statusSelect, { target: { value: 'paid' } });

    await waitFor(() => expect(window.balanceBook.getForecast).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('status')).toHaveTextContent('displayed forecast');
    expect(statusSelect).toHaveValue('paid');

    fireEvent.change(statusSelect, { target: { value: 'skipped' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic status failure');
  });
});
