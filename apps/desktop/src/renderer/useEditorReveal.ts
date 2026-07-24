import { useEffect, useRef, type RefObject } from 'react';

export const editorRevealScrollBehavior = (prefersReducedMotion: boolean): ScrollBehavior =>
  prefersReducedMotion ? 'auto' : 'smooth';

export type ImmediateActionLock = {
  acquire: (action: string) => boolean;
  release: (action: string) => void;
  active: () => string | null;
};

/**
 * A synchronous guard for async UI actions. React state makes the pending state visible, while
 * this controller closes the same-tick double-click window before a rerender can disable controls.
 */
export const createImmediateActionLock = (): ImmediateActionLock => {
  let activeAction: string | null = null;
  return {
    acquire: (action) => {
      if (activeAction !== null) return false;
      activeAction = action;
      return true;
    },
    release: (action) => {
      if (activeAction === action) activeAction = null;
    },
    active: () => activeAction,
  };
};

/**
 * Reveals a conditionally rendered editor after the activating state is committed.
 * Call this hook unconditionally, then attach the returned ref to the editor region.
 */
export const useEditorReveal = <Element extends HTMLElement>(
  activeEditorKey: string | null,
  revealRequest = 0,
): RefObject<Element | null> => {
  const editorRef = useRef<Element>(null);
  const lastRevealedKey = useRef<string | null>(null);
  const lastRevealRequest = useRef<number | null>(null);

  useEffect(() => {
    if (activeEditorKey === null) {
      lastRevealedKey.current = null;
      lastRevealRequest.current = null;
      return;
    }
    if (activeEditorKey === lastRevealedKey.current && revealRequest === lastRevealRequest.current)
      return;

    const editor = editorRef.current;
    if (!editor) return;

    lastRevealedKey.current = activeEditorKey;
    lastRevealRequest.current = revealRequest;
    const prefersReducedMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    editor.focus({ preventScroll: true });
    editor.scrollIntoView?.({
      behavior: editorRevealScrollBehavior(prefersReducedMotion),
      block: 'start',
    });
  }, [activeEditorKey, revealRequest]);

  return editorRef;
};
