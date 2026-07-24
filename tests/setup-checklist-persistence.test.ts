// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupPage, updateSetupReviewSections } from '../apps/desktop/src/renderer/App';
import type { BalanceBookApi, ManagedRecordsDto } from '../apps/desktop/src/shared/contracts';

const records: ManagedRecordsDto = {
  accounts: [
    {
      id: 'checking-a',
      userId: 'profile-a',
      name: 'Checking A',
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

const topicCard = (name: string): HTMLElement => {
  return screen.getByLabelText(`${name} setup topic`);
};

beforeEach(() => {
  Object.defineProperty(window, 'balanceBook', {
    configurable: true,
    value: {
      listRecords: vi.fn().mockResolvedValue({ ok: true, value: records }),
      getOnboardingDraft: vi.fn().mockResolvedValue({ ok: true, value: null }),
      getImportReview: vi.fn().mockResolvedValue({
        ok: true,
        value: { batches: [], fields: [] },
      }),
      saveOnboardingDraft: vi.fn().mockResolvedValue({ ok: true, value: { success: true } }),
    } as unknown as BalanceBookApi,
  });
});

afterEach(() => cleanup());

describe('established-profile setup checklist persistence', () => {
  it('updates and reopens decisions immutably', () => {
    const original = { cards: 'reviewed' as const };
    const added = updateSetupReviewSections(original, 'rewards', 'not-applicable');
    const reopened = updateSetupReviewSections(added, 'cards');

    expect(original).toEqual({ cards: 'reviewed' });
    expect(added).toEqual({ cards: 'reviewed', rewards: 'not-applicable' });
    expect(reopened).toEqual({ rewards: 'not-applicable' });
  });

  it('saves each decision immediately and keeps the newest queued write alive after navigation', async () => {
    let finishFirstSave: ((value: { ok: true; value: { success: true } }) => void) | undefined;
    const firstSave = new Promise<{ ok: true; value: { success: true } }>((resolve) => {
      finishFirstSave = resolve;
    });
    const save = vi.mocked(window.balanceBook.saveOnboardingDraft);
    save.mockImplementationOnce(() => firstSave);

    const view = render(createElement(MemoryRouter, null, createElement(SetupPage, null)));
    await screen.findByRole('heading', { name: 'Guided setup checklist' });

    fireEvent.click(
      within(topicCard('Money owed to you')).getByRole('button', { name: 'Not applicable' }),
    );
    expect(within(topicCard('Money owed to you')).getByText('Not applicable')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Saving decision...');
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0].values).toMatchObject({
      'review_money-owed': 'not-applicable',
    });

    fireEvent.click(screen.getByText(/Level 3 — Advanced/));
    fireEvent.click(
      within(topicCard('Loans and payment schedules')).getByRole('button', {
        name: 'Not applicable',
      }),
    );
    expect(
      within(topicCard('Loans and payment schedules')).getByText('Not applicable'),
    ).toBeVisible();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      finishFirstSave?.({ ok: true, value: { success: true } });
      await firstSave;
    });

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[0].values).toMatchObject({
      'review_money-owed': 'not-applicable',
      review_loans: 'not-applicable',
    });
  });

  it('shows success and recoverable error feedback in the established checklist', async () => {
    const save = vi.mocked(window.balanceBook.saveOnboardingDraft);
    const view = render(createElement(MemoryRouter, null, createElement(SetupPage, null)));
    await screen.findByRole('heading', { name: 'Guided setup checklist' });

    fireEvent.click(
      within(topicCard('Money owed to you')).getByRole('button', { name: 'Not applicable' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Decision saved locally.');

    save.mockResolvedValueOnce({ ok: false, error: 'The local profile is temporarily busy.' });
    fireEvent.click(screen.getByText(/Level 3 — Advanced/));
    fireEvent.click(
      within(topicCard('Loans and payment schedules')).getByRole('button', {
        name: 'Not applicable',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Checklist decision not saved: The local profile is temporarily busy.',
    );

    save.mockResolvedValueOnce({ ok: true, value: { success: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry checklist save' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checklist decisions saved locally.',
    );
    expect(save.mock.calls.at(-1)?.[0].values).toMatchObject({
      'review_money-owed': 'not-applicable',
      review_loans: 'not-applicable',
    });

    view.unmount();
  });

  it('persists explicit review and reopen actions instead of waiting for autosave', async () => {
    vi.mocked(window.balanceBook.getImportReview).mockResolvedValue({
      ok: true,
      value: {
        batches: [
          {
            id: 'import-a',
            sourceFileName: 'source.xlsx',
            workbookChecksum: 'checksum-a',
            status: 'completed',
            createdAt: '2026-07-01T12:00:00.000Z',
          },
        ],
        fields: [],
      },
    });
    const save = vi.mocked(window.balanceBook.saveOnboardingDraft);
    render(createElement(MemoryRouter, null, createElement(SetupPage, null)));
    await screen.findByRole('heading', { name: 'Guided setup checklist' });

    const sourceTopic = topicCard('Sources, import mapping, and audit trail');
    const advancedDetails = sourceTopic.closest('details');
    if (!(advancedDetails instanceof HTMLDetailsElement)) {
      throw new Error('Could not find the advanced-review disclosure');
    }
    advancedDetails.open = true;

    fireEvent.click(within(sourceTopic).getByRole('button', { name: 'Mark reviewed' }));
    expect(within(sourceTopic).getByText('Reviewed')).toBeVisible();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0].values).toMatchObject({ review_sources: 'reviewed' });
    expect(await screen.findByRole('status')).toHaveTextContent('Decision saved locally.');

    fireEvent.click(within(sourceTopic).getByRole('button', { name: 'Reopen section' }));
    expect(within(sourceTopic).getByText('Review needed')).toBeVisible();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[0].values).not.toHaveProperty('review_sources');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Section reopened and saved locally.',
    );
  });
});
