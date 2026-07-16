import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, latestSchemaVersion } from '@balance-book/database';

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

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('effective-dated income stream migration', () => {
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
