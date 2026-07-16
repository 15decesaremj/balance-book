import { extname } from 'node:path';

export const prohibitedExtensions = new Set([
  '.xlsx',
  '.xls',
  '.xlsm',
  '.sqlite',
  '.sqlite3',
  '.sqlite-wal',
  '.sqlite-shm',
  '.sqlite-journal',
  '.db',
  '.db-wal',
  '.db-shm',
  '.backup',
  '.log',
  '.pdf',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.pfx',
  '.p12',
  '.pem',
  '.key',
  '.balancebook-backup',
  '.exe',
  '.msi',
  '.msix',
  '.nupkg',
  '.zip',
  '.7z',
  '.asar',
  '.pak',
  '.dll',
  '.node',
]);

export const prohibitedPaths =
  /^(?:\.pnpm-store|\.vite|coverage|dist|exports|local-backups|local-data|local-release-work|local-releases|local-screenshots|node_modules|out|playwright-report|private|release|releases|screenshots|test-results)\//i;

export const prohibitedExportNames = new Set([
  'balance-book-export.json',
  'accounts.csv',
  'events.csv',
  'cards.csv',
  'loans.csv',
  'receivables.csv',
  'assets.csv',
  'reconciliations.csv',
  'refinance-plans.csv',
]);

export const normalizeSourcePath = (file) => file.replaceAll('\\', '/');

export const isProhibitedSourceFile = (file) => {
  const normalized = normalizeSourcePath(file);
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  return (
    prohibitedPaths.test(normalized) ||
    prohibitedExtensions.has(extname(normalized).toLowerCase()) ||
    prohibitedExportNames.has(name)
  );
};
