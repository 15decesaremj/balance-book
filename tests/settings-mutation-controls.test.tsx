// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataPage } from '../apps/desktop/src/renderer/CorePages';
import type {
  BalanceBookApi,
  ManagedRecordsDto,
  SessionDto,
} from '../apps/desktop/src/shared/contracts';

const session: SessionDto = {
  profile: {
    id: 'profile-a',
    displayName: 'Profile A',
    username: 'profile-a',
    passwordSet: true,
    onboardingComplete: true,
  },
  themePreference: 'dark',
  preferences: {
    overviewForecastMode: 'expected',
    compactLayout: false,
    reduceMotion: false,
    showOverviewDailySummary: true,
    showOverviewUpcomingEvents: true,
    showOverviewWiderPicture: true,
  },
};

const baseRecords: ManagedRecordsDto = {
  accounts: [
    {
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
      preferredFloorCents: 5_000,
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
  policy: {
    hardConsolidatedFloorCents: 0,
    preferredConsolidatedFloorCents: 10_000,
    horizonDays: 365,
    includeConfirmedReceivablesConservatively: true,
  },
};

const renderPage = (onSession = vi.fn()) =>
  render(createElement(DataPage, { session, systemDark: false, onSession }));

describe('Settings mutation controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'balanceBook', {
      configurable: true,
      value: {
        appVersion: '1.1.9-test',
        listRecords: vi.fn().mockResolvedValue({ ok: true, value: baseRecords }),
        setTheme: vi.fn(),
        setPreferences: vi.fn().mockResolvedValue({ ok: true, value: session }),
        updateCashPolicy: vi.fn(),
        upsertRecord: vi.fn(),
        importJson: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ ok: true, value: session }),
      } as unknown as BalanceBookApi,
    });
  });

  afterEach(() => cleanup());

  it('follows route-driven category changes without remounting the settings page', async () => {
    const onSession = vi.fn();
    const view = render(
      createElement(DataPage, {
        session,
        systemDark: false,
        onSession,
        initialSection: 'appearance',
      }),
    );
    await screen.findByRole('heading', { name: 'Appearance and Overview' });

    view.rerender(
      createElement(DataPage, {
        session,
        systemDark: false,
        onSession,
        initialSection: 'data',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Privacy boundary' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Data and backup' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    view.rerender(
      createElement(DataPage, {
        session,
        systemDark: false,
        onSession,
        initialSection: 'accounts',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Account protection and transfer timing' }),
    ).toBeVisible();
  });

  it('closes the same-tick duplicate-submit window for appearance changes', async () => {
    let resolveTheme: ((value: { ok: true; value: SessionDto }) => void) | undefined;
    vi.mocked(window.balanceBook.setTheme).mockReturnValue(
      new Promise((resolve) => {
        resolveTheme = resolve;
      }),
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Appearance and Overview' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), {
      target: { value: 'light' },
    });

    const form = screen.getByRole('button', { name: 'Save experience' }).closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(window.balanceBook.setTheme).toHaveBeenCalledTimes(1);
    expect(window.balanceBook.setPreferences).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    await act(async () =>
      resolveTheme?.({ ok: true, value: { ...session, themePreference: 'light' } }),
    );
    await waitFor(() => expect(window.balanceBook.setPreferences).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Experience preferences saved.')).toBeVisible();
  });

  it('persists guardrail and account edits once, repopulates saved values, and preserves scope', async () => {
    const policyRecords: ManagedRecordsDto = {
      ...baseRecords,
      policy: {
        ...baseRecords.policy!,
        hardConsolidatedFloorCents: 25_000,
        preferredConsolidatedFloorCents: 30_000,
        horizonDays: 420,
      },
    };
    let resolvePolicy: ((value: { ok: true; value: ManagedRecordsDto }) => void) | undefined;
    vi.mocked(window.balanceBook.updateCashPolicy).mockReturnValue(
      new Promise((resolve) => {
        resolvePolicy = resolve;
      }),
    );

    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Forecast and safety' }));
    await screen.findByRole('heading', { name: 'Forecast safety settings' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Consolidated minimum override' }), {
      target: { value: '250.00' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Forecast horizon in days' }), {
      target: { value: '420' },
    });
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Consolidated preferred override (optional)' }),
      { target: { value: '300.00' } },
    );
    const policyForm = screen
      .getByRole('button', { name: 'Save forecast safety settings' })
      .closest('form');
    expect(policyForm).not.toBeNull();
    await act(async () => {
      policyForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      policyForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(window.balanceBook.updateCashPolicy).toHaveBeenCalledTimes(1);
    expect(window.balanceBook.updateCashPolicy).toHaveBeenCalledWith({
      hardConsolidatedFloorCents: 25_000,
      preferredConsolidatedFloorCents: 30_000,
      horizonDays: 420,
      includeConfirmedReceivablesConservatively: true,
    });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    await act(async () => resolvePolicy?.({ ok: true, value: policyRecords }));
    expect(await screen.findByText(/Forecast safety settings updated/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Consolidated minimum override' })).toHaveValue(
      '250.00',
    );
    expect(screen.getByRole('spinbutton', { name: 'Forecast horizon in days' })).toHaveValue(420);

    fireEvent.click(screen.getByRole('tab', { name: 'Accounts' }));
    await screen.findByRole('heading', { name: 'Account protection and transfer timing' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    const accountRecords: ManagedRecordsDto = {
      ...policyRecords,
      accounts: [
        {
          ...policyRecords.accounts[0],
          hardFloorCents: 7_500,
          preferredFloorCents: 12_500,
          transferDelayDays: 2,
          showOnOverview: false,
        },
      ],
    };
    let resolveAccount: ((value: { ok: true; value: ManagedRecordsDto }) => void) | undefined;
    vi.mocked(window.balanceBook.upsertRecord).mockReturnValue(
      new Promise((resolve) => {
        resolveAccount = resolve;
      }),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Account minimum' }), {
      target: { value: '75.00' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Preferred buffer' }), {
      target: { value: '125.00' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Transfer lead time (days)' }), {
      target: { value: '2' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Show this account in the Overview cash-account list' }),
    );
    const accountForm = screen.getByRole('button', { name: 'Save Checking A' }).closest('form');
    expect(accountForm).not.toBeNull();
    await act(async () => {
      accountForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      accountForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(window.balanceBook.upsertRecord).toHaveBeenCalledTimes(1);
    expect(window.balanceBook.upsertRecord).toHaveBeenCalledWith({
      entityType: 'cash-account',
      payload: expect.objectContaining({
        id: 'checking-a',
        openingBalanceCents: 100_000,
        hardFloorCents: 7_500,
        preferredFloorCents: 12_500,
        transferDelayDays: 2,
        includedInLiquidity: true,
        canFundOtherAccounts: true,
        showOnOverview: false,
      }),
    });
    expect(screen.getByRole('button', { name: 'Saving Checking A…' })).toBeDisabled();

    await act(async () => resolveAccount?.({ ok: true, value: accountRecords }));
    expect(await screen.findByText(/Checking A protection updated/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Account minimum' })).toHaveValue('75.00');
    expect(screen.getByRole('textbox', { name: 'Preferred buffer' })).toHaveValue('125.00');
    expect(screen.getByRole('spinbutton', { name: 'Transfer lead time (days)' })).toHaveValue(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Forecast and safety' }));
    expect(screen.getByRole('textbox', { name: 'Consolidated minimum override' })).toHaveValue(
      '250.00',
    );
  });

  it('surfaces rejected settings calls and releases the lock for a retry', async () => {
    vi.mocked(window.balanceBook.updateCashPolicy)
      .mockRejectedValueOnce(new Error('Synthetic policy failure'))
      .mockResolvedValueOnce({ ok: true, value: baseRecords });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Forecast and safety' }));
    await screen.findByRole('heading', { name: 'Forecast safety settings' });

    fireEvent.click(screen.getByRole('button', { name: 'Save forecast safety settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic policy failure');
    fireEvent.click(screen.getByRole('button', { name: 'Save forecast safety settings' }));
    await waitFor(() => expect(window.balanceBook.updateCashPolicy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Forecast safety settings updated/)).toBeVisible();
  });

  it('reloads settings and session state after a JSON import replaces records', async () => {
    const importedRecords: ManagedRecordsDto = {
      ...baseRecords,
      policy: {
        ...baseRecords.policy!,
        hardConsolidatedFloorCents: 12_345,
      },
    };
    vi.mocked(window.balanceBook.listRecords)
      .mockResolvedValueOnce({ ok: true, value: baseRecords })
      .mockResolvedValueOnce({ ok: true, value: importedRecords });
    vi.mocked(window.balanceBook.importJson).mockResolvedValue({
      ok: true,
      value: { canceled: false, itemCount: 42 },
    });
    const onSession = vi.fn();
    renderPage(onSession);
    await screen.findByRole('heading', { name: 'Appearance and Overview' });
    fireEvent.click(screen.getByRole('tab', { name: 'Data and backup' }));

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: "I understand this replaces the active profile's records",
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose JSON export to import' }));

    await waitFor(() => expect(window.balanceBook.listRecords).toHaveBeenCalledTimes(2));
    expect(window.balanceBook.getSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(session);
    expect(await screen.findByText(/42 item\(s\) imported/)).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Forecast and safety' }));
    expect(screen.getByRole('textbox', { name: 'Consolidated minimum override' })).toHaveValue(
      '123.45',
    );
  });
});
