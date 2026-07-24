import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultProfilePreferences,
  storedProfilePreferencesSchema,
  type ProfilePreferences,
} from '@balance-book/domain';
import {
  BalanceBookStore,
  applyMigrations,
  databaseSchemaVersion,
  latestSchemaVersion,
  parsePortableProfileBackup,
} from '@balance-book/database';
import { setPreferencesRequestSchema } from '../apps/desktop/src/shared/contracts';

const directories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-preferences-'));
  directories.push(directory);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'migration-backups'),
  });
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.raw.open) store.close();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

const customizedPreferences: ProfilePreferences = {
  overviewForecastMode: 'conservative',
  compactLayout: true,
  reduceMotion: true,
  sidebarCollapsed: true,
  showOverviewDailySummary: false,
  showOverviewUpcomingEvents: false,
  showOverviewWiderPicture: false,
  showIncomeTools: false,
  showBills: false,
  showCreditCards: false,
  showLoans: false,
  showMoneyOwed: false,
  showAssetsAndNetWorth: false,
  experimentalCardInterestForecastEnabled: true,
  updateChannel: 'stable',
};

describe('profile experience preferences', () => {
  it('fills additive stored defaults while keeping current IPC writes complete and strict', () => {
    expect(storedProfilePreferencesSchema.parse({})).toEqual(defaultProfilePreferences);
    expect(storedProfilePreferencesSchema.parse({ compactLayout: true })).toEqual({
      ...defaultProfilePreferences,
      compactLayout: true,
    });
    expect(setPreferencesRequestSchema.parse(customizedPreferences)).toEqual(customizedPreferences);
    expect(() => setPreferencesRequestSchema.parse({ compactLayout: true })).toThrow();
    expect(() =>
      setPreferencesRequestSchema.parse({
        ...customizedPreferences,
        futureUnknownSetting: true,
      }),
    ).toThrow();
  });

  it('persists preferences per profile and reapplies the migration safely', () => {
    const store = openStore();
    store.initializeProfiles([
      { id: 'profile-a', displayName: 'Profile A', username: 'profile-a' },
      { id: 'profile-b', displayName: 'Profile B', username: 'profile-b' },
    ]);

    expect(store.getCredentialsById('profile-a')?.preferences).toEqual(defaultProfilePreferences);
    store.setPreferences('profile-a', customizedPreferences);
    expect(store.getCredentialsById('profile-a')?.preferences).toEqual(customizedPreferences);
    expect(store.getCredentialsById('profile-b')?.preferences).toEqual(defaultProfilePreferences);
    expect(() => store.setPreferences('missing-profile', customizedPreferences)).toThrow(
      /profile not found/i,
    );

    store.raw.prepare('DELETE FROM schema_migrations WHERE version = 31').run();
    expect(() =>
      applyMigrations({
        database: store.raw,
        databasePath: store.raw.name,
        backupDirectory: path.join(path.dirname(store.raw.name), 'migration-backups'),
      }),
    ).not.toThrow();
    expect(
      store.raw.prepare('SELECT name FROM schema_migrations WHERE version = 31').get(),
    ).toEqual({ name: 'profile-experience-preferences' });
    expect(store.getCredentialsById('profile-a')?.preferences).toEqual(customizedPreferences);
    expect(latestSchemaVersion).toBe(36);
    expect(databaseSchemaVersion).toBe(latestSchemaVersion);
  });

  it('exports version 3, restores customization, and normalizes a version 2 backup to defaults', () => {
    const source = openStore();
    source.initializeProfiles([
      { id: 'source-profile', displayName: 'Source', username: 'source' },
    ]);
    source.setPreferences('source-profile', customizedPreferences);
    const portable = source.exportPortableProfile('source-profile', 'test-version');
    expect(portable.version).toBe(3);
    expect(portable.sourceProfile.preferences).toEqual(customizedPreferences);

    const destination = openStore();
    destination.initializeProfiles([
      { id: 'destination-profile', displayName: 'Destination', username: 'destination' },
    ]);
    destination.replacePortableProfile('destination-profile', portable);
    expect(destination.getCredentialsById('destination-profile')?.preferences).toEqual(
      customizedPreferences,
    );

    const legacySourceProfile = {
      id: portable.sourceProfile.id,
      displayName: portable.sourceProfile.displayName,
      username: portable.sourceProfile.username,
      themePreference: portable.sourceProfile.themePreference,
      onboardingComplete: portable.sourceProfile.onboardingComplete,
    };
    const normalized = parsePortableProfileBackup({
      ...portable,
      version: 2,
      sourceSchemaVersion: 30,
      sourceProfile: { ...legacySourceProfile, onboardingComplete: false },
      accounts: [
        {
          id: 'legacy-account',
          userId: portable.sourceProfile.id,
          name: 'Legacy checking',
          type: 'checking',
          openingBalanceCents: 1_000,
          balanceAsOf: '2026-07-19',
          includedInLiquidity: true,
          canFundOtherAccounts: true,
          showOnOverview: true,
          transferDelayDays: 0,
        },
      ],
    });
    expect(normalized.version).toBe(3);
    expect(normalized.sourceProfile.preferences).toEqual(defaultProfilePreferences);
    expect(normalized.sourceProfile.onboardingComplete).toBe(true);

    const legacyPreferences: Record<string, unknown> = { ...customizedPreferences };
    delete legacyPreferences.experimentalCardInterestForecastEnabled;
    const normalizedLegacyV3 = parsePortableProfileBackup({
      ...portable,
      sourceProfile: {
        ...portable.sourceProfile,
        preferences: legacyPreferences,
      },
    });
    expect(normalizedLegacyV3.sourceProfile.preferences).toEqual({
      ...customizedPreferences,
      experimentalCardInterestForecastEnabled: false,
    });
  });
});
