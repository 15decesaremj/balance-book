import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import axe from 'axe-core';
import type { BalanceBookApi, ForecastSnapshotDto } from '../../apps/desktop/src/shared/contracts';

let app: ElectronApplication;
let dataDirectory: string;

const displayedMoneyToCents = (value: string): number => {
  const match = /^(-?)\$([\d,]+)\.(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Expected a displayed USD amount, received "${value}"`);
  const wholeDollars = Number(match[2]!.replaceAll(',', ''));
  const cents = wholeDollars * 100 + Number(match[3]);
  return match[1] ? -cents : cents;
};

const centsForInput = (cents: number): string => {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Invalid cents value: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
};

const formattedMoney = (cents: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const inputMoneyToCents = (value: string): number => {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`Expected a nonnegative money input, received "${value}"`);
  }
  return cents;
};

const expectNoSeriousAxeViolations = async (
  window: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
): Promise<void> => {
  await window.evaluate(axe.source);
  const violations = await window.evaluate(async () => {
    const axeApi = (
      globalThis as unknown as {
        axe: {
          run: () => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ html: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await axeApi.run();
    return result.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => ({
        ...violation,
        // Fluent's Tabster focus guards deliberately sit at the edge of a focus trap with
        // aria-hidden + tabindex=0. They are generated framework sentinels, not app content.
        nodes: violation.nodes.filter((node) => !node.html.includes('data-tabster-dummy')),
      }))
      .filter((violation) => violation.nodes.length > 0);
  });
  expect(violations).toEqual([]);
};

const expectStatusMessage = async (window: Page, message: string): Promise<void> => {
  // Loading skeletons also announce through role=status. Match the intended mutation result so
  // slow IPC cannot make this assertion ambiguous while a separate panel is still hydrating.
  await expect(window.getByRole('status').filter({ hasText: message })).toBeVisible({
    timeout: 30_000,
  });
};

const waitForViewTransition = async (view: Locator): Promise<void> => {
  await view.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        globalThis.requestAnimationFrame(() => {
          globalThis.requestAnimationFrame(() => {
            void Promise.all(
              element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
            ).then(() => resolve());
          });
        });
      }),
  );
};

const expectBoundsToMatch = (
  actual: Awaited<ReturnType<Locator['boundingBox']>>,
  expected: Awaited<ReturnType<Locator['boundingBox']>>,
): void => {
  expect(actual).not.toBeNull();
  expect(expected).not.toBeNull();
  for (const dimension of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual![dimension] - expected![dimension]),
      `${dimension} should remain fixed (${expected![dimension]} -> ${actual![dimension]})`,
    ).toBeLessThanOrEqual(0.5);
  }
};

const expectEditorReady = async (editor: Locator): Promise<void> => {
  await expect(editor).toBeVisible();
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const active = document.activeElement;
        return {
          focused:
            active !== null &&
            active !== document.body &&
            active !== document.documentElement &&
            (element === active || element.contains(active) || active.contains(element)),
          inViewport:
            bounds.height > 0 &&
            bounds.width > 0 &&
            bounds.bottom > 0 &&
            bounds.right > 0 &&
            bounds.top < globalThis.innerHeight &&
            bounds.left < globalThis.innerWidth,
        };
      }),
    )
    .toEqual({ focused: true, inViewport: true });
};

const waitForPageReady = async (window: Page): Promise<void> => {
  await window.locator('.balance-skeleton').waitFor({ state: 'hidden', timeout: 60_000 });
};

const captureStoreScreenshot = async (window: Page, filename: string): Promise<void> => {
  const outputDirectory = process.env.BALANCE_BOOK_STORE_SCREENSHOT_DIR;
  if (!outputDirectory) return;
  const previousViewport = window.viewportSize();
  await window.setViewportSize({ width: 1366, height: 768 });
  await window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        globalThis.scrollTo({ top: 0, left: 0 });
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
      }),
  );
  fs.mkdirSync(path.resolve(outputDirectory), { recursive: true });
  await window.screenshot({
    path: path.join(path.resolve(outputDirectory), filename),
    fullPage: false,
  });
  if (previousViewport) await window.setViewportSize(previousViewport);
};

const openPrimaryPage = async (
  window: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  name: string,
): Promise<void> => {
  const destinations: Record<string, { primary: string; secondary?: string }> = {
    Overview: { primary: 'Overview' },
    'Cash forecast': { primary: 'Forecast', secondary: 'Cash forecast' },
    'Income and raises': { primary: 'Forecast', secondary: 'Income and raises' },
    'Recurring plan': { primary: 'Forecast', secondary: 'Recurring plan' },
    'Credit cards': { primary: 'Accounts', secondary: 'Credit cards' },
    Loans: { primary: 'Accounts', secondary: 'Loans' },
    'Bills & subscriptions': { primary: 'Accounts', secondary: 'Bills & subscriptions' },
    'Money owed to you': { primary: 'Accounts', secondary: 'Money owed' },
    'Assets and net worth': { primary: 'Accounts', secondary: 'Assets and net worth' },
    Scenarios: { primary: 'Planning', secondary: 'Scenarios' },
    'Refinance planner': { primary: 'Planning', secondary: 'Refinance' },
    Charts: { primary: 'Planning', secondary: 'Trends' },
    Settings: { primary: 'Settings' },
    Reconciliation: { primary: 'Settings', secondary: 'Financial check-in' },
    'Setup checklist': { primary: 'Settings', secondary: 'Setup status' },
    'All financial records': { primary: 'Settings', secondary: 'Advanced records' },
  };
  const destination = destinations[name] ?? { primary: name };
  const primaryButton = window
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: destination.primary, exact: true });
  const usesCompactNavigation = await window.evaluate(() => globalThis.innerWidth <= 1120);
  if (usesCompactNavigation) {
    await window.getByLabel('Go to page').selectOption({ label: destination.primary });
  } else {
    await primaryButton.click();
  }
  if (destination.secondary) {
    await window
      .getByRole('navigation', { name: 'Section navigation' })
      .getByRole('button', { name: destination.secondary, exact: true })
      .click();
  }
  await waitForPageReady(window);
};

const reloadAndWait = async (window: Page): Promise<void> => {
  await window.reload();
  await waitForPageReady(window);
};

const selectSettingsCategory = async (window: Page, name: string): Promise<void> => {
  await window
    .getByRole('tablist', { name: 'Settings category' })
    .getByRole('tab', { name, exact: true })
    .click();
};

const openCardManagement = async (window: Page, cardName: string): Promise<Locator> => {
  const card = window
    .getByRole('heading', { name: cardName, exact: true })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  const manage = card.getByRole('button', { name: 'Manage', exact: true });
  const close = card.getByRole('button', { name: 'Close', exact: true });
  if (!(await close.isVisible())) {
    await expect(manage).toBeVisible();
    await manage.click();
  }
  await expect(close).toBeVisible();
  return card;
};

const layoutAuditRoutes = [
  '/',
  '/accounts',
  '/forecast',
  '/income',
  '/baseline',
  '/planning',
  '/scenario',
  '/refinance',
  '/cards',
  '/loans',
  '/bills',
  '/receivables',
  '/net-worth',
  '/charts',
  '/reconcile',
  '/setup',
  '/records',
  '/data',
] as const;

const layoutAuditWidths = [1440, 1121, 1120, 900, 520, 430, 360, 320] as const;

const expectStableLayout = async (window: Page, route: string, width: number): Promise<void> => {
  await window.setViewportSize({ width, height: 1000 });
  await window.evaluate((nextRoute) => {
    globalThis.location.hash = `#${nextRoute}`;
    globalThis.scrollTo({ top: 0, left: 0 });
  }, route);
  await window.waitForURL((url) => url.hash === `#${route}`, { timeout: 15_000 });
  await waitForPageReady(window);
  await window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
      }),
  );
  const audit = await window.evaluate(() => {
    type PaintedBox = {
      x: number;
      y: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      height: number;
    };
    const paintedBox = (element: HTMLElement): PaintedBox => {
      const raw = element.getBoundingClientRect();
      let left = raw.left;
      let right = raw.right;
      let top = raw.top;
      let bottom = raw.bottom;
      let ancestor = element.parentElement;
      while (ancestor) {
        const style = globalThis.getComputedStyle(ancestor);
        const clipX = ['auto', 'clip', 'hidden', 'scroll'].includes(style.overflowX);
        const clipY = ['auto', 'clip', 'hidden', 'scroll'].includes(style.overflowY);
        if (clipX || clipY) {
          const ancestorBox = ancestor.getBoundingClientRect();
          if (clipX) {
            left = Math.max(left, ancestorBox.left);
            right = Math.min(right, ancestorBox.right);
          }
          if (clipY) {
            top = Math.max(top, ancestorBox.top);
            bottom = Math.min(bottom, ancestorBox.bottom);
          }
        }
        ancestor = ancestor.parentElement;
      }
      return {
        x: left,
        y: top,
        left,
        right,
        top,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    };
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const closedDetails = element.closest('details:not([open])');
      if (closedDetails) {
        const visibleSummary = closedDetails.querySelector(':scope > summary');
        if (!visibleSummary?.contains(element)) return false;
      }
      const style = globalThis.getComputedStyle(element);
      const box = paintedBox(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        box.width > 1 &&
        box.height > 1
      );
    };
    const label = (element: HTMLElement): string =>
      (
        element.getAttribute('aria-label') ??
        element.getAttribute('name') ??
        element.textContent ??
        element.tagName
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);
    const intersection = (
      left: Pick<PaintedBox, 'left' | 'right' | 'top' | 'bottom'>,
      right: Pick<PaintedBox, 'left' | 'right' | 'top' | 'bottom'>,
    ): { width: number; height: number } => ({
      width: Math.min(left.right, right.right) - Math.max(left.left, right.left),
      height: Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
    });
    const boxLabel = (box: PaintedBox): string =>
      `[x=${box.x.toFixed(1)}, y=${box.y.toFixed(1)}, w=${box.width.toFixed(1)}, h=${box.height.toFixed(1)}]`;

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), select, textarea, summary, a[href]',
      ),
    )
      .filter(visible)
      // A quick-open hit area deliberately sits behind the whole summary card while its explicit
      // edit controls are raised above it. Their overlap is the interaction design, not collision.
      .filter((element) => !element.classList.contains('quick-open-hit'));
    const controlOverlaps: string[] = [];
    for (let firstIndex = 0; firstIndex < controls.length; firstIndex += 1) {
      const first = controls[firstIndex]!;
      for (let secondIndex = firstIndex + 1; secondIndex < controls.length; secondIndex += 1) {
        const second = controls[secondIndex]!;
        if (first.contains(second) || second.contains(first)) continue;
        const firstBox = paintedBox(first);
        const secondBox = paintedBox(second);
        const overlap = intersection(firstBox, secondBox);
        if (overlap.width > 1 && overlap.height > 1) {
          controlOverlaps.push(
            `${label(first)} ${boxLabel(firstBox)} <> ${label(second)} ${boxLabel(secondBox)}`,
          );
        }
      }
    }

    const watchedOverlaps: string[] = [];
    const watchedOverflows: string[] = [];
    for (const container of Array.from(
      document.querySelectorAll<HTMLElement>('[data-layout-watch]'),
    ).filter(visible)) {
      const children = Array.from(container.children)
        .filter(visible)
        .filter((child) => {
          const position = globalThis.getComputedStyle(child).position;
          return position !== 'absolute' && position !== 'fixed';
        });
      const containerBox = container.getBoundingClientRect();
      for (const child of children) {
        const childBox = child.getBoundingClientRect();
        if (childBox.left < containerBox.left - 1 || childBox.right > containerBox.right + 1) {
          watchedOverflows.push(
            `${container.dataset.layoutWatch ?? 'watched layout'}: ${label(child)}`,
          );
        }
      }
      for (let firstIndex = 0; firstIndex < children.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < children.length; secondIndex += 1) {
          const first = children[firstIndex]!;
          const second = children[secondIndex]!;
          const overlap = intersection(
            first.getBoundingClientRect(),
            second.getBoundingClientRect(),
          );
          if (overlap.width > 1 && overlap.height > 1) {
            watchedOverlaps.push(
              `${container.dataset.layoutWatch ?? 'watched layout'}: ${label(first)} <> ${label(second)}`,
            );
          }
        }
      }
    }

    return {
      horizontalOverflow: document.documentElement.scrollWidth - globalThis.innerWidth,
      controlOverlaps,
      watchedOverlaps,
      watchedOverflows,
    };
  });

  const context = `${route} at ${width}px`;
  expect(
    audit.horizontalOverflow,
    `${context} has page-level horizontal overflow`,
  ).toBeLessThanOrEqual(1);
  expect(audit.controlOverlaps, `${context} has overlapping controls`).toEqual([]);
  expect(audit.watchedOverlaps, `${context} has overlapping watched layout items`).toEqual([]);
  expect(audit.watchedOverflows, `${context} has watched content outside its container`).toEqual(
    [],
  );
};

test.beforeAll(async () => {
  if (process.env.BALANCE_BOOK_E2E_NATIVE_READY !== 'verified') {
    const pnpmCli = process.env.npm_execpath;
    const command = pnpmCli
      ? process.execPath
      : process.platform === 'win32'
        ? (process.env.ComSpec ?? 'cmd.exe')
        : 'pnpm';
    const prefix = pnpmCli
      ? [pnpmCli]
      : process.platform === 'win32'
        ? ['/d', '/s', '/c', 'pnpm']
        : [];
    execFileSync(command, [...prefix, 'exec', 'electron-rebuild', '-f', '-w', 'better-sqlite3'], {
      cwd: path.resolve('.'),
      stdio: 'pipe',
    });
  }
  dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-e2e-'));
  app = await electron.launch({
    args: ['.'],
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      BALANCE_BOOK_TODAY: '2026-07-14',
      BALANCE_BOOK_DATA_DIR: dataDirectory,
      BALANCE_BOOK_BOOTSTRAP_PROFILES: path.resolve('tests', 'fixtures', 'bootstrap-profiles.json'),
    },
  });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (dataDirectory) {
    fs.rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const pnpmCli = process.env.npm_execpath;
  if (process.env.BALANCE_BOOK_E2E_NATIVE_READY !== 'verified') {
    const command = pnpmCli
      ? process.execPath
      : process.platform === 'win32'
        ? (process.env.ComSpec ?? 'cmd.exe')
        : 'pnpm';
    const prefix = pnpmCli
      ? [pnpmCli]
      : process.platform === 'win32'
        ? ['/d', '/s', '/c', 'pnpm']
        : [];
    execFileSync(command, [...prefix, 'rebuild', 'better-sqlite3'], {
      cwd: path.resolve('.'),
      stdio: 'pipe',
    });
  }
});

test('completes the persistent authenticated forecast vertical slice', async () => {
  test.setTimeout(1_200_000);
  const window = await app.firstWindow();
  await expect(window).toHaveTitle('Balance Book');
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const activeWindow = BrowserWindow.getAllWindows()[0];
        return activeWindow ? activeWindow.isMenuBarVisible() : false;
      }),
    )
    .toBe(false);
  await window.getByTestId('native-menu-reveal-edge').hover({ position: { x: 20, y: 1 } });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const activeWindow = BrowserWindow.getAllWindows()[0];
        return activeWindow ? activeWindow.isMenuBarVisible() : false;
      }),
    )
    .toBe(true);
  await window.mouse.move(300, 180);
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) => {
          const activeWindow = BrowserWindow.getAllWindows()[0];
          return activeWindow ? activeWindow.isMenuBarVisible() : false;
        }),
      { timeout: 5_000 },
    )
    .toBe(false);
  await expect(window.getByRole('heading', { name: 'Choose a profile' })).toBeVisible();
  await expect(window.getByText('$', { exact: false })).toHaveCount(0);

  await window.getByRole('button', { name: 'Owner' }).click();
  await expect(window.getByRole('heading', { name: 'Protect Owner' })).toBeVisible();
  await window.getByLabel('Password', { exact: true }).fill('synthetic-test-password');
  await window.getByLabel('Confirm password').fill('synthetic-test-password');
  await window.getByRole('button', { name: 'Create password' }).click();

  await expect(window.getByRole('heading', { name: 'Build your first forecast' })).toBeVisible();
  const applicationShell = window.locator('[data-sidebar-collapsed]');
  const sidebar = window.locator('#primary-sidebar');
  const collapseNavigation = window.getByRole('button', {
    name: 'Collapse navigation',
    exact: true,
  });
  const expandedCollapseButtonBounds = await collapseNavigation.boundingBox();
  const expandedBrandMarkBounds = await window.getByTestId('sidebar-brand-mark').boundingBox();
  await expect(applicationShell).toHaveAttribute('data-sidebar-collapsed', 'false');
  const expandedSidebarWidth = (await sidebar.boundingBox())?.width ?? 0;
  await collapseNavigation.click();
  await expect(applicationShell).toHaveAttribute('data-sidebar-collapsed', 'true');
  expectBoundsToMatch(
    await window.getByRole('button', { name: 'Expand navigation', exact: true }).boundingBox(),
    expandedCollapseButtonBounds,
  );
  expectBoundsToMatch(
    await window.getByTestId('sidebar-brand-mark').boundingBox(),
    expandedBrandMarkBounds,
  );
  await waitForViewTransition(applicationShell);
  await expect(
    window
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Overview', exact: true }),
  ).toBeVisible();
  await window.screenshot({
    path: 'local-screenshots/desktop-navigation-collapsed.png',
    fullPage: false,
  });
  const collapsedOverflowDiagnostics = await sidebar.evaluate((element) => {
    const boundary = element.getBoundingClientRect().right + 1;
    return [...element.querySelectorAll<HTMLElement>('*')]
      .filter((child) => child.getBoundingClientRect().right > boundary)
      .map((child) => ({
        tag: child.tagName,
        className: child.className,
        ariaLabel: child.getAttribute('aria-label'),
        right: Math.round(child.getBoundingClientRect().right),
        width: Math.round(child.getBoundingClientRect().width),
        clientWidth: child.clientWidth,
        scrollWidth: child.scrollWidth,
      }))
      .slice(0, 12);
  });
  expect(collapsedOverflowDiagnostics).toEqual([]);
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  const collapsedSidebarWidth = (await sidebar.boundingBox())?.width ?? 0;
  expect(collapsedSidebarWidth).toBeLessThan(expandedSidebarWidth);
  await reloadAndWait(window);
  await expect(applicationShell).toHaveAttribute('data-sidebar-collapsed', 'true');
  await window
    .getByRole('button', {
      name: 'Expand navigation from Balance Book logo',
      exact: true,
    })
    .click();
  await expect(applicationShell).toHaveAttribute('data-sidebar-collapsed', 'false');
  const mainContent = window.locator('#main-content');
  const skipLink = window.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toHaveAttribute('href', '#main-content');
  await skipLink.focus();
  await window.keyboard.press('Enter');
  await expect(mainContent).toBeFocused();
  await expect(skipLink).toHaveCSS('opacity', '0');
  await expect(skipLink).toHaveCSS('pointer-events', 'none');
  await window.getByRole('button', { name: 'Start guided setup' }).click();
  await expect(window.getByRole('heading', { name: 'First forecast setup' })).toBeVisible();
  await captureStoreScreenshot(window, '01-welcome-local-data.png');
  const localDataConsent = window.getByRole('checkbox', {
    name: /I consent to Balance Book storing the financial information I enter locally/,
  });
  await expect(localDataConsent).not.toBeChecked();
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(
    window.getByText('Confirm how Balance Book stores the information you enter'),
  ).toBeVisible();
  await localDataConsent.check();
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(
    window.getByRole('heading', { name: 'Which parts fit your finances?' }),
  ).toBeVisible();
  const applicabilityQuestions = [
    'Do you want to track income, raises, or bonuses?',
    'Do you pay bills or subscriptions?',
    'Do you use credit cards?',
    'Do you have installment loans?',
    'Does anyone reimburse or repay you?',
    'Do you want to track investments or other assets?',
  ];
  for (const question of applicabilityQuestions) {
    await window
      .getByRole('group', { name: question })
      .getByRole('button', { name: 'Yes' })
      .click();
  }
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'Cash account' })).toBeVisible();
  await expect(window.getByLabel('Account name')).toHaveValue('');
  await expect(window.getByLabel('Opening balance')).toHaveValue('');
  await window.getByLabel('Balance as of').fill('2026-07-14');
  await window.getByLabel('Account name').fill('Primary checking');
  await window.getByLabel('Opening balance').fill('2500.00');
  await window.waitForTimeout(700);
  await reloadAndWait(window);
  await expect(window.getByRole('heading', { name: 'First forecast setup' })).toBeVisible();
  await expectStatusMessage(window, 'Resumed saved setup');
  await expect(localDataConsent).toBeChecked();
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(
    window.getByRole('heading', { name: 'Which parts fit your finances?' }),
  ).toBeVisible();
  for (const question of applicabilityQuestions) {
    await expect(
      window.getByRole('group', { name: question }).getByRole('button', { name: 'Yes' }),
    ).toHaveAttribute('aria-pressed', 'true');
  }
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByLabel('Account name')).toHaveValue('Primary checking');
  await expect(window.getByLabel('Opening balance')).toHaveValue('2500.00');
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'One upcoming deposit' })).toBeVisible();
  await window.getByLabel('Deposit source').fill('Paycheck');
  await window.getByLabel('Deposit date').fill('2026-07-21');
  await window.getByLabel('Net deposit amount').fill('2000.00');
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'One upcoming bill' })).toBeVisible();
  await window.getByLabel('Bill name').fill('Housing payment');
  await window.getByLabel('Payment date').fill('2026-07-17');
  await window.getByLabel('Amount', { exact: true }).fill('1200.00');
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'Credit card' })).toBeVisible();
  await window.getByLabel('Card name').fill('Everyday card');
  await window.getByLabel('Typical future statement').fill('500.00');
  await window.getByLabel('Statement closes on day').fill('7');
  await window.getByLabel('Payment happens on day').fill('28');
  await window.getByLabel('Open-cycle estimate policy').selectOption('baseline-guardrail');
  await window.getByLabel('Payment policy').selectOption('full-statement');
  await expect(window.getByLabel('Card name')).toHaveValue('Everyday card');
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'Global minimum and buffer' })).toBeVisible();
  await window.getByLabel('Global protected minimum').fill('500.00');
  await window.getByLabel('Preferred buffer').fill('1000.00');
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'Review first forecast' })).toBeVisible();
  await window.getByRole('button', { name: 'Save first forecast and continue' }).click();

  await expect(
    window.getByRole('heading', { name: 'Complete your financial picture' }),
  ).toBeVisible();
  const cardSetupHeadings = window.getByRole('heading', {
    name: 'Credit cards and statement history',
  });
  await expect(cardSetupHeadings).toHaveCount(2);
  await expect(cardSetupHeadings.first()).toBeVisible();
  const cardSetupTopic = cardSetupHeadings
    .last()
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await expect(cardSetupTopic).toContainText('Needs setup');
  await expect(cardSetupTopic).not.toContainText('Ready · data entered');
  await expect(
    window.getByRole('heading', { name: 'Income and recurring money coming in' }),
  ).toBeVisible();
  const sourceReviewHeading = window.getByRole('heading', {
    name: 'Sources, import mapping, and audit trail',
  });
  await expect(sourceReviewHeading).toHaveCount(0);
  await expect(window.getByText(/^Advanced review/)).toHaveCount(0);
  await window.getByRole('button', { name: 'Review cards' }).first().click();
  await openCardManagement(window, 'Everyday card');
  await window.getByRole('button', { name: 'Add statement' }).click();
  await window.getByLabel('Cycle opens').fill('2026-06-08');
  await window.getByLabel('Cycle closes').fill('2026-07-07');
  await window.getByLabel('Payment due').fill('2026-07-28');
  await window.getByLabel('Cycle status').selectOption('closed-statement');
  await window.getByLabel('Typical statement estimate').fill('500.00');
  await window.getByLabel('Activity posted in this cycle').fill('0.00');
  await window.getByLabel('Planned activity').fill('0.00');
  await window.getByLabel('Locked statement balance', { exact: true }).fill('500.00');
  await window.getByRole('button', { name: 'Save statement cycle' }).click();
  await window.getByRole('button', { name: 'Add statement' }).click();
  await window.getByLabel('Cycle opens').fill('2026-07-08');
  await window.getByLabel('Cycle closes').fill('2026-08-07');
  await window.getByLabel('Payment due').fill('2026-08-28');
  await window.getByLabel('Cycle status').selectOption('open');
  await window.getByLabel('Typical statement estimate').fill('500.00');
  await window.getByLabel('Activity posted in this cycle').fill('100.00');
  await window.getByLabel('Planned activity').fill('0.00');
  await window.getByRole('button', { name: 'Save statement cycle' }).click();

  await window.getByRole('button', { name: 'Add card or credit line' }).click();
  await window.getByLabel('Card name').fill('Rewards card');
  await window.getByLabel('Typical future statement').fill('400.00');
  await window.getByLabel('Statement closes on day').fill('15');
  await window.getByLabel('Payment happens on day').fill('5');
  await window.getByLabel('Open-cycle estimate policy').selectOption('baseline-guardrail');
  await window.getByLabel('Payment policy').selectOption('full-statement');
  await window.getByRole('button', { name: 'Save card' }).click();
  await expectStatusMessage(window, 'Credit card added. Add its current cycle next.');
  await openCardManagement(window, 'Rewards card');
  await window.getByRole('button', { name: 'Add statement' }).click();
  await window.getByLabel('Cycle opens').fill('2026-07-16');
  await window.getByLabel('Cycle closes').fill('2026-08-15');
  await window.getByLabel('Payment due').fill('2026-09-05');
  await window.getByLabel('Cycle status').selectOption('open');
  await window.getByLabel('Typical statement estimate').fill('400.00');
  await window.getByLabel('Activity posted in this cycle').fill('0.00');
  await window.getByLabel('Planned activity').fill('0.00');
  await window.getByRole('button', { name: 'Save statement cycle' }).click();
  await expectStatusMessage(window, 'Statement cycle added');

  await openPrimaryPage(window, 'Income and raises');
  await expect(window.getByRole('heading', { name: 'Income and raises' })).toBeVisible();
  await expect(mainContent).toBeFocused();
  await window.getByLabel('Source or label').fill('Main salary');
  await window.getByLabel('Income type').selectOption('paycheck');
  await window.getByLabel('Net amount', { exact: true }).fill('3000.00');
  await window.getByLabel('First or next arrival').fill('2026-07-20');
  await window.getByLabel('Cadence').selectOption('monthly');
  await window.getByLabel('Repeat every (months)').fill('1');
  await window.getByLabel('Certainty').selectOption('confirmed');
  await window.getByLabel('Notes (optional)').fill('Synthetic monthly take-home pay');
  await window.getByRole('button', { name: 'Save income stream' }).click();
  await expectStatusMessage(
    window,
    'Income saved and applied to both expected and protected cash projections.',
  );
  await expect(
    window.getByRole('heading', { name: 'Exact forecast impact: Income stream' }),
  ).toBeVisible();

  await expect(window.getByLabel('Recurring base pay').locator('option:checked')).toContainText(
    'Main salary',
  );
  await window.getByLabel('How are you entering the raise?').selectOption('new-net');
  await window.getByLabel('New net deposit').fill('3300.00');
  await window.getByLabel('First higher-pay arrival').fill('2026-08-20');
  await window.getByLabel('Raise status').selectOption('expected');
  await window.getByLabel('Bonus net amount').fill('600.00');
  await window.getByLabel('Bonus arrival date').fill('2026-08-05');
  await window.getByLabel('Bonus status').selectOption('expected');
  await window.getByRole('button', { name: 'Save raise plan' }).click();
  await expectStatusMessage(window, 'Projected higher pay saved in the expected projection only.');
  await expect(
    window.getByRole('heading', { name: 'Exact forecast impact: Raise and bonus plan' }),
  ).toBeVisible();
  await expect(
    window.getByText('Expected cash at horizon', { exact: true }).locator('..'),
  ).toContainText('change $1,200.00');
  await expect(
    window.getByText('Protected cash at horizon', { exact: true }).locator('..'),
  ).toContainText('change $0.00');
  await expect(window.getByRole('strong').filter({ hasText: /^Main salary$/ })).toBeVisible();
  await expect(
    window.getByRole('strong').filter({ hasText: /^Main salary raise adjustment$/ }),
  ).toBeVisible();
  await expect(window.getByRole('strong').filter({ hasText: /^Main salary bonus$/ })).toBeVisible();
  await expect(window.getByText('Linked to recurring base: Main salary')).toBeVisible();
  await window.setViewportSize({ width: 430, height: 900 });
  const mobileRouteSelector = window.getByRole('combobox', { name: 'Go to page' });
  await expect(mobileRouteSelector).toBeVisible();
  await mobileRouteSelector.selectOption('/');
  await expect(mobileRouteSelector).toHaveValue('/');
  await expect(mainContent).toBeFocused();
  await expect(window.getByRole('heading', { name: 'How much can I safely spend?' })).toBeVisible();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(window);
  await window.setViewportSize({ width: 1440, height: 1000 });

  for (const hub of [
    {
      page: 'Accounts',
      title: 'Cash accounts',
      description: 'Balances, protection, visibility, and transfer timing.',
    },
    {
      page: 'Planning',
      title: 'Scenarios',
      description: 'Test purchases and saved what-if decisions.',
    },
  ] as const) {
    await openPrimaryPage(window, hub.page);
    const titleBox = await window.getByRole('heading', { name: hub.title }).boundingBox();
    const descriptionBox = await window.getByText(hub.description, { exact: true }).boundingBox();
    expect(titleBox).not.toBeNull();
    expect(descriptionBox).not.toBeNull();
    expect(descriptionBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 1);
  }

  await openPrimaryPage(window, 'Overview');

  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveCount(0);
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe('dark');
  await expect(
    window.getByRole('heading', { name: 'Safe to spend on each card today' }),
  ).toBeVisible();
  await expect(
    window.getByText('Each card has its own runway. Do not add the amounts together.', {
      exact: false,
    }),
  ).toBeVisible();
  const forecastMode = window.getByRole('group', { name: 'Forecast mode' });
  await expect(forecastMode.getByRole('button', { name: 'Expected' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await window.getByRole('button', { name: 'Conservative' }).click();
  await expect(forecastMode.getByRole('button', { name: 'Conservative' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await window.getByRole('button', { name: 'Expected' }).click();
  const everydaySafeSpend = window.getByLabel('Everyday card available spend');
  await expect(everydaySafeSpend).toHaveText(/^\$[\d,]+\.\d{2}$/);
  const everydaySafeSpendCents = displayedMoneyToCents(
    (await everydaySafeSpend.textContent()) ?? '',
  );
  expect(everydaySafeSpendCents).toBeGreaterThan(0);
  const everydaySummary = window.getByLabel('Everyday card safe spending summary');
  await expect(everydaySummary.getByLabel('Everyday card next due date')).toHaveText(
    'Due Jul 28, 2026',
  );
  await expect(
    window
      .getByLabel('Rewards card safe spending summary')
      .getByLabel('Rewards card next due date'),
  ).toHaveText('Due Aug 5, 2026');
  await expect(everydaySummary.getByLabel('Everyday card current balance')).toHaveText('$600.00');
  await expect(everydaySummary.getByLabel('Everyday card last statement balance')).toHaveText(
    '$500.00',
  );
  await expect(everydaySummary.getByLabel('Everyday card still owed on statements')).toHaveCount(0);
  const everydayQuickOpen = everydaySummary.getByRole('button', {
    name: 'Open quick update for Everyday card',
  });
  await everydayQuickOpen.click();
  const everydayDetail = window.getByRole('dialog');
  await expect(
    everydayDetail.getByRole('tablist', { name: 'Financial detail section' }),
  ).toBeVisible();
  await everydayDetail.getByRole('tab', { name: 'Activity' }).click();
  await expect(everydayDetail.getByText('Issuer balance snapshot')).toBeVisible();
  await everydayDetail.getByRole('tab', { name: 'Plan' }).click();
  await expect(everydayDetail.getByText('Safe spend this cycle')).toBeVisible();
  await expect(everydayDetail.getByRole('button', { name: 'Record payment' })).toBeVisible();
  await expect(everydayDetail.getByRole('button', { name: 'Schedule payment' })).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(everydayDetail).not.toBeVisible();
  await expect(everydayQuickOpen).toBeFocused();
  const overviewSnapshot: ForecastSnapshotDto = await window.evaluate(async () => {
    const response = await (
      globalThis as unknown as { balanceBook: BalanceBookApi }
    ).balanceBook.getForecast();
    if (!response.ok) throw new Error(response.error);
    return response.value;
  });
  const defaultOverviewOrder = [...(overviewSnapshot.cardSpendingPower ?? [])]
    .sort(
      (left, right) =>
        (left.currentCycleClosesOn ?? '\uffff').localeCompare(
          right.currentCycleClosesOn ?? '\uffff',
        ) || left.cardName.localeCompare(right.cardName),
    )
    .map((card) => card.cardName);
  const displayedOverviewOrder = async (): Promise<string[]> =>
    window
      .locator('[aria-label$=" safe spending summary"]')
      .evaluateAll((elements) =>
        elements.map((element) =>
          element.getAttribute('aria-label')!.replace(' safe spending summary', ''),
        ),
      );
  expect(await displayedOverviewOrder()).toEqual(defaultOverviewOrder);
  for (const card of overviewSnapshot.cardSpendingPower ?? []) {
    expect(card.nextStatementDueOn).toBeDefined();
    expect(card.nextStatementPositionCents).toBeDefined();
    expect(card.currentCyclePaymentOn).toBeDefined();
    expect(card.nextStatementDueOn! > card.currentCyclePaymentOn!).toBe(true);
    const nextStatementLow = overviewSnapshot.dailyCash
      ?.filter((day) => day.date >= card.nextStatementDueOn!)
      .reduce((lowest, day) =>
        day.expectedPositionCents < lowest.expectedPositionCents ? day : lowest,
      );
    expect(nextStatementLow?.expectedPositionCents).toBe(card.nextStatementPositionCents);
    await expect(window.getByLabel(`${card.cardName} next statement position`)).toContainText(
      formattedMoney(card.nextStatementPositionCents!),
    );
    await expect(
      window.getByLabel(`${card.cardName} owed to me at total position low`),
    ).toContainText(formattedMoney(card.futurePositionLowReceivableCents));
  }
  const cardSort = window.getByLabel('Overview card sort order');
  await cardSort.selectOption('name-desc');
  expect(await displayedOverviewOrder()).toEqual(
    [...defaultOverviewOrder].sort((left, right) => right.localeCompare(left)),
  );
  await cardSort.selectOption('balance-desc');
  const debtByCardId = new Map(
    (overviewSnapshot.revolvingDebtByCard ?? []).map((debt) => [debt.cardId, debt] as const),
  );
  expect(await displayedOverviewOrder()).toEqual(
    [...(overviewSnapshot.cardSpendingPower ?? [])]
      .sort(
        (left, right) =>
          (debtByCardId.get(right.cardId)?.currentBalanceCents ?? -1) -
            (debtByCardId.get(left.cardId)?.currentBalanceCents ?? -1) ||
          left.cardName.localeCompare(right.cardName),
      )
      .map((card) => card.cardName),
  );
  await cardSort.selectOption('period-asc');
  await expect(everydaySummary.getByText('Runway available', { exact: true })).toHaveCount(0);
  await expect(everydaySummary.getByText('Needs card setup', { exact: true })).toHaveCount(0);
  await expect(everydaySummary.getByLabel('Everyday card runway lows')).toBeVisible();
  await expect(everydaySummary.getByLabel('Everyday card total position low')).toHaveText(
    /^\$[\d,]+\.\d{2}$/,
  );
  await expect(everydaySummary.getByLabel('Everyday card Primary checking account low')).toHaveText(
    /^-?\$[\d,]+\.\d{2}$/,
  );
  await expect(everydaySummary.getByText('Available this cycle')).toBeVisible();
  await expect(everydaySummary.getByText('Cash-only capacity', { exact: true })).toHaveCount(0);
  await expect(everydaySummary.getByText('Funding-account low', { exact: true })).toHaveCount(0);
  await expect(window.getByText('Lowest liquid cash', { exact: true })).toHaveCount(0);
  await expect(
    window.getByRole('heading', { name: 'How each safe-spend limit is calculated' }),
  ).toHaveCount(0);
  await expect(window.getByLabel('Upcoming cash events table')).toHaveAttribute('tabindex', '0');
  await window.locator('summary').filter({ hasText: 'Wider financial picture' }).click();
  await expect(
    window.getByRole('heading', { name: 'Debt, net worth, and review status' }),
  ).toBeVisible();

  // Available spend follows the selected total-position runway. The purchase advisor is the
  // stricter conservative cash/account boundary, so exercise it against the separately displayed
  // cash-only capacity instead of assuming those intentionally distinct controls are identical.
  await window.getByRole('button', { name: 'Conservative' }).click();
  await expect(window.getByText('Lowest liquid cash', { exact: true })).toBeVisible();
  const everydayFundingLow = everydaySummary
    .getByText('Payment account low', { exact: true })
    .locator('..');
  await expect(everydayFundingLow).toContainText(/\w{3} \d{1,2}, 2026/);
  await expect(everydayFundingLow).toContainText(/minimum \$[\d,]+\.\d{2}/);
  const calculationSummary = window.getByText(/^Show full calculations for all 2 cards$/);
  const calculationDisclosure = calculationSummary.locator('..');
  await expect(calculationDisclosure).not.toHaveAttribute('open', '');
  await expect(window.getByText('Explain this card').first()).toBeHidden();
  await calculationSummary.click();
  await expect(calculationDisclosure).toHaveAttribute('open', '');
  await expect(window.getByText('Future liquid cash low').first()).toBeVisible();
  await expect(window.getByText('Explain this card').first()).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Position versus cash' })).toBeVisible();
  const everydayCashOnlyCapacity = window.getByLabel('Everyday card cash-only capacity');
  const everydayCashOnlyCapacityCents = displayedMoneyToCents(
    (await everydayCashOnlyCapacity.textContent()) ?? '',
  );
  expect(everydayCashOnlyCapacityCents).toBeGreaterThan(0);
  await window.locator('summary').filter({ hasText: 'Test a purchase' }).click();
  const purchaseAdvisor = window
    .getByRole('heading', { name: 'Which card should I use?' })
    .locator('xpath=ancestor::details[1]');
  await purchaseAdvisor
    .getByLabel('Purchase amount')
    .fill(centsForInput(everydayCashOnlyCapacityCents));
  await purchaseAdvisor.getByLabel('Purchase date').fill('2026-07-14');
  await purchaseAdvisor.getByRole('button', { name: 'Compare every card' }).click();
  await expect(
    purchaseAdvisor.getByRole('heading', { name: 'You can use any card' }),
  ).toBeVisible();
  const rankedSummary = purchaseAdvisor.getByText(/^Compare all 2 ranked card options$/);
  const rankedDisclosure = rankedSummary.locator('..');
  await expect(rankedDisclosure).not.toHaveAttribute('open', '');
  await expect(purchaseAdvisor.getByRole('list', { name: 'Ranked card options' })).toBeHidden();
  await rankedSummary.click();
  await expect(rankedDisclosure).toHaveAttribute('open', '');
  await expect(
    purchaseAdvisor.getByRole('list', { name: 'Ranked card options' }).getByRole('listitem'),
  ).toHaveCount(2);
  const everydayAtDisplayedLimit = purchaseAdvisor
    .getByRole('list', { name: 'Ranked card options' })
    .locator('[aria-label$=": Everyday card"]');
  await expect(everydayAtDisplayedLimit).toContainText('Can use');
  await expect(everydayAtDisplayedLimit).toContainText('Within total and account thresholds');
  await expect(everydayAtDisplayedLimit).toContainText('Total-position margin');
  await expect(everydayAtDisplayedLimit).toContainText('$0.00');

  await purchaseAdvisor
    .getByLabel('Purchase amount')
    .fill(centsForInput(everydayCashOnlyCapacityCents + 1));
  await purchaseAdvisor.getByRole('button', { name: 'Compare every card' }).click();
  const overLimitRankedSummary = purchaseAdvisor.getByText(/^Compare all 2 ranked card options$/);
  await expect(overLimitRankedSummary.locator('..')).not.toHaveAttribute('open', '');
  await overLimitRankedSummary.click();
  const everydayOneCentOver = purchaseAdvisor
    .getByRole('list', { name: 'Ranked card options' })
    .locator('[aria-label$=": Everyday card"]');
  await expect(everydayOneCentOver).toContainText('Needs a plan change');
  await expect(everydayOneCentOver).toContainText('Outside a total or account threshold');
  await expect(everydayOneCentOver).toContainText('-$0.01');
  await window.setViewportSize({ width: 430, height: 900 });
  await expect(mobileRouteSelector).toBeVisible();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(window);
  await window.setViewportSize({ width: 1440, height: 1000 });
  fs.mkdirSync(path.resolve('local-screenshots'), { recursive: true });
  await window.screenshot({
    path: 'local-screenshots/daily-driver-overview-dark.png',
    fullPage: true,
  });
  await captureStoreScreenshot(window, '02-overview.png');

  await openPrimaryPage(window, 'Cash forecast');
  await expect(window.getByRole('heading', { name: 'Cash forecast', exact: true })).toBeVisible();
  await expect(window.getByText('Net monthly free cash flow', { exact: true })).toBeVisible();
  await expect(
    window.getByText(/known future card payments included|Conservative recurring budget margin/),
  ).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Daily closes' })).toBeVisible();
  await expect(window.getByRole('columnheader', { name: 'Total position' })).toBeVisible();
  await expect(window.getByRole('columnheader', { name: 'Liquid cash' })).toBeVisible();
  await expect(window.getByRole('columnheader', { name: 'Money owed' })).toBeVisible();
  await expect(
    window.getByText(/Conservative keeps active cash outflows but removes unconfirmed inflows/),
  ).toBeVisible();
  await window
    .getByRole('group', { name: 'Forecast mode' })
    .getByRole('button', {
      name: 'Expected',
    })
    .click();
  await expect(
    window.getByText(/Expected currently depends on \d+ nonconfirmed cash events?/),
  ).toBeVisible();
  await expect(window.getByLabel('Housing payment on 2026-07-17 event state')).toHaveText(
    'Planned',
  );
  await expect(window.getByLabel('Paycheck on 2026-07-21 event state')).toHaveText('Estimated');
  await expect(window.getByLabel('Main salary on 2026-07-20 event state')).toHaveText('Planned');
  await expect(window.getByLabel('Main salary bonus on 2026-08-05 event state')).toHaveText(
    'Estimated',
  );
  await expect(
    window.getByLabel('Main salary raise adjustment on 2026-08-20 event state'),
  ).toHaveText('Estimated');
  await expect(
    window.getByLabel('Everyday card statement payment on 2026-07-28 event state'),
  ).toHaveText('Locked');
  await captureStoreScreenshot(window, '03-cash-forecast.png');
  expect(
    await window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth),
  ).toBeLessThanOrEqual(1);
  await window.setViewportSize({ width: 430, height: 900 });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  const firstMobileDay = window
    .locator('[aria-label^="Daily closes for "]')
    .locator('details')
    .first();
  const firstMobileDaySummary = firstMobileDay.locator('summary');
  await expect(firstMobileDaySummary).toBeVisible();
  await expect(firstMobileDaySummary.getByText('Jul 14, 2026', { exact: true })).toBeVisible();
  await expect(firstMobileDaySummary.getByText(/^\$[\d,]+\.\d{2}$/)).toBeVisible();
  await expect
    .poll(async () => (await firstMobileDaySummary.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(40);
  await window.screenshot({
    path: 'local-screenshots/daily-driver-forecast-mobile.png',
    fullPage: true,
  });
  await window.setViewportSize({ width: 1440, height: 1000 });

  await openPrimaryPage(window, 'Credit cards');
  await expect(window.getByRole('heading', { name: 'Credit cards', exact: true })).toBeVisible();
  await expect(window.getByText('Last statement', { exact: true })).toHaveCount(2);
  await expect(window.getByText('Current balance', { exact: true })).toHaveCount(2);
  await openCardManagement(window, 'Everyday card');
  await expect(window.getByLabel('Everyday card estimated monthly interest')).toContainText(
    '$0.00',
  );
  await expect(window.getByLabel('Everyday card estimated monthly interest')).toContainText(
    'No balance carried',
  );
  const firstEditCardButton = window
    .getByRole('button', { name: 'Edit card', exact: true })
    .first();
  await firstEditCardButton.click();
  const cardEditor = window.getByRole('form', { name: 'Credit card editor' });
  await expectEditorReady(cardEditor);
  await firstEditCardButton.click();
  await expectEditorReady(cardEditor);
  await cardEditor.getByLabel('Typical future statement').fill('550.00');
  await window.getByRole('button', { name: 'Save card' }).click();
  await expectStatusMessage(window, 'Card terms updated');
  await window.getByRole('button', { name: 'Update current spending' }).first().click();
  const statementCycleEditor = window.getByRole('form', { name: 'Statement cycle editor' });
  await expectEditorReady(statementCycleEditor);
  await statementCycleEditor.getByLabel('Typical statement estimate').fill('550.00');
  await statementCycleEditor.getByLabel('Activity posted in this cycle').fill('125.00');
  await statementCycleEditor.getByLabel('Planned activity').fill('25.00');
  await statementCycleEditor.getByRole('button', { name: 'Save statement cycle' }).click();
  await expectStatusMessage(window, 'Statement cycle updated');
  await expect(window.getByText('$125.00')).toBeVisible();

  const everydayCardPanel = window
    .getByRole('heading', { name: 'Everyday card' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  const addScheduledPayment = async (input: {
    date: string;
    amount: string;
    label: string;
  }): Promise<void> => {
    await everydayCardPanel.getByRole('button', { name: 'Schedule payment' }).click();
    const paymentForm = everydayCardPanel
      .getByRole('button', { name: 'Add payment to forecast' })
      .locator('xpath=ancestor::form[1]');
    await expectEditorReady(paymentForm);
    await paymentForm.getByLabel('Payment date').fill(input.date);
    await paymentForm.getByLabel('Amount').fill(input.amount);
    await paymentForm.getByLabel('Statement (optional)').selectOption({ index: 1 });
    await paymentForm.getByLabel('Label (optional)').fill(input.label);
    await paymentForm.getByRole('button', { name: 'Add payment to forecast' }).click();
    await expectStatusMessage(
      window,
      'payment scheduled. Its dated cash effect is now in the forecast',
    );
  };
  await addScheduledPayment({
    date: '2026-07-20',
    amount: '125.00',
    label: 'Synthetic installment one',
  });
  await addScheduledPayment({
    date: '2026-07-25',
    amount: '75.00',
    label: 'Synthetic installment two',
  });
  const firstInstallmentRow = everydayCardPanel
    .getByText('Synthetic installment one', { exact: true })
    .locator('xpath=ancestor::div[2]');
  await expect(firstInstallmentRow).toContainText('$125.00');
  await firstInstallmentRow.getByRole('button', { name: 'Edit payment' }).click();
  const editPaymentForm = everydayCardPanel
    .getByRole('button', { name: 'Save payment changes' })
    .locator('xpath=ancestor::form[1]');
  await expectEditorReady(editPaymentForm);
  await expect(editPaymentForm.getByLabel('Amount')).toHaveValue('125.00');
  await editPaymentForm.getByLabel('Amount').fill('130.00');
  await editPaymentForm.getByRole('button', { name: 'Save payment changes' }).click();
  await expectStatusMessage(
    window,
    'payment updated. Its revised cash effect is now in the forecast',
  );
  await expect(
    everydayCardPanel
      .getByText('Synthetic installment one', { exact: true })
      .locator('xpath=ancestor::div[2]'),
  ).toContainText('$130.00');
  const secondInstallmentRow = everydayCardPanel
    .getByText('Synthetic installment two', { exact: true })
    .locator('xpath=ancestor::div[2]');
  await secondInstallmentRow.getByRole('button', { name: 'Cancel payment' }).click();
  await expectStatusMessage(window, 'Synthetic installment two cancelled');
  await expect(
    everydayCardPanel.getByText('Synthetic installment two', { exact: true }),
  ).toHaveCount(0);

  await openPrimaryPage(window, 'Cash forecast');
  const installmentState = window.getByLabel('Synthetic installment one on 2026-07-20 event state');
  await expect(installmentState).toHaveText('Locked');
  await expect(installmentState.locator('xpath=ancestor::tr[1]')).toContainText('-$130.00');
  const remainingAutopayState = window.getByLabel(
    'Everyday card statement payment on 2026-07-28 event state',
  );
  await expect(remainingAutopayState.locator('xpath=ancestor::tr[1]')).toContainText('-$370.00');
  await expect(window.getByText('Synthetic installment two', { exact: true })).toHaveCount(0);

  await openPrimaryPage(window, 'Credit cards');
  await expectNoSeriousAxeViolations(window);
  await captureStoreScreenshot(window, '04-credit-cards.png');
  await window.screenshot({ path: 'local-screenshots/daily-driver-cards.png', fullPage: true });

  await openPrimaryPage(window, 'Charts');
  await expect(window.getByRole('heading', { name: 'Trends' })).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Balances over time' })).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Patterns that matter' })).toBeVisible();
  const chartControls = window.getByRole('region', { name: 'Chart controls' });
  const historicalToggle = chartControls.getByRole('button', { name: 'Historical' });
  const futureToggle = chartControls.getByRole('button', { name: 'Expected future' });
  await expect(historicalToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(futureToggle).toHaveAttribute('aria-pressed', 'true');
  await futureToggle.click();
  await expect(futureToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(historicalToggle).toHaveAttribute('aria-pressed', 'true');
  await futureToggle.click();
  await expect(futureToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(window.getByText('Average monthly carry')).toBeVisible();
  await expectNoSeriousAxeViolations(window);
  await captureStoreScreenshot(window, '06-trends.png');
  await window.setViewportSize({ width: 430, height: 900 });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await window.screenshot({
    path: 'local-screenshots/daily-driver-charts-mobile.png',
    fullPage: true,
  });
  await window.setViewportSize({ width: 1440, height: 1000 });

  await openPrimaryPage(window, 'Credit cards');

  await window.getByRole('button', { name: 'Add card or credit line' }).click();
  await window.getByLabel('Card name').fill('Manual timing card');
  await window.getByLabel('Typical future statement').fill('125.00');
  await window.getByLabel('Payment policy').selectOption('manual');
  await expect(window.getByLabel('Statement closes on day (optional)')).toHaveValue('');
  await expect(window.getByLabel('Payment happens on day (optional)')).toHaveValue('');
  await window.getByRole('button', { name: 'Save card' }).click();
  await expectStatusMessage(window, 'Credit card added');
  const manualCard = window
    .getByRole('heading', { name: 'Manual timing card' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await openCardManagement(window, 'Manual timing card');
  await expect(manualCard.getByText('Timing incomplete', { exact: true })).toBeVisible();
  await expect(manualCard).toContainText(
    'No dates were inferred. Add the real close and payment timing when known.',
  );

  await openPrimaryPage(window, 'Overview');
  const manualCardSafeSpend = window.getByLabel('Manual timing card available spend');
  await expect(manualCardSafeSpend).toHaveText('Unavailable');
  await window.locator('summary').filter({ hasText: 'Test a purchase' }).click();
  await expect(
    window.getByText(
      '1 card excluded because payment policy, cycle timing, or account data cannot support a runway recommendation.',
    ),
  ).toBeVisible();
  await openPrimaryPage(window, 'Setup checklist');
  await expect(
    window.getByRole('heading', { name: 'Complete your financial picture' }),
  ).toBeVisible();
  const readyCardSetupTopic = window
    .getByRole('heading', { name: 'Credit cards and statement history' })
    .last()
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await expect(readyCardSetupTopic).toContainText('Ready · data entered');
  await expect(window.getByText(/card setup item\(s\) still need/)).toHaveCount(0);
  await expect(
    window.getByText(/non-manual card\(s\) have incomplete statement timing/),
  ).toHaveCount(0);

  // Manual special-financing cards can show a determinate runway when their real timing and
  // explicit dated paydown are entered through the same controls an owner uses. They remain
  // excluded from the hypothetical purchase advisor because a new purchase has no automatic
  // full-statement cash-settlement rule.
  await openPrimaryPage(window, 'Credit cards');
  const manualCardPanel = window
    .getByRole('heading', { name: 'Manual timing card' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await openCardManagement(window, 'Manual timing card');
  await manualCardPanel.getByRole('button', { name: 'Edit card' }).click();
  await expectEditorReady(window.getByRole('form', { name: 'Credit card editor' }));
  await window.getByLabel('Issuer (optional)').fill('Synthetic issuer');
  await window.getByLabel('Last four digits (optional)').fill('4821');
  await window.getByLabel('Statement closes on day (optional)').fill('19');
  await window.getByLabel('Payment happens on day (optional)').fill('12');
  await window.getByLabel('Credit limit (optional)').fill('3000.00');
  await window.getByLabel('Issuer-reported current balance (optional)').fill('1432.10');
  await window.getByLabel('Current balance as of (required with balance)').fill('2026-07-14');
  await window.getByRole('button', { name: 'Save card' }).click();
  await expectStatusMessage(window, 'Card terms updated');

  await manualCardPanel.getByRole('button', { name: 'Add statement' }).click();
  const manualHistoryEditor = window.getByRole('form', { name: 'Statement cycle editor' });
  await expectEditorReady(manualHistoryEditor);
  await manualHistoryEditor.getByLabel('Cycle opens').fill('2026-05-20');
  await manualHistoryEditor.getByLabel('Cycle closes').fill('2026-06-19');
  await manualHistoryEditor.getByLabel('Payment due').fill('2026-07-12');
  await manualHistoryEditor.getByLabel('Scheduled or paid on (optional)').fill('2026-07-12');
  await manualHistoryEditor.getByLabel('Cycle status').selectOption('paid');
  await manualHistoryEditor.getByLabel('Typical statement estimate').fill('720.00');
  await manualHistoryEditor.getByLabel('Activity posted in this cycle').fill('0.00');
  await manualHistoryEditor.getByLabel('Planned activity').fill('0.00');
  await manualHistoryEditor.getByLabel('Locked statement balance', { exact: true }).fill('720.00');
  await manualHistoryEditor.getByLabel('Actual statement payment (optional)').fill('180.00');
  await manualHistoryEditor.getByRole('button', { name: 'Save statement cycle' }).click();
  await expectStatusMessage(window, 'Statement cycle added');

  await manualCardPanel.getByRole('button', { name: 'Add statement' }).click();
  const manualCycleEditor = window.getByRole('form', { name: 'Statement cycle editor' });
  await expectEditorReady(manualCycleEditor);
  await manualCycleEditor.getByLabel('Cycle opens').fill('2026-06-20');
  await manualCycleEditor.getByLabel('Cycle closes').fill('2026-07-19');
  await manualCycleEditor.getByLabel('Payment due').fill('2026-08-12');
  await manualCycleEditor.getByLabel('Cycle status').selectOption('open');
  await manualCycleEditor.getByLabel('Typical statement estimate').fill('0.00');
  await manualCycleEditor.getByLabel('Activity posted in this cycle').fill('892.10');
  await manualCycleEditor.getByLabel('Planned activity').fill('0.00');
  await manualCycleEditor.getByRole('button', { name: 'Save statement cycle' }).click();
  await expectStatusMessage(window, 'Statement cycle added');

  await manualCardPanel.getByRole('button', { name: 'Schedule payment' }).click();
  const manualPaymentEditor = manualCardPanel
    .getByRole('button', { name: 'Add payment to forecast' })
    .locator('xpath=ancestor::form[1]');
  await expectEditorReady(manualPaymentEditor);
  await manualPaymentEditor.getByLabel('Payment date').fill('2026-08-12');
  await manualPaymentEditor.getByLabel('Amount').fill('155.00');
  await manualPaymentEditor.getByLabel('Statement (optional)').selectOption({ index: 1 });
  await manualPaymentEditor.getByLabel('Label (optional)').fill('Manual financing payment');
  await manualPaymentEditor.getByRole('button', { name: 'Add payment to forecast' }).click();
  await expectStatusMessage(
    window,
    'payment scheduled. Its dated cash effect is now in the forecast',
  );

  await openPrimaryPage(window, 'Overview');
  await expect(window.getByLabel('Manual timing card available spend')).toHaveText(
    /^\$[\d,]+\.\d{2}$/,
  );
  const manualOverviewSnapshot: ForecastSnapshotDto = await window.evaluate(async () => {
    const response = await (
      globalThis as unknown as { balanceBook: BalanceBookApi }
    ).balanceBook.getForecast();
    if (!response.ok) throw new Error(response.error);
    return response.value;
  });
  const manualPower = manualOverviewSnapshot.cardSpendingPower?.find(
    (card) => card.cardName === 'Manual timing card',
  );
  expect(manualPower).toMatchObject({
    spendingPowerStatus: 'determinate',
    purchaseAdvisorEligible: false,
    nextDueOn: '2026-08-12',
    nextStatementDueOn: '2026-09-12',
  });
  const manualNextStatementLow = manualOverviewSnapshot.dailyCash
    ?.filter((day) => day.date >= manualPower!.nextStatementDueOn!)
    .reduce((lowest, day) =>
      day.expectedPositionCents < lowest.expectedPositionCents ? day : lowest,
    );
  expect(manualPower?.nextStatementPositionCents).toBe(
    manualNextStatementLow?.expectedPositionCents,
  );
  await expect(window.getByLabel('Manual timing card next statement position')).toContainText(
    formattedMoney(manualPower!.nextStatementPositionCents!),
  );
  const manualDebt = manualOverviewSnapshot.revolvingDebtByCard?.find(
    (debt) => debt.cardId === manualPower?.cardId,
  );
  expect(manualDebt?.carryingBalanceCents).toBeGreaterThan(0);
  await expect(window.getByLabel('Manual timing card still owed on statements')).toHaveText(
    formattedMoney(manualDebt!.carryingBalanceCents),
  );
  await openPrimaryPage(window, 'Loans');
  await window.getByRole('button', { name: 'Add loan' }).click();
  await window.getByLabel('Loan name').fill('Synthetic auto loan');
  await window.getByLabel('Current principal (optional)').fill('10000.00');
  await window.getByLabel('Accrued interest (optional)').fill('0.00');
  await window.getByLabel('Balance as of (optional)').fill('2026-07-14');
  await window.getByLabel('Annual rate (optional)').fill('6.50');
  await window.getByLabel('Amount applied to debt (optional)').fill('350.00');
  await window.getByLabel('Next payment date (optional)').fill('2026-08-01');
  await window.getByRole('button', { name: 'Calculate and save loan' }).click();
  await expectStatusMessage(window, 'Loan added');
  await window.getByRole('button', { name: 'Add loan' }).click();
  await window.getByLabel('Loan name').fill('Synthetic personal loan');
  await window.getByLabel('Current principal (optional)').fill('4000.00');
  await window.getByLabel('Accrued interest (optional)').fill('0.00');
  await window.getByLabel('Balance as of (optional)').fill('2026-07-14');
  await window.getByLabel('Annual rate (optional)').fill('7.25');
  await window.getByLabel('Amount applied to debt (optional)').fill('200.00');
  await window.getByLabel('Next payment date (optional)').fill('2026-08-05');
  await window.getByLabel('Payment frequency (optional)').selectOption('biweekly');
  await window.getByRole('button', { name: 'Calculate and save loan' }).click();
  await expectStatusMessage(window, 'Loan added');
  await captureStoreScreenshot(window, '05-loans.png');
  const autoLoanCard = window
    .getByRole('heading', { name: 'Synthetic auto loan' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  const editAutoLoanButton = autoLoanCard.getByRole('button', { name: 'Edit loan' });
  await editAutoLoanButton.click();
  const autoLoanEditor = window
    .getByRole('heading', { name: 'Edit Synthetic auto loan' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await expectEditorReady(autoLoanEditor);
  await editAutoLoanButton.click();
  await expectEditorReady(autoLoanEditor);
  await autoLoanEditor.getByLabel('Lender (optional)').fill('Synthetic lender');
  await autoLoanEditor.getByLabel('Payment account').selectOption({ label: 'Primary checking' });
  await autoLoanEditor.getByRole('button', { name: 'Calculate and save loan' }).click();
  await expectStatusMessage(window, 'Loan updated');
  await autoLoanCard.getByText('Loan details and assumptions').click();
  await expect(autoLoanCard).toContainText('Synthetic lender');

  await editAutoLoanButton.click();
  await expectEditorReady(autoLoanEditor);
  await expect(autoLoanEditor.getByLabel('Lender (optional)')).toHaveValue('Synthetic lender');
  await expect(autoLoanEditor.getByLabel('Payment account').locator('option:checked')).toHaveText(
    'Primary checking',
  );
  await autoLoanEditor.getByLabel('Payment account').selectOption({ label: 'Primary checking' });
  await autoLoanEditor.getByRole('button', { name: 'Calculate and save loan' }).click();
  await expectStatusMessage(window, 'Loan updated');

  await autoLoanCard.getByRole('button', { name: 'Plan a refinance' }).click();
  await expect(window.getByRole('heading', { name: 'Refinance planner' })).toBeVisible();
  await expect(
    window.getByRole('checkbox', { name: 'Synthetic auto loan', exact: true }),
  ).toBeChecked();

  await openPrimaryPage(window, 'Scenarios');
  await window.getByLabel('Description').fill('Synthetic purchase');
  await window.getByLabel('Amount').fill('250.00');
  await window.getByLabel('Payment method').selectOption('card');
  await window.getByLabel('Card to use').selectOption({ label: 'Everyday card' });
  await window.getByRole('button', { name: 'Evaluate purchase' }).click();
  await expect(window.getByRole('heading', { name: /Result:/ })).toBeVisible();
  await expect(window.getByText('Cash settlement date:', { exact: false })).toBeVisible();
  await expect(window.getByText('Payment instrument:', { exact: false })).toBeVisible();
  await expect(
    window.getByText('Scheduled card payment changes from', { exact: false }),
  ).toContainText('This purchase adds');
  await window.getByRole('button', { name: 'Save this scenario' }).click();
  await expectStatusMessage(window, 'Scenario saved locally');
  await window.getByRole('button', { name: 'Duplicate' }).dblclick();
  await expect(window.getByText('Synthetic purchase (copy)', { exact: true })).toHaveCount(1);
  await window.getByRole('button', { name: 'Evaluate all active together' }).click();
  await expect(window.getByRole('heading', { name: /Result:/ })).toBeVisible();

  await openPrimaryPage(window, 'Settings');
  await window.getByRole('combobox', { name: 'Theme' }).selectOption('light');
  await window.getByRole('button', { name: 'Save experience' }).click();
  await expectStatusMessage(window, 'Experience preferences saved.');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe('light');
  await window.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
  await window
    .getByRole('combobox', { name: 'Default forecast view' })
    .selectOption('conservative');
  await window.getByRole('checkbox', { name: 'Use compact spacing' }).check();
  await window.getByRole('checkbox', { name: 'Reduce animations and motion' }).check();
  await window.getByRole('button', { name: 'Save experience' }).click();
  await expectStatusMessage(window, 'Experience preferences saved.');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe('dark');
  await expect(window.getByRole('combobox', { name: 'Theme' })).toBeEnabled();
  await openPrimaryPage(window, 'Scenarios');
  await expect(window.getByRole('heading', { name: 'Can I afford this?' })).toBeVisible();
  await expectNoSeriousAxeViolations(window);
  await window.screenshot({
    path: 'local-screenshots/daily-driver-dark-scenario.png',
    fullPage: true,
  });

  await window.getByRole('button', { name: 'Log out' }).click();
  await expect(window.getByRole('heading', { name: 'Choose a profile' })).toBeVisible();
  await window.getByRole('button', { name: 'Owner' }).click();
  await window.getByLabel('Password').fill('synthetic-test-password');
  await window.getByRole('button', { name: 'Sign in' }).click();
  await openPrimaryPage(window, 'Overview');
  await expect(window.getByRole('heading', { name: 'How much can I safely spend?' })).toBeVisible();
  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveCount(0);
  await expect(window.getByRole('button', { name: 'Conservative' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.density))
    .toBe('compact');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.reduceMotion))
    .toBe('true');
  await window.setViewportSize({ width: 430, height: 900 });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(window);
  await window.setViewportSize({ width: 1440, height: 1000 });
  await openPrimaryPage(window, 'Settings');
  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
  await window.getByRole('combobox', { name: 'Theme' }).selectOption('light');
  await window.getByRole('combobox', { name: 'Default forecast view' }).selectOption('expected');
  await window.getByRole('checkbox', { name: 'Use compact spacing' }).uncheck();
  await window.getByRole('checkbox', { name: 'Reduce animations and motion' }).uncheck();
  await window.getByRole('button', { name: 'Save experience' }).click();
  await expectStatusMessage(window, 'Experience preferences saved.');
  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveValue('light');
  await expectNoSeriousAxeViolations(window);

  await openPrimaryPage(window, 'Setup checklist');
  await window.getByText(/^Level 3/).click();
  await window.getByRole('button', { name: 'Add other obligation' }).click();
  await expect(window.getByRole('heading', { name: 'Activity & records' })).toBeVisible();
  const contextualPayableCreator = window.getByText('Add a financial record').locator('..');
  await expect(contextualPayableCreator).toHaveAttribute('open', '');
  await expect(window.getByLabel('Record type')).toHaveValue('forecast-event');
  await expect(window.getByLabel('Event kind')).toHaveValue('payable');
  await expect(window.getByLabel('Direction')).toHaveValue('Money leaves the account');

  await openPrimaryPage(window, 'Setup checklist');
  await window.getByRole('button', { name: 'Review cash accounts' }).click();
  await expect(window.getByRole('heading', { name: 'Activity & records' })).toBeVisible();
  await expect(window.getByLabel('Filter records')).toHaveValue('cash-account');
  await expect(window.getByLabel('Record type')).toBeHidden();
  await window.getByText('Add a financial record').click();
  await expect(window.getByText('Add a financial record').locator('..')).toHaveAttribute(
    'open',
    '',
  );
  await expect(window.getByLabel('Record type')).toHaveValue('cash-account');
  await window.getByLabel('Record type').selectOption('asset');
  await window.getByLabel('Name').fill('Synthetic investment');
  await window.getByLabel('Value').fill('5000.00');
  await window.getByLabel('Valuation date').fill('2026-08-01');
  await window.getByRole('button', { name: 'Save record' }).click();
  await expectStatusMessage(window, 'Record saved locally');
  await window.getByLabel('Record type').selectOption('receivable');
  await window.getByLabel('Source').fill('Synthetic partner');
  await window.getByLabel('Description').fill('Synthetic recurring reimbursement');
  await window.getByLabel('Original amount').fill('0.00');
  await window.getByLabel('Remaining amount').fill('0.00');
  await window.getByLabel('Date', { exact: true }).fill('2026-08-28');
  await window.getByLabel('Certainty').selectOption('expected');
  await window.getByLabel('Recurrence', { exact: true }).selectOption('monthly');
  await window.getByLabel('Amount per future occurrence (optional)').fill('274.13');
  await window.getByRole('button', { name: 'Save record' }).click();
  await expectStatusMessage(window, 'Record saved locally');
  await window.getByLabel('Record type').selectOption('receivable');
  await window.getByLabel('Source').fill('Synthetic customer');
  await window.getByLabel('Description').fill('Synthetic open reimbursement');
  await window.getByLabel('Original amount').fill('274.13');
  await window.getByLabel('Remaining amount').fill('274.13');
  await window.getByLabel('Date', { exact: true }).fill('2026-08-10');
  await window.getByLabel('Certainty').selectOption('expected');
  await window.getByLabel('Recurrence', { exact: true }).selectOption('once');
  await window.getByRole('button', { name: 'Save record' }).click();
  await expectStatusMessage(window, 'Record saved locally');

  await openPrimaryPage(window, 'Cash forecast');
  await expect(window.getByRole('heading', { name: 'Cash forecast', exact: true })).toBeVisible();
  const beforeReceivableSettlement = window
    .getByRole('row')
    .filter({ hasText: 'Aug 9, 2026' })
    .first();
  const receivableSettlementDay = window
    .getByRole('row')
    .filter({ hasText: 'Aug 10, 2026' })
    .first();
  const totalBeforeSettlement = displayedMoneyToCents(
    await beforeReceivableSettlement.locator('td').nth(1).innerText(),
  );
  const cashBeforeSettlement = displayedMoneyToCents(
    await beforeReceivableSettlement.locator('td').nth(2).innerText(),
  );
  const owedBeforeSettlement = displayedMoneyToCents(
    await beforeReceivableSettlement.locator('td').nth(4).innerText(),
  );
  const totalOnSettlement = displayedMoneyToCents(
    await receivableSettlementDay.locator('td').nth(1).innerText(),
  );
  const cashOnSettlement = displayedMoneyToCents(
    await receivableSettlementDay.locator('td').nth(2).innerText(),
  );
  const owedOnSettlement = displayedMoneyToCents(
    await receivableSettlementDay.locator('td').nth(4).innerText(),
  );
  expect(cashOnSettlement - cashBeforeSettlement).toBe(27_413);
  expect(owedBeforeSettlement - owedOnSettlement).toBe(27_413);
  expect(totalOnSettlement).toBe(totalBeforeSettlement);
  await openPrimaryPage(window, 'All financial records');
  await window.getByText('Add a financial record').click();
  await expect(window.getByText('Add a financial record').locator('..')).toHaveAttribute(
    'open',
    '',
  );
  await window.getByLabel('Record type').selectOption('cash-account');
  await window.getByLabel('Name').fill('Reserve savings');
  await window.getByLabel('Opening balance').fill('1000.00');
  await window.getByLabel('Account hard floor').fill('0.00');
  await window.getByLabel('Balance as of').fill('2026-07-14');
  await window.getByLabel('Account type').selectOption('savings');
  await window.getByLabel('Transfer delay days').fill('2');
  await window.getByRole('button', { name: 'Save record' }).click();
  await expectStatusMessage(window, 'Record saved locally');

  await openPrimaryPage(window, 'Income and raises');
  await window.getByLabel('Source or label').fill('Routed salary');
  await window.getByLabel('Income type').selectOption('paycheck');
  await window.getByLabel('Net amount', { exact: true }).fill('1000.00');
  await window.getByLabel('Cadence').selectOption('biweekly');
  await window.getByLabel('Deposit routing').selectOption('routed');
  await window.getByLabel('Next official payday').fill('2027-01-15');
  await window.getByLabel('Paycheck destination 1').selectOption({ label: 'Primary checking' });
  await window.getByRole('button', { name: 'Add destination' }).click();
  await window.getByLabel('Paycheck destination 2').selectOption({ label: 'Reserve savings' });
  await window.getByLabel('Deposit rule 2').selectOption('fixed');
  await window.getByLabel('Deposit amount 2').fill('300.00');
  await window.getByLabel('Days early 2').fill('2');
  await expect(window.getByText('Official payday 2027-01-15')).toBeVisible();
  await expect(window.getByText(/Reserve savings receives \$300\.00 on 2027-01-13/)).toBeVisible();
  await expect(window.getByText(/Primary checking receives \$700\.00 on 2027-01-15/)).toBeVisible();
  await window.getByRole('button', { name: 'Save income stream' }).click();
  await expectStatusMessage(window, 'Paycheck routing saved');
  await expect(window.getByLabel('Recurring base pay').locator('option:checked')).toContainText(
    'Routed salary',
  );
  const editRoutedSalary = window.getByRole('button', { name: 'Edit paycheck' });
  const routedSalaryCard = editRoutedSalary.locator('xpath=../../..');
  await expect(routedSalaryCard).toContainText('$1,000.00');
  await expect(routedSalaryCard).toContainText('2 calendar days early');
  await editRoutedSalary.click();
  const paycheckEditor = window
    .getByRole('button', { name: 'Save paycheck plan' })
    .locator('xpath=ancestor::form[1]');
  await expectEditorReady(paycheckEditor);
  await expect(window.getByLabel('Total take-home per paycheck')).toHaveValue('1000.00');
  const primaryPaycheckAllocation = window.getByRole('group', {
    name: 'Paycheck allocation for Primary checking',
  });
  const reservePaycheckAllocation = window.getByRole('group', {
    name: 'Paycheck allocation for Reserve savings',
  });
  const paycheckAllocations = window.getByRole('group', {
    name: /^Paycheck allocation for /,
  });
  await expect(paycheckAllocations).toHaveCount(2);
  await expect(paycheckAllocations.nth(0)).toHaveAccessibleName(
    'Paycheck allocation for Primary checking',
  );
  await expect(paycheckAllocations.nth(1)).toHaveAccessibleName(
    'Paycheck allocation for Reserve savings',
  );
  await expect(primaryPaycheckAllocation.getByLabel('Deposit rule 1')).toHaveValue('remainder');
  await expect(primaryPaycheckAllocation.getByLabel('Deposit amount 1')).toHaveValue('700.00');
  await expect(reservePaycheckAllocation.getByLabel('Deposit rule 2')).toHaveValue('fixed');
  await expect(reservePaycheckAllocation.getByLabel('Deposit amount 2')).toHaveValue('300.00');
  await reservePaycheckAllocation.getByLabel('Days early 2').fill('3');
  await window.getByRole('button', { name: 'Save paycheck plan' }).click();
  await expectStatusMessage(window, 'Paycheck routing saved');
  await expect(window.getByLabel('Recurring base pay').locator('option:checked')).toContainText(
    'Routed salary',
  );
  await expect(window.getByText('Arrives 3 calendar days early')).toBeVisible();

  await openPrimaryPage(window, 'All financial records');
  await window.getByLabel('Filter records').selectOption('cash-account');
  await window.getByRole('button', { name: 'Edit Primary checking', exact: true }).click();
  const accountEditor = window.getByRole('form', { name: 'Cash account editor' });
  await expectEditorReady(accountEditor);
  await accountEditor.getByLabel('Account name').fill('Edited primary checking');
  await accountEditor.getByLabel('Balance', { exact: true }).fill('2600.00');
  await accountEditor.getByLabel('Protected minimum (optional)').fill('400.00');
  await accountEditor.getByLabel('Preferred buffer (optional)').fill('750.00');
  await accountEditor.getByLabel('Transfer delay days').fill('2');
  await accountEditor.getByRole('button', { name: 'Save account changes' }).click();
  await expect(accountEditor.getByRole('status')).toContainText('Cash account updated');
  await expect(
    window.getByRole('strong').filter({ hasText: /^Edited primary checking$/ }),
  ).toBeVisible();

  await window.getByLabel('Filter records').selectOption('forecast-event');
  await window.getByRole('button', { name: 'Edit Housing payment', exact: true }).click();
  const eventEditor = window.getByRole('form', { name: 'Cash event editor' });
  await expectEditorReady(eventEditor);
  await eventEditor.getByLabel('Event label').fill('Housing on card');
  await eventEditor.getByLabel('Amount').fill('1234.00');
  await eventEditor.getByLabel('Certainty').selectOption('expected');
  await eventEditor.getByLabel('Status').selectOption('scheduled');
  await eventEditor.getByLabel('Payment method').selectOption('credit-card');
  await eventEditor.getByLabel('Credit card').selectOption({ label: 'Everyday card' });
  await expect(eventEditor.getByLabel('Protected forecast treatment')).toHaveValue(
    'Always included while active',
  );
  await eventEditor.getByLabel('Repeat').selectOption('monthly');
  await eventEditor.getByLabel('Day of month').fill('17');
  await eventEditor.getByLabel('Repeat every (months)').fill('1');
  await eventEditor.getByLabel('Repeat through (optional)').fill('2026-12-17');
  await eventEditor.getByRole('button', { name: 'Save event changes' }).click();
  await expect(eventEditor.getByRole('status')).toContainText('Cash event updated');
  await expect(window.getByRole('strong').filter({ hasText: /^Housing on card$/ })).toBeVisible();

  // Bills & Subscriptions reuses the recurring forecast event as its source of truth. A card bill
  // defaults to already included in the entered cycle total, while a shared split accrues Money
  // Owed on each billing date without moving checking cash.
  const sharedBillBaseline = await window.evaluate(async () => {
    const response = await (
      globalThis as unknown as { balanceBook: BalanceBookApi }
    ).balanceBook.getForecast();
    if (!response.ok) throw new Error(response.error);
    const point = response.value.dailyCash?.find((candidate) => candidate.date === '2026-08-03');
    return {
      cashCents: point?.expectedCashCents,
      receivableCents: point?.expectedReceivableCents,
    };
  });
  await openPrimaryPage(window, 'Bills & subscriptions');
  await expect(window.getByRole('heading', { name: 'Bills & subscriptions' })).toBeVisible();
  await expect(window.getByText('Housing on card', { exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Add bill' }).click();
  const billEditor = window.getByRole('form', { name: 'Add bill' });
  await expectEditorReady(billEditor);
  await billEditor.getByLabel('Bill or subscription name').fill('Synthetic shared subscription');
  await billEditor.getByLabel('Amount', { exact: true }).fill('19.99');
  await billEditor.getByLabel('First or next billing date').fill('2026-08-03');
  await billEditor.getByLabel('Repeats').selectOption('monthly');
  await billEditor.getByLabel('Paid from').selectOption({ label: 'Everyday card · credit card' });
  const addBillToCardBalance = billEditor.getByRole('checkbox', {
    name: 'Add this charge to the card balance',
  });
  await expect(addBillToCardBalance).not.toBeChecked();
  await expect(
    billEditor.getByText(/already included in the card.s entered cycle total/),
  ).toBeVisible();
  await billEditor.getByRole('checkbox', { name: 'Split 50/50' }).check();
  await billEditor.getByLabel('Who owes you?').fill('Synthetic housemate');
  await billEditor.getByRole('button', { name: 'Save bill' }).click();
  await expectStatusMessage(window, 'Bill added to your forecast.');
  const savedSharedBill = window
    .getByText('Synthetic shared subscription', { exact: true })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await expect(savedSharedBill).toContainText('$19.99');
  await expect(savedSharedBill).toContainText('Already included in card total');
  await expect(savedSharedBill).toContainText('Adds $10.00 to Money Owed');
  const sharedBillResult = await window.evaluate(async () => {
    const api = (globalThis as unknown as { balanceBook: BalanceBookApi }).balanceBook;
    const [records, forecast] = await Promise.all([api.listRecords(), api.getForecast()]);
    if (!records.ok) throw new Error(records.error);
    if (!forecast.ok) throw new Error(forecast.error);
    const event = records.value.events.find(
      (candidate) => candidate.label === 'Synthetic shared subscription',
    );
    const receivable = records.value.receivables.find(
      (candidate) => candidate.relatedExpenseId === event?.id,
    );
    const point = forecast.value.dailyCash?.find((candidate) => candidate.date === '2026-08-03');
    const settlementPoint = forecast.value.dailyCash?.find(
      (candidate) => candidate.date === '2026-08-28',
    );
    return { event, receivable, point, settlementPoint };
  });
  expect(sharedBillResult.event).toMatchObject({
    amountCents: 1_999,
    paymentMethod: 'credit-card',
    cardActivityTreatment: 'included-in-cycle-total',
  });
  expect(sharedBillResult.receivable).toMatchObject({
    accrualAmountCents: 1_000,
    includeInCashForecast: false,
    source: 'Synthetic housemate',
  });
  expect(sharedBillResult.point?.expectedCashCents).toBe(sharedBillBaseline.cashCents);
  expect(sharedBillResult.point?.expectedReceivableCents).toBe(
    (sharedBillBaseline.receivableCents ?? 0) + 1_000,
  );

  await savedSharedBill.getByRole('button', { name: 'Edit bill' }).click();
  const editSharedBill = window.getByRole('form', {
    name: 'Edit Synthetic shared subscription',
  });
  await expectEditorReady(editSharedBill);
  await editSharedBill
    .getByRole('checkbox', { name: 'Add this charge to the card balance' })
    .check();
  await editSharedBill.getByRole('button', { name: 'Save bill' }).click();
  await expectStatusMessage(window, 'Bill updated.');
  await expect(savedSharedBill).toContainText('Adds to card balance');
  const additionalCardBillResult = await window.evaluate(async () => {
    const api = (globalThis as unknown as { balanceBook: BalanceBookApi }).balanceBook;
    const [records, forecast] = await Promise.all([api.listRecords(), api.getForecast()]);
    if (!records.ok) throw new Error(records.error);
    if (!forecast.ok) throw new Error(forecast.error);
    const event = records.value.events.find(
      (candidate) => candidate.label === 'Synthetic shared subscription',
    );
    const settlementPoint = forecast.value.dailyCash?.find(
      (candidate) => candidate.date === '2026-08-28',
    );
    return {
      treatment: event?.cardActivityTreatment,
      settlementPoint,
    };
  });
  expect(additionalCardBillResult.treatment).toBe('additional');
  expect(additionalCardBillResult.settlementPoint?.expectedCashCents).toBe(
    (sharedBillResult.settlementPoint?.expectedCashCents ?? 0) - 1_999,
  );
  expect(additionalCardBillResult.settlementPoint?.expectedPositionCents).toBe(
    (sharedBillResult.settlementPoint?.expectedPositionCents ?? 0) - 1_999,
  );

  await openPrimaryPage(window, 'Cash forecast');
  const dayBeforeCardPurchase = window.getByRole('row').filter({ hasText: 'Jul 16, 2026' }).first();
  const cardPurchaseDay = window.getByRole('row').filter({ hasText: 'Jul 17, 2026' }).first();
  expect(displayedMoneyToCents(await cardPurchaseDay.locator('td').nth(2).innerText())).toBe(
    displayedMoneyToCents(await dayBeforeCardPurchase.locator('td').nth(2).innerText()),
  );
  await expect(cardPurchaseDay).not.toContainText('Housing on card');
  const owningCyclePaymentDay = window.getByRole('row').filter({ hasText: 'Aug 28, 2026' }).first();
  await expect(owningCyclePaymentDay).toContainText('Everyday card statement payment');
  await expect(owningCyclePaymentDay).toContainText('-$1,403.99');
  await window
    .getByRole('group', { name: 'Forecast series' })
    .getByRole('button', { name: 'Liquid cash', exact: true })
    .click();
  await window.setViewportSize({ width: 430, height: 900 });
  const mobileCardPurchaseDay = window
    .getByLabel('Daily closes for Liquid cash')
    .getByText('Jul 17, 2026', { exact: true })
    .locator('xpath=ancestor::details[1]');
  await mobileCardPurchaseDay.locator('summary').click();
  await expect(mobileCardPurchaseDay).toHaveAttribute('open', '');
  const editedPrimaryMobileBalance = window.getByLabel(
    'Edited primary checking balance on 2026-07-17',
  );
  await expect(
    editedPrimaryMobileBalance.getByText('Edited primary checking', { exact: true }),
  ).toBeVisible();
  await expect(editedPrimaryMobileBalance.getByText(/^\$[\d,]+\.\d{2}$/)).toBeVisible();
  const reserveMobileBalance = window.getByLabel('Reserve savings balance on 2026-07-17');
  await expect(reserveMobileBalance.getByText('Reserve savings', { exact: true })).toBeVisible();
  await expect(reserveMobileBalance.getByText(/^\$[\d,]+\.\d{2}$/)).toBeVisible();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await window.setViewportSize({ width: 1440, height: 1000 });
  await openPrimaryPage(window, 'All financial records');

  await window.getByLabel('Filter records').selectOption('asset');
  await window.getByRole('button', { name: 'Advanced edit Synthetic investment' }).click();
  const advancedAssetEditor = window
    .getByRole('heading', { name: 'Advanced record editor' })
    .locator('xpath=ancestor::form[1]');
  await expectEditorReady(advancedAssetEditor);
  await window.getByText('Show advanced structured fields').click();
  await expect(window.getByLabel('Record fields JSON')).toBeVisible();
  await window.getByRole('button', { name: 'Cancel' }).click();

  await openPrimaryPage(window, 'Money owed to you');
  await expect(window.getByRole('heading', { name: 'Money owed to you' })).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Open balances' })).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Recurring money owed' })).toBeVisible();
  await expect(
    window.getByText('Synthetic recurring reimbursement', { exact: true }),
  ).toBeVisible();
  await window.getByRole('button', { name: 'Edit open balance' }).click();
  const moneyOwedEditor = window
    .getByRole('button', { name: 'Save money-owed record' })
    .locator('xpath=ancestor::form[1]');
  await expectEditorReady(moneyOwedEditor);
  const automaticRelease = moneyOwedEditor.getByLabel(
    'Automatically release each occurrence into checking on its schedule',
  );
  const timingMethod = moneyOwedEditor.getByLabel('Timing method');
  await expect(timingMethod).toHaveValue('once');
  await automaticRelease.uncheck();
  await moneyOwedEditor.getByLabel('Expected owed or release date').fill('2026-08-11');
  const defaultReleaseAccount = moneyOwedEditor.getByLabel('Default release account');
  await defaultReleaseAccount.selectOption({ label: 'Reserve savings' });
  const reserveAccountId = await defaultReleaseAccount.inputValue();
  await expect(automaticRelease).not.toBeChecked();
  await moneyOwedEditor.getByLabel('I know the date (show it as confirmed)').uncheck();
  await moneyOwedEditor.getByRole('button', { name: 'Save money-owed record' }).click();
  await expectStatusMessage(window, 'Money-owed record updated');
  const savedOpenBalance = window
    .getByRole('button', { name: 'Edit open balance' })
    .locator('xpath=ancestor::*[contains(@class,"fui-Card")][1]');
  await expect(savedOpenBalance).toContainText('2026-08-11 (unconfirmed)');
  await expect(savedOpenBalance).toContainText('Reserve savings');
  await expect(savedOpenBalance).toContainText(
    'Held in Money Owed until you release the amount to a checking account.',
  );

  const receivedCashForm = window
    .getByRole('button', { name: 'Release to checking' })
    .locator('xpath=ancestor::form[1]');
  const receivableChoice = receivedCashForm.getByLabel('Balance or recurring receipt');
  const openBalanceChoiceValue = await receivableChoice
    .locator('option')
    .filter({ hasText: 'Synthetic open reimbursement' })
    .getAttribute('value');
  const recurringChoiceValue = await receivableChoice
    .locator('option')
    .filter({ hasText: 'Synthetic recurring reimbursement' })
    .getAttribute('value');
  if (!openBalanceChoiceValue) throw new Error('Open receivable option is unavailable');
  if (!recurringChoiceValue) throw new Error('Recurring receivable option is unavailable');
  await receivableChoice.selectOption(openBalanceChoiceValue);
  await expect(receivedCashForm.getByLabel('Release into')).toHaveValue(reserveAccountId);
  await receivableChoice.selectOption(recurringChoiceValue);
  await receivedCashForm.getByLabel('Amount received').fill('1.00');
  await receivedCashForm.getByLabel('Release into').selectOption({ label: 'Reserve savings' });
  await receivedCashForm.getByLabel('Installment this receipt settles').selectOption('2026-08-28');
  await receivedCashForm.getByRole('button', { name: 'Release to checking' }).click();
  await expectStatusMessage(
    window,
    'Funds released once to the selected account and removed from Money Owed.',
  );
  await window.getByText('Settlement history (1)', { exact: true }).click();
  await expect(window.getByText(/deposited to Reserve savings/)).toBeVisible();
  await expect(window.getByText(/installment scheduled 2026-08-28/)).toBeVisible();
  await window.getByRole('button', { name: 'Apply automatically' }).click();
  const automaticReceiptForm = window
    .getByRole('button', { name: 'Record and apply' })
    .locator('xpath=ancestor::form[1]');
  await expect(automaticReceiptForm.getByLabel('Balance or recurring receipt')).toHaveCount(0);
  await automaticReceiptForm.getByLabel('Amount received').fill('2.00');
  await automaticReceiptForm.getByLabel('Release into').selectOption({ label: 'Reserve savings' });
  await automaticReceiptForm.getByRole('button', { name: 'Record and apply' }).click();
  await expectStatusMessage(
    window,
    'Money received was deposited once and applied automatically to the oldest open balances.',
  );
  await expect(
    window
      .getByRole('button', { name: 'Edit open balance' })
      .locator('xpath=ancestor::*[contains(@class,"fui-Card")][1]'),
  ).toContainText('$272.13');
  await window.setViewportSize({ width: 430, height: 900 });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(window);
  await window.screenshot({
    path: 'local-screenshots/daily-driver-money-owed-mobile.png',
    fullPage: true,
  });
  await window.setViewportSize({ width: 1440, height: 1000 });

  await openPrimaryPage(window, 'All financial records');
  await window.getByText('Add a financial record').click();
  const genericEventKind = window.getByLabel('Event kind');
  await expect(genericEventKind.locator('option[value="receivable-settlement"]')).toHaveCount(0);
  await expect(
    window.getByText(/Use Money Owed to schedule or record received money/),
  ).toBeVisible();
  await window.getByLabel('Filter records').selectOption('forecast-event');
  await window
    .getByRole('button', {
      name: 'Edit Settlement: Synthetic recurring reimbursement',
      exact: true,
    })
    .click();
  const settlementEditor = window.getByRole('form', { name: 'Cash event editor' });
  await expectEditorReady(settlementEditor);
  await expect(settlementEditor.getByLabel('Event type')).toHaveValue(
    'Receivable settlement (managed in Money Owed)',
  );
  await settlementEditor.getByLabel('Event label').fill('Recorded recurring reimbursement');
  await settlementEditor.getByRole('button', { name: 'Save event changes' }).click();
  await expect(settlementEditor.getByRole('status')).toContainText('Cash event updated');

  await window.getByRole('button', { name: 'Advanced edit Housing on card' }).click();
  const advancedEventEditor = window
    .getByRole('heading', { name: 'Advanced record editor' })
    .locator('xpath=ancestor::form[1]');
  await expectEditorReady(advancedEventEditor);
  await window.getByText('Show advanced structured fields').click();
  const eventJson = window.getByLabel('Record fields JSON');
  const attemptedConversion = JSON.parse(await eventJson.inputValue()) as Record<string, unknown>;
  attemptedConversion.kind = 'receivable-settlement';
  await eventJson.fill(JSON.stringify(attemptedConversion, null, 2));
  await advancedEventEditor.getByRole('button', { name: 'Save changes' }).click();
  await expect(advancedEventEditor.getByRole('alert')).toContainText(
    'Use Money Owed to schedule or record received money',
  );
  await window.getByRole('button', { name: 'Cancel' }).click();

  await openPrimaryPage(window, 'Assets and net worth');
  await expect(window.getByRole('heading', { name: 'Net worth' })).toBeVisible();
  await expect(window.getByText('Adjusted net worth', { exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Edit asset' }).click();
  const assetEditor = window
    .getByRole('button', { name: 'Save asset' })
    .locator('xpath=ancestor::form[1]');
  await expectEditorReady(assetEditor);
  await window.getByLabel('Current value').fill('5100.00');
  await assetEditor.getByLabel('Expected annual return % (optional)').fill('10.00');
  await assetEditor.getByLabel('Gross annual pay for this estimate (optional)').fill('100000.00');
  await assetEditor.getByLabel('Your contribution % of gross pay (optional)').fill('4.00');
  await assetEditor.getByLabel('Employer match % of gross pay (optional)').fill('4.00');
  await window.getByRole('button', { name: 'Save asset' }).click();
  await expectStatusMessage(window, 'Asset updated');
  const savedInvestment = await window.evaluate(async () => {
    const response = await (
      globalThis as unknown as { balanceBook: BalanceBookApi }
    ).balanceBook.listRecords();
    if (!response.ok) throw new Error(response.error);
    return response.value.assets.find((asset) => asset.name === 'Synthetic investment');
  });
  expect(savedInvestment).toMatchObject({
    annualGrowthRateBasisPoints: 1_000,
    contributionGrossAnnualIncomeCents: 10_000_000,
    contributionRateBasisPoints: 400,
    employerMatchBasisPoints: 400,
  });
  await expectNoSeriousAxeViolations(window);

  await openPrimaryPage(window, 'Cash forecast');
  const forecastSeriesButtons = window
    .getByRole('group', { name: 'Forecast series' })
    .getByRole('button');
  await expect(forecastSeriesButtons.last()).toHaveText('Net worth');
  await expect(forecastSeriesButtons.last()).toBeEnabled();
  const netWorthForecast = await window.evaluate(async () => {
    const response = await (
      globalThis as unknown as { balanceBook: BalanceBookApi }
    ).balanceBook.getForecast();
    if (!response.ok) throw new Error(response.error);
    return response.value.dailyCash?.map((point) => ({
      date: point.date,
      expected: point.expectedNetWorthCents,
      conservative: point.conservativeNetWorthCents,
    }));
  });
  expect(netWorthForecast?.length).toBeGreaterThanOrEqual(90);
  expect(netWorthForecast?.every((point) => point.expected !== undefined)).toBe(true);
  expect(netWorthForecast?.every((point) => point.conservative !== undefined)).toBe(true);
  await forecastSeriesButtons.last().click();
  await expect(window.getByRole('heading', { name: 'Net worth', exact: true })).toBeVisible();

  await openPrimaryPage(window, 'Refinance planner');
  await expect(window.getByRole('heading', { name: 'Refinance planner' })).toBeVisible();
  await expect(window.getByRole('heading', { name: '1. Loans and payoff timing' })).toBeVisible();

  // Consolidate a monthly loan and a biweekly loan. Closing, payoff, and first-payment dates are
  // intentionally distinct so this flow proves the effective-dated boundaries instead of merely
  // exercising a same-day refinance.
  const autoLoanChoice = window.getByRole('checkbox', {
    name: 'Synthetic auto loan',
    exact: true,
  });
  const personalLoanChoice = window.getByRole('checkbox', {
    name: 'Synthetic personal loan',
    exact: true,
  });
  await expect(autoLoanChoice).toBeChecked();
  await personalLoanChoice.check();
  await expect(personalLoanChoice).toBeChecked();
  const autoPayoffQuote = window.getByLabel('Payoff quote for Synthetic auto loan');
  const personalPayoffQuote = window.getByLabel('Payoff quote for Synthetic personal loan');
  await expect(autoPayoffQuote).not.toHaveValue('');
  await expect(personalPayoffQuote).not.toHaveValue('');
  const initialPayoffQuotes = [
    await autoPayoffQuote.inputValue(),
    await personalPayoffQuote.inputValue(),
  ];
  const refinanceClosingDate = window.getByLabel('Refinance closing date');
  await refinanceClosingDate.fill('');
  await expect(refinanceClosingDate).toHaveValue('');
  await expect(window.getByRole('heading', { name: 'Refinance planner' })).toBeVisible();
  await refinanceClosingDate.fill('2026-08-15');
  await expect
    .poll(async () => [await autoPayoffQuote.inputValue(), await personalPayoffQuote.inputValue()])
    .not.toEqual(initialPayoffQuotes);
  const closingDatePayoffQuotes = [
    await autoPayoffQuote.inputValue(),
    await personalPayoffQuote.inputValue(),
  ];
  await window.getByRole('checkbox', { name: 'The old lender payoff posts after closing' }).check();
  await window.getByLabel('Old lender payoff date').fill('2026-08-18');
  // A replacement payment can legitimately begin before the old lender finishes its delayed
  // administrative payoff. The UI and engine must preserve both schedules during that overlap.
  await window.getByLabel('First new-loan payment date').fill('2026-08-16');
  await expect
    .poll(async () => [await autoPayoffQuote.inputValue(), await personalPayoffQuote.inputValue()])
    .not.toEqual(closingDatePayoffQuotes);
  const firstPayoffCents =
    inputMoneyToCents(await autoPayoffQuote.inputValue()) +
    inputMoneyToCents(await personalPayoffQuote.inputValue());
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: '2. New loan' })).toBeVisible();
  await window.getByLabel('Plan name').fill('Synthetic consolidation refinance');
  await window.getByLabel('New loan name').fill('Synthetic consolidated loan');
  await window.getByLabel('New lender (optional)').fill('Synthetic refinance lender');
  await window.getByLabel('New APR').fill('4.50');
  await window.getByLabel('Monthly debt payment (optional)').fill('');
  await window.getByLabel('New term months').fill('48');
  await window.getByLabel('Payment account').selectOption({ label: 'Edited primary checking' });
  // Principal covers lender payoffs and financed fees, then sends exactly $1,000 of cash-out to
  // the selected destination. Only the $100 unfinanced fee should leave a bank account.
  await window
    .getByLabel('New principal', { exact: true })
    .fill(centsForInput(firstPayoffCents + 120_000));
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(
    window.getByRole('heading', { name: '3. Money moving through your bank accounts' }),
  ).toBeVisible();
  await window.getByLabel('Total closing and lender fees').fill('300.00');
  await window.getByLabel('Fees included in the new principal').fill('200.00');
  await window
    .getByLabel('Account paying cash due at closing')
    .selectOption({ label: 'Edited primary checking' });
  await window
    .getByLabel('Account receiving excess refinance cash')
    .selectOption({ label: 'Reserve savings' });
  const firstSettlement = window.getByLabel('Refinance settlement breakdown');
  await expect(firstSettlement.getByText('Bank cash leaving').locator('..')).toContainText(
    '$100.00',
  );
  await expect(firstSettlement.getByText('Bank cash received').locator('..')).toContainText(
    '$1,000.00',
  );
  await window.getByRole('button', { name: 'Compare full refinance' }).click();
  await expect(window.getByRole('heading', { name: 'Current plan versus offer' })).toBeVisible();
  const refinanceComparison = window.getByRole('table');
  await expect(refinanceComparison.getByRole('row', { name: /Monthly cash draft/ })).toBeVisible();
  await expect(
    refinanceComparison.getByRole('row', { name: /Net remaining cash cost/ }),
  ).toBeVisible();
  await expect(
    refinanceComparison.getByRole('row', { name: /Consolidated cash low/ }),
  ).toBeVisible();
  await expect(refinanceComparison.getByRole('row', { name: /Safe cash available/ })).toBeVisible();
  await expect(
    window.getByRole('heading', { name: 'Use this refinance going forward' }),
  ).toBeVisible();
  await expect(window.getByText(/existing payments remain before 2026-08-18/)).toBeVisible();
  await expect(window.getByText(/begins payments on 2026-08-16/)).toBeVisible();
  window.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Use Synthetic consolidation refinance going forward?');
    await dialog.accept();
  });
  await window.getByRole('button', { name: 'Use this refinance' }).click();
  await expectStatusMessage(
    window,
    'Old payments stop on 2026-08-18; the new payment starts on 2026-08-16.',
  );
  await expect(
    window.getByRole('strong').filter({ hasText: /^Synthetic consolidation refinance$/ }),
  ).toBeVisible();
  await expect(
    window.getByText(
      /Synthetic (?:personal loan \+ Synthetic auto loan|auto loan \+ Synthetic personal loan) .* Synthetic consolidated loan/,
    ),
  ).toBeVisible();
  await expect(window.getByText('Closes: 2026-08-15')).toBeVisible();
  await expect(window.getByText('Old loans paid: 2026-08-18')).toBeVisible();
  await expect(window.getByText('First new payment: 2026-08-16')).toBeVisible();
  await expect(
    window.getByText('Bank cash paid: $100.00 from Edited primary checking'),
  ).toBeVisible();
  await expect(window.getByText('Cash-out received: $1,000.00 in Reserve savings')).toBeVisible();

  // Reload the renderer to prove the committed decision is hydrated from SQLite, then refinance
  // that future replacement again. This is the user-visible stacking path and protects the
  // original consolidation history rather than mutating it in place.
  await reloadAndWait(window);
  await expect(window.getByRole('heading', { name: 'Refinance planner' })).toBeVisible();
  await expect(
    window.getByRole('strong').filter({ hasText: /^Synthetic consolidation refinance$/ }),
  ).toBeVisible();
  await expect(
    window.getByRole('checkbox', { name: 'Synthetic auto loan', exact: true }),
  ).toHaveCount(0);
  await expect(
    window.getByRole('checkbox', { name: 'Synthetic personal loan', exact: true }),
  ).toHaveCount(0);
  await window.getByRole('button', { name: 'Refinance this replacement' }).click();
  await expectStatusMessage(
    window,
    'Planning the next refinance after Synthetic consolidation refinance.',
  );
  await expect(
    window.getByRole('checkbox', {
      name: /Synthetic consolidated loan.*available after 2026-08-18/,
    }),
  ).toBeChecked();
  await window.getByLabel('Refinance closing date').fill('2026-10-01');
  const replacementPayoff = window.getByLabel('Payoff quote for Synthetic consolidated loan');
  await expect(replacementPayoff).not.toHaveValue('');
  const replacementClosingDateQuote = await replacementPayoff.inputValue();
  await window.getByRole('checkbox', { name: 'The old lender payoff posts after closing' }).check();
  await window.getByLabel('Old lender payoff date').fill('2026-10-02');
  await window.getByLabel('First new-loan payment date').fill('2026-10-10');
  await expect.poll(() => replacementPayoff.inputValue()).not.toBe(replacementClosingDateQuote);
  const replacementPayoffCents = inputMoneyToCents(await replacementPayoff.inputValue());
  expect(replacementPayoffCents).toBeGreaterThan(50_000);
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: '2. New loan' })).toBeVisible();
  await window.getByLabel('Plan name').fill('Synthetic stacked refinance');
  await window.getByLabel('New loan name').fill('Synthetic second replacement');
  await window.getByLabel('New APR').fill('3.75');
  await window.getByLabel('New term months').fill('48');
  await window.getByLabel('Payment account').selectOption({ label: 'Edited primary checking' });
  // This second refinance contributes $500 toward principal and pays $150 of fees, all from the
  // reserve account, proving the cash-contribution branch can stack after a cash-out refinance.
  await window
    .getByLabel('New principal', { exact: true })
    .fill(centsForInput(replacementPayoffCents - 50_000));
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(
    window.getByRole('heading', { name: '3. Money moving through your bank accounts' }),
  ).toBeVisible();
  await window.getByLabel('Total closing and lender fees').fill('150.00');
  await window.getByLabel('Fees included in the new principal').fill('0.00');
  await window
    .getByLabel('Account paying cash due at closing')
    .selectOption({ label: 'Reserve savings' });
  const stackedSettlement = window.getByLabel('Refinance settlement breakdown');
  await expect(stackedSettlement.getByText('Bank cash leaving').locator('..')).toContainText(
    '$650.00',
  );
  await expect(stackedSettlement.getByText('Bank cash received').locator('..')).toContainText(
    '$0.00',
  );
  await window.getByRole('button', { name: 'Compare full refinance' }).click();
  await expect(window.getByRole('heading', { name: 'Current plan versus offer' })).toBeVisible();
  window.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Use Synthetic stacked refinance going forward?');
    await dialog.accept();
  });
  await window.getByRole('button', { name: 'Use this refinance' }).click();
  await expectStatusMessage(
    window,
    'Old payments stop on 2026-10-02; the new payment starts on 2026-10-10.',
  );
  await expect(
    window.getByRole('strong').filter({ hasText: /^Synthetic stacked refinance$/ }),
  ).toBeVisible();
  await expect(
    window.getByText(/Synthetic consolidated loan .* Synthetic second replacement/),
  ).toBeVisible();
  await expect(window.getByText('Bank cash paid: $650.00 from Reserve savings')).toBeVisible();
  await expect(window.getByText('Cash-out received: $0.00')).toBeVisible();
  await reloadAndWait(window);
  await expect(window.getByRole('heading', { name: 'Refinance planner' })).toBeVisible();
  await expect(
    window.getByRole('strong').filter({ hasText: /^Synthetic consolidation refinance$/ }),
  ).toBeVisible();
  await expect(
    window.getByRole('strong').filter({ hasText: /^Synthetic stacked refinance$/ }),
  ).toBeVisible();
  await window.setViewportSize({ width: 430, height: 900 });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(window);
  await window.setViewportSize({ width: 1440, height: 1000 });
  await window.screenshot({ path: 'local-screenshots/daily-driver-refinance.png', fullPage: true });

  await openPrimaryPage(window, 'Cash forecast');
  const cashOutClosingDay = window.getByRole('row').filter({ hasText: 'Aug 15, 2026' }).first();
  await expect(cashOutClosingDay).toContainText(
    'Synthetic consolidation refinance excess refinance proceeds',
  );
  await expect(cashOutClosingDay).toContainText(
    'Synthetic consolidation refinance cash due at closing',
  );
  await expect(cashOutClosingDay).toContainText('$1,000.00');
  await expect(cashOutClosingDay).toContainText('-$100.00');
  await expect(cashOutClosingDay).toContainText('Reserve savings');
  await expect(cashOutClosingDay).toContainText('Edited primary checking');
  const beforeLenderPayoffDay = window.getByRole('row').filter({ hasText: 'Aug 17, 2026' }).first();
  const lenderPayoffDay = window.getByRole('row').filter({ hasText: 'Aug 18, 2026' }).first();
  expect(displayedMoneyToCents(await lenderPayoffDay.locator('td').nth(2).innerText())).toBe(
    displayedMoneyToCents(await beforeLenderPayoffDay.locator('td').nth(2).innerText()),
  );
  await expect(lenderPayoffDay).not.toContainText('loan payoff');
  const retiredBiweeklyPaymentDay = window
    .getByRole('row')
    .filter({ hasText: 'Aug 19, 2026' })
    .first();
  await expect(retiredBiweeklyPaymentDay).not.toContainText('Synthetic personal loan payment');
  const retiredMonthlyPaymentDay = window
    .getByRole('row')
    .filter({ hasText: 'Sep 1, 2026' })
    .first();
  await expect(retiredMonthlyPaymentDay).not.toContainText('Synthetic auto loan payment');
  const firstReplacementPaymentDay = window
    .getByRole('row')
    .filter({ hasText: 'Aug 16, 2026' })
    .first();
  await expect(firstReplacementPaymentDay).toContainText('Synthetic consolidated loan payment');
  const secondReplacementPaymentDay = window
    .getByRole('row')
    .filter({ hasText: 'Sep 16, 2026' })
    .first();
  await expect(secondReplacementPaymentDay).toContainText('Synthetic consolidated loan payment');
  const stackedClosingDay = window.getByRole('row').filter({ hasText: 'Oct 1, 2026' }).first();
  await expect(stackedClosingDay).toContainText('Synthetic stacked refinance cash due at closing');
  await expect(stackedClosingDay).toContainText('-$650.00');
  const stackedFirstPaymentDay = window
    .getByRole('row')
    .filter({ hasText: 'Oct 10, 2026' })
    .first();
  await expect(stackedFirstPaymentDay).toContainText('Synthetic second replacement payment');

  await openPrimaryPage(window, 'Loans');
  const futureReplacementDisclosure = window
    .getByRole('strong')
    .filter({ hasText: /^Synthetic consolidated loan$/ })
    .locator('xpath=ancestor::details[1]');
  const futureReplacementSummary = futureReplacementDisclosure.locator(':scope > summary');
  await expect(futureReplacementDisclosure).not.toHaveAttribute('open', '');
  await expect(futureReplacementSummary).toContainText(
    'Scheduled to start with Synthetic consolidation refinance on 2026-08-15',
  );
  await expect(futureReplacementSummary).toContainText('Future balance');
  await futureReplacementSummary.click();
  await expect(futureReplacementDisclosure).toHaveAttribute('open', '');
  const futureReplacementCard = futureReplacementDisclosure
    .getByRole('heading', { name: 'Synthetic consolidated loan' })
    .locator('..')
    .locator('..');
  await expect(futureReplacementCard).toContainText(
    'Effective modeled balance (2026-07-14): $0.00',
  );
  await expect(futureReplacementCard).toContainText('Next payment: Starts 2026-08-16');
  await expect(futureReplacementCard).toContainText('Cash schedule: Begins on 2026-08-16');
  await expect(futureReplacementCard).toContainText(
    'Lifecycle: Scheduled to start with Synthetic consolidation refinance on 2026-08-15',
  );

  await openPrimaryPage(window, 'Reconciliation');
  const manualBalanceCheck = window.getByText('Compare an actual balance', { exact: true });
  await manualBalanceCheck.click();
  await window.getByLabel('Date', { exact: true }).fill('2026-08-01');
  await window.getByLabel('Forecast balance').fill('2500.00');
  await window.getByLabel('Actual balance').fill('2450.00');
  await window.getByRole('button', { name: 'Save balance check' }).click();
  await expectStatusMessage(window, 'does not move cash');

  await openPrimaryPage(window, 'Overview');
  const everydayBeforeFloorIncrease = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  await window.evaluate(() => {
    globalThis.location.hash = '#/settings';
  });
  await waitForPageReady(window);
  await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => window.evaluate(() => globalThis.location.hash)).toBe('#/settings');
  await window.evaluate(() => {
    globalThis.location.hash = '#/route-that-does-not-exist';
  });
  await waitForPageReady(window);
  await expect(window.getByRole('heading', { name: 'How much can I safely spend?' })).toBeVisible();
  await expect.poll(() => window.evaluate(() => globalThis.location.hash)).toBe('#/');
  await openPrimaryPage(window, 'Settings');
  await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(window.getByText(/Version \d+\.\d+\.\d+/, { exact: false })).toBeVisible();
  await selectSettingsCategory(window, 'Accounts');
  const effectiveGlobalMinimum = window
    .getByText('Effective global minimum', { exact: true })
    .locator('..');
  await expect(effectiveGlobalMinimum).toContainText('$500.00');
  const accountProtection = window.getByRole('form', {
    name: 'Edited primary checking protection settings',
  });
  await window
    .getByText('Edited primary checking', { exact: true })
    .locator('xpath=ancestor::div[2]')
    .getByRole('button', { name: 'Manage' })
    .click();
  await accountProtection.getByLabel('Account minimum').fill('900.00');
  await accountProtection.getByLabel('Preferred buffer').fill('1200.00');
  await accountProtection.getByLabel('Transfer lead time (days)').fill('3');
  await accountProtection.getByRole('button', { name: 'Save Edited primary checking' }).click();
  await expectStatusMessage(window, 'Global minimum and funding guidance were recalculated.');
  await expect(effectiveGlobalMinimum).toContainText('$900.00');
  await expect(accountProtection.getByLabel('Account minimum')).toHaveValue('900.00');
  await expect(accountProtection.getByLabel('Preferred buffer')).toHaveValue('1200.00');
  await expect(accountProtection.getByLabel('Transfer lead time (days)')).toHaveValue('3');
  const overviewVisibility = accountProtection.getByLabel(
    'Show this account in the Overview cash-account list',
  );
  await expect(overviewVisibility).toBeChecked();
  await overviewVisibility.uncheck();
  await accountProtection.getByRole('button', { name: 'Save Edited primary checking' }).click();
  await expectStatusMessage(window, 'Global minimum and funding guidance were recalculated.');
  await openPrimaryPage(window, 'Overview');
  const overviewCashAccounts = window.getByLabel('Overview cash accounts');
  await expect(
    overviewCashAccounts.getByText('Edited primary checking', { exact: true }),
  ).toHaveCount(0);
  await window
    .getByLabel('Everyday card safe spending summary')
    .getByText('Projected lows', { exact: true })
    .click();
  await expect(
    window.getByLabel('Everyday card Edited primary checking account low'),
  ).toBeVisible();
  await openPrimaryPage(window, 'Settings');
  await selectSettingsCategory(window, 'Accounts');
  await window
    .getByText('Edited primary checking', { exact: true })
    .locator('xpath=ancestor::div[2]')
    .getByRole('button', { name: 'Manage' })
    .click();
  await expect(overviewVisibility).not.toBeChecked();
  await overviewVisibility.check();
  await accountProtection.getByRole('button', { name: 'Save Edited primary checking' }).click();
  await expectStatusMessage(window, 'Global minimum and funding guidance were recalculated.');
  await openPrimaryPage(window, 'Overview');
  await expect(
    window
      .getByLabel('Overview cash accounts')
      .getByText('Edited primary checking', { exact: true }),
  ).toBeVisible();
  const everydayAfterAccountFloorIncrease = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  expect(everydayAfterAccountFloorIncrease).toBe(everydayBeforeFloorIncrease - 40_000);
  await openPrimaryPage(window, 'Settings');
  await selectSettingsCategory(window, 'Forecast and safety');
  const experimentalCardInterest = window.getByLabel(
    'Include card interest in forecasts (experimental)',
  );
  await expect(experimentalCardInterest).not.toBeChecked();
  await experimentalCardInterest.check();
  await window.getByRole('button', { name: 'Save experimental setting' }).click();
  await expectStatusMessage(window, 'Experimental card-interest setting saved.');

  await window.getByLabel('Consolidated minimum override').fill('1000.00');
  await window.getByLabel('Consolidated preferred override (optional)').fill('1500.00');
  await window.getByRole('button', { name: 'Save forecast safety settings' }).click();
  await expect(
    window.getByText('Forecast safety settings updated.', { exact: false }),
  ).toBeVisible();
  await selectSettingsCategory(window, 'Accounts');
  await expect(effectiveGlobalMinimum).toContainText('$1,000.00');
  await expect(effectiveGlobalMinimum).toContainText('Preferred warning $1,500.00');
  await openPrimaryPage(window, 'Overview');
  await expect(window.getByText('Global Spending Power', { exact: true })).toBeVisible();
  const everydayAfterGlobalFloorIncrease = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  expect(everydayAfterGlobalFloorIncrease).toBe(everydayAfterAccountFloorIncrease - 10_000);
  await openPrimaryPage(window, 'Settings');
  await selectSettingsCategory(window, 'Forecast and safety');
  await window.getByLabel('Forecast horizon in days').fill('120');
  await window.getByRole('button', { name: 'Save forecast safety settings' }).click();
  await expect(
    window.getByText('Forecast safety settings updated.', { exact: false }),
  ).toBeVisible();
  await openPrimaryPage(window, 'Overview');
  await openPrimaryPage(window, 'Recurring plan');
  await window.getByLabel('From account').selectOption({ label: 'Reserve savings' });
  await window.getByLabel('To account').selectOption({ label: 'Edited primary checking' });
  await window.getByLabel('Amount', { exact: true }).fill('100.00');
  await window.getByLabel('Initiation date').fill('2026-09-01');
  await window.getByLabel('Arrival date').fill('2026-09-03');
  await window.getByLabel('Label', { exact: true }).fill('Guardrail transfer');
  await window.getByLabel('Status').selectOption('scheduled');
  await window.getByRole('button', { name: 'Add planned transfer' }).click();
  await expectStatusMessage(window, 'Transfer debit and delayed credit created together.');
  await window.getByLabel('Edit Guardrail transfer').first().click();
  const transferEditor = window.getByRole('form', { name: 'Cash event editor' });
  await expectEditorReady(transferEditor);
  await expect(transferEditor.getByLabel('Event type')).toHaveValue('Transfer initiation');
  await expect(transferEditor.getByLabel('Certainty')).toHaveValue('Confirmed ownership transfer');
  await transferEditor.getByLabel('Amount').fill('150.00');
  await transferEditor.getByRole('button', { name: 'Save event changes' }).click();
  await expect(transferEditor.getByRole('status')).toContainText('Cash event updated');
  await openPrimaryPage(window, 'Cash forecast');
  await expect(window.getByRole('columnheader', { name: 'In transfer' })).toBeVisible();
  const transferDay = window.getByRole('row').filter({ hasText: 'Sep 1, 2026' }).first();
  await expect(transferDay.locator('td').nth(3)).toHaveText('$150.00');
  await transferDay
    .getByRole('button', { name: 'Trace Guardrail transfer to its source record' })
    .first()
    .click();
  await window.waitForURL(/#\/records\?entityType=forecast-event/, { timeout: 15_000 });
  await waitForPageReady(window);
  await expect(window.getByRole('heading', { name: 'Activity & records' })).toBeVisible();
  const tracedTransferEditor = window.getByRole('form', { name: 'Cash event editor' });
  await expectEditorReady(tracedTransferEditor);
  await expect(tracedTransferEditor.getByLabel('Event label')).toHaveValue('Guardrail transfer');
  await tracedTransferEditor.getByRole('button', { name: 'Close editor' }).click();
  await window.getByLabel('Search activity').fill('Guardrail transfer');
  await expect(window.getByText('Guardrail transfer', { exact: true }).first()).toBeVisible();

  // Update a real account balance from Overview, then prove the same audited account record
  // refreshes the account tile and downstream card spending power without a duplicate save.
  await openPrimaryPage(window, 'Overview');
  const spendingPowerBeforeBalanceUpdate = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  const overviewAccountSummary = window.getByLabel('Edited primary checking balance summary');
  await overviewAccountSummary
    .getByRole('button', { name: 'Open quick update for Edited primary checking' })
    .click();
  const overviewBalanceEditor = window.getByRole('form', {
    name: 'Update Edited primary checking balance',
  });
  await expect(overviewBalanceEditor).toBeVisible();
  const overviewBalanceInput = overviewBalanceEditor.getByLabel('New balance');
  const existingOverviewBalanceCents = inputMoneyToCents(await overviewBalanceInput.inputValue());
  const revisedOverviewBalanceCents = existingOverviewBalanceCents + 1_234;
  await overviewBalanceInput.fill(centsForInput(revisedOverviewBalanceCents));
  await overviewBalanceEditor.getByRole('button', { name: 'Save balance' }).dblclick();
  await expectStatusMessage(window, 'Forecasts and spending power refreshed.');
  await expect(overviewAccountSummary).toContainText(
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      revisedOverviewBalanceCents / 100,
    ),
  );
  const spendingPowerAfterBalanceUpdate = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  expect(spendingPowerAfterBalanceUpdate).toBe(spendingPowerBeforeBalanceUpdate + 1_234);
  await reloadAndWait(window);
  await expect(window.getByRole('heading', { name: 'How much can I safely spend?' })).toBeVisible();
  await expect(window.getByLabel('Edited primary checking balance summary')).toContainText(
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      revisedOverviewBalanceCents / 100,
    ),
  );

  // Overview card-balance edits reuse the same card and statement records as the Cards page.
  // Current total is an issuer snapshot; changing it must not rewrite the locked statement,
  // checking balance, payment policy, or scheduled-payment plan.
  const checkingSummaryBeforeCardEdits =
    (await window.getByLabel('Edited primary checking balance summary').textContent()) ?? '';
  const everydayOverview = window.getByLabel('Everyday card safe spending summary');
  const originalCurrentCardCents = displayedMoneyToCents(
    (await everydayOverview.getByLabel('Everyday card current balance').textContent()) ?? '',
  );
  const originalStatementCents = displayedMoneyToCents(
    (await everydayOverview.getByLabel('Everyday card last statement balance').textContent()) ?? '',
  );
  await everydayOverview
    .getByRole('button', { name: 'Edit current total for Everyday card' })
    .click();
  const currentCardEditor = window.getByRole('form', {
    name: 'Update Everyday card balance',
  });
  await expect(currentCardEditor).toBeVisible();
  const revisedCurrentCardCents = originalCurrentCardCents + 321;
  await currentCardEditor
    .getByLabel('Issuer current balance')
    .fill(centsForInput(revisedCurrentCardCents));
  await currentCardEditor.getByRole('button', { name: 'Save balance' }).dblclick();
  await expectStatusMessage(window, 'Forecasts and card details refreshed.');
  await expect(everydayOverview.getByLabel('Everyday card current balance')).toHaveText(
    formattedMoney(revisedCurrentCardCents),
  );
  await expect(everydayOverview.getByLabel('Everyday card last statement balance')).toHaveText(
    formattedMoney(originalStatementCents),
  );
  expect(
    (await window.getByLabel('Edited primary checking balance summary').textContent()) ?? '',
  ).toBe(checkingSummaryBeforeCardEdits);

  await openPrimaryPage(window, 'Credit cards');
  const everydayCardAfterOverviewEdit = window
    .getByRole('heading', { name: 'Everyday card' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await openCardManagement(window, 'Everyday card');
  await expect(
    everydayCardAfterOverviewEdit
      .getByText('Total current balance', { exact: true })
      .locator('xpath=..'),
  ).toContainText(formattedMoney(revisedCurrentCardCents));
  await expect(everydayCardAfterOverviewEdit).toContainText('Synthetic installment one');
  await everydayCardAfterOverviewEdit.getByRole('button', { name: 'Edit card' }).click();
  const policyCheckEditor = window.getByRole('form', { name: 'Credit card editor' });
  await expectEditorReady(policyCheckEditor);
  await expect(policyCheckEditor.getByLabel('Payment policy')).toHaveValue('full-statement');
  await expect(
    policyCheckEditor.getByLabel(
      'Include carried-balance interest in experimental forecasts for this card',
    ),
  ).not.toBeChecked();
  await policyCheckEditor.getByRole('button', { name: 'Cancel' }).click();

  // A locked-statement correction updates the statement-derived debt and forecast, while the
  // separately reported current total and scheduled installment remain intact.
  await openPrimaryPage(window, 'Overview');
  const everydayBeforeStatementEdit = window.getByLabel('Everyday card safe spending summary');
  const revisedStatementCents = originalStatementCents + 777;
  await everydayBeforeStatementEdit
    .getByRole('button', { name: 'Edit last statement for Everyday card' })
    .click();
  const statementEditor = window.getByRole('form', {
    name: 'Update Everyday card balance',
  });
  await expect(statementEditor).toBeVisible();
  await expect(statementEditor.getByRole('note')).toHaveCount(0);
  await statementEditor
    .getByLabel('Latest statement balance')
    .fill(centsForInput(revisedStatementCents));
  await statementEditor.getByRole('button', { name: 'Save balance' }).click();
  await expectStatusMessage(window, 'Forecasts and card details refreshed.');
  await expect(
    everydayBeforeStatementEdit.getByLabel('Everyday card last statement balance'),
  ).toHaveText(formattedMoney(revisedStatementCents));
  await expect(everydayBeforeStatementEdit.getByLabel('Everyday card current balance')).toHaveText(
    formattedMoney(revisedCurrentCardCents),
  );
  expect(
    (await window.getByLabel('Edited primary checking balance summary').textContent()) ?? '',
  ).toBe(checkingSummaryBeforeCardEdits);
  await openPrimaryPage(window, 'Credit cards');
  const everydayCardAfterStatementEdit = window
    .getByRole('heading', { name: 'Everyday card' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
  await openCardManagement(window, 'Everyday card');
  await expect(
    everydayCardAfterStatementEdit
      .getByText('Latest closed statement', { exact: true })
      .locator('xpath=..'),
  ).toContainText(formattedMoney(revisedStatementCents));
  await expect(everydayCardAfterStatementEdit).toContainText('Synthetic installment one');

  // Log a shared card expense from Overview. The card activity and Money Owed record must save
  // atomically, card debt must rise immediately, and bank cash must not move until payment.
  await openPrimaryPage(window, 'Overview');
  const expenseBaseline = await window.evaluate(async () => {
    const api = (globalThis as unknown as { balanceBook: BalanceBookApi }).balanceBook;
    const [records, forecast] = await Promise.all([api.listRecords(), api.getForecast()]);
    if (!records.ok) throw new Error(records.error);
    if (!forecast.ok) throw new Error(forecast.error);
    return {
      eventIds: records.value.events.map((event) => event.id),
      receivableIds: records.value.receivables.map((receivable) => receivable.id),
      currentCashCents: forecast.value.currentConsolidatedCashCents,
      currentReceivableCents: forecast.value.currentReceivableCents,
    };
  });
  const checkingBeforeExpense =
    (await window.getByLabel('Edited primary checking balance summary').textContent()) ?? '';
  const cardBeforeExpenseCents = displayedMoneyToCents(
    (await window.getByLabel('Everyday card current balance').textContent()) ?? '',
  );
  await window.getByRole('button', { name: 'Log an expense' }).click();
  const expenseEditor = window.getByRole('form', { name: 'Log an expense' });
  await expectEditorReady(expenseEditor);
  await expenseEditor.getByLabel('Paid with').selectOption({ label: 'Everyday card' });
  await expenseEditor.getByLabel('Amount').fill('12.35');
  await expenseEditor.getByLabel('Description').fill('Synthetic shared Overview expense');
  await expenseEditor.getByRole('checkbox', { name: 'Shared expense (50%)' }).check();
  await expenseEditor.getByLabel('Owed by').fill('Synthetic counterparty');
  await expect(expenseEditor.getByText('Added to Money Owed').locator('xpath=..')).toContainText(
    '$6.18',
  );
  await expenseEditor.getByRole('button', { name: 'Save expense' }).click();
  await expectStatusMessage(window, '$6.18 was added to Money Owed.');
  await expect(window.getByLabel('Everyday card current balance')).toHaveText(
    formattedMoney(cardBeforeExpenseCents + 1_235),
  );
  expect(
    (await window.getByLabel('Edited primary checking balance summary').textContent()) ?? '',
  ).toBe(checkingBeforeExpense);
  const expenseResult = await window.evaluate(
    async ({ priorEventIds, priorReceivableIds }) => {
      const api = (globalThis as unknown as { balanceBook: BalanceBookApi }).balanceBook;
      const [records, forecast] = await Promise.all([api.listRecords(), api.getForecast()]);
      if (!records.ok) throw new Error(records.error);
      if (!forecast.ok) throw new Error(forecast.error);
      const event = records.value.events.find(
        (candidate) =>
          !priorEventIds.includes(candidate.id) &&
          candidate.label === 'Synthetic shared Overview expense',
      );
      const receivable = records.value.receivables.find(
        (candidate) =>
          !priorReceivableIds.includes(candidate.id) && candidate.relatedExpenseId === event?.id,
      );
      return { event, receivable, forecast: forecast.value };
    },
    {
      priorEventIds: expenseBaseline.eventIds,
      priorReceivableIds: expenseBaseline.receivableIds,
    },
  );
  expect(expenseResult.event).toMatchObject({
    amountCents: 1_235,
    direction: 'outflow',
    paymentMethod: 'credit-card',
    cardActivityTreatment: 'additional',
  });
  expect(expenseResult.receivable).toMatchObject({
    originalAmountCents: 618,
    remainingAmountCents: 618,
    grossExpenseCents: 1_235,
    userEconomicShareCents: 617,
    source: 'Synthetic counterparty',
    includeInCashForecast: false,
  });
  expect(expenseResult.forecast.currentConsolidatedCashCents).toBe(
    expenseBaseline.currentCashCents,
  );
  expect(expenseResult.forecast.currentReceivableCents).toBe(
    (expenseBaseline.currentReceivableCents ?? 0) + 618,
  );

  // Generate one isolated stale source balance, then prove presentation state and financial
  // resolution remain separate. Marking every notification read quiets and zeroes the badge; the
  // canonical exact-balance confirmation removes only this underlying condition and saves once.
  const checkInSource = await window.evaluate(async () => {
    const response = await (
      globalThis as unknown as { balanceBook: BalanceBookApi }
    ).balanceBook.upsertRecord({
      entityType: 'cash-account',
      payload: {
        id: 'notification-check-in-account',
        name: 'Notification check-in account',
        type: 'checking',
        openingBalanceCents: 10_000,
        balanceAsOf: '2026-06-20',
        includedInLiquidity: true,
        canFundOtherAccounts: true,
        showOnOverview: true,
        hardFloorCents: 0,
        transferDelayDays: 0,
      },
    });
    if (!response.ok) throw new Error(response.error);
    const forecast = await (
      globalThis as unknown as { balanceBook: BalanceBookApi }
    ).balanceBook.getForecast();
    if (!forecast.ok) throw new Error(forecast.error);
    globalThis.dispatchEvent(new CustomEvent('balance-book:financial-state-changed'));
    return forecast.value.cashAccounts?.find(
      (account) => account.id === 'notification-check-in-account',
    );
  });
  expect(checkInSource).toMatchObject({
    sourceBalanceCents: 10_000,
    sourceBalanceDate: '2026-06-20',
    calculatedThroughDate: '2026-07-14',
  });
  await openPrimaryPage(window, 'Overview');
  await window.setViewportSize({ width: 430, height: 900 });
  const inAppBrandMark = window.locator('.balance-brand-mark--compact').first();
  const inAppBrandLogo = inAppBrandMark.locator('img[data-balance-book-logo="app-icon"]');
  await expect(inAppBrandLogo).toBeVisible();
  const brandMarkBounds = await inAppBrandMark.boundingBox();
  const brandLogoBounds = await inAppBrandLogo.boundingBox();
  expect(brandMarkBounds).not.toBeNull();
  expect(brandLogoBounds).not.toBeNull();
  expect(Math.abs(brandLogoBounds!.x - brandMarkBounds!.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(brandLogoBounds!.y - brandMarkBounds!.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(brandLogoBounds!.width - brandMarkBounds!.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(brandLogoBounds!.height - brandMarkBounds!.height)).toBeLessThanOrEqual(0.5);
  const notificationTrigger = window.getByRole('button', {
    name: /Notifications, \d+ unread notification/,
  });
  await expect(notificationTrigger).toBeVisible();
  const unreadBeforeLabel = (await notificationTrigger.getAttribute('aria-label')) ?? '';
  const unreadBefore = Number(/Notifications, (\d+) unread/.exec(unreadBeforeLabel)?.[1]);
  expect(unreadBefore).toBeGreaterThan(0);
  await expect(notificationTrigger).toHaveText(String(unreadBefore));
  await expect(notificationTrigger.locator('svg')).toHaveCount(0);
  const notificationTriggerBounds = await notificationTrigger.boundingBox();
  const logoutBounds = await window.getByRole('button', { name: 'Log out' }).boundingBox();
  expect(notificationTriggerBounds).not.toBeNull();
  expect(logoutBounds).not.toBeNull();
  expect(Math.abs(notificationTriggerBounds!.height - logoutBounds!.height)).toBeLessThanOrEqual(
    0.5,
  );
  await notificationTrigger.click();
  const closeTrigger = window.getByRole('button', { name: 'Close notifications' });
  await expect(closeTrigger).toBeVisible();
  const closeTriggerBounds = await closeTrigger.boundingBox();
  expect(closeTriggerBounds).not.toBeNull();
  expect(Math.abs(closeTriggerBounds!.x - notificationTriggerBounds!.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(closeTriggerBounds!.y - notificationTriggerBounds!.y)).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(closeTriggerBounds!.width - notificationTriggerBounds!.width),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(closeTriggerBounds!.height - notificationTriggerBounds!.height),
  ).toBeLessThanOrEqual(0.5);
  const notificationSurface = window.getByRole('dialog', {
    name: 'Financial center',
    exact: true,
  });
  await expect(notificationSurface).toBeVisible();
  const noticeLayout = await notificationSurface.evaluate((surface) => {
    const body = surface.querySelector<HTMLElement>('[data-financial-center-view="notices"]');
    const card = surface.querySelector<HTMLElement>('article');
    const heading = card?.querySelector<HTMLElement>('strong')?.parentElement;
    const subject = heading?.lastElementChild as HTMLElement | null;
    const provider = surface.closest<HTMLElement>('.fui-FluentProvider');
    const switcher = surface.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Financial center sections"]',
    );
    if (!body || !card || !heading || !subject || !provider || !switcher) return null;
    const bodyStyle = getComputedStyle(body);
    const cardStyle = getComputedStyle(card);
    const unreadDotStyle = getComputedStyle(card, '::before');
    const cardBounds = card.getBoundingClientRect();
    const subjectBounds = subject.getBoundingClientRect();
    return {
      theme: provider.dataset.notificationTheme,
      bodyPaddingLeft: Number.parseFloat(bodyStyle.paddingLeft),
      bodyPaddingRight: Number.parseFloat(bodyStyle.paddingRight),
      cardPaddingLeft: Number.parseFloat(cardStyle.paddingLeft),
      cardWidth: cardBounds.width,
      cardRadius: Number.parseFloat(cardStyle.borderRadius),
      cardBackground: cardStyle.backgroundImage,
      unreadDotLeft: Number.parseFloat(unreadDotStyle.left),
      unreadDotWidth: Number.parseFloat(unreadDotStyle.width),
      subjectInsideCard:
        subjectBounds.left >= cardBounds.left - 0.5 &&
        subjectBounds.right <= cardBounds.right + 0.5,
      subjectFits: subject.scrollWidth <= subject.clientWidth + 1,
      subjectWhiteSpace: getComputedStyle(subject).whiteSpace,
      switchTransitionDuration: getComputedStyle(switcher, '::before').transitionDuration,
      switchTransform: getComputedStyle(switcher, '::before').transform,
    };
  });
  expect(noticeLayout).not.toBeNull();
  expect(noticeLayout!.theme).toBe(await window.locator('html').getAttribute('data-theme'));
  expect(noticeLayout!.bodyPaddingLeft).toBeGreaterThanOrEqual(16);
  expect(noticeLayout!.bodyPaddingRight).toBeGreaterThanOrEqual(16);
  expect(noticeLayout!.cardPaddingLeft).toBeGreaterThanOrEqual(16);
  expect(noticeLayout!.cardRadius).toBeGreaterThanOrEqual(12);
  expect(noticeLayout!.cardBackground).not.toBe('none');
  expect(noticeLayout!.unreadDotLeft).toBeGreaterThanOrEqual(0);
  expect(noticeLayout!.unreadDotLeft + noticeLayout!.unreadDotWidth).toBeLessThanOrEqual(
    noticeLayout!.cardWidth,
  );
  expect(noticeLayout!.subjectInsideCard).toBe(true);
  expect(noticeLayout!.subjectFits).toBe(true);
  expect(noticeLayout!.subjectWhiteSpace).toBe('normal');
  expect(noticeLayout!.switchTransitionDuration).not.toBe('0s');
  const financialCenterSections = notificationSurface.getByRole('tablist', {
    name: 'Financial center sections',
  });
  await expect(financialCenterSections).toBeVisible();
  const noticeSurfaceBounds = await notificationSurface.boundingBox();
  const noticeBodyBounds = await notificationSurface
    .getByRole('tabpanel', { name: 'Latest' })
    .boundingBox();
  await financialCenterSections.getByRole('tab', { name: 'Bills', exact: true }).click();
  const billsPanel = notificationSurface.getByRole('tabpanel', { name: 'Upcoming bills' });
  await expect(billsPanel).toBeVisible();
  await waitForViewTransition(billsPanel);
  const billsSurfaceBounds = await notificationSurface.boundingBox();
  const billsBodyBounds = await billsPanel.boundingBox();
  const billsSwitchTransform = await financialCenterSections.evaluate(
    (switcher) => getComputedStyle(switcher, '::before').transform,
  );
  expect(billsSwitchTransform).not.toBe(noticeLayout!.switchTransform);
  expectBoundsToMatch(billsSurfaceBounds, noticeSurfaceBounds);
  expectBoundsToMatch(billsBodyBounds, noticeBodyBounds);
  const billCard = notificationSurface.locator('article').first();
  await expect(billCard).toBeVisible();
  const billCardStyle = await billCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      paddingLeft: Number.parseFloat(style.paddingLeft),
      radius: Number.parseFloat(style.borderRadius),
      background: style.backgroundImage,
    };
  });
  expect(billCardStyle.paddingLeft).toBeGreaterThanOrEqual(12);
  expect(billCardStyle.radius).toBeGreaterThanOrEqual(12);
  expect(billCardStyle.background).not.toBe('none');
  await financialCenterSections.getByRole('tab', { name: 'Balances', exact: true }).click();
  const balancesPanel = notificationSurface.getByRole('tabpanel', { name: 'Current balances' });
  await expect(balancesPanel).toBeVisible();
  await waitForViewTransition(balancesPanel);
  const balancesSurfaceBounds = await notificationSurface.boundingBox();
  const balancesBodyBounds = await balancesPanel.boundingBox();
  const balancesSwitchTransform = await financialCenterSections.evaluate(
    (switcher) => getComputedStyle(switcher, '::before').transform,
  );
  expect(balancesSwitchTransform).not.toBe(billsSwitchTransform);
  expectBoundsToMatch(balancesSurfaceBounds, noticeSurfaceBounds);
  expectBoundsToMatch(balancesBodyBounds, noticeBodyBounds);
  const balanceCard = notificationSurface.getByRole('button', { name: /cash account$/ }).first();
  await expect(balanceCard).toBeVisible();
  const balanceCardStyle = await balanceCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      paddingLeft: Number.parseFloat(style.paddingLeft),
      radius: Number.parseFloat(style.borderRadius),
      background: style.backgroundImage,
    };
  });
  expect(balanceCardStyle.paddingLeft).toBeGreaterThanOrEqual(12);
  expect(balanceCardStyle.radius).toBeGreaterThanOrEqual(12);
  expect(balanceCardStyle.background).not.toBe('none');
  await financialCenterSections.getByRole('tab', { name: /^Notices / }).click();
  await expect(notificationSurface.getByRole('tabpanel', { name: 'Latest' })).toBeVisible();
  const notificationBounds = await notificationSurface.boundingBox();
  expect(notificationBounds).not.toBeNull();
  expect(notificationBounds!.x).toBeGreaterThanOrEqual(7);
  expect(notificationBounds!.y).toBeGreaterThanOrEqual(7);
  expect(notificationBounds!.x + notificationBounds!.width).toBeLessThanOrEqual(423);
  expect(notificationBounds!.y + notificationBounds!.height).toBeLessThanOrEqual(893);
  const staleCheckIn = notificationSurface.getByLabel(
    'Refresh cash balance: Notification check-in account',
  );
  await expect(staleCheckIn).toBeVisible();
  const attentionClass = await closeTrigger.getAttribute('class');
  await notificationSurface.getByRole('button', { name: 'Mark all read' }).click();
  await expect(closeTrigger).toHaveAttribute('data-unread-count', '0');
  await expect.poll(() => closeTrigger.getAttribute('class')).not.toBe(attentionClass);
  await staleCheckIn.getByRole('button', { name: 'Confirm calculated balance' }).click();
  await expect(staleCheckIn.getByLabel('Exact amount')).toHaveValue('100.00');
  await expect(staleCheckIn.getByLabel('Exact date')).toHaveValue('2026-07-14');
  await staleCheckIn.getByRole('button', { name: 'Save exact update' }).dblclick();
  await expect(staleCheckIn).toHaveCount(0);
  await closeTrigger.click();
  await expect(notificationSurface).toBeHidden();
  const quietNotificationTrigger = window.getByRole('button', {
    name: 'Notifications, 0 unread notifications',
  });
  await expect(quietNotificationTrigger).toHaveText('0');

  await window.setViewportSize({ width: 1440, height: 1000 });
  await openPrimaryPage(window, 'Setup checklist');
  const startSetupGroup = window
    .getByRole('heading', { name: /^Level 1/ })
    .locator('xpath=ancestor::section[1]');
  const setupHeaderGeometry = await startSetupGroup.evaluate((section) => {
    const title = section.querySelector<HTMLElement>('h2');
    const description = title?.parentElement?.querySelector<HTMLElement>('p, span');
    const status = title?.parentElement?.parentElement?.querySelector<HTMLElement>(
      ':scope > span:last-child',
    );
    if (!title || !description || !status) return null;
    const titleBounds = title.getBoundingClientRect();
    const descriptionBounds = description.getBoundingClientRect();
    const statusBounds = status.getBoundingClientRect();
    const overlaps = (left: DOMRect, right: DOMRect): boolean =>
      left.left < right.right &&
      left.right > right.left &&
      left.top < right.bottom &&
      left.bottom > right.top;
    return {
      descriptionBelowTitle: descriptionBounds.top >= titleBounds.bottom - 0.5,
      descriptionStatusOverlap: overlaps(descriptionBounds, statusBounds),
      titleStatusOverlap: overlaps(titleBounds, statusBounds),
    };
  });
  expect(setupHeaderGeometry).toEqual({
    descriptionBelowTitle: true,
    descriptionStatusOverlap: false,
    titleStatusOverlap: false,
  });

  await openPrimaryPage(window, 'Settings');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(window);
  // Load each data-backed route once, then resize it through the full viewport matrix. Keeping the
  // route outermost preserves every route/width assertion without rebuilding the same forecast
  // eight times.
  for (const route of layoutAuditRoutes) {
    for (const width of layoutAuditWidths) {
      await expectStableLayout(window, route, width);
    }
  }
  await window.setViewportSize({ width: 1440, height: 1000 });
  await window.evaluate(() => {
    globalThis.location.hash = '#/data';
    globalThis.scrollTo({ top: 0, left: 0 });
  });
  await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await window.screenshot({
    path: 'local-screenshots/daily-driver-settings.png',
    fullPage: true,
  });
  const createBackupButton = window.getByRole('button', { name: 'Create encrypted backup' });
  const backupPassword = window.getByLabel('Backup password (separate from sign-in)');
  const backupConfirmation = window.getByLabel('Confirm backup password');
  await expect(createBackupButton).toBeDisabled();
  await backupPassword.fill('synthetic-backup-password');
  await backupConfirmation.fill('different-backup-password');
  await expect(window.getByText('Backup passwords do not match')).toBeVisible();
  await expect(createBackupButton).toBeDisabled();
  await backupConfirmation.fill('synthetic-backup-password');
  await expect(createBackupButton).toBeEnabled();
  await backupPassword.fill('');
  await backupConfirmation.fill('');

  await window.getByRole('button', { name: 'Log out' }).click();
  await window.getByRole('button', { name: 'New User' }).click();
  await window.getByLabel('Password', { exact: true }).fill('blank-profile-password');
  await window.getByLabel('Confirm password').fill('blank-profile-password');
  await window.getByRole('button', { name: 'Create password' }).click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe('dark');
  await openPrimaryPage(window, 'Overview');
  await expect(window.getByRole('heading', { name: 'Build your first forecast' })).toBeVisible();
  await window.getByRole('button', { name: 'Start guided setup' }).click();
  await window
    .getByRole('checkbox', {
      name: /I consent to Balance Book storing the financial information I enter locally/,
    })
    .check();
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(
    window.getByRole('heading', { name: 'Which parts fit your finances?' }),
  ).toBeVisible();
  for (const question of applicabilityQuestions) {
    await window
      .getByRole('group', { name: question })
      .getByRole('button', { name: 'Yes' })
      .click();
  }
  await window.getByRole('button', { name: 'Continue' }).click();
  await window.getByLabel('Balance as of').fill('2026-07-14');
  await window.getByLabel('Account name').fill('Manual setup checking');
  await window.getByLabel('Opening balance').fill('1000.00');
  await window.getByRole('button', { name: 'Continue' }).click();
  await window.getByRole('button', { name: 'Continue' }).click();
  await window.getByRole('button', { name: 'Continue' }).click();
  await window.getByLabel('Card name').fill('Manual setup card');
  await window.getByLabel('Typical future statement').fill('100.00');
  await window.getByLabel('Open-cycle estimate policy').selectOption('actual-reset');
  await window.getByLabel('Payment policy').selectOption('manual');
  await expect(
    window.getByLabel('Statement closes on day (optional for manual payments)'),
  ).toHaveValue('');
  await expect(
    window.getByLabel('Payment happens on day (optional for manual payments)'),
  ).toHaveValue('');
  await window.getByRole('button', { name: 'Continue' }).click();
  await window.getByLabel('Global protected minimum').fill('0.00');
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'Review first forecast' })).toBeVisible();
  await expect(
    window.getByText(/Manual setup card uses a typical statement of 100.00/),
  ).toContainText('No statement-close or payment dates were inferred.');
});
