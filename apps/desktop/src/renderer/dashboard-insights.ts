import type { ForecastSnapshotDto, ScenarioResponseDto } from '../shared/contracts';
import { formatMoney, formatPlainDate } from './utils';

export type DashboardCardPower = NonNullable<ForecastSnapshotDto['cardSpendingPower']>[number];

export type CardAdvisorResult = {
  card: DashboardCardPower;
  scenario: ScenarioResponseDto;
  rewardRateBasisPoints?: number;
  rewardType?: DashboardCardPower['rewardType'];
  estimatedRewardCents?: number;
};

export type AdvisorResultStatus = 'safe' | 'transfer-required' | 'income-dependent' | 'unsafe';

export const advisorVerdictLabel: Record<ScenarioResponseDto['verdict'], string> = {
  'affordable-under-current-assumptions': 'Within current guardrails',
  'above-hard-floor-below-preferred-buffer': 'Above hard floor, below preferred buffer',
  'dependent-on-expected-income': 'Depends on expected income',
  'underfunded-account': 'Funding account shortfall',
  'breaches-protected-floor': 'Breaches protected floor',
};

export const advisorStatusLabel: Record<AdvisorResultStatus, string> = {
  safe: 'Can use',
  'transfer-required': 'Can use after transfer',
  'income-dependent': 'Conditional on expected income',
  unsafe: 'Needs a plan change',
};

const advisorVerdictRank: Record<ScenarioResponseDto['verdict'], number> = {
  'affordable-under-current-assumptions': 0,
  'above-hard-floor-below-preferred-buffer': 1,
  'dependent-on-expected-income': 2,
  'underfunded-account': 3,
  'breaches-protected-floor': 4,
};

const hasCompleteTransferPlan = (result: CardAdvisorResult): boolean =>
  result.scenario.transferNeeds.length > 0 &&
  result.scenario.transferNeeds.every((need) =>
    Boolean(need.sourceAccountId && need.initiationDate && need.arrivalDate),
  );

export const advisorResultStatus = (result: CardAdvisorResult): AdvisorResultStatus => {
  const { scenario } = result;
  if (scenario.purchaseSafety) return scenario.purchaseSafety.safe ? 'safe' : 'unsafe';
  if (scenario.afterHardFloorMarginCents < 0 || scenario.verdict === 'breaches-protected-floor') {
    return 'unsafe';
  }

  if (scenario.accountShortfallCount > 0 || scenario.verdict === 'underfunded-account') {
    return hasCompleteTransferPlan(result) ? 'transfer-required' : 'unsafe';
  }

  if (scenario.verdict === 'dependent-on-expected-income') return 'income-dependent';
  return 'safe';
};

export const advisorResultIsSafe = (result: CardAdvisorResult): boolean =>
  advisorResultStatus(result) === 'safe';

export const advisorResultIsFundable = (result: CardAdvisorResult): boolean =>
  advisorResultStatus(result) === 'transfer-required';

export const advisorResultIsIncomeDependent = (result: CardAdvisorResult): boolean =>
  advisorResultStatus(result) === 'income-dependent';

const advisorSafetyTier: Record<AdvisorResultStatus, number> = {
  safe: 0,
  'transfer-required': 1,
  'income-dependent': 2,
  unsafe: 3,
};

export const rankAdvisorResults = (results: CardAdvisorResult[]): CardAdvisorResult[] =>
  [...results].sort((left, right) => {
    const safetyDifference =
      advisorSafetyTier[advisorResultStatus(left)] - advisorSafetyTier[advisorResultStatus(right)];
    if (safetyDifference !== 0) return safetyDifference;
    if (left.scenario.purchaseSafety && right.scenario.purchaseSafety) {
      const scopedMarginDifference =
        right.scenario.purchaseSafety.totalPositionMarginCents -
        left.scenario.purchaseSafety.totalPositionMarginCents;
      if (scopedMarginDifference !== 0) return scopedMarginDifference;
      const releaseDifference =
        left.scenario.purchaseSafety.receivableReleaseNeededCents -
        right.scenario.purchaseSafety.receivableReleaseNeededCents;
      if (releaseDifference !== 0) return releaseDifference;
    }
    const verdictDifference =
      advisorVerdictRank[left.scenario.verdict] - advisorVerdictRank[right.scenario.verdict];
    if (verdictDifference !== 0) return verdictDifference;
    const fundingDifference =
      Number(left.scenario.accountShortfallCount > 0) -
      Number(right.scenario.accountShortfallCount > 0);
    if (fundingDifference !== 0) return fundingDifference;
    const marginDifference =
      right.scenario.afterHardFloorMarginCents - left.scenario.afterHardFloorMarginCents;
    if (marginDifference !== 0) return marginDifference;
    const settlementDifference = right.scenario.settlementDate.localeCompare(
      left.scenario.settlementDate,
    );
    if (settlementDifference !== 0) return settlementDifference;
    const rewardDifference =
      (right.rewardRateBasisPoints ?? -1) - (left.rewardRateBasisPoints ?? -1);
    if (rewardDifference !== 0) return rewardDifference;
    return left.card.cardName.localeCompare(right.card.cardName);
  });

export const advisorReason = (result: CardAdvisorResult): string => {
  const scoped = result.scenario.purchaseSafety;
  if (scoped) {
    if (scoped.safe && scoped.fundingAccountShortfallCents > 0) {
      const releasePart =
        scoped.receivableReleaseNeededCents > 0
          ? `release ${formatMoney(scoped.receivableReleaseNeededCents)} of Money Owed`
          : '';
      const transferPart =
        scoped.uncoveredFundingShortfallCents > 0
          ? `move the remaining ${formatMoney(scoped.uncoveredFundingShortfallCents)} from another included cash account`
          : '';
      const fundingAction = [releasePart, transferPart].filter(Boolean).join(' and ');
      return `You can use it because total position stays ${formatMoney(scoped.totalPositionMarginCents)} above its threshold. By ${formatPlainDate(scoped.fundingAccountLowDate)}, ${result.scenario.fundingAccountName} needs ${formatMoney(scoped.fundingAccountShortfallCents)} of funding${fundingAction ? `: ${fundingAction}` : ''}.`;
    }
    if (scoped.safe) {
      return `You can use it. Total position stays ${formatMoney(scoped.totalPositionMarginCents)} above its threshold and ${result.scenario.fundingAccountName} stays above its account minimum.`;
    }
    if (scoped.totalPositionMarginCents < 0) {
      return `Do not use it for this purchase: total position would fall ${formatMoney(Math.abs(scoped.totalPositionMarginCents))} below its threshold on ${formatPlainDate(scoped.totalPositionLowDate)}.`;
    }
    return `Do not use it without another funding action: after applying ${formatMoney(scoped.receivableReleaseNeededCents)} of projected money owed, ${result.scenario.fundingAccountName} is still ${formatMoney(scoped.uncoveredFundingShortfallCents)} short on ${formatPlainDate(scoped.fundingAccountLowDate)}.`;
  }
  const margin = formatMoney(result.scenario.afterHardFloorMarginCents);
  switch (result.scenario.verdict) {
    case 'affordable-under-current-assumptions':
      return `It keeps every modeled account funded and leaves ${margin} above the protected cash floor.`;
    case 'above-hard-floor-below-preferred-buffer':
      return `It remains ${margin} above the protected floor, but uses part of the preferred comfort buffer.`;
    case 'dependent-on-expected-income':
      return 'This is conditional, not an unconditional safe-spend result: it depends on expected income arriving as modeled.';
    case 'underfunded-account':
      return advisorResultIsFundable(result)
        ? 'The consolidated floor holds and every account shortfall has a safe transfer source and arrival date.'
        : `The consolidated floor holds, but ${result.scenario.accountShortfallCount} account${result.scenario.accountShortfallCount === 1 ? '' : 's'} would be underfunded without a safe transfer source.`;
    case 'breaches-protected-floor':
      return `It leaves a ${margin} protected-floor margin, so the purchase needs a plan change before it is safe.`;
  }
};

export const cardSpendingPowerUnavailableReason = (
  card: Pick<DashboardCardPower, 'spendingPowerStatus'>,
): string | null => {
  switch (card.spendingPowerStatus) {
    case 'determinate':
    case 'conditional-existing-shortfall':
      return null;
    case 'indeterminate-cycle-timing':
      return 'Statement timing is incomplete, so the app will not invent a total-position runway or payment date. Add a current cycle and its real dates to finish setup.';
    case 'indeterminate-overdue-payment-timing':
      return 'A known statement is past due without a future payment date. Its balance remains visible, but safe spending is unavailable until you record when it will be paid or mark it paid.';
    case 'indeterminate-payment-policy':
      return 'This card is not set to pay the full statement, so its future cash timing and total-position runway need an explicit paydown plan.';
    case 'indeterminate-payment-outside-horizon':
      return 'This cycle pays after the current forecast horizon. Extend the horizon to calculate its total-position runway.';
    case 'indeterminate-account-balances':
      return "The forecast is missing a required funding-account balance on or after this cycle's payment date.";
  }
};
