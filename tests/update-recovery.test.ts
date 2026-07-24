import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createVerifiedUpdateRecoverySnapshot } from '../apps/desktop/src/update-recovery';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('automatic update recovery snapshot', () => {
  it('checkpoints, verifies, and retains only the newest snapshots', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-update-recovery-'));
    temporaryDirectories.push(directory);
    const database = new Database(path.join(directory, 'source.sqlite'));
    database.pragma('journal_mode = WAL');
    database.exec('CREATE TABLE evidence (value TEXT NOT NULL)');
    database.prepare('INSERT INTO evidence (value) VALUES (?)').run('synthetic');
    const backupDirectory = path.join(directory, 'backups');

    try {
      for (let index = 0; index < 4; index += 1) {
        await createVerifiedUpdateRecoverySnapshot({
          database,
          directory: backupDirectory,
          currentVersion: '2.0.6',
          now: new Date(`2026-07-23T12:00:0${index}.000Z`),
        });
      }
    } finally {
      database.close();
    }

    const snapshots = fs.readdirSync(backupDirectory).sort();
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toContain('12-00-01');
    const recovered = new Database(path.join(backupDirectory, snapshots[2]!), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(recovered.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(recovered.prepare('SELECT value FROM evidence').get()).toEqual({
        value: 'synthetic',
      });
    } finally {
      recovered.close();
    }
  });

  it('removes a corrupt recovery file and refuses the restart path', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-update-corrupt-'));
    temporaryDirectories.push(directory);
    const backupDirectory = path.join(directory, 'backups');
    const corruptingDatabase = {
      pragma: () => undefined,
      backup: async (destination: string) => {
        fs.writeFileSync(destination, 'not a sqlite database');
      },
    };

    await expect(
      createVerifiedUpdateRecoverySnapshot({
        database: corruptingDatabase,
        directory: backupDirectory,
        currentVersion: '2.0.6',
      }),
    ).rejects.toThrow();
    expect(fs.readdirSync(backupDirectory)).toEqual([]);
  });
});
