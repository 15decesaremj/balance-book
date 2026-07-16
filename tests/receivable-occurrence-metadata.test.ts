import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceBookStore, applyMigrations, latestSchemaVersion } from '@balance-book/database';
import {
  cashAccountSchema,
  forecastEventSchema,
  receivableSchema,
  type ForecastEvent,
} from '@balance-book/domain';
import {
  formatReceivableOccurrenceNote,
  materializeForecastEvents,
  mergeReceivableSettlementUserNotes,
  projectReceivableBalances,
  receivableSettlementUserNotes,
} from '@balance-book/financial-engine';
import {
  anchoredReceivableDateForEdit,
  defaultReceivableSettlementOccurrence,
} from '../apps/desktop/src/renderer/CorePages';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-occurrence-metadata-'));
  temporaryDirectories.push(directory);
  return directory;
};

const openStore = (): BalanceBookStore => {
  const directory = temporaryDirectory();
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'backups'),
  });
  stores.push(store);
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

const userId = 'synthetic-user';
const account = cashAccountSchema.parse({
  id: 'checking',
  userId,
  name: 'Checking',
  type: 'checking',
  openingBalanceCents: 100_000,
  balanceAsOf: '2026-03-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  hardFloorCents: 0,
  transferDelayDays: 0,
});
const editedReceivable = receivableSchema.parse({
  id: 'monthly-reimbursement',
  userId,
  source: 'Synthetic customer',
  description: 'Monthly reimbursement',
  originalAmountCents: 0,
  remainingAmountCents: 0,
  recurringAmountCents: 12_000,
  expectedDate: '2026-01-30',
  recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
  destinationAccountId: account.id,
  certainty: 'expected',
  includeInCashForecast: true,
  accrualAmountCents: 10_000,
  accrualDate: '2026-03-01',
  accrualRecurrenceRule: { frequency: 'once' },
});

const recordedReceipt = (amountCents: number): ForecastEvent =>
  forecastEventSchema.parse({
    id: `receipt-${amountCents}`,
    userId,
    accountId: account.id,
    date: '2026-03-29',
    kind: 'receivable-settlement',
    direction: 'inflow',
    amountCents,
    certainty: 'confirmed',
    status: 'confirmed',
    label: 'Recorded receipt',
    sourceRecordId: editedReceivable.id,
    paymentMethod: 'cash-account',
    receivableOccurrenceDate: '2026-03-30',
    receivableOccurrenceTargetCents: 10_000,
  });

describe('durable receivable occurrence metadata', () => {
  it('keeps internal linkage out of user notes while preserving legacy metadata on edit', () => {
    const legacy = `${formatReceivableOccurrenceNote('2026-03-30')}\nOriginal user note`;
    expect(receivableSettlementUserNotes(legacy)).toBe('Original user note');
    expect(mergeReceivableSettlementUserNotes(legacy, 'Corrected note')).toBe(
      `${formatReceivableOccurrenceNote('2026-03-30')}\nCorrected note`,
    );
    expect(() =>
      forecastEventSchema.parse({
        ...recordedReceipt(10_000),
        kind: 'income',
      }),
    ).toThrow(/occurrence metadata is only valid/i);
  });

  it('freezes a settled occurrence target when the future recurring amount increases', () => {
    const fullReceipt = recordedReceipt(10_000);
    const fullCash = materializeForecastEvents({
      accounts: [account],
      events: [fullReceipt],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [editedReceivable],
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    }).filter(
      (event) =>
        event.kind === 'receivable-settlement' &&
        event.status !== 'cancelled' &&
        event.status !== 'skipped',
    );
    expect(fullCash.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-03-29', 10_000],
    ]);

    const partialReceipt = recordedReceipt(4_000);
    const partialCash = materializeForecastEvents({
      accounts: [account],
      events: [partialReceipt],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [editedReceivable],
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    }).filter((event) => event.kind === 'receivable-settlement');
    expect(partialCash.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-03-29', 4_000],
      ['2026-03-30', 6_000],
    ]);

    const owed = projectReceivableBalances({
      receivables: [{ ...editedReceivable, expectedDate: '2026-03-30' }],
      settlementEvents: [partialReceipt],
      startDate: '2026-03-01',
      endDate: '2026-03-30',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    expect(owed.at(-1)).toMatchObject({ endingOutstandingCents: 0 });
  });

  it('keeps split receipts together when a schedule edit moves their shared occurrence', () => {
    const movedSchedule = receivableSchema.parse({
      ...editedReceivable,
      expectedDate: '2026-08-01',
      recurringAmountCents: 10_000,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
    });
    const splitReceipts = [
      forecastEventSchema.parse({
        ...recordedReceipt(4_000),
        id: 'split-receipt-one',
        date: '2026-08-14',
        receivableOccurrenceDate: '2026-08-15',
      }),
      forecastEventSchema.parse({
        ...recordedReceipt(6_000),
        id: 'split-receipt-two',
        date: '2026-08-20',
        receivableOccurrenceDate: '2026-08-15',
      }),
    ];

    const cash = materializeForecastEvents({
      accounts: [{ ...account, balanceAsOf: '2026-07-01' }],
      events: splitReceipts,
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [movedSchedule],
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    }).filter((event) => event.kind === 'receivable-settlement');
    expect(cash.map((event) => [event.id, event.date, event.amountCents])).toEqual([
      ['split-receipt-one', '2026-08-14', 4_000],
      ['split-receipt-two', '2026-08-20', 6_000],
    ]);
  });

  it('uses exact receivable IDs before interpreting a legacy @date suffix', () => {
    const prefixReceivable = receivableSchema.parse({
      ...editedReceivable,
      id: 'shared-id',
      recurringAmountCents: 10_000,
    });
    const exactReceivable = receivableSchema.parse({
      ...editedReceivable,
      id: 'shared-id@2026-03-30',
      recurringAmountCents: 20_000,
    });
    const exactReceipt = forecastEventSchema.parse({
      ...recordedReceipt(20_000),
      id: 'exact-id-receipt',
      sourceRecordId: exactReceivable.id,
      receivableOccurrenceTargetCents: 20_000,
    });

    const cash = materializeForecastEvents({
      accounts: [account],
      events: [exactReceipt],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [prefixReceivable, exactReceivable],
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    }).filter((event) => event.kind === 'receivable-settlement');
    expect(cash.map((event) => [event.sourceRecordId, event.date, event.amountCents])).toEqual([
      ['shared-id@2026-03-30', '2026-03-29', 20_000],
      ['shared-id', '2026-03-30', 10_000],
    ]);
  });

  it('does not let another profile receipt reduce this profile money-owed ledger', () => {
    const otherProfileReceipt = forecastEventSchema.parse({
      ...recordedReceipt(10_000),
      id: 'other-profile-receipt',
      userId: 'other-profile',
      date: '2026-03-15',
    });
    const owed = projectReceivableBalances({
      receivables: [{ ...editedReceivable, expectedDate: '2026-03-30' }],
      settlementEvents: [otherProfileReceipt],
      startDate: '2026-03-01',
      endDate: '2026-03-30',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    expect(owed.find((day) => day.date === '2026-03-15')).toMatchObject({
      settledCents: 0,
      endingOutstandingCents: 10_000,
    });
  });

  it('preserves the original anchor cycle on edits and defaults late cash to the nearest installment', () => {
    const anchor = forecastEventSchema.parse({
      id: 'rent',
      userId,
      accountId: account.id,
      date: '2026-02-01',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 100_000,
      certainty: 'confirmed',
      status: 'planned',
      label: 'Rent',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      paymentMethod: 'cash-account',
    });
    const anchored = receivableSchema.parse({
      ...editedReceivable,
      id: 'anchored-reimbursement',
      expectedDate: '2026-01-30',
      recurringAmountCents: 10_000,
      recurrenceRule: undefined,
      settlementAnchorEventId: anchor.id,
      settlementOffsetDays: -2,
    });
    expect(
      anchoredReceivableDateForEdit({
        existing: anchored,
        anchorEvent: anchor,
        settlementOffsetDays: -3,
        onOrAfter: '2026-07-15',
      }),
    ).toBe('2026-01-29');
    expect(
      defaultReceivableSettlementOccurrence({
        receivable: anchored,
        events: [anchor],
        settlementDate: '2026-07-31',
        fallbackOccurrences: [],
      }),
    ).toBe('2026-07-30');
  });

  it('snapshots the old amount before an edit and preserves historical account placement', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    const checkingId = 'profile-a-primary-cash';
    store.upsertManagedEntity('profile-a', 'cash-account', {
      id: 'profile-a-savings',
      name: 'Savings',
      type: 'savings',
      openingBalanceCents: 50_000,
      balanceAsOf: '2026-01-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'profile-a-recurring',
      source: 'Synthetic customer',
      description: 'Recurring receipt',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      destinationAccountId: checkingId,
      certainty: 'expected',
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'profile-a-recurring',
      amountCents: 4_000,
      date: '2026-03-29',
      asOfDate: '2026-03-29',
      occurrenceDate: '2026-03-30',
    });
    const beforeEdit = store.getManagedRecords('profile-a');
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...beforeEdit.receivables[0]!,
      userId: undefined,
      recurringAmountCents: 12_000,
      destinationAccountId: 'profile-a-savings',
    });

    const afterEdit = store.getManagedRecords('profile-a');
    const historical = afterEdit.events.find((event) => event.kind === 'receivable-settlement')!;
    expect(historical).toMatchObject({
      accountId: checkingId,
      receivableOccurrenceDate: '2026-03-30',
      receivableOccurrenceTargetCents: 10_000,
      notes: undefined,
    });
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...historical,
        userId: undefined,
        label: 'Corrected historical label',
      }),
    ).not.toThrow();
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...historical,
        userId: undefined,
        accountId: 'profile-a-savings',
        date: '2026-04-29',
        receivableOccurrenceDate: '2026-04-30',
      }),
    ).toThrow(/targeted receivable receipt cannot be reassigned/i);
    const withoutInternalTarget = {
      ...historical,
      receivableOccurrenceTargetCents: undefined,
    };
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...withoutInternalTarget,
        userId: undefined,
        accountId: 'profile-a-savings',
        date: '2026-04-29',
        receivableOccurrenceDate: '2026-04-30',
      }),
    ).toThrow(/targeted receivable receipt cannot be reassigned/i);
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'profile-a-recurring',
      amountCents: 6_000,
      date: '2026-03-30',
      asOfDate: '2026-03-30',
      occurrenceDate: '2026-03-30',
    });
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'profile-a-recurring',
        amountCents: 1,
        date: '2026-03-30',
        asOfDate: '2026-03-30',
        occurrenceDate: '2026-03-30',
      }),
    ).toThrow(/open occurrence amount/i);
  });

  it('does not replace a partially received opening balance with the recurring run rate', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'profile-a-opening-and-recurring',
      source: 'Synthetic customer',
      description: 'Opening balance plus monthly reimbursement',
      originalAmountCents: 50_000,
      remainingAmountCents: 50_000,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'profile-a-opening-and-recurring',
      amountCents: 20_000,
      date: '2026-01-29',
      asOfDate: '2026-01-29',
      occurrenceDate: '2026-01-30',
    });
    const beforeEdit = store.getManagedRecords('profile-a');
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...beforeEdit.receivables[0]!,
      userId: undefined,
      recurringAmountCents: 12_000,
    });

    const afterEdit = store.getManagedRecords('profile-a');
    const openingReceipt = afterEdit.events.find((event) => event.kind === 'receivable-settlement');
    expect(openingReceipt).toMatchObject({
      receivableOccurrenceDate: '2026-01-30',
      receivableOccurrenceTargetCents: undefined,
    });
    expect(afterEdit.receivables[0]).toMatchObject({ remainingAmountCents: 30_000 });

    const cash = materializeForecastEvents({
      accounts: afterEdit.accounts,
      events: afterEdit.events,
      cards: afterEdit.cards,
      cardCycles: afterEdit.cardCycles,
      loans: afterEdit.loans,
      receivables: afterEdit.receivables,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    }).filter((event) => event.kind === 'receivable-settlement');
    expect(cash.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-01-29', 20_000],
      ['2026-01-30', 30_000],
    ]);
  });

  it('freezes legacy receipt identity before timing edits and blocks destructive cadence changes', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'profile-a-legacy-timing',
      source: 'Synthetic customer',
      description: 'Legacy split receipt',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: true,
    });
    const receiptBase = {
      accountId: 'profile-a-primary-cash',
      kind: 'receivable-settlement' as const,
      direction: 'inflow' as const,
      certainty: 'confirmed' as const,
      status: 'confirmed' as const,
      label: 'Legacy split receipt',
      sourceRecordId: 'profile-a-legacy-timing',
      paymentMethod: 'cash-account' as const,
    };
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...receiptBase,
      id: 'profile-a-split-one',
      date: '2026-03-28',
      amountCents: 4_000,
    });
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...receiptBase,
      id: 'profile-a-split-two',
      date: '2026-03-29',
      amountCents: 6_000,
    });
    let records = store.getManagedRecords('profile-a');
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...records.receivables[0]!,
      userId: undefined,
      expectedDate: '2026-01-31',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 31, interval: 1 },
    });
    records = store.getManagedRecords('profile-a');
    expect(
      records.events
        .filter((event) => event.kind === 'receivable-settlement')
        .map((event) => event.receivableOccurrenceDate),
    ).toEqual(['2026-03-30', '2026-03-30']);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'receivable', {
        ...records.receivables[0]!,
        userId: undefined,
        expectedDate: '2026-01-30',
        recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
        recurrenceEndDate: '2026-03-30',
      }),
    ).not.toThrow();
    records = store.getManagedRecords('profile-a');
    expect(() =>
      store.upsertManagedEntity('profile-a', 'receivable', {
        ...records.receivables[0]!,
        userId: undefined,
        recurrenceRule: { frequency: 'monthly', dayOfMonth: 31, interval: 3 },
      }),
    ).toThrow(/cannot change recurrence cadence/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'receivable', {
        ...records.receivables[0]!,
        userId: undefined,
        recurrenceEndDate: '2026-02-28',
      }),
    ).toThrow(/cannot end before/i);
  });

  it('freezes the original-amount fallback when it is the recurring run rate', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'profile-a-fallback-run-rate',
      source: 'Synthetic customer',
      description: 'Fallback recurring receipt',
      originalAmountCents: 10_000,
      remainingAmountCents: 0,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: true,
    });
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      id: 'profile-a-fallback-receipt',
      accountId: 'profile-a-primary-cash',
      date: '2026-03-29',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 4_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Fallback receipt',
      sourceRecordId: 'profile-a-fallback-run-rate',
      paymentMethod: 'cash-account',
      receivableOccurrenceDate: '2026-03-30',
    });
    const records = store.getManagedRecords('profile-a');
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...records.receivables[0]!,
      userId: undefined,
      originalAmountCents: 12_000,
    });
    expect(store.getManagedRecords('profile-a').events[0]).toMatchObject({
      receivableOccurrenceDate: '2026-03-30',
      receivableOccurrenceTargetCents: 10_000,
    });
  });

  it('keeps occurrence targets internal instead of trusting edited financial records', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'profile-a-recurring',
      source: 'Synthetic customer',
      description: 'Recurring receipt',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: true,
    });
    const legacyReceipt = {
      id: 'profile-a-legacy-receipt',
      accountId: 'profile-a-primary-cash',
      date: '2026-03-29',
      kind: 'receivable-settlement' as const,
      direction: 'inflow' as const,
      amountCents: 4_000,
      certainty: 'confirmed' as const,
      status: 'confirmed' as const,
      label: 'Legacy receipt',
      sourceRecordId: 'profile-a-recurring',
      paymentMethod: 'cash-account' as const,
      receivableOccurrenceDate: '2026-03-30',
    };
    store.upsertManagedEntity('profile-a', 'forecast-event', legacyReceipt);

    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...legacyReceipt,
        receivableOccurrenceTargetCents: 100_000,
      }),
    ).toThrow(/target is managed internally/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...legacyReceipt,
        id: 'profile-a-forged-receipt',
        amountCents: 1_000,
        receivableOccurrenceTargetCents: 100_000,
      }),
    ).toThrow(/target is managed internally/i);
  });

  it('retains a frozen occurrence target through cancellation and replacement', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'profile-a-recurring',
      source: 'Synthetic customer',
      description: 'Recurring receipt',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'profile-a-recurring',
      amountCents: 4_000,
      date: '2026-03-29',
      asOfDate: '2026-03-29',
      occurrenceDate: '2026-03-30',
    });
    let records = store.getManagedRecords('profile-a');
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...records.receivables[0]!,
      userId: undefined,
      recurringAmountCents: 12_000,
    });
    records = store.getManagedRecords('profile-a');
    const originalReceipt = records.events.find((event) => event.kind === 'receivable-settlement')!;
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...originalReceipt,
      userId: undefined,
      status: 'cancelled',
    });
    expect(() =>
      store.deleteManagedEntity('profile-a', 'forecast-event', originalReceipt.id),
    ).toThrow(/cannot be deleted/i);
    records = store.getManagedRecords('profile-a');
    const reopenedCash = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    }).filter(
      (event) =>
        event.kind === 'receivable-settlement' &&
        event.status !== 'cancelled' &&
        event.status !== 'skipped',
    );
    expect(reopenedCash.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-03-30', 10_000],
    ]);

    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'profile-a-recurring',
      amountCents: 10_000,
      date: '2026-03-30',
      asOfDate: '2026-03-30',
      occurrenceDate: '2026-03-30',
    });
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...originalReceipt,
        userId: undefined,
        status: 'confirmed',
      }),
    ).toThrow(/open recurring occurrence amount/i);
  });

  it('backfills legacy occurrence notes during migration without requiring a full fixture schema', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'legacy.sqlite');
    const database = new BetterSqlite3(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE forecast_events (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        source_record_id TEXT,
        notes TEXT
      );
    `);
    const insertMigration = database.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)');
    database.transaction(() => {
      for (let version = 1; version <= 26; version += 1) {
        insertMigration.run(version, `legacy-${version}`, '2026-01-01T00:00:00.000Z');
      }
    })();
    database
      .prepare('INSERT INTO forecast_events VALUES (?, ?, ?, ?)')
      .run(
        'legacy-receipt',
        'receivable-settlement',
        'receivable-id',
        formatReceivableOccurrenceNote('2026-03-30'),
      );
    try {
      applyMigrations({ database, databasePath, backupDirectory: path.join(directory, 'backups') });
      expect(
        database
          .prepare(
            'SELECT receivable_occurrence_date AS occurrenceDate FROM forecast_events WHERE id = ?',
          )
          .get('legacy-receipt'),
      ).toEqual({ occurrenceDate: '2026-03-30' });
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({ version: latestSchemaVersion });
    } finally {
      database.close();
    }
  });
});
