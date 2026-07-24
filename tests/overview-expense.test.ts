import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceBookStore, type VerticalSliceInput } from '@balance-book/database';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-overview-expense-'));
  temporaryDirectories.push(directory);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'backups'),
  });
  stores.push(store);
  return store;
};

const setup: VerticalSliceInput = {
  balanceAsOf: '2026-07-01',
  accountName: 'Synthetic checking',
  openingBalanceCents: 100_000,
  cardName: 'Synthetic card',
  cardEstimateCents: 20_000,
  cardPaymentDayOfMonth: 15,
  cardStatementCloseDayOfMonth: 24,
  cardEstimatePolicy: 'actual-reset',
  cardPaymentPolicy: 'full-statement',
  hardFloorCents: 0,
};

const initializedStore = (): BalanceBookStore => {
  const store = openStore();
  store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
  store.saveVerticalSlice('profile-a', setup);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.raw.open) store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('Overview expense recording', () => {
  it('records a cash expense and its shared Money Owed balance as linked canonical records', () => {
    const store = initializedStore();
    const account = store.getManagedRecords('profile-a').accounts[0]!;

    const result = store.recordOverviewExpense({
      userId: 'profile-a',
      paymentSource: { kind: 'cash-account', accountId: account.id },
      amountCents: 10_001,
      date: '2026-07-02',
      label: 'Synthetic shared expense',
      notes: 'Synthetic test note',
      owedTreatment: 'shared',
      owedBy: 'Synthetic counterparty',
      asOfDate: '2026-07-02',
    });

    const records = store.getManagedRecords('profile-a');
    expect(records.events.find((event) => event.id === result.expenseEventId)).toMatchObject({
      accountId: account.id,
      date: '2026-07-02',
      direction: 'outflow',
      amountCents: 10_001,
      paymentMethod: 'cash-account',
      label: 'Synthetic shared expense',
    });
    expect(records.receivables.find((item) => item.id === result.receivableId)).toMatchObject({
      source: 'Synthetic counterparty',
      description: 'Synthetic shared expense',
      originalAmountCents: 5_001,
      remainingAmountCents: 5_001,
      expectedDate: '2026-07-02',
      settlementDateConfirmed: false,
      destinationAccountId: account.id,
      grossExpenseCents: 10_001,
      userEconomicShareCents: 5_000,
      relatedExpenseId: result.expenseEventId,
      paymentInstrument: `cash-account:${account.id}`,
      includeInCashForecast: false,
    });
  });

  it('adds a card expense to card activity without moving cash and creates a full reimbursement', () => {
    const store = initializedStore();
    const initial = store.getManagedRecords('profile-a');
    const card = initial.cards[0]!;

    const result = store.recordOverviewExpense({
      userId: 'profile-a',
      paymentSource: { kind: 'credit-card', cardId: card.id },
      amountCents: 25_000,
      date: '2026-07-02',
      label: 'Synthetic reimbursable purchase',
      owedTreatment: 'reimbursable',
      owedBy: 'Synthetic counterparty',
      asOfDate: '2026-07-02',
    });

    const records = store.getManagedRecords('profile-a');
    expect(records.events.find((event) => event.id === result.expenseEventId)).toMatchObject({
      accountId: card.fundingAccountId,
      direction: 'outflow',
      amountCents: 25_000,
      paymentMethod: 'credit-card',
      cardId: card.id,
      cardActivityTreatment: 'additional',
    });
    expect(records.receivables.find((item) => item.id === result.receivableId)).toMatchObject({
      originalAmountCents: 25_000,
      remainingAmountCents: 25_000,
      destinationAccountId: card.fundingAccountId,
      grossExpenseCents: 25_000,
      userEconomicShareCents: 0,
      paymentInstrument: `credit-card:${card.id}`,
    });
    expect(
      records.events.filter(
        (event) => event.id === result.expenseEventId && event.paymentMethod === 'cash-account',
      ),
    ).toHaveLength(0);
  });

  it('rolls the expense back if its linked Money Owed record cannot be saved', () => {
    const store = initializedStore();
    const account = store.getManagedRecords('profile-a').accounts[0]!;
    store.raw.exec(`
      CREATE TRIGGER synthetic_receivable_failure
      BEFORE INSERT ON receivables
      BEGIN
        SELECT RAISE(ABORT, 'synthetic receivable failure');
      END;
    `);

    expect(() =>
      store.recordOverviewExpense({
        userId: 'profile-a',
        paymentSource: { kind: 'cash-account', accountId: account.id },
        amountCents: 10_000,
        date: '2026-07-02',
        label: 'Must roll back',
        owedTreatment: 'reimbursable',
        owedBy: 'Synthetic counterparty',
        asOfDate: '2026-07-02',
      }),
    ).toThrow(/synthetic receivable failure/i);

    const records = store.getManagedRecords('profile-a');
    expect(records.events.some((event) => event.label === 'Must roll back')).toBe(false);
    expect(records.receivables.some((item) => item.description === 'Must roll back')).toBe(false);
  });
});
