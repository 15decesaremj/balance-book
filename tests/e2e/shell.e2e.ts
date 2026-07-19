import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import axe from 'axe-core';

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
        axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string | null }> }> };
      }
    ).axe;
    const result = await axeApi.run();
    return result.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
  });
  expect(violations).toEqual([]);
};

const expectStatusMessage = async (window: Page, message: string): Promise<void> => {
  // Loading skeletons also announce through role=status. Match the intended mutation result so
  // slow IPC cannot make this assertion ambiguous while a separate panel is still hydrating.
  await expect(window.getByRole('status').filter({ hasText: message })).toBeVisible();
};

const openPrimaryPage = async (
  window: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  name: string,
): Promise<void> => {
  await window
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
};

test.beforeAll(async () => {
  if (process.env.BALANCE_BOOK_E2E_NATIVE_READY !== 'verified') {
    const pnpmCli = process.env.npm_execpath;
    if (!pnpmCli) throw new Error('pnpm executable path is unavailable');
    execFileSync(
      process.execPath,
      [pnpmCli, 'exec', 'electron-rebuild', '-f', '-w', 'better-sqlite3'],
      {
        cwd: path.resolve('.'),
        stdio: 'pipe',
      },
    );
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
  if (pnpmCli && process.env.BALANCE_BOOK_E2E_NATIVE_READY !== 'verified') {
    execFileSync(process.execPath, [pnpmCli, 'rebuild', 'better-sqlite3'], {
      cwd: path.resolve('.'),
      stdio: 'pipe',
    });
  }
});

test('completes the persistent authenticated forecast vertical slice', async () => {
  test.setTimeout(180_000);
  const window = await app.firstWindow();
  await expect(window).toHaveTitle('Balance Book');
  await expect(window.getByRole('heading', { name: 'Choose a profile' })).toBeVisible();
  await expect(window.getByText('$', { exact: false })).toHaveCount(0);

  await window.getByRole('button', { name: 'Owner' }).click();
  await expect(window.getByRole('heading', { name: 'Protect Owner' })).toBeVisible();
  await window.getByLabel('Password', { exact: true }).fill('synthetic-test-password');
  await window.getByLabel('Confirm password').fill('synthetic-test-password');
  await window.getByRole('button', { name: 'Create password' }).click();

  await expect(window.getByRole('heading', { name: 'Build your first forecast' })).toBeVisible();
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
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'Cash account' })).toBeVisible();
  await expect(window.getByLabel('Account name')).toHaveValue('');
  await expect(window.getByLabel('Opening balance')).toHaveValue('');
  await window.getByLabel('Balance as of').fill('2026-07-14');
  await window.getByLabel('Account name').fill('Primary checking');
  await window.getByLabel('Opening balance').fill('2500.00');
  await window.waitForTimeout(700);
  await window.reload();
  await expect(window.getByRole('heading', { name: 'First forecast setup' })).toBeVisible();
  await expectStatusMessage(window, 'Resumed saved setup');
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
  await window.getByRole('button', { name: 'Add statement cycle' }).click();
  await window.getByLabel('Cycle opens').fill('2026-06-08');
  await window.getByLabel('Cycle closes').fill('2026-07-07');
  await window.getByLabel('Payment due').fill('2026-07-28');
  await window.getByLabel('Cycle status').selectOption('closed-statement');
  await window.getByLabel('Typical statement estimate').fill('500.00');
  await window.getByLabel('Activity posted in this cycle').fill('0.00');
  await window.getByLabel('Planned activity').fill('0.00');
  await window.getByLabel('Locked statement balance', { exact: true }).fill('500.00');
  await window.getByRole('button', { name: 'Save statement cycle' }).click();
  await window.getByRole('button', { name: 'Add statement cycle' }).click();
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
  await window.getByRole('button', { name: 'Add statement cycle' }).last().click();
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

  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe('dark');
  await expect(
    window.getByRole('heading', { name: 'Safe to spend on each card today' }),
  ).toBeVisible();
  await expect(
    window.getByText('Each card is its own runway; do not add them together.', {
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
  await expect(everydaySummary.getByLabel('Everyday card runway lows')).toBeVisible();
  await expect(everydaySummary.getByLabel('Everyday card total position low')).toHaveText(
    /^\$[\d,]+\.\d{2}$/,
  );
  await expect(everydaySummary.getByLabel('Everyday card Primary checking account low')).toHaveText(
    /^-?\$[\d,]+\.\d{2}$/,
  );
  await expect(everydaySummary.getByText('Available spend in current cycle')).toBeVisible();
  await expect(everydaySummary.getByText('Cash-only capacity', { exact: true })).toHaveCount(0);
  await expect(everydaySummary.getByText('Funding-account low', { exact: true })).toHaveCount(0);
  await expect(window.getByText('Lowest liquid cash', { exact: true })).toHaveCount(0);
  await expect(
    window.getByRole('heading', { name: 'How each safe-spend limit is calculated' }),
  ).toHaveCount(0);
  await expect(window.getByLabel('Upcoming cash events table')).toHaveAttribute('tabindex', '0');
  await expect(
    window.getByRole('heading', { name: 'Debt, net worth, and review status' }),
  ).toBeVisible();

  // Available spend follows the selected total-position runway. The purchase advisor is the
  // stricter conservative cash/account boundary, so exercise it against the separately displayed
  // cash-only capacity instead of assuming those intentionally distinct controls are identical.
  await window.getByRole('button', { name: 'Conservative' }).click();
  await expect(window.getByText('Lowest liquid cash', { exact: true })).toBeVisible();
  const everydayFundingLow = everydaySummary
    .getByText('Funding-account low', { exact: true })
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
  const purchaseAdvisor = window
    .getByRole('heading', { name: 'Which card should I use?' })
    .locator('xpath=ancestor::section[1]');
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

  await openPrimaryPage(window, 'Cash forecast');
  await expect(window.getByRole('heading', { name: 'Daily balance ledger' })).toBeVisible();
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
  await expect(window.getByRole('heading', { name: 'Cards and revolving credit' })).toBeVisible();
  await expect(window.getByText('Latest closed statement')).toHaveCount(2);
  await expect(window.getByText('Current cycle spending recorded')).toHaveCount(2);
  await window.getByRole('button', { name: 'Edit card', exact: true }).first().click();
  await window.getByLabel('Typical future statement').fill('550.00');
  await window.getByRole('button', { name: 'Save card' }).click();
  await expectStatusMessage(window, 'Card terms updated');
  await window.getByRole('button', { name: 'Update current spending' }).first().click();
  await window.getByLabel('Typical statement estimate').fill('550.00');
  await window.getByLabel('Activity posted in this cycle').fill('125.00');
  await window.getByLabel('Planned activity').fill('25.00');
  await window.getByRole('button', { name: 'Save statement cycle' }).click();
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
  await window.screenshot({ path: 'local-screenshots/daily-driver-cards.png', fullPage: true });

  await openPrimaryPage(window, 'Charts');
  await expect(window.getByRole('heading', { name: 'Charts' })).toBeVisible();
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
  await expect(manualCard.getByText('Timing incomplete', { exact: true })).toBeVisible();
  await expect(manualCard).toContainText(
    'No dates were inferred. Add the real close and payment timing when known.',
  );

  await openPrimaryPage(window, 'Overview');
  const manualCardSafeSpend = window.getByLabel('Manual timing card available spend');
  await expect(manualCardSafeSpend).toHaveText('Unavailable');
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
  const autoLoanCard = window
    .getByRole('heading', { name: 'Synthetic auto loan' })
    .locator('xpath=ancestor::*[contains(@class, "fui-Card")][1]');
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
  await window.getByRole('button', { name: 'Duplicate' }).click();
  await window.getByRole('button', { name: 'Evaluate all active together' }).click();
  await expect(window.getByRole('heading', { name: /Result:/ })).toBeVisible();

  await window.getByRole('combobox', { name: 'Theme' }).selectOption('light');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe('light');
  await window.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe('dark');
  await expect(window.getByRole('combobox', { name: 'Theme' })).toBeEnabled();
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
  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
  await window.getByRole('combobox', { name: 'Theme' }).selectOption('light');
  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveValue('light');
  await expect(window.getByRole('combobox', { name: 'Theme' })).toBeEnabled();
  await expectNoSeriousAxeViolations(window);

  await openPrimaryPage(window, 'Setup checklist');
  await window.getByText(/^Optional expansion/).click();
  await window.getByRole('button', { name: 'Add other obligation' }).click();
  await expect(window.getByRole('heading', { name: 'Financial records' })).toBeVisible();
  const contextualPayableCreator = window.getByText('Add a financial record').locator('..');
  await expect(contextualPayableCreator).toHaveAttribute('open', '');
  await expect(window.getByLabel('Record type')).toHaveValue('forecast-event');
  await expect(window.getByLabel('Event kind')).toHaveValue('payable');
  await expect(window.getByLabel('Direction')).toHaveValue('Money leaves the account');

  await openPrimaryPage(window, 'Setup checklist');
  await window.getByRole('button', { name: 'Review cash accounts' }).click();
  await expect(window.getByRole('heading', { name: 'Financial records' })).toBeVisible();
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
  await expect(window.getByRole('heading', { name: 'Daily balance ledger' })).toBeVisible();
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
  await accountEditor.getByLabel('Account name').fill('Edited primary checking');
  await accountEditor.getByLabel('Balance', { exact: true }).fill('2600.00');
  await accountEditor.getByLabel('Hard floor (optional)').fill('400.00');
  await accountEditor.getByLabel('Preferred floor (optional)').fill('750.00');
  await accountEditor.getByLabel('Transfer delay days').fill('2');
  await accountEditor.getByRole('button', { name: 'Save account changes' }).click();
  await expect(accountEditor.getByRole('status')).toContainText('Cash account updated');
  await expect(
    window.getByRole('strong').filter({ hasText: /^Edited primary checking$/ }),
  ).toBeVisible();

  await window.getByLabel('Filter records').selectOption('forecast-event');
  await window.getByRole('button', { name: 'Edit Housing payment', exact: true }).click();
  const eventEditor = window.getByRole('form', { name: 'Cash event editor' });
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

  await openPrimaryPage(window, 'Cash forecast');
  const dayBeforeCardPurchase = window.getByRole('row').filter({ hasText: 'Jul 16, 2026' }).first();
  const cardPurchaseDay = window.getByRole('row').filter({ hasText: 'Jul 17, 2026' }).first();
  expect(displayedMoneyToCents(await cardPurchaseDay.locator('td').nth(2).innerText())).toBe(
    displayedMoneyToCents(await dayBeforeCardPurchase.locator('td').nth(2).innerText()),
  );
  await expect(cardPurchaseDay).not.toContainText('Housing on card');
  const owningCyclePaymentDay = window.getByRole('row').filter({ hasText: 'Aug 28, 2026' }).first();
  await expect(owningCyclePaymentDay).toContainText('Everyday card statement payment');
  await expect(owningCyclePaymentDay).toContainText('-$1,384.00');
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
  await window.getByText('Show advanced structured fields').click();
  await expect(window.getByLabel('Record fields JSON')).toBeVisible();
  await window.getByRole('button', { name: 'Cancel' }).click();

  await openPrimaryPage(window, 'Money owed to you');
  await expect(window.getByRole('heading', { name: 'Money owed to you' })).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Open balances' })).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Recurring future receivables' })).toBeVisible();
  await expect(
    window.getByText('Synthetic recurring reimbursement', { exact: true }),
  ).toBeVisible();
  await window.getByRole('button', { name: 'Edit open balance' }).click();
  const moneyOwedEditor = window
    .getByRole('button', { name: 'Save money-owed record' })
    .locator('xpath=ancestor::form[1]');
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
  await expect(settlementEditor.getByLabel('Event type')).toHaveValue(
    'Receivable settlement (managed in Money Owed)',
  );
  await settlementEditor.getByLabel('Event label').fill('Recorded recurring reimbursement');
  await settlementEditor.getByRole('button', { name: 'Save event changes' }).click();
  await expect(settlementEditor.getByRole('status')).toContainText('Cash event updated');

  await window.getByRole('button', { name: 'Advanced edit Housing on card' }).click();
  await window.getByText('Show advanced structured fields').click();
  const eventJson = window.getByLabel('Record fields JSON');
  const attemptedConversion = JSON.parse(await eventJson.inputValue()) as Record<string, unknown>;
  attemptedConversion.kind = 'receivable-settlement';
  await eventJson.fill(JSON.stringify(attemptedConversion, null, 2));
  await window.getByRole('button', { name: 'Save changes' }).click();
  await expect(window.getByRole('alert')).toContainText(
    'Use Money Owed to schedule or record received money',
  );
  await window.getByRole('button', { name: 'Cancel' }).click();

  await openPrimaryPage(window, 'Assets and net worth');
  await expect(window.getByRole('heading', { name: 'Net worth' })).toBeVisible();
  await expect(window.getByText('Contractual net worth', { exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Edit asset' }).click();
  await window.getByLabel('Current value').fill('5100.00');
  await window.getByRole('button', { name: 'Save asset' }).click();
  await expectStatusMessage(window, 'Asset updated');
  await expectNoSeriousAxeViolations(window);

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
  await window.getByLabel('Plan name').fill('Synthetic consolidation refinance');
  await window.getByLabel('New loan name').fill('Synthetic consolidated loan');
  await window.getByLabel('New lender (optional)').fill('Synthetic refinance lender');
  await window.getByLabel('New APR').fill('4.50');
  await window.getByLabel('Monthly debt payment (optional)').fill('');
  await window.getByLabel('New term months').fill('48');
  await window.getByLabel('Payment account').selectOption({ label: 'Edited primary checking' });
  await window.getByLabel('Total closing and lender fees').fill('300.00');
  await window.getByLabel('Fees included in the new principal').fill('200.00');
  // Principal covers lender payoffs and financed fees, then sends exactly $1,000 of cash-out to
  // the selected destination. Only the $100 unfinanced fee should leave a bank account.
  await window
    .getByLabel('New principal', { exact: true })
    .fill(centsForInput(firstPayoffCents + 120_000));
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
  await window.reload();
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
  await window.getByLabel('Plan name').fill('Synthetic stacked refinance');
  await window.getByLabel('New loan name').fill('Synthetic second replacement');
  await window.getByLabel('New APR').fill('3.75');
  await window.getByLabel('New term months').fill('48');
  await window.getByLabel('Payment account').selectOption({ label: 'Edited primary checking' });
  await window.getByLabel('Total closing and lender fees').fill('150.00');
  await window.getByLabel('Fees included in the new principal').fill('0.00');
  // This second refinance contributes $500 toward principal and pays $150 of fees, all from the
  // reserve account, proving the cash-contribution branch can stack after a cash-out refinance.
  await window
    .getByLabel('New principal', { exact: true })
    .fill(centsForInput(replacementPayoffCents - 50_000));
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
  await window.reload();
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
  await window.getByLabel('Expected modeled balance').fill('2500.00');
  await window.getByLabel('Actual balance').fill('2450.00');
  await window.getByRole('button', { name: 'Save reconciliation' }).click();
  await expectStatusMessage(window, 'does not move cash');

  await openPrimaryPage(window, 'Overview');
  const everydayBeforeFloorIncrease = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  await window.evaluate(() => {
    globalThis.location.hash = '#/settings';
  });
  await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => window.evaluate(() => globalThis.location.hash)).toBe('#/data');
  await window.evaluate(() => {
    globalThis.location.hash = '#/route-that-does-not-exist';
  });
  await expect(window.getByRole('heading', { name: 'How much can I safely spend?' })).toBeVisible();
  await expect.poll(() => window.evaluate(() => globalThis.location.hash)).toBe('#/');
  await openPrimaryPage(window, 'Settings');
  await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(window.getByText(/Balance Book \d+\.\d+\.\d+/, { exact: false })).toBeVisible();
  const effectiveGlobalMinimum = window
    .getByText('Effective global minimum', { exact: true })
    .locator('..');
  await expect(effectiveGlobalMinimum).toContainText('$500.00');
  const accountProtection = window.getByRole('form', {
    name: 'Edited primary checking protection settings',
  });
  await accountProtection.getByLabel('Account minimum').fill('900.00');
  await accountProtection.getByLabel('Preferred buffer').fill('1200.00');
  await accountProtection.getByLabel('Transfer lead time (days)').fill('3');
  await accountProtection.getByRole('button', { name: 'Save Edited primary checking' }).click();
  await expectStatusMessage(window, 'Global minimum and funding guidance were recalculated.');
  await expect(effectiveGlobalMinimum).toContainText('$900.00');
  await expect(accountProtection.getByLabel('Account minimum')).toHaveValue('900.00');
  await expect(accountProtection.getByLabel('Preferred buffer')).toHaveValue('1200.00');
  await expect(accountProtection.getByLabel('Transfer lead time (days)')).toHaveValue('3');
  await openPrimaryPage(window, 'Overview');
  const everydayAfterAccountFloorIncrease = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  expect(everydayAfterAccountFloorIncrease).toBe(everydayBeforeFloorIncrease - 40_000);
  await openPrimaryPage(window, 'Settings');

  await window.getByLabel('Consolidated minimum override').fill('1000.00');
  await window.getByLabel('Consolidated preferred override (optional)').fill('1500.00');
  await window.getByRole('button', { name: 'Save forecast guardrails' }).click();
  await expect(window.getByText('Forecast guardrails updated.', { exact: false })).toBeVisible();
  await expect(effectiveGlobalMinimum).toContainText('$1,000.00');
  await expect(effectiveGlobalMinimum).toContainText('Preferred warning $1,500.00');
  await openPrimaryPage(window, 'Overview');
  await expect(window.getByText('Global Spending Power', { exact: true })).toBeVisible();
  const everydayAfterGlobalFloorIncrease = displayedMoneyToCents(
    (await window.getByLabel('Everyday card available spend').textContent()) ?? '',
  );
  expect(everydayAfterGlobalFloorIncrease).toBe(everydayAfterAccountFloorIncrease - 10_000);
  await openPrimaryPage(window, 'Settings');
  await window.getByLabel('Forecast horizon in days').fill('120');
  await window.getByRole('button', { name: 'Save forecast guardrails' }).click();
  await expect(window.getByText('Forecast guardrails updated.', { exact: false })).toBeVisible();
  await openPrimaryPage(window, 'Overview');
  await openPrimaryPage(window, 'Baseline plan');
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
  await expect(transferEditor.getByLabel('Event type')).toHaveValue('Transfer initiation');
  await expect(transferEditor.getByLabel('Certainty')).toHaveValue('Confirmed ownership transfer');
  await transferEditor.getByLabel('Amount').fill('150.00');
  await transferEditor.getByRole('button', { name: 'Save event changes' }).click();
  await expect(transferEditor.getByRole('status')).toContainText('Cash event updated');
  await openPrimaryPage(window, 'Cash forecast');
  await expect(window.getByRole('columnheader', { name: 'In transfer' })).toBeVisible();
  const transferDay = window.getByRole('row').filter({ hasText: 'Sep 1, 2026' }).first();
  await expect(transferDay.locator('td').nth(3)).toHaveText('$150.00');
  await openPrimaryPage(window, 'Settings');
  await window.setViewportSize({ width: 430, height: 900 });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth))
    .toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(window);
  await window.setViewportSize({ width: 1440, height: 1000 });
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
  await expect(window.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
  await openPrimaryPage(window, 'Overview');
  await expect(window.getByRole('heading', { name: 'Build your first forecast' })).toBeVisible();
  await window.getByRole('button', { name: 'Start guided setup' }).click();
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
