import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceBookStore, type VerticalSliceInput } from '@balance-book/database';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  forecastEventSchema,
  receivableSchema,
  type CashAccount,
  type ForecastEvent,
  type Receivable,
} from '@balance-book/domain';
import {
  buildForecastBundle,
  firstAnchoredReceivableSettlementDate,
  formatReceivableOccurrenceNote,
  materializeForecastEvents,
  projectReceivableBalances,
} from '@balance-book/financial-engine';

const userId = 'synthetic-user';
const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-receipt-timing-'));
  temporaryDirectories.push(directory);
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

const account = (
  id: string,
  openingBalanceCents: number,
  balanceAsOf = '2026-07-28',
): CashAccount =>
  cashAccountSchema.parse({
    id,
    userId,
    name: id,
    type: 'checking',
    openingBalanceCents,
    balanceAsOf,
    includedInLiquidity: true,
    canFundOtherAccounts: true,
    hardFloorCents: 0,
    transferDelayDays: 0,
  });

const anchorBill = (overrides: Partial<ForecastEvent> = {}): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'anchor-bill',
    userId,
    accountId: 'primary-checking',
    date: '2026-08-01',
    kind: 'direct-commitment',
    direction: 'outflow',
    amountCents: 200_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Monthly obligation',
    hypothetical: false,
    accepted: false,
    recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
    paymentMethod: 'cash-account',
    ...overrides,
  });

const anchoredReceivable = (
  id: string,
  recurringAmountCents: number,
  overrides: Partial<Receivable> = {},
): Receivable =>
  receivableSchema.parse({
    id,
    userId,
    source: 'Synthetic counterparty',
    description: id,
    originalAmountCents: 0,
    remainingAmountCents: 0,
    recurringAmountCents,
    expectedDate: '2026-07-30',
    settlementAnchorEventId: 'anchor-bill',
    settlementOffsetDays: -2,
    destinationAccountId: 'reserve-savings',
    certainty: 'expected',
    includeInCashForecast: true,
    ...overrides,
  });

describe('cash owed receipt timing', () => {
  it('derives two calendar days before a day-one bill across varying month lengths', () => {
    const anchor = anchorBill({ date: '2026-01-01' });
    expect(
      firstAnchoredReceivableSettlementDate({
        anchorEvent: anchor,
        settlementOffsetDays: -2,
        onOrAfter: '2026-01-01',
      }),
    ).toBe('2026-01-30');

    const receivable = anchoredReceivable('primary-share', 75_000, {
      expectedDate: '2026-01-30',
    });
    const receipts = materializeForecastEvents({
      accounts: [
        account('primary-checking', 500_000, '2026-01-01'),
        account('reserve-savings', 100_000, '2026-01-01'),
      ],
      events: [anchor],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-01-01',
      endDate: '2026-04-30',
    }).filter((event) => event.kind === 'receivable-settlement');

    expect(receipts.map((event) => event.date)).toEqual([
      '2026-01-30',
      '2026-02-27',
      '2026-03-30',
      '2026-04-29',
    ]);
  });

  it('posts each owed receipt once, only on its date and only into its destination account', () => {
    const accounts = [account('primary-checking', 500_000), account('reserve-savings', 100_000)];
    const anchor = anchorBill();
    const receivables = [
      anchoredReceivable('primary-share', 75_000),
      anchoredReceivable('secondary-share', 27_500),
    ];
    const events = materializeForecastEvents({
      accounts,
      events: [anchor],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables,
      startDate: '2026-07-28',
      endDate: '2026-08-02',
    });
    const receipts = events.filter((event) => event.kind === 'receivable-settlement');
    expect(receipts).toHaveLength(2);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRecordId: 'primary-share',
          accountId: 'reserve-savings',
          date: '2026-07-30',
          amountCents: 75_000,
        }),
        expect.objectContaining({
          sourceRecordId: 'secondary-share',
          accountId: 'reserve-savings',
          date: '2026-07-30',
          amountCents: 27_500,
        }),
      ]),
    );

    const forecast = buildForecastBundle({
      accounts,
      events,
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        preferredConsolidatedFloorCents: 0,
        horizonDays: 30,
        includeConfirmedReceivablesConservatively: true,
      }),
      startDate: '2026-07-28',
      endDate: '2026-08-02',
    }).expected.days;
    const balances = (date: string) =>
      Object.fromEntries(
        forecast
          .find((day) => day.date === date)!
          .accounts.map((value) => [value.accountId, value.endingBalanceCents]),
      );

    expect(balances('2026-07-29')).toEqual({
      'primary-checking': 500_000,
      'reserve-savings': 100_000,
    });
    expect(balances('2026-07-30')).toEqual({
      'primary-checking': 500_000,
      'reserve-savings': 202_500,
    });
    expect(forecast.find((day) => day.date === '2026-07-30')?.consolidatedCashCents).toBe(702_500);
    expect(balances('2026-08-01')).toEqual({
      'primary-checking': 300_000,
      'reserve-savings': 202_500,
    });
  });

  it('replaces one anchored occurrence with an actual receipt without duplicating cash', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    const setup: VerticalSliceInput = {
      balanceAsOf: '2026-07-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    };
    store.saveVerticalSlice('profile-a', setup);
    const accountId = 'profile-a-primary-cash';
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...anchorBill(),
      userId: undefined,
      id: 'profile-a-anchor',
      accountId,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...anchoredReceivable('profile-a-reimbursement', 10_000),
      userId: undefined,
      expectedDate: '2026-07-30',
      settlementAnchorEventId: 'profile-a-anchor',
      destinationAccountId: accountId,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'profile-a-reimbursement',
      amountCents: 10_000,
      date: '2026-08-29',
      asOfDate: '2026-08-29',
      occurrenceDate: '2026-08-30',
    });

    const records = store.getManagedRecords('profile-a');
    expect(records.receivables[0]).toMatchObject({
      settlementAnchorEventId: 'profile-a-anchor',
      settlementOffsetDays: -2,
      expectedDate: '2026-07-30',
      destinationAccountId: accountId,
    });
    const receipts = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-08-01',
      endDate: '2026-09-02',
    }).filter(
      (event) =>
        event.kind === 'receivable-settlement' &&
        event.sourceRecordId === 'profile-a-reimbursement',
    );
    expect(receipts.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-08-29', 10_000],
    ]);

    const portable = store.exportPortableProfile('profile-a', '1.1.0-test');
    const restoredStore = openStore();
    restoredStore.initializeProfiles([
      { id: 'profile-restored', displayName: 'Restored', username: 'restored' },
    ]);
    restoredStore.replacePortableProfile('profile-restored', portable);
    expect(restoredStore.getManagedRecords('profile-restored').receivables[0]).toMatchObject({
      userId: 'profile-restored',
      settlementAnchorEventId: 'profile-a-anchor',
      settlementOffsetDays: -2,
      expectedDate: '2026-07-30',
      destinationAccountId: accountId,
    });
  });

  it('keeps a recorded receipt attached when a later edit moves the recurring day', () => {
    const receivable = receivableSchema.parse({
      id: 'edited-recurring-receipt',
      userId,
      source: 'Synthetic roommate',
      description: 'Edited recurring reimbursement',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-07-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      destinationAccountId: 'reserve-savings',
      certainty: 'expected',
      includeInCashForecast: true,
      accrualAmountCents: 10_000,
      accrualDate: '2026-07-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
    });
    const recordedReceipt = forecastEventSchema.parse({
      id: 'historical-receipt',
      userId,
      accountId: 'reserve-savings',
      date: '2026-08-27',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Recorded before the schedule edit',
      sourceRecordId: receivable.id,
      paymentMethod: 'cash-account',
      notes: formatReceivableOccurrenceNote('2026-08-28'),
    });

    const cashReceipts = materializeForecastEvents({
      accounts: [account('reserve-savings', 100_000, '2026-08-20')],
      events: [recordedReceipt],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-08-20',
      endDate: '2026-09-02',
    }).filter(
      (event) => event.kind === 'receivable-settlement' && event.sourceRecordId === receivable.id,
    );
    expect(cashReceipts.map((event) => [event.id, event.date, event.amountCents])).toEqual([
      ['historical-receipt', '2026-08-27', 10_000],
    ]);
    expect(recordedReceipt.notes).toBe(formatReceivableOccurrenceNote('2026-08-28'));

    const owed = projectReceivableBalances({
      receivables: [receivable],
      settlementEvents: [recordedReceipt],
      startDate: '2026-07-01',
      endDate: '2026-08-31',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    expect(owed.find((day) => day.date === '2026-08-26')).toMatchObject({
      endingOutstandingCents: 10_000,
    });
    expect(owed.find((day) => day.date === '2026-08-27')).toMatchObject({
      settledCents: 10_000,
      endingOutstandingCents: 0,
    });
    expect(owed.find((day) => day.date === '2026-08-30')).toMatchObject({
      settledCents: 0,
      endingOutstandingCents: 0,
    });
  });

  it('uses the same anchored dates for the money-owed roll-forward', () => {
    const anchor = anchorBill();
    const receivable = anchoredReceivable('owed-ledger', 10_000, {
      accrualAmountCents: 10_000,
      accrualDate: '2026-07-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
    });
    const days = projectReceivableBalances({
      receivables: [receivable],
      settlementEvents: [anchor],
      startDate: '2026-07-01',
      endDate: '2026-08-31',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });

    expect(days.find((day) => day.date === '2026-07-29')).toMatchObject({
      endingOutstandingCents: 10_000,
      settledCents: 0,
    });
    expect(days.find((day) => day.date === '2026-07-30')).toMatchObject({
      endingOutstandingCents: 0,
      settledCents: 10_000,
    });
    expect(days.find((day) => day.date === '2026-08-01')).toMatchObject({
      accruedCents: 10_000,
      endingOutstandingCents: 10_000,
    });
    expect(days.find((day) => day.date === '2026-08-30')).toMatchObject({
      settledCents: 10_000,
      endingOutstandingCents: 0,
    });
  });

  it('rejects duplicate timing, unavailable anchors, and destructive anchor edits or deletion', () => {
    expect(() =>
      receivableSchema.parse({
        ...anchoredReceivable('invalid-double-schedule', 10_000),
        recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
      }),
    ).toThrow(/either a repeating receipt schedule or bill-relative timing/i);

    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-07-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    const accountId = 'profile-a-primary-cash';
    const anchor = {
      ...anchorBill(),
      userId: undefined,
      id: 'protected-rent',
      accountId,
    };
    store.upsertManagedEntity('profile-a', 'forecast-event', anchor);
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...anchoredReceivable('protected-receivable', 10_000),
      userId: undefined,
      settlementAnchorEventId: 'protected-rent',
      destinationAccountId: accountId,
    });

    expect(() =>
      store.deleteManagedEntity('profile-a', 'forecast-event', 'protected-rent'),
    ).toThrow(/linked Money Owed/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...anchor,
        recurrenceRule: undefined,
      }),
    ).toThrow(/recurring bill outflow/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'receivable', {
        ...anchoredReceivable('missing-anchor', 10_000),
        userId: undefined,
        settlementAnchorEventId: 'does-not-exist',
        destinationAccountId: accountId,
      }),
    ).toThrow(/not available to this profile/i);
  });

  it('preserves receipt identity across safe anchor edits and blocks destructive anchor changes', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-07-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    const accountId = 'profile-a-primary-cash';
    const anchor = {
      ...anchorBill(),
      userId: undefined,
      id: 'editable-rent',
      accountId,
    };
    store.upsertManagedEntity('profile-a', 'forecast-event', anchor);
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...anchoredReceivable('editable-anchor-receivable', 10_000),
      userId: undefined,
      settlementAnchorEventId: 'editable-rent',
      destinationAccountId: accountId,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'editable-anchor-receivable',
      amountCents: 10_000,
      date: '2026-07-29',
      asOfDate: '2026-07-29',
      occurrenceDate: '2026-07-30',
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'editable-anchor-receivable',
      amountCents: 10_000,
      date: '2026-08-29',
      asOfDate: '2026-08-29',
      occurrenceDate: '2026-08-30',
    });

    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...anchor,
      date: '2026-08-02',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 2, interval: 1 },
    });
    const afterSafeEdit = store.getManagedRecords('profile-a');
    expect(
      afterSafeEdit.events
        .filter((event) => event.kind === 'receivable-settlement')
        .map((event) => event.receivableOccurrenceDate),
    ).toEqual(['2026-07-30', '2026-08-30']);

    const editedAnchor = afterSafeEdit.events.find((event) => event.id === 'editable-rent')!;
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...editedAnchor,
        userId: undefined,
        recurrenceEndDate: '2026-08-02',
      }),
    ).toThrow(/cannot end before/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...editedAnchor,
        userId: undefined,
        recurrenceRule: { frequency: 'monthly', dayOfMonth: 2, interval: 3 },
      }),
    ).toThrow(/cannot change recurrence cadence/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'receivable', {
        ...afterSafeEdit.receivables[0]!,
        userId: undefined,
        expectedDate: '2026-09-01',
        settlementOffsetDays: 30,
      }),
    ).toThrow(/cannot jump across a recorded anchor cycle/i);
  });

  it('rejects a duplicate actual after a recurring receipt day is edited', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    const accountId = 'profile-a-primary-cash';
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'edited-recurring-receipt',
      source: 'Synthetic customer',
      description: 'Edited recurring receipt',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-28',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      destinationAccountId: accountId,
      certainty: 'expected',
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'edited-recurring-receipt',
      amountCents: 10_000,
      date: '2026-03-27',
      asOfDate: '2026-03-27',
      occurrenceDate: '2026-03-28',
    });
    const beforeEdit = store.getManagedRecords('profile-a');
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...beforeEdit.receivables[0]!,
      userId: undefined,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
    });

    const recordedReceipt = beforeEdit.events.find(
      (event) => event.kind === 'receivable-settlement',
    )!;
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...recordedReceipt,
        userId: undefined,
        label: 'Corrected historical receipt label',
      }),
    ).not.toThrow();
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'edited-recurring-receipt',
        amountCents: 10_000,
        date: '2026-03-30',
        asOfDate: '2026-03-30',
        occurrenceDate: '2026-03-30',
      }),
    ).toThrow(/open occurrence amount/i);

    const records = store.getManagedRecords('profile-a');
    const receipts = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    }).filter((event) => event.kind === 'receivable-settlement');
    expect(receipts.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-03-27', 10_000],
    ]);
  });

  it('preserves only the true partial residual after a recurring receipt day is edited', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    const accountId = 'profile-a-primary-cash';
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'edited-partial-receipt',
      source: 'Synthetic customer',
      description: 'Edited partial receipt',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-28',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      destinationAccountId: accountId,
      certainty: 'expected',
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'edited-partial-receipt',
      amountCents: 4_000,
      date: '2026-03-27',
      asOfDate: '2026-03-27',
      occurrenceDate: '2026-03-28',
    });
    const beforeEdit = store.getManagedRecords('profile-a');
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...beforeEdit.receivables[0]!,
      userId: undefined,
      expectedDate: '2026-01-30',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 30, interval: 1 },
    });

    const afterEdit = store.getManagedRecords('profile-a');
    expect(
      materializeForecastEvents({
        accounts: afterEdit.accounts,
        events: afterEdit.events,
        cards: afterEdit.cards,
        cardCycles: afterEdit.cardCycles,
        loans: afterEdit.loans,
        receivables: afterEdit.receivables,
        startDate: '2026-03-01',
        endDate: '2026-03-31',
      })
        .filter((event) => event.kind === 'receivable-settlement')
        .map((event) => [event.date, event.amountCents]),
    ).toEqual([
      ['2026-03-27', 4_000],
      ['2026-03-30', 6_000],
    ]);

    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'edited-partial-receipt',
      amountCents: 6_000,
      date: '2026-03-30',
      asOfDate: '2026-03-30',
      occurrenceDate: '2026-03-30',
    });
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'edited-partial-receipt',
        amountCents: 1,
        date: '2026-03-30',
        asOfDate: '2026-03-30',
        occurrenceDate: '2026-03-30',
      }),
    ).toThrow(/open occurrence amount/i);
  });
});
