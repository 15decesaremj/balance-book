import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  BalanceBookStore,
  readEncryptedBackup,
  writeEncryptedBackup,
} from '../packages/database/src/index';

const argument = (name: string, required = true): string | undefined => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} is required`);
  return value;
};

const countRecords = (records: ReturnType<BalanceBookStore['getManagedRecords']>): number =>
  Object.values(records).reduce(
    (total, value) => total + (Array.isArray(value) ? value.length : 0),
    0,
  );

const containsCredentialMaterial = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) =>
      ['passwordHash', 'passwordSalt', 'failedLoginAttempts', 'lockedUntil'].includes(key) ||
      containsCredentialMaterial(child),
  );
};

const databasePath = path.resolve(argument('--database')!);
const outputPath = path.resolve(argument('--output')!);
const sourceVersion = argument('--source-version', false) ?? '1.1.2';
const requestedProfileId = argument('--profile-id', false);
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
if (!fs.existsSync(databasePath)) throw new Error('Source database does not exist');

const workDirectory = path.resolve('local-release-work', 'migration-backups');
const store = new BalanceBookStore({ databasePath, backupDirectory: workDirectory });

try {
  const candidates = store
    .listProfiles()
    .map((profile) => ({ profile, records: store.getManagedRecords(profile.id) }));
  if (candidates.length === 0) throw new Error('The database contains no profiles');

  const selected = requestedProfileId
    ? candidates.find(({ profile }) => profile.id === requestedProfileId)
    : candidates.sort((left, right) => {
        const countDifference = countRecords(right.records) - countRecords(left.records);
        if (countDifference !== 0) return countDifference;
        return Number(right.profile.onboardingComplete) - Number(left.profile.onboardingComplete);
      })[0];

  if (!selected) throw new Error('Requested profile was not found');
  if (!requestedProfileId && candidates.length > 1) {
    const firstCount = countRecords(selected.records);
    const tied = candidates.filter(
      ({ profile, records }) =>
        profile.id !== selected.profile.id && countRecords(records) === firstCount,
    );
    if (tied.length > 0) {
      throw new Error('Multiple profiles have the same record count; pass --profile-id explicitly');
    }
  }

  const portable = store.exportPortableProfile(selected.profile.id, sourceVersion);
  if (containsCredentialMaterial(portable)) {
    throw new Error('Portable data unexpectedly contains local credential material');
  }

  await writeEncryptedBackup(outputPath, portable, password);
  const verified = await readEncryptedBackup(outputPath, password);
  if (verified.format !== portable.format || verified.exportedAt !== portable.exportedAt) {
    throw new Error('Encrypted backup read-back did not match the exported profile');
  }

  const serialized = fs.readFileSync(outputPath);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      fileSize: serialized.byteLength,
      sha256,
      managedRecordCount: countRecords(selected.records),
      auditEventCount: portable.auditEvents.length,
      importBatchCount: portable.importBatches.length,
      importLineageCount: portable.importLineage.length,
    })}\n`,
  );
} finally {
  store.close();
}
