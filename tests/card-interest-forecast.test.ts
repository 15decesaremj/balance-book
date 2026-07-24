import { describe, expect, it } from 'vitest';
import { creditCardCycleSchema, creditCardSchema, type CreditCard } from '@balance-book/domain';
import {
  cardsForInterestForecast,
  effectiveCarryingBalanceAprBasisPoints,
  estimatedMonthlyCardInterestCents,
  projectCardDebtSchedule,
} from '@balance-book/financial-engine';

const card = (overrides: Partial<CreditCard> = {}): CreditCard =>
  creditCardSchema.parse({
    id: 'synthetic-card',
    userId: 'synthetic-user',
    name: 'Synthetic card',
    fundingAccountId: 'synthetic-checking',
    accountKind: 'credit-card',
    defaultFutureStatementCents: 0,
    estimatePolicy: 'actual-reset',
    paymentPolicy: 'manual',
    interestForecastEnabled: true,
    promotionalCarryingBalance: false,
    status: 'active',
    ...overrides,
  });

const openCycle = (id: string, month: string) =>
  creditCardCycleSchema.parse({
    id,
    cardId: 'synthetic-card',
    opensOn: `${month}-01`,
    closesOn: `${month}-10`,
    dueOn: `${month}-25`,
    state: 'open',
    defaultEstimateCents: 0,
    actualActivityCents: 0,
    plannedActivityCents: 0,
  });

describe('experimental card interest forecasting', () => {
  it('reports zero for no carry and unavailable for positive carry without an APR', () => {
    const noAprCard = card({ aprBasisPoints: undefined });
    expect(estimatedMonthlyCardInterestCents({ card: noAprCard, carryingBalanceCents: 0 })).toBe(0);
    expect(
      estimatedMonthlyCardInterestCents({ card: noAprCard, carryingBalanceCents: 125_000 }),
    ).toBeUndefined();
  });

  it('uses the whole-balance promotional APR when selected', () => {
    const promotional = card({
      aprBasisPoints: 2_400,
      promotionalCarryingBalance: true,
      promotionalAprBasisPoints: 0,
    });
    expect(effectiveCarryingBalanceAprBasisPoints(promotional)).toBe(0);
    expect(
      estimatedMonthlyCardInterestCents({ card: promotional, carryingBalanceCents: 125_000 }),
    ).toBe(0);
  });

  it('rounds one nominal monthly period from the standard APR to integer cents', () => {
    expect(
      estimatedMonthlyCardInterestCents({
        card: card({ aprBasisPoints: 2_400 }),
        carryingBalanceCents: 125_000,
      }),
    ).toBe(2_500);
  });

  it('requires both profile and card opt-in and never adds interest to a locked statement', () => {
    const enabled = card({ aprBasisPoints: 2_400 });
    const disabledByProfile = cardsForInterestForecast([enabled], false)[0]!;
    const unlocked = openCycle('unlocked', '2032-02');
    const locked = creditCardCycleSchema.parse({
      ...openCycle('locked', '2032-03'),
      lockedStatementCents: 80_000,
      state: 'closed-statement',
    });
    const project = (projectedCard: CreditCard, includeInterest: boolean) =>
      projectCardDebtSchedule({
        card: projectedCard,
        cardCycles: [unlocked, locked],
        asOfDate: '2032-01-20',
        openingCarryingBalance: { cents: 100_000, asOfDate: '2032-01-20' },
        includeInterest,
      });

    expect(project(enabled, false)[0]!.interestOnCarryCents).toBe(0);
    expect(project(disabledByProfile, true)[0]!.interestOnCarryCents).toBe(0);
    const optedIn = project(enabled, true);
    expect(optedIn[0]).toMatchObject({ obligationCents: 102_000, interestOnCarryCents: 2_000 });
    expect(optedIn[1]).toMatchObject({ obligationCents: 80_000, interestOnCarryCents: 0 });
  });
});
