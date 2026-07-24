import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  committedRefinancePlanSchema,
  creditCardCycleSchema,
  forecastEventSchema,
  loanSchema,
} from '@balance-book/domain';
import {
  activeLoansForDate,
  analyzeLoanContinuationFromPayoff,
  expandRecurrence,
  projectLoanBalanceAtEndOfDate,
  solveInstallmentLoanSetup,
} from '@balance-book/financial-engine';
import {
  aggregateKnownLimitCardUtilization,
  billRelativeReceiptTimingLabel,
  cardUtilizationPresentation,
  defaultReceivableReceiptDate,
  effectiveLoanPageMetrics,
  isRecurringRunRateActive,
  loanAmortizationLedger,
  loanPageMetrics,
  latestClosedStatementForReconciliation,
  monthlyEquivalentRunRateCents,
  netWorthCashBalance,
  receivableAccrualRecurrenceRuleForEdit,
  receivableExpectedTimingText,
  receivableRecurrenceRuleForEdit,
  resolveLoanEditField,
  scheduledReceivableEffectText,
  scheduledCardPaymentRequest,
  selectCardStatementSummaryCycles,
} from '../apps/desktop/src/renderer/CorePages';

describe('core page numeric summaries', () => {
  it('defaults a new expected receipt to the first day of the next calendar month', () => {
    expect(defaultReceivableReceiptDate('2026-07-16')).toBe('2026-08-01');
    expect(defaultReceivableReceiptDate('2026-12-31')).toBe('2027-01-01');
    expect(defaultReceivableReceiptDate('2028-02-29')).toBe('2028-03-01');
  });

  it('moves a monthly receipt cadence with its edited expected date', () => {
    expect(
      receivableRecurrenceRuleForEdit({
        frequency: 'monthly',
        expectedDate: '2026-08-30',
        existing: { frequency: 'monthly', dayOfMonth: 28, interval: 2 },
      }),
    ).toEqual({ frequency: 'monthly', dayOfMonth: 30, interval: 2 });
    expect(
      receivableRecurrenceRuleForEdit({
        frequency: 'once',
        expectedDate: '2026-08-01',
        existing: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      }),
    ).toBeUndefined();
  });

  it('moves a monthly owed-balance cadence with its edited first accrual date', () => {
    const updatedRule = receivableAccrualRecurrenceRuleForEdit({
      frequency: 'monthly',
      accrualDate: '2026-08-30',
      existing: { frequency: 'monthly', dayOfMonth: 1, interval: 2 },
    });

    expect(updatedRule).toEqual({ frequency: 'monthly', dayOfMonth: 30, interval: 2 });
    expect(
      expandRecurrence({
        startDate: '2026-08-30',
        endDate: '2026-12-31',
        rule: updatedRule!,
      }),
    ).toEqual(['2026-08-30', '2026-10-30', '2026-12-30']);
    expect(
      receivableAccrualRecurrenceRuleForEdit({
        frequency: 'once',
        accrualDate: '2026-08-01',
        existing: { frequency: 'monthly', dayOfMonth: 1, interval: 1 },
      }),
    ).toEqual({ frequency: 'once' });
  });

  it('describes receipt timing and scheduled effects in plain language', () => {
    expect(billRelativeReceiptTimingLabel(-2, 'Rent')).toBe('2 days before Rent');
    expect(billRelativeReceiptTimingLabel(1, 'Auto payment')).toBe('1 day after Auto payment');
    expect(billRelativeReceiptTimingLabel(0, 'Rent')).toBe('when Rent is due');
    expect(
      receivableExpectedTimingText({
        expectedDate: '2026-08-01',
        settlementDateConfirmed: false,
      }),
    ).toBe('2026-08-01 (unconfirmed)');
    expect(
      scheduledReceivableEffectText({
        date: '2026-07-30',
        accountName: 'Reserve savings',
        cashAmountCents: 102_500,
        owedReductionCents: 27_500,
      }),
    ).toBe(
      'Scheduled effect on 2026-07-30: +$1,025.00 to Reserve savings and -$275.00 from projected Money Owed. The other $750.00 is scheduled cash that was not already owed.',
    );
    expect(
      scheduledReceivableEffectText({
        date: '2026-08-11',
        accountName: 'Reserve savings',
        cashAmountCents: 27_413,
        owedReductionCents: 27_413,
      }),
    ).toBe(
      'Scheduled effect on 2026-08-11: +$274.13 to Reserve savings and -$274.13 from projected Money Owed.',
    );
  });

  it('normalizes every supported recurring cadence to one average month', () => {
    expect(
      monthlyEquivalentRunRateCents([
        {
          amountCents: 1_200,
          recurrenceRule: { frequency: 'weekly', interval: 1 },
        },
        {
          amountCents: 1_200,
          recurrenceRule: { frequency: 'biweekly' },
        },
        {
          amountCents: 1_200,
          recurrenceRule: { frequency: 'semimonthly', daysOfMonth: [1, 15] },
        },
        {
          amountCents: 1_200,
          recurrenceRule: { frequency: 'monthly', dayOfMonth: 1, interval: 2 },
        },
        {
          amountCents: 99_999,
          recurrenceRule: { frequency: 'once' },
        },
      ]),
    ).toBe(10_800);
  });

  it('excludes only schedules that ended before the run-rate date', () => {
    expect(isRecurringRunRateActive('2026-07-14', '2026-07-15')).toBe(false);
    expect(isRecurringRunRateActive('2026-07-15', '2026-07-15')).toBe(true);
    expect(isRecurringRunRateActive('2026-08-01', '2026-07-15')).toBe(true);
    expect(isRecurringRunRateActive(undefined, '2026-07-15')).toBe(true);
  });

  it('uses the loan convention for daily accrual and total modeled debt for payoff', () => {
    const loan = loanSchema.parse({
      id: 'loan-a',
      userId: 'profile-a',
      name: 'Synthetic loan',
      principalCents: 100_000,
      accruedInterestCents: 10_000,
      balanceDate: '2026-07-15',
      annualRateBasisPoints: 3_650,
      accrualConvention: 'monthly',
      paymentCents: 10_000,
      nextPaymentDate: '2026-08-15',
      fundingAccountId: 'cash-a',
    });

    const metrics = loanPageMetrics(loan, '2026-07-15');

    expect(metrics.modeled.totalCents).toBe(110_000);
    expect(metrics.dailyInterestCents).toBe(101);
    expect(metrics.payoff).toEqual(
      analyzeLoanContinuationFromPayoff({
        loan: { ...loan, principalCents: 100_000, accruedInterestCents: 10_000 },
        payoffDate: '2026-07-15',
        payoffAmountCents: 110_000,
      }),
    );
    expect(metrics.payoff.totalPaymentsCents).toBeGreaterThan(110_000);
    expect(metrics.payoff.remainingInterestCents).toBeGreaterThan(0);
    expect(metrics.payoff.paidOffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows the scheduled-payment-adjusted balance instead of accruing from a stale snapshot', () => {
    const loan = loanSchema.parse({
      id: 'loan-scheduled',
      userId: 'profile-a',
      name: 'Scheduled synthetic loan',
      principalCents: 100_000,
      accruedInterestCents: 0,
      balanceDate: '2026-07-15',
      annualRateBasisPoints: 1_200,
      accrualConvention: 'actual-365',
      paymentCents: 10_000,
      nextPaymentDate: '2026-08-01',
      fundingAccountId: 'cash-a',
    });
    const asOf = '2026-08-02';
    const exact = projectLoanBalanceAtEndOfDate(loan, asOf);

    expect(loanPageMetrics(loan, asOf).modeled).toEqual(exact);
    expect(exact.principalCents).toBeLessThan(loan.principalCents);
  });

  it('keeps a sparse loan anchored when a later edit changes no calculated field', () => {
    const initial = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 100_000,
      annualRateBasisPoints: 0,
      paymentCents: 10_000,
    });
    expect(initial.status).toBe('approximate');
    const stored = loanSchema.parse({
      id: 'sparse-edit-loan',
      userId: 'profile-a',
      name: 'Sparse synthetic loan',
      principalCents: initial.resolved.principalCents,
      accruedInterestCents: initial.resolved.accruedInterestCents,
      balanceDate: initial.resolved.balanceDate,
      annualRateBasisPoints: initial.resolved.annualRateBasisPoints,
      accrualConvention: initial.resolved.accrualConvention,
      paymentCents: initial.resolved.paymentCents,
      cashPaymentCents: initial.resolved.cashPaymentCents,
      nextPaymentDate: initial.resolved.nextPaymentDate,
      paymentFrequency: initial.resolved.paymentFrequency,
      inferredFields: initial.inferredFields,
      fundingAccountId: 'cash-a',
    });
    expect(projectLoanBalanceAtEndOfDate(stored, '2026-03-02').totalCents).toBe(80_000);
    const inferredFields = new Set(stored.inferredFields);
    const balanceDate = resolveLoanEditField({
      field: 'balanceDate',
      submitted: undefined,
      stored: stored.balanceDate,
      inferredFields,
      recalculate: false,
    });
    const nextPaymentDate = resolveLoanEditField({
      field: 'nextPaymentDate',
      submitted: undefined,
      stored: stored.nextPaymentDate,
      inferredFields,
      recalculate: false,
    });
    const edited = solveInstallmentLoanSetup({
      asOfDate: '2026-03-02',
      principalCents: stored.principalCents,
      accruedInterestCents: stored.accruedInterestCents,
      balanceDate: balanceDate.value,
      annualRateBasisPoints: stored.annualRateBasisPoints,
      accrualConvention: stored.accrualConvention,
      paymentCents: stored.paymentCents,
      cashPaymentCents: stored.cashPaymentCents,
      nextPaymentDate: nextPaymentDate.value,
      paymentFrequency: stored.paymentFrequency,
    });
    const editedLoan = loanSchema.parse({
      ...stored,
      ...edited.resolved,
      name: 'Renamed only',
    });

    expect(balanceDate).toEqual({
      value: '2026-01-01',
      preservedCalculatedValue: true,
    });
    expect(nextPaymentDate.preservedCalculatedValue).toBe(true);
    expect(projectLoanBalanceAtEndOfDate(editedLoan, '2026-03-02').totalCents).toBe(80_000);
  });

  it('shows every future regular and extra-principal allocation with the matching cash draft', () => {
    const loan = loanSchema.parse({
      id: 'loan-ledger',
      userId: 'profile-a',
      name: 'Synthetic ledger loan',
      principalCents: 100_000,
      accruedInterestCents: 0,
      balanceDate: '2026-01-01',
      annualRateBasisPoints: 0,
      accrualConvention: 'actual-365',
      paymentCents: 25_000,
      cashPaymentCents: 30_000,
      nextPaymentDate: '2026-02-01',
      maturityDate: '2026-05-01',
      fundingAccountId: 'cash-a',
    });
    const extra = forecastEventSchema.parse({
      id: 'extra-principal-a',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-02-15',
      kind: 'loan-payment',
      direction: 'outflow',
      amountCents: 10_000,
      certainty: 'confirmed',
      status: 'planned',
      label: 'Synthetic extra principal',
      paymentMethod: 'cash-account',
      sourceRecordId: loan.id,
      loanPaymentTreatment: 'additional-principal',
    });
    const overOverride = forecastEventSchema.parse({
      id: 'overridden-regular-draft',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-02-01',
      kind: 'loan-payment',
      direction: 'outflow',
      amountCents: 35_000,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Observed lender draft',
      paymentMethod: 'cash-account',
      sourceRecordId: loan.id,
      loanPaymentTreatment: 'scheduled-draft-override',
    });

    const rows = loanAmortizationLedger(loan, '2026-01-01', [extra, overOverride]);

    expect(rows).toHaveLength(5);
    expect(rows.slice(0, 2)).toEqual([
      expect.objectContaining({
        date: '2026-02-01',
        type: 'scheduled-payment',
        cashDraftCents: 35_000,
        interestPaidCents: 0,
        principalPaidCents: 25_000,
        remainingDebtCents: 75_000,
      }),
      expect.objectContaining({
        date: '2026-02-15',
        type: 'additional-principal',
        label: 'Synthetic extra principal',
        cashDraftCents: 10_000,
        principalPaidCents: 10_000,
        remainingDebtCents: 65_000,
      }),
    ]);
    expect(rows.at(-1)).toEqual(
      expect.objectContaining({
        date: '2026-05-01',
        cashDraftCents: 20_000,
        principalPaidCents: 15_000,
        remainingDebtCents: 0,
      }),
    );
    expect(loanAmortizationLedger(loan, '2026-02-20', [extra, overOverride])).not.toContainEqual(
      expect.objectContaining({ type: 'additional-principal' }),
    );
  });

  it('labels and allocates an explicit contractual balloon at maturity', () => {
    const loan = loanSchema.parse({
      id: 'loan-balloon-ledger',
      userId: 'profile-a',
      name: 'Synthetic balloon loan',
      principalCents: 120_000,
      accruedInterestCents: 0,
      balanceDate: '2025-12-15',
      annualRateBasisPoints: 0,
      accrualConvention: 'actual-365',
      paymentCents: 50_000,
      nextPaymentDate: '2026-01-01',
      maturityDate: '2026-02-01',
      amortizationStructure: 'balloon',
      expectedBalloonCents: 20_000,
      fundingAccountId: 'cash-a',
    });

    expect(loanAmortizationLedger(loan, '2025-12-15').at(-1)).toEqual(
      expect.objectContaining({
        date: '2026-02-01',
        label: 'Contractual maturity payment',
        cashDraftCents: 70_000,
        principalPaidCents: 70_000,
        remainingDebtCents: 0,
      }),
    );
  });

  it('keeps earliest amount due separate from the newest closed statement display', () => {
    const olderDue = creditCardCycleSchema.parse({
      id: 'older-due',
      cardId: 'card-a',
      opensOn: '2026-01-01',
      closesOn: '2026-01-31',
      dueOn: '2026-02-20',
      state: 'closed-statement',
      defaultEstimateCents: 0,
      actualActivityCents: 40_000,
      plannedActivityCents: 0,
      lockedStatementCents: 40_000,
    });
    const newestLocked = creditCardCycleSchema.parse({
      id: 'newest-locked',
      cardId: 'card-a',
      opensOn: '2026-02-01',
      closesOn: '2026-02-28',
      dueOn: '2026-03-20',
      state: 'scheduled-payment',
      defaultEstimateCents: 0,
      actualActivityCents: 25_000,
      plannedActivityCents: 0,
      lockedStatementCents: 25_000,
    });

    expect(selectCardStatementSummaryCycles([newestLocked, olderDue])).toEqual({
      comingDue: olderDue,
      latestStatement: newestLocked,
    });
  });

  it('calculates aggregate utilization only from cards with known limits', () => {
    expect(
      aggregateKnownLimitCardUtilization([
        { currentBalanceCents: 50_000, creditLimitCents: 200_000 },
        { currentBalanceCents: 900_000 },
      ]),
    ).toEqual({
      currentBalanceCents: 50_000,
      creditLimitCents: 200_000,
      knownLimitCardCount: 1,
      totalCardCount: 2,
      utilizationPercent: 25,
    });
  });

  it('shows true over-limit utilization while clamping only the progress bar', () => {
    expect(cardUtilizationPresentation(240_000, 200_000)).toEqual({
      utilizationPercent: 120,
      barPercent: 100,
    });
    expect(cardUtilizationPresentation(-5_000, 200_000)).toEqual({
      utilizationPercent: 0,
      barPercent: 0,
    });
  });

  it('edits a scheduled card payment in place while preserving its identity and notes', () => {
    const existing = forecastEventSchema.parse({
      id: 'scheduled-card-payment',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-08-15',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 14_470,
      certainty: 'confirmed',
      status: 'scheduled',
      label: 'Original payment',
      sourceRecordId: 'cycle-a',
      hypothetical: false,
      accepted: false,
      paymentMethod: 'cash-account',
      cardId: 'card-a',
      notes: 'Preserve this audit note.',
    });

    const request = scheduledCardPaymentRequest({
      existing,
      newId: 'must-not-replace-existing-id',
      accountId: 'cash-b',
      date: '2026-08-20',
      amountCents: 16_000,
      label: 'Revised payment',
      cardId: 'card-a',
    });
    const payload = request.payload as Record<string, unknown>;

    expect(request.entityType).toBe('forecast-event');
    expect(payload).toEqual(
      expect.objectContaining({
        id: existing.id,
        accountId: 'cash-b',
        date: '2026-08-20',
        amountCents: 16_000,
        label: 'Revised payment',
        notes: 'Preserve this audit note.',
        status: 'scheduled',
      }),
    );
    expect(payload.sourceRecordId).toBeUndefined();
    expect(payload.userId).toBeUndefined();
  });

  it('preserves status and recurring-series lineage when a scheduled card payment is edited', () => {
    const existing = forecastEventSchema.parse({
      id: 'recurring-card-payment',
      userId: 'profile-a',
      accountId: 'cash-a',
      date: '2026-08-15',
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: 10_000,
      certainty: 'expected',
      status: 'planned',
      label: 'Original recurring payment',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 15, interval: 1 },
      recurrenceEndDate: '2027-08-15',
      hypothetical: true,
      accepted: true,
      paymentMethod: 'cash-account',
      cardId: 'card-a',
      notes: 'Series lineage must survive the edit.',
    });

    const request = scheduledCardPaymentRequest({
      existing,
      newId: 'unused-id',
      accountId: 'cash-b',
      date: '2026-09-15',
      amountCents: 12_500,
      label: 'Revised recurring payment',
      cardId: 'card-a',
    });

    expect(request.payload).toEqual(
      expect.objectContaining({
        id: existing.id,
        status: 'planned',
        certainty: 'expected',
        recurrenceRule: existing.recurrenceRule,
        recurrenceEndDate: existing.recurrenceEndDate,
        hypothetical: true,
        accepted: true,
        notes: 'Series lineage must survive the edit.',
      }),
    );
  });

  it('uses the modeled latest closed statement and falls back to stored history', () => {
    const stored = creditCardCycleSchema.parse({
      id: 'stored-statement',
      cardId: 'card-a',
      opensOn: '2026-05-01',
      closesOn: '2026-05-31',
      dueOn: '2026-06-20',
      state: 'paid',
      defaultEstimateCents: 0,
      actualActivityCents: 20_000,
      plannedActivityCents: 0,
      lockedStatementCents: 20_000,
    });

    expect(
      latestClosedStatementForReconciliation({
        cardId: 'card-a',
        asOfDate: '2026-07-15',
        cycles: [stored],
        modeled: { latestStatementCents: 25_000, latestStatementDate: '2026-06-30' },
      }),
    ).toEqual({ amountCents: 25_000, date: '2026-06-30' });
    expect(
      latestClosedStatementForReconciliation({
        cardId: 'card-a',
        asOfDate: '2026-07-15',
        cycles: [stored],
      }),
    ).toEqual({ amountCents: 20_000, date: '2026-05-31' });
  });

  it('shows zero before replacement closing and after source payoff, with both loans active during overlap', () => {
    const account = cashAccountSchema.parse({
      id: 'cash-a',
      userId: 'profile-a',
      name: 'Synthetic checking',
      type: 'checking',
      openingBalanceCents: 500_000,
      balanceAsOf: '2026-07-15',
    });
    const source = loanSchema.parse({
      id: 'source-loan',
      userId: 'profile-a',
      name: 'Source loan',
      principalCents: 100_000,
      accruedInterestCents: 0,
      balanceDate: '2026-07-15',
      annualRateBasisPoints: 600,
      accrualConvention: 'actual-365',
      paymentCents: 10_000,
      nextPaymentDate: '2026-07-23',
      fundingAccountId: account.id,
    });
    const replacement = loanSchema.parse({
      ...source,
      id: 'replacement-loan',
      name: 'Replacement loan',
      balanceDate: '2026-07-20',
      originalDate: '2026-07-20',
      originalPrincipalCents: 100_000,
      nextPaymentDate: '2026-07-22',
    });
    const plan = committedRefinancePlanSchema.parse({
      id: 'refinance-a',
      userId: 'profile-a',
      name: 'Synthetic refinance',
      status: 'committed',
      closingDate: '2026-07-20',
      payoffDate: '2026-07-25',
      firstPaymentDate: '2026-07-22',
      payoffs: [{ sourceLoanId: source.id, payoffAmountCents: 100_000 }],
      replacementLoan: replacement,
      replacementLoanSnapshot: replacement,
      assetRelinks: [],
      principalCashContributionCents: 0,
      closingCostsCents: 0,
      financedFeesCents: 0,
      excessProceedsCents: 0,
    });
    const effectiveOn = (date: '2026-07-19' | '2026-07-22' | '2026-07-25') =>
      new Map(
        activeLoansForDate({
          accounts: [account],
          loans: [source, replacement],
          plans: [plan],
          date,
        }).map((loan) => [loan.id, loan] as const),
      );

    const before = effectiveOn('2026-07-19');
    expect(
      effectiveLoanPageMetrics(replacement, before.get(replacement.id), '2026-07-19'),
    ).toMatchObject({ active: false, modeled: { totalCents: 0 }, nextPaymentDate: null });
    const overlap = effectiveOn('2026-07-22');
    expect(effectiveLoanPageMetrics(source, overlap.get(source.id), '2026-07-22').active).toBe(
      true,
    );
    expect(
      effectiveLoanPageMetrics(replacement, overlap.get(replacement.id), '2026-07-22').modeled
        .totalCents,
    ).toBeGreaterThan(0);
    const afterPayoff = effectiveOn('2026-07-25');
    expect(
      effectiveLoanPageMetrics(source, afterPayoff.get(source.id), '2026-07-25'),
    ).toMatchObject({ active: false, modeled: { totalCents: 0 }, nextPaymentDate: null });
    expect(
      effectiveLoanPageMetrics(replacement, afterPayoff.get(replacement.id), '2026-07-25').active,
    ).toBe(true);
  });

  it('prefers the modeled current cash balance and only falls back when it is unavailable', () => {
    const account = { id: 'cash-a', openingBalanceCents: 25_000 };
    const snapshotAccounts = [
      {
        id: 'cash-a',
        name: 'Primary checking',
        balanceCents: 18_750,
        hardFloorCents: 0,
      },
    ];

    expect(netWorthCashBalance(account, snapshotAccounts)).toEqual({
      balanceCents: 18_750,
      modeled: true,
    });
    expect(netWorthCashBalance(account, undefined)).toEqual({
      balanceCents: 25_000,
      modeled: false,
    });
  });
});
