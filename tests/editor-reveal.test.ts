// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createImmediateActionLock,
  editorRevealScrollBehavior,
  useEditorReveal,
} from '../apps/desktop/src/renderer/useEditorReveal';

const corePages = readFileSync(resolve('apps/desktop/src/renderer/CorePages.tsx'), 'utf8');
const styles = readFileSync(resolve('apps/desktop/src/renderer/styles.css'), 'utf8');

const pageSource = (name: string, nextName: string): string => {
  const start = corePages.indexOf(`export const ${name} =`);
  const end = corePages.indexOf(`export const ${nextName} =`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not isolate ${name}`);
  return corePages.slice(start, end);
};

const Harness = ({
  activeKey,
  revealRequest = 0,
}: {
  activeKey: string | null;
  revealRequest?: number;
}) => {
  const editorRef = useEditorReveal<HTMLDivElement>(activeKey, revealRequest);
  return activeKey
    ? createElement('div', { ref: editorRef, tabIndex: -1, 'data-testid': 'editor' }, 'Editor')
    : null;
};

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('long-list editor reveal', () => {
  it('focuses and smoothly reveals an editor only after it is rendered', () => {
    const view = render(createElement(Harness, { activeKey: null }));

    view.rerender(createElement(Harness, { activeKey: 'card-1' }));

    expect(document.activeElement).toBe(view.getByTestId('editor'));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

    view.rerender(createElement(Harness, { activeKey: 'card-1' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerender(createElement(Harness, { activeKey: null }));
    view.rerender(createElement(Harness, { activeKey: 'card-1' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('uses immediate scrolling when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    render(createElement(Harness, { activeKey: 'loan-1' }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    expect(editorRevealScrollBehavior(true)).toBe('auto');
    expect(editorRevealScrollBehavior(false)).toBe('smooth');
  });

  it('re-reveals the same mounted editor when its trigger is activated again', () => {
    const view = render(createElement(Harness, { activeKey: 'card-1', revealRequest: 1 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerender(createElement(Harness, { activeKey: 'card-1', revealRequest: 2 }));

    expect(document.activeElement).toBe(view.getByTestId('editor'));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('locks an async action synchronously and only releases the matching owner', () => {
    const lock = createImmediateActionLock();

    expect(lock.acquire('save-card')).toBe(true);
    expect(lock.active()).toBe('save-card');
    expect(lock.acquire('save-card')).toBe(false);
    expect(lock.acquire('save-cycle')).toBe(false);

    lock.release('save-cycle');
    expect(lock.active()).toBe('save-card');
    lock.release('save-card');

    expect(lock.active()).toBeNull();
    expect(lock.acquire('save-cycle')).toBe(true);
  });

  it.each([
    [
      'CardsPage',
      'LoansPage',
      'cardEditorRef',
      'editingCardId',
      'card-editor-title',
      'if (!records)',
    ],
    [
      'LoansPage',
      'ReceivablesPage',
      'loanEditorRef',
      'editingLoanId',
      'loan-editor-title',
      'if (!records)',
    ],
    [
      'ReceivablesPage',
      'NetWorthPage',
      'receivableEditorRef',
      'editingReceivableId',
      'receivable-editor-title',
      'if (!records)',
    ],
    [
      'NetWorthPage',
      'ReconciliationPage',
      'assetEditorRef',
      'editingAssetId',
      'asset-editor-title',
      'if (!result || !records || !snapshot)',
    ],
  ])(
    'wires %s before its loading return and labels the focus target',
    (pageName, nextPageName, refName, stateName, titleId, loadingReturn) => {
      const source = pageSource(pageName, nextPageName);
      const hookCall = new RegExp(
        `const\\s+${refName}\\s*=\\s*useEditorReveal<HTMLDivElement>\\(\\s*${stateName}`,
      );

      expect(source).toMatch(hookCall);
      expect(source.search(hookCall)).toBeLessThan(source.indexOf(loadingReturn));
      expect(source).toContain(`ref={${refName}}`);
      expect(source).toContain('className={`${styles.panel} balance-editor-reveal`}');
      expect(source).toContain('tabIndex={-1}');
      expect(source).toContain(`aria-labelledby="${titleId}"`);
      expect(source).toContain(`id="${titleId}"`);
    },
  );

  it('wires every card subeditor to reveal, mutual exclusion, and an immediate mutation lock', () => {
    const source = pageSource('CardsPage', 'LoansPage');

    expect(source).toContain(
      'const cycleEditorRef = useEditorReveal<HTMLDivElement>(editingCycleId, cycleRevealRequest);',
    );
    expect(source).toContain('const scheduledPaymentEditorRef = useEditorReveal<HTMLFormElement>(');
    expect(source).toContain('const statementPaymentEditorRef = useEditorReveal<HTMLFormElement>(');
    expect(source).toContain('ref={cycleEditorRef}');
    expect(source).toContain('ref={scheduledPaymentEditorRef}');
    expect(source).toContain('ref={statementPaymentEditorRef}');
    expect(source).toContain("prepareCardEditor('card')");
    expect(source).toContain("prepareCardEditor('cycle')");
    expect(source).toContain("prepareCardEditor('scheduled-payment')");
    expect(source).toContain("prepareCardEditor('statement-payment')");
    expect(source.match(/if \(!beginCardMutation\(action\)\) return;/g)).toHaveLength(6);
    expect(source).toContain('disabled={pendingAction !== null}');
    expect(source).toContain('<GuidedEditorFeedback message={null} error={error} />');
  });

  it('uses a blue, offset focus ring without placing editor regions in normal tab order', () => {
    expect(styles).toMatch(
      /\.balance-editor-reveal:focus\s*\{[\s\S]*outline: 2px solid var\(--balance-focus-ring\)/,
    );
    expect(styles).toContain('scroll-margin-top: 24px');
  });
});
