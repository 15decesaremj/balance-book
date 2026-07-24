// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProfilePreferences } from '@balance-book/domain';
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
    ...defaultProfilePreferences,
    overviewForecastMode: 'expected',
    compactLayout: false,
    reduceMotion: false,
    showOverviewDailySummary: true,
    showOverviewUpcomingEvents: true,
    showOverviewWiderPicture: true,
  },
};

const records: ManagedRecordsDto = {
  accounts: [],
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

describe('Settings experience controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'balanceBook', {
      configurable: true,
      value: {
        appVersion: '1.1.9-test',
        listRecords: vi.fn().mockResolvedValue({ ok: true, value: records }),
        setTheme: vi.fn().mockResolvedValue({
          ok: true,
          value: { ...session, themePreference: 'light' },
        }),
        setPreferences: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            ...session,
            themePreference: 'light',
            preferences: {
              ...session.preferences,
              overviewForecastMode: 'conservative',
              compactLayout: true,
              sidebarCollapsed: true,
              showOverviewDailySummary: false,
            },
          },
        }),
      } as unknown as BalanceBookApi,
    });
  });

  afterEach(() => cleanup());

  it('saves appearance, default-view, and Overview visibility choices together', async () => {
    const onSession = vi.fn();
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(DataPage, {
          session,
          systemDark: false,
          onSession,
        }),
      ),
    );

    await screen.findByRole('heading', { name: 'Appearance and Overview' });
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
    expect(screen.getByText(/System \(Light now\)/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), {
      target: { value: 'light' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Default forecast view' }), {
      target: { value: 'conservative' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use compact spacing' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep desktop navigation collapsed' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show daily summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save experience' }));

    await waitFor(() =>
      expect(window.balanceBook.setTheme).toHaveBeenCalledWith({ theme: 'light' }),
    );
    expect(window.balanceBook.setPreferences).toHaveBeenCalledWith({
      ...session.preferences,
      overviewForecastMode: 'conservative',
      compactLayout: true,
      reduceMotion: false,
      sidebarCollapsed: true,
      showOverviewDailySummary: false,
      showOverviewUpcomingEvents: true,
      showOverviewWiderPicture: true,
    });
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({
        themePreference: 'light',
        preferences: expect.objectContaining({
          overviewForecastMode: 'conservative',
          compactLayout: true,
          sidebarCollapsed: true,
          showOverviewDailySummary: false,
        }),
      }),
    );
    expect(await screen.findByText('Experience preferences saved.')).toBeVisible();
  });

  it('re-enables a hidden onboarding section without changing unrelated preferences', async () => {
    const hiddenLoanSession: SessionDto = {
      ...session,
      preferences: { ...session.preferences, showLoans: false },
    };
    vi.mocked(window.balanceBook.setPreferences).mockResolvedValueOnce({
      ok: true,
      value: {
        ...hiddenLoanSession,
        preferences: { ...hiddenLoanSession.preferences, showLoans: true },
      },
    });
    const onSession = vi.fn();
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(DataPage, {
          session: hiddenLoanSession,
          systemDark: false,
          onSession,
          initialSection: 'features',
        }),
      ),
    );

    await screen.findByRole('heading', { name: 'Visible sections' });
    const loans = screen.getByRole('checkbox', { name: 'Loans and refinancing' });
    expect(loans).not.toBeChecked();
    fireEvent.click(loans);
    fireEvent.click(screen.getByRole('button', { name: 'Save visible sections' }));

    await waitFor(() =>
      expect(window.balanceBook.setPreferences).toHaveBeenCalledWith({
        ...hiddenLoanSession.preferences,
        showLoans: true,
      }),
    );
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ showLoans: true }),
      }),
    );
    expect(await screen.findByText(/Saved records and forecasts were not changed/i)).toBeVisible();
  });

  it('keeps card-interest forecasting off until the experimental profile switch is saved', async () => {
    const onSession = vi.fn();
    vi.mocked(window.balanceBook.setPreferences).mockResolvedValueOnce({
      ok: true,
      value: {
        ...session,
        preferences: {
          ...session.preferences,
          experimentalCardInterestForecastEnabled: true,
        },
      },
    });
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(DataPage, {
          session,
          systemDark: false,
          onSession,
          initialSection: 'forecast',
        }),
      ),
    );

    await screen.findByRole('heading', { name: 'Experimental card interest' });
    const interest = screen.getByRole('checkbox', {
      name: 'Include card interest in forecasts (experimental)',
    });
    expect(interest).not.toBeChecked();
    fireEvent.click(interest);
    fireEvent.click(screen.getByRole('button', { name: 'Save experimental setting' }));

    await waitFor(() =>
      expect(window.balanceBook.setPreferences).toHaveBeenCalledWith({
        ...session.preferences,
        experimentalCardInterestForecastEnabled: true,
      }),
    );
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({
          experimentalCardInterestForecastEnabled: true,
        }),
      }),
    );
  });
});
