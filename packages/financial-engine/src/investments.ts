import Decimal from 'decimal.js';
import {
  compareDates,
  daysBetween,
  moneyCentsSchema,
  plainDateSchema,
  type Asset,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';

const DAYS_PER_YEAR = new Decimal(365);
const MONTHS_PER_YEAR = new Decimal(12);

/**
 * Projects one investment from its dated valuation without creating cash-ledger activity.
 *
 * Contribution rates use the investment's explicit annual gross-income assumption. The optional
 * fixed amount is monthly. Both employee contributions and employer match increase the investment
 * while leaving cash unchanged because modeled paychecks are take-home deposits.
 */
export const projectInvestmentValueAtDate = (
  assetInput: Asset,
  dateInput: PlainDateString,
): MoneyCents => {
  const asset = assetInput;
  const date = plainDateSchema.parse(dateInput);
  if (asset.type !== 'investment' || compareDates(date, asset.valuationDate) <= 0) {
    return asset.valueCents;
  }

  const elapsedDays = daysBetween(asset.valuationDate, date);
  const annualRate = new Decimal(asset.annualGrowthRateBasisPoints ?? 0).div(10_000);
  const grossIncome = new Decimal(asset.contributionGrossAnnualIncomeCents ?? 0);
  const employeeRate = new Decimal(asset.contributionRateBasisPoints ?? 0).div(10_000);
  const employerRate = new Decimal(asset.employerMatchBasisPoints ?? 0).div(10_000);
  const annualContribution = grossIncome
    .mul(employeeRate.add(employerRate))
    .add(new Decimal(asset.contributionAmountCents ?? 0).mul(MONTHS_PER_YEAR));
  const dailyContribution = annualContribution.div(DAYS_PER_YEAR);
  const dailyGrowthFactor = annualRate.add(1).pow(new Decimal(1).div(DAYS_PER_YEAR));
  const growthFactor = dailyGrowthFactor.pow(elapsedDays);
  const contributionGrowth = dailyGrowthFactor.equals(1)
    ? dailyContribution.mul(elapsedDays)
    : dailyContribution.mul(growthFactor.sub(1)).div(dailyGrowthFactor.sub(1));

  return moneyCentsSchema.parse(
    new Decimal(asset.valueCents)
      .mul(growthFactor)
      .add(contributionGrowth)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber(),
  );
};

export const projectAssetsAtDate = (assets: readonly Asset[], date: PlainDateString): Asset[] =>
  assets.map((asset) => ({
    ...asset,
    valueCents: projectInvestmentValueAtDate(asset, date),
  }));
