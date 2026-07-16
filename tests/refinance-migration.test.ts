import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, latestSchemaVersion } from '@balance-book/database';

const temporaryDirectories: string[] = [];
const databases: Array<InstanceType<typeof BetterSqlite3>> = [];

const createLegacyDatabase = (
  version: 18 | 19 | 20,
): {
  database: InstanceType<typeof BetterSqlite3>;
  databasePath: string;
  directory: string;
} => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-refinance-migration-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'balance-book.sqlite');
  const database = new BetterSqlite3(databasePath);
  databases.push(database);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations VALUES
      (13, 'dark-first-interface-default', '2026-07-15T00:00:00.000Z'),
      (${version}, 'legacy-refinance-version', '2026-07-15T00:00:00.000Z');
    CREATE TABLE committed_refinance_plans (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      replacement_loan_id TEXT NOT NULL
      ${version >= 19 ? ", asset_relinks_json TEXT NOT NULL DEFAULT '[]'" : ''}
    );
    CREATE TABLE committed_refinance_payoffs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      source_loan_id TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE assets (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      linked_liability_id TEXT
    );
    CREATE TABLE loans (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL
    );
    INSERT INTO committed_refinance_plans (id, user_id, replacement_loan_id)
      VALUES ('plan-a', 'profile-a', 'replacement-a');
    INSERT INTO committed_refinance_payoffs (id, user_id, plan_id, source_loan_id)
      VALUES ('payoff-a', 'profile-a', 'plan-a', 'source-a');
    INSERT INTO loans VALUES ('source-a', 'profile-a'), ('replacement-a', 'profile-a');
    INSERT INTO assets VALUES ('asset-a', 'profile-a', 'replacement-a');
    INSERT INTO audit_events VALUES (
      'audit-a', 'profile-a', 'commit', 'committed-refinance-plan', 'plan-a',
      '{"plan":{"id":"plan-a"},"assetRelinks":[{"assetId":"asset-a","sourceLoanId":"source-a","replacementLoanId":"replacement-a"}]}',
      '2026-07-15T00:00:00.000Z'
    );
  `);
  return { database, databasePath, directory };
};

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('refinance collateral-lineage migration', () => {
  it.each([18, 19, 20] as const)(
    'backfills audit-retained relinks from schema v%s through the repair migration',
    (version) => {
      const { database, databasePath, directory } = createLegacyDatabase(version);

      applyMigrations({
        database,
        databasePath,
        backupDirectory: path.join(directory, 'backups'),
      });

      expect(
        database
          .prepare(
            'SELECT asset_relinks_json AS assetRelinksJson FROM committed_refinance_plans WHERE id = ?',
          )
          .get('plan-a'),
      ).toEqual({
        assetRelinksJson: JSON.stringify([
          {
            assetId: 'asset-a',
            sourceLoanId: 'source-a',
            replacementLoanId: 'replacement-a',
          },
        ]),
      });
      const audit = database
        .prepare('SELECT payload_json AS payloadJson FROM audit_events WHERE id = ?')
        .get('audit-a') as { payloadJson: string };
      expect(JSON.parse(audit.payloadJson)).toMatchObject({
        plan: { id: 'plan-a', replacementLoanId: 'replacement-a' },
        assetRelinkCount: 1,
        migratedLegacyAssetRelinks: true,
      });
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({ version: latestSchemaVersion });
    },
  );

  it('leaves a mixed valid and invalid legacy audit payload entirely unmodified', () => {
    const { database, databasePath, directory } = createLegacyDatabase(19);
    database.prepare('UPDATE audit_events SET payload_json = ? WHERE id = ?').run(
      JSON.stringify({
        assetRelinks: [
          {
            assetId: 'asset-a',
            sourceLoanId: 'source-a',
            replacementLoanId: 'replacement-a',
          },
          {
            assetId: 'missing-asset',
            sourceLoanId: 'source-a',
            replacementLoanId: 'replacement-a',
          },
        ],
      }),
      'audit-a',
    );

    applyMigrations({
      database,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
    });

    expect(
      database
        .prepare('SELECT asset_relinks_json AS assetRelinksJson FROM committed_refinance_plans')
        .get(),
    ).toEqual({ assetRelinksJson: '[]' });
  });

  it('backfills every relink when a valid legacy plan has more than one thousand assets', () => {
    const { database, databasePath, directory } = createLegacyDatabase(19);
    database.prepare('DELETE FROM assets').run();
    const relinks = Array.from({ length: 1_001 }, (_, index) => ({
      assetId: `asset-${index}`,
      sourceLoanId: 'source-a',
      replacementLoanId: 'replacement-a',
    }));
    const insertAsset = database.prepare(
      'INSERT INTO assets (id, user_id, linked_liability_id) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (const relink of relinks) {
        insertAsset.run(relink.assetId, 'profile-a', 'replacement-a');
      }
    })();
    database
      .prepare('UPDATE audit_events SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ assetRelinks: relinks }), 'audit-a');

    applyMigrations({
      database,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
    });

    const row = database
      .prepare('SELECT asset_relinks_json AS assetRelinksJson FROM committed_refinance_plans')
      .get() as { assetRelinksJson: string };
    expect(JSON.parse(row.assetRelinksJson)).toHaveLength(1_001);
  });
});
