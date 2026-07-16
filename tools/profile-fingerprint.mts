import { createHash } from 'node:crypto';
import path from 'node:path';
import { BalanceBookStore } from '../packages/database/src/index';

const databaseIndex = process.argv.indexOf('--database');
const databasePath =
  databaseIndex >= 0 && process.argv[databaseIndex + 1]
    ? path.resolve(process.argv[databaseIndex + 1]!)
    : undefined;
const profileIndex = process.argv.indexOf('--profile-id');
const requestedProfileId =
  profileIndex >= 0 && process.argv[profileIndex + 1] ? process.argv[profileIndex + 1] : undefined;
if (!databasePath) throw new Error('--database is required');

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(stable);
    return items.every(
      (item) => item && typeof item === 'object' && 'id' in (item as Record<string, unknown>),
    )
      ? items.sort((left, right) =>
          String((left as Record<string, unknown>).id).localeCompare(
            String((right as Record<string, unknown>).id),
          ),
        )
      : items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
};
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');

const store = new BalanceBookStore({
  databasePath,
  backupDirectory: path.resolve('local-release-work', 'fingerprint-migration-backups'),
});
try {
  const profiles = store.listProfiles();
  const selected = requestedProfileId
    ? profiles.find((profile) => profile.id === requestedProfileId)
    : profiles
        .map((profile) => ({ profile, records: store.getManagedRecords(profile.id) }))
        .sort(
          (left, right) =>
            Object.values(right.records).reduce(
              (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
              0,
            ) -
            Object.values(left.records).reduce(
              (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
              0,
            ),
        )[0]?.profile;
  if (!selected) throw new Error('Profile was not found');
  const credentials = store.getCredentialsById(selected.id)!;
  const records = store.getManagedRecords(selected.id);
  const policy = store.getForecastData(selected.id)?.policy;
  const integrity = store.raw.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      profileId: selected.id,
      credentialDigest: digest({
        passwordHash: credentials.passwordHash,
        passwordSalt: credentials.passwordSalt,
      }),
      financialDigest: digest({ records, policy }),
      managedRecordCount: Object.values(records).reduce(
        (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
        0,
      ),
      sqliteIntegrity: 'ok',
    })}\n`,
  );
} finally {
  store.close();
}
