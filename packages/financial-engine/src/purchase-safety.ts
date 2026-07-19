import {
  compareDates,
  moneyCentsSchema,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import type { ForecastResult, TransferNeed } from './forecast';

export interface ReceivableFundingCoverage {
  receivableOutstandingCents: MoneyCents;
  receivableReleaseNeededCents: MoneyCents;
  uncoveredAfterReceivablesCents: MoneyCents;
  deepestReceivableOutstandingCents: MoneyCents;
  deepestReceivableReleaseNeededCents: MoneyCents;
  deepestUncoveredAfterReceivablesCents: MoneyCents;
}

export interface ReceivableFundingMilestone {
  date: PlainDateString;
  requiredCents: MoneyCents;
}

type ReceivableFundingNeed = Pick<
  TransferNeed,
  'date' | 'shortfallCents' | 'horizonDeepestShortfallDate' | 'horizonDeepestShortfallCents'
> & {
  /**
   * Optional cumulative requirements between the first and deepest low. Supplying every new
   * account-low record lets the allocator reserve receivables in true date order when accounts'
   * shortfalls interleave.
   */
  fundingMilestones?: ReceivableFundingMilestone[];
};

export const assessReceivableFundingCoverage = (input: {
  need: Pick<
    TransferNeed,
    'date' | 'shortfallCents' | 'horizonDeepestShortfallDate' | 'horizonDeepestShortfallCents'
  >;
  receivableDays: Array<{ date: PlainDateString; endingOutstandingCents: MoneyCents }>;
}): ReceivableFundingCoverage => {
  const receivableByDate = new Map(
    input.receivableDays.map((day) => [day.date, day.endingOutstandingCents]),
  );
  const receivableOutstandingCents = moneyCentsSchema.parse(
    receivableByDate.get(input.need.date) ?? 0,
  );
  const deepestReceivableOutstandingCents = moneyCentsSchema.parse(
    receivableByDate.get(input.need.horizonDeepestShortfallDate) ?? 0,
  );
  const receivableReleaseNeededCents = moneyCentsSchema.parse(
    Math.min(input.need.shortfallCents, receivableOutstandingCents),
  );
  const deepestReceivableReleaseNeededCents = moneyCentsSchema.parse(
    Math.min(input.need.horizonDeepestShortfallCents, deepestReceivableOutstandingCents),
  );
  return {
    receivableOutstandingCents,
    receivableReleaseNeededCents,
    uncoveredAfterReceivablesCents: moneyCentsSchema.parse(
      input.need.shortfallCents - receivableReleaseNeededCents,
    ),
    deepestReceivableOutstandingCents,
    deepestReceivableReleaseNeededCents,
    deepestUncoveredAfterReceivablesCents: moneyCentsSchema.parse(
      input.need.horizonDeepestShortfallCents - deepestReceivableReleaseNeededCents,
    ),
  };
};

/**
 * Allocates projected Money Owed across funding actions in need-by order. This prevents two
 * account warnings from promising the same future receivable dollars. Each action's deepest-run
 * amount is a total requirement, so only the increment beyond its first release is reserved on
 * the later date.
 */
export const assessReceivableFundingCoverageSequence = (input: {
  needs: ReceivableFundingNeed[];
  receivableDays: Array<{ date: PlainDateString; endingOutstandingCents: MoneyCents }>;
}): ReceivableFundingCoverage[] => {
  const receivableByDate = new Map(
    input.receivableDays.map((day) => [day.date, day.endingOutstandingCents]),
  );
  const reservations: Array<{ date: PlainDateString; amountCents: MoneyCents }> = [];
  const results: ReceivableFundingCoverage[] = input.needs.map(() => ({
    receivableOutstandingCents: 0,
    receivableReleaseNeededCents: 0,
    uncoveredAfterReceivablesCents: 0,
    deepestReceivableOutstandingCents: 0,
    deepestReceivableReleaseNeededCents: 0,
    deepestUncoveredAfterReceivablesCents: 0,
  }));
  const allocatedByNeed: MoneyCents[] = input.needs.map(() => 0);
  const milestones = input.needs
    .flatMap((need, needIndex) => {
      const cumulativeMilestones =
        need.fundingMilestones && need.fundingMilestones.length > 0
          ? [...need.fundingMilestones]
          : [
              { date: need.date, requiredCents: need.shortfallCents },
              {
                date: need.horizonDeepestShortfallDate,
                requiredCents: need.horizonDeepestShortfallCents,
              },
            ];
      const ordered = cumulativeMilestones.sort(
        (left, right) =>
          compareDates(left.date, right.date) || left.requiredCents - right.requiredCents,
      );
      let priorRequirementCents: MoneyCents = 0;
      const increasingMilestones = ordered.flatMap((milestone) => {
        const requiredCents = moneyCentsSchema.parse(milestone.requiredCents);
        if (requiredCents <= priorRequirementCents) return [];
        const incrementalNeedCents = moneyCentsSchema.parse(requiredCents - priorRequirementCents);
        priorRequirementCents = requiredCents;
        return [{ date: milestone.date, incrementalNeedCents, requiredCents }];
      });
      return increasingMilestones.map((milestone, milestoneIndex) => ({
        ...milestone,
        needIndex,
        milestoneIndex,
        isFirst: milestoneIndex === 0,
        isDeepest: milestoneIndex === increasingMilestones.length - 1,
      }));
    })
    .sort(
      (left, right) =>
        compareDates(left.date, right.date) ||
        left.needIndex - right.needIndex ||
        left.milestoneIndex - right.milestoneIndex,
    );

  for (const milestone of milestones) {
    const need = input.needs[milestone.needIndex]!;
    const result = results[milestone.needIndex]!;
    const alreadyReservedCents = reservations.reduce(
      (total, reservation) =>
        compareDates(reservation.date, milestone.date) <= 0
          ? total + reservation.amountCents
          : total,
      0,
    );
    const availableCents = moneyCentsSchema.parse(
      Math.max(0, (receivableByDate.get(milestone.date) ?? 0) - alreadyReservedCents),
    );
    const allocatedCents = moneyCentsSchema.parse(
      Math.min(milestone.incrementalNeedCents, availableCents),
    );
    if (allocatedCents > 0) {
      reservations.push({ date: milestone.date, amountCents: allocatedCents });
      allocatedByNeed[milestone.needIndex] = moneyCentsSchema.parse(
        allocatedByNeed[milestone.needIndex]! + allocatedCents,
      );
    }

    if (milestone.isFirst) {
      result.receivableOutstandingCents = availableCents;
      result.receivableReleaseNeededCents = allocatedCents;
      result.uncoveredAfterReceivablesCents = moneyCentsSchema.parse(
        need.shortfallCents - allocatedCents,
      );
    }

    if (milestone.isDeepest) {
      result.deepestReceivableOutstandingCents = moneyCentsSchema.parse(
        allocatedByNeed[milestone.needIndex]! + availableCents - allocatedCents,
      );
      result.deepestReceivableReleaseNeededCents = moneyCentsSchema.parse(
        allocatedByNeed[milestone.needIndex]!,
      );
      result.deepestUncoveredAfterReceivablesCents = moneyCentsSchema.parse(
        milestone.requiredCents - allocatedByNeed[milestone.needIndex]!,
      );
    }
  }
  return results;
};

export interface PurchaseSafetyAssessment {
  safe: boolean;
  totalPositionLowCents: MoneyCents;
  totalPositionLowDate: PlainDateString;
  totalPositionMarginCents: MoneyCents;
  fundingAccountLowCents: MoneyCents;
  fundingAccountLowDate: PlainDateString;
  fundingAccountFloorCents: MoneyCents;
  fundingAccountShortfallCents: MoneyCents;
  receivableOutstandingCents: MoneyCents;
  receivableReleaseNeededCents: MoneyCents;
  uncoveredFundingShortfallCents: MoneyCents;
}

/**
 * Evaluates a purchase from the date cash actually leaves onward. Money owed remains a separate
 * non-cash asset: it contributes to total position, and only the explicitly reported release amount
 * can cure the selected funding account's low. This deliberately avoids using today's global
 * safe-to-deploy value, which can be zero because of an earlier, unrelated account breach.
 */
export const assessPurchaseSafety = (input: {
  forecast: ForecastResult;
  cashLeavesOn: PlainDateString;
  fundingAccountId: string;
  fundingAccountFloorCents: MoneyCents;
  protectedTotalFloorCents: MoneyCents;
  receivableDays: Array<{ date: PlainDateString; endingOutstandingCents: MoneyCents }>;
  /**
   * All account funding needs in this forecast. When supplied, projected Money Owed is allocated
   * across every account in chronological order before the selected account is called fundable.
   */
  fundingNeeds?: Array<
    Pick<
      TransferNeed,
      | 'accountId'
      | 'date'
      | 'floorCents'
      | 'shortfallCents'
      | 'horizonDeepestShortfallDate'
      | 'horizonDeepestShortfallCents'
    >
  >;
  /**
   * Cash purchases must leave the selected account fundable. Card guidance is different: a card
   * remains usable when the protected total position holds, while any account-funding action is
   * reported separately for the later payment date.
   */
  enforceFundingAccountFloor?: boolean;
}): PurchaseSafetyAssessment => {
  const days = input.forecast.days.filter((day) => compareDates(day.date, input.cashLeavesOn) >= 0);
  if (days.length === 0) throw new Error('Purchase payment date is outside the forecast horizon');
  const receivableByDate = new Map(
    input.receivableDays.map((day) => [day.date, day.endingOutstandingCents]),
  );
  const totalPositionLow = days.reduce(
    (lowest, day) => {
      const candidateCents = moneyCentsSchema.parse(
        day.consolidatedCashCents + (receivableByDate.get(day.date) ?? 0),
      );
      return candidateCents < lowest.cents ? { day, cents: candidateCents } : lowest;
    },
    {
      day: days[0]!,
      cents: moneyCentsSchema.parse(
        days[0]!.consolidatedCashCents + (receivableByDate.get(days[0]!.date) ?? 0),
      ),
    },
  );
  const fundingAccountLow = days.reduce(
    (lowest, day) => {
      const candidate = day.accounts.find(
        (account) => account.accountId === input.fundingAccountId,
      );
      if (!candidate) throw new Error('Funding account is missing from the purchase forecast');
      return candidate.endingBalanceCents < lowest.cents
        ? { date: day.date, cents: candidate.endingBalanceCents }
        : lowest;
    },
    (() => {
      const first = days[0]!.accounts.find(
        (account) => account.accountId === input.fundingAccountId,
      );
      if (!first) throw new Error('Funding account is missing from the purchase forecast');
      return { date: days[0]!.date, cents: first.endingBalanceCents };
    })(),
  );
  const fundingAccountShortfallCents = moneyCentsSchema.parse(
    Math.max(0, input.fundingAccountFloorCents - fundingAccountLow.cents),
  );
  let receivableOutstandingCents = moneyCentsSchema.parse(
    receivableByDate.get(fundingAccountLow.date) ?? 0,
  );
  let receivableReleaseNeededCents = moneyCentsSchema.parse(
    Math.min(fundingAccountShortfallCents, receivableOutstandingCents),
  );
  let uncoveredFundingShortfallCents = moneyCentsSchema.parse(
    fundingAccountShortfallCents - receivableReleaseNeededCents,
  );
  if (input.fundingNeeds) {
    const sequencedNeeds = input.fundingNeeds.map((need) => {
      let deepestRequiredCents: MoneyCents = 0;
      const fundingMilestones = input.forecast.days.flatMap((day) => {
        const account = day.accounts.find((candidate) => candidate.accountId === need.accountId);
        if (!account) throw new Error('Funding account is missing from the purchase forecast');
        const requiredCents = moneyCentsSchema.parse(
          Math.max(0, need.floorCents - account.endingBalanceCents),
        );
        if (requiredCents <= deepestRequiredCents) return [];
        deepestRequiredCents = requiredCents;
        return [{ date: day.date, requiredCents }];
      });
      return { ...need, fundingMilestones };
    });
    const selectedNeedIndex = sequencedNeeds.findIndex(
      (need) => need.accountId === input.fundingAccountId,
    );
    if (selectedNeedIndex >= 0) {
      const selectedCoverage = assessReceivableFundingCoverageSequence({
        needs: sequencedNeeds,
        receivableDays: input.receivableDays,
      })[selectedNeedIndex]!;
      receivableOutstandingCents = selectedCoverage.deepestReceivableOutstandingCents;
      receivableReleaseNeededCents = moneyCentsSchema.parse(
        Math.min(
          fundingAccountShortfallCents,
          selectedCoverage.deepestReceivableReleaseNeededCents,
        ),
      );
      uncoveredFundingShortfallCents = moneyCentsSchema.parse(
        fundingAccountShortfallCents - receivableReleaseNeededCents,
      );
    }
  }
  const totalPositionMarginCents = moneyCentsSchema.parse(
    totalPositionLow.cents - input.protectedTotalFloorCents,
  );

  return {
    safe:
      totalPositionMarginCents >= 0 &&
      (input.enforceFundingAccountFloor === false || uncoveredFundingShortfallCents === 0),
    totalPositionLowCents: totalPositionLow.cents,
    totalPositionLowDate: totalPositionLow.day.date,
    totalPositionMarginCents,
    fundingAccountLowCents: fundingAccountLow.cents,
    fundingAccountLowDate: fundingAccountLow.date,
    fundingAccountFloorCents: input.fundingAccountFloorCents,
    fundingAccountShortfallCents,
    receivableOutstandingCents,
    receivableReleaseNeededCents,
    uncoveredFundingShortfallCents,
  };
};
