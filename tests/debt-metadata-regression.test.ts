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
  latestSchemaVersion,
} from '@balance-book/database';
import {
  cashAccountSchema,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  loanSchema,
} from '@balance-book/domain';
import {
  calculateCardSpendingPower,
  calculateNetWorth,
  materializeForecastEvents,
  projectCardDebtSchedule,
  projectLoanPayoffAtDate,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const makeTemporaryDirectory = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const openStore = (prefix = 'balance-book-debt-metadata-'): BalanceBookStore => {
  const directory = makeTemporaryDirectory(prefix);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'migration-backups'),
  });
  stores.push(store);
  return store;
};

const initializeProfile = (store: BalanceBookStore, id: string): string => {
  store.initializeProfiles([{ id, displayName: `Profile ${id}`, username: `user-${id}` }]);
  const accountId = `${id}-checking`;
  store.upsertManagedEntity(id, 'cash-account', {
    id: accountId,
    name: 'Synthetic checking',
    type: 'checking',
    openingBalanceCents: 250_000,
    balanceAsOf: '2026-06-30',
    includedInLiquidity: true,
    canFundOtherAccounts: true,
    transferDelayDays: 0,
  });
  store.updateCashFloorPolicy(id, {
    hardConsolidatedFloorCents: 0,
    horizonDays: 120,
    includeConfirmedReceivablesConservatively: true,
  });
  return accountId;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.raw.open) store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('debt metadata persistence', () => {
  it('round-trips card and loan debt metadata without crossing profile boundaries or portable backup restores', async () => {
    const source = openStore();
    const accountId = initializeProfile(source, 'profile-a');
    initializeProfile(source, 'profile-b');

    source.upsertManagedEntity('profile-a', 'credit-card', {
      id: 'debt-card',
      name: 'Synthetic revolving line',
      issuer: 'Synthetic issuer',
      fundingAccountId: accountId,
      accountKind: 'line-of-credit',
      creditLimitCents: 1_500_000,
      reportedBalanceCents: 84_321,
      reportedBalanceDate: '2026-07-15',
      reportedCarryingBalanceCents: 12_345,
      reportedCarryingBalanceDate: '2026-07-15',
      defaultFutureStatementCents: 20_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'minimum',
      minimumPaymentCents: 5_000,
      aprBasisPoints: 1_999,
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 20,
    });
    source.upsertManagedEntity('profile-a', 'card-cycle', {
      id: 'debt-cycle',
      cardId: 'debt-card',
      opensOn: '2026-06-21',
      closesOn: '2026-07-20',
      dueOn: '2026-08-15',
      state: 'paid',
      defaultEstimateCents: 20_000,
      actualActivityCents: 18_765,
      plannedActivityCents: 0,
      lockedStatementCents: 18_765,
      paymentOn: '2026-08-14',
      actualPaymentCents: 6_420,
    });
    source.upsertManagedEntity('profile-a', 'loan', {
      id: 'debt-loan',
      name: 'Synthetic installment loan',
      lender: 'Synthetic lender',
      loanType: 'secured installment',
      principalCents: 875_000,
      accruedInterestCents: 1_234,
      balanceDate: '2026-07-15',
      annualRateBasisPoints: 675,
      accrualConvention: 'actual-365',
      paymentCents: 25_000,
      cashPaymentCents: 31_500,
      nextPaymentDate: '2026-08-01',
      maturityDate: '2029-07-01',
      originalPrincipalCents: 1_000_000,
      originalDate: '2025-08-01',
      originalTermMonths: 48,
      amortizationStructure: 'balloon',
      expectedBalloonCents: 123_456,
      inferredFields: ['originalDate', 'originalTermMonths', 'expectedBalloonCents'],
      fundingAccountId: accountId,
      excludeFromEconomicNetWorthDoubleCount: false,
      paymentFrequency: 'monthly',
      includeInCashForecast: true,
      status: 'active',
    });

    const sourceRecords = source.getManagedRecords('profile-a');
    expect(sourceRecords.cards).toContainEqual(
      expect.objectContaining({
        id: 'debt-card',
        accountKind: 'line-of-credit',
        creditLimitCents: 1_500_000,
        reportedBalanceCents: 84_321,
        reportedBalanceDate: '2026-07-15',
        reportedCarryingBalanceCents: 12_345,
        reportedCarryingBalanceDate: '2026-07-15',
      }),
    );
    expect(sourceRecords.cardCycles).toContainEqual(
      expect.objectContaining({ id: 'debt-cycle', actualPaymentCents: 6_420 }),
    );
    expect(sourceRecords.loans).toContainEqual(
      expect.objectContaining({
        id: 'debt-loan',
        cashPaymentCents: 31_500,
        originalTermMonths: 48,
        amortizationStructure: 'balloon',
        expectedBalloonCents: 123_456,
        inferredFields: ['originalDate', 'originalTermMonths', 'expectedBalloonCents'],
      }),
    );
    const storedCard = sourceRecords.cards.find((card) => card.id === 'debt-card');
    if (!storedCard) throw new Error('Expected the stored debt card');
    const { userId: storedCardUserId, ...editableCard } = storedCard;
    expect(storedCardUserId).toBe('profile-a');
    source.upsertManagedEntity('profile-a', 'credit-card', {
      ...editableCard,
      accountKind: 'credit-card',
      creditLimitCents: 1_600_000,
      reportedBalanceCents: 74_321,
      reportedBalanceDate: '2026-07-16',
      reportedCarryingBalanceCents: 0,
      reportedCarryingBalanceDate: '2026-07-16',
    });
    expect(source.getManagedRecords('profile-a').cards).toContainEqual(
      expect.objectContaining({
        id: 'debt-card',
        accountKind: 'credit-card',
        creditLimitCents: 1_600_000,
        reportedBalanceCents: 74_321,
        reportedBalanceDate: '2026-07-16',
        reportedCarryingBalanceCents: 0,
        reportedCarryingBalanceDate: '2026-07-16',
      }),
    );
    const profileB = source.getManagedRecords('profile-b');
    expect(profileB.cards.some((card) => card.id === 'debt-card')).toBe(false);
    expect(profileB.cardCycles.some((cycle) => cycle.id === 'debt-cycle')).toBe(false);
    expect(profileB.loans.some((loan) => loan.id === 'debt-loan')).toBe(false);

    const portable = source.exportPortableProfile('profile-a', 'debt-metadata-test');
    const encrypted = await createEncryptedBackup(portable, 'synthetic-debt-backup-password');
    expect(encrypted).not.toContain('Synthetic installment loan');
    const decrypted = await decryptBackup(encrypted, 'synthetic-debt-backup-password');
    if (decrypted.format !== 'balance-book-portable-profile') {
      throw new Error('Expected a portable profile backup');
    }

    const destination = openStore('balance-book-debt-metadata-restore-');
    initializeProfile(destination, 'restored-profile');
    destination.replacePortableProfile('restored-profile', decrypted);
    const restored = destination.getManagedRecords('restored-profile');
    expect(restored.cards).toContainEqual(
      expect.objectContaining({
        id: 'debt-card',
        userId: 'restored-profile',
        accountKind: 'credit-card',
        creditLimitCents: 1_600_000,
        reportedBalanceCents: 74_321,
        reportedCarryingBalanceCents: 0,
      }),
    );
    expect(restored.cardCycles).toContainEqual(
      expect.objectContaining({ id: 'debt-cycle', actualPaymentCents: 6_420 }),
    );
    expect(restored.loans).toContainEqual(
      expect.objectContaining({
        id: 'debt-loan',
        userId: 'restored-profile',
        cashPaymentCents: 31_500,
        originalTermMonths: 48,
        amortizationStructure: 'balloon',
        expectedBalloonCents: 123_456,
        inferredFields: ['originalDate', 'originalTermMonths', 'expectedBalloonCents'],
      }),
    );
  });

  it('migrates a schema-v21 database to debt metadata v22 with safe legacy defaults', () => {
    const directory = makeTemporaryDirectory('balance-book-debt-v22-migration-');
    const databasePath = path.join(directory, 'balance-book.sqlite');
    const backupDirectory = path.join(directory, 'backups');
    const database = new BetterSqlite3(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES
        (13, 'dark-first-interface-default', '2026-01-01T00:00:00.000Z'),
        (21, 'compact-legacy-refinance-audit-payloads', '2026-01-01T00:00:00.000Z');
      CREATE TABLE credit_cards (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE credit_card_cycles (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE loans (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO credit_cards (id) VALUES ('legacy-card');
      INSERT INTO credit_card_cycles (id) VALUES ('legacy-cycle');
      INSERT INTO loans (id) VALUES ('legacy-loan');
    `);

    applyMigrations({ database, databasePath, backupDirectory });

    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      {
        version: latestSchemaVersion,
      },
    );
    expect(
      database.prepare('SELECT account_kind FROM credit_cards WHERE id = ?').get('legacy-card'),
    ).toEqual({
      account_kind: 'credit-card',
    });
    for (const [table, columns] of [
      [
        'credit_cards',
        [
          'account_kind',
          'credit_limit_cents',
          'reported_balance_cents',
          'reported_balance_date',
          'reported_carrying_balance_cents',
          'reported_carrying_balance_date',
        ],
      ],
      ['credit_card_cycles', ['actual_payment_cents']],
      [
        'loans',
        [
          'cash_payment_cents',
          'original_term_months',
          'inferred_fields_json',
          'amortization_structure',
          'expected_balloon_cents',
        ],
      ],
    ] as const) {
      const actualColumns = (
        database.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(actualColumns).toEqual(expect.arrayContaining([...columns]));
    }
    expect(
      database
        .prepare('SELECT amortization_structure, expected_balloon_cents FROM loans WHERE id = ?')
        .get('legacy-loan'),
    ).toEqual({ amortization_structure: 'fully-amortizing', expected_balloon_cents: null });
    expect(fs.readdirSync(backupDirectory)).toHaveLength(1);
    database.close();
  });
});

describe('debt metadata financial effects', () => {
  const account = cashAccountSchema.parse({
    id: 'checking',
    userId: 'user-a',
    name: 'Checking',
    type: 'checking',
    openingBalanceCents: 500_000,
    balanceAsOf: '2026-07-01',
    includedInLiquidity: true,
    canFundOtherAccounts: true,
    transferDelayDays: 0,
  });

  it('uses the larger cash draft in cash flow while applying only contractual debt service to principal', () => {
    const loan = loanSchema.parse({
      id: 'loan-a',
      userId: 'user-a',
      name: 'Installment debt with escrow',
      principalCents: 25_000,
      accruedInterestCents: 0,
      balanceDate: '2026-07-01',
      annualRateBasisPoints: 0,
      accrualConvention: 'actual-365',
      paymentCents: 10_000,
      cashPaymentCents: 15_000,
      nextPaymentDate: '2026-07-15',
      fundingAccountId: account.id,
      excludeFromEconomicNetWorthDoubleCount: false,
      paymentFrequency: 'monthly',
      includeInCashForecast: true,
      status: 'active',
    });
    const payoff = projectLoanPayoffAtDate(loan, '2026-08-16');
    expect(payoff.scheduledPayments.map((payment) => payment.appliedPaymentCents)).toEqual([
      10_000, 10_000,
    ]);
    expect(payoff.scheduledPayments[0]?.remainingPrincipalCents).toBe(15_000);

    const materialized = materializeForecastEvents({
      accounts: [account],
      events: [],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-07-01',
      endDate: '2026-08-15',
    });
    expect(
      materialized
        .filter((event) => event.kind === 'loan-payment')
        .map((event) => ({ date: event.date, amountCents: event.amountCents })),
    ).toEqual([
      { date: '2026-07-15', amountCents: 15_000 },
      { date: '2026-08-15', amountCents: 15_000 },
    ]);
  });

  it('preserves a 31st-of-month installment anchor across February', () => {
    const loan = loanSchema.parse({
      id: 'eom-loan',
      userId: 'user-a',
      name: 'End-of-month loan',
      principalCents: 300_000,
      accruedInterestCents: 0,
      balanceDate: '2028-01-31',
      annualRateBasisPoints: 0,
      accrualConvention: 'actual-365',
      paymentCents: 100_000,
      nextPaymentDate: '2028-02-29',
      originalPrincipalCents: 300_000,
      originalDate: '2028-01-31',
      originalTermMonths: 3,
      maturityDate: '2028-04-30',
      fundingAccountId: account.id,
      paymentFrequency: 'monthly',
      includeInCashForecast: true,
      status: 'active',
    });

    const payoff = projectLoanPayoffAtDate(loan, '2028-05-01');
    expect(payoff.scheduledPayments.map((payment) => payment.date)).toEqual([
      '2028-02-29',
      '2028-03-31',
      '2028-04-30',
    ]);
    expect(payoff.payoffCents).toBe(0);
  });

  it('reconciles explicit managed-loan drafts instead of double-counting cash', () => {
    const loan = loanSchema.parse({
      id: 'linked-loan',
      userId: 'user-a',
      name: 'Linked installment loan',
      principalCents: 25_000,
      accruedInterestCents: 0,
      balanceDate: '2026-07-01',
      annualRateBasisPoints: 0,
      accrualConvention: 'actual-365',
      paymentCents: 10_000,
      cashPaymentCents: 15_000,
      nextPaymentDate: '2026-07-15',
      fundingAccountId: account.id,
      paymentFrequency: 'monthly',
      includeInCashForecast: true,
      status: 'active',
    });
    const linkedDraft = forecastEventSchema.parse({
      id: 'linked-loan-draft',
      userId: 'user-a',
      accountId: account.id,
      date: '2026-07-15',
      kind: 'loan-payment',
      direction: 'outflow',
      amountCents: 15_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Linked lender draft',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 15, interval: 1 },
      paymentMethod: 'cash-account',
      sourceRecordId: loan.id,
    });
    const linkedPayments = materializeForecastEvents({
      accounts: [account],
      events: [linkedDraft],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-07-02',
      endDate: '2026-08-31',
    }).filter((event) => event.kind === 'loan-payment');
    expect(
      linkedPayments.map((event) => ({ date: event.date, amountCents: event.amountCents })),
    ).toEqual([
      { date: '2026-07-15', amountCents: 15_000 },
      { date: '2026-08-15', amountCents: 15_000 },
    ]);

    const partialDraft = forecastEventSchema.parse({
      ...linkedDraft,
      id: 'partial-loan-draft',
      recurrenceRule: undefined,
      amountCents: 5_000,
    });
    const partialPayments = materializeForecastEvents({
      accounts: [account],
      events: [partialDraft],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-07-02',
      endDate: '2026-07-31',
    }).filter((event) => event.kind === 'loan-payment');
    expect(partialPayments.map((event) => event.amountCents).sort((a, b) => a - b)).toEqual([
      5_000, 10_000,
    ]);
    expect(partialPayments.reduce((total, event) => total + event.amountCents, 0)).toBe(15_000);
  });

  it('includes posted revolving debt in both contractual and economic net worth liabilities', () => {
    const withoutCardDebt = calculateNetWorth({
      cashAccounts: [account],
      assets: [],
      receivables: [],
      loans: [],
    });
    const withCardDebt = calculateNetWorth({
      cashAccounts: [account],
      assets: [],
      receivables: [],
      loans: [],
      revolvingDebtCents: 42_345,
    });

    expect(withCardDebt.contractualLiabilitiesCents).toBe(42_345);
    expect(withCardDebt.contractualNetWorthCents).toBe(
      withoutCardDebt.contractualNetWorthCents - 42_345,
    );
    expect(withCardDebt.economicNetWorthCents).toBe(withoutCardDebt.economicNetWorthCents - 42_345);
    expect(withCardDebt.liquidNetPositionCents).toBe(withoutCardDebt.liquidNetPositionCents);
  });

  it('keeps snapshot net worth invariant for a scheduled same-day payment while Overview debt remains actually owed', () => {
    const card = creditCardSchema.parse({
      id: 'same-day-net-worth-card',
      userId: 'user-a',
      name: 'Same-day card',
      fundingAccountId: account.id,
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
    });
    const cycle = creditCardCycleSchema.parse({
      id: 'same-day-net-worth-cycle',
      cardId: card.id,
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-15',
      paymentOn: '2026-07-15',
      state: 'scheduled-payment',
      defaultEstimateCents: 40_000,
      actualActivityCents: 40_000,
      plannedActivityCents: 0,
      lockedStatementCents: 40_000,
    });
    const payment = forecastEventSchema.parse({
      id: 'same-day-net-worth-payment',
      userId: 'user-a',
      accountId: account.id,
      date: '2026-07-15',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 40_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Same-day statement payment',
      sourceRecordId: cycle.id,
      paymentMethod: 'cash-account',
      cardId: card.id,
    });
    const openCycle = creditCardCycleSchema.parse({
      id: 'same-day-net-worth-open-cycle',
      cardId: card.id,
      opensOn: '2026-07-01',
      closesOn: '2026-07-31',
      dueOn: '2026-08-15',
      state: 'open',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });
    const postedPurchase = forecastEventSchema.parse({
      id: 'same-day-net-worth-posted-purchase',
      userId: 'user-a',
      accountId: account.id,
      date: '2026-07-10',
      kind: 'scenario',
      direction: 'outflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'planned',
      label: 'Posted current-cycle purchase',
      paymentMethod: 'credit-card',
      cardId: card.id,
      cardActivityTreatment: 'additional',
    });
    const opening = calculateNetWorth({
      cashAccounts: [account],
      assets: [],
      receivables: [],
      loans: [],
      revolvingDebtCents: 50_000,
    });
    const actualDebtForOverview = summarizeRevolvingDebt({
      card,
      cycles: [cycle, openCycle],
      // Mirrors the dashboard debt input: raw posted activity plus a materialized
      // cash payment occurrence.
      events: [postedPurchase, payment],
      asOfDate: '2026-07-15',
    });
    const debtForExpectedCashClose = summarizeRevolvingDebt({
      card,
      cycles: [cycle, openCycle],
      events: [postedPurchase, payment],
      asOfDate: '2026-07-15',
      paymentEvidenceMode: 'include-projected-payments',
    });
    const closing = calculateNetWorth({
      cashAccounts: [account],
      assets: [],
      receivables: [],
      loans: [],
      revolvingDebtCents: debtForExpectedCashClose.currentBalanceCents,
      liquidCashCentsOverride: account.openingBalanceCents - payment.amountCents,
      allCashCentsOverride: account.openingBalanceCents - payment.amountCents,
    });

    expect(actualDebtForOverview.amountCurrentlyDueCents).toBe(40_000);
    expect(actualDebtForOverview.currentBalanceCents).toBe(50_000);
    expect(debtForExpectedCashClose.amountCurrentlyDueCents).toBe(0);
    expect(debtForExpectedCashClose.currentBalanceCents).toBe(10_000);
    expect(closing.contractualNetWorthCents).toBe(opening.contractualNetWorthCents);
    expect(closing.economicNetWorthCents).toBe(opening.economicNetWorthCents);
  });

  it('does not generate a duplicate card payment when a recurring linked cash payment covers the cycle', () => {
    const card = creditCardSchema.parse({
      id: 'card-a',
      userId: 'user-a',
      name: 'Full-pay card',
      fundingAccountId: account.id,
      defaultFutureStatementCents: 20_000,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 20,
    });
    const cycle = creditCardCycleSchema.parse({
      id: 'cycle-a',
      cardId: card.id,
      opensOn: '2026-01-21',
      closesOn: '2026-02-20',
      dueOn: '2026-03-15',
      paymentOn: '2026-03-15',
      state: 'scheduled-payment',
      defaultEstimateCents: 20_000,
      actualActivityCents: 20_000,
      plannedActivityCents: 0,
      lockedStatementCents: 20_000,
    });
    const explicitPayment = forecastEventSchema.parse({
      id: 'linked-card-payment',
      userId: 'user-a',
      accountId: account.id,
      date: '2026-01-15',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 20_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Issuer autopay',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 15, interval: 1 },
      recurrenceEndDate: '2026-12-15',
      paymentMethod: 'cash-account',
      cardId: card.id,
    });

    const paymentsOnCycleDate = materializeForecastEvents({
      accounts: [account],
      events: [explicitPayment],
      cards: [card],
      cardCycles: [cycle],
      loans: [],
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    }).filter((event) => event.kind === 'card-payment' && event.date === '2026-03-15');

    expect(paymentsOnCycleDate).toHaveLength(1);
    expect(paymentsOnCycleDate[0]).toMatchObject({
      id: 'linked-card-payment@2026-03-15',
      amountCents: 20_000,
      cardId: card.id,
    });
  });

  it('generates only the remainder when a linked card payment is smaller than the policy amount', () => {
    const card = creditCardSchema.parse({
      id: 'partial-link-card',
      userId: 'user-a',
      name: 'Partially linked full-pay card',
      fundingAccountId: account.id,
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
    });
    const cycle = creditCardCycleSchema.parse({
      id: 'partial-link-cycle',
      cardId: card.id,
      opensOn: '2026-05-01',
      closesOn: '2026-05-31',
      dueOn: '2026-07-15',
      paymentOn: '2026-07-15',
      state: 'scheduled-payment',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 10_000,
    });
    const linkedPayment = forecastEventSchema.parse({
      id: 'small-linked-payment',
      userId: 'user-a',
      accountId: account.id,
      date: '2026-07-15',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 100,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Small issuer payment',
      paymentMethod: 'cash-account',
      cardId: card.id,
    });

    const payments = materializeForecastEvents({
      accounts: [account],
      events: [linkedPayment],
      cards: [card],
      cardCycles: [cycle],
      loans: [],
      startDate: '2026-07-02',
      endDate: '2026-07-31',
    }).filter((event) => event.kind === 'card-payment' && event.date === '2026-07-15');

    expect(payments.map((payment) => payment.amountCents).sort((a, b) => a - b)).toEqual([
      100, 9_900,
    ]);
    expect(payments.reduce((total, payment) => total + payment.amountCents, 0)).toBe(10_000);

    const unacceptedScenarioPayment = forecastEventSchema.parse({
      ...linkedPayment,
      id: 'unaccepted-scenario-payment',
      amountCents: 10_000,
      hypothetical: true,
      accepted: false,
    });
    const generatedDespiteScenario = materializeForecastEvents({
      accounts: [account],
      events: [unacceptedScenarioPayment],
      cards: [card],
      cardCycles: [cycle],
      loans: [],
      startDate: '2026-07-02',
      endDate: '2026-07-31',
    }).find((event) => event.id === `card-payment-${cycle.id}`);
    expect(generatedDespiteScenario?.amountCents).toBe(10_000);
  });

  it('uses explicit manual payments in carry and preserves overdue unpaid debt', () => {
    const manualCard = creditCardSchema.parse({
      id: 'manual-card',
      userId: 'user-a',
      name: 'Manual-pay line',
      fundingAccountId: account.id,
      accountKind: 'line-of-credit',
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'manual',
    });
    const locked = creditCardCycleSchema.parse({
      id: 'manual-locked',
      cardId: manualCard.id,
      opensOn: '2026-05-01',
      closesOn: '2026-05-31',
      dueOn: '2026-07-15',
      paymentOn: '2026-07-15',
      state: 'scheduled-payment',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
      lockedStatementCents: 10_000,
    });
    const future = creditCardCycleSchema.parse({
      id: 'manual-future',
      cardId: manualCard.id,
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-08-15',
      state: 'future-estimated',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });
    const manualSchedule = projectCardDebtSchedule({
      card: manualCard,
      cardCycles: [locked, future],
      asOfDate: '2026-07-01',
      explicitPaymentCentsByCycleId: { [locked.id]: 4_000 },
    });
    expect(manualSchedule[0]).toMatchObject({
      paymentCents: 4_000,
      carryingBalanceAfterPaymentCents: 6_000,
    });
    expect(manualSchedule[1]).toMatchObject({
      obligationCents: 6_000,
      paymentCents: 0,
      carryingBalanceAfterPaymentCents: 6_000,
    });

    const overdueFullPay = creditCardSchema.parse({
      ...manualCard,
      id: 'overdue-card',
      paymentPolicy: 'full-statement',
    });
    const overdue = creditCardCycleSchema.parse({
      ...locked,
      id: 'overdue-locked',
      cardId: overdueFullPay.id,
      dueOn: '2026-06-20',
      paymentOn: undefined,
      state: 'closed-statement',
    });
    const catchUp = creditCardCycleSchema.parse({
      ...future,
      id: 'overdue-future',
      cardId: overdueFullPay.id,
    });
    const overdueSchedule = projectCardDebtSchedule({
      card: overdueFullPay,
      cardCycles: [overdue, catchUp],
      asOfDate: '2026-06-21',
    });
    expect(overdueSchedule[0]).toMatchObject({
      paymentCents: 0,
      carryingBalanceAfterPaymentCents: 10_000,
    });
    expect(overdueSchedule[1]).toMatchObject({
      obligationCents: 10_000,
      paymentCents: 10_000,
      carryingBalanceAfterPaymentCents: 0,
    });
  });

  it('uses a reported line balance as dated opening carry for fixed-payment projection', () => {
    const card = creditCardSchema.parse({
      id: 'opening-line',
      userId: 'user-a',
      name: 'Opening line balance',
      fundingAccountId: account.id,
      accountKind: 'line-of-credit',
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'fixed',
      fixedPaymentCents: 1_000,
    });
    const future = creditCardCycleSchema.parse({
      id: 'opening-line-cycle',
      cardId: card.id,
      opensOn: '2026-07-01',
      closesOn: '2026-07-31',
      dueOn: '2026-08-15',
      state: 'future-estimated',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });

    expect(
      projectCardDebtSchedule({
        card,
        cardCycles: [future],
        asOfDate: '2026-07-15',
        openingCarryingBalance: { cents: 10_000, asOfDate: '2026-07-15' },
      })[0],
    ).toMatchObject({
      obligationCents: 10_000,
      paymentCents: 1_000,
      carryingBalanceAfterPaymentCents: 9_000,
    });
  });

  it('keeps the latest paid locked statement visible beside the open cycle in Spending Power', () => {
    const card = creditCardSchema.parse({
      id: 'card-a',
      userId: 'user-a',
      name: 'Paid-in-full card',
      fundingAccountId: account.id,
      defaultFutureStatementCents: 0,
      estimatePolicy: 'actual-reset',
      paymentPolicy: 'full-statement',
      paymentDayOfMonth: 15,
      statementCloseDayOfMonth: 30,
    });
    const paidStatement = creditCardCycleSchema.parse({
      id: 'paid-statement',
      cardId: card.id,
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-15',
      paymentOn: '2026-07-15',
      state: 'paid',
      defaultEstimateCents: 42_000,
      actualActivityCents: 42_000,
      plannedActivityCents: 0,
      lockedStatementCents: 42_000,
      actualPaymentCents: 42_000,
    });
    const openCycle = creditCardCycleSchema.parse({
      id: 'open-cycle',
      cardId: card.id,
      opensOn: '2026-07-01',
      closesOn: '2026-07-31',
      dueOn: '2026-08-15',
      paymentOn: '2026-08-15',
      state: 'open',
      defaultEstimateCents: 0,
      actualActivityCents: 9_876,
      plannedActivityCents: 0,
    });

    const spendingPower = calculateCardSpendingPower({
      cards: [card],
      cardCycles: [paidStatement, openCycle],
      asOfDate: '2026-07-16',
      days: [
        {
          date: '2026-07-16',
          consolidatedCashCents: 500_000,
          totalPositionCents: 500_000,
          accountBalances: [{ accountId: account.id, endingBalanceCents: 500_000 }],
        },
        {
          date: '2026-08-15',
          consolidatedCashCents: 490_124,
          totalPositionCents: 490_124,
          accountBalances: [{ accountId: account.id, endingBalanceCents: 490_124 }],
        },
      ],
    })[0]!;

    expect(spendingPower).toMatchObject({
      statementCycleId: paidStatement.id,
      statementAmountCents: 42_000,
      statementDueOn: '2026-07-15',
      statementState: 'paid',
      currentCycleId: openCycle.id,
      currentCycleAmountCents: 9_876,
    });
  });
});
