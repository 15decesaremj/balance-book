export type FormDirtyTracker = {
  hasUnsavedChanges(): boolean;
  dispose(): void;
};

export const installFormDirtyTracker = (
  documentObject: Document,
  windowObject: Window,
): FormDirtyTracker => {
  const dirtyForms = new WeakSet<HTMLFormElement>();
  const formForEvent = (event: Event): HTMLFormElement | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest('form');
  };
  const markDirty = (event: Event): void => {
    const form = formForEvent(event);
    if (form) dirtyForms.add(form);
  };
  const clearDirty = (event: Event): void => {
    const form = formForEvent(event);
    if (form) dirtyForms.delete(form);
  };
  windowObject.addEventListener('input', markDirty, true);
  windowObject.addEventListener('change', markDirty, true);
  windowObject.addEventListener('reset', clearDirty, true);

  return {
    hasUnsavedChanges: () =>
      [...documentObject.forms].some(
        (form) => dirtyForms.has(form) || form.getAttribute('aria-busy') === 'true',
      ),
    dispose: () => {
      windowObject.removeEventListener('input', markDirty, true);
      windowObject.removeEventListener('change', markDirty, true);
      windowObject.removeEventListener('reset', clearDirty, true);
    },
  };
};
