import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATABASE_FILE = 'balance-book.sqlite';
const JOURNAL_FILE = 'legacy-profile-migration.json';
const STAGING_FILE = `${DATABASE_FILE}.migrating`;
const JOURNAL_FORMAT = 'balance-book-store-profile-migration';
const JOURNAL_VERSION = 1;

type MigrationJournal = {
  format: typeof JOURNAL_FORMAT;
  version: typeof JOURNAL_VERSION;
  state: 'started' | 'complete';
  startedAt: string;
  completedAt?: string;
  recoverySnapshot: string;
  sourceDatabaseSha256: string;
  destinationDatabaseSha256?: string;
};

export type StoreProfileMigrationResult =
  | { state: 'not-needed'; reason: 'no-legacy-profile' | 'store-profile-exists' }
  | {
      state: 'migrated';
      recoverySnapshot: string;
      sourceDatabaseSha256: string;
      destinationDatabaseSha256: string;
    }
  | {
      state: 'recovered';
      recoverySnapshot: string;
      destinationDatabaseSha256: string;
    };

const databaseIntegrity = (databasePath: string): void => {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('The profile database did not pass its integrity check.');
    }
  } finally {
    database.close();
  }
};

const sha256 = (filePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const safeTimestamp = (date: Date): string => date.toISOString().replaceAll(/[:.]/gu, '-');

const writeJournal = (journalPath: string, journal: MigrationJournal): void => {
  const temporaryPath = `${journalPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, journalPath);
};

const readJournal = (journalPath: string): MigrationJournal | undefined => {
  if (!fs.existsSync(journalPath)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<MigrationJournal>;
  if (
    parsed.format !== JOURNAL_FORMAT ||
    parsed.version !== JOURNAL_VERSION ||
    !['started', 'complete'].includes(parsed.state ?? '') ||
    typeof parsed.startedAt !== 'string' ||
    typeof parsed.recoverySnapshot !== 'string' ||
    typeof parsed.sourceDatabaseSha256 !== 'string'
  ) {
    throw new Error('The Store profile migration journal is not valid.');
  }
  return parsed as MigrationJournal;
};

const copyLegacyRecoveryDirectories = (
  sourceDirectory: string,
  destinationDirectory: string,
  timestamp: string,
): void => {
  const recoveryRoot = path.join(destinationDirectory, 'legacy-recovery', timestamp);
  for (const name of ['migration-backups', 'update-backups']) {
    const source = path.join(sourceDirectory, name);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(recoveryRoot, name), {
      recursive: true,
      errorOnExist: false,
      force: false,
    });
  }
};

const recoverySnapshotPath = (storeDataDirectory: string, relativeSnapshot: string): string => {
  if (path.isAbsolute(relativeSnapshot)) {
    throw new Error('The Store profile migration recovery path is not valid.');
  }
  const resolved = path.resolve(storeDataDirectory, relativeSnapshot);
  const root = `${path.resolve(storeDataDirectory)}${path.sep}`;
  if (!resolved.startsWith(root)) {
    throw new Error('The Store profile migration recovery path is not valid.');
  }
  return resolved;
};

export const migrateLegacyProfileToStore = async (input: {
  legacyDataDirectory: string;
  storeDataDirectory: string;
  now?: Date;
}): Promise<StoreProfileMigrationResult> => {
  const legacyDataDirectory = path.resolve(input.legacyDataDirectory);
  const storeDataDirectory = path.resolve(input.storeDataDirectory);
  if (legacyDataDirectory === storeDataDirectory) {
    throw new Error('The Store profile directory must be separate from the legacy profile.');
  }

  const sourceDatabasePath = path.join(legacyDataDirectory, DATABASE_FILE);
  const destinationDatabasePath = path.join(storeDataDirectory, DATABASE_FILE);
  const stagingDatabasePath = path.join(storeDataDirectory, STAGING_FILE);
  const journalPath = path.join(storeDataDirectory, JOURNAL_FILE);
  const existingJournal = readJournal(journalPath);

  if (fs.existsSync(destinationDatabasePath)) {
    databaseIntegrity(destinationDatabasePath);
    const destinationDatabaseSha256 = sha256(destinationDatabasePath);
    if (existingJournal?.state === 'started') {
      if (destinationDatabaseSha256 !== existingJournal.sourceDatabaseSha256) {
        throw new Error('The interrupted Store profile does not match its recovery snapshot.');
      }
      const recoverySnapshot = recoverySnapshotPath(
        storeDataDirectory,
        existingJournal.recoverySnapshot,
      );
      if (
        !fs.existsSync(recoverySnapshot) ||
        sha256(recoverySnapshot) !== existingJournal.sourceDatabaseSha256
      ) {
        throw new Error('The Store profile migration recovery snapshot is missing or changed.');
      }
      copyLegacyRecoveryDirectories(
        legacyDataDirectory,
        storeDataDirectory,
        safeTimestamp(new Date(existingJournal.startedAt)),
      );
      writeJournal(journalPath, {
        ...existingJournal,
        state: 'complete',
        completedAt: (input.now ?? new Date()).toISOString(),
        destinationDatabaseSha256,
      });
      return {
        state: 'recovered',
        recoverySnapshot: existingJournal.recoverySnapshot,
        destinationDatabaseSha256,
      };
    }
    return { state: 'not-needed', reason: 'store-profile-exists' };
  }

  if (!fs.existsSync(sourceDatabasePath)) {
    return { state: 'not-needed', reason: 'no-legacy-profile' };
  }

  fs.mkdirSync(storeDataDirectory, { recursive: true });
  fs.rmSync(stagingDatabasePath, { force: true });

  const now = input.now ?? new Date();
  const timestamp = safeTimestamp(now);
  const recoveryDirectory = path.join(storeDataDirectory, 'migration-backups');
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  const recoverySnapshot = path.join(
    recoveryDirectory,
    `before-store-migration-${timestamp}.sqlite`,
  );

  const source = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
  try {
    source.pragma('query_only = ON');
    if (source.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('The existing Balance Book profile did not pass its integrity check.');
    }
    await source.backup(recoverySnapshot);
  } finally {
    source.close();
  }
  databaseIntegrity(recoverySnapshot);
  const sourceDatabaseSha256 = sha256(recoverySnapshot);
  const startedJournal: MigrationJournal = {
    format: JOURNAL_FORMAT,
    version: JOURNAL_VERSION,
    state: 'started',
    startedAt: now.toISOString(),
    recoverySnapshot: path.relative(storeDataDirectory, recoverySnapshot),
    sourceDatabaseSha256,
  };
  writeJournal(journalPath, startedJournal);

  fs.copyFileSync(recoverySnapshot, stagingDatabasePath, fs.constants.COPYFILE_EXCL);
  databaseIntegrity(stagingDatabasePath);
  if (sha256(stagingDatabasePath) !== sourceDatabaseSha256) {
    throw new Error('The copied Store profile does not match its recovery snapshot.');
  }
  fs.renameSync(stagingDatabasePath, destinationDatabasePath);
  databaseIntegrity(destinationDatabasePath);
  const destinationDatabaseSha256 = sha256(destinationDatabasePath);
  if (destinationDatabaseSha256 !== sourceDatabaseSha256) {
    throw new Error('The completed Store profile does not match its recovery snapshot.');
  }

  copyLegacyRecoveryDirectories(legacyDataDirectory, storeDataDirectory, timestamp);
  writeJournal(journalPath, {
    ...startedJournal,
    state: 'complete',
    completedAt: now.toISOString(),
    destinationDatabaseSha256,
  });
  return {
    state: 'migrated',
    recoverySnapshot,
    sourceDatabaseSha256,
    destinationDatabaseSha256,
  };
};
