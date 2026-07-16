import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scrypt as nodeScrypt } from 'node:crypto';
import { z } from 'zod';
import {
  assetSchema,
  cashAccountSchema,
  cashFloorPolicySchema,
  creditCardCycleSchema,
  creditCardSchema,
  committedRefinancePlanSchema,
  forecastEventSchema,
  loanSchema,
  maximumProfileAssetRecords,
  receivableSchema,
  reconciliationSchema,
  rewardProgramSchema,
  savedScenarioSchema,
} from '@balance-book/domain';
import type { PortableProfileBackup, UserDataExport } from './store';

export const maximumEncryptedBackupBytes = 100 * 1024 * 1024;

const userDataExportSchema = z
  .object({
    format: z.literal('balance-book-user-data'),
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    policy: cashFloorPolicySchema.optional(),
    accounts: z.array(cashAccountSchema).max(10_000),
    events: z.array(forecastEventSchema).max(200_000),
    cards: z.array(creditCardSchema).max(10_000),
    cardCycles: z.array(creditCardCycleSchema).max(200_000),
    loans: z.array(loanSchema).max(50_000),
    committedRefinancePlans: z.array(committedRefinancePlanSchema).max(50_000).default([]),
    receivables: z.array(receivableSchema).max(200_000),
    assets: z.array(assetSchema).max(maximumProfileAssetRecords),
    rewardPrograms: z.array(rewardProgramSchema).max(50_000),
    reconciliations: z.array(reconciliationSchema).max(200_000),
    savedScenarios: z.array(savedScenarioSchema).max(200_000),
  })
  .strict();

export const parseUserDataExport = (input: unknown): UserDataExport =>
  userDataExportSchema.parse(input);

const portableAuditEventSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    action: z.string().min(1).max(120),
    entityType: z.string().min(1).max(120),
    entityId: z.string().min(1).max(256),
    payloadJson: z.string().max(2 * 1024 * 1024),
    createdAt: z.string().datetime(),
  })
  .strict();

const portableImportBatchSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    workbookChecksum: z.string().min(1).max(256),
    sourceFileName: z.string().min(1).max(1024),
    status: z.string().min(1).max(120),
    createdAt: z.string().datetime(),
    rolledBackAt: z.string().datetime().nullable(),
  })
  .strict();

const portableImportLineageSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    sourceBatchId: z.string().min(1).max(256),
    entityType: z.string().min(1).max(120),
    entityId: z.string().min(1).max(256),
    field: z.string().min(1).max(256),
    sourceSheet: z.string().min(1).max(512),
    // Older importer rows legitimately used an empty range for sheet-level metadata.
    sourceRange: z.string().max(512),
    rawValueJson: z.string().max(2 * 1024 * 1024),
    parsedValueJson: z
      .string()
      .max(2 * 1024 * 1024)
      .nullable(),
    transformation: z.string().min(1).max(2048),
    confidence: z.string().min(1).max(120),
    warning: z.string().max(2048).nullable(),
    sourceChecksum: z.string().min(1).max(256),
    destinationValueJson: z
      .string()
      .max(2 * 1024 * 1024)
      .nullable(),
    destinationEditedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

const managedEntityTypeSchema = z.enum([
  'cash-account',
  'forecast-event',
  'credit-card',
  'card-cycle',
  'loan',
  'receivable',
  'asset',
  'reward-program',
  'reconciliation',
  'saved-scenario',
  'committed-refinance-plan',
]);

const portableProfileBackupSchema = z
  .object({
    format: z.literal('balance-book-portable-profile'),
    version: z.literal(2),
    exportedAt: z.string().datetime(),
    sourceAppVersion: z.string().min(1).max(64),
    sourceSchemaVersion: z.number().int().positive().max(10_000),
    sourceProfile: z
      .object({
        id: z.string().min(1).max(128),
        displayName: z.string().min(1).max(120),
        username: z.string().min(1).max(128),
        themePreference: z.enum(['system', 'light', 'dark']),
        onboardingComplete: z.boolean(),
      })
      .strict(),
    onboardingDraft: z
      .object({
        values: z.record(z.string().min(1).max(64), z.string().max(500)),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
    policy: cashFloorPolicySchema.optional(),
    accounts: z.array(cashAccountSchema).max(10_000),
    events: z.array(forecastEventSchema).max(200_000),
    cards: z.array(creditCardSchema).max(10_000),
    cardCycles: z.array(creditCardCycleSchema).max(200_000),
    loans: z.array(loanSchema).max(50_000),
    committedRefinancePlans: z.array(committedRefinancePlanSchema).max(50_000).default([]),
    receivables: z.array(receivableSchema).max(200_000),
    assets: z.array(assetSchema).max(maximumProfileAssetRecords),
    rewardPrograms: z.array(rewardProgramSchema).max(50_000),
    reconciliations: z.array(reconciliationSchema).max(200_000),
    savedScenarios: z.array(savedScenarioSchema).max(200_000),
    auditEvents: z.array(portableAuditEventSchema).max(500_000),
    importBatches: z.array(portableImportBatchSchema).max(100_000),
    importLineage: z.array(portableImportLineageSchema).max(500_000),
    recordTimestamps: z
      .array(
        z
          .object({
            entityType: managedEntityTypeSchema,
            entityId: z.string().min(1).max(256),
            createdAt: z.string().datetime(),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(500_000),
    policyUpdatedAt: z.string().datetime().nullable(),
  })
  .strict();

export const parsePortableProfileBackup = (input: unknown): PortableProfileBackup =>
  portableProfileBackupSchema.parse(input);

export type PortableBackupData = UserDataExport | PortableProfileBackup;

const portableBackupDataSchema = z.union([portableProfileBackupSchema, userDataExportSchema]);

const base64Schema = z
  .string()
  .min(1)
  .max(Math.ceil((maximumEncryptedBackupBytes * 4) / 3) + 16)
  .refine((value) => Buffer.from(value, 'base64').toString('base64') === value, {
    message: 'Expected canonical base64',
  });

const exactBase64Bytes = (length: number) =>
  base64Schema.refine((value) => Buffer.from(value, 'base64').length === length);

const legacyEnvelopeSchema = z
  .object({
    format: z.literal('balance-book-encrypted-backup'),
    version: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    kdf: z.literal('scrypt'),
    salt: exactBase64Bytes(16),
    iv: exactBase64Bytes(12),
    authTag: exactBase64Bytes(16),
    ciphertext: base64Schema,
  })
  .strict();

const currentEnvelopeSchema = z
  .object({
    format: z.literal('balance-book-encrypted-backup'),
    version: z.literal(2),
    algorithm: z.literal('aes-256-gcm'),
    kdf: z.literal('scrypt'),
    kdfParameters: z
      .object({ N: z.literal(32_768), r: z.literal(8), p: z.literal(1), keyLength: z.literal(32) })
      .strict(),
    salt: exactBase64Bytes(16),
    iv: exactBase64Bytes(12),
    authTag: exactBase64Bytes(16),
    ciphertext: base64Schema,
  })
  .strict();

const envelopeSchema = z.union([currentEnvelopeSchema, legacyEnvelopeSchema]);

const deriveKey = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      32,
      { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });

const validateBackupPassword = (password: string): void => {
  if (password.length < 12 || password.length > 128) {
    throw new Error('Backup password must be between 12 and 128 characters');
  }
};

export const createEncryptedBackup = async (
  dataInput: PortableProfileBackup,
  password: string,
): Promise<string> => {
  validateBackupPassword(password);
  const data = portableProfileBackupSchema.parse(dataInput);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    format: 'balance-book-encrypted-backup',
    version: 2,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParameters: { N: 32_768, r: 8, p: 1, keyLength: 32 },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
};

export const decryptBackup = async (
  serialized: string,
  password: string,
): Promise<PortableBackupData> => {
  validateBackupPassword(password);
  if (Buffer.byteLength(serialized, 'utf8') > maximumEncryptedBackupBytes) {
    throw new Error('Backup file is too large');
  }
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(serialized);
  } catch {
    throw new Error('Backup file is not valid JSON');
  }
  const envelope = envelopeSchema.parse(untrusted);
  const key = await deriveKey(password, Buffer.from(envelope.salt, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return portableBackupDataSchema.parse(JSON.parse(plaintext));
  } catch {
    throw new Error('Backup password is incorrect or the backup is damaged');
  }
};

export const writeEncryptedBackup = async (
  filePath: string,
  data: PortableProfileBackup,
  password: string,
): Promise<void> => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = await createEncryptedBackup(data, password);
  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const temporaryPath = `${filePath}.${suffix}.tmp`;
  const previousPath = `${filePath}.${suffix}.previous`;
  let movedPrevious = false;
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, serialized, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const verified = await readEncryptedBackup(temporaryPath, password);
    if (
      verified.format !== data.format ||
      verified.version !== data.version ||
      verified.exportedAt !== data.exportedAt
    ) {
      throw new Error('Encrypted backup verification failed');
    }
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, previousPath);
      movedPrevious = true;
    }
    fs.renameSync(temporaryPath, filePath);
    if (movedPrevious) fs.rmSync(previousPath, { force: true });
  } catch (error) {
    if (movedPrevious && !fs.existsSync(filePath) && fs.existsSync(previousPath)) {
      fs.renameSync(previousPath, filePath);
    }
    throw error;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    fs.rmSync(previousPath, { force: true });
  }
};

export const readEncryptedBackup = async (
  filePath: string,
  password: string,
): Promise<PortableBackupData> => {
  const size = fs.statSync(filePath).size;
  if (size <= 0) throw new Error('Backup file is empty');
  if (size > maximumEncryptedBackupBytes) throw new Error('Backup file is too large');
  return decryptBackup(fs.readFileSync(filePath, 'utf8'), password);
};

const csvCell = (value: unknown): string => {
  const raw = value === null || value === undefined ? '' : String(value);
  // Excel and similar tools may execute formula-leading text. The apostrophe is the standard
  // display-safe escape and is applied only to user-controlled strings, never numeric values.
  const text = typeof value === 'string' && /^[=+\-@\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const toCsv = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\r\n');
};

export const writeUserExports = (directory: string, dataInput: UserDataExport): string[] => {
  const data = userDataExportSchema.parse(dataInput);
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = data.exportedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const baseName = `Balance Book export ${timestamp}`;
  let exportDirectory = path.join(directory, baseName);
  for (let suffix = 2; fs.existsSync(exportDirectory); suffix += 1) {
    exportDirectory = path.join(directory, `${baseName} (${suffix})`);
  }
  fs.mkdirSync(exportDirectory, { recursive: false });
  const files: Array<[string, Array<Record<string, unknown>>]> = [
    ['accounts.csv', data.accounts],
    ['events.csv', data.events],
    ['cards.csv', data.cards],
    ['loans.csv', data.loans],
    [
      'refinance-plans.csv',
      data.committedRefinancePlans.map((plan) => ({
        ...plan,
        payoffs: JSON.stringify(plan.payoffs),
        replacementLoan: JSON.stringify(plan.replacementLoan),
        replacementLoanSnapshot: JSON.stringify(
          plan.replacementLoanSnapshot ?? plan.replacementLoan,
        ),
        assetRelinks: JSON.stringify(plan.assetRelinks ?? []),
      })),
    ],
    ['receivables.csv', data.receivables],
    ['assets.csv', data.assets],
    ['reconciliations.csv', data.reconciliations],
  ];
  const written: string[] = [];
  const writeNewFile = (filePath: string, contents: string): void => {
    const temporaryPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporaryPath, filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  };
  const jsonPath = path.join(exportDirectory, 'balance-book-export.json');
  writeNewFile(jsonPath, JSON.stringify(data, null, 2));
  written.push(jsonPath);
  for (const [name, rows] of files) {
    const filePath = path.join(exportDirectory, name);
    writeNewFile(filePath, toCsv(rows));
    written.push(filePath);
  }
  return written;
};
