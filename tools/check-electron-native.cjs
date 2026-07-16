'use strict';

const { app } = require('electron');

try {
  const Database = require('better-sqlite3');
  const database = new Database(':memory:');
  const result = database.prepare('select 1 as ok').get();
  database.close();
  if (result?.ok !== 1) throw new Error('SQLite verification query returned the wrong value');
  process.stdout.write(
    `Electron ${process.versions.electron}; native modules ${process.versions.modules}: OK\n`,
  );
  app.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
}
