// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProfilePreferences } from '@balance-book/domain';
import { SetupPage } from '../apps/desktop/src/renderer/App';
import type {
  BalanceBookApi,
  ManagedRecordsDto,
  SessionDto,
} from '../apps/desktop/src/shared/contracts';

const emptyRecords: ManagedRecordsDto = {
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

const session: SessionDto = {
  profile: {
    id: 'new-profile',
    displayName: 'New profile',
    username: 'new-profile',
    passwordSet: true,
    onboardingComplete: false,
  },
  themePreference: 'dark',
  preferences: defaultProfilePreferences,
};

beforeEach(() => {
  Object.defineProperty(window, 'balanceBook', {
    configurable: true,
    value: {
      listRecords: vi.fn().mockResolvedValue({ ok: true, value: emptyRecords }),
      getOnboardingDraft: vi.fn().mockResolvedValue({ ok: true, value: null }),
      getImportReview: vi.fn().mockResolvedValue({
        ok: true,
        value: { batches: [], fields: [] },
      }),
      saveOnboardingDraft: vi.fn().mockResolvedValue({ ok: true, value: { success: true } }),
      saveVerticalSlice: vi.fn().mockResolvedValue({
        ok: true,
        value: { setupComplete: true },
      }),
      setPreferences: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          ...session,
          profile: { ...session.profile, onboardingComplete: true },
          preferences: {
            ...defaultProfilePreferences,
            showIncomeTools: false,
            showBills: false,
            showCreditCards: false,
            showLoans: false,
            showMoneyOwed: false,
            showAssetsAndNetWorth: false,
          },
        },
      }),
    } as unknown as BalanceBookApi,
  });
});

afterEach(() => cleanup());

describe('first-run applicability questions', () => {
  it('skips non-applicable steps and saves presentation-only visibility choices', async () => {
    const onSession = vi.fn();
    render(createElement(MemoryRouter, null, createElement(SetupPage, { session, onSession })));

    await screen.findByRole('heading', { name: 'First forecast setup' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText('Confirm how Balance Book stores the information you enter'),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I consent to Balance Book storing the financial information I enter locally/,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Which parts fit your finances?' });

    for (const question of [
      'Do you want to track income, raises, or bonuses?',
      'Do you pay bills or subscriptions?',
      'Do you use credit cards?',
      'Do you have installment loans?',
      'Does anyone reimburse or repay you?',
      'Do you want to track investments or other assets?',
    ]) {
      fireEvent.click(within(screen.getByRole('group', { name: question })).getByText('No'));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'Cash account' });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Checking' } });
    fireEvent.change(screen.getByLabelText('Opening balance'), { target: { value: '500.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'Global minimum and buffer' });
    fireEvent.change(screen.getByLabelText('Global protected minimum'), {
      target: { value: '0.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Review first forecast' });
    fireEvent.click(screen.getByRole('button', { name: 'Save first forecast and continue' }));

    await waitFor(() => expect(window.balanceBook.saveVerticalSlice).toHaveBeenCalledTimes(1));
    expect(window.balanceBook.saveVerticalSlice).toHaveBeenCalledWith(
      expect.not.objectContaining({
        incomeLabel: expect.anything(),
        commitmentLabel: expect.anything(),
        cardName: expect.anything(),
      }),
    );
    expect(window.balanceBook.setPreferences).toHaveBeenCalledWith({
      ...defaultProfilePreferences,
      showIncomeTools: false,
      showBills: false,
      showCreditCards: false,
      showLoans: false,
      showMoneyOwed: false,
      showAssetsAndNetWorth: false,
    });
    expect(onSession).toHaveBeenCalledTimes(1);
  });
});
