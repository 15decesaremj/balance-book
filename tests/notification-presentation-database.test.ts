import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, BalanceBookStore, latestSchemaVersion } from '@balance-book/database';

const directories: string[] = [];
const stores: BalanceBookStore[] = [];

const createStore = (databasePath?: string): BalanceBookStore => {
  const directory = databasePath
    ? path.dirname(databasePath)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-notifications-'));
  if (!databasePath) directories.push(directory);
  const store = new BalanceBookStore({
    databasePath: databasePath ?? path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'migration-backups'),
  });
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) if (store.raw.open) store.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('notification presentation metadata', () => {
  it('returns only the active profile audit envelope without exposing payload details', () => {
    const store = createStore();
    store.initializeProfiles([
      { id: 'a', displayName: 'A', username: 'profile-a' },
      { id: 'b', displayName: 'B', username: 'profile-b' },
    ]);
    store.upsertManagedEntity('a', 'cash-account', {
      id: 'a-checking',
      name: 'A checking',
      type: 'checking',
      openingBalanceCents: 10_000,
      balanceAsOf: '2026-07-01',
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      hardFloorCents: 0,
      transferDelayDays: 0,
    });

    expect(store.getAuditHistory('b')).toEqual([]);
    expect(store.getAuditHistory('a')).toEqual([
      expect.objectContaining({
        action: 'upsert',
        entityType: 'cash-account',
        entityId: 'a-checking',
      }),
    ]);
    expect(Object.keys(store.getAuditHistory('a')[0]!).sort()).toEqual(
      ['action', 'createdAt', 'entityId', 'entityType', 'id'].sort(),
    );
  });

  it('persists per profile and restart, changes fingerprints atomically, and resets with the profile', () => {
    const store = createStore();
    const databasePath = store.raw.name;
    store.initializeProfiles([
      { id: 'a', displayName: 'A', username: 'profile-a' },
      { id: 'b', displayName: 'B', username: 'profile-b' },
    ]);
    store.setNotificationPresentations('a', [
      {
        notificationId: 'funding:checking',
        conditionFingerprint: 'v1:first',
        readAt: '2026-07-01T12:00:00.000Z',
        snoozedUntil: null,
        dismissedAt: null,
      },
    ]);
    expect(store.getNotificationPresentations('b')).toEqual([]);
    store.close();

    const restarted = createStore(databasePath);
    expect(restarted.getNotificationPresentations('a')).toEqual([
      expect.objectContaining({
        notificationId: 'funding:checking',
        conditionFingerprint: 'v1:first',
        readAt: '2026-07-01T12:00:00.000Z',
      }),
    ]);
    restarted.setNotificationPresentations('a', [
      {
        notificationId: 'funding:checking',
        conditionFingerprint: 'v1:changed',
        readAt: null,
        snoozedUntil: null,
        dismissedAt: null,
      },
    ]);
    expect(restarted.getNotificationPresentations('a')[0]).toMatchObject({
      conditionFingerprint: 'v1:changed',
      readAt: null,
    });
    restarted.resetUserData('a');
    expect(restarted.getNotificationPresentations('a')).toEqual([]);
  });

  it('migrates schema 33 to 34 recovery-safely and keeps presentation state device-local', () => {
    const store = createStore();
    store.initializeProfiles([{ id: 'a', displayName: 'A', username: 'profile-a' }]);
    store.raw.exec('DROP TABLE notification_presentations');
    store.raw.prepare('DELETE FROM schema_migrations WHERE version = 34').run();
    applyMigrations({
      database: store.raw,
      databasePath: store.raw.name,
      backupDirectory: path.join(path.dirname(store.raw.name), 'migration-backups'),
    });
    expect(latestSchemaVersion).toBe(36);
    const columns = store.raw
      .prepare('PRAGMA table_info(notification_presentations)')
      .all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain('condition_fingerprint');
    store.raw.prepare('DELETE FROM schema_migrations WHERE version = 34').run();
    expect(() =>
      applyMigrations({
        database: store.raw,
        databasePath: store.raw.name,
        backupDirectory: path.join(path.dirname(store.raw.name), 'migration-backups'),
      }),
    ).not.toThrow();

    store.setNotificationPresentations('a', [
      {
        notificationId: 'information:one',
        conditionFingerprint: 'v1:one',
        readAt: '2026-07-01T12:00:00.000Z',
        snoozedUntil: null,
        dismissedAt: null,
      },
    ]);
    expect(JSON.stringify(store.exportUserData('a'))).not.toContain('information:one');
    expect(JSON.stringify(store.exportPortableProfile('a', '2.0.0'))).not.toContain(
      'information:one',
    );
  });
});
