import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  LoadingSkeleton,
  type LoadingSkeletonVariant,
} from '../apps/desktop/src/renderer/LoadingSkeleton';

const rendererSource = (name: string): string =>
  readFileSync(new URL(`../apps/desktop/src/renderer/${name}`, import.meta.url), 'utf8');

describe('accessible loading skeleton', () => {
  it('announces one meaningful status while hiding decorative shimmer geometry', () => {
    const markup = renderToStaticMarkup(
      createElement(LoadingSkeleton, {
        label: 'Building your financial plan',
        variant: 'dashboard',
      }),
    );

    expect(markup).toMatch(
      /class="balance-skeleton balance-skeleton--dashboard" role="status" aria-live="polite" aria-atomic="true"/,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(
      '<span class="balance-visually-hidden">Building your financial plan</span>',
    );
    expect(markup).toContain(
      'class="balance-skeleton__content" aria-hidden="true" aria-busy="true"',
    );
    expect(markup).not.toMatch(/<(button|input|select|textarea)\b/);
  });

  it.each<LoadingSkeletonVariant>(['launch', 'dashboard', 'form', 'list', 'inline-form'])(
    'renders stable %s geometry',
    (variant) => {
      const markup = renderToStaticMarkup(
        createElement(LoadingSkeleton, { label: 'Loading', variant }),
      );

      expect(markup).toContain(`balance-skeleton--${variant}`);
      expect(markup).toContain('balance-skeleton__bar');
    },
  );

  it('uses theme-aware shimmer, rounded panels, and an explicit reduced-motion fallback', () => {
    const styles = rendererSource('styles.css');

    expect(styles).toContain('--balance-skeleton-base: rgba(137, 166, 207, 0.13)');
    expect(styles).toContain('--balance-skeleton-base: rgba(57, 87, 126, 0.1)');
    expect(styles).toContain('@keyframes balance-book-shimmer');
    expect(styles).toContain('animation: balance-book-shimmer 1.65s ease-in-out infinite');
    expect(styles).toContain('border-radius: 20px');
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.balance-skeleton__bar[\s\S]*animation: none !important/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 540px\)[\s\S]*\.balance-skeleton__actions[\s\S]*width: 100%/,
    );
  });

  it('replaces renderer-level spinners without adding shimmer to action progress', () => {
    const pageFiles = ['App.tsx', 'CorePages.tsx', 'DashboardPage.tsx', 'RefinancePlannerPage.tsx'];
    const combined = pageFiles.map(rendererSource).join('\n');

    expect(combined).not.toMatch(/\bSpinner\b/);
    expect(combined).toContain('LoadingSkeleton label="Opening Balance Book"');
    expect(combined).toContain('LoadingSkeleton label="Building your financial plan"');
    expect(combined).toContain('LoadingSkeleton label="Loading money owed to you"');
    expect(combined).toContain("scenarioAction === 'evaluate-scenario' ? 'Evaluating");
    expect(combined).toContain("busy ? 'Saving");
  });
});
