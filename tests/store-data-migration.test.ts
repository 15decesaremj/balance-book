import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyProfileToStore } from '../apps/desktop/src/store-data-migration';

const roots: string[] = [];

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'BalanceBookStoreMigration-'));
  roots.push(root);
  return root;
};

const makeLegacyDatabase = (directory: string): string => {
  fs.mkdirSync(directory, { recursive: true });
  const databasePath = path.join(directory, 'balance-book.sqlite');
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      cents INTEGER NOT NULL
    );
    INSERT INTO credentials VALUES ('profile', 'local-user', 'scrypt-digest');
    INSERT INTO entries VALUES ('cash', 123456);
  `);
  database.close();
  return databasePath;
};

const digest = (filePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Store profile migration', () => {
  it('does nothing when there is no legacy profile', async () => {
    const root = makeRoot();
    await expect(
      migrateLegacyProfileToStore({
        legacyDataDirectory: path.join(root, 'legacy'),
        storeDataDirectory: path.join(root, 'store'),
      }),
    ).resolves.toEqual({ state: 'not-needed', reason: 'no-legacy-profile' });
  });

  it('copies a consistent profile and recovery material without changing the source', async () => {
    const root = makeRoot();
    const legacy = path.join(root, 'legacy');
    const store = path.join(root, 'store');
    const sourceDatabase = makeLegacyDatabase(legacy);
    fs.mkdirSync(path.join(legacy, 'update-backups'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'update-backups', 'before-update.sqlite'), 'recovery');
    const sourceBefore = digest(sourceDatabase);

    const result = await migrateLegacyProfileToStore({
      legacyDataDirectory: legacy,
      storeDataDirectory: store,
      now: new Date('2026-07-24T12:34:56.000Z'),
    });

    expect(result.state).toBe('migrated');
    expect(digest(sourceDatabase)).toBe(sourceBefore);
    const migrated = new Database(path.join(store, 'balance-book.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    expect(migrated.prepare('SELECT cents FROM entries WHERE id = ?').pluck().get('cash')).toBe(
      123456,
    );
    expect(
      migrated.prepare('SELECT password_hash FROM credentials WHERE id = ?').pluck().get('profile'),
    ).toBe('scrypt-digest');
    expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok');
    migrated.close();
    expect(
      fs.existsSync(
        path.join(
          store,
          'legacy-recovery',
          '2026-07-24T12-34-56-000Z',
          'update-backups',
          'before-update.sqlite',
        ),
      ),
    ).toBe(true);
  });

  it('never replaces an existing Store profile', async () => {
    const root = makeRoot();
    const legacy = path.join(root, 'legacy');
    const store = path.join(root, 'store');
    makeLegacyDatabase(legacy);
    const storeDatabasePath = makeLegacyDatabase(store);
    const storeDatabase = new Database(storeDatabasePath);
    storeDatabase.prepare('UPDATE entries SET cents = 999 WHERE id = ?').run('cash');
    storeDatabase.close();

    await expect(
      migrateLegacyProfileToStore({
        legacyDataDirectory: legacy,
        storeDataDirectory: store,
      }),
    ).resolves.toEqual({ state: 'not-needed', reason: 'store-profile-exists' });

    const reopened = new Database(storeDatabasePath, { readonly: true });
    expect(reopened.prepare('SELECT cents FROM entries WHERE id = ?').pluck().get('cash')).toBe(
      999,
    );
    reopened.close();
  });

  it('completes an interrupted journal when the destination database is already valid', async () => {
    const root = makeRoot();
    const legacy = path.join(root, 'legacy');
    const store = path.join(root, 'store');
    makeLegacyDatabase(legacy);
    const first = await migrateLegacyProfileToStore({
      legacyDataDirectory: legacy,
      storeDataDirectory: store,
      now: new Date('2026-07-24T12:34:56.000Z'),
    });
    expect(first.state).toBe('migrated');
    const journalPath = path.join(store, 'legacy-profile-migration.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      state: string;
      completedAt?: string;
      destinationDatabaseSha256?: string;
    };
    journal.state = 'started';
    delete journal.completedAt;
    delete journal.destinationDatabaseSha256;
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    fs.mkdirSync(path.join(legacy, 'update-backups'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'update-backups', 'after-interruption.sqlite'), 'recovery');

    const recovered = await migrateLegacyProfileToStore({
      legacyDataDirectory: legacy,
      storeDataDirectory: store,
      now: new Date('2026-07-24T13:00:00.000Z'),
    });

    expect(recovered.state).toBe('recovered');
    expect(
      JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { state: string; completedAt: string },
    ).toMatchObject({ state: 'complete', completedAt: '2026-07-24T13:00:00.000Z' });
    expect(
      fs.existsSync(
        path.join(
          store,
          'legacy-recovery',
          '2026-07-24T12-34-56-000Z',
          'update-backups',
          'after-interruption.sqlite',
        ),
      ),
    ).toBe(true);
  });

  it('refuses to bless a changed destination after an interrupted migration', async () => {
    const root = makeRoot();
    const legacy = path.join(root, 'legacy');
    const store = path.join(root, 'store');
    makeLegacyDatabase(legacy);
    await migrateLegacyProfileToStore({
      legacyDataDirectory: legacy,
      storeDataDirectory: store,
      now: new Date('2026-07-24T12:34:56.000Z'),
    });
    const journalPath = path.join(store, 'legacy-profile-migration.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      state: string;
      completedAt?: string;
      destinationDatabaseSha256?: string;
    };
    journal.state = 'started';
    delete journal.completedAt;
    delete journal.destinationDatabaseSha256;
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const destination = new Database(path.join(store, 'balance-book.sqlite'));
    destination.prepare('UPDATE entries SET cents = 777 WHERE id = ?').run('cash');
    destination.close();

    await expect(
      migrateLegacyProfileToStore({
        legacyDataDirectory: legacy,
        storeDataDirectory: store,
      }),
    ).rejects.toThrow('does not match its recovery snapshot');
    expect((JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { state: string }).state).toBe(
      'started',
    );
  });

  it('rejects a migration that points both channels at the same directory', async () => {
    const root = makeRoot();
    await expect(
      migrateLegacyProfileToStore({
        legacyDataDirectory: root,
        storeDataDirectory: root,
      }),
    ).rejects.toThrow('must be separate');
  });
});
