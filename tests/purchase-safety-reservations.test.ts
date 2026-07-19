import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  forecastEventSchema,
  type CashAccount,
  type ForecastEvent,
  type MoneyCents,
} from '@balance-book/domain';
import {
  assessPurchaseSafety,
  assessReceivableFundingCoverageSequence,
  buildForecastBundle,
} from '@balance-book/financial-engine';

const userId = 'purchase-reservation-user';
const account = (overrides: Partial<CashAccount>): CashAccount =>
  cashAccountSchema.parse({
    id: 'checking',
    userId,
    name: 'Checking',
    type: 'checking',
    openingBalanceCents: 0,
    balanceAsOf: '2026-07-14',
    includedInLiquidity: true,
    canFundOtherAccounts: false,
    transferDelayDays: 0,
    ...overrides,
  });

const event = (overrides: Partial<ForecastEvent>): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'event',
    userId,
    accountId: 'checking',
    date: '2026-07-15',
    kind: 'direct-commitment',
    direction: 'outflow',
    amountCents: 1_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Commitment',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'cash-account',
    ...overrides,
  });

const policy = cashFloorPolicySchema.parse({
  hardConsolidatedFloorCents: 0,
  horizonDays: 30,
  includeConfirmedReceivablesConservatively: true,
});

const receivableDays = (amountCents: MoneyCents) =>
  ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18'].map((date) => ({
    date,
    endingOutstandingCents: amountCents,
  }));

describe('purchase-safety receivable reservations', () => {
  it('reserves every new account low in chronological order when funding needs interleave', () => {
    const coverage = assessReceivableFundingCoverageSequence({
      needs: [
        {
          date: '2026-08-15',
          shortfallCents: 4_000,
          horizonDeepestShortfallDate: '2026-08-30',
          horizonDeepestShortfallCents: 8_000,
          fundingMilestones: [
            { date: '2026-08-15', requiredCents: 4_000 },
            { date: '2026-08-16', requiredCents: 6_000 },
            { date: '2026-08-30', requiredCents: 8_000 },
          ],
        },
        {
          date: '2026-08-20',
          shortfallCents: 5_000,
          horizonDeepestShortfallDate: '2026-08-20',
          horizonDeepestShortfallCents: 5_000,
        },
      ],
      receivableDays: [
        { date: '2026-08-15', endingOutstandingCents: 10_000 },
        { date: '2026-08-16', endingOutstandingCents: 10_000 },
        { date: '2026-08-20', endingOutstandingCents: 10_000 },
        { date: '2026-08-30', endingOutstandingCents: 10_000 },
      ],
    });

    expect(coverage[0]).toMatchObject({
      receivableReleaseNeededCents: 4_000,
      deepestReceivableReleaseNeededCents: 6_000,
      deepestUncoveredAfterReceivablesCents: 2_000,
    });
    expect(coverage[1]).toMatchObject({
      receivableOutstandingCents: 4_000,
      receivableReleaseNeededCents: 4_000,
      uncoveredAfterReceivablesCents: 1_000,
    });
  });

  it('does not let a cash recommendation reuse Money Owed already reserved for another account', () => {
    const pnc = account({ id: 'pnc', name: 'PNC' });
    const sofi = account({ id: 'sofi', name: 'SoFi' });
    const ballast = account({
      id: 'ballast',
      name: 'Ballast',
      openingBalanceCents: 50_000,
    });
    const forecast = buildForecastBundle({
      accounts: [pnc, sofi, ballast],
      events: [
        event({ id: 'pnc-first-low', accountId: pnc.id, amountCents: 6_000 }),
        event({
          id: 'pnc-lower-low',
          accountId: pnc.id,
          date: '2026-07-16',
          amountCents: 2_000,
        }),
        event({
          id: 'pnc-recovery',
          accountId: pnc.id,
          date: '2026-07-17',
          kind: 'income',
          direction: 'inflow',
          amountCents: 8_000,
        }),
        event({
          id: 'cash-purchase',
          accountId: sofi.id,
          date: '2026-07-17',
          kind: 'scenario',
          amountCents: 3_000,
          hypothetical: true,
          accepted: true,
        }),
      ],
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-18',
    }).expected;

    expect(forecast.transferNeeds).toMatchObject([
      {
        accountId: pnc.id,
        shortfallCents: 6_000,
        horizonDeepestShortfallCents: 8_000,
      },
      {
        accountId: sofi.id,
        shortfallCents: 3_000,
        horizonDeepestShortfallCents: 3_000,
      },
    ]);

    const raw = assessPurchaseSafety({
      forecast,
      cashLeavesOn: '2026-07-17',
      fundingAccountId: sofi.id,
      fundingAccountFloorCents: 0,
      protectedTotalFloorCents: 0,
      receivableDays: receivableDays(10_000),
    });
    expect(raw).toMatchObject({
      safe: true,
      receivableReleaseNeededCents: 3_000,
      uncoveredFundingShortfallCents: 0,
    });

    const reserved = assessPurchaseSafety({
      forecast,
      cashLeavesOn: '2026-07-17',
      fundingAccountId: sofi.id,
      fundingAccountFloorCents: 0,
      protectedTotalFloorCents: 0,
      receivableDays: receivableDays(10_000),
      fundingNeeds: forecast.transferNeeds,
    });
    expect(reserved).toMatchObject({
      safe: false,
      fundingAccountLowCents: -3_000,
      fundingAccountShortfallCents: 3_000,
      receivableOutstandingCents: 2_000,
      receivableReleaseNeededCents: 2_000,
      uncoveredFundingShortfallCents: 1_000,
    });

    const cardDisclosure = assessPurchaseSafety({
      forecast,
      cashLeavesOn: '2026-07-17',
      fundingAccountId: sofi.id,
      fundingAccountFloorCents: 0,
      protectedTotalFloorCents: 0,
      receivableDays: receivableDays(10_000),
      fundingNeeds: forecast.transferNeeds,
      enforceFundingAccountFloor: false,
    });
    expect(cardDisclosure).toMatchObject({
      safe: true,
      receivableReleaseNeededCents: 2_000,
      uncoveredFundingShortfallCents: 1_000,
    });
  });

  it('labels cash fundable after release when unreserved Money Owed covers the selected account', () => {
    const pnc = account({ id: 'pnc', name: 'PNC' });
    const sofi = account({ id: 'sofi', name: 'SoFi' });
    const ballast = account({ id: 'ballast', name: 'Ballast', openingBalanceCents: 50_000 });
    const forecast = buildForecastBundle({
      accounts: [pnc, sofi, ballast],
      events: [
        event({ id: 'pnc-first-low', accountId: pnc.id, amountCents: 8_000 }),
        event({
          id: 'pnc-recovery',
          accountId: pnc.id,
          date: '2026-07-17',
          kind: 'income',
          direction: 'inflow',
          amountCents: 8_000,
        }),
        event({
          id: 'cash-purchase',
          accountId: sofi.id,
          date: '2026-07-17',
          kind: 'scenario',
          amountCents: 3_000,
          hypothetical: true,
          accepted: true,
        }),
      ],
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-18',
    }).expected;

    const assessment = assessPurchaseSafety({
      forecast,
      cashLeavesOn: '2026-07-17',
      fundingAccountId: sofi.id,
      fundingAccountFloorCents: 0,
      protectedTotalFloorCents: 0,
      receivableDays: receivableDays(12_000),
      fundingNeeds: forecast.transferNeeds,
    });
    expect(assessment).toMatchObject({
      safe: true,
      fundingAccountShortfallCents: 3_000,
      receivableOutstandingCents: 4_000,
      receivableReleaseNeededCents: 3_000,
      uncoveredFundingShortfallCents: 0,
    });
  });
});
