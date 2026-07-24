// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationCenter } from '../apps/desktop/src/renderer/NotificationCenter';
import { FINANCIAL_STATE_CHANGED_EVENT } from '../apps/desktop/src/renderer/financial-events';
import type {
  BalanceBookApi,
  ForecastSnapshotDto,
  ManagedRecordsDto,
} from '../apps/desktop/src/shared/contracts';

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

const staleSnapshot: ForecastSnapshotDto = {
  setupComplete: true,
  startDate: '2026-07-01',
  cashAccounts: [
    {
      id: 'checking',
      name: 'Checking',
      balanceCents: 105_000,
      sourceBalanceCents: 100_000,
      sourceBalanceDate: '2026-06-01',
      calculatedThroughDate: '2026-07-01',
      postSourceChangeCents: 5_000,
      hardFloorCents: 0,
    },
  ],
  cardSpendingPower: [],
  transferNeeds: [],
  expectedTransferNeeds: [],
};

let forecast = staleSnapshot;

beforeEach(() => {
  forecast = staleSnapshot;
  Object.defineProperty(window, 'balanceBook', {
    configurable: true,
    value: {
      getForecast: vi.fn().mockImplementation(async () => ({ ok: true, value: forecast })),
      listRecords: vi.fn().mockResolvedValue({ ok: true, value: records }),
      listNotificationPresentations: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      setNotificationPresentations: vi.fn().mockImplementation(async (request) => ({
        ok: true,
        value: request.updates.map((update: object) => ({
          ...update,
          updatedAt: '2026-07-01T12:01:00.000Z',
        })),
      })),
      upsertRecord: vi.fn().mockResolvedValue({ ok: false, error: 'Database is busy.' }),
    } as unknown as BalanceBookApi,
  });
});

afterEach(() => cleanup());

describe('notification center presentation and actions', () => {
  it('ignores an older refresh that completes after newer canonical state', async () => {
    let resolveOlder!: (value: { ok: true; value: ForecastSnapshotDto }) => void;
    const older = new Promise<{ ok: true; value: ForecastSnapshotDto }>((resolve) => {
      resolveOlder = resolve;
    });
    const currentSnapshot: ForecastSnapshotDto = {
      ...staleSnapshot,
      cashAccounts: staleSnapshot.cashAccounts?.map((account) => ({
        ...account,
        sourceBalanceCents: account.balanceCents,
        sourceBalanceDate: '2026-07-01',
        postSourceChangeCents: 0,
      })),
    };
    vi.mocked(window.balanceBook.getForecast)
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce({ ok: true, value: currentSnapshot });
    const rendered = render(
      createElement(MemoryRouter, null, createElement(NotificationCenter, { refreshKey: '/' })),
    );
    await waitFor(() => expect(window.balanceBook.getForecast).toHaveBeenCalledOnce());
    rendered.rerender(
      createElement(
        MemoryRouter,
        null,
        createElement(NotificationCenter, { refreshKey: '/cards' }),
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'Notifications, 0 unread notifications' }),
    ).toBeVisible();
    resolveOlder({ ok: true, value: staleSnapshot });
    await Promise.resolve();
    expect(
      screen.getByRole('button', { name: 'Notifications, 0 unread notifications' }),
    ).toBeVisible();
  });

  it('turns the badge quiet and zero after marking all read while preserving canonical resolution', async () => {
    render(
      createElement(MemoryRouter, null, createElement(NotificationCenter, { refreshKey: '/' })),
    );
    const trigger = await screen.findByRole('button', {
      name: 'Notifications, 1 unread notification',
    });
    expect(trigger).toHaveTextContent('1');
    expect(trigger.querySelector('svg')).toBeNull();
    fireEvent.click(trigger);
    const closeTrigger = screen.getByRole('button', { name: 'Close notifications' });
    expect(closeTrigger).toBe(trigger);
    expect(
      screen.getByLabelText('Financial center').closest('.fui-FluentProvider'),
    ).toHaveAttribute('data-notification-theme', 'dark');
    expect(await screen.findByText('1 to review · 1 unread')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByText('1 to review · 0 unread')).toBeVisible();
    expect(closeTrigger).toHaveAttribute('data-unread-count', '0');
    fireEvent.click(closeTrigger);
    expect(trigger).toHaveAccessibleName('Notifications, 0 unread notifications');
    expect(trigger).toHaveTextContent('0');

    forecast = {
      ...staleSnapshot,
      cashAccounts: staleSnapshot.cashAccounts?.map((account) => ({
        ...account,
        sourceBalanceDate: '2026-07-01',
        sourceBalanceCents: account.balanceCents,
        postSourceChangeCents: 0,
      })),
    };
    window.dispatchEvent(new CustomEvent(FINANCIAL_STATE_CHANGED_EVENT));
    await waitFor(() =>
      expect(trigger).toHaveAccessibleName('Notifications, 0 unread notifications'),
    );
  });

  it('retains exact inline input and the condition when a canonical save fails', async () => {
    render(
      createElement(MemoryRouter, null, createElement(NotificationCenter, { refreshKey: '/' })),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Notifications, 1 unread/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm calculated balance' }));
    const amount = screen.getByRole('textbox', { name: 'Exact amount' });
    fireEvent.change(amount, { target: { value: '1049.99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save exact update' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is busy.');
    expect(amount).toHaveValue('1049.99');
    expect(
      screen.getByRole('button', { name: 'Close notifications', hidden: true }),
    ).toBeInTheDocument();
  });

  it('confirms an exact account snapshot once even when save is activated twice', async () => {
    vi.mocked(window.balanceBook.upsertRecord).mockImplementation(async () => {
      forecast = {
        ...staleSnapshot,
        cashAccounts: staleSnapshot.cashAccounts?.map((account) => ({
          ...account,
          sourceBalanceCents: account.balanceCents,
          sourceBalanceDate: '2026-07-01',
          postSourceChangeCents: 0,
        })),
      };
      return { ok: true, value: records };
    });
    render(
      createElement(MemoryRouter, null, createElement(NotificationCenter, { refreshKey: '/' })),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Notifications, 1 unread/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm calculated balance' }));
    const save = screen.getByRole('button', { name: 'Save exact update' });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(window.balanceBook.upsertRecord).toHaveBeenCalledOnce());
    expect(window.balanceBook.upsertRecord).toHaveBeenCalledWith({
      entityType: 'cash-account',
      payload: expect.objectContaining({
        id: 'checking',
        openingBalanceCents: 105_000,
        balanceAsOf: '2026-07-01',
      }),
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close notifications' })).toBeVisible(),
    );
  });

  it('switches one compact bubble between notices, upcoming bills, and current balances', async () => {
    forecast = {
      ...staleSnapshot,
      upcomingEvents: [
        {
          id: 'rent',
          label: 'Rent',
          accountName: 'Checking',
          date: '2026-07-15',
          amountCents: 80_000,
          direction: 'outflow',
          kind: 'expense',
          certainty: 'confirmed',
        },
        {
          id: 'paycheck',
          label: 'Paycheck',
          accountName: 'Checking',
          date: '2026-07-14',
          amountCents: 150_000,
          direction: 'inflow',
          kind: 'income',
          certainty: 'confirmed',
        },
      ],
    };
    render(
      createElement(MemoryRouter, null, createElement(NotificationCenter, { refreshKey: '/' })),
    );

    fireEvent.click(await screen.findByRole('button', { name: /Notifications, 1 unread/ }));
    const center = await screen.findByLabelText('Financial center');
    expect(center).toBeVisible();
    expect(screen.getByRole('tablist', { name: 'Financial center sections' })).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Bills', exact: true }));
    expect(await screen.findByRole('heading', { name: 'Upcoming bills' })).toBeVisible();
    expect(screen.getByText('Rent')).toBeVisible();
    expect(screen.getAllByText('$800.00')).toHaveLength(2);
    expect(screen.queryByText('Paycheck')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Balances', exact: true }));
    expect(await screen.findByRole('heading', { name: 'Current balances' })).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Open Checking cash account' }),
    ).toHaveTextContent('$1,050.00');
  });
});
