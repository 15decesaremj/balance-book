// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { installFormDirtyTracker } from '../apps/desktop/src/form-dirty-tracker';

const trackers: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.dispose();
  document.body.replaceChildren();
});

describe('update restart form safety', () => {
  it('tracks user input without treating asynchronously populated defaults as edits', () => {
    document.body.innerHTML = '<form><input name="amount" value=""></form>';
    const input = document.querySelector('input')!;
    const tracker = installFormDirtyTracker(document, window);
    trackers.push(tracker);

    input.value = '125.00';
    expect(tracker.hasUnsavedChanges()).toBe(false);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(tracker.hasUnsavedChanges()).toBe(true);
    input.form!.reset();
    expect(tracker.hasUnsavedChanges()).toBe(false);
  });

  it('blocks restart while a form save is still in progress', () => {
    document.body.innerHTML = '<form aria-busy="true"><input name="amount"></form>';
    const tracker = installFormDirtyTracker(document, window);
    trackers.push(tracker);
    expect(tracker.hasUnsavedChanges()).toBe(true);
  });
});
