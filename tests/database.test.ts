import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BalanceBookStore,
  applyMigrations,
  createEncryptedBackup,
  decryptBackup,
  LocalAuthService,
  latestSchemaVersion,
  readEncryptedBackup,
  writeEncryptedBackup,
  type VerticalSliceInput,
} from '@balance-book/database';
import { materializeForecastEvents } from '@balance-book/financial-engine';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-db-test-'));
  temporaryDirectories.push(directory);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'backups'),
  });
  stores.push(store);
  return store;
};

const setup: VerticalSliceInput = {
  balanceAsOf: '2026-01-01',
  accountName: 'Synthetic checking',
  openingBalanceCents: 100_000,
  incomeLabel: 'Synthetic income',
  incomeDate: '2026-01-10',
  incomeAmountCents: 50_000,
  commitmentLabel: 'Synthetic commitment',
  commitmentDate: '2026-01-05',
  commitmentAmountCents: 30_000,
  cardName: 'Synthetic card',
  cardEstimateCents: 20_000,
  cardPaymentDayOfMonth: 15,
  cardStatementCloseDayOfMonth: 24,
  cardEstimatePolicy: 'baseline-guardrail',
  cardPaymentPolicy: 'full-statement',
  hardFloorCents: 10_000,
  preferredFloorCents: 20_000,
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.raw.open) store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('local database and authentication', () => {
  it('applies a versioned migration and initializes profile shells idempotently', () => {
    const store = openStore();
    const initial = [
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'New User', username: 'newuser' },
    ];
    store.initializeProfiles(initial);
    store.initializeProfiles(initial);
    expect(store.listProfiles()).toHaveLength(2);
    expect(initial.map((profile) => store.getCredentialsById(profile.id)?.themePreference)).toEqual(
      ['dark', 'dark'],
    );
    const migration = store.raw
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    expect(migration.version).toBe(latestSchemaVersion);
  });

  it('moves the legacy system default to dark without overwriting an explicit light choice', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.setTheme('profile-a', 'system');
    store.setTheme('profile-b', 'light');
    store.raw.prepare('DELETE FROM schema_migrations WHERE version = 13').run();

    applyMigrations({
      database: store.raw,
      databasePath: store.raw.name,
      backupDirectory: path.join(path.dirname(store.raw.name), 'theme-migration-backups'),
    });

    expect(store.getCredentialsById('profile-a')?.themePreference).toBe('dark');
    expect(store.getCredentialsById('profile-b')?.themePreference).toBe('light');
  });

  it('reapplies the Overview visibility migration safely when its marker is missing', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.raw.prepare('DELETE FROM schema_migrations WHERE version = 30').run();

    expect(() =>
      applyMigrations({
        database: store.raw,
        databasePath: store.raw.name,
        backupDirectory: path.join(path.dirname(store.raw.name), 'visibility-migration-backups'),
      }),
    ).not.toThrow();

    expect(
      store.raw.prepare('SELECT name FROM schema_migrations WHERE version = 30').get(),
    ).toMatchObject({ name: 'cash-account-overview-visibility' });
    expect(store.getManagedRecords('profile-a').accounts[0]!.showOnOverview).toBe(true);
  });

  it('scopes a cash card-payment link to a card owned by the active profile', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.saveVerticalSlice('profile-a', setup);
    store.saveVerticalSlice('profile-b', setup);
    const profileACardId = store.getManagedRecords('profile-a').cards[0]!.id;
    const profileBCardId = store.getManagedRecords('profile-b').cards[0]!.id;
    const payment = {
      id: 'profile-a-card-payment',
      accountId: 'profile-a-primary-cash',
      date: '2026-01-15',
      kind: 'card-payment' as const,
      direction: 'outflow' as const,
      amountCents: 20_000,
      certainty: 'confirmed' as const,
      status: 'paid' as const,
      label: 'Synthetic statement payment',
      paymentMethod: 'cash-account' as const,
      cardId: profileACardId,
    };

    expect(store.upsertManagedEntity('profile-a', 'forecast-event', payment)).toBe(payment.id);
    expect(store.getManagedRecords('profile-a').events).toContainEqual(
      expect.objectContaining({ id: payment.id, cardId: profileACardId }),
    );
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...payment,
        id: 'cross-profile-card-payment',
        cardId: profileBCardId,
      }),
    ).toThrow(/card.*profile/i);
  });

  it('validates durable loan and optional statement sources on explicit debt payments', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.saveVerticalSlice('profile-a', setup);
    store.saveVerticalSlice('profile-b', setup);
    const profileARecords = store.getManagedRecords('profile-a');
    const profileBRecords = store.getManagedRecords('profile-b');
    const profileAAccountId = profileARecords.accounts[0]!.id;
    const profileBAccountId = profileBRecords.accounts[0]!.id;
    const profileACardId = profileARecords.cards[0]!.id;
    const profileBCardId = profileBRecords.cards[0]!.id;

    store.upsertManagedEntity('profile-a', 'credit-card', {
      id: 'profile-a-other-card',
      name: 'Other synthetic card',
      fundingAccountId: profileAAccountId,
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'manual',
      paymentDayOfMonth: 20,
      statementCloseDayOfMonth: 25,
    });
    const cycle = {
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-15',
      state: 'future-estimated' as const,
      defaultEstimateCents: 20_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    };
    store.upsertManagedEntity('profile-a', 'card-cycle', {
      ...cycle,
      id: 'profile-a-cycle',
      cardId: profileACardId,
    });
    store.upsertManagedEntity('profile-b', 'card-cycle', {
      ...cycle,
      id: 'profile-b-cycle',
      cardId: profileBCardId,
    });

    const cardPayment = {
      id: 'profile-a-linked-card-payment',
      accountId: profileAAccountId,
      date: '2026-07-15',
      kind: 'card-payment' as const,
      direction: 'outflow' as const,
      amountCents: 20_000,
      certainty: 'confirmed' as const,
      status: 'paid' as const,
      label: 'Synthetic statement payment',
      paymentMethod: 'cash-account' as const,
      cardId: profileACardId,
      sourceRecordId: 'profile-a-cycle',
    };
    expect(store.upsertManagedEntity('profile-a', 'forecast-event', cardPayment)).toBe(
      cardPayment.id,
    );
    expect(
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...cardPayment,
        id: 'profile-a-unlinked-card-payment',
        sourceRecordId: undefined,
      }),
    ).toBe('profile-a-unlinked-card-payment');
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...cardPayment,
        id: 'wrong-card-cycle-payment',
        cardId: 'profile-a-other-card',
      }),
    ).toThrow(/statement cycle.*selected card.*profile/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...cardPayment,
        id: 'cross-profile-cycle-payment',
        sourceRecordId: 'profile-b-cycle',
      }),
    ).toThrow(/statement cycle.*selected card.*profile/i);

    const makeLoan = (id: string, fundingAccountId: string) => ({
      id,
      name: `Synthetic ${id}`,
      principalCents: 100_000,
      accruedInterestCents: 0,
      balanceDate: '2026-07-01',
      annualRateBasisPoints: 500,
      accrualConvention: 'actual-365' as const,
      paymentCents: 10_000,
      nextPaymentDate: '2026-08-01',
      fundingAccountId,
      excludeFromEconomicNetWorthDoubleCount: false,
      paymentFrequency: 'monthly' as const,
      includeInCashForecast: true,
      status: 'active' as const,
    });
    store.upsertManagedEntity('profile-a', 'loan', makeLoan('profile-a-loan', profileAAccountId));
    store.upsertManagedEntity('profile-b', 'loan', makeLoan('profile-b-loan', profileBAccountId));
    const loanPayment = {
      id: 'profile-a-loan-payment',
      accountId: profileAAccountId,
      date: '2026-08-01',
      kind: 'loan-payment' as const,
      direction: 'outflow' as const,
      amountCents: 10_000,
      certainty: 'confirmed' as const,
      status: 'paid' as const,
      label: 'Synthetic installment payment',
      paymentMethod: 'cash-account' as const,
      sourceRecordId: 'profile-a-loan',
    };
    expect(store.upsertManagedEntity('profile-a', 'forecast-event', loanPayment)).toBe(
      loanPayment.id,
    );
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...loanPayment,
        id: 'missing-loan-link',
        sourceRecordId: undefined,
      }),
    ).toThrow(/identify the installment loan/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...loanPayment,
        id: 'cross-profile-loan-payment',
        sourceRecordId: 'profile-b-loan',
      }),
    ).toThrow(/linked liability.*profile/i);
  });

  it('reads legacy unlinked loan payments but requires a source when they are resaved', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const accountId = store.getManagedRecords('profile-a').accounts[0]!.id;
    const timestamp = '2026-07-15T00:00:00.000Z';
    store.raw
      .prepare(
        `INSERT INTO forecast_events (
          id, user_id, account_id, date, kind, direction, amount_cents, certainty, status, label,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-unlinked-loan-payment',
        'profile-a',
        accountId,
        '2026-07-15',
        'loan-payment',
        'outflow',
        10_000,
        'confirmed',
        'paid',
        'Legacy loan payment',
        timestamp,
        timestamp,
      );

    const legacy = store
      .getManagedRecords('profile-a')
      .events.find((event) => event.id === 'legacy-unlinked-loan-payment');
    expect(legacy).toMatchObject({ kind: 'loan-payment', sourceRecordId: undefined });
    expect(() => store.upsertManagedEntity('profile-a', 'forecast-event', legacy!)).toThrow(
      /identify the installment loan/i,
    );
  });

  it('backs up an existing database before applying recovery-safe migrations', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-migration-test-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'balance-book.sqlite');
    const backupDirectory = path.join(directory, 'backups');
    const database = new BetterSqlite3(databasePath);
    database.pragma('journal_mode = WAL');
    database.pragma('wal_autocheckpoint = 0');
    database.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY NOT NULL,
        theme_preference TEXT NOT NULL DEFAULT 'system'
      );
      CREATE TABLE cash_accounts (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE forecast_events (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE credit_cards (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE credit_card_cycles (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE loans (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE receivables (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE saved_scenarios (
        id TEXT PRIMARY KEY NOT NULL,
        settlement_date TEXT,
        account_id TEXT
      );
      INSERT INTO forecast_events (id) VALUES ('legacy-forecast-event');
      INSERT INTO cash_accounts (id) VALUES ('legacy-cash-account');
      INSERT INTO saved_scenarios (id, settlement_date, account_id)
      VALUES ('legacy-cash-scenario', '2026-03-01', 'legacy-account');
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (5, 'card-payment-and-promotion-terms', '2026-01-01T00:00:00.000Z');
    `);
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.prepare("INSERT INTO forecast_events (id) VALUES ('committed-only-in-wal')").run();
    applyMigrations({ database, databasePath, backupDirectory });
    const version = database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as {
      version: number;
    };
    expect(version.version).toBe(latestSchemaVersion);
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('credit_cards') WHERE name = 'payment_day_of_month'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('receivables') WHERE name = 'recurrence_json'")
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('cash_accounts') WHERE name = 'available_balance_cents'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('cash_accounts') WHERE name = 'show_on_overview'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare('SELECT show_on_overview AS showOnOverview FROM cash_accounts WHERE id = ?')
        .get('legacy-cash-account'),
    ).toEqual({ showOnOverview: 1 });
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('loans') WHERE name = 'original_principal_cents'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('forecast_events') WHERE name = 'card_activity_treatment'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare(
          "SELECT card_activity_treatment AS treatment FROM forecast_events WHERE id = 'legacy-forecast-event'",
        )
        .get(),
    ).toEqual({ treatment: 'additional' });
    for (const column of ['income_type', 'parent_income_event_id', 'notes']) {
      expect(
        database
          .prepare("SELECT name FROM pragma_table_info('forecast_events') WHERE name = ?")
          .get(column),
      ).toBeTruthy();
    }
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('forecast_events') WHERE name = 'income_allocation_order'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare(
          "SELECT income_allocation_order AS allocationOrder FROM forecast_events WHERE id = 'legacy-forecast-event'",
        )
        .get(),
    ).toEqual({ allocationOrder: null });
    for (const column of ['funding_type', 'card_id', 'purchase_date']) {
      expect(
        database
          .prepare("SELECT name FROM pragma_table_info('saved_scenarios') WHERE name = ?")
          .get(column),
      ).toBeTruthy();
    }
    expect(
      database
        .prepare(
          "SELECT funding_type AS fundingType FROM saved_scenarios WHERE id = 'legacy-cash-scenario'",
        )
        .get(),
    ).toEqual({ fundingType: 'cash' });
    database.close();
    const backupNames = fs.readdirSync(backupDirectory);
    expect(backupNames).toHaveLength(1);
    const backup = new BetterSqlite3(path.join(backupDirectory, backupNames[0]!), {
      readonly: true,
    });
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      backup.prepare("SELECT id FROM forecast_events WHERE id = 'committed-only-in-wal'").get(),
    ).toEqual({ id: 'committed-only-in-wal' });
    expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: 5,
    });
    backup.close();
  });

  it('uses unique salted scrypt hashes and verifies a local password', async () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    const auth = new LocalAuthService(store);
    await auth.createPassword('profile-a', 'a-local-password');
    await auth.createPassword('profile-b', 'a-local-password');
    const first = store.getCredentialsById('profile-a')!;
    const second = store.getCredentialsById('profile-b')!;
    expect(first.passwordHash).not.toBe(second.passwordHash);
    expect(first.passwordSalt).not.toBe(second.passwordSalt);
    await expect(auth.login('profilea', 'wrong-password-value')).rejects.toThrow(/invalid/i);
    await expect(auth.login('profilea', 'a-local-password')).resolves.toMatchObject({
      id: 'profile-a',
    });
  });

  it('throttles repeated password failures at the configured boundary', async () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    const auth = new LocalAuthService(store);
    await auth.createPassword('profile-a', 'a-local-password');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(auth.login('profilea', 'wrong-password-value')).rejects.toThrow(/invalid/i);
    }
    await expect(auth.login('profilea', 'wrong-password-value')).rejects.toThrow(/too many/i);
    await expect(auth.login('profilea', 'a-local-password')).rejects.toThrow(/too many/i);
  });

  it('filters every financial read by the active user', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.saveVerticalSlice('profile-a', setup);
    store.saveVerticalSlice('profile-b', {
      ...setup,
      accountName: 'Other synthetic checking',
      openingBalanceCents: 900_000,
    });
    const first = store.getForecastData('profile-a')!;
    const second = store.getForecastData('profile-b')!;
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]?.userId).toBe('profile-a');
    expect(first.accounts[0]?.openingBalanceCents).toBe(100_000);
    expect(first.events.every((event) => event.userId === 'profile-a')).toBe(true);
    expect(second.accounts[0]?.openingBalanceCents).toBe(900_000);
    expect(second.events.every((event) => event.userId === 'profile-b')).toBe(true);
  });

  it('creates a useful first forecast without inventing optional money records', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Only real account',
      openingBalanceCents: 12_345,
      hardFloorCents: 0,
    });

    const records = store.getManagedRecords('profile-a');
    expect(records.accounts).toHaveLength(1);
    expect(records.events).toHaveLength(0);
    expect(records.cards).toHaveLength(0);
    expect(records.cardCycles).toHaveLength(0);
    expect(store.getForecastData('profile-a')).toMatchObject({
      policy: { hardConsolidatedFloorCents: 0 },
    });
  });

  it('keeps onboarding income expected instead of guaranteeing it in conservative cash', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);

    expect(store.getManagedRecords('profile-a').events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'income', certainty: 'expected' }),
        expect.objectContaining({ kind: 'direct-commitment', certainty: 'confirmed' }),
      ]),
    );
  });

  it('refuses to rerun first setup over an established financial record set', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    expect(() =>
      store.saveVerticalSlice('profile-a', { ...setup, openingBalanceCents: 125_000 }),
    ).toThrow(/already complete/i);
    expect(store.getForecastData('profile-a')?.accounts[0]?.openingBalanceCents).toBe(100_000);
    const audits = store.raw
      .prepare('SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ?')
      .get('profile-a') as { count: number };
    expect(audits.count).toBe(1);
  });

  it('updates forecast guardrails without replacing financial records', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.updateCashFloorPolicy('profile-a', {
      hardConsolidatedFloorCents: 25_000,
      preferredConsolidatedFloorCents: 40_000,
      horizonDays: 180,
      includeConfirmedReceivablesConservatively: false,
    });
    const data = store.getForecastData('profile-a')!;
    expect(data.policy).toEqual({
      hardConsolidatedFloorCents: 25_000,
      preferredConsolidatedFloorCents: 40_000,
      horizonDays: 180,
      includeConfirmedReceivablesConservatively: false,
    });
    expect(data.accounts).toHaveLength(1);
    expect(data.events).toHaveLength(2);
    expect(store.getManagedRecords('profile-a').policy).toEqual(data.policy);
  });

  it('stores truthful onboarding card terms without inventing statement history', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);

    const records = store.getManagedRecords('profile-a');
    expect(records.cards).toHaveLength(1);
    expect(records.cards[0]).toMatchObject({
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 24,
      estimatePolicy: 'baseline-guardrail',
      paymentPolicy: 'full-statement',
    });
    expect(records.cardCycles).toHaveLength(0);
    expect(records.events.filter((event) => event.kind === 'card-payment')).toHaveLength(0);

    const materialized = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: setup.balanceAsOf,
      endDate: '2026-01-31',
    });
    expect(materialized.filter((event) => event.kind === 'card-payment')).toEqual([
      expect.objectContaining({
        sourceRecordId: 'generated-cycle-profile-a-card-1-2026-01',
        date: '2026-01-15',
        amountCents: setup.cardEstimateCents,
        certainty: 'expected',
        status: 'planned',
      }),
    ]);
  });

  it('stores an onboarding manual card without fabricating cycle timing', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', {
      balanceAsOf: '2026-01-01',
      accountName: 'Synthetic checking',
      openingBalanceCents: 100_000,
      cardName: 'Synthetic manual card',
      cardEstimateCents: 0,
      cardEstimatePolicy: 'actual-reset',
      cardPaymentPolicy: 'manual',
      hardFloorCents: 0,
    });

    const card = store.getManagedRecords('profile-a').cards[0]!;
    expect(card).toMatchObject({
      name: 'Synthetic manual card',
      paymentPolicy: 'manual',
    });
    expect(card.paymentDayOfMonth).toBeUndefined();
    expect(card.statementCloseDayOfMonth).toBeUndefined();
    expect(store.getManagedRecords('profile-a').cardCycles).toHaveLength(0);
    expect(
      store.raw
        .prepare('SELECT cycle_timing_complete FROM credit_cards WHERE id = ?')
        .get('profile-a-card-1'),
    ).toEqual({ cycle_timing_complete: 0 });
  });

  it('persists onboarding minimum and fixed card payment amounts', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-minimum', displayName: 'Minimum', username: 'minimum' },
      { id: 'profile-fixed', displayName: 'Fixed', username: 'fixed' },
    ]);
    const base = {
      balanceAsOf: '2026-01-01',
      accountName: 'Synthetic checking',
      openingBalanceCents: 100_000,
      cardEstimateCents: 10_000,
      cardPaymentDayOfMonth: 15,
      cardStatementCloseDayOfMonth: 25,
      cardEstimatePolicy: 'actual-reset' as const,
      hardFloorCents: 0,
    };
    store.saveVerticalSlice('profile-minimum', {
      ...base,
      cardName: 'Minimum card',
      cardPaymentPolicy: 'minimum',
      cardMinimumPaymentCents: 2_500,
    });
    store.saveVerticalSlice('profile-fixed', {
      ...base,
      cardName: 'Fixed card',
      cardPaymentPolicy: 'fixed',
      cardFixedPaymentCents: 7_500,
    });

    expect(store.getManagedRecords('profile-minimum').cards[0]).toMatchObject({
      paymentPolicy: 'minimum',
      minimumPaymentCents: 2_500,
      fixedPaymentCents: undefined,
    });
    expect(store.getManagedRecords('profile-fixed').cards[0]).toMatchObject({
      paymentPolicy: 'fixed',
      fixedPaymentCents: 7_500,
      minimumPaymentCents: undefined,
    });
  });

  it('persists complete-core records and round-trips an authenticated backup', async () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const accountId = 'profile-a-primary-cash';
    store.upsertManagedEntity('profile-a', 'asset', {
      id: 'asset-a',
      name: 'Synthetic investment',
      type: 'investment',
      valueCents: 500_000,
      valuationDate: '2026-01-01',
      includedInNetWorth: true,
      includedInLiquidity: false,
    });
    store.upsertManagedEntity('profile-a', 'loan', {
      id: 'loan-a',
      name: 'Synthetic loan',
      principalCents: 100_000,
      accruedInterestCents: 1_000,
      balanceDate: '2026-01-01',
      annualRateBasisPoints: 500,
      accrualConvention: 'actual-365',
      paymentCents: 10_000,
      nextPaymentDate: '2026-01-15',
      fundingAccountId: accountId,
      excludeFromEconomicNetWorthDoubleCount: false,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'receivable-a',
      source: 'Synthetic source',
      description: 'Synthetic receivable',
      originalAmountCents: 20_000,
      remainingAmountCents: 15_000,
      expectedDate: '2026-01-20',
      destinationAccountId: accountId,
      certainty: 'expected',
    });
    const records = store.getManagedRecords('profile-a');
    expect(records.assets).toHaveLength(1);
    expect(records.loans).toHaveLength(1);
    expect(records.receivables[0]?.remainingAmountCents).toBe(15_000);

    const exported = store.exportPortableProfile('profile-a', '1.0.0-test');
    const encrypted = await createEncryptedBackup(exported, 'synthetic-backup-password');
    expect(encrypted).not.toContain('Synthetic investment');
    await expect(decryptBackup(encrypted, 'incorrect-backup-password')).rejects.toThrow(
      /incorrect|damaged/i,
    );
    const restored = await decryptBackup(encrypted, 'synthetic-backup-password');
    expect(restored.format).toBe('balance-book-portable-profile');
    if (restored.format !== 'balance-book-portable-profile') {
      throw new Error('Expected a portable profile backup');
    }
    expect(restored.assets[0]?.valueCents).toBe(500_000);

    store.deleteManagedEntity('profile-a', 'asset', 'asset-a');
    expect(store.getManagedRecords('profile-a').assets).toHaveLength(0);
    store.replacePortableProfile('profile-a', restored);
    expect(store.getManagedRecords('profile-a').assets[0]?.id).toBe('asset-a');
  });

  it('restores a full portable profile into an independent fresh login', async () => {
    const source = openStore();
    source.initializeProfiles([
      { id: 'source-profile', displayName: 'Source Profile', username: 'source' },
    ]);
    const sourceAuth = new LocalAuthService(source);
    await sourceAuth.createPassword('source-profile', 'source-login-password');
    source.saveVerticalSlice('source-profile', setup);
    source.setTheme('source-profile', 'light');
    source.saveOnboardingDraft('source-profile', { reviewStep: 'cards' });
    const sourceRecords = source.getManagedRecords('source-profile');
    const primaryAccount = sourceRecords.accounts[0]!;
    const card = sourceRecords.cards[0]!;
    source.upsertManagedEntity('source-profile', 'cash-account', {
      id: 'source-reserve',
      name: 'Synthetic reserve',
      type: 'savings',
      openingBalanceCents: 75_000,
      balanceAsOf: '2026-01-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 2,
    });
    source.createInternalTransfer({
      userId: 'source-profile',
      sourceAccountId: 'source-reserve',
      destinationAccountId: primaryAccount.id,
      amountCents: 12_345,
      initiationDate: '2026-01-03',
      arrivalDate: '2026-01-05',
      label: 'Synthetic paired transfer',
      status: 'scheduled',
    });
    source.upsertManagedEntity('source-profile', 'forecast-event', {
      id: 'source-card-activity',
      accountId: primaryAccount.id,
      date: '2026-01-06',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 4_321,
      certainty: 'confirmed',
      status: 'planned',
      label: 'Synthetic card activity',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'credit-card',
      cardId: card.id,
      cardActivityTreatment: 'additional',
    });
    source.upsertManagedEntity('source-profile', 'receivable', {
      id: 'source-receivable',
      source: 'Synthetic source',
      description: 'Synthetic portable receivable',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-01-02',
      destinationAccountId: primaryAccount.id,
      certainty: 'confirmed',
    });
    source.recordReceivableSettlement({
      userId: 'source-profile',
      receivableId: 'source-receivable',
      amountCents: 2_500,
      date: '2026-01-02',
      asOfDate: '2026-01-02',
    });
    source.raw
      .prepare(
        `INSERT INTO import_batches (id, user_id, workbook_checksum, source_file_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'source-batch',
        'source-profile',
        'synthetic-checksum',
        'synthetic.xlsx',
        'applied',
        '2026-01-01T00:00:00.000Z',
      );
    source.raw
      .prepare(
        `INSERT INTO import_lineage
         (id, user_id, batch_id, entity_type, entity_id, field, source_sheet, source_range,
          raw_value_json, parsed_value_json, transformation, confidence, warning,
          source_checksum, destination_value_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'source-lineage',
        'source-profile',
        'source-batch',
        'cash-account',
        primaryAccount.id,
        'openingBalanceCents',
        'Synthetic',
        'A1',
        '100000',
        '100000',
        'synthetic parse',
        'high',
        null,
        'synthetic-checksum',
        '100000',
        '2026-01-01T00:00:00.000Z',
      );

    const portable = source.exportPortableProfile('source-profile', '1.0.0-test');
    const sourceCredential = source.getCredentialsById('source-profile')!;
    expect(JSON.stringify(portable)).not.toContain(sourceCredential.passwordHash);
    expect(JSON.stringify(portable)).not.toContain(sourceCredential.passwordSalt);
    expect(portable.importBatches).toHaveLength(1);
    expect(portable.importLineage).toHaveLength(1);
    expect(portable.events.some((event) => event.paymentMethod === 'credit-card')).toBe(true);
    expect(portable.events.filter((event) => event.transferId)).toHaveLength(2);

    const backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-portable-test-'));
    temporaryDirectories.push(backupDirectory);
    const backupPath = path.join(backupDirectory, 'profile.balancebook-backup');
    await writeEncryptedBackup(backupPath, portable, 'independent-backup-password');
    await expect(readEncryptedBackup(backupPath, 'wrong-backup-password')).rejects.toThrow(
      /incorrect|damaged/i,
    );

    const destinationDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'balance-book-portable-destination-'),
    );
    temporaryDirectories.push(destinationDirectory);
    const destinationPath = path.join(destinationDirectory, 'balance-book.sqlite');
    const destination = new BalanceBookStore({
      databasePath: destinationPath,
      backupDirectory: path.join(destinationDirectory, 'backups'),
    });
    stores.push(destination);
    destination.initializeProfiles([
      { id: 'destination-profile', displayName: 'Destination', username: 'destination' },
    ]);
    const destinationAuth = new LocalAuthService(destination);
    await destinationAuth.createPassword('destination-profile', 'destination-login-password');
    const credentialsBefore = destination.getCredentialsById('destination-profile')!;
    const decrypted = await readEncryptedBackup(backupPath, 'independent-backup-password');
    if (decrypted.format !== 'balance-book-portable-profile') {
      throw new Error('Expected a portable profile backup');
    }
    destination.replacePortableProfile('destination-profile', decrypted);
    const credentialsAfter = destination.getCredentialsById('destination-profile')!;
    expect(credentialsAfter.passwordHash).toBe(credentialsBefore.passwordHash);
    expect(credentialsAfter.passwordSalt).toBe(credentialsBefore.passwordSalt);
    expect(credentialsAfter.themePreference).toBe('light');
    await expect(
      destinationAuth.login('destination', 'destination-login-password'),
    ).resolves.toMatchObject({ id: 'destination-profile' });
    expect(destination.getImportReview('destination-profile').batches).toHaveLength(1);
    expect(destination.getImportReview('destination-profile').fields).toHaveLength(1);
    expect(
      destination.raw
        .prepare('SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ?')
        .get('destination-profile'),
    ).toEqual({ count: portable.auditEvents.length + 1 });
    expect(destination.raw.pragma('integrity_check', { simple: true })).toBe('ok');

    const normalizeUser = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value), (key, item: unknown) =>
        key === 'userId' ? 'portable-user' : item,
      );
    expect(normalizeUser(destination.getManagedRecords('destination-profile'))).toEqual(
      normalizeUser(source.getManagedRecords('source-profile')),
    );

    destination.close();
    const restarted = new BalanceBookStore({
      databasePath: destinationPath,
      backupDirectory: path.join(destinationDirectory, 'backups'),
    });
    stores.push(restarted);
    const restartedAuth = new LocalAuthService(restarted);
    await expect(
      restartedAuth.login('destination', 'destination-login-password'),
    ).resolves.toMatchObject({ id: 'destination-profile' });
    expect(normalizeUser(restarted.getManagedRecords('destination-profile'))).toEqual(
      normalizeUser(source.getManagedRecords('source-profile')),
    );
  });

  it('refuses parent deletion when it would erase linked financial history', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const records = store.getManagedRecords('profile-a');
    const accountId = records.accounts[0]!.id;
    const cardId = records.cards[0]!.id;
    store.upsertManagedEntity('profile-a', 'card-cycle', {
      id: 'protected-cycle',
      cardId,
      opensOn: '2025-12-01',
      closesOn: '2025-12-31',
      dueOn: '2026-01-15',
      state: 'closed-statement',
      defaultEstimateCents: 20_000,
      actualActivityCents: 20_000,
      plannedActivityCents: 0,
      lockedStatementCents: 20_000,
    });

    expect(() => store.deleteManagedEntity('profile-a', 'credit-card', cardId)).toThrow(
      /linked statement history/i,
    );
    expect(() => store.deleteManagedEntity('profile-a', 'cash-account', accountId)).toThrow(
      /linked events, cards, loans/i,
    );
    const after = store.getManagedRecords('profile-a');
    expect(after.cards.some((card) => card.id === cardId)).toBe(true);
    expect(after.cardCycles.some((cycle) => cycle.id === 'protected-cycle')).toBe(true);
    expect(after.accounts.some((account) => account.id === accountId)).toBe(true);
  });

  it('refuses to orphan recorded receivable settlements and allows deletion after history removal', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const accountId = store.getManagedRecords('profile-a').accounts[0]!.id;
    const receivableId = 'protected-receivable-history';
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: receivableId,
      source: 'Synthetic source',
      description: 'Synthetic protected receivable',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-01-20',
      destinationAccountId: accountId,
      certainty: 'confirmed',
    });
    const settlementId = store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId,
      amountCents: 2_500,
      date: '2026-01-20',
      asOfDate: '2026-01-20',
    });

    expect(() => store.deleteManagedEntity('profile-a', 'receivable', receivableId)).toThrow(
      /recorded receipts.*Delete those receipt records first.*portable backups/i,
    );
    const protectedRecords = store.getManagedRecords('profile-a');
    expect(protectedRecords.receivables).toContainEqual(
      expect.objectContaining({ id: receivableId }),
    );
    expect(protectedRecords.events).toContainEqual(
      expect.objectContaining({ id: settlementId, sourceRecordId: receivableId }),
    );

    store.deleteManagedEntity('profile-a', 'forecast-event', settlementId);
    store.deleteManagedEntity('profile-a', 'receivable', receivableId);
    const deletedRecords = store.getManagedRecords('profile-a');
    expect(deletedRecords.receivables.some((item) => item.id === receivableId)).toBe(false);
    expect(deletedRecords.events.some((item) => item.id === settlementId)).toBe(false);
  });

  it('rolls back a managed deletion when its audit entry cannot be written', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'asset', {
      id: 'rollback-asset',
      name: 'Synthetic rollback asset',
      type: 'other',
      valueCents: 25_000,
      valuationDate: '2026-01-01',
      includedInNetWorth: true,
      includedInLiquidity: false,
    });
    store.raw.exec(`
      CREATE TRIGGER reject_delete_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'delete'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic audit failure');
      END
    `);

    expect(() => store.deleteManagedEntity('profile-a', 'asset', 'rollback-asset')).toThrow(
      /synthetic audit failure/i,
    );
    expect(
      store.getManagedRecords('profile-a').assets.some((asset) => asset.id === 'rollback-asset'),
    ).toBe(true);
    const deleteAudits = store.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ? AND action = 'delete' AND entity_type = ? AND entity_id = ?",
      )
      .get('profile-a', 'asset', 'rollback-asset') as { count: number };
    expect(deleteAudits.count).toBe(0);
  });

  it('round-trips native recurrence, card payment timing, and loan schedule controls', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const accountId = 'profile-a-primary-cash';
    const cardId = 'profile-a-card-1';
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      id: 'recurring-a',
      accountId,
      date: '2026-01-31',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 12_345,
      certainty: 'confirmed',
      status: 'planned',
      label: 'Recurring synthetic bill',
      hypothetical: false,
      accepted: false,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 31, interval: 1 },
      recurrenceEndDate: '2026-12-31',
      paymentMethod: 'credit-card',
      cardId,
    });
    store.upsertManagedEntity('profile-a', 'credit-card', {
      ...store.getForecastData('profile-a')!.cards[0],
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 20,
    });
    store.upsertManagedEntity('profile-a', 'card-cycle', {
      id: 'cycle-a',
      cardId,
      opensOn: '2025-12-21',
      closesOn: '2026-01-20',
      dueOn: '2026-02-15',
      paymentOn: '2026-02-13',
      state: 'scheduled-payment',
      defaultEstimateCents: 10_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 11_111,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'recurring-receivable-a',
      source: 'Synthetic source',
      description: 'Synthetic recurring receivable',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 27_413,
      expectedDate: '2026-02-28',
      destinationAccountId: accountId,
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      recurrenceEndDate: '2026-12-28',
      includeInCashForecast: true,
    });
    const records = store.getManagedRecords('profile-a');
    expect(records.events.find((event) => event.id === 'recurring-a')).toMatchObject({
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 31, interval: 1 },
      recurrenceEndDate: '2026-12-31',
      paymentMethod: 'credit-card',
      cardId,
    });
    expect(records.cards[0]).toMatchObject({ paymentDayOfMonth: 15, statementCloseDayOfMonth: 20 });
    expect(records.cardCycles.find((cycle) => cycle.id === 'cycle-a')?.paymentOn).toBe(
      '2026-02-13',
    );
    expect(records.receivables[0]).toMatchObject({
      recurringAmountCents: 27_413,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 28, interval: 1 },
      recurrenceEndDate: '2026-12-28',
      includeInCashForecast: true,
    });
  });

  it('preserves unknown card timing without exposing the database compatibility defaults', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const existing = store.getManagedRecords('profile-a').cards[0]!;

    store.upsertManagedEntity('profile-a', 'credit-card', {
      ...existing,
      name: 'Manual card with incomplete timing',
      paymentPolicy: 'manual',
      paymentDayOfMonth: undefined,
      statementCloseDayOfMonth: undefined,
    });

    const reloaded = store.getManagedRecords('profile-a').cards[0]!;
    expect(reloaded).toMatchObject({
      name: 'Manual card with incomplete timing',
      paymentPolicy: 'manual',
    });
    expect(reloaded.paymentDayOfMonth).toBeUndefined();
    expect(reloaded.statementCloseDayOfMonth).toBeUndefined();
    expect(
      store.raw
        .prepare(
          'SELECT payment_day_of_month, statement_close_day_of_month, cycle_timing_complete FROM credit_cards WHERE id = ?',
        )
        .get(existing.id),
    ).toEqual({
      payment_day_of_month: 1,
      statement_close_day_of_month: 1,
      cycle_timing_complete: 0,
    });
  });

  it('saves a card during staged import before the forecast policy exists', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.upsertManagedEntity('profile-a', 'cash-account', {
      id: 'staged-account',
      name: 'Staged checking',
      type: 'checking',
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-01-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 0,
    });
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        id: 'staged-event',
        accountId: 'staged-account',
        date: '2026-01-05',
        kind: 'direct-commitment',
        direction: 'outflow',
        amountCents: 1_000,
        certainty: 'confirmed',
        status: 'planned',
        label: 'Staged event',
      }),
    ).not.toThrow();

    expect(() =>
      store.upsertManagedEntity('profile-a', 'credit-card', {
        id: 'staged-card',
        name: 'Staged manual card',
        fundingAccountId: 'staged-account',
        defaultFutureStatementCents: 0,
        estimatePolicy: 'actual-reset',
        paymentPolicy: 'manual',
        paymentDayOfMonth: undefined,
        statementCloseDayOfMonth: undefined,
      }),
    ).not.toThrow();
    expect(
      store.raw
        .prepare('SELECT cycle_timing_complete FROM credit_cards WHERE id = ? AND user_id = ?')
        .get('staged-card', 'profile-a'),
    ).toEqual({ cycle_timing_complete: 0 });
    expect(() =>
      store.upsertManagedEntity('profile-a', 'card-cycle', {
        id: 'staged-cycle',
        cardId: 'staged-card',
        opensOn: '2026-01-01',
        closesOn: '2026-01-31',
        dueOn: '2026-02-15',
        state: 'future-estimated',
        defaultEstimateCents: 0,
        actualActivityCents: 0,
        plannedActivityCents: 0,
      }),
    ).not.toThrow();
    expect(
      store.raw
        .prepare('SELECT COUNT(*) AS count FROM credit_card_cycles WHERE id = ? AND user_id = ?')
        .get('staged-cycle', 'profile-a'),
    ).toEqual({ count: 1 });
  });

  it('rejects unresolved card payment terms and finalized cycles without statements', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const card = store.getManagedRecords('profile-a').cards[0]!;

    expect(() =>
      store.upsertManagedEntity('profile-a', 'credit-card', {
        ...card,
        paymentPolicy: 'minimum',
        minimumPaymentCents: undefined,
      }),
    ).toThrow(/minimum payment amount is required/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'credit-card', {
        ...card,
        paymentPolicy: 'fixed',
        fixedPaymentCents: 0,
      }),
    ).toThrow(/positive fixed payment amount is required/i);

    const cycle = {
      id: 'unresolved-cycle',
      cardId: card.id,
      opensOn: '2026-01-01',
      closesOn: '2026-01-31',
      dueOn: '2026-02-15',
      defaultEstimateCents: 20_000,
      actualActivityCents: 20_000,
      plannedActivityCents: 0,
    };
    for (const state of ['closed-statement', 'scheduled-payment'] as const) {
      expect(() =>
        store.upsertManagedEntity('profile-a', 'card-cycle', { ...cycle, state }),
      ).toThrow(/locked statement amount is required/i);
    }
  });

  it('clears account and policy guardrails when nullable values are omitted', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const account = store.getManagedRecords('profile-a').accounts[0]!;
    const accountInput = {
      id: account.id,
      name: account.name,
      type: account.type,
      openingBalanceCents: account.openingBalanceCents,
      balanceAsOf: account.balanceAsOf,
      includedInLiquidity: account.includedInLiquidity,
      canFundOtherAccounts: account.canFundOtherAccounts,
      transferDelayDays: account.transferDelayDays,
    };

    store.upsertManagedEntity('profile-a', 'cash-account', {
      ...accountInput,
      hardFloorCents: 15_000,
      preferredFloorCents: 25_000,
    });
    store.updateCashFloorPolicy('profile-a', {
      hardConsolidatedFloorCents: 15_000,
      preferredConsolidatedFloorCents: 25_000,
      horizonDays: 120,
      includeConfirmedReceivablesConservatively: false,
    });
    expect(store.getManagedRecords('profile-a').accounts[0]).toMatchObject({
      hardFloorCents: 15_000,
      preferredFloorCents: 25_000,
    });

    store.upsertManagedEntity('profile-a', 'cash-account', accountInput);
    store.updateCashFloorPolicy('profile-a', {
      hardConsolidatedFloorCents: 15_000,
      horizonDays: 120,
      includeConfirmedReceivablesConservatively: false,
    });
    const cleared = store.getManagedRecords('profile-a');
    expect(cleared.accounts[0]?.hardFloorCents).toBeUndefined();
    expect(cleared.accounts[0]?.preferredFloorCents).toBeUndefined();
    expect(cleared.policy?.preferredConsolidatedFloorCents).toBeUndefined();
  });

  it('round-trips typed income and linked raise metadata without crossing profiles', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.saveVerticalSlice('profile-a', setup);
    store.saveVerticalSlice('profile-b', setup);
    const base = store
      .getManagedRecords('profile-a')
      .events.find((item) => item.kind === 'income')!;
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      id: 'linked-raise',
      accountId: base.accountId,
      date: '2026-02-07',
      kind: 'income',
      direction: 'inflow',
      amountCents: 10_000,
      certainty: 'expected',
      status: 'planned',
      label: 'Projected raise',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'cash-account',
      recurrenceRule: { frequency: 'biweekly' },
      incomeType: 'raise-adjustment',
      parentIncomeEventId: base.id,
      notes: 'Synthetic raise note',
    });
    expect(
      store.getManagedRecords('profile-a').events.find((item) => item.id === 'linked-raise'),
    ).toMatchObject({
      incomeType: 'raise-adjustment',
      parentIncomeEventId: base.id,
      notes: 'Synthetic raise note',
    });
    expect(
      store.getManagedRecords('profile-b').events.some((item) => item.id === 'linked-raise'),
    ).toBe(false);
    const foreignBase = store
      .getManagedRecords('profile-b')
      .events.find((item) => item.kind === 'income')!;
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...store.getManagedRecords('profile-a').events.find((item) => item.id === 'linked-raise')!,
        parentIncomeEventId: foreignBase.id,
      }),
    ).toThrow(/not available to this profile/i);
  });

  it('saves a raise and bonus as one atomic income plan', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const base = store
      .getManagedRecords('profile-a')
      .events.find((item) => item.kind === 'income')!;
    const raise = {
      id: 'atomic-raise',
      accountId: base.accountId,
      date: '2026-02-07',
      kind: 'income' as const,
      direction: 'inflow' as const,
      amountCents: 10_000,
      certainty: 'expected' as const,
      status: 'planned' as const,
      label: 'Atomic raise',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'cash-account' as const,
      recurrenceRule: { frequency: 'biweekly' as const },
      incomeType: 'raise-adjustment' as const,
      parentIncomeEventId: base.id,
    };
    const bonus = {
      id: 'atomic-bonus',
      accountId: base.accountId,
      date: '2026-02-14',
      kind: 'income' as const,
      direction: 'inflow' as const,
      amountCents: 50_000,
      certainty: 'expected' as const,
      status: 'planned' as const,
      label: 'Atomic bonus',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'cash-account' as const,
      incomeType: 'bonus' as const,
    };

    expect(() =>
      store.upsertIncomePlan('profile-a', [raise, { ...bonus, accountId: 'missing-account' }]),
    ).toThrow(/not available to this profile/i);
    expect(
      store
        .getManagedRecords('profile-a')
        .events.some((item) => item.id === 'atomic-raise' || item.id === 'atomic-bonus'),
    ).toBe(false);

    expect(store.upsertIncomePlan('profile-a', [raise, bonus])).toEqual([
      'atomic-raise',
      'atomic-bonus',
    ]);
    expect(
      store
        .getManagedRecords('profile-a')
        .events.filter((item) => item.id === 'atomic-raise' || item.id === 'atomic-bonus'),
    ).toHaveLength(2);
  });

  it('enforces transfer delay and persists a recurring paired transfer schedule atomically', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const source = store.getManagedRecords('profile-a').accounts[0]!;
    store.upsertManagedEntity('profile-a', 'cash-account', {
      ...source,
      transferDelayDays: 2,
    });
    store.upsertManagedEntity('profile-a', 'cash-account', {
      ...source,
      id: 'destination-account',
      name: 'Destination',
      openingBalanceCents: 0,
      transferDelayDays: 0,
    });
    expect(() =>
      store.createInternalTransfer({
        userId: 'profile-a',
        sourceAccountId: source.id,
        destinationAccountId: 'destination-account',
        amountCents: 10_000,
        initiationDate: '2026-02-01',
        arrivalDate: '2026-02-02',
        label: 'Too-fast transfer',
      }),
    ).toThrow(/configured delay/i);

    const transferId = store.createInternalTransfer({
      userId: 'profile-a',
      sourceAccountId: source.id,
      destinationAccountId: 'destination-account',
      amountCents: 10_000,
      initiationDate: '2026-02-01',
      arrivalDate: '2026-02-03',
      label: 'Recurring reserve transfer',
      recurrenceRule: { frequency: 'weekly', interval: 1 },
      recurrenceEndDate: '2026-02-15',
      status: 'scheduled',
      notes: 'Synthetic transfer note',
    });
    const records = store.getManagedRecords('profile-a');
    const stored = records.events.filter((item) => item.transferId === transferId);
    expect(stored).toHaveLength(2);
    expect(stored.find((item) => item.kind === 'transfer-debit')).toMatchObject({
      recurrenceRule: { frequency: 'weekly', interval: 1 },
      recurrenceEndDate: '2026-02-15',
      status: 'scheduled',
      notes: 'Synthetic transfer note',
    });
    expect(stored.find((item) => item.kind === 'transfer-credit')?.recurrenceRule).toBeUndefined();
    const materialized = materializeForecastEvents({
      accounts: records.accounts,
      events: stored,
      cards: [],
      cardCycles: [],
      loans: [],
      startDate: '2026-02-01',
      endDate: '2026-02-17',
    });
    expect(materialized.filter((item) => item.kind === 'transfer-debit')).toHaveLength(3);
    expect(materialized.filter((item) => item.kind === 'transfer-credit')).toHaveLength(3);

    const debit = stored.find((item) => item.kind === 'transfer-debit')!;
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...debit,
      date: '2026-02-05',
      amountCents: 12_500,
      status: 'confirmed',
      certainty: 'expected',
      label: 'Updated reserve transfer',
      notes: 'Updated through either paired leg',
    });
    let updated = store
      .getManagedRecords('profile-a')
      .events.filter((item) => item.transferId === transferId);
    expect(updated).toHaveLength(2);
    expect(updated.find((item) => item.kind === 'transfer-debit')).toMatchObject({
      date: '2026-02-05',
      amountCents: 12_500,
      status: 'confirmed',
      certainty: 'confirmed',
      label: 'Updated reserve transfer',
      notes: 'Updated through either paired leg',
      recurrenceRule: { frequency: 'weekly', interval: 1 },
    });
    const updatedCredit = updated.find((item) => item.kind === 'transfer-credit')!;
    expect(updatedCredit).toMatchObject({
      date: '2026-02-07',
      amountCents: 12_500,
      status: 'confirmed',
      certainty: 'confirmed',
      label: 'Updated reserve transfer',
      notes: 'Updated through either paired leg',
    });
    expect(updatedCredit.recurrenceRule).toBeUndefined();

    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...updatedCredit,
      date: '2026-02-10',
    });
    updated = store
      .getManagedRecords('profile-a')
      .events.filter((item) => item.transferId === transferId);
    expect(updated.find((item) => item.kind === 'transfer-debit')?.date).toBe('2026-02-05');
    expect(updated.find((item) => item.kind === 'transfer-credit')?.date).toBe('2026-02-10');

    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...updated.find((item) => item.kind === 'transfer-debit')!,
        kind: 'direct-commitment',
      }),
    ).toThrow(/cannot change its financial role/i);
    expect(
      store.getManagedRecords('profile-a').events.filter((item) => item.transferId === transferId),
    ).toHaveLength(2);

    store.deleteManagedEntity('profile-a', 'forecast-event', updatedCredit.id);
    expect(
      store.getManagedRecords('profile-a').events.filter((item) => item.transferId === transferId),
    ).toHaveLength(0);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...debit,
        id: 'unpaired-transfer-leg',
        transferId: 'unpaired-transfer',
      }),
    ).toThrow(/paired internal-transfer planner/i);
  });

  it('rejects overlapping card cycles while allowing the next nonoverlapping statement period', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const cardId = store.getManagedRecords('profile-a').cards[0]!.id;
    store.upsertManagedEntity('profile-a', 'card-cycle', {
      id: 'cycle-one',
      cardId,
      opensOn: '2026-01-01',
      closesOn: '2026-01-24',
      dueOn: '2026-02-15',
      state: 'open',
      defaultEstimateCents: 20_000,
      actualActivityCents: 5_000,
      plannedActivityCents: 0,
    });
    expect(() =>
      store.upsertManagedEntity('profile-a', 'card-cycle', {
        id: 'cycle-overlap',
        cardId,
        opensOn: '2026-01-20',
        closesOn: '2026-02-24',
        dueOn: '2026-03-15',
        state: 'future-estimated',
        defaultEstimateCents: 20_000,
        actualActivityCents: 0,
        plannedActivityCents: 0,
      }),
    ).toThrow(/overlaps the existing/i);
    store.upsertManagedEntity('profile-a', 'card-cycle', {
      id: 'cycle-two',
      cardId,
      opensOn: '2026-01-25',
      closesOn: '2026-02-24',
      dueOn: '2026-03-15',
      state: 'future-estimated',
      defaultEstimateCents: 20_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });
    expect(store.getManagedRecords('profile-a').cardCycles).toHaveLength(2);
  });

  it('round-trips and explicitly clears typed onboarding metadata', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const initial = store.getManagedRecords('profile-a');
    const account = initial.accounts[0]!;
    const card = initial.cards[0]!;
    const expense = initial.events.find((event) => event.kind === 'direct-commitment')!;

    store.upsertManagedEntity('profile-a', 'cash-account', {
      ...account,
      availableBalanceCents: 95_000,
      notes: 'Synthetic available-balance note',
    });
    store.upsertManagedEntity('profile-a', 'credit-card', {
      ...card,
      issuer: 'Synthetic issuer',
      lastFour: '1234',
    });
    store.upsertManagedEntity('profile-a', 'loan', {
      id: 'loan-with-metadata',
      name: 'Synthetic loan',
      lender: 'Synthetic lender',
      loanType: 'Vehicle',
      principalCents: 500_000,
      accruedInterestCents: 1_000,
      balanceDate: '2026-01-01',
      annualRateBasisPoints: 625,
      accrualConvention: 'actual-365',
      paymentCents: 20_000,
      nextPaymentDate: '2026-02-01',
      maturityDate: '2028-12-01',
      originalPrincipalCents: 750_000,
      originalDate: '2025-01-01',
      fundingAccountId: account.id,
      paymentFrequency: 'monthly',
      includeInCashForecast: true,
      status: 'active',
    });
    store.upsertManagedEntity('profile-a', 'asset', {
      id: 'asset-with-metadata',
      name: 'Synthetic investment',
      type: 'investment',
      valueCents: 1_000_000,
      valuationDate: '2026-01-01',
      contributionAmountCents: 25_000,
      contributionRateBasisPoints: 600,
      employerMatchBasisPoints: 300,
      restrictionStatus: 'restricted',
      linkedLiabilityId: 'loan-with-metadata',
      includedInNetWorth: true,
      includedInLiquidity: false,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'receivable-with-metadata',
      source: 'Synthetic source',
      description: 'Synthetic shared purchase',
      originalAmountCents: 20_000,
      remainingAmountCents: 20_000,
      expectedDate: '2026-01-10',
      destinationAccountId: account.id,
      certainty: 'expected',
      relatedExpenseId: expense.id,
      paymentInstrument: `credit-card:${card.id}`,
    });

    const populated = store.getManagedRecords('profile-a');
    expect(populated.accounts[0]).toMatchObject({
      availableBalanceCents: 95_000,
      notes: 'Synthetic available-balance note',
    });
    expect(populated.cards[0]).toMatchObject({ issuer: 'Synthetic issuer', lastFour: '1234' });
    expect(populated.loans[0]).toMatchObject({
      lender: 'Synthetic lender',
      loanType: 'Vehicle',
      maturityDate: '2028-12-01',
      originalPrincipalCents: 750_000,
      originalDate: '2025-01-01',
    });
    expect(populated.assets[0]).toMatchObject({
      contributionAmountCents: 25_000,
      contributionRateBasisPoints: 600,
      employerMatchBasisPoints: 300,
      restrictionStatus: 'restricted',
      linkedLiabilityId: 'loan-with-metadata',
    });
    expect(populated.receivables[0]).toMatchObject({
      relatedExpenseId: expense.id,
      paymentInstrument: `credit-card:${card.id}`,
    });

    store.upsertManagedEntity('profile-a', 'cash-account', {
      ...populated.accounts[0]!,
      availableBalanceCents: undefined,
      notes: undefined,
    });
    store.upsertManagedEntity('profile-a', 'credit-card', {
      ...populated.cards[0]!,
      issuer: undefined,
      lastFour: undefined,
    });
    store.upsertManagedEntity('profile-a', 'loan', {
      ...populated.loans[0]!,
      lender: undefined,
      loanType: undefined,
      maturityDate: undefined,
      originalPrincipalCents: undefined,
      originalDate: undefined,
    });
    store.upsertManagedEntity('profile-a', 'asset', {
      ...populated.assets[0]!,
      contributionAmountCents: undefined,
      contributionRateBasisPoints: undefined,
      employerMatchBasisPoints: undefined,
      restrictionStatus: undefined,
      linkedLiabilityId: undefined,
    });
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...populated.receivables[0]!,
      relatedExpenseId: undefined,
      paymentInstrument: undefined,
    });

    const cleared = store.getManagedRecords('profile-a');
    expect(cleared.accounts[0]?.availableBalanceCents).toBeUndefined();
    expect(cleared.accounts[0]?.notes).toBeUndefined();
    expect(cleared.cards[0]?.issuer).toBeUndefined();
    expect(cleared.cards[0]?.lastFour).toBeUndefined();
    expect(cleared.loans[0]?.lender).toBeUndefined();
    expect(cleared.loans[0]?.originalPrincipalCents).toBeUndefined();
    expect(cleared.assets[0]?.linkedLiabilityId).toBeUndefined();
    expect(cleared.assets[0]?.contributionRateBasisPoints).toBeUndefined();
    expect(cleared.receivables[0]?.relatedExpenseId).toBeUndefined();
    expect(cleared.receivables[0]?.paymentInstrument).toBeUndefined();
  });

  it('clears card terms and cycle overrides while preserving omitted timing defaults', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const card = store.getManagedRecords('profile-a').cards[0]!;
    const cardInput = {
      id: card.id,
      name: card.name,
      fundingAccountId: card.fundingAccountId,
      defaultFutureStatementCents: card.defaultFutureStatementCents,
      estimatePolicy: card.estimatePolicy,
      paymentPolicy: 'full-statement' as const,
    };
    const cycleInput = {
      id: 'clearable-cycle',
      cardId: card.id,
      opensOn: '2026-01-01',
      closesOn: '2026-01-31',
      dueOn: '2026-02-15',
      state: 'open' as const,
      defaultEstimateCents: 20_000,
      actualActivityCents: 18_000,
      plannedActivityCents: 2_000,
    };

    store.upsertManagedEntity('profile-a', 'credit-card', {
      ...cardInput,
      paymentPolicy: 'fixed',
      fixedPaymentCents: 5_000,
      minimumPaymentCents: 2_500,
      aprBasisPoints: 2_499,
      promotionEndDate: '2026-12-31',
      paymentDayOfMonth: 21,
      statementCloseDayOfMonth: 10,
    });
    store.upsertManagedEntity('profile-a', 'card-cycle', {
      ...cycleInput,
      state: 'scheduled-payment',
      lockedStatementCents: 19_000,
      projectionOverrideCents: 17_500,
      paymentOn: '2026-02-13',
    });

    store.upsertManagedEntity('profile-a', 'credit-card', cardInput);
    store.upsertManagedEntity('profile-a', 'card-cycle', cycleInput);
    const records = store.getManagedRecords('profile-a');
    const clearedCard = records.cards.find((candidate) => candidate.id === card.id)!;
    const clearedCycle = records.cardCycles.find((candidate) => candidate.id === cycleInput.id)!;
    expect(clearedCard).toMatchObject({ paymentDayOfMonth: 21, statementCloseDayOfMonth: 10 });
    expect(clearedCard.fixedPaymentCents).toBeUndefined();
    expect(clearedCard.minimumPaymentCents).toBeUndefined();
    expect(clearedCard.aprBasisPoints).toBeUndefined();
    expect(clearedCard.promotionEndDate).toBeUndefined();
    expect(clearedCycle.lockedStatementCents).toBeUndefined();
    expect(clearedCycle.projectionOverrideCents).toBeUndefined();
    expect(clearedCycle.paymentOn).toBeUndefined();
  });

  it('clears event overrides without dropping omitted lineage fields', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const accountId = 'profile-a-primary-cash';
    const cardId = 'profile-a-card-1';
    const eventInput = {
      id: 'clearable-event',
      accountId,
      date: '2026-02-01',
      kind: 'direct-commitment' as const,
      direction: 'outflow' as const,
      amountCents: 12_345,
      certainty: 'expected' as const,
      status: 'planned' as const,
      label: 'Clearable event',
      hypothetical: false,
      accepted: false,
    };

    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...eventInput,
      manualOrder: 7,
      sourceRecordId: 'source-lineage',
      includeInConservative: false,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      recurrenceEndDate: '2026-12-01',
      paymentMethod: 'credit-card',
      cardId,
      cardActivityTreatment: 'included-in-cycle-total',
    });
    expect(
      store
        .getManagedRecords('profile-a')
        .events.find((candidate) => candidate.id === eventInput.id)?.cardActivityTreatment,
    ).toBe('included-in-cycle-total');
    store.upsertManagedEntity('profile-a', 'forecast-event', eventInput);

    const event = store
      .getManagedRecords('profile-a')
      .events.find((candidate) => candidate.id === eventInput.id)!;
    expect(event).toMatchObject({
      manualOrder: 7,
      sourceRecordId: 'source-lineage',
      paymentMethod: 'cash-account',
      cardActivityTreatment: 'additional',
    });
    expect(event.includeInConservative).toBeUndefined();
    expect(event.recurrenceRule).toBeUndefined();
    expect(event.recurrenceEndDate).toBeUndefined();
    expect(event.cardId).toBeUndefined();
  });

  it('clears receivable schedules, reward dates, and optional record notes', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const accountId = 'profile-a-primary-cash';
    const cardId = 'profile-a-card-1';
    const receivableInput = {
      id: 'clearable-receivable',
      source: 'Synthetic source',
      description: 'Clearable receivable',
      originalAmountCents: 30_000,
      remainingAmountCents: 20_000,
      expectedDate: '2026-03-01',
      destinationAccountId: accountId,
      certainty: 'expected' as const,
      settlementDateConfirmed: false,
      includeInCashForecast: true,
    };
    const rewardInput = {
      id: 'clearable-reward',
      cardId,
      rewardType: 'points' as const,
      baseRateBasisPoints: 300,
      annualFeeCents: 9_500,
      treatment: 'informational' as const,
    };
    const reconciliationInput = {
      id: 'clearable-reconciliation',
      accountId,
      date: '2026-01-31',
      forecastBalanceCents: 100_000,
      actualBalanceCents: 99_000,
      varianceCents: -1_000,
      resolution: 'explained' as const,
    };
    const scenarioInput = {
      id: 'clearable-scenario',
      description: 'Clearable scenario',
      amountCents: 10_000,
      settlementDate: '2026-04-01',
      accountId,
      status: 'saved' as const,
    };

    store.upsertManagedEntity('profile-a', 'receivable', {
      ...receivableInput,
      grossExpenseCents: 40_000,
      userEconomicShareCents: 10_000,
      recurringAmountCents: 2_000,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      recurrenceEndDate: '2026-12-01',
      accrualAmountCents: 500,
      accrualDate: '2026-02-01',
      accrualRecurrenceRule: { frequency: 'weekly', interval: 2 },
      notes: 'Temporary receivable note',
    });
    store.upsertManagedEntity('profile-a', 'reward-program', {
      ...rewardInput,
      pointValueMicros: 10_000,
      expectedReceiptDate: '2026-05-01',
    });
    store.upsertManagedEntity('profile-a', 'reconciliation', {
      ...reconciliationInput,
      note: 'Temporary reconciliation note',
    });
    store.upsertManagedEntity('profile-a', 'saved-scenario', {
      ...scenarioInput,
      notes: 'Temporary scenario note',
    });

    store.upsertManagedEntity('profile-a', 'receivable', receivableInput);
    store.upsertManagedEntity('profile-a', 'reward-program', rewardInput);
    store.upsertManagedEntity('profile-a', 'reconciliation', reconciliationInput);
    store.upsertManagedEntity('profile-a', 'saved-scenario', scenarioInput);
    const records = store.getManagedRecords('profile-a');
    const receivable = records.receivables.find(
      (candidate) => candidate.id === receivableInput.id,
    )!;
    expect(receivable.grossExpenseCents).toBeUndefined();
    expect(receivable.userEconomicShareCents).toBeUndefined();
    expect(receivable.recurringAmountCents).toBeUndefined();
    expect(receivable.recurrenceRule).toBeUndefined();
    expect(receivable.recurrenceEndDate).toBeUndefined();
    expect(receivable.accrualAmountCents).toBeUndefined();
    expect(receivable.accrualDate).toBeUndefined();
    expect(receivable.accrualRecurrenceRule).toBeUndefined();
    expect(receivable.notes).toBeUndefined();
    const reward = records.rewardPrograms.find((candidate) => candidate.id === rewardInput.id)!;
    expect(reward.pointValueMicros).toBeUndefined();
    expect(reward.expectedReceiptDate).toBeUndefined();
    expect(
      records.reconciliations.find((candidate) => candidate.id === reconciliationInput.id)?.note,
    ).toBeUndefined();
    expect(
      records.savedScenarios.find((candidate) => candidate.id === scenarioInput.id)?.notes,
    ).toBeUndefined();
  });

  it('converts a saved scenario into a commitment atomically', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'saved-scenario', {
      id: 'scenario-a',
      description: 'Synthetic purchase',
      amountCents: 12_345,
      settlementDate: '2026-02-01',
      accountId: 'profile-a-primary-cash',
      status: 'accepted',
    });

    const eventId = store.convertScenarioToCommitment('profile-a', 'scenario-a');
    const records = store.getManagedRecords('profile-a');
    expect(records.savedScenarios[0]?.status).toBe('archived');
    expect(records.events).toContainEqual(
      expect.objectContaining({
        id: eventId,
        amountCents: 12_345,
        sourceRecordId: 'scenario-a',
        hypothetical: false,
        accepted: true,
      }),
    );
    expect(() => store.convertScenarioToCommitment('profile-a', 'scenario-a')).toThrow(
      /not found/i,
    );
  });

  it('persists and converts a saved card scenario as purchase-date card activity', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'saved-scenario', {
      id: 'card-scenario-a',
      description: 'Synthetic card purchase',
      amountCents: 30_000,
      purchaseDate: '2026-01-20',
      settlementDate: '2026-02-15',
      accountId: 'profile-a-primary-cash',
      fundingType: 'card',
      cardId: 'profile-a-card-1',
      status: 'accepted',
    });

    const saved = store.getManagedRecords('profile-a').savedScenarios[0]!;
    expect(saved).toMatchObject({
      fundingType: 'card',
      cardId: 'profile-a-card-1',
      purchaseDate: '2026-01-20',
      settlementDate: '2026-02-15',
    });

    const eventId = store.convertScenarioToCommitment('profile-a', saved.id);
    const records = store.getManagedRecords('profile-a');
    const purchase = records.events.find((event) => event.id === eventId)!;
    expect(purchase).toMatchObject({
      date: '2026-01-20',
      amountCents: 30_000,
      accountId: 'profile-a-primary-cash',
      paymentMethod: 'credit-card',
      cardId: 'profile-a-card-1',
      cardActivityTreatment: 'additional',
      hypothetical: false,
      accepted: true,
    });
    const materialized = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    });
    expect(materialized).not.toContainEqual(expect.objectContaining({ id: eventId }));
    expect(materialized).toContainEqual(
      expect.objectContaining({
        kind: 'card-payment',
        date: '2026-02-15',
        amountCents: 30_000,
      }),
    );
  });

  it('does not regenerate a recurring occurrence after an off-date full settlement', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const receivableId = 'recurring-settlement-test';
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: receivableId,
      source: 'Synthetic source',
      description: 'Recurring shared cost',
      originalAmountCents: 20_000,
      remainingAmountCents: 20_000,
      recurringAmountCents: 20_000,
      expectedDate: '2026-01-10',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 10, interval: 1 },
      includeInCashForecast: true,
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId,
      amountCents: 20_000,
      date: '2026-01-09',
      asOfDate: '2026-01-09',
    });
    const records = store.getManagedRecords('profile-a');
    const scheduled = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-01-02',
      endDate: '2026-02-28',
    });

    expect(
      scheduled
        .filter((event) => event.sourceRecordId === receivableId)
        .map((event) => [event.date, event.amountCents]),
    ).toEqual([
      ['2026-01-09', 20_000],
      ['2026-02-10', 20_000],
    ]);
  });

  it('keeps a static receivable balance synchronized when a settlement is edited or deleted', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'editable-static-receivable',
      source: 'Synthetic source',
      description: 'Editable shared cost',
      originalAmountCents: 20_000,
      remainingAmountCents: 20_000,
      expectedDate: '2026-01-10',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: true,
    });
    const eventId = store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'editable-static-receivable',
      amountCents: 5_000,
      date: '2026-01-05',
      asOfDate: '2026-01-05',
    });
    let records = store.getManagedRecords('profile-a');
    expect(
      records.receivables.find((receivable) => receivable.id === 'editable-static-receivable')
        ?.remainingAmountCents,
    ).toBe(15_000);

    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...records.events.find((event) => event.id === eventId)!,
      amountCents: 7_000,
    });
    records = store.getManagedRecords('profile-a');
    expect(
      records.receivables.find((receivable) => receivable.id === 'editable-static-receivable')
        ?.remainingAmountCents,
    ).toBe(13_000);

    store.deleteManagedEntity('profile-a', 'forecast-event', eventId);
    records = store.getManagedRecords('profile-a');
    expect(
      records.receivables.find((receivable) => receivable.id === 'editable-static-receivable')
        ?.remainingAmountCents,
    ).toBe(20_000);
    expect(records.events.some((event) => event.id === eventId)).toBe(false);
  });

  it('rejects generic receivable-settlement creation and cloned settlement IDs', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'protected-receivable',
      source: 'Synthetic source',
      description: 'Protected balance',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-01-10',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      includeInCashForecast: true,
    });

    const genericSettlement = {
      id: 'generic-receivable-settlement',
      accountId: 'profile-a-primary-cash',
      date: '2026-01-05',
      kind: 'receivable-settlement' as const,
      direction: 'inflow' as const,
      amountCents: 4_000,
      certainty: 'confirmed' as const,
      status: 'confirmed' as const,
      label: 'Generic received cash',
      sourceRecordId: 'protected-receivable',
      paymentMethod: 'cash-account' as const,
    };
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', genericSettlement),
    ).toThrow(/Money Owed.*cannot be created as generic forecast events/i);

    const eventId = store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'protected-receivable',
      amountCents: 4_000,
      date: '2026-01-05',
      asOfDate: '2026-01-05',
    });
    const event = store
      .getManagedRecords('profile-a')
      .events.find((candidate) => candidate.id === eventId)!;
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...event,
        id: 'cloned-receivable-settlement',
      }),
    ).toThrow(/Money Owed.*cannot be created as generic forecast events/i);

    const records = store.getManagedRecords('profile-a');
    expect(
      records.events.filter((candidate) => candidate.kind === 'receivable-settlement'),
    ).toEqual([expect.objectContaining({ id: eventId, sourceRecordId: 'protected-receivable' })]);
    expect(records.receivables[0]?.remainingAmountCents).toBe(6_000);
  });

  it('locks a static settlement association while allowing a valid receipt correction', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    store.upsertManagedEntity('profile-a', 'cash-account', {
      id: 'profile-a-reserve-cash',
      name: 'Synthetic reserve',
      type: 'savings',
      openingBalanceCents: 50_000,
      balanceAsOf: '2026-01-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 0,
    });
    for (const id of ['source-receivable-a', 'source-receivable-b']) {
      store.upsertManagedEntity('profile-a', 'receivable', {
        id,
        source: 'Synthetic source',
        description: id,
        originalAmountCents: 10_000,
        remainingAmountCents: 10_000,
        expectedDate: '2026-01-10',
        destinationAccountId: 'profile-a-primary-cash',
        certainty: 'expected',
        includeInCashForecast: true,
      });
    }
    const eventId = store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'source-receivable-a',
      amountCents: 4_000,
      date: '2026-01-05',
      asOfDate: '2026-01-05',
    });
    const event = store
      .getManagedRecords('profile-a')
      .events.find((candidate) => candidate.id === eventId)!;

    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...event,
        sourceRecordId: 'source-receivable-b',
      }),
    ).toThrow(/cannot be reassigned to a different balance/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...event,
        kind: 'manual-adjustment',
      }),
    ).toThrow(/must remain linked to Money Owed/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...event,
        receivableOccurrenceDate: '2026-01-10',
      }),
    ).toThrow(/targeted receivable receipt cannot be reassigned/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...event,
        receivableOccurrenceTargetCents: 10_000,
      }),
    ).toThrow(/occurrence target requires an occurrence date/i);

    let records = store.getManagedRecords('profile-a');
    const receivableA = records.receivables.find(
      (receivable) => receivable.id === 'source-receivable-a',
    )!;
    store.upsertManagedEntity('profile-a', 'receivable', {
      ...receivableA,
      userId: undefined,
      destinationAccountId: 'profile-a-reserve-cash',
    });
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...event,
      accountId: 'profile-a-reserve-cash',
      date: '2026-01-06',
      amountCents: 5_000,
      label: 'Corrected received cash',
    });
    records = store.getManagedRecords('profile-a');
    expect(
      Object.fromEntries(
        records.receivables
          .filter((receivable) => receivable.id.startsWith('source-receivable-'))
          .map((receivable) => [receivable.id, receivable.remainingAmountCents]),
      ),
    ).toEqual({ 'source-receivable-a': 5_000, 'source-receivable-b': 10_000 });
    expect(records.events.find((candidate) => candidate.id === eventId)).toMatchObject({
      accountId: 'profile-a-reserve-cash',
      date: '2026-01-06',
      amountCents: 5_000,
      label: 'Corrected received cash',
      kind: 'receivable-settlement',
      sourceRecordId: 'source-receivable-a',
    });
  });

  it('rolls back invalid and cross-profile settlement edits without changing either record', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.saveVerticalSlice('profile-a', setup);
    store.saveVerticalSlice('profile-b', { ...setup, accountName: 'Other checking' });
    for (const profileId of ['profile-a', 'profile-b']) {
      store.upsertManagedEntity(profileId, 'receivable', {
        id: `${profileId}-private-receivable`,
        source: 'Synthetic source',
        description: 'Private shared cost',
        originalAmountCents: 10_000,
        remainingAmountCents: 10_000,
        expectedDate: '2026-01-10',
        destinationAccountId: `${profileId}-primary-cash`,
        certainty: 'expected',
        includeInCashForecast: true,
      });
    }
    const eventId = store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'profile-a-private-receivable',
      amountCents: 3_000,
      date: '2026-01-05',
      asOfDate: '2026-01-05',
    });
    const originalEvent = store
      .getManagedRecords('profile-a')
      .events.find((event) => event.id === eventId)!;

    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...originalEvent,
        sourceRecordId: 'profile-b-private-receivable',
      }),
    ).toThrow(/cannot be reassigned to a different balance/i);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...originalEvent,
        amountCents: 11_000,
      }),
    ).toThrow(/exceeds the open static receivable balance/i);

    expect(
      store
        .getManagedRecords('profile-a')
        .receivables.find((receivable) => receivable.id === 'profile-a-private-receivable')
        ?.remainingAmountCents,
    ).toBe(7_000);
    expect(
      store.getManagedRecords('profile-a').events.find((event) => event.id === eventId),
    ).toMatchObject({ amountCents: 3_000, sourceRecordId: 'profile-a-private-receivable' });
    expect(
      store
        .getManagedRecords('profile-b')
        .receivables.find((receivable) => receivable.id === 'profile-b-private-receivable')
        ?.remainingAmountCents,
    ).toBe(10_000);
  });

  it('edits and cancels a later recurring settlement without touching the static anchor balance', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'profile-a', displayName: 'Profile A', username: 'profilea' }]);
    store.saveVerticalSlice('profile-a', setup);
    const receivableId = 'editable-recurring-receivable';
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: receivableId,
      source: 'Synthetic source',
      description: 'Recurring shared cost',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-01-10',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 10, interval: 1 },
      includeInCashForecast: true,
    });
    const eventId = store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId,
      amountCents: 4_000,
      date: '2026-02-12',
      asOfDate: '2026-02-12',
      occurrenceDate: '2026-02-10',
    });
    const event = store
      .getManagedRecords('profile-a')
      .events.find((candidate) => candidate.id === eventId)!;
    store.upsertManagedEntity('profile-a', 'forecast-event', { ...event, amountCents: 6_000 });
    expect(
      store
        .getManagedRecords('profile-a')
        .receivables.find((receivable) => receivable.id === receivableId)?.remainingAmountCents,
    ).toBe(0);
    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', { ...event, amountCents: 10_001 }),
    ).toThrow(/open recurring occurrence amount/i);

    const editedEvent = store
      .getManagedRecords('profile-a')
      .events.find((candidate) => candidate.id === eventId)!;
    store.upsertManagedEntity('profile-a', 'forecast-event', {
      ...editedEvent,
      status: 'cancelled',
    });
    const records = store.getManagedRecords('profile-a');
    const scheduled = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: records.cards,
      cardCycles: records.cardCycles,
      loans: records.loans,
      receivables: records.receivables,
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    expect(scheduled).toContainEqual(
      expect.objectContaining({
        sourceRecordId: receivableId,
        date: '2026-02-10',
        amountCents: 10_000,
      }),
    );
  });

  it('persists setup drafts, paired transfers, partial settlements, and a user-scoped reset', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profilea' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profileb' },
    ]);
    store.saveVerticalSlice('profile-a', setup);
    store.saveVerticalSlice('profile-b', { ...setup, accountName: 'Other checking' });
    store.saveOnboardingDraft('profile-a', { accountName: 'Draft checking' });
    expect(store.getOnboardingDraft('profile-a')?.values.accountName).toBe('Draft checking');
    store.upsertManagedEntity('profile-a', 'cash-account', {
      id: 'profile-a-savings',
      name: 'Synthetic savings',
      type: 'savings',
      openingBalanceCents: 50_000,
      balanceAsOf: '2026-01-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 2,
    });
    const transferId = store.createInternalTransfer({
      userId: 'profile-a',
      sourceAccountId: 'profile-a-primary-cash',
      destinationAccountId: 'profile-a-savings',
      amountCents: 10_000,
      initiationDate: '2026-01-02',
      arrivalDate: '2026-01-04',
      label: 'Synthetic transfer',
    });
    expect(
      store
        .getManagedRecords('profile-a')
        .events.filter((event) => event.transferId === transferId),
    ).toHaveLength(2);
    store.upsertManagedEntity('profile-a', 'receivable', {
      id: 'receivable-settlement-test',
      source: 'Synthetic source',
      description: 'Shared cost',
      originalAmountCents: 20_000,
      remainingAmountCents: 20_000,
      expectedDate: '2026-01-10',
      destinationAccountId: 'profile-a-primary-cash',
      certainty: 'expected',
    });
    store.recordReceivableSettlement({
      userId: 'profile-a',
      receivableId: 'receivable-settlement-test',
      amountCents: 5_000,
      date: '2026-01-05',
      asOfDate: '2026-01-05',
    });
    const beforeReset = store.getManagedRecords('profile-a');
    expect(beforeReset.receivables[0]?.remainingAmountCents).toBe(15_000);
    expect(beforeReset.events).toContainEqual(
      expect.objectContaining({ kind: 'receivable-settlement', amountCents: 5_000 }),
    );

    store.resetUserData('profile-a');
    expect(store.getManagedRecords('profile-a').accounts).toHaveLength(0);
    expect(store.getOnboardingDraft('profile-a')).toBeNull();
    expect(store.getManagedRecords('profile-b').accounts).toHaveLength(1);
  });
});
