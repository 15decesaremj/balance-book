import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const source = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const destination = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
if (!source || !destination) {
  throw new Error('Usage: node tools/snapshot-sqlite.mjs <source.sqlite> <destination.sqlite>');
}
if (!fs.existsSync(source)) throw new Error('Source database does not exist');
fs.mkdirSync(path.dirname(destination), { recursive: true });
if (fs.existsSync(destination)) throw new Error('Destination snapshot already exists');

const database = new Database(source, { readonly: true, fileMustExist: true });
try {
  await database.backup(destination);
} finally {
  database.close();
}

const snapshot = new Database(destination, { readonly: true, fileMustExist: true });
try {
  const integrity = snapshot.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Snapshot integrity check failed: ${String(integrity)}`);
} finally {
  snapshot.close();
}

const bytes = fs.readFileSync(destination);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sqliteIntegrity: 'ok',
  })}\n`,
);
