import { describe, expect, it } from 'vitest';
import type { Asset } from '@balance-book/domain';
import { projectAssetsAtDate, projectInvestmentValueAtDate } from '@balance-book/financial-engine';

const investment = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'synthetic-investment',
  userId: 'synthetic-profile',
  name: 'Synthetic retirement plan',
  type: 'investment',
  valueCents: 10_000_000,
  valuationDate: '2026-01-01',
  includedInNetWorth: true,
  includedInLiquidity: false,
  ...overrides,
});

describe('investment forecast assumptions', () => {
  it('compounds an annual growth assumption over one year using decimal rate math', () => {
    expect(
      projectInvestmentValueAtDate(
        investment({ annualGrowthRateBasisPoints: 1_000 }),
        '2027-01-01',
      ),
    ).toBe(11_000_000);
  });

  it('adds employee and employer contributions from explicit gross income without changing cash', () => {
    expect(
      projectInvestmentValueAtDate(
        investment({
          contributionGrossAnnualIncomeCents: 10_000_000,
          contributionRateBasisPoints: 400,
          employerMatchBasisPoints: 400,
        }),
        '2027-01-01',
      ),
    ).toBe(10_800_000);
  });

  it('annualizes the optional monthly contribution and combines it with growth', () => {
    const value = projectInvestmentValueAtDate(
      investment({
        annualGrowthRateBasisPoints: 1_000,
        contributionAmountCents: 10_000,
      }),
      '2027-01-01',
    );

    expect(value).toBeGreaterThan(11_120_000);
    expect(value).toBeLessThan(11_130_000);
  });

  it('keeps non-investments and dates on or before the valuation unchanged', () => {
    expect(
      projectInvestmentValueAtDate(
        investment({ type: 'tangible', annualGrowthRateBasisPoints: 1_000 }),
        '2027-01-01',
      ),
    ).toBe(10_000_000);
    expect(
      projectInvestmentValueAtDate(
        investment({ annualGrowthRateBasisPoints: 1_000 }),
        '2026-01-01',
      ),
    ).toBe(10_000_000);
    expect(
      projectAssetsAtDate([investment({ annualGrowthRateBasisPoints: 1_000 })], '2027-01-01')[0],
    ).toMatchObject({ valueCents: 11_000_000, valuationDate: '2026-01-01' });
  });
});
