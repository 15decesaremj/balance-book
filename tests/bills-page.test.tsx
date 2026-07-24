// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillsPage } from '../apps/desktop/src/renderer/CorePages';
import type { BalanceBookApi, ManagedRecordsDto } from '../apps/desktop/src/shared/contracts';

const records: ManagedRecordsDto = {
  accounts: [
    {
      id: 'checking',
      userId: 'synthetic-profile',
      name: 'Synthetic checking',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-07-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      showOnOverview: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    },
  ],
  events: [
    {
      id: 'utility',
      userId: 'synthetic-profile',
      accountId: 'checking',
      date: '2026-08-05',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 12_000,
      certainty: 'expected',
      status: 'planned',
      label: 'Synthetic utility',
      hypothetical: false,
      accepted: false,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 5, interval: 1 },
      paymentMethod: 'cash-account',
    },
  ],
  policy: {
    userId: 'synthetic-profile',
    hardConsolidatedFloorCents: 0,
    horizonDays: 365,
    includeConfirmedReceivablesConservatively: true,
  },
  cards: [
    {
      id: 'card',
      userId: 'synthetic-profile',
      name: 'Synthetic card',
      fundingAccountId: 'checking',
      accountKind: 'credit-card',
      status: 'active',
      defaultFutureStatementCents: 20_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
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

beforeEach(() => {
  Object.defineProperty(window, 'balanceBook', {
    configurable: true,
    value: {
      listRecords: vi.fn().mockResolvedValue({ ok: true, value: records }),
      upsertBillPlan: vi.fn().mockResolvedValue({ ok: true, value: records }),
    } as unknown as BalanceBookApi,
  });
});

afterEach(() => cleanup());

describe('Bills and subscriptions page', () => {
  it('loads existing recurring costs and opens a clear, editable bill form', async () => {
    render(createElement(BillsPage));

    expect(await screen.findByRole('heading', { name: 'Bills & subscriptions' })).toBeVisible();
    expect(screen.getByText('Synthetic utility')).toBeVisible();
    expect(screen.getByText('$120.00')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit bill' }));
    expect(screen.getByRole('form', { name: 'Edit Synthetic utility' })).toBeVisible();
    expect(screen.getByLabelText('Bill or subscription name')).toHaveValue('Synthetic utility');
    expect(screen.getByLabelText('First or next billing date')).toHaveValue('2026-08-05');
  });

  it('defaults a new card bill to no extra card activity and saves shared Money Owed', async () => {
    render(createElement(BillsPage));
    await screen.findByRole('heading', { name: 'Bills & subscriptions' });
    fireEvent.click(screen.getByRole('button', { name: 'Add bill' }));

    fireEvent.change(screen.getByLabelText('Bill or subscription name'), {
      target: { value: 'Synthetic subscription' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '19.99' } });
    fireEvent.change(screen.getByLabelText('First or next billing date'), {
      target: { value: '2026-08-10' },
    });
    fireEvent.change(screen.getByLabelText('Paid from'), { target: { value: 'card:card' } });
    const addToCard = screen.getByRole('checkbox', {
      name: 'Add this charge to the card balance',
    });
    expect(addToCard).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Split 50/50' }));
    fireEvent.change(screen.getByLabelText('Who owes you?'), {
      target: { value: 'Synthetic counterparty' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save bill' }));

    await waitFor(() => expect(window.balanceBook.upsertBillPlan).toHaveBeenCalledOnce());
    expect(window.balanceBook.upsertBillPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentSource: {
          kind: 'credit-card',
          cardId: 'card',
          addToCardBalance: false,
        },
        amountCents: 1_999,
        firstBillDate: '2026-08-10',
        label: 'Synthetic subscription',
        recurrenceRule: { frequency: 'monthly', dayOfMonth: 10, interval: 1 },
        owedTreatment: 'shared',
        owedBy: 'Synthetic counterparty',
      }),
    );
  });
});
