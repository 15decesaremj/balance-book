import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

type UpdateRecoveryDatabase = {
  backup(destinationFile: string): Promise<unknown>;
  pragma(source: string): unknown;
};

type UpdateRecoveryOptions = {
  database: UpdateRecoveryDatabase;
  directory: string;
  currentVersion: string;
  now?: Date;
  retain?: number;
};

const updateSnapshotName = (version: string, now: Date): string =>
  `before-update-${version}-${now.toISOString().replaceAll(/[:.]/g, '-')}.sqlite`;

const snapshotFiles = (snapshotPath: string): string[] => [
  snapshotPath,
  `${snapshotPath}-wal`,
  `${snapshotPath}-shm`,
];

export const createVerifiedUpdateRecoverySnapshot = async ({
  database,
  directory,
  currentVersion,
  now = new Date(),
  retain = 3,
}: UpdateRecoveryOptions): Promise<string> => {
  await fs.promises.mkdir(directory, { recursive: true });
  const snapshotPath = path.join(directory, updateSnapshotName(currentVersion, now));
  database.pragma('wal_checkpoint(TRUNCATE)');
  try {
    await database.backup(snapshotPath);
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw new Error('The automatic recovery snapshot did not pass its integrity check.');
      }
    } finally {
      snapshot.close();
      await Promise.all(
        snapshotFiles(snapshotPath)
          .slice(1)
          .map((file) => fs.promises.rm(file, { force: true })),
      );
    }
  } catch (error) {
    await Promise.all(
      snapshotFiles(snapshotPath).map((file) => fs.promises.rm(file, { force: true })),
    );
    throw error;
  }

  const retainedCount = Math.max(1, Math.trunc(retain));
  const olderSnapshots = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^before-update-.*\.sqlite$/u.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort()
    .reverse()
    .slice(retainedCount);
  await Promise.all(
    olderSnapshots.flatMap((file) =>
      snapshotFiles(file).map((candidate) => fs.promises.rm(candidate, { force: true })),
    ),
  );
  return snapshotPath;
};
