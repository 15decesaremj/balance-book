import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, latestSchemaVersion } from '@balance-book/database';
import { forecastEventSchema } from '@balance-book/domain';
import { materializeRecurringEvents } from '@balance-book/financial-engine';

const temporaryDirectories: string[] = [];
const databases: Array<InstanceType<typeof BetterSqlite3>> = [];

interface LegacyIncomeFixture {
  id: string;
  userId?: string;
  accountId: string;
  date: string;
  amountCents: number;
  label: string;
  recurrenceEndDate: string | null;
  incomeType?: string | null;
  incomePlanId?: string | null;
  incomePlanTotalCents?: number | null;
  incomeNominalDate?: string | null;
  notes?: string | null;
}

const createPreV17Database = (): {
  database: InstanceType<typeof BetterSqlite3>;
  databasePath: string;
  directory: string;
} => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-income-stream-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'balance-book.sqlite');
  const database = new BetterSqlite3(databasePath);
  databases.push(database);
  database.exec(`
    CREATE TABLE forecast_events (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      kind TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      certainty TEXT NOT NULL,
      status TEXT NOT NULL,
      label TEXT NOT NULL,
      source_record_id TEXT,
      hypothetical INTEGER NOT NULL DEFAULT 0,
      accepted INTEGER NOT NULL DEFAULT 0,
      include_in_conservative INTEGER,
      recurrence_json TEXT,
      recurrence_end_date TEXT,
      payment_method TEXT NOT NULL DEFAULT 'cash-account',
      income_type TEXT,
      parent_income_event_id TEXT,
      income_plan_id TEXT,
      income_plan_total_cents INTEGER,
      income_nominal_date TEXT,
      income_arrival_offset_days INTEGER,
      income_allocation_rule TEXT,
      income_allocation_order INTEGER,
      parent_income_plan_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations VALUES
      (13, 'dark-first-interface-default', '2026-01-01T00:00:00.000Z'),
      (16, 'durable-income-allocation-order', '2026-01-01T00:00:00.000Z');
  `);
  return { database, databasePath, directory };
};

const insertLegacyIncome = (
  database: InstanceType<typeof BetterSqlite3>,
  fixture: LegacyIncomeFixture,
): void => {
  database
    .prepare(
      `INSERT INTO forecast_events (
         id, user_id, account_id, date, kind, direction, amount_cents, certainty, status,
         label, recurrence_json, recurrence_end_date, payment_method, income_type,
         income_plan_id, income_plan_total_cents, income_nominal_date, notes, created_at, updated_at
       ) VALUES (
         @id, @userId, @accountId, @date, 'income', 'inflow', @amountCents, 'confirmed',
         'planned', @label, '{"frequency":"biweekly"}', @recurrenceEndDate, 'cash-account',
         @incomeType, @incomePlanId, @incomePlanTotalCents, @incomeNominalDate, @notes,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       )`,
    )
    .run({
      ...fixture,
      userId: fixture.userId ?? 'profile-a',
      incomeType: fixture.incomeType ?? null,
      incomePlanId: fixture.incomePlanId ?? null,
      incomePlanTotalCents: fixture.incomePlanTotalCents ?? null,
      incomeNominalDate: fixture.incomeNominalDate ?? null,
      notes: fixture.notes ?? null,
    });
};

const createPreV28RoutingDatabase = (): {
  database: InstanceType<typeof BetterSqlite3>;
  databasePath: string;
  directory: string;
} => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-paycheck-repair-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'balance-book.sqlite');
  const database = new BetterSqlite3(databasePath);
  databases.push(database);
  applyMigrations({ database, databasePath, backupDirectory: path.join(directory, 'backups') });
  database.exec(`
    INSERT INTO profiles (
      id, display_name, username, onboarding_complete, theme_preference, created_at, updated_at
    ) VALUES (
      'profile-a', 'Test profile', 'test-profile', 1, 'dark',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO cash_accounts (
      id, user_id, name, type, opening_balance_cents, balance_as_of,
      included_in_liquidity, can_fund_other_accounts, created_at, updated_at
    ) VALUES
      ('early-checking', 'profile-a', 'Early checking', 'checking', 0, '2026-01-01', 1, 1,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('primary-checking', 'profile-a', 'Primary checking', 'checking', 0, '2026-01-01', 1, 1,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('other-checking', 'profile-a', 'Other checking', 'checking', 0, '2026-01-01', 1, 1,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO import_batches (
      id, user_id, workbook_checksum, source_file_name, status, created_at
    ) VALUES (
      'legacy-import', 'profile-a', 'synthetic-checksum', 'synthetic-source.xlsx', 'completed',
      '2026-01-01T00:00:00.000Z'
    );
  `);
  const insert = database.prepare(
    `INSERT INTO forecast_events (
       id, user_id, account_id, date, kind, direction, amount_cents, certainty, status,
       label, source_record_id, transfer_id, hypothetical, accepted, recurrence_json,
       recurrence_end_date, payment_method, income_type, income_plan_id, income_stream_id,
       income_plan_total_cents, income_nominal_date, income_arrival_offset_days,
       income_allocation_rule, income_allocation_order, notes, created_at, updated_at
     ) VALUES (
       @id, 'profile-a', @accountId, @date, @kind, @direction, @amountCents, 'confirmed',
       'planned', @label, @sourceRecordId, @transferId, 0, 0, @recurrenceJson,
       @recurrenceEndDate, 'cash-account', @incomeType, @incomePlanId, @incomeStreamId,
       @incomePlanTotalCents, @incomeNominalDate, @incomeArrivalOffsetDays,
       @incomeAllocationRule, @incomeAllocationOrder, @notes,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
     )`,
  );
  const baseIncome = {
    kind: 'income',
    direction: 'inflow',
    transferId: null,
    recurrenceJson: '{"frequency":"biweekly"}',
    incomeType: 'paycheck',
    incomeStreamId: 'paycheck-stream',
    incomePlanTotalCents: 220_000,
  };
  insert.run({
    ...baseIncome,
    id: 'current-early',
    accountId: 'early-checking',
    date: '2026-07-22',
    amountCents: 40_000,
    label: 'Main paycheck - current split',
    sourceRecordId: 'legacy-early-source',
    recurrenceEndDate: '2026-09-29',
    incomePlanId: 'current-plan',
    incomeNominalDate: '2026-07-24',
    incomeArrivalOffsetDays: -2,
    incomeAllocationRule: 'fixed',
    incomeAllocationOrder: 0,
    notes: 'Current paycheck routing.',
  });
  insert.run({
    ...baseIncome,
    id: 'current-payday',
    accountId: 'primary-checking',
    date: '2026-07-24',
    amountCents: 180_000,
    label: 'Main paycheck - current split',
    sourceRecordId: 'legacy-payday-source',
    recurrenceEndDate: '2026-09-29',
    incomePlanId: 'current-plan',
    incomeNominalDate: '2026-07-24',
    incomeArrivalOffsetDays: 0,
    incomeAllocationRule: 'remainder',
    incomeAllocationOrder: 1,
    notes: 'Current paycheck routing.',
  });
  insert.run({
    ...baseIncome,
    id: 'future-payday-only',
    accountId: 'primary-checking',
    date: '2026-10-02',
    amountCents: 220_000,
    label: 'Main paycheck - future routing',
    sourceRecordId: 'legacy-future-source',
    recurrenceEndDate: null,
    incomePlanId: 'future-plan',
    incomeNominalDate: '2026-10-02',
    incomeArrivalOffsetDays: 0,
    incomeAllocationRule: 'remainder',
    incomeAllocationOrder: 0,
    notes: 'Future paycheck routing.',
  });
  const transfer = {
    recurrenceEndDate: null,
    incomeType: null,
    incomePlanId: null,
    incomeStreamId: null,
    incomePlanTotalCents: null,
    incomeNominalDate: null,
    incomeArrivalOffsetDays: null,
    incomeAllocationRule: null,
    incomeAllocationOrder: null,
    sourceRecordId: null,
    notes: null,
  };
  insert.run({
    ...transfer,
    id: 'payroll-transfer-debit',
    accountId: 'primary-checking',
    date: '2026-09-30',
    kind: 'transfer-debit',
    direction: 'outflow',
    amountCents: 40_000,
    label: 'Recurring savings transfer',
    transferId: 'payroll-transfer',
    recurrenceJson: '{"frequency":"biweekly"}',
  });
  insert.run({
    ...transfer,
    id: 'payroll-transfer-credit',
    accountId: 'early-checking',
    date: '2026-09-30',
    kind: 'transfer-credit',
    direction: 'inflow',
    amountCents: 40_000,
    label: 'Recurring savings transfer',
    transferId: 'payroll-transfer',
    recurrenceJson: null,
  });
  insert.run({
    ...transfer,
    id: 'genuine-transfer-debit',
    accountId: 'primary-checking',
    date: '2026-10-01',
    kind: 'transfer-debit',
    direction: 'outflow',
    amountCents: 40_000,
    label: 'Independent savings transfer',
    transferId: 'genuine-transfer',
    recurrenceJson: '{"frequency":"biweekly"}',
  });
  insert.run({
    ...transfer,
    id: 'genuine-transfer-credit',
    accountId: 'other-checking',
    date: '2026-10-01',
    kind: 'transfer-credit',
    direction: 'inflow',
    amountCents: 40_000,
    label: 'Independent savings transfer',
    transferId: 'genuine-transfer',
    recurrenceJson: null,
  });
  const insertLineage = database.prepare(
    `INSERT INTO import_lineage (
       id, user_id, batch_id, entity_type, entity_id, field, source_sheet, source_range,
       raw_value_json, parsed_value_json, transformation, confidence, warning, source_checksum,
       destination_value_json, destination_edited_at, created_at
     ) VALUES (
       @id, 'profile-a', 'legacy-import', 'forecast-event', @entityId, 'record', 'Synthetic',
       @sourceRange, '{}', '{}', 'synthetic legacy fixture', 'high', NULL,
       'synthetic-checksum', '{}', NULL, '2026-01-01T00:00:00.000Z'
     )`,
  );
  [
    'current-early',
    'current-payday',
    'future-payday-only',
    'payroll-transfer-debit',
    'payroll-transfer-credit',
  ].forEach((entityId, index) =>
    insertLineage.run({
      id: `legacy-lineage-${index}`,
      entityId,
      sourceRange: `A${index + 1}`,
    }),
  );
  database.prepare('DELETE FROM schema_migrations WHERE version >= 28').run();
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

describe('effective-dated income stream migration', () => {
  it('restores a legacy early deposit as real income and cancels only its substitute transfer', () => {
    const { database, databasePath, directory } = createPreV28RoutingDatabase();

    applyMigrations({ database, databasePath, backupDirectory: path.join(directory, 'backups') });

    const futurePlan = database
      .prepare(
        `SELECT account_id AS accountId,
                date,
                amount_cents AS amountCents,
                income_arrival_offset_days AS offsetDays,
                income_allocation_rule AS allocationRule,
                income_allocation_order AS allocationOrder
           FROM forecast_events
          WHERE user_id = 'profile-a'
            AND income_plan_id = 'future-plan'
            AND status = 'planned'
          ORDER BY income_allocation_order`,
      )
      .all();
    expect(futurePlan).toEqual([
      {
        accountId: 'early-checking',
        date: '2026-09-30',
        amountCents: 40_000,
        offsetDays: -2,
        allocationRule: 'fixed',
        allocationOrder: 0,
      },
      {
        accountId: 'primary-checking',
        date: '2026-10-02',
        amountCents: 180_000,
        offsetDays: 0,
        allocationRule: 'remainder',
        allocationOrder: 1,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT transfer_id AS transferId, status, COUNT(*) AS legs
             FROM forecast_events
            WHERE transfer_id IN ('payroll-transfer', 'genuine-transfer')
            GROUP BY transfer_id, status
            ORDER BY transfer_id`,
        )
        .all(),
    ).toEqual([
      { transferId: 'genuine-transfer', status: 'planned', legs: 2 },
      { transferId: 'payroll-transfer', status: 'cancelled', legs: 2 },
    ]);
    expect(
      database
        .prepare(
          `SELECT date, SUM(CASE WHEN direction = 'inflow' THEN amount_cents ELSE -amount_cents END) AS netCents
             FROM forecast_events
            WHERE status = 'planned'
              AND date IN ('2026-09-30', '2026-10-02')
            GROUP BY date
            ORDER BY date`,
        )
        .all(),
    ).toEqual([
      { date: '2026-09-30', netCents: 40_000 },
      { date: '2026-10-02', netCents: 180_000 },
    ]);
    const storedFuturePlan = database
      .prepare(
        `SELECT id,
                account_id AS accountId,
                date,
                amount_cents AS amountCents,
                label,
                source_record_id AS sourceRecordId,
                income_plan_id AS incomePlanId,
                income_stream_id AS incomeStreamId,
                income_plan_total_cents AS incomePlanTotalCents,
                income_nominal_date AS incomeNominalDate,
                income_arrival_offset_days AS incomeArrivalOffsetDays,
                income_allocation_rule AS incomeAllocationRule,
                income_allocation_order AS incomeAllocationOrder,
                notes
           FROM forecast_events
          WHERE user_id = 'profile-a'
            AND income_plan_id = 'future-plan'
            AND status = 'planned'
          ORDER BY income_allocation_order`,
      )
      .all() as Array<Record<string, unknown>>;
    const occurrences = materializeRecurringEvents({
      events: storedFuturePlan.map((row) =>
        forecastEventSchema.parse({
          ...row,
          userId: 'profile-a',
          kind: 'income',
          direction: 'inflow',
          certainty: 'confirmed',
          status: 'planned',
          hypothetical: false,
          accepted: false,
          recurrenceRule: { frequency: 'biweekly' },
          paymentMethod: 'cash-account',
          incomeType: 'paycheck',
        }),
      ),
      startDate: '2026-09-30',
      endDate: '2026-10-30',
    });
    expect(
      occurrences.map((event) => ({
        accountId: event.accountId,
        date: event.date,
        nominalDate: event.incomeNominalDate,
        amountCents: event.amountCents,
      })),
    ).toEqual([
      {
        accountId: 'early-checking',
        date: '2026-09-30',
        nominalDate: '2026-10-02',
        amountCents: 40_000,
      },
      {
        accountId: 'early-checking',
        date: '2026-10-14',
        nominalDate: '2026-10-16',
        amountCents: 40_000,
      },
      {
        accountId: 'early-checking',
        date: '2026-10-28',
        nominalDate: '2026-10-30',
        amountCents: 40_000,
      },
      {
        accountId: 'primary-checking',
        date: '2026-10-02',
        nominalDate: '2026-10-02',
        amountCents: 180_000,
      },
      {
        accountId: 'primary-checking',
        date: '2026-10-16',
        nominalDate: '2026-10-16',
        amountCents: 180_000,
      },
      {
        accountId: 'primary-checking',
        date: '2026-10-30',
        nominalDate: '2026-10-30',
        amountCents: 180_000,
      },
    ]);
    const totalByPayday = new Map<string, typeof occurrences>();
    for (const event of occurrences) {
      const payday = event.incomeNominalDate!;
      totalByPayday.set(payday, [...(totalByPayday.get(payday) ?? []), event]);
    }
    for (const events of totalByPayday.values()) {
      expect(events.reduce((total, event) => total + event.amountCents, 0)).toBe(220_000);
    }
    expect(
      database
        .prepare(
          `SELECT action, entity_type AS entityType
             FROM audit_events
            WHERE action = 'repair' AND entity_id = 'future-plan'`,
        )
        .get(),
    ).toEqual({ action: 'repair', entityType: 'income-plan' });
    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      { version: latestSchemaVersion },
    );
    database.close();
  });

  it('leaves the legacy shape untouched when any imported field was edited by the user', () => {
    const { database, databasePath, directory } = createPreV28RoutingDatabase();
    database
      .prepare(
        `UPDATE import_lineage
            SET destination_edited_at = '2026-02-01T00:00:00.000Z'
          WHERE entity_type = 'forecast-event' AND entity_id = 'payroll-transfer-credit'`,
      )
      .run();

    applyMigrations({ database, databasePath, backupDirectory: path.join(directory, 'backups') });

    expect(
      database
        .prepare(
          `SELECT account_id AS accountId,
                  amount_cents AS amountCents,
                  income_arrival_offset_days AS offsetDays,
                  income_allocation_order AS allocationOrder
             FROM forecast_events
            WHERE income_plan_id = 'future-plan' AND status = 'planned'`,
        )
        .all(),
    ).toEqual([
      {
        accountId: 'primary-checking',
        amountCents: 220_000,
        offsetDays: 0,
        allocationOrder: 0,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT status, COUNT(*) AS legs
             FROM forecast_events
            WHERE transfer_id = 'payroll-transfer'
            GROUP BY status`,
        )
        .all(),
    ).toEqual([{ status: 'planned', legs: 2 }]);
    expect(
      database
        .prepare("SELECT COUNT(*) AS repairs FROM audit_events WHERE action = 'repair'")
        .get(),
    ).toEqual({ repairs: 0 });
    database.close();
  });

  it('conservatively recognizes a split paycheck and its exact next routing phase', () => {
    const { database, databasePath, directory } = createPreV17Database();
    insertLegacyIncome(database, {
      id: 'legacy-early-leg',
      accountId: 'early-checking',
      date: '2026-07-22',
      amountCents: 40_000,
      label: 'Paycheck savings split',
      recurrenceEndDate: '2026-09-29',
    });
    insertLegacyIncome(database, {
      id: 'legacy-primary-leg',
      accountId: 'primary-checking',
      date: '2026-07-24',
      amountCents: 180_000,
      label: 'Paycheck to primary checking',
      recurrenceEndDate: '2026-09-29',
    });
    insertLegacyIncome(database, {
      id: 'legacy-successor',
      accountId: 'primary-checking',
      date: '2026-10-02',
      amountCents: 220_000,
      label: 'Paycheck to primary checking',
      recurrenceEndDate: null,
    });
    insertLegacyIncome(database, {
      id: 'unrelated-income',
      accountId: 'primary-checking',
      date: '2026-10-02',
      amountCents: 75_000,
      label: 'Consulting income',
      recurrenceEndDate: null,
    });

    applyMigrations({
      database,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
    });

    const migrated = database
      .prepare(
        `SELECT id,
                income_type AS incomeType,
                income_plan_id AS planId,
                income_stream_id AS streamId,
                income_plan_total_cents AS totalCents,
                income_nominal_date AS nominalDate,
                income_arrival_offset_days AS offsetDays,
                income_allocation_rule AS allocationRule,
                income_allocation_order AS allocationOrder
         FROM forecast_events
         ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    const early = migrated.find((row) => row.id === 'legacy-early-leg')!;
    const primary = migrated.find((row) => row.id === 'legacy-primary-leg')!;
    const successor = migrated.find((row) => row.id === 'legacy-successor')!;
    const unrelated = migrated.find((row) => row.id === 'unrelated-income')!;

    expect(early).toMatchObject({
      incomeType: 'paycheck',
      totalCents: 220_000,
      nominalDate: '2026-07-24',
      offsetDays: -2,
      allocationRule: 'fixed',
      allocationOrder: 0,
    });
    expect(primary).toMatchObject({
      planId: early.planId,
      streamId: early.streamId,
      totalCents: 220_000,
      nominalDate: '2026-07-24',
      offsetDays: 0,
      allocationRule: 'remainder',
      allocationOrder: 1,
    });
    expect(successor).toMatchObject({
      incomeType: 'paycheck',
      streamId: early.streamId,
      totalCents: 220_000,
      nominalDate: '2026-10-02',
      offsetDays: 0,
      allocationRule: 'remainder',
      allocationOrder: 0,
    });
    expect(successor.planId).not.toBe(early.planId);
    expect(unrelated).toMatchObject({
      incomeType: null,
      planId: null,
      streamId: null,
    });
    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      { version: latestSchemaVersion },
    );
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'forecast_events_income_stream_idx'",
        )
        .get(),
    ).toEqual({ name: 'forecast_events_income_stream_idx' });
    database.close();
  });

  it('leaves aligned but unrelated paychecks separate without an explicit split-routing signature', () => {
    const { database, databasePath, directory } = createPreV17Database();
    insertLegacyIncome(database, {
      id: 'first-job-paycheck',
      accountId: 'primary-checking',
      date: '2026-07-24',
      amountCents: 180_000,
      label: 'Paycheck to primary checking',
      recurrenceEndDate: '2026-09-29',
    });
    insertLegacyIncome(database, {
      id: 'second-job-paycheck',
      accountId: 'secondary-checking',
      date: '2026-07-22',
      amountCents: 40_000,
      label: 'Paycheck from second employer',
      recurrenceEndDate: '2026-09-29',
    });
    insertLegacyIncome(database, {
      id: 'first-job-successor',
      accountId: 'primary-checking',
      date: '2026-10-02',
      amountCents: 220_000,
      label: 'Paycheck to primary checking',
      recurrenceEndDate: null,
    });

    applyMigrations({
      database,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
    });

    expect(
      database
        .prepare(
          `SELECT id,
                  income_plan_id AS planId,
                  income_stream_id AS streamId
           FROM forecast_events
           ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'first-job-paycheck', planId: null, streamId: null },
      { id: 'first-job-successor', planId: null, streamId: null },
      { id: 'second-job-paycheck', planId: null, streamId: null },
    ]);
    database.close();
  });

  it('does not create an invalid grouped plan from split-shaped rows with different notes', () => {
    const { database, databasePath, directory } = createPreV17Database();
    insertLegacyIncome(database, {
      id: 'noted-early-leg',
      accountId: 'early-checking',
      date: '2026-07-22',
      amountCents: 40_000,
      label: 'Paycheck savings split',
      recurrenceEndDate: '2026-09-29',
      notes: 'Reserved for savings',
    });
    insertLegacyIncome(database, {
      id: 'noted-primary-leg',
      accountId: 'primary-checking',
      date: '2026-07-24',
      amountCents: 180_000,
      label: 'Paycheck to primary checking',
      recurrenceEndDate: '2026-09-29',
      notes: 'Available for bills',
    });
    insertLegacyIncome(database, {
      id: 'noted-successor',
      accountId: 'primary-checking',
      date: '2026-10-02',
      amountCents: 220_000,
      label: 'Paycheck to primary checking',
      recurrenceEndDate: null,
      notes: 'Available for bills',
    });

    applyMigrations({
      database,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
    });

    expect(
      database
        .prepare(
          `SELECT id,
                  income_plan_id AS planId,
                  income_stream_id AS streamId
           FROM forecast_events
           ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'noted-early-leg', planId: null, streamId: null },
      { id: 'noted-primary-leg', planId: null, streamId: null },
      { id: 'noted-successor', planId: null, streamId: null },
    ]);
    database.close();
  });

  it('scopes legacy plan grouping and ambiguity checks to each profile', () => {
    const { database, databasePath, directory } = createPreV17Database();
    const insertPhase = (input: {
      id: string;
      userId: string;
      accountId: string;
      date: string;
      amountCents: number;
      label: string;
      recurrenceEndDate: string | null;
      incomePlanId: string;
    }): void =>
      insertLegacyIncome(database, {
        ...input,
        incomeType: 'paycheck',
        incomePlanTotalCents: input.amountCents,
        incomeNominalDate: input.date,
      });

    for (const profile of [
      { userId: 'profile-a', employer: 'Acme', amountCents: 100_000 },
      { userId: 'profile-b', employer: 'Beta', amountCents: 140_000 },
    ]) {
      insertPhase({
        id: `${profile.userId}-current`,
        userId: profile.userId,
        accountId: `${profile.userId}-checking`,
        date: '2026-07-24',
        amountCents: profile.amountCents,
        label: `${profile.employer} paycheck`,
        recurrenceEndDate: '2026-09-29',
        incomePlanId: 'shared-current-plan-id',
      });
      insertPhase({
        id: `${profile.userId}-successor`,
        userId: profile.userId,
        accountId: `${profile.userId}-checking`,
        date: '2026-10-02',
        amountCents: profile.amountCents,
        label: `${profile.employer} paycheck`,
        recurrenceEndDate: null,
        incomePlanId: 'shared-successor-plan-id',
      });
    }

    applyMigrations({
      database,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
    });

    const rows = database
      .prepare(
        `SELECT user_id AS userId,
                income_plan_id AS planId,
                income_stream_id AS streamId
         FROM forecast_events
         ORDER BY user_id, income_plan_id`,
      )
      .all() as Array<{ userId: string; planId: string; streamId: string }>;
    const profileA = rows.filter((row) => row.userId === 'profile-a');
    const profileB = rows.filter((row) => row.userId === 'profile-b');
    expect(new Set(profileA.map((row) => row.streamId))).toHaveLength(1);
    expect(new Set(profileB.map((row) => row.streamId))).toHaveLength(1);
    expect(profileA[0]!.streamId).not.toBe(profileA[0]!.planId);
    expect(profileB[0]!.streamId).not.toBe(profileB[0]!.planId);
    expect(profileA[0]!.streamId).not.toBe(profileB[0]!.streamId);
    database.close();
  });
});
