import { useEffect, useRef, type RefObject } from 'react';

export const editorRevealScrollBehavior = (prefersReducedMotion: boolean): ScrollBehavior =>
  prefersReducedMotion ? 'auto' : 'smooth';

/**
 * Reveals a conditionally rendered editor after the activating state is committed.
 * Call this hook unconditionally, then attach the returned ref to the editor region.
 */
export const useEditorReveal = <Element extends HTMLElement>(
  activeEditorKey: string | null,
): RefObject<Element | null> => {
  const editorRef = useRef<Element>(null);
  const lastRevealedKey = useRef<string | null>(null);

  useEffect(() => {
    if (activeEditorKey === null) {
      lastRevealedKey.current = null;
      return;
    }
    if (activeEditorKey === lastRevealedKey.current) return;

    const editor = editorRef.current;
    if (!editor) return;

    lastRevealedKey.current = activeEditorKey;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    editor.focus({ preventScroll: true });
    editor.scrollIntoView({
      behavior: editorRevealScrollBehavior(prefersReducedMotion),
      block: 'start',
    });
  }, [activeEditorKey]);

  return editorRef;
};
