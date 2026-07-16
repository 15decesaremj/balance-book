import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataActionProgressMessage, type DataAction } from '../apps/desktop/src/renderer/CorePages';

const source = readFileSync(
  new URL('../apps/desktop/src/renderer/CorePages.tsx', import.meta.url),
  'utf8',
);
const dataPageSource = source.slice(source.indexOf('export const DataPage'));

describe('data action lifecycle guard', () => {
  it('provides specific progress copy for every protected operation', () => {
    const actions: DataAction[] = ['backup', 'restore', 'export', 'import', 'reset'];

    expect(actions.map(dataActionProgressMessage)).toEqual([
      'Creating and verifying your encrypted portable backup...',
      'Validating and restoring your encrypted portable backup...',
      'Preparing your JSON and CSV exports...',
      'Validating and importing the selected JSON export...',
      'Resetting the active profile financial data...',
    ]);
  });

  it('claims one immediate ref lock and always releases it in finally', () => {
    const start = dataPageSource.indexOf('const performDataAction = async');
    const end = dataPageSource.indexOf('\n  const run = async', start);
    const guardSource = dataPageSource.slice(start, end);

    expect(guardSource).toContain('if (activeDataActionRef.current !== null) return');
    expect(guardSource).toContain('activeDataActionRef.current = action');
    expect(guardSource).toContain('await operation()');
    expect(guardSource).toContain('catch (caught)');
    expect(guardSource).toContain('finally');
    expect(guardSource).toContain('activeDataActionRef.current = null');
    expect(guardSource).toContain('setActiveDataAction(null)');
    expect(guardSource.indexOf('if (activeDataActionRef.current')).toBeLessThan(
      guardSource.indexOf('activeDataActionRef.current = action'),
    );
  });

  it('routes all five operations through the same lock and disables their whole control area', () => {
    expect(dataPageSource).toContain('await performDataAction(action, async () =>');
    expect(dataPageSource).toContain("await performDataAction('reset', async () =>");
    expect(dataPageSource).toContain('disabled={dataActionBusy}');
    expect(dataPageSource).toContain('aria-busy={dataActionBusy}');
    expect(dataPageSource).toContain(
      'aria-label="Backup, restore, export, import, and reset actions"',
    );
    expect(dataPageSource).toContain('dataActionProgressMessage(activeDataAction)');
    expect(dataPageSource).toContain('role="alert"');
  });
});
