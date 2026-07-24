import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  BalanceBookStore,
  LocalAuthService,
  type ManagedRecords,
  readEncryptedBackup,
} from '../packages/database/src/index';

const argument = (name: string, required = true): string | undefined => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} is required`);
  return value;
};

const normalized = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(normalized);
    return items.every(
      (item) => item && typeof item === 'object' && 'id' in (item as Record<string, unknown>),
    )
      ? items.sort((left, right) =>
          String((left as Record<string, unknown>).id).localeCompare(
            String((right as Record<string, unknown>).id),
          ),
        )
      : items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, key === 'userId' ? '<profile>' : normalized(child)]),
  );
};

const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(normalized(value)) ?? 'undefined')
    .digest('hex');

const backupPath = path.resolve(argument('--backup')!);
const readPassword = async (): Promise<string> => {
  if (process.env.BALANCE_BOOK_BACKUP_PASSWORD) return process.env.BALANCE_BOOK_BACKUP_PASSWORD;
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  throw new Error('Backup password was not provided');
};
const password = await readPassword();
if (!password) throw new Error('Backup password is required');
if (!fs.existsSync(backupPath)) throw new Error('Backup file does not exist');

const portable = await readEncryptedBackup(backupPath, password);
if (portable.format !== 'balance-book-portable-profile' || portable.version !== 3) {
  throw new Error('V1 portability verification requires a normalized version 3 portable profile');
}

const temporaryBase = path.resolve(argument('--work-root', false) ?? os.tmpdir());
fs.mkdirSync(temporaryBase, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(temporaryBase, 'BalanceBookPortableVerify-'));
const databasePath = path.join(temporaryRoot, 'balance-book.sqlite');
const backupDirectory = path.join(temporaryRoot, 'migration-backups');
const destinationProfile = {
  id: 'portable-restore-profile',
  displayName: 'Portable Restore',
  username: 'portable-restore',
};
const localLoginPassword = `Bb-${randomBytes(24).toString('base64url')}`;

let store: BalanceBookStore | undefined;
try {
  store = new BalanceBookStore({ databasePath, backupDirectory });
  store.initializeProfiles([destinationProfile]);
  const auth = new LocalAuthService(store);
  await auth.createPassword(destinationProfile.id, localLoginPassword, destinationProfile);
  const credentialsBefore = store.getCredentialsById(destinationProfile.id)!;

  store.replacePortableProfile(destinationProfile.id, portable);
  const credentialsAfter = store.getCredentialsById(destinationProfile.id)!;
  if (
    credentialsAfter.displayName !== destinationProfile.displayName ||
    credentialsAfter.username !== destinationProfile.username ||
    credentialsAfter.passwordHash !== credentialsBefore.passwordHash ||
    credentialsAfter.passwordSalt !== credentialsBefore.passwordSalt
  ) {
    throw new Error('Restore changed the destination login identity or password');
  }
  if (
    credentialsAfter.themePreference !== portable.sourceProfile.themePreference ||
    digest(credentialsAfter.preferences) !== digest(portable.sourceProfile.preferences) ||
    credentialsAfter.onboardingComplete !== portable.sourceProfile.onboardingComplete
  ) {
    throw new Error('Restore did not preserve portable theme, preferences, or onboarding state');
  }

  const expectedRecords: ManagedRecords = {
    accounts: portable.accounts,
    events: portable.events,
    policy: portable.policy,
    cards: portable.cards,
    cardCycles: portable.cardCycles,
    loans: portable.loans,
    receivables: portable.receivables,
    assets: portable.assets,
    rewardPrograms: portable.rewardPrograms,
    reconciliations: portable.reconciliations,
    savedScenarios: portable.savedScenarios,
    committedRefinancePlans: portable.committedRefinancePlans,
  };
  const restoredRecords = store.getManagedRecords(destinationProfile.id);
  if (digest(restoredRecords) !== digest(expectedRecords)) {
    throw new Error('Restored financial records do not match the portable profile');
  }
  if (digest(store.getForecastData(destinationProfile.id)?.policy) !== digest(portable.policy)) {
    throw new Error('Restored forecast policy does not match the portable profile');
  }

  const restoredPortable = store.exportPortableProfile(destinationProfile.id, '1.1.9');
  if (restoredPortable.auditEvents.length !== portable.auditEvents.length + 1) {
    throw new Error('Audit history was not restored with exactly one restore audit event');
  }
  if (
    restoredPortable.importBatches.length !== portable.importBatches.length ||
    restoredPortable.importLineage.length !== portable.importLineage.length
  ) {
    throw new Error('Import lineage was not restored completely');
  }
  const integrity = store.raw.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);

  store.close();
  store = undefined;

  store = new BalanceBookStore({ databasePath, backupDirectory });
  await new LocalAuthService(store).login(destinationProfile.username, localLoginPassword);
  if (digest(store.getManagedRecords(destinationProfile.id)) !== digest(expectedRecords)) {
    throw new Error('Restored records changed after a full database restart');
  }
  const restartedCredentials = store.getCredentialsById(destinationProfile.id)!;
  if (
    restartedCredentials.themePreference !== portable.sourceProfile.themePreference ||
    digest(restartedCredentials.preferences) !== digest(portable.sourceProfile.preferences) ||
    restartedCredentials.onboardingComplete !== portable.sourceProfile.onboardingComplete
  ) {
    throw new Error('Restored theme, preferences, or onboarding state changed after restart');
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      portableDigest: digest(expectedRecords),
      managedRecordCount: Object.values(expectedRecords).reduce(
        (total, value) => total + (Array.isArray(value) ? value.length : 0),
        0,
      ),
      auditEventCount: restoredPortable.auditEvents.length,
      importBatchCount: restoredPortable.importBatches.length,
      importLineageCount: restoredPortable.importLineage.length,
      experiencePreferencesVerified: true,
      restartLoginVerified: true,
      sqliteIntegrity: 'ok',
    })}\n`,
  );
} finally {
  store?.close();
  const safePrefix = `${temporaryBase}${path.sep}`;
  if (
    temporaryRoot.startsWith(safePrefix) &&
    path.basename(temporaryRoot).startsWith('BalanceBookPortableVerify-')
  ) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
