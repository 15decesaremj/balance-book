import { describe, expect, it } from 'vitest';
import {
  scenarioResponseSchema,
  type ScenarioResponseDto,
} from '../apps/desktop/src/shared/contracts';
import {
  advisorReason,
  advisorResultIsFundable,
  advisorResultIsIncomeDependent,
  advisorResultIsSafe,
  advisorResultStatus,
  advisorStatusLabel,
  advisorVerdictLabel,
  cardSpendingPowerUnavailableReason,
  rankAdvisorResults,
  type CardAdvisorResult,
  type DashboardCardPower,
} from '../apps/desktop/src/renderer/dashboard-insights';
import { formatMoney } from '../apps/desktop/src/renderer/utils';

const card = (cardName: string): DashboardCardPower => ({
  cardId: `card-${cardName.toLowerCase().replaceAll(' ', '-')}`,
  cardName,
  fundingAccountId: 'checking',
  fundingAccountName: 'Checking',
  statementAmountCents: 40_000,
  currentCycleAmountCents: 25_000,
  purchaseAdvisorEligible: true,
  spendingPowerCents: 50_000,
  cashBackedCapacityCents: 50_000,
  spendingPowerStatus: 'determinate',
  prePaymentShortfallCents: 0,
  baselineEstimateSlackCents: 15_000,
  futurePositionLowCents: 100_000,
  futurePositionLowDate: '2026-09-20',
  futurePositionLowCashCents: 90_000,
  futurePositionLowReceivableCents: 10_000,
  futurePositionLowAccountBalances: [
    { accountId: 'checking', accountName: 'Checking', endingBalanceCents: 90_000 },
  ],
  futureAccountLows: [
    {
      accountId: 'checking',
      accountName: 'Checking',
      endingBalanceCents: 70_000,
      date: '2026-09-20',
    },
  ],
  futureCashLowCents: 90_000,
  futureCashLowDate: '2026-09-20',
  fundingAccountLowCents: 70_000,
  fundingAccountLowDate: '2026-09-20',
});

const scenario = (overrides: Partial<ScenarioResponseDto> = {}): ScenarioResponseDto =>
  scenarioResponseSchema.parse({
    verdict: 'affordable-under-current-assumptions',
    settlementDate: '2026-09-15',
    beforeTroughCents: 150_000,
    afterTroughCents: 125_000,
    afterHardFloorMarginCents: 75_000,
    afterAvailableToDeployCents: 75_000,
    accountShortfallCount: 0,
    transferNeeds: [],
    fundingAccountName: 'Checking',
    ...overrides,
  });

const result = (
  cardName: string,
  scenarioOverrides: Partial<ScenarioResponseDto> = {},
  rewardRateBasisPoints?: number,
): CardAdvisorResult => ({
  card: card(cardName),
  scenario: scenario(scenarioOverrides),
  rewardRateBasisPoints,
});

const completeTransfer = {
  accountId: 'checking',
  accountName: 'Checking',
  sourceAccountId: 'savings',
  sourceAccountName: 'Savings',
  date: '2026-09-15' as const,
  shortfallCents: 20_000,
  initiationDate: '2026-09-12' as const,
  arrivalDate: '2026-09-14' as const,
};

describe('dashboard card-advisor status semantics', () => {
  it('classifies unconditional, transfer-required, income-dependent, and unsafe results distinctly', () => {
    const safe = result('Safe');
    const fundable = result('Fundable', {
      verdict: 'underfunded-account',
      accountShortfallCount: 1,
      transferNeeds: [completeTransfer],
    });
    const incomeDependent = result('Income dependent', {
      verdict: 'dependent-on-expected-income',
    });
    const unsafe = result('Unsafe', {
      verdict: 'breaches-protected-floor',
      afterHardFloorMarginCents: -1,
    });

    expect(advisorResultStatus(safe)).toBe('safe');
    expect(advisorResultStatus(fundable)).toBe('transfer-required');
    expect(advisorResultStatus(incomeDependent)).toBe('income-dependent');
    expect(advisorResultStatus(unsafe)).toBe('unsafe');

    expect(advisorResultIsSafe(safe)).toBe(true);
    expect(advisorResultIsFundable(fundable)).toBe(true);
    expect(advisorResultIsIncomeDependent(incomeDependent)).toBe(true);
    expect(advisorResultIsSafe(incomeDependent)).toBe(false);
    expect(advisorResultIsFundable(incomeDependent)).toBe(false);
  });

  it('requires a complete transfer plan and never lets one override a protected-floor breach', () => {
    const missingArrival = result('Missing arrival', {
      verdict: 'underfunded-account',
      accountShortfallCount: 1,
      transferNeeds: [{ ...completeTransfer, arrivalDate: undefined }],
    });
    const breachedWithTransfer = result('Breached', {
      verdict: 'breaches-protected-floor',
      afterHardFloorMarginCents: -10_000,
      accountShortfallCount: 1,
      transferNeeds: [completeTransfer],
    });

    expect(advisorResultStatus(missingArrival)).toBe('unsafe');
    expect(advisorResultIsFundable(missingArrival)).toBe(false);
    expect(advisorResultStatus(breachedWithTransfer)).toBe('unsafe');
    expect(advisorResultIsFundable(breachedWithTransfer)).toBe(false);
  });

  it('provides exact status and verdict labels without calling an income-dependent result safe', () => {
    expect(advisorStatusLabel).toEqual({
      safe: 'Can use',
      'transfer-required': 'Can use after transfer',
      'income-dependent': 'Conditional on expected income',
      unsafe: 'Needs a plan change',
    });
    expect(advisorVerdictLabel['dependent-on-expected-income']).toBe('Depends on expected income');
  });

  it('uses payment-date purchase safety instead of an unrelated earlier global shortfall', () => {
    const scopedSafe = result('Scoped safe', {
      verdict: 'underfunded-account',
      accountShortfallCount: 1,
      afterHardFloorMarginCents: -5_000,
      purchaseSafety: {
        safe: true,
        totalPositionLowCents: 125_000,
        totalPositionLowDate: '2026-09-20',
        totalPositionMarginCents: 25_000,
        fundingAccountLowCents: -5_000,
        fundingAccountLowDate: '2026-09-15',
        fundingAccountFloorCents: 0,
        fundingAccountShortfallCents: 5_000,
        receivableOutstandingCents: 3_000,
        receivableReleaseNeededCents: 3_000,
        uncoveredFundingShortfallCents: 2_000,
      },
    });
    expect(advisorResultStatus(scopedSafe)).toBe('safe');
    expect(advisorReason(scopedSafe)).toContain('You can use it');
    expect(advisorReason(scopedSafe)).toContain(formatMoney(5_000));
    expect(advisorReason(scopedSafe)).toContain(formatMoney(2_000));
  });
});

describe('dashboard card-advisor ranking', () => {
  it('ranks protected safety before a transfer, a transfer before expected income, and expected income before unsafe options', () => {
    const input = [
      result('Unsafe', {
        verdict: 'breaches-protected-floor',
        afterHardFloorMarginCents: -5_000,
      }),
      result('Expected income', { verdict: 'dependent-on-expected-income' }),
      result('Transfer', {
        verdict: 'underfunded-account',
        accountShortfallCount: 1,
        transferNeeds: [completeTransfer],
      }),
      result('Protected safe'),
    ];

    expect(rankAdvisorResults(input).map((item) => item.card.cardName)).toEqual([
      'Protected safe',
      'Transfer',
      'Expected income',
      'Unsafe',
    ]);
    expect(input.map((item) => item.card.cardName)).toEqual([
      'Unsafe',
      'Expected income',
      'Transfer',
      'Protected safe',
    ]);
  });

  it('uses floor margin, later settlement, rewards, and card name as deterministic tie-breakers', () => {
    const lowerMargin = result('Lower margin', { afterHardFloorMarginCents: 10_000 });
    const higherMargin = result('Higher margin', { afterHardFloorMarginCents: 20_000 });
    expect(rankAdvisorResults([lowerMargin, higherMargin])[0]?.card.cardName).toBe('Higher margin');

    const earlier = result('Earlier', { settlementDate: '2026-09-10' });
    const later = result('Later', { settlementDate: '2026-09-20' });
    expect(rankAdvisorResults([earlier, later])[0]?.card.cardName).toBe('Later');

    const lowerReward = result('Lower rewards', {}, 100);
    const higherReward = result('Higher rewards', {}, 300);
    expect(rankAdvisorResults([lowerReward, higherReward])[0]?.card.cardName).toBe(
      'Higher rewards',
    );

    const zeta = result('Zeta');
    const alpha = result('Alpha');
    expect(rankAdvisorResults([zeta, alpha])[0]?.card.cardName).toBe('Alpha');
  });
});

describe('dashboard card-advisor explanations', () => {
  it('explains each verdict exactly and makes expected-income dependence explicit', () => {
    expect(advisorReason(result('Safe', { afterHardFloorMarginCents: 25_000 }))).toBe(
      `It keeps every modeled account funded and leaves ${formatMoney(25_000)} above the protected cash floor.`,
    );
    expect(
      advisorReason(
        result('Preferred buffer', {
          verdict: 'above-hard-floor-below-preferred-buffer',
          afterHardFloorMarginCents: 10_000,
        }),
      ),
    ).toBe(
      `It remains ${formatMoney(10_000)} above the protected floor, but uses part of the preferred comfort buffer.`,
    );
    expect(
      advisorReason(result('Expected income', { verdict: 'dependent-on-expected-income' })),
    ).toBe(
      'This is conditional, not an unconditional safe-spend result: it depends on expected income arriving as modeled.',
    );
    expect(
      advisorReason(
        result('Transfer', {
          verdict: 'underfunded-account',
          accountShortfallCount: 1,
          transferNeeds: [completeTransfer],
        }),
      ),
    ).toBe(
      'The consolidated floor holds and every account shortfall has a safe transfer source and arrival date.',
    );
    expect(
      advisorReason(
        result('Underfunded', {
          verdict: 'underfunded-account',
          accountShortfallCount: 2,
        }),
      ),
    ).toBe(
      'The consolidated floor holds, but 2 accounts would be underfunded without a safe transfer source.',
    );
    expect(
      advisorReason(
        result('Breach', {
          verdict: 'breaches-protected-floor',
          afterHardFloorMarginCents: -5_000,
        }),
      ),
    ).toBe(
      `It leaves a ${formatMoney(-5_000)} protected-floor margin, so the purchase needs a plan change before it is safe.`,
    );
  });
});

describe('dashboard card spending-power unavailable explanations', () => {
  it.each([
    ['determinate', null],
    [
      'indeterminate-overdue-payment-timing',
      'A known statement is past due without a future payment date. Its balance remains visible, but safe spending is unavailable until you record when it will be paid or mark it paid.',
    ],
    [
      'indeterminate-payment-policy',
      'This card is not set to pay the full statement, so its future cash timing and total-position runway need an explicit paydown plan.',
    ],
    [
      'indeterminate-payment-outside-horizon',
      'This cycle pays after the current forecast horizon. Extend the horizon to calculate its total-position runway.',
    ],
    [
      'indeterminate-account-balances',
      "The forecast is missing a required funding-account balance on or after this cycle's payment date.",
    ],
  ] as const)('maps %s to its exact explanation', (spendingPowerStatus, expected) => {
    expect(cardSpendingPowerUnavailableReason({ spendingPowerStatus })).toBe(expected);
  });
});
