import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { previewWorkbook, type MappingRule } from '../tools/workbook-importer/src/index';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('read-only workbook importer', () => {
  it('previews create, skip, conflict, and unresolved states without changing the source', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-workbook-test-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'synthetic.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic');
    sheet.getCell('A1').value = 'Primary checking';
    sheet.getCell('B1').value = 123.45;
    await workbook.xlsx.writeFile(filePath);
    const before = fs.readFileSync(filePath);

    const mappings: MappingRule[] = [
      {
        entityType: 'cash-account',
        entityId: 'account-a',
        field: 'name',
        sheet: 'Synthetic',
        range: 'A1',
        parser: 'text',
        transformation: 'trim text',
        confidence: 'high',
      },
      {
        entityType: 'cash-account',
        entityId: 'account-a',
        field: 'openingBalanceCents',
        sheet: 'Synthetic',
        range: 'B1',
        parser: 'money-cents',
        transformation: 'decimal dollars to integer cents',
        confidence: 'high',
      },
      {
        entityType: 'cash-account',
        entityId: 'account-a',
        field: 'missing',
        sheet: 'Missing',
        range: 'A1',
        parser: 'text',
        transformation: 'none',
        confidence: 'low',
      },
    ];

    const initial = await previewWorkbook({ filePath, mappings });
    expect(initial.counts).toMatchObject({ create: 2, unresolved: 1 });
    expect(initial.items[1]?.parsedValue).toBe(12_345);
    const repeated = await previewWorkbook({
      filePath,
      mappings,
      existingLineage: [
        {
          sourceKey: initial.items[0]!.sourceKey,
          rawValueJson: JSON.stringify(initial.items[0]!.rawValue),
          parsedValueJson: JSON.stringify(initial.items[0]!.parsedValue),
          destinationEdited: false,
        },
        {
          sourceKey: initial.items[1]!.sourceKey,
          rawValueJson: '0',
          parsedValueJson: '0',
          destinationEdited: true,
        },
      ],
    });
    expect(repeated.items[0]?.disposition).toBe('skip');
    expect(repeated.items[1]?.disposition).toBe('conflict');
    expect(fs.readFileSync(filePath)).toEqual(before);
  });
});
