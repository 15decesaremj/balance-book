import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceBookStore, type VerticalSliceInput } from '@balance-book/database';
import {
  materializeForecastEvents,
  projectReceivableBalances,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';

const directories: string[] = [];
const stores: BalanceBookStore[] = [];

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

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-bills-'));
  directories.push(directory);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'backups'),
  });
  stores.push(store);
  store.initializeProfiles([
    { id: 'synthetic-profile', displayName: 'Synthetic Profile', username: 'synthetic' },
  ]);
  store.saveVerticalSlice('synthetic-profile', setup);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.raw.open) store.close();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('bill and subscription plans', () => {
  it('saves an editable cash bill on the canonical recurring cash schedule', () => {
    const store = openStore();
    const account = store.getManagedRecords('synthetic-profile').accounts[0]!;

    store.upsertBillPlan({
      userId: 'synthetic-profile',
      eventId: 'synthetic-electric',
      paymentSource: { kind: 'cash-account', accountId: account.id },
      amountCents: 12_345,
      firstBillDate: '2026-08-05',
      label: 'Synthetic electric',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 5, interval: 1 },
      certainty: 'expected',
      active: true,
      owedTreatment: 'none',
      asOfDate: '2026-07-23',
    });

    const records = store.getManagedRecords('synthetic-profile');
    expect(records.events.find((event) => event.id === 'synthetic-electric')).toMatchObject({
      accountId: account.id,
      date: '2026-08-05',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 12_345,
      certainty: 'expected',
      status: 'planned',
      paymentMethod: 'cash-account',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 5, interval: 1 },
    });
    expect(
      materializeForecastEvents({
        accounts: records.accounts,
        events: records.events,
        cards: records.cards,
        cardCycles: records.cardCycles,
        loans: records.loans,
        receivables: records.receivables,
        startDate: '2026-08-01',
        endDate: '2026-10-31',
      })
        .filter((event) => event.sourceRecordId === 'synthetic-electric')
        .map((event) => event.date),
    ).toEqual(['2026-08-05', '2026-09-05', '2026-10-05']);
  });

  it('defaults a card bill to already included, then adds shared Money Owed on each bill date', () => {
    const store = openStore();
    const initial = store.getManagedRecords('synthetic-profile');
    const card = initial.cards[0]!;

    const saved = store.upsertBillPlan({
      userId: 'synthetic-profile',
      eventId: 'synthetic-subscription',
      paymentSource: { kind: 'credit-card', cardId: card.id, addToCardBalance: false },
      amountCents: 10_001,
      firstBillDate: '2026-08-10',
      label: 'Synthetic subscription',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 10, interval: 1 },
      certainty: 'confirmed',
      active: true,
      owedTreatment: 'shared',
      owedBy: 'Synthetic counterparty',
      asOfDate: '2026-07-23',
    });

    const records = store.getManagedRecords('synthetic-profile');
    const bill = records.events.find((event) => event.id === saved.eventId)!;
    const receivable = records.receivables.find((item) => item.id === saved.receivableId)!;
    expect(bill).toMatchObject({
      paymentMethod: 'credit-card',
      cardId: card.id,
      cardActivityTreatment: 'included-in-cycle-total',
    });
    expect(receivable).toMatchObject({
      source: 'Synthetic counterparty',
      relatedExpenseId: bill.id,
      originalAmountCents: 0,
      remainingAmountCents: 0,
      accrualAmountCents: 5_001,
      accrualDate: '2026-08-10',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 10, interval: 1 },
      grossExpenseCents: 10_001,
      userEconomicShareCents: 5_000,
      includeInCashForecast: false,
    });

    const debtWithIncludedBill = summarizeRevolvingDebt({
      card,
      cycles: records.cardCycles,
      events: records.events,
      asOfDate: '2026-08-10',
      paymentEvidenceMode: 'include-projected-payments',
    });
    const debtWithoutBill = summarizeRevolvingDebt({
      card,
      cycles: records.cardCycles,
      events: records.events.filter((event) => event.id !== bill.id),
      asOfDate: '2026-08-10',
      paymentEvidenceMode: 'include-projected-payments',
    });
    expect(debtWithIncludedBill.currentBalanceCents).toBe(debtWithoutBill.currentBalanceCents);

    const owed = projectReceivableBalances({
      receivables: records.receivables,
      settlementEvents: records.events,
      startDate: '2026-08-01',
      endDate: '2026-09-30',
      currentBalancesAsOfDate: '2026-07-23',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    expect(owed.find((day) => day.date === '2026-08-10')?.endingOutstandingCents).toBe(5_001);
    expect(owed.find((day) => day.date === '2026-09-10')?.endingOutstandingCents).toBe(10_002);
  });

  it('updates card treatment and stops future owed accruals atomically', () => {
    const store = openStore();
    const initial = store.getManagedRecords('synthetic-profile');
    const card = initial.cards[0]!;
    const saved = store.upsertBillPlan({
      userId: 'synthetic-profile',
      eventId: 'synthetic-service',
      paymentSource: { kind: 'credit-card', cardId: card.id, addToCardBalance: false },
      amountCents: 8_000,
      firstBillDate: '2026-08-01',
      label: 'Synthetic service',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      certainty: 'confirmed',
      active: true,
      owedTreatment: 'reimbursable',
      owedBy: 'Synthetic counterparty',
      asOfDate: '2026-07-23',
    });

    store.upsertBillPlan({
      userId: 'synthetic-profile',
      eventId: saved.eventId,
      linkedReceivableId: saved.receivableId,
      paymentSource: { kind: 'credit-card', cardId: card.id, addToCardBalance: true },
      amountCents: 9_000,
      firstBillDate: '2026-09-01',
      label: 'Synthetic service updated',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      certainty: 'confirmed',
      active: false,
      owedTreatment: 'none',
      asOfDate: '2026-07-23',
    });

    const records = store.getManagedRecords('synthetic-profile');
    expect(records.events.find((event) => event.id === saved.eventId)).toMatchObject({
      amountCents: 9_000,
      status: 'cancelled',
      cardActivityTreatment: 'additional',
    });
    expect(records.receivables.find((item) => item.id === saved.receivableId)).toMatchObject({
      relatedExpenseId: saved.eventId,
      accrualAmountCents: undefined,
      accrualDate: undefined,
      accrualRecurrenceRule: undefined,
    });
  });

  it('rolls back the bill when its linked Money Owed schedule cannot be saved', () => {
    const store = openStore();
    const account = store.getManagedRecords('synthetic-profile').accounts[0]!;
    store.raw.exec(`
      CREATE TRIGGER synthetic_bill_receivable_failure
      BEFORE INSERT ON receivables
      BEGIN
        SELECT RAISE(ABORT, 'synthetic bill receivable failure');
      END;
    `);

    expect(() =>
      store.upsertBillPlan({
        userId: 'synthetic-profile',
        eventId: 'must-not-persist',
        paymentSource: { kind: 'cash-account', accountId: account.id },
        amountCents: 5_000,
        firstBillDate: '2026-08-01',
        label: 'Must not persist',
        recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
        certainty: 'confirmed',
        active: true,
        owedTreatment: 'shared',
        owedBy: 'Synthetic counterparty',
        asOfDate: '2026-07-23',
      }),
    ).toThrow(/synthetic bill receivable failure/i);

    const records = store.getManagedRecords('synthetic-profile');
    expect(records.events.some((event) => event.id === 'must-not-persist')).toBe(false);
    expect(records.receivables.some((item) => item.relatedExpenseId === 'must-not-persist')).toBe(
      false,
    );
  });
});
