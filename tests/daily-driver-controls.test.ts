import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  creditCardCycleSchema,
  forecastEventSchema,
  receivableSchema,
  type CashAccount,
  type ForecastEvent,
} from '@balance-book/domain';
import {
  buildForecastBundle,
  deriveEffectiveCashFloorPolicy,
  materializeForecastEvents,
  materializeRecurringEvents,
  prepareRollingForecastContext,
  projectRollingReceivableBalances,
  shouldIncludeEvent,
} from '@balance-book/financial-engine';

const userId = 'daily-driver-user';
const account = (overrides: Partial<CashAccount> = {}): CashAccount =>
  cashAccountSchema.parse({
    id: 'checking',
    userId,
    name: 'Checking',
    type: 'checking',
    openingBalanceCents: 100_000,
    balanceAsOf: '2026-07-14',
    includedInLiquidity: true,
    canFundOtherAccounts: true,
    transferDelayDays: 0,
    ...overrides,
  });

const event = (overrides: Partial<ForecastEvent> = {}): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'event',
    userId,
    accountId: 'checking',
    date: '2026-07-15',
    kind: 'income',
    direction: 'inflow',
    amountCents: 10_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Income',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'cash-account',
    ...overrides,
  });

const policy = cashFloorPolicySchema.parse({
  hardConsolidatedFloorCents: 0,
  horizonDays: 90,
  includeConfirmedReceivablesConservatively: true,
});

describe('rolling current forecast context', () => {
  it('replays stale snapshots through past expected events once, then gives every preview the same current opening', () => {
    const staleChecking = account({ balanceAsOf: '2026-07-10', openingBalanceCents: 100_000 });
    const currentSavings = account({
      id: 'savings',
      name: 'Savings',
      type: 'savings',
      balanceAsOf: '2026-07-14',
      openingBalanceCents: 50_000,
    });
    const events = [
      event({ id: 'past-pay', date: '2026-07-11', amountCents: 50_000 }),
      event({
        id: 'past-bill',
        date: '2026-07-12',
        kind: 'direct-commitment',
        direction: 'outflow',
        amountCents: 20_000,
        incomeType: undefined,
      }),
      event({
        id: 'past-expected-pay',
        date: '2026-07-13',
        amountCents: 30_000,
        certainty: 'expected',
      }),
      event({
        id: 'future-expected-pay',
        date: '2026-07-15',
        amountCents: 10_000,
        certainty: 'expected',
      }),
    ];

    const context = prepareRollingForecastContext({
      accounts: [staleChecking, currentSavings],
      events,
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      policy,
      requestedStartDate: '2026-07-14',
    });

    expect(context.startDate).toBe('2026-07-14');
    expect(context.endDate).toBe('2026-10-11');
    expect(context.accounts.find((item) => item.id === 'checking')).toMatchObject({
      openingBalanceCents: 160_000,
      balanceAsOf: '2026-07-13',
      availableBalanceCents: undefined,
    });
    expect(context.accounts.find((item) => item.id === 'savings')).toEqual(currentSavings);

    const scheduled = materializeForecastEvents({
      accounts: context.accounts,
      events,
      cards: [],
      cardCycles: [],
      loans: [],
      receivables: [],
      startDate: context.startDate,
      endDate: context.endDate,
    });
    const bundle = buildForecastBundle({
      accounts: context.accounts,
      events: scheduled,
      policy,
      startDate: context.startDate,
      endDate: context.endDate,
    });
    expect(bundle.expected.days[0]?.consolidatedCashCents).toBe(210_000);
    expect(bundle.conservative.days[0]?.consolidatedCashCents).toBe(210_000);
    expect(bundle.expected.days.at(-1)?.consolidatedCashCents).toBe(220_000);
    expect(bundle.conservative.days.at(-1)?.consolidatedCashCents).toBe(210_000);
  });

  it('carries a pre-start receivable accrual into today and settles open money only on its cash date', () => {
    const accruedReceivable = receivableSchema.parse({
      id: 'shared-service',
      userId,
      source: 'Household member',
      description: 'Shared service expenses',
      originalAmountCents: 0,
      remainingAmountCents: 0,
      expectedDate: '2026-07-20',
      settlementDateConfirmed: true,
      destinationAccountId: 'checking',
      certainty: 'expected',
      accrualAmountCents: 27_500,
      accrualDate: '2026-07-12',
      includeInCashForecast: false,
    });
    const settlingReceivable = receivableSchema.parse({
      id: 'open-reimbursement',
      userId,
      source: 'Household member',
      description: 'Open reimbursement',
      originalAmountCents: 10_000,
      remainingAmountCents: 10_000,
      expectedDate: '2026-07-20',
      settlementDateConfirmed: true,
      destinationAccountId: 'checking',
      certainty: 'expected',
      includeInCashForecast: true,
    });

    const days = projectRollingReceivableBalances({
      receivables: [accruedReceivable, settlingReceivable],
      replayStartDate: '2026-07-10',
      startDate: '2026-07-15',
      endDate: '2026-07-21',
      mode: 'expected',
      includeConfirmedReceivablesConservatively: true,
    });

    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ date: '2026-07-15', endingOutstandingCents: 37_500 });
    expect(days.find((day) => day.date === '2026-07-19')?.endingOutstandingCents).toBe(37_500);
    expect(days.find((day) => day.date === '2026-07-20')).toMatchObject({
      settledCents: 10_000,
      endingOutstandingCents: 27_500,
    });
  });
});

describe('daily-driver income controls', () => {
  it('maps a projected raise and bonus into expected cash without overstating conservative pay', () => {
    const basePay = event({
      id: 'base-pay',
      amountCents: 100_000,
      incomeType: 'paycheck',
      recurrenceRule: { frequency: 'biweekly' },
    });
    const raise = event({
      id: 'raise',
      date: '2026-07-29',
      amountCents: 10_000,
      certainty: 'expected',
      incomeType: 'raise-adjustment',
      parentIncomeEventId: basePay.id,
      recurrenceRule: { frequency: 'biweekly' },
    });
    const bonus = event({
      id: 'bonus',
      date: '2026-08-01',
      amountCents: 50_000,
      certainty: 'expected',
      incomeType: 'bonus',
    });
    const events = materializeForecastEvents({
      accounts: [account()],
      events: [basePay, raise, bonus],
      cards: [],
      cardCycles: [],
      loans: [],
      startDate: '2026-07-14',
      endDate: '2026-08-15',
    });
    const result = buildForecastBundle({
      accounts: [account()],
      events,
      policy,
      startDate: '2026-07-14',
      endDate: '2026-08-15',
    });

    expect(result.conservative.days.at(-1)?.consolidatedCashCents).toBe(400_000);
    expect(result.expected.days.at(-1)?.consolidatedCashCents).toBe(470_000);
    expect(
      result.expected.days.find((day) => day.date === '2026-07-29')?.consolidatedCashCents,
    ).toBe(310_000);
  });

  it.each([
    [{ frequency: 'weekly', interval: 2 } as const, ['2026-07-15', '2026-07-29']],
    [{ frequency: 'biweekly' } as const, ['2026-07-15', '2026-07-29']],
    [
      { frequency: 'semimonthly' as const, daysOfMonth: [15, 31] as [number, number] },
      ['2026-07-15', '2026-07-31'],
    ],
    [{ frequency: 'monthly', dayOfMonth: 15, interval: 1 } as const, ['2026-07-15']],
  ])('materializes editable cadence %j and respects an inclusive end date', (rule, dates) => {
    const occurrences = materializeRecurringEvents({
      events: [
        event({
          recurrenceRule: rule,
          recurrenceEndDate: '2026-07-31',
        }),
      ],
      startDate: '2026-07-15',
      endDate: '2026-08-31',
    });
    expect(occurrences.map((occurrence) => occurrence.date)).toEqual(dates);
  });

  it('moves only the selected destination account while preserving the consolidated delta', () => {
    const savings = account({
      id: 'savings',
      name: 'Savings',
      type: 'savings',
      openingBalanceCents: 50_000,
    });
    const destinationIncome = event({ accountId: savings.id, amountCents: 25_000 });
    const result = buildForecastBundle({
      accounts: [account(), savings],
      events: [destinationIncome],
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-15',
    }).expected.days.at(-1)!;
    expect(result.consolidatedCashCents).toBe(175_000);
    expect(result.accounts.find((item) => item.accountId === 'checking')?.endingBalanceCents).toBe(
      100_000,
    );
    expect(result.accounts.find((item) => item.accountId === 'savings')?.endingBalanceCents).toBe(
      75_000,
    );
  });

  it('enforces the certainty truth table even when an unsafe override is supplied', () => {
    const uncertainInflow = event({ certainty: 'uncertain', includeInConservative: true });
    const expectedInflow = event({ certainty: 'expected', includeInConservative: true });
    const riskOutflow = event({
      kind: 'direct-commitment',
      direction: 'outflow',
      certainty: 'uncertain',
      includeInConservative: false,
      incomeType: undefined,
    });
    expect(shouldIncludeEvent(uncertainInflow, 'conservative')).toBe(false);
    expect(shouldIncludeEvent(uncertainInflow, 'expected')).toBe(false);
    expect(shouldIncludeEvent(expectedInflow, 'conservative')).toBe(false);
    expect(shouldIncludeEvent(expectedInflow, 'expected')).toBe(true);
    expect(shouldIncludeEvent(riskOutflow, 'conservative')).toBe(true);
  });
});

describe('daily-driver floor and funding controls', () => {
  it('derives the global minimum from account thresholds while preserving a larger override', () => {
    const accounts = [
      account({ hardFloorCents: 30_000, preferredFloorCents: 45_000 }),
      account({
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        hardFloorCents: 20_000,
        preferredFloorCents: 35_000,
      }),
    ];
    expect(deriveEffectiveCashFloorPolicy({ accounts, policy })).toMatchObject({
      accountHardFloorTotalCents: 50_000,
      accountPreferredFloorTotalCents: 80_000,
      effectiveHardFloorCents: 50_000,
      effectivePreferredFloorCents: 80_000,
    });
    const largerOverride = cashFloorPolicySchema.parse({
      ...policy,
      hardConsolidatedFloorCents: 90_000,
      preferredConsolidatedFloorCents: 110_000,
    });
    expect(
      deriveEffectiveCashFloorPolicy({ accounts, policy: largerOverride }).effectiveHardFloorCents,
    ).toBe(90_000);
  });

  it('keeps delayed transfers in consolidated ownership while withholding destination funding', () => {
    const source = account({ id: 'source', openingBalanceCents: 100_000 });
    const destination = account({ id: 'destination', openingBalanceCents: 0 });
    const transferEvents = [
      event({
        id: 'debit',
        accountId: source.id,
        kind: 'transfer-debit',
        direction: 'outflow',
        amountCents: 50_000,
        incomeType: undefined,
        transferId: 'transfer-1',
      }),
      event({
        id: 'credit',
        accountId: destination.id,
        date: '2026-07-17',
        kind: 'transfer-credit',
        amountCents: 50_000,
        incomeType: undefined,
        transferId: 'transfer-1',
      }),
    ];
    const result = buildForecastBundle({
      accounts: [source, destination],
      events: transferEvents,
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-17',
    }).conservative;
    expect(result.days.map((day) => day.consolidatedCashCents)).toEqual([
      100_000, 100_000, 100_000, 100_000,
    ]);
    expect(result.days.find((day) => day.date === '2026-07-16')?.inTransitCents).toBe(50_000);
    expect(
      result.days
        .find((day) => day.date === '2026-07-16')
        ?.accounts.find((item) => item.accountId === destination.id)?.endingBalanceCents,
    ).toBe(0);
  });

  it('keeps recurring transfer credits paired to each delayed debit occurrence', () => {
    const debit = event({
      id: 'recurring-debit',
      accountId: 'source',
      kind: 'transfer-debit',
      direction: 'outflow',
      amountCents: 10_000,
      incomeType: undefined,
      transferId: 'recurring-transfer',
      recurrenceRule: { frequency: 'weekly', interval: 1 },
      recurrenceEndDate: '2026-07-29',
    });
    const credit = event({
      id: 'recurring-credit',
      accountId: 'destination',
      date: '2026-07-17',
      kind: 'transfer-credit',
      amountCents: 10_000,
      incomeType: undefined,
      transferId: 'recurring-transfer',
    });
    const occurrences = materializeRecurringEvents({
      events: [debit, credit],
      startDate: '2026-07-14',
      endDate: '2026-07-31',
    });
    expect(
      occurrences.filter((item) => item.kind === 'transfer-debit').map((item) => item.date),
    ).toEqual(['2026-07-15', '2026-07-22', '2026-07-29']);
    expect(
      occurrences.filter((item) => item.kind === 'transfer-credit').map((item) => item.date),
    ).toEqual(['2026-07-17', '2026-07-24', '2026-07-31']);
    expect(new Set(occurrences.map((item) => item.transferId)).size).toBe(3);
  });

  it('suggests a timing-safe source and returns a reviewable initiation and arrival date', () => {
    const source = account({
      id: 'source',
      openingBalanceCents: 500_000,
      hardFloorCents: 100_000,
      transferDelayDays: 1,
    });
    const destination = account({
      id: 'destination',
      openingBalanceCents: 100_000,
      hardFloorCents: 100_000,
    });
    const bill = event({
      id: 'bill',
      accountId: destination.id,
      date: '2026-07-17',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 150_000,
      incomeType: undefined,
    });
    const need = buildForecastBundle({
      accounts: [source, destination],
      events: [bill],
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-20',
    }).conservative.transferNeeds[0]!;
    expect(need).toMatchObject({
      accountId: destination.id,
      shortfallCents: 150_000,
      suggestedSourceAccountId: source.id,
      initiationDate: '2026-07-15',
      arrivalDate: '2026-07-16',
      sourceSurplusAfterFloorsCents: 250_000,
    });
  });

  it('attributes a transfer to the earliest breach and advances after that increment is planned', () => {
    const source = account({
      id: 'source',
      openingBalanceCents: 500_000,
      hardFloorCents: 100_000,
      transferDelayDays: 1,
    });
    const destination = account({
      id: 'destination',
      openingBalanceCents: 100_000,
      hardFloorCents: 100_000,
    });
    const firstBill = event({
      id: 'first-bill',
      accountId: destination.id,
      date: '2026-07-17',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 50_000,
      incomeType: undefined,
    });
    const laterBill = event({
      id: 'later-bill',
      accountId: destination.id,
      date: '2026-07-20',
      kind: 'direct-commitment',
      direction: 'outflow',
      amountCents: 100_000,
      incomeType: undefined,
    });
    const forecastInput = {
      accounts: [source, destination],
      policy,
      startDate: '2026-07-14' as const,
      endDate: '2026-07-21' as const,
    };

    const firstNeed = buildForecastBundle({
      ...forecastInput,
      events: [firstBill, laterBill],
    }).conservative.transferNeeds[0]!;

    expect(firstNeed).toMatchObject({
      accountId: destination.id,
      date: '2026-07-17',
      balanceCents: 50_000,
      shortfallCents: 50_000,
      eventIds: [firstBill.id],
      horizonDeepestShortfallCents: 150_000,
      horizonDeepestShortfallDate: '2026-07-20',
      horizonAdditionalShortfallCents: 100_000,
      suggestedSourceAccountId: source.id,
      initiationDate: '2026-07-15',
      arrivalDate: '2026-07-16',
      sourceSurplusAfterFloorsCents: 250_000,
    });

    const nextNeed = buildForecastBundle({
      ...forecastInput,
      events: [
        firstBill,
        laterBill,
        event({
          id: 'first-transfer-debit',
          accountId: source.id,
          date: '2026-07-15',
          kind: 'transfer-debit',
          direction: 'outflow',
          amountCents: 50_000,
          incomeType: undefined,
          transferId: 'first-transfer',
        }),
        event({
          id: 'first-transfer-credit',
          accountId: destination.id,
          date: '2026-07-16',
          kind: 'transfer-credit',
          direction: 'inflow',
          amountCents: 50_000,
          incomeType: undefined,
          transferId: 'first-transfer',
        }),
      ],
    }).conservative.transferNeeds[0]!;

    expect(nextNeed).toMatchObject({
      accountId: destination.id,
      date: '2026-07-20',
      balanceCents: 0,
      shortfallCents: 100_000,
      eventIds: [laterBill.id],
      horizonDeepestShortfallCents: 100_000,
      horizonDeepestShortfallDate: '2026-07-20',
      horizonAdditionalShortfallCents: 0,
      suggestedSourceAccountId: source.id,
      initiationDate: '2026-07-18',
      arrivalDate: '2026-07-19',
    });
  });

  it('jointly allocates source capacity in need-by order and leaves later needs unresolved', () => {
    const source = account({
      id: 'source',
      openingBalanceCents: 200_000,
      hardFloorCents: 100_000,
      transferDelayDays: 1,
    });
    const firstTarget = account({
      id: 'first-target',
      openingBalanceCents: 100_000,
      hardFloorCents: 100_000,
    });
    const secondTarget = account({
      id: 'second-target',
      openingBalanceCents: 100_000,
      hardFloorCents: 100_000,
    });
    const ballast = account({
      id: 'ballast',
      openingBalanceCents: 500_000,
      canFundOtherAccounts: false,
    });
    const result = buildForecastBundle({
      accounts: [source, firstTarget, secondTarget, ballast],
      events: [
        event({
          id: 'first-bill',
          accountId: firstTarget.id,
          date: '2026-07-17',
          kind: 'direct-commitment',
          direction: 'outflow',
          amountCents: 70_000,
          incomeType: undefined,
        }),
        event({
          id: 'second-bill',
          accountId: secondTarget.id,
          date: '2026-07-18',
          kind: 'direct-commitment',
          direction: 'outflow',
          amountCents: 70_000,
          incomeType: undefined,
        }),
      ],
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-20',
    });

    expect(result.conservative.transferNeeds).toMatchObject([
      {
        accountId: firstTarget.id,
        suggestedSourceAccountId: source.id,
        sourceSurplusAfterFloorsCents: 30_000,
      },
      {
        accountId: secondTarget.id,
        suggestedSourceAccountId: undefined,
      },
    ]);
    expect(result.rawSafeToDeployMarginCents).toBeGreaterThan(0);
    expect(result.availableToDeployCents).toBe(0);
  });

  it('reports source surplus after every jointly reserved transfer', () => {
    const source = account({
      id: 'source',
      openingBalanceCents: 250_000,
      hardFloorCents: 100_000,
      transferDelayDays: 1,
    });
    const firstTarget = account({
      id: 'first-target',
      openingBalanceCents: 100_000,
      hardFloorCents: 100_000,
    });
    const secondTarget = account({
      id: 'second-target',
      openingBalanceCents: 100_000,
      hardFloorCents: 100_000,
    });
    const result = buildForecastBundle({
      accounts: [source, firstTarget, secondTarget],
      events: [
        event({
          id: 'first-bill',
          accountId: firstTarget.id,
          date: '2026-07-17',
          kind: 'direct-commitment',
          direction: 'outflow',
          amountCents: 70_000,
          incomeType: undefined,
        }),
        event({
          id: 'second-bill',
          accountId: secondTarget.id,
          date: '2026-07-18',
          kind: 'direct-commitment',
          direction: 'outflow',
          amountCents: 60_000,
          incomeType: undefined,
        }),
      ],
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-20',
    });

    expect(result.conservative.transferNeeds).toMatchObject([
      {
        accountId: firstTarget.id,
        suggestedSourceAccountId: source.id,
        sourceSurplusAfterFloorsCents: 80_000,
      },
      {
        accountId: secondTarget.id,
        suggestedSourceAccountId: source.id,
        sourceSurplusAfterFloorsCents: 20_000,
      },
    ]);
    expect(result.availableToDeployCents).toBe(20_000);
  });

  it('never calls consolidated headroom safe when an account shortfall has no funding source', () => {
    const reserve = account({
      id: 'reserve',
      openingBalanceCents: 500_000,
      canFundOtherAccounts: false,
    });
    const bills = account({ id: 'bills', openingBalanceCents: 10_000, hardFloorCents: 10_000 });
    const result = buildForecastBundle({
      accounts: [reserve, bills],
      events: [
        event({
          accountId: bills.id,
          kind: 'direct-commitment',
          direction: 'outflow',
          amountCents: 20_000,
          incomeType: undefined,
        }),
      ],
      policy,
      startDate: '2026-07-14',
      endDate: '2026-07-16',
    });
    expect(result.rawSafeToDeployMarginCents).toBeGreaterThan(0);
    expect(result.conservative.transferNeeds[0]?.suggestedSourceAccountId).toBeUndefined();
    expect(result.availableToDeployCents).toBe(0);
  });

  it('rejects invalid floor and recurrence relationships at the domain boundary', () => {
    expect(() =>
      cashFloorPolicySchema.parse({
        ...policy,
        hardConsolidatedFloorCents: 20_000,
        preferredConsolidatedFloorCents: 10_000,
      }),
    ).toThrow(/preferred consolidated buffer/i);
    expect(() => account({ hardFloorCents: 20_000, preferredFloorCents: 10_000 })).toThrow(
      /preferred account buffer/i,
    );
    expect(() =>
      event({
        recurrenceRule: { frequency: 'weekly', interval: 1 },
        recurrenceEndDate: '2026-07-14',
      }),
    ).toThrow(/end date cannot precede/i);
    expect(() =>
      event({ recurrenceRule: { frequency: 'semimonthly', daysOfMonth: [15, 15] } }),
    ).toThrow(/must differ/i);
    expect(() =>
      creditCardCycleSchema.parse({
        id: 'invalid-cycle',
        cardId: 'card',
        opensOn: '2026-08-01',
        closesOn: '2026-07-31',
        dueOn: '2026-08-20',
        state: 'open',
        defaultEstimateCents: 0,
        actualActivityCents: 0,
        plannedActivityCents: 0,
      }),
    ).toThrow(/cannot close before/i);
    expect(() =>
      creditCardCycleSchema.parse({
        id: 'invalid-due-cycle',
        cardId: 'card',
        opensOn: '2026-07-01',
        closesOn: '2026-07-31',
        dueOn: '2026-07-20',
        state: 'open',
        defaultEstimateCents: 0,
        actualActivityCents: 0,
        plannedActivityCents: 0,
      }),
    ).toThrow(/due before/i);
  });
});
