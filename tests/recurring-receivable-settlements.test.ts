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
  type ForecastEvent,
} from '@balance-book/domain';
import {
  formatReceivableOccurrenceNote,
  materializeForecastEvents,
  prepareRollingForecastContext,
  projectReceivableBalances,
  projectRollingReceivableBalances,
} from '@balance-book/financial-engine';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-receivable-test-'));
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
  hardFloorCents: 0,
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.raw.open) store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('recurring receivable settlement actualization', () => {
  it('keeps an overdue open balance owed until an actual settlement is recorded', () => {
    const receivable = receivableSchema.parse({
      id: 'overdue-open',
      userId: 'profile-a',
      source: 'Synthetic customer',
      description: 'Overdue reimbursement',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-09-01',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      includeInCashForecast: true,
    });
    const days = projectRollingReceivableBalances({
      receivables: [receivable],
      replayStartDate: '2026-08-01',
      startDate: '2026-09-15',
      endDate: '2026-09-20',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });

    expect(days[0]).toMatchObject({
      date: '2026-09-15',
      endingOutstandingCents: 10_000,
      settledCents: 0,
    });
    expect(days.at(-1)?.endingOutstandingCents).toBe(10_000);
  });

  it('does not replay an unresolved overdue receipt into cash while it remains owed', () => {
    const account = cashAccountSchema.parse({
      id: 'cash-a',
      userId: 'profile-a',
      name: 'Synthetic checking',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-08-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 0,
    });
    const receivable = receivableSchema.parse({
      id: 'overdue-cash-identity',
      userId: 'profile-a',
      source: 'Synthetic customer',
      description: 'Still-open overdue reimbursement',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-09-01',
      destinationAccountId: account.id,
      certainty: 'expected',
      includeInCashForecast: true,
    });
    const context = prepareRollingForecastContext({
      accounts: [account],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      policy: cashFloorPolicySchema.parse({
        hardConsolidatedFloorCents: 0,
        horizonDays: 30,
        includeConfirmedReceivablesConservatively: true,
      }),
      requestedStartDate: '2026-09-15',
    });
    const owed = projectRollingReceivableBalances({
      receivables: [receivable],
      replayStartDate: context.replayStartDate,
      startDate: context.startDate,
      endDate: context.endDate,
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });

    expect(context.accounts[0]?.openingBalanceCents).toBe(100_000);
    expect(owed[0]?.endingOutstandingCents).toBe(10_000);
    expect(context.accounts[0]!.openingBalanceCents + owed[0]!.endingOutstandingCents).toBe(
      110_000,
    );
  });

  it('replays an accrual before a newer cash snapshot so current money owed does not disappear', () => {
    const receivable = receivableSchema.parse({
      id: 'monthly-share-current',
      userId: 'profile-a',
      source: 'Synthetic partner',
      description: 'Shared service expense',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 27_500,
      expectedDate: '2026-09-28',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 27_500,
      accrualDate: '2026-09-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    });
    const days = projectRollingReceivableBalances({
      receivables: [receivable],
      replayStartDate: '2026-09-15',
      startDate: '2026-09-15',
      endDate: '2026-09-30',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });

    expect(days[0]?.endingOutstandingCents).toBe(27_500);
    expect(days.find((day) => day.date === '2026-09-28')?.endingOutstandingCents).toBe(0);
  });

  it('treats a nonzero current balance as already including past accruals', () => {
    const receivable = receivableSchema.parse({
      id: 'current-balance-with-growth',
      userId: 'profile-a',
      source: 'Synthetic customer',
      description: 'Current balance plus future monthly growth',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-12-31',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      accrualAmountCents: 10_000,
      accrualDate: '2026-07-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: false,
    });
    const days = projectRollingReceivableBalances({
      receivables: [receivable],
      replayStartDate: '2026-07-01',
      startDate: '2026-07-15',
      endDate: '2026-08-02',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });

    expect(days[0]?.endingOutstandingCents).toBe(10_000);
    expect(days.find((day) => day.date === '2026-07-31')?.endingOutstandingCents).toBe(10_000);
    expect(days.find((day) => day.date === '2026-08-01')?.endingOutstandingCents).toBe(20_000);
  });

  it('pairs the next accrual with the next receipt after a past accrual entered the current balance', () => {
    const receivable = receivableSchema.parse({
      id: 'current-anchor-with-skipped-accrual',
      userId: 'profile-a',
      source: 'Synthetic customer',
      description: 'Current installment followed by monthly activity',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      recurringAmountCents: 10_000,
      expectedDate: '2026-08-28',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 10_000,
      accrualDate: '2026-08-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    });
    const days = projectRollingReceivableBalances({
      receivables: [receivable],
      replayStartDate: '2026-08-01',
      startDate: '2026-08-15',
      endDate: '2026-09-29',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => days.find((day) => day.date === date)!;

    expect(on('2026-08-28')).toMatchObject({ settledCents: 10_000, endingOutstandingCents: 0 });
    expect(on('2026-09-01')).toMatchObject({
      accruedCents: 10_000,
      endingOutstandingCents: 10_000,
    });
    expect(on('2026-09-28')).toMatchObject({ settledCents: 10_000, endingOutstandingCents: 0 });
  });

  it('moves each actual recurring receipt from money owed to cash on the same date', () => {
    const userId = 'profile-a';
    const receivable = receivableSchema.parse({
      id: 'monthly-share-asset',
      userId,
      source: 'Synthetic partner',
      description: 'Shared service expense',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 27_500,
      expectedDate: '2026-08-28',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 27_500,
      accrualDate: '2026-08-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    });
    const actual = (input: {
      id: string;
      date: string;
      amountCents: number;
      occurrenceDate: '2026-08-28' | '2026-09-28';
    }): ForecastEvent =>
      forecastEventSchema.parse({
        id: input.id,
        userId,
        accountId: 'cash-a',
        date: input.date,
        kind: 'receivable-settlement',
        direction: 'inflow',
        amountCents: input.amountCents,
        certainty: 'confirmed',
        status: 'confirmed',
        label: 'Recorded settlement',
        sourceRecordId: receivable.id,
        notes: formatReceivableOccurrenceNote(input.occurrenceDate),
      });
    const settlementEvents = [
      actual({
        id: 'august-actual',
        date: '2026-08-26',
        amountCents: 27_500,
        occurrenceDate: '2026-08-28',
      }),
      actual({
        id: 'september-partial',
        date: '2026-09-27',
        amountCents: 10_000,
        occurrenceDate: '2026-09-28',
      }),
    ];
    const projection = projectReceivableBalances({
      receivables: [receivable],
      settlementEvents,
      startDate: '2026-08-01',
      endDate: '2026-09-30',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => projection.find((day) => day.date === date)!;

    expect(on('2026-08-01').endingOutstandingCents).toBe(27_500);
    expect(on('2026-08-26')).toMatchObject({
      settledCents: 27_500,
      endingOutstandingCents: 0,
    });
    expect(on('2026-08-28').settledCents).toBe(0);
    expect(on('2026-09-01').endingOutstandingCents).toBe(27_500);
    expect(on('2026-09-27')).toMatchObject({
      settledCents: 10_000,
      endingOutstandingCents: 17_500,
    });
    expect(on('2026-09-28')).toMatchObject({
      settledCents: 17_500,
      endingOutstandingCents: 0,
    });
  });

  it('carries an early receipt forward to offset its linked later accrual', () => {
    const receivable = receivableSchema.parse({
      id: 'early-monthly-share',
      userId: 'profile-a',
      source: 'Synthetic partner',
      description: 'Early shared service receipt',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-08-28',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 10_000,
      accrualDate: '2026-08-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    });
    const earlyActual = forecastEventSchema.parse({
      id: 'early-actual',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-07-31',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Early actual receipt',
      sourceRecordId: receivable.id,
      notes: formatReceivableOccurrenceNote('2026-08-28'),
    });
    const days = projectRollingReceivableBalances({
      receivables: [receivable],
      settlementEvents: [earlyActual],
      replayStartDate: '2026-08-01',
      startDate: '2026-07-31',
      endDate: '2026-08-29',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => days.find((day) => day.date === date)!;

    expect(on('2026-07-31')).toMatchObject({ settledCents: 0, endingOutstandingCents: 0 });
    expect(on('2026-08-01')).toMatchObject({
      accruedCents: 10_000,
      settledCents: 10_000,
      endingOutstandingCents: 0,
    });
    expect(on('2026-08-28')).toMatchObject({ settledCents: 0, endingOutstandingCents: 0 });
  });

  it('replays a late actual receipt whose logical occurrence predates the replay window', () => {
    const receivable = receivableSchema.parse({
      id: 'late-receipt-before-replay-anchor',
      userId: 'profile-a',
      source: 'Synthetic counterparty',
      description: 'Synthetic recurring reimbursement',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 12_345,
      expectedDate: '2031-01-15',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 15, interval: 1 },
      accrualAmountCents: 12_345,
      accrualDate: '2031-02-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    });
    const lateActual = forecastEventSchema.parse({
      id: 'late-recorded-receipt',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2031-02-02',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 12_345,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Synthetic late receipt',
      sourceRecordId: receivable.id,
      receivableOccurrenceDate: '2031-01-15',
    });
    const days = projectRollingReceivableBalances({
      receivables: [receivable],
      settlementEvents: [lateActual],
      replayStartDate: '2031-01-20',
      startDate: '2031-01-20',
      endDate: '2031-02-03',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => days.find((day) => day.date === date)!;

    expect(on('2031-02-01')).toMatchObject({
      accruedCents: 12_345,
      settledCents: 0,
      endingOutstandingCents: 12_345,
    });
    expect(on('2031-02-02')).toMatchObject({
      accruedCents: 0,
      settledCents: 12_345,
      endingOutstandingCents: 0,
    });
  });

  it('keeps a later-installment prepayment from settling an earlier accrual', () => {
    const receivable = receivableSchema.parse({
      id: 'future-installment-prepayment',
      userId: 'profile-a',
      source: 'Synthetic partner',
      description: 'Installment-specific prepayment',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-08-28',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 10_000,
      accrualDate: '2026-08-15',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 15, interval: 1 },
      includeInCashForecast: true,
    });
    const septemberPrepayment = forecastEventSchema.parse({
      id: 'september-prepayment',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-08-01',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'September installment prepaid',
      sourceRecordId: receivable.id,
      notes: formatReceivableOccurrenceNote('2026-09-28'),
    });
    const days = projectReceivableBalances({
      receivables: [receivable],
      settlementEvents: [septemberPrepayment],
      startDate: '2026-08-01',
      endDate: '2026-09-30',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => days.find((day) => day.date === date)!;

    expect(on('2026-08-15')).toMatchObject({
      accruedCents: 10_000,
      settledCents: 0,
      endingOutstandingCents: 10_000,
    });
    expect(on('2026-08-28')).toMatchObject({
      settledCents: 10_000,
      endingOutstandingCents: 0,
    });
    expect(on('2026-09-15')).toMatchObject({
      accruedCents: 10_000,
      settledCents: 10_000,
      endingOutstandingCents: 0,
    });
    expect(on('2026-09-28')).toMatchObject({ settledCents: 0, endingOutstandingCents: 0 });
  });

  it('pairs a prepaid service credit with the following accrual by schedule order', () => {
    const receivable = receivableSchema.parse({
      id: 'prepaid-service-credit',
      userId: 'profile-a',
      source: 'Synthetic vendor',
      description: 'Service credit received before the monthly invoice',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 43_700,
      expectedDate: '2026-08-28',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 43_700,
      accrualDate: '2026-09-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    });
    const augustReceipt = forecastEventSchema.parse({
      id: 'august-service-credit',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-08-26',
      kind: 'receivable-settlement',
      direction: 'inflow',
      amountCents: 43_700,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'August service credit received',
      sourceRecordId: receivable.id,
      notes: formatReceivableOccurrenceNote('2026-08-28'),
    });
    const days = projectReceivableBalances({
      receivables: [receivable],
      settlementEvents: [augustReceipt],
      startDate: '2026-08-01',
      endDate: '2026-10-02',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => days.find((day) => day.date === date)!;

    expect(on('2026-09-01')).toMatchObject({
      accruedCents: 43_700,
      settledCents: 43_700,
      endingOutstandingCents: 0,
    });
    expect(on('2026-09-28')).toMatchObject({ settledCents: 0, endingOutstandingCents: 0 });
    expect(on('2026-10-01')).toMatchObject({
      accruedCents: 43_700,
      settledCents: 43_700,
      endingOutstandingCents: 0,
    });
  });

  it('pairs the first new accrual after a static anchor with the next receipt occurrence', () => {
    const receivable = receivableSchema.parse({
      id: 'static-anchor-then-recurring',
      userId: 'profile-a',
      source: 'Synthetic customer',
      description: 'Settled static anchor followed by recurring activity',
      originalAmountCents: 10_000,
      remainingAmountCents: 0,
      recurringAmountCents: 20_000,
      expectedDate: '2026-08-28',
      destinationAccountId: 'cash-a',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      accrualAmountCents: 20_000,
      accrualDate: '2026-09-01',
      accrualRecurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      includeInCashForecast: true,
    });
    const days = projectReceivableBalances({
      receivables: [receivable],
      startDate: '2026-08-28',
      endDate: '2026-09-29',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });
    const on = (date: string) => days.find((day) => day.date === date)!;

    expect(on('2026-09-01')).toMatchObject({
      accruedCents: 20_000,
      settledCents: 0,
      endingOutstandingCents: 20_000,
    });
    expect(on('2026-09-28')).toMatchObject({
      settledCents: 20_000,
      endingOutstandingCents: 0,
    });
  });

  it('replaces the first and a later planned occurrence with their recorded cash exactly once', () => {
    const userId = 'profile-a';
    const account = cashAccountSchema.parse({
      id: 'cash-a',
      userId,
      name: 'Synthetic checking',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-07-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 0,
    });
    const receivable = receivableSchema.parse({
      id: 'monthly-share',
      userId,
      source: 'Synthetic partner',
      description: 'Shared service expense',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 27_500,
      expectedDate: '2026-08-28',
      destinationAccountId: account.id,
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      includeInCashForecast: true,
    });
    const actual = (input: {
      id: string;
      date: string;
      occurrenceDate: '2026-08-28' | '2026-09-28';
    }): ForecastEvent =>
      forecastEventSchema.parse({
        id: input.id,
        userId,
        accountId: account.id,
        date: input.date,
        kind: 'receivable-settlement',
        direction: 'inflow',
        amountCents: 27_500,
        certainty: 'confirmed',
        status: 'confirmed',
        label: 'Recorded shared service settlement',
        sourceRecordId: receivable.id,
        notes: formatReceivableOccurrenceNote(input.occurrenceDate),
      });
    const events = materializeForecastEvents({
      accounts: [account],
      events: [
        actual({ id: 'august-actual', date: '2026-08-26', occurrenceDate: '2026-08-28' }),
        actual({ id: 'september-actual', date: '2026-09-28', occurrenceDate: '2026-09-28' }),
      ],
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [receivable],
      startDate: '2026-08-01',
      endDate: '2026-10-31',
    }).filter((event) => event.kind === 'receivable-settlement');

    expect(events.map((event) => [event.id, event.date, event.amountCents])).toEqual([
      ['august-actual', '2026-08-26', 27_500],
      ['september-actual', '2026-09-28', 27_500],
      ['receivable-settlement-monthly-share@2026-10-28', '2026-10-28', 27_500],
    ]);
    expect(events.reduce((total, event) => total + event.amountCents, 0)).toBe(82_500);
  });

  it('persists partial later-occurrence settlements without changing a zero static anchor', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'monthly-share',
      source: 'Synthetic partner',
      description: 'Shared service expense',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 27_500,
      expectedDate: '2026-08-28',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      includeInCashForecast: true,
    });

    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'monthly-share',
      amountCents: 27_500,
      date: '2026-08-26',
      asOfDate: '2026-08-26',
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'monthly-share',
      amountCents: 10_000,
      date: '2026-09-27',
      asOfDate: '2026-09-27',
    });
    const partialRecords = store.getManagedRecords('profile-a');
    expect(
      materializeForecastEvents({
        accounts: partialRecords.accounts,
        events: partialRecords.events,
        cards: partialRecords.cards,
        cardCycles: partialRecords.cardCycles,
        loans: partialRecords.loans,
        receivables: partialRecords.receivables,
        startDate: '2026-09-01',
        endDate: '2026-09-30',
      }).find((event) => event.id === 'receivable-settlement-monthly-share@2026-09-28'),
    ).toMatchObject({ amountCents: 17_500, status: 'planned' });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'monthly-share',
      amountCents: 17_500,
      date: '2026-09-28',
      asOfDate: '2026-09-28',
    });

    const records = store.getManagedRecords('profile-a');
    expect(
      records.receivables.find((item) => item.id === 'monthly-share')?.remainingAmountCents,
    ).toBe(0);
    expect(
      records.events
        .filter((event) => event.sourceRecordId === 'monthly-share')
        .map((event) => [
          event.date,
          event.amountCents,
          event.notes,
          event.receivableOccurrenceDate,
          event.receivableOccurrenceTargetCents,
        ]),
    ).toEqual([
      ['2026-08-26', 27_500, undefined, '2026-08-28', 27_500],
      ['2026-09-27', 10_000, undefined, '2026-09-28', 27_500],
      ['2026-09-28', 17_500, undefined, '2026-09-28', 27_500],
    ]);
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'monthly-share',
        amountCents: 1,
        date: '2026-09-28',
        asOfDate: '2026-09-28',
      }),
    ).toThrow(/open occurrence amount/i);

    const materialized = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-08-01',
      endDate: '2026-10-31',
    }).filter((event) => event.kind === 'receivable-settlement');
    expect(
      materialized.filter(
        (event) =>
          event.id === 'receivable-settlement-monthly-share@2026-08-28' ||
          event.id === 'receivable-settlement-monthly-share@2026-09-28',
      ),
    ).toHaveLength(0);
    expect(
      materialized.find((event) => event.id === 'receivable-settlement-monthly-share@2026-10-28'),
    ).toMatchObject({ amountCents: 27_500 });

    const audits = store.raw
      .prepare(
        "SELECT payload_json AS payloadJson FROM audit_events WHERE user_id = ? AND action = 'settle' ORDER BY created_at, rowid",
      )
      .all('profile-a') as Array<{ payloadJson: string }>;
    expect(audits.map((audit) => JSON.parse(audit.payloadJson))).toEqual([
      expect.objectContaining({ occurrenceDate: '2026-08-28', staticBalanceReducedCents: 0 }),
      expect.objectContaining({ occurrenceDate: '2026-09-28', staticBalanceReducedCents: 0 }),
      expect.objectContaining({ occurrenceDate: '2026-09-28', staticBalanceReducedCents: 0 }),
    ]);
  });

  it('does not turn a fully settled static first occurrence into a second recurring allowance', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'static-then-recurring',
      source: 'Synthetic customer',
      description: 'Static open amount then larger monthly amount',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      recurringAmountCents: 20_000,
      expectedDate: '2026-08-28',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'static-then-recurring',
      amountCents: 10_000,
      date: '2026-08-28',
      asOfDate: '2026-08-28',
    });
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'static-then-recurring',
        amountCents: 1,
        date: '2026-08-28',
        asOfDate: '2026-08-28',
      }),
    ).toThrow(/open occurrence amount/i);

    const records = store.getManagedRecords('profile-a');
    const settlements = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-08-01',
      endDate: '2026-09-30',
    }).filter(
      (event) =>
        event.kind === 'receivable-settlement' && event.sourceRecordId === 'static-then-recurring',
    );
    expect(settlements.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-08-28', 10_000],
      ['2026-09-28', 20_000],
    ]);
  });

  it('lets a late receipt explicitly finish an older partial installment', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'installment-choice',
      source: 'Synthetic customer',
      description: 'Explicit installment choice',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-09-28',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'installment-choice',
      amountCents: 4_000,
      date: '2026-10-02',
      asOfDate: '2026-10-02',
      occurrenceDate: '2026-09-28',
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'installment-choice',
      amountCents: 6_000,
      date: '2026-10-20',
      asOfDate: '2026-10-20',
      occurrenceDate: '2026-09-28',
    });
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'installment-choice',
        amountCents: 1,
        date: '2026-10-20',
        asOfDate: '2026-10-20',
        occurrenceDate: '2026-09-27',
      }),
    ).toThrow(/not part of the receivable schedule/i);

    const records = store.getManagedRecords('profile-a');
    const settlements = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-09-01',
      endDate: '2026-10-31',
    }).filter(
      (event) =>
        event.kind === 'receivable-settlement' && event.sourceRecordId === 'installment-choice',
    );
    expect(
      settlements.map((event) => [
        event.date,
        event.amountCents,
        event.notes,
        event.receivableOccurrenceDate,
        event.receivableOccurrenceTargetCents,
      ]),
    ).toEqual([
      ['2026-10-02', 4_000, undefined, '2026-09-28', 10_000],
      ['2026-10-20', 6_000, undefined, '2026-09-28', 10_000],
      ['2026-10-28', 10_000, undefined, undefined, undefined],
    ]);
  });

  it('validates the occurrence cap and keeps settlements isolated to the owning user', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.saveVerticalSlice('profile-a', setup);
    store.saveVerticalSlice('profile-b', setup);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'monthly-service-credit',
      source: 'Synthetic vendor',
      description: 'Monthly service credit',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 37_900,
      expectedDate: '2026-08-28',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      includeInCashForecast: true,
    });

    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-b',
        receivableId: 'monthly-service-credit',
        amountCents: 1,
        date: '2026-08-28',
        asOfDate: '2026-08-28',
      }),
    ).toThrow(/not found/i);
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'monthly-service-credit',
        amountCents: 37_901,
        date: '2026-08-28',
        asOfDate: '2026-08-28',
      }),
    ).toThrow(/open occurrence amount/i);
    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'monthly-service-credit',
        amountCents: 1,
        date: 'not-a-date',
        asOfDate: '2026-08-28',
      }),
    ).toThrow();
    expect(store.getManagedRecords('profile-a').events).toHaveLength(0);
    expect(store.getManagedRecords('profile-b').events).toHaveLength(0);
  });

  it('rejects a future received date before changing cash or the owed balance', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'future-receipt',
      source: 'Synthetic customer',
      description: 'Future receipt must stay open today',
      originalAmountCents: 25_000,
      remainingAmountCents: 25_000,
      expectedDate: '2026-08-01',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'confirmed',
      includeInCashForecast: true,
    });

    expect(() =>
      store.recordReceivableSettlement({
        userId: 'profile-a',
        receivableId: 'future-receipt',
        amountCents: 25_000,
        date: '2026-08-01',
        asOfDate: '2026-07-15',
      }),
    ).toThrow(/cannot be in the future/i);

    const records = store.getManagedRecords('profile-a');
    expect(records.receivables.find((item) => item.id === 'future-receipt')).toMatchObject({
      remainingAmountCents: 25_000,
    });
    expect(records.events).toHaveLength(0);
  });
});
