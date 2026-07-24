import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

type TableEvidence = {
  rows: number;
  sha256: string;
};

const argument = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path.`);
  return path.resolve(value);
};

const legacyDirectory = argument('--legacy');
const storeDirectory = argument('--store');
if (legacyDirectory === storeDirectory) throw new Error('Legacy and Store paths must be separate.');

const legacyDatabasePath = path.join(legacyDirectory, 'balance-book.sqlite');
const storeDatabasePath = path.join(storeDirectory, 'balance-book.sqlite');
const journalPath = path.join(storeDirectory, 'legacy-profile-migration.json');
for (const filePath of [legacyDatabasePath, storeDatabasePath, journalPath]) {
  if (!fs.existsSync(filePath))
    throw new Error(`Required migration evidence is missing: ${filePath}`);
}

const sha256File = (filePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const normalizeCell = (value: unknown): unknown => {
  if (Buffer.isBuffer(value)) return { blobBase64: value.toString('base64') };
  if (typeof value === 'bigint') return value.toString();
  return value;
};

const databaseEvidence = (databasePath: string): Map<string, TableEvidence> => {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error(`SQLite integrity failed: ${databasePath}`);
    }
    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .pluck()
      .all() as string[];
    const evidence = new Map<string, TableEvidence>();
    for (const table of tables) {
      const columns = database
        .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all() as Array<{
        name: string;
      }>;
      if (columns.length === 0) throw new Error(`Table has no columns: ${table}`);
      const orderBy = columns.map(({ name }) => quoteIdentifier(name)).join(', ');
      const rows = database
        .prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`)
        .all() as Array<Record<string, unknown>>;
      const digest = crypto.createHash('sha256');
      for (const row of rows) {
        digest.update(
          `${JSON.stringify(
            Object.fromEntries(
              Object.entries(row).map(([name, value]) => [name, normalizeCell(value)]),
            ),
          )}\n`,
        );
      }
      evidence.set(table, { rows: rows.length, sha256: digest.digest('hex') });
    }
    return evidence;
  } finally {
    database.close();
  }
};

const legacyEvidence = databaseEvidence(legacyDatabasePath);
const storeEvidence = databaseEvidence(storeDatabasePath);
if (JSON.stringify([...storeEvidence]) !== JSON.stringify([...legacyEvidence])) {
  throw new Error('The Store database table evidence does not match the legacy profile.');
}

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
  format?: unknown;
  version?: unknown;
  state?: unknown;
  recoverySnapshot?: unknown;
  sourceDatabaseSha256?: unknown;
  destinationDatabaseSha256?: unknown;
};
if (
  journal.format !== 'balance-book-store-profile-migration' ||
  journal.version !== 1 ||
  journal.state !== 'complete' ||
  typeof journal.recoverySnapshot !== 'string' ||
  typeof journal.sourceDatabaseSha256 !== 'string' ||
  typeof journal.destinationDatabaseSha256 !== 'string'
) {
  throw new Error('The Store migration journal is incomplete or invalid.');
}
if (path.isAbsolute(journal.recoverySnapshot)) {
  throw new Error('The recovery snapshot path must be Store-relative.');
}
const recoverySnapshot = path.resolve(storeDirectory, journal.recoverySnapshot);
const storeRoot = `${path.resolve(storeDirectory)}${path.sep}`;
if (!recoverySnapshot.startsWith(storeRoot) || !fs.existsSync(recoverySnapshot)) {
  throw new Error('The recovery snapshot is missing or outside the Store profile.');
}
const recoveryHash = sha256File(recoverySnapshot);
const destinationHash = sha256File(storeDatabasePath);
if (
  recoveryHash !== journal.sourceDatabaseSha256 ||
  destinationHash !== journal.destinationDatabaseSha256 ||
  recoveryHash !== destinationHash
) {
  throw new Error('The Store migration file hashes do not match the recovery journal.');
}

const totalRows = [...storeEvidence.values()].reduce((sum, table) => sum + table.rows, 0);
process.stdout.write(
  `${JSON.stringify(
    {
      format: 'balance-book-store-profile-copy-evidence',
      tableCount: storeEvidence.size,
      totalRows,
      storeDatabaseSha256: destinationHash,
      recoverySnapshotSha256: recoveryHash,
      integrity: 'ok',
      tableEvidenceMatches: true,
    },
    null,
    2,
  )}\n`,
);
