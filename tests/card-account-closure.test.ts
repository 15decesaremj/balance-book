import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
} from '@balance-book/domain';
import {
  BalanceBookStore,
  applyMigrations,
  latestSchemaVersion,
  parsePortableProfileBackup,
  type VerticalSliceInput,
} from '@balance-book/database';
import {
  calculateCardPurchaseCashImpact,
  calculateCardSpendingPower,
  generateCardCyclesThroughHorizon,
  materializeForecastEvents,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const temporaryDirectory = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const openStore = (): BalanceBookStore => {
  const directory = temporaryDirectory('balance-book-card-closure-');
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

const account = cashAccountSchema.parse({
  id: 'checking',
  userId: 'user-a',
  name: 'Checking',
  type: 'checking',
  openingBalanceCents: 100_000,
  balanceAsOf: '2026-01-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  transferDelayDays: 0,
});

const card = (
  overrides: Partial<ReturnType<typeof creditCardSchema.parse>> = {},
): ReturnType<typeof creditCardSchema.parse> =>
  creditCardSchema.parse({
    id: 'card-a',
    userId: 'user-a',
    name: 'Everyday card',
    fundingAccountId: account.id,
    defaultFutureStatementCents: 10_000,
    estimatePolicy: 'baseline-guardrail',
    paymentPolicy: 'full-statement',
    paymentDayOfMonth: 10,
    statementCloseDayOfMonth: 15,
    ...overrides,
  });

const closedCard = () => card({ status: 'closed', closedOn: '2026-01-16' });

describe('credit-card and line-of-credit closure lifecycle', () => {
  it('defaults legacy cards active and requires a coherent closure pair', () => {
    expect(card()).toMatchObject({ status: 'active' });
    expect(() => card({ status: 'closed' })).toThrow(/requires its closure date/i);
    expect(() => card({ status: 'active', closedOn: '2026-01-16' })).toThrow(
      /cannot retain a closure date/i,
    );
    expect(closedCard()).toMatchObject({ status: 'closed', closedOn: '2026-01-16' });
  });

  it('keeps the final pre-closure cycle but generates no cycle opening on or after closure', () => {
    const cycles = generateCardCyclesThroughHorizon({
      card: closedCard(),
      cardCycles: [],
      startDate: '2026-01-01',
      endDate: '2026-04-30',
    }).filter((cycle) => cycle.cardId === 'card-a');

    expect(
      cycles.some((cycle) => cycle.opensOn === '2025-12-16' && cycle.dueOn === '2026-02-10'),
    ).toBe(true);
    expect(cycles.every((cycle) => cycle.opensOn < '2026-01-16')).toBe(true);
  });

  it('materializes the final pre-closure baseline payment and no later baseline payments', () => {
    const payments = materializeForecastEvents({
      accounts: [account],
      events: [],
      cards: [closedCard()],
      cardCycles: [],
      loans: [],
      startDate: '2026-01-16',
      endDate: '2026-05-31',
    }).filter((event) => event.kind === 'card-payment');

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ date: '2026-02-10', amountCents: 10_000 });
  });

  it('rejects post-closure purchase calculations and excludes closed accounts from Spending Power', () => {
    expect(() =>
      calculateCardPurchaseCashImpact({
        card: closedCard(),
        cardCycles: [],
        purchaseDate: '2026-01-16',
        amountCents: 1_000,
      }),
    ).toThrow(/on or after closure/i);

    expect(
      calculateCardSpendingPower({
        cards: [closedCard()],
        cardCycles: [],
        asOfDate: '2026-01-16',
        days: [
          {
            date: '2026-02-10',
            consolidatedCashCents: 100_000,
            totalPositionCents: 100_000,
            accountBalances: [{ accountId: account.id, endingBalanceCents: 100_000 }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('ignores card-funded activity after closure while retaining post-close debt payments', () => {
    const statement = creditCardCycleSchema.parse({
      id: 'final-statement',
      cardId: 'card-a',
      opensOn: '2025-12-16',
      closesOn: '2026-01-15',
      dueOn: '2026-02-10',
      state: 'scheduled-payment',
      defaultEstimateCents: 12_345,
      actualActivityCents: 12_345,
      plannedActivityCents: 0,
      lockedStatementCents: 12_345,
    });
    const postClosePurchase = forecastEventSchema.parse({
      id: 'invalid-post-close-purchase',
      userId: 'user-a',
      accountId: account.id,
      date: '2026-01-16',
      kind: 'scenario',
      direction: 'outflow',
      amountCents: 9_999,
      certainty: 'confirmed',
      status: 'confirmed',
      label: 'Post-close purchase',
      paymentMethod: 'credit-card',
      cardId: 'card-a',
      cardActivityTreatment: 'additional',
    });
    const payment = forecastEventSchema.parse({
      id: 'post-close-payment',
      userId: 'user-a',
      accountId: account.id,
      date: '2026-02-10',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 12_345,
      certainty: 'confirmed',
      status: 'paid',
      label: 'Final statement payment',
      sourceRecordId: statement.id,
      paymentMethod: 'cash-account',
      cardId: 'card-a',
    });

    const summary = summarizeRevolvingDebt({
      card: closedCard(),
      cycles: [statement],
      events: [postClosePurchase, payment],
      asOfDate: '2026-02-10',
    });

    expect(summary.latestStatementCents).toBe(12_345);
    expect(summary.currentBalanceCents).toBe(0);
    expect(summary.carryingBalanceCents).toBe(0);
  });
});

describe('credit-card closure persistence', () => {
  const setup: VerticalSliceInput = {
    balanceAsOf: '2026-01-01',
    accountName: 'Synthetic checking',
    openingBalanceCents: 100_000,
    incomeLabel: 'Synthetic income',
    incomeDate: '2026-01-10',
    incomeAmountCents: 50_000,
    commitmentLabel: 'Synthetic bill',
    commitmentDate: '2026-01-05',
    commitmentAmountCents: 30_000,
    cardName: 'Synthetic card',
    cardEstimateCents: 20_000,
    cardPaymentDayOfMonth: 10,
    cardStatementCloseDayOfMonth: 15,
    cardEstimatePolicy: 'baseline-guardrail',
    cardPaymentPolicy: 'full-statement',
    hardFloorCents: 10_000,
    preferredFloorCents: 20_000,
  };

  it('migrates v23 cards to active lifecycle rows', () => {
    const directory = temporaryDirectory('balance-book-card-v24-migration-');
    const databasePath = path.join(directory, 'legacy.sqlite');
    const database = new BetterSqlite3(databasePath);
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations VALUES
          (13, 'dark-first-interface-default', '2026-01-01T00:00:00.000Z'),
          (21, 'compact-legacy-refinance-audit-payloads', '2026-01-01T00:00:00.000Z'),
          (23, 'typed-installment-loan-payment-treatment', '2026-01-01T00:00:00.000Z');
        CREATE TABLE credit_cards (id TEXT PRIMARY KEY NOT NULL);
        INSERT INTO credit_cards (id) VALUES ('legacy-card');
      `);

      applyMigrations({
        database,
        databasePath,
        backupDirectory: path.join(directory, 'backups'),
      });

      expect(latestSchemaVersion).toBeGreaterThanOrEqual(24);
      expect(
        database.prepare('SELECT name FROM schema_migrations WHERE version = 24').get(),
      ).toEqual({ name: 'credit-card-account-lifecycle' });
      expect(database.prepare('SELECT status, closed_on FROM credit_cards').get()).toEqual({
        status: 'active',
        closed_on: null,
      });
    } finally {
      database.close();
    }
  });

  it('round-trips closure, blocks new activity, preserves payments, and reactivation clears closure', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const records = store.getManagedRecords('profile-a');
    const originalCard = records.cards[0]!;
    const accountId = records.accounts[0]!.id;

    store.upsertManagedEntity('profile-a', 'credit-card', {
      ...originalCard,
      status: 'closed',
      closedOn: '2026-01-16',
    });
    const closed = store.getManagedRecords('profile-a').cards[0]!;
    expect(closed).toMatchObject({ status: 'closed', closedOn: '2026-01-16' });

    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        id: 'post-close-card-spend',
        accountId,
        date: '2026-01-16',
        kind: 'direct-commitment',
        direction: 'outflow',
        amountCents: 1_000,
        certainty: 'confirmed',
        status: 'planned',
        label: 'Invalid closed-card purchase',
        paymentMethod: 'credit-card',
        cardId: closed.id,
      }),
    ).toThrow(/cannot fund purchases/i);

    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        id: 'post-close-card-payment',
        accountId,
        date: '2026-02-10',
        kind: 'card-payment',
        direction: 'outflow',
        amountCents: 20_000,
        certainty: 'confirmed',
        status: 'paid',
        label: 'Final card payment',
        paymentMethod: 'cash-account',
        cardId: closed.id,
      }),
    ).not.toThrow();

    const portable = store.exportPortableProfile('profile-a', 'test');
    expect(portable.cards[0]).toMatchObject({ status: 'closed', closedOn: '2026-01-16' });
    const legacyPortable = JSON.parse(JSON.stringify(portable)) as Record<string, unknown>;
    const legacyCards = legacyPortable.cards as Array<Record<string, unknown>>;
    delete legacyCards[0]!.status;
    delete legacyCards[0]!.closedOn;
    expect(parsePortableProfileBackup(legacyPortable).cards[0]).toMatchObject({ status: 'active' });

    store.upsertManagedEntity('profile-a', 'credit-card', { ...closed, status: 'active' });
    const reactivated = store.getManagedRecords('profile-a').cards[0]!;
    expect(reactivated.status).toBe('active');
    expect(reactivated.closedOn).toBeUndefined();
  });
});
