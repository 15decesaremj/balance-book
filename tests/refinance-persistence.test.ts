import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  committedRefinancePlanInputSchema,
  committedRefinancePlanSchema,
  maximumProfileAssetRecords,
  type CommittedRefinancePlanInput,
  type Loan,
} from '@balance-book/domain';
import {
  BalanceBookStore,
  createEncryptedBackup,
  decryptBackup,
  latestSchemaVersion,
  parsePortableProfileBackup,
} from '@balance-book/database';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-refinance-test-'));
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

const initializeProfile = (store: BalanceBookStore, userId = 'profile-a'): void => {
  store.initializeProfiles([
    { id: userId, displayName: `Profile ${userId}`, username: `user-${userId}` },
  ]);
  store.saveVerticalSlice(userId, {
    balanceAsOf: '2026-07-15',
    accountName: 'Primary checking',
    openingBalanceCents: 500_000,
    hardFloorCents: 10_000,
  });
  store.upsertManagedEntity(userId, 'cash-account', {
    id: `${userId}-reserve`,
    name: 'Reserve savings',
    type: 'savings',
    openingBalanceCents: 300_000,
    balanceAsOf: '2026-07-15',
    includedInLiquidity: true,
    canFundOtherAccounts: true,
    transferDelayDays: 0,
  });
};

const addLoan = (
  store: BalanceBookStore,
  userId: string,
  id: string,
  principalCents: number,
  fundingAccountId = `${userId}-primary-cash`,
): Loan => {
  store.upsertManagedEntity(userId, 'loan', {
    id,
    name: `Loan ${id}`,
    lender: 'Synthetic lender',
    loanType: 'installment',
    principalCents,
    accruedInterestCents: 0,
    balanceDate: '2026-07-15',
    annualRateBasisPoints: 800,
    accrualConvention: 'actual-365',
    paymentCents: 25_000,
    nextPaymentDate: '2026-08-01',
    amortizationStructure: 'fully-amortizing',
    fundingAccountId,
    excludeFromEconomicNetWorthDoubleCount: false,
    paymentFrequency: 'monthly',
    includeInCashForecast: true,
    status: 'active',
  });
  return store.getManagedRecords(userId).loans.find((loan) => loan.id === id)!;
};

const replacementLoanInput = (
  id: string,
  principalCents: number,
  fundingAccountId = 'profile-a-reserve',
  closingDate = '2026-09-01',
  firstPaymentDate = '2026-10-01',
): Omit<Loan, 'userId'> => ({
  id,
  name: `Replacement ${id}`,
  lender: 'Replacement lender',
  loanType: 'refinance',
  principalCents,
  accruedInterestCents: 0,
  balanceDate: closingDate,
  annualRateBasisPoints: 625,
  accrualConvention: 'actual-365',
  paymentCents: 18_000,
  nextPaymentDate: firstPaymentDate,
  amortizationStructure: 'fully-amortizing',
  originalPrincipalCents: principalCents,
  originalDate: closingDate,
  fundingAccountId,
  excludeFromEconomicNetWorthDoubleCount: false,
  paymentFrequency: 'monthly',
  includeInCashForecast: true,
  status: 'active',
});

const consolidationInput = (): CommittedRefinancePlanInput => ({
  id: 'refinance-a',
  name: 'Consolidate two loans',
  closingDate: '2026-09-01',
  payoffDate: '2026-09-03',
  firstPaymentDate: '2026-10-01',
  payoffs: [
    { sourceLoanId: 'source-a', payoffAmountCents: 500_000 },
    { sourceLoanId: 'source-b', payoffAmountCents: 250_000 },
  ],
  replacementLoan: replacementLoanInput('replacement-a', 740_000),
  principalCashContributionCents: 50_000,
  closingCostsCents: 20_000,
  financedFeesCents: 15_000,
  cashSourceAccountId: 'profile-a-primary-cash',
  excessProceedsCents: 25_000,
  excessProceedsAccountId: 'profile-a-reserve',
  notes: 'Synthetic committed refinance',
});

describe('committed refinance persistence', () => {
  it('validates settlement identity, fee funding, and refinance chronology at the domain boundary', () => {
    const valid = consolidationInput();
    expect(committedRefinancePlanInputSchema.parse(valid)).toMatchObject({
      closingCostsCents: 20_000,
      financedFeesCents: 15_000,
      principalCashContributionCents: 50_000,
      excessProceedsCents: 25_000,
    });
    expect(() =>
      committedRefinancePlanInputSchema.parse({
        ...valid,
        replacementLoan: { ...valid.replacementLoan, principalCents: 739_999 },
      }),
    ).toThrow(/principal/i);
    expect(() =>
      committedRefinancePlanInputSchema.parse({
        ...valid,
        financedFeesCents: 20_001,
      }),
    ).toThrow(/financed fees/i);
    expect(() =>
      committedRefinancePlanInputSchema.parse({ ...valid, cashSourceAccountId: undefined }),
    ).toThrow(/bank account/i);
    expect(() =>
      committedRefinancePlanInputSchema.parse({
        ...valid,
        payoffDate: '2026-08-31',
      }),
    ).toThrow(/payoff date/i);
    expect(() =>
      committedRefinancePlanInputSchema.parse({
        ...valid,
        payoffDate: valid.closingDate,
        firstPaymentDate: valid.closingDate,
        replacementLoan: {
          ...valid.replacementLoan,
          nextPaymentDate: valid.closingDate,
        },
      }),
    ).toThrow(/first payment must be after the refinance closing date/i);
    expect(() =>
      committedRefinancePlanInputSchema.parse({
        ...valid,
        payoffDate: '2027-09-03',
        firstPaymentDate: '2027-10-01',
        replacementLoan: {
          ...valid.replacementLoan,
          nextPaymentDate: '2027-10-01',
        },
      }),
    ).toThrow(/within one year/i);
    expect(() =>
      committedRefinancePlanInputSchema.parse({
        ...valid,
        replacementLoan: {
          ...valid.replacementLoan,
          maturityDate: '2080-01-01',
        },
      }),
    ).toThrow(/600 months/i);
    expect(
      committedRefinancePlanSchema.parse({
        ...valid,
        userId: 'profile-a',
        status: 'committed',
        replacementLoan: { ...valid.replacementLoan, userId: 'profile-a' },
        assetRelinks: Array.from({ length: 1_001 }, (_, index) => ({
          assetId: `asset-${index}`,
          sourceLoanId: 'source-a',
          replacementLoanId: valid.replacementLoan.id,
        })),
      }).assetRelinks,
    ).toHaveLength(1_001);
    expect(
      committedRefinancePlanSchema.safeParse({
        ...valid,
        userId: 'profile-a',
        status: 'committed',
        replacementLoan: { ...valid.replacementLoan, userId: 'profile-a' },
        assetRelinks: Array.from({ length: 50_001 }, (_, index) => ({
          assetId: `asset-${index}`,
          sourceLoanId: 'source-a',
          replacementLoanId: valid.replacementLoan.id,
        })),
      }).success,
    ).toBe(false);
  });

  it('rejects a positive payoff quote when the source debt is gone by payoff', () => {
    const store = openStore();
    initializeProfile(store);
    const sourceA = addLoan(store, 'profile-a', 'source-a', 500_000);
    addLoan(store, 'profile-a', 'source-b', 250_000);
    store.upsertManagedEntity('profile-a', 'loan', {
      ...sourceA,
      maturityDate: '2026-08-01',
    });

    expect(() =>
      store.commitRefinancePlan('profile-a', consolidationInput(), '2026-07-15'),
    ).toThrow(/no modeled debt remaining/i);
    expect(
      store.raw.prepare('SELECT id FROM loans WHERE id = ?').get('replacement-a'),
    ).toBeUndefined();
  });

  it('rejects a source whose payments are excluded before creating any refinance records', () => {
    const store = openStore();
    initializeProfile(store);
    const sourceA = addLoan(store, 'profile-a', 'source-a', 500_000);
    addLoan(store, 'profile-a', 'source-b', 250_000);
    store.upsertManagedEntity('profile-a', 'loan', {
      ...sourceA,
      includeInCashForecast: false,
    });

    expect(() =>
      store.commitRefinancePlan('profile-a', consolidationInput(), '2026-07-15'),
    ).toThrow(/include the payoff loan payments in the cash forecast/i);
    expect(
      store.raw.prepare('SELECT id FROM loans WHERE id = ?').get('replacement-a'),
    ).toBeUndefined();
    expect(
      store.raw.prepare('SELECT id FROM committed_refinance_plans WHERE id = ?').get('refinance-a'),
    ).toBeUndefined();
  });

  it('preflights the relink ceiling and migrates high-count legacy audit records into portable encrypted backups', async () => {
    const store = openStore();
    initializeProfile(store);
    addLoan(store, 'profile-a', 'source-a', 500_000);
    addLoan(store, 'profile-a', 'source-b', 250_000);
    const retainedAssetCount = 12_000;
    const insertAsset = store.raw.prepare(
      `INSERT INTO assets (
         id, user_id, name, type, value_cents, valuation_date, linked_liability_id,
         included_in_net_worth, included_in_liquidity, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    store.raw.transaction(() => {
      for (let index = 0; index <= maximumProfileAssetRecords; index += 1) {
        const prefix = index < retainedAssetCount ? 'kept' : 'extra';
        const id = `${prefix}-${String(index).padStart(5, '0')}-${'x'.repeat(110)}`;
        insertAsset.run(
          id,
          'profile-a',
          `Synthetic asset ${index}`,
          'tangible',
          1,
          '2026-07-15',
          'source-a',
          1,
          0,
          '2026-07-15T00:00:00.000Z',
          '2026-07-15T00:00:00.000Z',
        );
      }
    })();

    expect(() =>
      store.commitRefinancePlan('profile-a', consolidationInput(), '2026-07-15'),
    ).toThrow(/more than .* linked assets/i);
    expect(
      store.raw.prepare('SELECT id FROM loans WHERE id = ?').get('replacement-a'),
    ).toBeUndefined();
    expect(
      store.raw.prepare('SELECT id FROM committed_refinance_plans WHERE id = ?').get('refinance-a'),
    ).toBeUndefined();

    store.raw.prepare("DELETE FROM assets WHERE id LIKE 'extra-%'").run();
    const committed = store.commitRefinancePlan('profile-a', consolidationInput(), '2026-07-15');
    expect(committed.assetRelinks).toHaveLength(retainedAssetCount);
    expect(JSON.stringify({ assetRelinks: committed.assetRelinks }).length).toBeGreaterThan(
      2 * 1024 * 1024,
    );
    const commitAudit = store.raw
      .prepare(
        "SELECT payload_json AS payloadJson FROM audit_events WHERE entity_type = 'committed-refinance-plan' AND entity_id = ? AND action = 'commit'",
      )
      .get('refinance-a') as { payloadJson: string };
    expect(commitAudit.payloadJson.length).toBeLessThan(2 * 1024 * 1024);
    expect(JSON.parse(commitAudit.payloadJson)).toMatchObject({
      plan: { id: 'refinance-a', replacementLoanId: 'replacement-a' },
      assetRelinkCount: retainedAssetCount,
    });

    store.raw
      .prepare(
        `UPDATE audit_events
            SET payload_json = ?
          WHERE user_id = ?
            AND entity_type = 'committed-refinance-plan'
            AND entity_id = ?
            AND action = 'commit'`,
      )
      .run(
        JSON.stringify({ plan: { id: 'refinance-a' }, assetRelinks: committed.assetRelinks }),
        'profile-a',
        'refinance-a',
      );
    store.raw.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
    const databasePath = store.raw.name;
    const directory = path.dirname(databasePath);
    store.close();

    const repaired = new BalanceBookStore({
      databasePath,
      backupDirectory: path.join(directory, 'repair-backups'),
    });
    stores.push(repaired);
    expect(repaired.getCommittedRefinancePlans('profile-a')[0]?.assetRelinks).toHaveLength(
      retainedAssetCount,
    );
    const repairedAudit = repaired.raw
      .prepare(
        "SELECT payload_json AS payloadJson FROM audit_events WHERE entity_type = 'committed-refinance-plan' AND entity_id = ? AND action = 'commit'",
      )
      .get('refinance-a') as { payloadJson: string };
    expect(
      repaired.raw.prepare('SELECT name FROM schema_migrations WHERE version = 21').get(),
    ).toEqual({ name: 'compact-legacy-refinance-audit-payloads' });
    expect(repairedAudit.payloadJson.length).toBeLessThan(2 * 1024 * 1024);
    expect(JSON.parse(repairedAudit.payloadJson)).toMatchObject({
      plan: { id: 'refinance-a', replacementLoanId: 'replacement-a' },
      assetRelinkCount: retainedAssetCount,
      migratedLegacyAssetRelinks: true,
    });

    const encrypted = await createEncryptedBackup(
      repaired.exportPortableProfile('profile-a', '1.0.0-test'),
      'synthetic-refinance-backup-password',
    );
    const decrypted = await decryptBackup(encrypted, 'synthetic-refinance-backup-password');
    if (decrypted.format !== 'balance-book-portable-profile') {
      throw new Error('Expected a portable profile backup');
    }
    const portable = parsePortableProfileBackup(decrypted);
    const destination = openStore();
    initializeProfile(destination, 'destination-profile');
    destination.replacePortableProfile('destination-profile', portable);
    expect(destination.getManagedRecords('destination-profile').assets).toHaveLength(
      retainedAssetCount,
    );
    expect(
      destination.getCommittedRefinancePlans('destination-profile')[0]?.assetRelinks,
    ).toHaveLength(retainedAssetCount);
  }, 20_000);

  it('commits atomically, scopes ownership, relinks assets, handles retries, and hydrates current loan terms', () => {
    const store = openStore();
    initializeProfile(store);
    addLoan(store, 'profile-a', 'source-a', 500_000);
    addLoan(store, 'profile-a', 'source-b', 250_000);
    store.upsertManagedEntity('profile-a', 'asset', {
      id: 'asset-a',
      name: 'Asset securing source A',
      type: 'tangible',
      valueCents: 900_000,
      valuationDate: '2026-07-15',
      linkedLiabilityId: 'source-a',
      includedInNetWorth: true,
      includedInLiquidity: false,
    });

    const input = consolidationInput();
    const staleClosing: CommittedRefinancePlanInput = {
      ...input,
      id: 'stale-closing-refinance',
      closingDate: '2026-07-15',
      replacementLoan: {
        ...input.replacementLoan,
        id: 'stale-closing-replacement',
        balanceDate: '2026-07-15',
        originalDate: '2026-07-15',
      },
    };
    expect(() => store.commitRefinancePlan('profile-a', staleClosing, '2026-07-15')).toThrow(
      /closing cash must occur after/i,
    );
    expect(
      store.raw.prepare('SELECT id FROM loans WHERE id = ?').get('stale-closing-replacement'),
    ).toBeUndefined();

    const farFuture: CommittedRefinancePlanInput = {
      ...input,
      id: 'far-future-refinance',
      closingDate: '2040-01-01',
      payoffDate: '2040-01-02',
      firstPaymentDate: '2040-02-01',
      replacementLoan: replacementLoanInput(
        'far-future-replacement',
        740_000,
        'profile-a-reserve',
        '2040-01-01',
        '2040-02-01',
      ),
    };
    expect(() => store.commitRefinancePlan('profile-a', farFuture, '2026-07-15')).toThrow(
      /within the next 10 years/i,
    );
    expect(
      store.raw.prepare('SELECT id FROM loans WHERE id = ?').get('far-future-replacement'),
    ).toBeUndefined();

    const committed = store.commitRefinancePlan('profile-a', input);
    expect(committed).toMatchObject({
      id: 'refinance-a',
      status: 'committed',
      replacementLoan: { id: 'replacement-a', fundingAccountId: 'profile-a-reserve' },
      payoffs: [
        { sourceLoanId: 'source-a', payoffAmountCents: 500_000 },
        { sourceLoanId: 'source-b', payoffAmountCents: 250_000 },
      ],
      cashSourceAccountId: 'profile-a-primary-cash',
      excessProceedsAccountId: 'profile-a-reserve',
    });
    expect(store.getManagedRecords('profile-a').assets[0]?.linkedLiabilityId).toBe('replacement-a');
    const committedSource = store
      .getManagedRecords('profile-a')
      .loans.find((loan) => loan.id === 'source-a')!;
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'loan',
        { ...committedSource, cashPaymentCents: committedSource.paymentCents },
        { asOfDate: '2026-07-15' },
      ),
    ).not.toThrow();
    const sourceWithExplicitCashPayment = store
      .getManagedRecords('profile-a')
      .loans.find((loan) => loan.id === 'source-a')!;
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'loan',
        {
          ...sourceWithExplicitCashPayment,
          cashPaymentCents: sourceWithExplicitCashPayment.paymentCents + 1,
        },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/schedule terms are locked by committed refinance history/i);
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'loan',
        { ...sourceWithExplicitCashPayment, originalTermMonths: 36 },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/schedule terms are locked by committed refinance history/i);
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'loan',
        { ...committedSource, maturityDate: '2026-08-01' },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/schedule terms are locked by committed refinance history/i);
    const committedAsset = store.getManagedRecords('profile-a').assets[0]!;
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'asset',
        { ...committedAsset, linkedLiabilityId: 'source-a' },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/scheduled for a committed refinance payoff/i);
    expect(() => store.deleteManagedEntity('profile-a', 'asset', 'asset-a')).toThrow(
      /committed refinance history/i,
    );
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'asset',
        {
          id: 'late-source-asset',
          name: 'Late source asset',
          type: 'tangible',
          valueCents: 10_000,
          valuationDate: '2026-07-15',
          linkedLiabilityId: 'source-a',
          includedInNetWorth: true,
          includedInLiquidity: false,
        },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/already scheduled for a committed refinance payoff/i);
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'asset',
        {
          id: 'early-replacement-asset',
          name: 'Early replacement asset',
          type: 'tangible',
          valueCents: 10_000,
          valuationDate: '2026-07-15',
          linkedLiabilityId: 'replacement-a',
          includedInNetWorth: true,
          includedInLiquidity: false,
        },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/does not become effective until/i);
    expect(store.commitRefinancePlan('profile-a', input)).toEqual(committed);
    expect(() =>
      store.commitRefinancePlan('profile-a', { ...input, name: 'Different terms' }),
    ).toThrow(/different committed terms/i);
    expect(
      store.raw
        .prepare('SELECT COUNT(*) AS count FROM committed_refinance_plans WHERE user_id = ?')
        .get('profile-a'),
    ).toEqual({ count: 1 });

    const audit = store.raw
      .prepare(
        "SELECT payload_json AS payloadJson FROM audit_events WHERE user_id = ? AND entity_type = 'committed-refinance-plan' AND action = 'commit'",
      )
      .get('profile-a') as { payloadJson: string };
    expect(JSON.parse(audit.payloadJson)).toMatchObject({
      plan: { id: 'refinance-a', replacementLoanId: 'replacement-a' },
      assetRelinkCount: 1,
    });

    const currentReplacement = store
      .getManagedRecords('profile-a')
      .loans.find((loan) => loan.id === 'replacement-a')!;
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'loan',
        {
          ...currentReplacement,
          paymentCents: currentReplacement.paymentCents + 1,
        },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/future replacement-loan terms are locked/i);
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'loan',
        {
          ...currentReplacement,
          status: 'paid-off',
          includeInCashForecast: false,
        },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/lifecycle and cash inclusion are managed/i);
    expect(() =>
      store.upsertManagedEntity(
        'profile-a',
        'loan',
        {
          ...currentReplacement,
          balanceDate: '2026-10-15',
          principalCents: 1,
        },
        { asOfDate: '2026-07-15' },
      ),
    ).toThrow(/future replacement-loan terms are locked/i);
    store.upsertManagedEntity(
      'profile-a',
      'loan',
      {
        ...currentReplacement,
        principalCents: 710_000,
        balanceDate: '2026-10-15',
        paymentCents: 19_250,
        nextPaymentDate: '2026-11-01',
      },
      { asOfDate: '2026-10-15' },
    );
    expect(store.getCommittedRefinancePlans('profile-a')[0]?.replacementLoan).toMatchObject({
      principalCents: 710_000,
      balanceDate: '2026-10-15',
      paymentCents: 19_250,
      nextPaymentDate: '2026-11-01',
    });
    expect(store.commitRefinancePlan('profile-a', input).replacementLoan).toMatchObject({
      principalCents: 710_000,
      paymentCents: 19_250,
    });
    const snapshot = store.raw
      .prepare(
        'SELECT replacement_loan_snapshot_json AS snapshot FROM committed_refinance_plans WHERE id = ?',
      )
      .get('refinance-a') as { snapshot: string };
    expect(JSON.parse(snapshot.snapshot)).toMatchObject({
      principalCents: 740_000,
      paymentCents: 18_000,
    });
    const updatedBackup = store.exportPortableProfile('profile-a', '1.0.0-test');
    expect(updatedBackup.committedRefinancePlans[0]).toMatchObject({
      replacementLoan: { principalCents: 710_000, paymentCents: 19_250 },
      replacementLoanSnapshot: { principalCents: 740_000, paymentCents: 18_000 },
      assetRelinks: [
        {
          assetId: 'asset-a',
          sourceLoanId: 'source-a',
          replacementLoanId: 'replacement-a',
        },
      ],
    });

    initializeProfile(store, 'profile-b');
    expect(() => store.commitRefinancePlan('profile-b', input)).toThrow(/another profile/i);
    addLoan(store, 'profile-b', 'profile-b-source', 100_000);
    const crossProfileSource: CommittedRefinancePlanInput = {
      ...input,
      id: 'cross-profile-source-plan',
      name: 'Invalid foreign source',
      payoffs: [{ sourceLoanId: 'profile-b-source', payoffAmountCents: 100_000 }],
      replacementLoan: replacementLoanInput('cross-profile-replacement', 100_000),
      principalCashContributionCents: 0,
      closingCostsCents: 0,
      financedFeesCents: 0,
      cashSourceAccountId: undefined,
      excessProceedsCents: 0,
      excessProceedsAccountId: undefined,
    };
    expect(() => store.commitRefinancePlan('profile-a', crossProfileSource)).toThrow(
      /not available to this profile/i,
    );
    expect(
      store.raw.prepare('SELECT id FROM loans WHERE id = ?').get('cross-profile-replacement'),
    ).toBeUndefined();

    expect(() =>
      store.cancelCommittedRefinancePlan('profile-a', input.id, input.closingDate),
    ).toThrow(/on or after its closing date/i);
    expect(store.cancelCommittedRefinancePlan('profile-a', input.id, '2026-07-15').status).toBe(
      'cancelled',
    );
    expect(store.getManagedRecords('profile-a').assets[0]?.linkedLiabilityId).toBe('source-a');
    const cancelAudit = store.raw
      .prepare(
        "SELECT payload_json AS payloadJson FROM audit_events WHERE user_id = ? AND entity_type = 'committed-refinance-plan' AND action = 'cancel'",
      )
      .get('profile-a') as { payloadJson: string };
    expect(JSON.parse(cancelAudit.payloadJson)).toMatchObject({
      plan: { id: input.id, status: 'cancelled' },
      restoredAssetRelinkCount: 1,
    });
  });

  it('supports chronological stacked refinancing and preserves explicit predecessor lineage', () => {
    const store = openStore();
    initializeProfile(store);
    addLoan(store, 'profile-a', 'source-a', 500_000);
    addLoan(store, 'profile-a', 'unrelated-stack-loan', 480_000);
    store.upsertManagedEntity('profile-a', 'asset', {
      id: 'stacked-asset',
      name: 'Stacked secured asset',
      type: 'tangible',
      valueCents: 900_000,
      valuationDate: '2026-07-15',
      linkedLiabilityId: 'source-a',
      includedInNetWorth: true,
      includedInLiquidity: false,
    });

    const first: CommittedRefinancePlanInput = {
      id: 'refinance-first',
      name: 'First refinance',
      closingDate: '2026-09-01',
      payoffDate: '2026-09-01',
      firstPaymentDate: '2026-10-01',
      payoffs: [{ sourceLoanId: 'source-a', payoffAmountCents: 500_000 }],
      replacementLoan: replacementLoanInput('replacement-first', 500_000),
      principalCashContributionCents: 0,
      closingCostsCents: 0,
      financedFeesCents: 0,
      excessProceedsCents: 0,
    };
    store.commitRefinancePlan('profile-a', first);

    expect(() =>
      store.commitRefinancePlan('profile-a', {
        ...first,
        id: 'refinance-conflict',
        replacementLoan: replacementLoanInput('replacement-conflict', 500_000),
      }),
    ).toThrow(/already assigned/i);

    const second: CommittedRefinancePlanInput = {
      id: 'refinance-second',
      name: 'Second refinance',
      closingDate: '2027-01-15',
      payoffDate: '2027-01-16',
      firstPaymentDate: '2027-02-15',
      payoffs: [{ sourceLoanId: 'replacement-first', payoffAmountCents: 480_000 }],
      replacementLoan: replacementLoanInput(
        'replacement-second',
        490_000,
        'profile-a-primary-cash',
        '2027-01-15',
        '2027-02-15',
      ),
      principalCashContributionCents: 0,
      closingCostsCents: 10_000,
      financedFeesCents: 10_000,
      excessProceedsCents: 0,
    };
    const stacked = store.commitRefinancePlan('profile-a', second);
    expect(stacked.payoffs).toEqual([
      {
        sourceLoanId: 'replacement-first',
        payoffAmountCents: 480_000,
        sourceRefinancePlanId: 'refinance-first',
      },
    ]);
    expect(store.getManagedRecords('profile-a').assets[0]?.linkedLiabilityId).toBe(
      'replacement-second',
    );

    const stackedExport = store.exportPortableProfile('profile-a', '1.0.0-test');
    stackedExport.exportedAt = '2026-07-15T00:00:00.000Z';
    const destination = openStore();
    initializeProfile(destination, 'stacked-destination');
    const wrongTerminalLink = structuredClone(stackedExport);
    wrongTerminalLink.assets[0]!.linkedLiabilityId = 'unrelated-stack-loan';
    expect(() =>
      destination.replacePortableProfile('stacked-destination', wrongTerminalLink),
    ).toThrow(/asset link that does not match committed refinance history/i);
    const discontinuousRelinks = structuredClone(stackedExport);
    const secondPlan = discontinuousRelinks.committedRefinancePlans.find(
      (plan) => plan.id === 'refinance-second',
    )!;
    secondPlan.payoffs = [{ sourceLoanId: 'unrelated-stack-loan', payoffAmountCents: 480_000 }];
    secondPlan.assetRelinks = [
      {
        assetId: 'stacked-asset',
        sourceLoanId: 'unrelated-stack-loan',
        replacementLoanId: 'replacement-second',
      },
    ];
    expect(() =>
      destination.replacePortableProfile('stacked-destination', discontinuousRelinks),
    ).toThrow(/discontinuous committed refinance asset-relink history/i);
    const missingEarlierRelink = structuredClone(stackedExport);
    missingEarlierRelink.committedRefinancePlans.find(
      (plan) => plan.id === 'refinance-first',
    )!.assetRelinks = [];
    expect(() =>
      destination.replacePortableProfile('stacked-destination', missingEarlierRelink),
    ).toThrow(/missing earlier future refinance asset-relink history/i);
    expect(() =>
      store.cancelCommittedRefinancePlan('profile-a', 'refinance-first', '2026-07-15'),
    ).toThrow(/later stacked refinance/i);
    expect(
      store.cancelCommittedRefinancePlan('profile-a', 'refinance-second', '2026-07-15').status,
    ).toBe('cancelled');
    expect(store.getManagedRecords('profile-a').assets[0]?.linkedLiabilityId).toBe(
      'replacement-first',
    );
    expect(
      store.cancelCommittedRefinancePlan('profile-a', 'refinance-first', '2026-07-15').status,
    ).toBe('cancelled');
    expect(store.getManagedRecords('profile-a').assets[0]?.linkedLiabilityId).toBe('source-a');
  });

  it('repairs already-v19 relink metadata and preserves export, restore, and cancellation', () => {
    const source = openStore();
    initializeProfile(source);
    addLoan(source, 'profile-a', 'source-a', 500_000);
    addLoan(source, 'profile-a', 'source-b', 250_000);
    source.upsertManagedEntity('profile-a', 'asset', {
      id: 'repair-asset',
      name: 'Repair asset',
      type: 'tangible',
      valueCents: 900_000,
      valuationDate: '2026-07-15',
      linkedLiabilityId: 'source-a',
      includedInNetWorth: true,
      includedInLiquidity: false,
    });
    source.commitRefinancePlan('profile-a', consolidationInput(), '2026-07-15');
    source.raw
      .prepare(
        `UPDATE audit_events
            SET payload_json = ?
          WHERE user_id = ?
            AND entity_type = 'committed-refinance-plan'
            AND entity_id = ?
            AND action = 'commit'`,
      )
      .run(
        JSON.stringify({
          plan: { id: 'refinance-a' },
          assetRelinks: [
            {
              assetId: 'repair-asset',
              sourceLoanId: 'source-a',
              replacementLoanId: 'replacement-a',
            },
          ],
        }),
        'profile-a',
        'refinance-a',
      );
    source.raw
      .prepare("UPDATE committed_refinance_plans SET asset_relinks_json = '[]' WHERE id = ?")
      .run('refinance-a');
    source.raw.prepare('DELETE FROM schema_migrations WHERE version >= 20').run();
    const databasePath = source.raw.name;
    const directory = path.dirname(databasePath);
    source.close();

    const repaired = new BalanceBookStore({
      databasePath,
      backupDirectory: path.join(directory, 'repair-backups'),
    });
    stores.push(repaired);
    expect(repaired.getCommittedRefinancePlans('profile-a')[0]?.assetRelinks).toEqual([
      {
        assetId: 'repair-asset',
        sourceLoanId: 'source-a',
        replacementLoanId: 'replacement-a',
      },
    ]);

    const exported = repaired.exportPortableProfile('profile-a', '1.0.0-test');
    const destination = openStore();
    initializeProfile(destination, 'destination-profile');
    destination.replacePortableProfile('destination-profile', exported);
    expect(destination.getCommittedRefinancePlans('destination-profile')[0]?.assetRelinks).toEqual([
      {
        assetId: 'repair-asset',
        sourceLoanId: 'source-a',
        replacementLoanId: 'replacement-a',
      },
    ]);
    destination.cancelCommittedRefinancePlan('destination-profile', 'refinance-a', '2026-07-15');
    expect(
      destination
        .getManagedRecords('destination-profile')
        .assets.find((asset) => asset.id === 'repair-asset')?.linkedLiabilityId,
    ).toBe('source-a');
  });

  it('round-trips refinance plans and lineage through a portable profile backup', () => {
    const source = openStore();
    initializeProfile(source, 'source-profile');
    addLoan(source, 'source-profile', 'source-loan', 300_000);
    addLoan(source, 'source-profile', 'unrelated-loan', 100_000);
    source.upsertManagedEntity('source-profile', 'asset', {
      id: 'portable-asset',
      name: 'Portable secured asset',
      type: 'tangible',
      valueCents: 400_000,
      valuationDate: '2026-07-15',
      linkedLiabilityId: 'source-loan',
      includedInNetWorth: true,
      includedInLiquidity: false,
    });
    const input: CommittedRefinancePlanInput = {
      id: 'portable-refinance',
      name: 'Portable refinance',
      closingDate: '2026-09-01',
      payoffDate: '2026-09-01',
      firstPaymentDate: '2026-10-01',
      payoffs: [{ sourceLoanId: 'source-loan', payoffAmountCents: 300_000 }],
      replacementLoan: replacementLoanInput(
        'portable-replacement',
        300_000,
        'source-profile-primary-cash',
      ),
      principalCashContributionCents: 0,
      closingCostsCents: 0,
      financedFeesCents: 0,
      excessProceedsCents: 0,
    };
    source.commitRefinancePlan('source-profile', input);
    const exported = source.exportPortableProfile('source-profile', '1.0.0-test');
    expect(exported.committedRefinancePlans).toHaveLength(1);
    expect(exported.recordTimestamps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'committed-refinance-plan',
          entityId: 'portable-refinance',
        }),
      ]),
    );

    const auditOnlyRelink = structuredClone(exported);
    auditOnlyRelink.exportedAt = '2026-07-15T00:00:00.000Z';
    auditOnlyRelink.committedRefinancePlans[0]!.assetRelinks = [];
    const commitAudit = auditOnlyRelink.auditEvents.find(
      (event) =>
        event.entityType === 'committed-refinance-plan' &&
        event.entityId === 'portable-refinance' &&
        event.action === 'commit',
    )!;
    commitAudit.payloadJson = JSON.stringify({
      assetRelinks: [
        {
          assetId: 'portable-asset',
          sourceLoanId: 'unrelated-loan',
          replacementLoanId: 'portable-replacement',
        },
      ],
    });
    const auditAttackDestination = openStore();
    initializeProfile(auditAttackDestination, 'audit-attack-destination');
    const auditAttackBefore = auditAttackDestination.getManagedRecords('audit-attack-destination');
    expect(() =>
      auditAttackDestination.replacePortableProfile('audit-attack-destination', auditOnlyRelink),
    ).toThrow(/future refinance replacement without durable relink history/i);
    expect(auditAttackDestination.getManagedRecords('audit-attack-destination')).toEqual(
      auditAttackBefore,
    );

    source.raw
      .prepare(
        `INSERT INTO assets (
           id, user_id, name, type, value_cents, valuation_date, linked_liability_id,
           included_in_net_worth, included_in_liquidity, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'untracked-replacement-asset',
        'source-profile',
        'Untracked replacement collateral',
        'tangible',
        100_000,
        '2026-07-15',
        'portable-replacement',
        1,
        0,
        '2026-07-15T00:00:00.000Z',
        '2026-07-15T00:00:00.000Z',
      );
    expect(() =>
      source.cancelCommittedRefinancePlan('source-profile', 'portable-refinance', '2026-07-15'),
    ).toThrow(/asset links .* future replacement without durable relink history/i);
    expect(source.getCommittedRefinancePlans('source-profile')[0]?.status).toBe('committed');
    expect(
      source
        .getManagedRecords('source-profile')
        .loans.find((loan) => loan.id === 'portable-replacement')?.status,
    ).toBe('active');
    expect(
      source
        .getManagedRecords('source-profile')
        .assets.find((asset) => asset.id === 'untracked-replacement-asset')?.linkedLiabilityId,
    ).toBe('portable-replacement');

    const destination = openStore();
    initializeProfile(destination, 'destination-profile');
    const destinationBeforeInvalidRestores = destination.getManagedRecords('destination-profile');
    const inconsistent = structuredClone(exported);
    inconsistent.committedRefinancePlans[0]!.replacementLoan.paymentCents += 1;
    expect(() => destination.replacePortableProfile('destination-profile', inconsistent)).toThrow(
      /do not match its loan record/i,
    );
    const missingOfferSnapshot = structuredClone(exported);
    delete missingOfferSnapshot.committedRefinancePlans[0]!.replacementLoanSnapshot;
    expect(() =>
      destination.replacePortableProfile('destination-profile', missingOfferSnapshot),
    ).toThrow(/missing its immutable replacement-loan offer snapshot/i);
    expect(destination.getManagedRecords('destination-profile')).toEqual(
      destinationBeforeInvalidRestores,
    );
    const missingAssetRelinks = structuredClone(exported);
    delete missingAssetRelinks.committedRefinancePlans[0]!.assetRelinks;
    expect(() =>
      destination.replacePortableProfile('destination-profile', missingAssetRelinks),
    ).toThrow(/missing its durable asset-relink history/i);
    const assetLinkedToRetiredSource = structuredClone(exported);
    assetLinkedToRetiredSource.assets[0]!.linkedLiabilityId = 'source-loan';
    expect(() =>
      destination.replacePortableProfile('destination-profile', assetLinkedToRetiredSource),
    ).toThrow(/asset linked to a loan retired by a committed refinance/i);
    const assetLinkedToUnrelatedLoan = structuredClone(exported);
    assetLinkedToUnrelatedLoan.assets[0]!.linkedLiabilityId = 'unrelated-loan';
    expect(() =>
      destination.replacePortableProfile('destination-profile', assetLinkedToUnrelatedLoan),
    ).toThrow(/asset link that does not match committed refinance history/i);
    const disabledSourceLoan = structuredClone(exported);
    disabledSourceLoan.loans.find((loan) => loan.id === 'source-loan')!.includeInCashForecast =
      false;
    expect(() =>
      destination.replacePortableProfile('destination-profile', disabledSourceLoan),
    ).toThrow(/lifecycle is managed by a committed refinance/i);
    const disabledReplacementLoan = structuredClone(exported);
    const disabledReplacementRecord = disabledReplacementLoan.loans.find(
      (loan) => loan.id === 'portable-replacement',
    )!;
    disabledReplacementRecord.status = 'paid-off';
    disabledReplacementRecord.includeInCashForecast = false;
    disabledReplacementLoan.committedRefinancePlans[0]!.replacementLoan = {
      ...disabledReplacementLoan.committedRefinancePlans[0]!.replacementLoan,
      status: 'paid-off',
      includeInCashForecast: false,
    };
    expect(() =>
      destination.replacePortableProfile('destination-profile', disabledReplacementLoan),
    ).toThrow(/lifecycle is managed by a committed refinance/i);
    const orphanRelink = structuredClone(exported);
    orphanRelink.committedRefinancePlans[0]!.assetRelinks![0]!.assetId = 'missing-asset';
    expect(() => destination.replacePortableProfile('destination-profile', orphanRelink)).toThrow(
      /unavailable refinance relink asset/i,
    );
    const maturedSource = structuredClone(exported);
    maturedSource.loans.find((loan) => loan.id === 'source-loan')!.maturityDate = '2026-08-01';
    expect(() => destination.replacePortableProfile('destination-profile', maturedSource)).toThrow(
      /no modeled debt/i,
    );
    destination.replacePortableProfile('destination-profile', exported);
    expect(destination.getCommittedRefinancePlans('destination-profile')).toEqual([
      expect.objectContaining({
        id: 'portable-refinance',
        userId: 'destination-profile',
        payoffs: [
          expect.objectContaining({ sourceLoanId: 'source-loan', payoffAmountCents: 300_000 }),
        ],
        replacementLoan: expect.objectContaining({
          id: 'portable-replacement',
          userId: 'destination-profile',
        }),
        replacementLoanSnapshot: expect.objectContaining({
          id: 'portable-replacement',
          userId: 'destination-profile',
        }),
        assetRelinks: [
          {
            assetId: 'portable-asset',
            sourceLoanId: 'source-loan',
            replacementLoanId: 'portable-replacement',
          },
        ],
      }),
    ]);
    expect(destination.getManagedRecords('destination-profile').assets[0]?.linkedLiabilityId).toBe(
      'portable-replacement',
    );
    destination.cancelCommittedRefinancePlan(
      'destination-profile',
      'portable-refinance',
      '2026-07-15',
    );
    expect(destination.getManagedRecords('destination-profile').assets[0]?.linkedLiabilityId).toBe(
      'source-loan',
    );
    expect(
      destination.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
    ).toEqual({ version: latestSchemaVersion });
  });
});
