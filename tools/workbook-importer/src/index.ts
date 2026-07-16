import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Temporal } from '@js-temporal/polyfill';
import { decimalToCents } from '@balance-book/domain';

export type ImportParser = 'text' | 'money-cents' | 'number' | 'boolean' | 'plain-date';
export type ImportDisposition = 'create' | 'update' | 'skip' | 'conflict' | 'unresolved';

export interface MappingRule {
  entityType: string;
  entityId: string;
  field: string;
  sheet: string;
  range: string;
  parser: ImportParser;
  transformation: string;
  confidence: 'high' | 'medium' | 'low';
  warning?: string;
}

export interface ExistingLineage {
  sourceKey: string;
  rawValueJson: string;
  parsedValueJson: string | null;
  destinationEdited: boolean;
}

export interface ImportPreviewItem extends MappingRule {
  sourceKey: string;
  rawValue: unknown;
  parsedValue: unknown;
  disposition: ImportDisposition;
  warning?: string;
}

export interface WorkbookPreview {
  workbookChecksum: string;
  sourceFileName: string;
  sourceSize: number;
  sheetCount: number;
  visibleSheetCount: number;
  hiddenSheetCount: number;
  items: ImportPreviewItem[];
  counts: Record<ImportDisposition, number>;
}

export const checksumFile = (filePath: string): string => {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const rawCellValue = (cell: ExcelJS.Cell): unknown => {
  const value = cell.value;
  if (value && typeof value === 'object' && 'formula' in value) {
    return { formula: value.formula, result: value.result ?? null };
  }
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'richText' in value) {
    return value.richText.map((part) => part.text).join('');
  }
  return value ?? null;
};

const parseValue = (raw: unknown, parser: ImportParser): unknown => {
  const effective = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
  if (effective === null || effective === undefined || effective === '') return null;
  switch (parser) {
    case 'text':
      return String(effective).trim();
    case 'money-cents':
      return decimalToCents(effective as string | number);
    case 'number': {
      const value = Number(effective);
      if (!Number.isFinite(value)) throw new Error('Not a finite number');
      return value;
    }
    case 'boolean':
      if (typeof effective === 'boolean') return effective;
      if (/^(true|yes|1)$/i.test(String(effective))) return true;
      if (/^(false|no|0)$/i.test(String(effective))) return false;
      throw new Error('Not a recognized boolean');
    case 'plain-date': {
      if (typeof effective === 'number') {
        const excelEpoch = Temporal.PlainDate.from('1899-12-30');
        return excelEpoch.add({ days: Math.trunc(effective) }).toString();
      }
      if (effective instanceof Date) return effective.toISOString().slice(0, 10);
      return Temporal.PlainDate.from(String(effective).slice(0, 10)).toString();
    }
  }
};

export const previewWorkbook = async (input: {
  filePath: string;
  mappings: MappingRule[];
  existingLineage?: ExistingLineage[];
}): Promise<WorkbookPreview> => {
  const absolutePath = path.resolve(input.filePath);
  const before = fs.statSync(absolutePath);
  const checksumBefore = checksumFile(absolutePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absolutePath);
  const lineage = new Map((input.existingLineage ?? []).map((item) => [item.sourceKey, item]));
  const items: ImportPreviewItem[] = input.mappings.map((mapping) => {
    const sourceKey = `${mapping.sheet}!${mapping.range}:${mapping.entityType}:${mapping.entityId}:${mapping.field}`;
    const sheet = workbook.getWorksheet(mapping.sheet);
    if (!sheet)
      return {
        ...mapping,
        sourceKey,
        rawValue: null,
        parsedValue: null,
        disposition: 'unresolved',
        warning: 'Worksheet not found',
      };
    const cells = sheet.getCell(mapping.range);
    const rawValue = rawCellValue(cells);
    let parsedValue: unknown;
    try {
      parsedValue = parseValue(rawValue, mapping.parser);
    } catch (error) {
      return {
        ...mapping,
        sourceKey,
        rawValue,
        parsedValue: null,
        disposition: 'unresolved',
        warning: error instanceof Error ? error.message : 'Parsing failed',
      };
    }
    if (parsedValue === null)
      return {
        ...mapping,
        sourceKey,
        rawValue,
        parsedValue,
        disposition: 'unresolved',
        warning: mapping.warning ?? 'Source is blank',
      };
    const previous = lineage.get(sourceKey);
    const rawJson = JSON.stringify(rawValue);
    const parsedJson = JSON.stringify(parsedValue);
    const disposition: ImportDisposition = !previous
      ? 'create'
      : previous.destinationEdited
        ? 'conflict'
        : previous.rawValueJson === rawJson && previous.parsedValueJson === parsedJson
          ? 'skip'
          : 'update';
    return { ...mapping, sourceKey, rawValue, parsedValue, disposition };
  });
  const checksumAfter = checksumFile(absolutePath);
  const after = fs.statSync(absolutePath);
  if (
    checksumBefore !== checksumAfter ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('Source workbook changed during read-only preview');
  }
  const dispositions: ImportDisposition[] = ['create', 'update', 'skip', 'conflict', 'unresolved'];
  return {
    workbookChecksum: checksumBefore,
    sourceFileName: path.basename(absolutePath),
    sourceSize: before.size,
    sheetCount: workbook.worksheets.length,
    visibleSheetCount: workbook.worksheets.filter((sheet) => sheet.state === 'visible').length,
    hiddenSheetCount: workbook.worksheets.filter((sheet) => sheet.state !== 'visible').length,
    items,
    counts: Object.fromEntries(
      dispositions.map((disposition) => [
        disposition,
        items.filter((item) => item.disposition === disposition).length,
      ]),
    ) as Record<ImportDisposition, number>,
  };
};
