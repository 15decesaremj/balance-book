import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BalanceBookStore,
  createEncryptedBackup,
  decryptBackup,
  latestSchemaVersion,
  LocalAuthService,
  maximumEncryptedBackupBytes,
  parsePortableProfileBackup,
  parseUserDataExport,
  readEncryptedBackup,
  writeUserExports,
  type PortableProfileBackup,
  type UserDataExport,
  type VerticalSliceInput,
} from '@balance-book/database';
import { createPasswordRequestSchema } from '../apps/desktop/src/shared/contracts';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];
const timestamp = '2026-07-15T12:00:00.000Z';

const makeTemporaryDirectory = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const openStore = (prefix: string): BalanceBookStore => {
  const directory = makeTemporaryDirectory(prefix);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'migration-backups'),
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

const emptyPortableProfile = (): PortableProfileBackup => ({
  format: 'balance-book-portable-profile',
  version: 2,
  exportedAt: timestamp,
  sourceAppVersion: '1.0.0-test',
  sourceSchemaVersion: latestSchemaVersion,
  sourceProfile: {
    id: 'source-profile',
    displayName: 'Synthetic source',
    username: 'synthetic-source',
    themePreference: 'dark',
    onboardingComplete: false,
  },
  onboardingDraft: null,
  accounts: [],
  events: [],
  policy: undefined,
  cards: [],
  cardCycles: [],
  loans: [],
  committedRefinancePlans: [],
  receivables: [],
  assets: [],
  rewardPrograms: [],
  reconciliations: [],
  savedScenarios: [],
  auditEvents: [],
  importBatches: [],
  importLineage: [],
  recordTimestamps: [],
  policyUpdatedAt: null,
});

const setup: VerticalSliceInput = {
  balanceAsOf: '2026-07-15',
  accountName: 'Synthetic checking',
  openingBalanceCents: 125_000,
  incomeLabel: 'Synthetic income',
  incomeDate: '2026-07-20',
  incomeAmountCents: 50_000,
  commitmentLabel: 'Synthetic bill',
  commitmentDate: '2026-07-18',
  commitmentAmountCents: 25_000,
  cardName: 'Synthetic card',
  cardEstimateCents: 10_000,
  cardPaymentDayOfMonth: 15,
  cardStatementCloseDayOfMonth: 25,
  cardEstimatePolicy: 'actual-reset',
  cardPaymentPolicy: 'full-statement',
  hardFloorCents: 10_000,
};

const formulaExport = (): UserDataExport => ({
  format: 'balance-book-user-data',
  version: 1,
  exportedAt: timestamp,
  policy: {
    hardConsolidatedFloorCents: 0,
    horizonDays: 90,
    includeConfirmedReceivablesConservatively: true,
  },
  accounts: [
    {
      id: 'formula-account',
      userId: 'formula-user',
      name: '=2+2',
      type: 'checking',
      openingBalanceCents: -12_345,
      balanceAsOf: '2026-07-15',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      transferDelayDays: 0,
    },
  ],
  events: [
    {
      id: 'formula-event-a',
      userId: 'formula-user',
      accountId: 'formula-account',
      date: '2026-07-16',
      kind: 'manual-adjustment',
      direction: 'outflow',
      amountCents: 100,
      certainty: 'confirmed',
      status: 'planned',
      label: '+SUM(1,1)',
      notes: '@external-link',
      hypothetical: false,
      accepted: false,
    },
    {
      id: 'formula-event-b',
      userId: 'formula-user',
      accountId: 'formula-account',
      date: '2026-07-17',
      kind: 'manual-adjustment',
      direction: 'inflow',
      amountCents: 200,
      certainty: 'confirmed',
      status: 'planned',
      label: '-10+20',
      hypothetical: false,
      accepted: false,
    },
  ],
  cards: [],
  cardCycles: [],
  loans: [],
  committedRefinancePlans: [],
  receivables: [],
  assets: [],
  rewardPrograms: [],
  reconciliations: [],
  savedScenarios: [],
});

describe('portable backup adversarial validation', () => {
  it('round-trips linked receipt history and rejects a backup with its receivable removed', () => {
    const source = openStore('balance-book-receivable-backup-source-');
    source.initializeProfiles([
      { id: 'source-profile', displayName: 'Source Profile', username: 'source-profile' },
    ]);
    source.saveVerticalSlice('source-profile', setup);
    const accountId = source.getManagedRecords('source-profile').accounts[0]!.id;
    source.upsertManagedEntity('source-profile', 'receivable', {
      id: 'portable-receivable',
      source: 'Synthetic source',
      description: 'Synthetic portable receipt history',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-07-20',
      destinationAccountId: accountId,
      certainty: 'confirmed',
    });
    const settlementId = source.recordReceivableSettlement({
      userId: 'source-profile',
      receivableId: 'portable-receivable',
      amountCents: 2_500,
      date: '2026-07-20',
      asOfDate: '2026-07-20',
    });
    const portable = source.exportPortableProfile('source-profile', '1.1.0-test');

    const destination = openStore('balance-book-receivable-backup-destination-');
    destination.initializeProfiles([
      {
        id: 'destination-profile',
        displayName: 'Destination Profile',
        username: 'destination-profile',
      },
    ]);
    destination.replacePortableProfile('destination-profile', portable);
    const restored = destination.getManagedRecords('destination-profile');
    expect(restored.receivables).toContainEqual(
      expect.objectContaining({ id: 'portable-receivable', userId: 'destination-profile' }),
    );
    expect(restored.events).toContainEqual(
      expect.objectContaining({ id: settlementId, sourceRecordId: 'portable-receivable' }),
    );

    const orphaned = structuredClone(portable);
    orphaned.receivables = [];
    expect(() => destination.replacePortableProfile('destination-profile', orphaned)).toThrow(
      /unavailable receivable settlement/i,
    );
    expect(destination.getManagedRecords('destination-profile').receivables).toContainEqual(
      expect.objectContaining({ id: 'portable-receivable' }),
    );
  });

  it('rejects conflicting, over-applied, or ambiguously linked recurring receipt history', () => {
    const source = openStore('balance-book-recurring-receipt-source-');
    source.initializeProfiles([
      { id: 'source-profile', displayName: 'Source Profile', username: 'source-profile' },
    ]);
    source.saveVerticalSlice('source-profile', setup);
    const accountId = source.getManagedRecords('source-profile').accounts[0]!.id;
    source.upsertManagedEntity('source-profile', 'receivable', {
      id: 'portable-recurring-receivable',
      source: 'Synthetic source',
      description: 'Synthetic recurring receipt history',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      recurringAmountCents: 10_000,
      expectedDate: '2026-07-20',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 20, interval: 1 },
      destinationAccountId: accountId,
      certainty: 'expected',
      includeInCashForecast: true,
    });
    const settlementId = source.recordReceivableSettlement({
      userId: 'source-profile',
      receivableId: 'portable-recurring-receivable',
      amountCents: 4_000,
      date: '2026-07-19',
      asOfDate: '2026-07-19',
      occurrenceDate: '2026-07-20',
    });
    const portable = source.exportPortableProfile('source-profile', '1.1.0-test');
    const receipt = portable.events.find((event) => event.id === settlementId)!;
    const receiptTimestamp = portable.recordTimestamps.find(
      (item) => item.entityType === 'forecast-event' && item.entityId === settlementId,
    )!;

    const destination = openStore('balance-book-recurring-receipt-destination-');
    destination.initializeProfiles([
      {
        id: 'destination-profile',
        displayName: 'Destination Profile',
        username: 'destination-profile',
      },
    ]);

    const conflicting = structuredClone(portable);
    conflicting.events.push({
      ...receipt,
      id: 'conflicting-target-receipt',
      amountCents: 1_000,
      receivableOccurrenceTargetCents: 12_000,
    });
    conflicting.recordTimestamps.push({
      ...receiptTimestamp,
      entityId: 'conflicting-target-receipt',
    });
    expect(() => destination.replacePortableProfile('destination-profile', conflicting)).toThrow(
      /conflicting receivable occurrence targets/i,
    );

    const overApplied = structuredClone(portable);
    overApplied.events = overApplied.events.map((event) =>
      event.id === settlementId ? { ...event, amountCents: 10_001 } : event,
    );
    expect(() => destination.replacePortableProfile('destination-profile', overApplied)).toThrow(
      /over-settles a receivable occurrence/i,
    );

    const conflictingIdentity = structuredClone(portable);
    conflictingIdentity.events = conflictingIdentity.events.map((event) =>
      event.id === settlementId
        ? {
            ...event,
            sourceRecordId: 'portable-recurring-receivable@2026-08-20',
          }
        : event,
    );
    expect(() =>
      destination.replacePortableProfile('destination-profile', conflictingIdentity),
    ).toThrow(/conflicting receivable occurrence identities/i);
  });

  it('rejects plaintext imports above the profile asset ceiling', () => {
    const data = formulaExport();
    const asset = {
      id: 'synthetic-asset',
      userId: 'formula-user',
      name: 'Synthetic asset',
      type: 'tangible' as const,
      valueCents: 1,
      valuationDate: '2026-07-15' as const,
      includedInNetWorth: true,
      includedInLiquidity: false,
    };
    expect(() =>
      parseUserDataExport({ ...data, assets: Array.from({ length: 50_001 }, () => asset) }),
    ).toThrow();
  });

  it('rejects non-canonical, malformed, and structurally invalid encrypted envelopes', async () => {
    const password = 'synthetic-envelope-password';
    const serialized = await createEncryptedBackup(emptyPortableProfile(), password);
    const envelope = JSON.parse(serialized) as Record<string, unknown> & {
      salt: string;
      iv: string;
      authTag: string;
      ciphertext: string;
      kdfParameters: Record<string, number>;
    };
    await expect(decryptBackup(serialized, password)).resolves.toMatchObject({
      format: 'balance-book-portable-profile',
      version: 2,
    });

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const significantIndex = envelope.salt.length - 3;
    const canonicalIndex = alphabet.indexOf(envelope.salt[significantIndex]!);
    const nonCanonicalIndex = (canonicalIndex & 0b11_0000) | ((canonicalIndex + 1) & 0b00_1111);
    const nonCanonicalSalt = `${envelope.salt.slice(0, significantIndex)}${alphabet[nonCanonicalIndex]}==`;
    expect(Buffer.from(nonCanonicalSalt, 'base64')).toEqual(Buffer.from(envelope.salt, 'base64'));
    expect(nonCanonicalSalt).not.toBe(envelope.salt);

    const corruptions: Array<(value: typeof envelope) => void> = [
      (value) => {
        value.salt = `${value.salt}\n`;
      },
      (value) => {
        value.salt = nonCanonicalSalt;
      },
      (value) => {
        value.salt = 'AAAA';
      },
      (value) => {
        value.iv = `${value.iv.slice(0, -1)}*`;
      },
      (value) => {
        value.authTag = value.authTag.replace(/=+$/, '');
      },
      (value) => {
        value.ciphertext = 'AAAA===';
      },
      (value) => {
        value.version = 3;
      },
      (value) => {
        value.kdfParameters = { ...value.kdfParameters, N: 16_384 };
      },
      (value) => {
        value.unexpected = true;
      },
    ];
    for (const corrupt of corruptions) {
      const malformed = structuredClone(envelope);
      corrupt(malformed);
      await expect(decryptBackup(JSON.stringify(malformed), password)).rejects.toThrow();
    }

    expect(() =>
      parsePortableProfileBackup({ ...emptyPortableProfile(), unexpected: true }),
    ).toThrow();
    expect(() => parsePortableProfileBackup({ ...emptyPortableProfile(), version: 3 })).toThrow();
  });

  it('rejects empty and oversized backup files before parsing their contents', async () => {
    const directory = makeTemporaryDirectory('balance-book-backup-size-test-');
    const emptyPath = path.join(directory, 'empty.balancebook-backup');
    const oversizedPath = path.join(directory, 'oversized.balancebook-backup');
    fs.writeFileSync(emptyPath, '');
    const descriptor = fs.openSync(oversizedPath, 'w');
    try {
      fs.ftruncateSync(descriptor, maximumEncryptedBackupBytes + 1);
    } finally {
      fs.closeSync(descriptor);
    }

    await expect(readEncryptedBackup(emptyPath, 'synthetic-file-password')).rejects.toThrow(
      /empty/i,
    );
    await expect(readEncryptedBackup(oversizedPath, 'synthetic-file-password')).rejects.toThrow(
      /too large/i,
    );
  });

  it('rejects malformed profile graphs without mutation and rolls back a mid-restore failure', async () => {
    const source = openStore('balance-book-portable-source-');
    source.initializeProfiles([
      { id: 'source-profile', displayName: 'Source shell', username: 'source-shell' },
    ]);
    const sourceAuth = new LocalAuthService(source);
    await sourceAuth.createPassword('source-profile', 'source-login-password', {
      displayName: 'Source identity',
      username: 'source-identity',
    });
    source.saveVerticalSlice('source-profile', setup);
    source.setTheme('source-profile', 'light');
    const portable = source.exportPortableProfile('source-profile', '1.0.0-test');

    const destination = openStore('balance-book-portable-destination-');
    destination.initializeProfiles([
      {
        id: 'destination-profile',
        displayName: 'Destination shell',
        username: 'destination-shell',
      },
    ]);
    const destinationAuth = new LocalAuthService(destination);
    await destinationAuth.createPassword('destination-profile', 'destination-login-password', {
      displayName: 'Destination identity',
      username: 'destination-identity',
    });
    destination.saveVerticalSlice('destination-profile', {
      ...setup,
      accountName: 'Existing destination checking',
      openingBalanceCents: 999_999,
    });
    const recordsBefore = structuredClone(destination.getManagedRecords('destination-profile'));
    const credentialsBefore = { ...destination.getCredentialsById('destination-profile')! };
    const auditBefore = destination.raw
      .prepare('SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ?')
      .get('destination-profile');

    const invalidReference = structuredClone(portable);
    invalidReference.cards[0]!.fundingAccountId = 'missing-account';
    expect(() =>
      destination.replacePortableProfile('destination-profile', invalidReference),
    ).toThrow(/unavailable card funding account/i);

    const mixedOwnership = structuredClone(portable);
    mixedOwnership.accounts[0]!.userId = 'another-source-profile';
    expect(() => destination.replacePortableProfile('destination-profile', mixedOwnership)).toThrow(
      /different source profile/i,
    );

    const missingTimestamp = structuredClone(portable);
    missingTimestamp.recordTimestamps = missingTimestamp.recordTimestamps.slice(1);
    expect(() =>
      destination.replacePortableProfile('destination-profile', missingTimestamp),
    ).toThrow(/missing record timestamps/i);

    for (const malformed of [invalidReference, mixedOwnership, missingTimestamp]) {
      expect(destination.getManagedRecords('destination-profile')).toEqual(recordsBefore);
      expect(destination.getCredentialsById('destination-profile')).toEqual(credentialsBefore);
      expect(
        destination.raw
          .prepare('SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ?')
          .get('destination-profile'),
      ).toEqual(auditBefore);
      expect(malformed).toBeTruthy();
    }

    destination.raw.exec(`
      CREATE TRIGGER reject_portable_restore
      BEFORE INSERT ON cash_accounts
      WHEN NEW.user_id = 'destination-profile'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic portable restore failure');
      END
    `);
    expect(() => destination.replacePortableProfile('destination-profile', portable)).toThrow(
      /synthetic portable restore failure/i,
    );
    destination.raw.exec('DROP TRIGGER reject_portable_restore');
    expect(destination.getManagedRecords('destination-profile')).toEqual(recordsBefore);
    expect(destination.getCredentialsById('destination-profile')).toEqual(credentialsBefore);
    expect(
      destination.raw
        .prepare('SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ?')
        .get('destination-profile'),
    ).toEqual(auditBefore);

    destination.replacePortableProfile('destination-profile', portable);
    const credentialsAfter = destination.getCredentialsById('destination-profile')!;
    expect(credentialsAfter).toMatchObject({
      id: 'destination-profile',
      displayName: 'Destination identity',
      username: 'destination-identity',
      passwordSalt: credentialsBefore.passwordSalt,
      passwordHash: credentialsBefore.passwordHash,
      themePreference: 'light',
    });
    expect(credentialsAfter.displayName).not.toBe(portable.sourceProfile.displayName);
    expect(credentialsAfter.username).not.toBe(portable.sourceProfile.username);
    await expect(
      destinationAuth.login('destination-identity', 'destination-login-password'),
    ).resolves.toMatchObject({ id: 'destination-profile' });
  });

  it('rejects ambiguous portable metadata before replacing destination data', () => {
    const source = openStore('balance-book-portable-metadata-source-');
    source.initializeProfiles([
      { id: 'source-profile', displayName: 'Source', username: 'source' },
    ]);
    source.saveVerticalSlice('source-profile', setup);
    const portable = source.exportPortableProfile('source-profile', '1.0.0-test');

    const destination = openStore('balance-book-portable-metadata-destination-');
    destination.initializeProfiles([
      { id: 'destination-profile', displayName: 'Destination', username: 'destination' },
    ]);
    destination.saveVerticalSlice('destination-profile', {
      ...setup,
      accountName: 'Existing data',
    });
    const before = structuredClone(destination.getManagedRecords('destination-profile'));

    const duplicateTimestamp = structuredClone(portable);
    duplicateTimestamp.recordTimestamps.push(
      structuredClone(duplicateTimestamp.recordTimestamps[0]!),
    );
    expect(() =>
      destination.replacePortableProfile('destination-profile', duplicateTimestamp),
    ).toThrow(/duplicate record timestamps/i);

    const unavailableTimestamp = structuredClone(portable);
    unavailableTimestamp.recordTimestamps[0]!.entityId = 'missing-record';
    expect(() =>
      destination.replacePortableProfile('destination-profile', unavailableTimestamp),
    ).toThrow(/timestamp for an unavailable record/i);

    const inconsistentPolicyTiming = structuredClone(portable);
    inconsistentPolicyTiming.policyUpdatedAt = null;
    expect(() =>
      destination.replacePortableProfile('destination-profile', inconsistentPolicyTiming),
    ).toThrow(/inconsistent policy timing/i);

    const duplicateLineage = structuredClone(portable);
    duplicateLineage.importBatches = [
      {
        sourceId: 'synthetic-batch',
        workbookChecksum: 'synthetic-checksum',
        sourceFileName: 'synthetic.xlsx',
        status: 'applied',
        createdAt: timestamp,
        rolledBackAt: null,
      },
    ];
    const lineage = {
      sourceId: 'synthetic-lineage-a',
      sourceBatchId: 'synthetic-batch',
      entityType: 'cash-account',
      entityId: portable.accounts[0]!.id,
      field: 'openingBalanceCents',
      sourceSheet: 'Synthetic',
      sourceRange: 'A1',
      rawValueJson: '125000',
      parsedValueJson: '125000',
      transformation: 'synthetic parse',
      confidence: 'high',
      warning: null,
      sourceChecksum: 'synthetic-checksum',
      destinationValueJson: '125000',
      destinationEditedAt: null,
      createdAt: timestamp,
    };
    const sheetLevelLineage = parsePortableProfileBackup({
      ...duplicateLineage,
      importLineage: [{ ...lineage, sourceRange: '' }],
    });
    expect(sheetLevelLineage.importLineage[0]!.sourceRange).toBe('');
    duplicateLineage.importLineage = [lineage, { ...lineage, sourceId: 'synthetic-lineage-b' }];
    expect(() =>
      destination.replacePortableProfile('destination-profile', duplicateLineage),
    ).toThrow(/duplicate import lineage fields/i);

    expect(destination.getManagedRecords('destination-profile')).toEqual(before);
  });
});

describe('portable export and profile identity boundaries', () => {
  it('neutralizes spreadsheet formulas without changing negative numeric values', () => {
    const directory = makeTemporaryDirectory('balance-book-formula-export-');
    const files = writeUserExports(directory, formulaExport());
    const accountsCsv = fs.readFileSync(
      files.find((file) => path.basename(file) === 'accounts.csv')!,
      'utf8',
    );
    const eventsCsv = fs.readFileSync(
      files.find((file) => path.basename(file) === 'events.csv')!,
      'utf8',
    );

    expect(accountsCsv).toContain("'=2+2");
    expect(accountsCsv).toContain('-12345');
    expect(accountsCsv).not.toContain("'-12345");
    expect(eventsCsv).toContain("'+SUM(1,1)");
    expect(eventsCsv).toContain("'-10+20");
    expect(eventsCsv).toContain("'@external-link");
  });

  it('uses a new export directory for each same-timestamp export', () => {
    const directory = makeTemporaryDirectory('balance-book-export-collision-');
    const data = formulaExport();
    const first = writeUserExports(directory, data);
    const firstDirectory = path.dirname(first[0]!);
    const firstJson = first.find((file) => path.basename(file) === 'balance-book-export.json')!;
    const firstContents = fs.readFileSync(firstJson, 'utf8');
    const second = writeUserExports(directory, data);
    const secondDirectory = path.dirname(second[0]!);

    expect(firstDirectory).not.toBe(secondDirectory);
    expect(path.basename(secondDirectory)).toBe(`${path.basename(firstDirectory)} (2)`);
    expect(new Set(first.map(path.dirname))).toEqual(new Set([firstDirectory]));
    expect(new Set(second.map(path.dirname))).toEqual(new Set([secondDirectory]));
    expect(fs.readFileSync(firstJson, 'utf8')).toBe(firstContents);
    expect(fs.readdirSync(directory)).toHaveLength(2);
  });

  it('requires complete strict identity input and preserves an unused shell on failure', async () => {
    const baseRequest = { profileId: 'profile-a', password: 'synthetic-login-password' };
    expect(
      createPasswordRequestSchema.safeParse({ ...baseRequest, displayName: 'Only name' }).success,
    ).toBe(false);
    expect(
      createPasswordRequestSchema.safeParse({ ...baseRequest, username: 'only-user' }).success,
    ).toBe(false);
    expect(
      createPasswordRequestSchema.safeParse({ ...baseRequest, unexpected: true }).success,
    ).toBe(false);
    expect(
      createPasswordRequestSchema.parse({
        ...baseRequest,
        displayName: '  Profile A  ',
        username: 'PROFILE.A',
      }),
    ).toMatchObject({ displayName: 'Profile A', username: 'profile.a' });

    const store = openStore('balance-book-identity-failure-');
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'First shell', username: 'first-shell' },
      { id: 'profile-b', displayName: 'Second shell', username: 'second-shell' },
    ]);
    const auth = new LocalAuthService(store);
    await expect(
      auth.createPassword('profile-b', 'synthetic-login-password', {
        displayName: 'X'.repeat(121),
        username: 'valid-user',
      }),
    ).rejects.toThrow(/invalid/i);
    expect(store.getCredentialsById('profile-b')).toMatchObject({
      displayName: 'Second shell',
      username: 'second-shell',
      passwordSet: false,
    });
    await expect(
      auth.createPassword('profile-b', 'synthetic-login-password', {
        displayName: 'Duplicate username',
        username: 'first-shell',
      }),
    ).rejects.toThrow();
    expect(store.getCredentialsById('profile-b')).toMatchObject({
      displayName: 'Second shell',
      username: 'second-shell',
      passwordSet: false,
    });
  });
});
