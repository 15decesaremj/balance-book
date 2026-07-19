import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, latestSchemaVersion } from '@balance-book/database';

const temporaryDirectories: string[] = [];
const databases: Array<InstanceType<typeof BetterSqlite3>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('imported static receivable date repair', () => {
  it('repairs only untouched imported placeholders and records a backed-up audited migration', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-static-receivable-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'balance-book.sqlite');
    const backupDirectory = path.join(directory, 'backups');
    const database = new BetterSqlite3(databasePath);
    databases.push(database);
    applyMigrations({ database, databasePath, backupDirectory });

    database.exec(`
      INSERT INTO profiles (
        id, display_name, username, onboarding_complete, theme_preference, created_at, updated_at
      ) VALUES (
        'synthetic-profile', 'Synthetic profile', 'synthetic-profile', 1, 'dark',
        '2041-02-17T10:00:00.000Z', '2041-02-17T10:00:00.000Z'
      );
      INSERT INTO cash_accounts (
        id, user_id, name, type, opening_balance_cents, balance_as_of,
        included_in_liquidity, can_fund_other_accounts, created_at, updated_at
      ) VALUES (
        'synthetic-account', 'synthetic-profile', 'Synthetic checking', 'checking', 500000,
        '2041-02-17', 1, 1, '2041-02-17T10:00:00.000Z', '2041-02-17T10:00:00.000Z'
      );
      INSERT INTO import_batches (
        id, user_id, workbook_checksum, source_file_name, status, created_at
      ) VALUES (
        'synthetic-import', 'synthetic-profile', 'synthetic-checksum', 'synthetic-source.xlsx',
        'completed', '2041-02-17T10:00:00.000Z'
      );
    `);

    const insertReceivable = database.prepare(
      `INSERT INTO receivables (
         id, user_id, source, description, original_amount_cents, remaining_amount_cents,
         expected_date, settlement_date_confirmed, destination_account_id, certainty,
         recurring_amount_cents, recurrence_json, recurrence_end_date,
         include_in_cash_forecast, accrual_amount_cents, accrual_date,
         accrual_recurrence_json, created_at, updated_at
       ) VALUES (
         @id, 'synthetic-profile', 'Synthetic counterparty', @description,
         @originalAmountCents, @remainingAmountCents, @expectedDate, @settlementDateConfirmed,
         'synthetic-account', @certainty, @recurringAmountCents, @recurrenceJson, NULL,
         @includeInCashForecast, NULL, NULL, NULL,
         '2041-02-17T10:00:00.000Z', @updatedAt
       )`,
    );
    const base = {
      originalAmountCents: 12_345,
      remainingAmountCents: 12_345,
      expectedDate: '2041-02-17',
      settlementDateConfirmed: 0,
      certainty: 'confirmed',
      recurringAmountCents: null,
      recurrenceJson: null,
      includeInCashForecast: 0,
      updatedAt: '2041-02-17T10:00:00.000Z',
    };
    const receivables = [
      { id: 'eligible-static', description: 'Eligible static balance' },
      { id: 'edited-lineage', description: 'User-edited imported balance' },
      {
        id: 'touched-record',
        description: 'Timestamp-edited balance',
        updatedAt: '2041-02-18T10:00:00.000Z',
      },
      {
        id: 'recurring-record',
        description: 'Recurring balance',
        recurringAmountCents: 2_500,
        recurrenceJson: '{"frequency":"monthly","dayOfMonth":17,"interval":1}',
      },
      { id: 'settled-history', description: 'Balance with receipt history' },
      {
        id: 'different-placeholder-date',
        description: 'Different placeholder date',
        expectedDate: '2041-02-18',
      },
      { id: 'missing-lineage', description: 'Balance without import lineage' },
      {
        id: 'confirmed-date',
        description: 'Confirmed receipt date',
        settlementDateConfirmed: 1,
      },
      {
        id: 'zero-balance',
        description: 'Settled balance',
        remainingAmountCents: 0,
      },
      {
        id: 'uncertain-balance',
        description: 'Uncertain imported balance',
        certainty: 'uncertain',
      },
    ];
    for (const receivable of receivables) {
      insertReceivable.run({ ...base, ...receivable });
    }

    const insertLineage = database.prepare(
      `INSERT INTO import_lineage (
         id, user_id, batch_id, entity_type, entity_id, field, source_sheet, source_range,
         raw_value_json, parsed_value_json, transformation, confidence, warning, source_checksum,
         destination_value_json, destination_edited_at, created_at
       ) VALUES (
         @id, 'synthetic-profile', 'synthetic-import', 'receivable', @entityId, @field,
         'Synthetic', @sourceRange, '{}', '{}', 'synthetic fixture', 'high', NULL,
         'synthetic-checksum', '{}', @destinationEditedAt, '2041-02-17T10:00:00.000Z'
       )`,
    );
    let lineageIndex = 0;
    for (const receivable of receivables.filter((item) => item.id !== 'missing-lineage')) {
      for (const field of ['expectedDate', 'includeInCashForecast', 'description']) {
        lineageIndex += 1;
        insertLineage.run({
          id: `synthetic-lineage-${lineageIndex}`,
          entityId: receivable.id,
          field,
          sourceRange: `R${lineageIndex}`,
          destinationEditedAt:
            receivable.id === 'edited-lineage' && field === 'expectedDate'
              ? '2041-02-18T10:00:00.000Z'
              : null,
        });
      }
    }

    database
      .prepare(
        `INSERT INTO forecast_events (
           id, user_id, account_id, date, kind, direction, amount_cents, certainty, status,
           label, source_record_id, hypothetical, accepted, created_at, updated_at
         ) VALUES (
           'synthetic-receipt-history', 'synthetic-profile', 'synthetic-account', '2041-02-18',
           'receivable-settlement', 'inflow', 1000, 'confirmed', 'cancelled',
           'Synthetic cancelled receipt', 'settled-history', 0, 0,
           '2041-02-18T10:00:00.000Z', '2041-02-18T10:00:00.000Z'
         )`,
      )
      .run();

    database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latestSchemaVersion);
    applyMigrations({ database, databasePath, backupDirectory });

    expect(
      database
        .prepare(
          `SELECT expected_date AS expectedDate,
                  include_in_cash_forecast AS includeInCashForecast,
                  settlement_date_confirmed AS settlementDateConfirmed,
                  created_at = updated_at AS untouched
             FROM receivables
            WHERE id = 'eligible-static'`,
        )
        .get(),
    ).toEqual({
      expectedDate: '2041-03-01',
      includeInCashForecast: 1,
      settlementDateConfirmed: 0,
      untouched: 0,
    });

    const preserved = database
      .prepare(
        `SELECT id,
                expected_date AS expectedDate,
                include_in_cash_forecast AS includeInCashForecast
           FROM receivables
          WHERE id <> 'eligible-static'
          ORDER BY id`,
      )
      .all();
    expect(preserved).toEqual(
      [...receivables]
        .filter((receivable) => receivable.id !== 'eligible-static')
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((receivable) => ({
          id: receivable.id,
          expectedDate: receivable.expectedDate ?? base.expectedDate,
          includeInCashForecast: base.includeInCashForecast,
        })),
    );

    expect(
      database
        .prepare(
          `SELECT field, destination_edited_at IS NOT NULL AS edited
             FROM import_lineage
            WHERE entity_type = 'receivable' AND entity_id = 'eligible-static'
            ORDER BY field`,
        )
        .all(),
    ).toEqual([
      { field: 'description', edited: 0 },
      { field: 'expectedDate', edited: 1 },
      { field: 'includeInCashForecast', edited: 1 },
    ]);

    const audit = database
      .prepare(
        `SELECT id, action, entity_type AS entityType, entity_id AS entityId,
                payload_json AS payloadJson
           FROM audit_events
          WHERE action = 'repair' AND entity_type = 'receivable'`,
      )
      .get() as
      | {
          id: string;
          action: string;
          entityType: string;
          entityId: string;
          payloadJson: string;
        }
      | undefined;
    expect(audit).toMatchObject({
      action: 'repair',
      entityType: 'receivable',
      entityId: 'eligible-static',
    });
    expect(audit?.id).toMatch(/^audit-static-receivable-date-repair-/u);
    expect(JSON.parse(audit!.payloadJson)).toEqual({
      source: 'schema-migration-v29',
      priorExpectedDate: '2041-02-17',
      expectedDate: '2041-03-01',
      includeInCashForecast: true,
      settlementDateConfirmed: false,
    });
    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      { version: latestSchemaVersion },
    );
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(database.pragma('foreign_key_check')).toEqual([]);
    const migrationBackups = fs
      .readdirSync(backupDirectory)
      .filter((fileName) => fileName.startsWith('pre-migration-v28-'));
    expect(migrationBackups).toHaveLength(1);

    applyMigrations({ database, databasePath, backupDirectory });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM audit_events
            WHERE action = 'repair'
              AND entity_type = 'receivable'
              AND entity_id = 'eligible-static'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fs
        .readdirSync(backupDirectory)
        .filter((fileName) => fileName.startsWith('pre-migration-v28-')),
    ).toEqual(migrationBackups);
  });
});
