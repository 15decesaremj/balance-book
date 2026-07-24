import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceBookStore } from '@balance-book/database';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  forecastEventSchema,
  receivableSchema,
} from '@balance-book/domain';
import {
  buildForecastBundle,
  materializeForecastEvents,
  projectRollingReceivableBalances,
} from '@balance-book/financial-engine';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-receivable-release-'));
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

describe('explicit receivable release accounting', () => {
  it('can accrue and automatically release one known future receipt without making it owed today', () => {
    const account = cashAccountSchema.parse({
      id: 'checking-a',
      userId: 'profile-a',
      name: 'Checking A',
      type: 'checking',
      openingBalanceCents: 50_000,
      balanceAsOf: '2026-07-18',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    });
    const receivable = receivableSchema.parse({
      id: 'known-one-time-receipt',
      userId: 'profile-a',
      source: 'Synthetic partner',
      description: 'Known next contribution',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-07-30',
      settlementDateConfirmed: true,
      destinationAccountId: 'checking-a',
      certainty: 'confirmed',
      includeInCashForecast: true,
      accrualAmountCents: 100_000,
      accrualDate: '2026-07-30',
    });

    const owed = projectRollingReceivableBalances({
      receivables: [receivable],
      settlementEvents: [],
      replayStartDate: '2026-07-18',
      startDate: '2026-07-18',
      endDate: '2026-08-01',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => owed.find((day) => day.date === date)!;

    expect(on('2026-07-18').endingOutstandingCents).toBe(0);
    expect(on('2026-07-30')).toMatchObject({
      accruedCents: 100_000,
      settledCents: 100_000,
      endingOutstandingCents: 0,
    });
    const events = materializeForecastEvents({
      accounts: [account],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-07-18',
      endDate: '2026-08-01',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        accountId: account.id,
        date: '2026-07-30',
        kind: 'receivable-settlement',
        amountCents: 100_000,
      }),
    );
  });

  it('nets an actual partial receipt against one planned one-time accrual receipt', () => {
    const account = cashAccountSchema.parse({
      id: 'checking-a',
      userId: 'profile-a',
      name: 'Checking A',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-07-31',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    });
    const receivable = receivableSchema.parse({
      id: 'planned-one-time-receipt',
      userId: 'profile-a',
      source: 'Synthetic partner',
      description: 'One planned contribution',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-08-05',
      settlementDateConfirmed: true,
      destinationAccountId: account.id,
      certainty: 'expected',
      includeInCashForecast: true,
      accrualAmountCents: 10_000,
      accrualDate: '2026-08-01',
    });
    const actualReceipt = forecastEventSchema.parse({
      id: 'actual-partial-one-time-receipt',
      userId: 'profile-a',
      accountId: account.id,
      date: '2026-08-03',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 4_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Partial receipt',
      sourceRecordId: receivable.id,
      paymentMethod: 'cash-account',
    });

    const events = materializeForecastEvents({
      accounts: [account],
      events: [actualReceipt],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-07-31',
      endDate: '2026-08-06',
    });
    expect(
      events
        .filter(
          (event) =>
            event.kind === 'receivable-settlement' && event.sourceRecordId === receivable.id,
        )
        .map((event) => [event.date, event.amountCents]),
    ).toEqual([
      ['2026-08-03', 4_000],
      ['2026-08-05', 6_000],
    ]);

    const cash = buildForecastBundle({
      accounts: [account],
      events,
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        horizonDays: 7,
        includeConfirmedReceivablesConservatively: true,
      }),
      startDate: '2026-07-31',
      endDate: '2026-08-06',
    }).expected.days;
    expect(cash.at(-1)?.consolidatedCashCents).toBe(110_000);

    const owed = projectRollingReceivableBalances({
      receivables: [receivable],
      settlementEvents: [actualReceipt],
      replayStartDate: '2026-07-31',
      startDate: '2026-07-31',
      endDate: '2026-08-06',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    expect(owed.find((day) => day.date === '2026-08-01')).toMatchObject({
      accruedCents: 10_000,
      endingOutstandingCents: 10_000,
    });
    expect(owed.find((day) => day.date === '2026-08-03')).toMatchObject({
      settledCents: 4_000,
      endingOutstandingCents: 6_000,
    });
    expect(owed.find((day) => day.date === '2026-08-05')).toMatchObject({
      settledCents: 6_000,
      endingOutstandingCents: 0,
    });
  });

  it('releases a one-time future accrual without rewriting its persisted opening balance', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-07-31',
      accountName: 'Primary checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'one-time-release-only',
      source: 'Synthetic partner',
      description: 'One future contribution',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-08-01',
      accrualDate: '2026-08-01',
      accrualAmountCents: 10_000,
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: false,
    });

    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'one-time-release-only',
        amountCents: 1_000,
        date: '2026-07-31',
        asOfDate: '2026-07-31',
        destinationAccountId: 'profile-a-primary-cash',
      }),
    ).toThrow(/not owed until its accrual date/i);

    const eventId = store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'one-time-release-only',
      amountCents: 4_000,
      date: '2026-08-01',
      asOfDate: '2026-08-01',
      destinationAccountId: 'profile-a-primary-cash',
    });
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'one-time-release-only',
        amountCents: 7_000,
        date: '2026-08-02',
        asOfDate: '2026-08-02',
        destinationAccountId: 'profile-a-primary-cash',
      }),
    ).toThrow(/no more than the open occurrence amount/i);
    const state = () => {
      const records = store.getManagedRecords('profile-a');
      const owed = projectRollingReceivableBalances({
        receivables: records.receivables,
        settlementEvents: records.events,
        replayStartDate: '2026-07-31',
        startDate: '2026-07-31',
        endDate: '2026-08-02',
        mode: 'expected',
        includeConfirmedReceivablesConservatively: true,
      });
      const cash = buildForecastBundle({
        accounts: records.accounts,
        events: materializeForecastEvents({
          accounts: records.accounts,
          events: records.events,
          cards: [],
          cardCycles: [],
          loans: [],
          receivables: records.receivables,
          startDate: '2026-07-31',
          endDate: '2026-08-02',
        }),
        policy: cashFloorPolicySchema.parse({
          hardConsolidatedFloorCents: 0,
          horizonDays: 3,
          includeConfirmedReceivablesConservatively: true,
        }),
        startDate: '2026-07-31',
        endDate: '2026-08-02',
      }).expected.days.at(-1)!.consolidatedCashCents;
      return { records, owed, cash };
    };

    let current = state();
    expect(current.records.receivables[0]?.remainingAmountCents).toBe(0);
    expect(current.owed.find((day) => day.date === '2026-08-01')).toMatchObject({
      accruedCents: 10_000,
      settledCents: 4_000,
      endingOutstandingCents: 6_000,
    });
    expect(current.cash).toBe(104_000);

    const release = current.records.events.find((event) => event.id === eventId)!;
    store.upsertManagedEntity('profile-a', 'forecast-event', { ...release, amountCents: 3_000 });
    current = state();
    expect(current.owed.at(-1)?.endingOutstandingCents).toBe(7_000);
    expect(current.cash).toBe(103_000);

    const editedRelease = current.records.events.find((event) => event.id === eventId)!;
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...editedRelease,
      status: 'cancelled',
    });
    current = state();
    expect(current.owed.at(-1)?.endingOutstandingCents).toBe(10_000);
    expect(current.cash).toBe(100_000);

    const cancelledRelease = current.records.events.find((event) => event.id === eventId)!;
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...cancelledRelease,
      status: 'confirmed',
    });
    current = state();
    expect(current.owed.at(-1)?.endingOutstandingCents).toBe(7_000);
    expect(current.cash).toBe(103_000);

    const reactivatedRelease = current.records.events.find((event) => event.id === eventId)!;
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...reactivatedRelease,
        date: '2026-07-31',
      }),
    ).toThrow(/not owed until its accrual date/i);

    store.deleteManagedEntity('profile-a', 'forecast-event', eventId);
    current = state();
    expect(current.records.events.some((event) => event.id === eventId)).toBe(false);
    expect(current.owed.at(-1)?.endingOutstandingCents).toBe(10_000);
    expect(current.cash).toBe(100_000);
  });

  it('uses an anchored recurring occurrence as the accrual date when no duplicate accrual schedule exists', () => {
    const account = cashAccountSchema.parse({
      id: 'checking-a',
      userId: 'profile-a',
      name: 'Checking A',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-08-29',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    });
    const anchor = forecastEventSchema.parse({
      id: 'monthly-bill',
      userId: 'profile-a',
      accountId: account.id,
      date: '2026-09-01',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 20_000,
      certainty: 'confirmed',
      status: 'planned',
      label: 'Monthly shared bill',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      paymentMethod: 'cash-account',
    });
    const receivable = receivableSchema.parse({
      id: 'anchored-release-only',
      userId: 'profile-a',
      source: 'Synthetic partner',
      description: 'Anchored shared amount',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-08-30',
      settlementAnchorEventId: anchor.id,
      settlementOffsetDays: -2,
      destinationAccountId: account.id,
      certainty: 'expected',
      includeInCashForecast: false,
    });
    const partialRelease = forecastEventSchema.parse({
      id: 'partial-release',
      userId: 'profile-a',
      accountId: account.id,
      date: '2026-08-31',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 4_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Partial release',
      sourceRecordId: receivable.id,
      receivableOccurrenceDate: '2026-08-30',
      receivableOccurrenceTargetCents: 10_000,
      paymentMethod: 'cash-account',
    });

    const owed = projectRollingReceivableBalances({
      receivables: [receivable],
      settlementEvents: [anchor, partialRelease],
      replayStartDate: '2026-08-29',
      startDate: '2026-08-29',
      endDate: '2026-09-30',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => owed.find((day) => day.date === date)!;

    expect(on('2026-08-29').endingOutstandingCents).toBe(0);
    expect(on('2026-08-30')).toMatchObject({
      accruedCents: 10_000,
      endingOutstandingCents: 10_000,
    });
    expect(on('2026-08-31')).toMatchObject({
      settledCents: 4_000,
      endingOutstandingCents: 6_000,
    });
    expect(on('2026-09-29')).toMatchObject({
      accruedCents: 10_000,
      endingOutstandingCents: 16_000,
    });

    const withoutRelease = materializeForecastEvents({
      accounts: [account],
      events: [anchor],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-08-29',
      endDate: '2026-09-30',
    });
    expect(withoutRelease.filter((event) => event.kind === 'receivable-settlement')).toEqual([]);

    const withRelease = materializeForecastEvents({
      accounts: [account],
      events: [anchor, partialRelease],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-08-29',
      endDate: '2026-09-30',
    });
    const cash = buildForecastBundle({
      accounts: [account],
      events: withRelease,
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        horizonDays: 40,
        includeConfirmedReceivablesConservatively: true,
      }),
      startDate: '2026-08-29',
      endDate: '2026-09-30',
    }).expected.days;
    expect(cash.find((day) => day.date === '2026-08-30')?.consolidatedCashCents).toBe(100_000);
    expect(cash.find((day) => day.date === '2026-08-31')?.consolidatedCashCents).toBe(104_000);
  });

  it('keeps future recurring accruals out of current owed and carries them forward without planned cash', () => {
    const receivable = receivableSchema.parse({
      id: 'monthly-release-only',
      userId: 'profile-a',
      source: 'Synthetic partner',
      description: 'Monthly shared expense',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-08-05',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 5, interval: 1 },
      accrualAmountCents: 10_000,
      accrualDate: '2026-08-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      destinationAccountId: 'checking-a',
      certainty: 'expected',
      includeInCashForecast: false,
    });

    const owed = projectRollingReceivableBalances({
      receivables: [receivable],
      settlementEvents: [],
      replayStartDate: '2026-07-31',
      startDate: '2026-07-31',
      endDate: '2026-09-06',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => owed.find((day) => day.date === date)!;

    expect(on('2026-07-31').endingOutstandingCents).toBe(0);
    expect(on('2026-08-01')).toMatchObject({
      accruedCents: 10_000,
      settledCents: 0,
      endingOutstandingCents: 10_000,
    });
    expect(on('2026-08-05').endingOutstandingCents).toBe(10_000);
    expect(on('2026-09-01')).toMatchObject({
      accruedCents: 10_000,
      endingOutstandingCents: 20_000,
    });
    expect(on('2026-09-05').endingOutstandingCents).toBe(20_000);
  });

  it('releases partial installments only on their dates, to their selected accounts, with audit lineage', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-07-31',
      accountName: 'Primary checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'cash-account', {
      id: 'profile-a-reserve',
      name: 'Reserve checking',
      type: 'checking',
      openingBalanceCents: 50_000,
      balanceAsOf: '2026-07-31',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'monthly-release-only',
      source: 'Synthetic partner',
      description: 'Monthly shared expense',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-08-05',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 5, interval: 1 },
      accrualAmountCents: 10_000,
      accrualDate: '2026-08-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: false,
    });

    store.initializeProfiles([{ id: 'profile-b', displayName: 'Profile B', username: 'profileb' }]);
    store.saveVerticalSlice('profile-b', {
      balanceAsOf: '2026-07-31',
      accountName: 'Other profile checking',
      openingBalanceCents: 1,
      hardFloorCents: 0,
    });
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'monthly-release-only',
        amountCents: 1_000,
        date: '2026-08-01',
        asOfDate: '2026-08-01',
        occurrenceDate: '2026-08-05',
        destinationAccountId: 'profile-b-primary-cash',
      }),
    ).toThrow(/not available to this profile/i);

    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'monthly-release-only',
      amountCents: 4_000,
      date: '2026-08-03',
      asOfDate: '2026-08-03',
      occurrenceDate: '2026-08-05',
      destinationAccountId: 'profile-a-primary-cash',
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'monthly-release-only',
      amountCents: 6_000,
      date: '2026-08-06',
      asOfDate: '2026-08-06',
      occurrenceDate: '2026-08-05',
      destinationAccountId: 'profile-a-reserve',
    });

    const records = store.getManagedRecords('profile-a');
    const events = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-07-31',
      endDate: '2026-09-06',
    });
    const receiptEvents = events.filter(
      (event) =>
        event.kind === 'receivable-settlement' && event.sourceRecordId === 'monthly-release-only',
    );
    expect(receiptEvents.map((event) => [event.date, event.amountCents, event.accountId])).toEqual([
      ['2026-08-03', 4_000, 'profile-a-primary-cash'],
      ['2026-08-06', 6_000, 'profile-a-reserve'],
    ]);

    const owed = projectRollingReceivableBalances({
      receivables: records.receivables,
      settlementEvents: records.events,
      replayStartDate: '2026-07-31',
      startDate: '2026-07-31',
      endDate: '2026-09-06',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const owedOn = (date: string) => owed.find((day) => day.date === date)!;
    expect(owedOn('2026-07-31').endingOutstandingCents).toBe(0);
    expect(owedOn('2026-08-01').endingOutstandingCents).toBe(10_000);
    expect(owedOn('2026-08-03')).toMatchObject({
      settledCents: 4_000,
      endingOutstandingCents: 6_000,
    });
    expect(owedOn('2026-08-06')).toMatchObject({
      settledCents: 6_000,
      endingOutstandingCents: 0,
    });
    expect(owedOn('2026-09-01')).toMatchObject({
      accruedCents: 10_000,
      endingOutstandingCents: 10_000,
    });
    expect(owedOn('2026-09-05').endingOutstandingCents).toBe(10_000);

    const forecast = buildForecastBundle({
      accounts: records.accounts,
      events,
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        horizonDays: 60,
        includeConfirmedReceivablesConservatively: true,
      }),
      startDate: '2026-07-31',
      endDate: '2026-09-06',
    }).expected.days;
    const cashOn = (date: string) => forecast.find((day) => day.date === date)!;
    const balancesOn = (date: string) =>
      Object.fromEntries(
        cashOn(date).accounts.map((account) => [account.accountId, account.endingBalanceCents]),
      );
    expect(balancesOn('2026-08-02')).toEqual({
      'profile-a-primary-cash': 100_000,
      'profile-a-reserve': 50_000,
    });
    expect(balancesOn('2026-08-03')).toEqual({
      'profile-a-primary-cash': 104_000,
      'profile-a-reserve': 50_000,
    });
    expect(balancesOn('2026-08-06')).toEqual({
      'profile-a-primary-cash': 104_000,
      'profile-a-reserve': 56_000,
    });
    expect(cashOn('2026-08-06').consolidatedCashCents).toBe(160_000);
    expect(cashOn('2026-09-05').consolidatedCashCents).toBe(160_000);
    expect(
      cashOn('2026-07-31').consolidatedCashCents + owedOn('2026-07-31').endingOutstandingCents,
    ).toBe(150_000);
    expect(
      cashOn('2026-09-05').consolidatedCashCents + owedOn('2026-09-05').endingOutstandingCents,
    ).toBe(170_000);

    const audits = store.raw
      .prepare(
        "SELECT payload_json AS payloadJson FROM audit_events WHERE user_id = ? AND action = 'settle' ORDER BY created_at, rowid",
      )
      .all('profile-a') as Array<{ payloadJson: string }>;
    expect(audits.map((audit) => JSON.parse(audit.payloadJson))).toEqual([
      expect.objectContaining({
        occurrenceDate: '2026-08-05',
        destinationAccountId: 'profile-a-primary-cash',
        staticBalanceReducedCents: 0,
      }),
      expect.objectContaining({
        occurrenceDate: '2026-08-05',
        destinationAccountId: 'profile-a-reserve',
        staticBalanceReducedCents: 0,
      }),
    ]);
  });

  it('records one unattributed receipt by atomically applying it to the oldest open balances', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-07-30',
      accountName: 'Primary checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    for (const input of [
      {
        id: 'older-balance',
        description: 'Older shared purchase',
        remainingAmountCents: 4_000,
        expectedDate: '2026-07-20',
      },
      {
        id: 'newer-balance',
        description: 'Newer shared purchase',
        remainingAmountCents: 3_000,
        expectedDate: '2026-07-25',
      },
    ]) {
      store.upsertManagedEntity('profile-a', 'receivable', {
        id: input.id,
        source: 'Synthetic partner',
        description: input.description,
        originalAmountCents: input.remainingAmountCents,
        remainingAmountCents: input.remainingAmountCents,
        expectedDate: input.expectedDate,
        destinationAccountId: 'profile-a-primary-cash',
        certainty: 'confirmed',
        includeInCashForecast: false,
      });
    }

    expect(() =>
      store.recordUnattributedReceivableSettlement({
        userId: 'profile-a',
        amountCents: 7_001,
        date: '2026-07-31',
        asOfDate: '2026-07-31',
        destinationAccountId: 'profile-a-primary-cash',
      }),
    ).toThrow(/cannot be more than the Money Owed balance/i);
    expect(
      store
        .getManagedRecords('profile-a')
        .events.filter((event) => event.kind === 'receivable-settlement'),
    ).toHaveLength(0);

    const eventIds = store.recordUnattributedReceivableSettlement({
      userId: 'profile-a',
      amountCents: 5_000,
      date: '2026-07-31',
      asOfDate: '2026-07-31',
      destinationAccountId: 'profile-a-primary-cash',
    });
    expect(eventIds).toHaveLength(2);
    const records = store.getManagedRecords('profile-a');
    expect(
      Object.fromEntries(
        records.receivables.map((receivable) => [receivable.id, receivable.remainingAmountCents]),
      ),
    ).toEqual({
      'older-balance': 0,
      'newer-balance': 2_000,
    });
    const settlements = records.events
      .filter((event) => event.kind === 'receivable-settlement')
      .sort((left, right) => left.sourceRecordId!.localeCompare(right.sourceRecordId!));
    expect(settlements).toEqual([
      expect.objectContaining({
        sourceRecordId: 'newer-balance',
        amountCents: 1_000,
        accountId: 'profile-a-primary-cash',
        date: '2026-07-31',
      }),
      expect.objectContaining({
        sourceRecordId: 'older-balance',
        amountCents: 4_000,
        accountId: 'profile-a-primary-cash',
        date: '2026-07-31',
      }),
    ]);
    const owed = projectRollingReceivableBalances({
      receivables: records.receivables,
      settlementEvents: records.events,
      replayStartDate: '2026-07-30',
      startDate: '2026-07-31',
      endDate: '2026-07-31',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    })[0]!;
    expect(owed.endingOutstandingCents).toBe(2_000);
    const cash = buildForecastBundle({
      accounts: records.accounts,
      events: materializeForecastEvents({
        accounts: records.accounts,
        events: records.events,
        cards: [],
        cardCycles: [],
        loans: [],
        receivables: records.receivables,
        startDate: '2026-07-30',
        endDate: '2026-07-31',
      }),
      policy: records.policy!,
      startDate: '2026-07-30',
      endDate: '2026-07-31',
    }).expected.days.at(-1)!;
    expect(cash.consolidatedCashCents).toBe(105_000);
  });

  it('automatically applies an unattributed receipt to a newly accrued recurring occurrence', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-07-31',
      accountName: 'Primary checking',
      openingBalanceCents: 100_000,
      hardFloorCents: 0,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'monthly-contribution',
      source: 'Synthetic partner',
      description: 'Monthly contribution',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-08-01',
      recurringAmountCents: 3_000,
      recurrenceRule: { frequency: 'monthly', interval: 1, dayOfMonth: 1 },
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'confirmed',
      includeInCashForecast: false,
    });

    store.recordUnattributedReceivableSettlement({
      userId: 'profile-a',
      amountCents: 3_000,
      date: '2026-08-01',
      asOfDate: '2026-08-01',
      destinationAccountId: 'profile-a-primary-cash',
    });
    const records = store.getManagedRecords('profile-a');
    expect(records.events.find((event) => event.kind === 'receivable-settlement')).toMatchObject({
      sourceRecordId: 'monthly-contribution',
      receivableOccurrenceDate: '2026-08-01',
      amountCents: 3_000,
      accountId: 'profile-a-primary-cash',
    });
    expect(
      projectRollingReceivableBalances({
        receivables: records.receivables,
        settlementEvents: records.events,
        replayStartDate: '2026-07-31',
        startDate: '2026-08-01',
        endDate: '2026-08-01',
        mode: 'expected',
        includeConfirmedReceivablesConservatively: true,
      })[0]!.endingOutstandingCents,
    ).toBe(0);
  });
});
