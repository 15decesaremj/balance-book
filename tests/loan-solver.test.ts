import { describe, expect, it } from 'vitest';
import {
  solveInstallmentLoanSetup,
  type InstallmentLoanSetupInput,
  type InstallmentLoanSetupResult,
} from '@balance-book/financial-engine';

const expectFiniteResult = (result: InstallmentLoanSetupResult): void => {
  const visit = (value: unknown): void => {
    if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(result);
};

describe('partial installment-loan setup solver', () => {
  it('infers payment from original amount, date, term, and APR', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-01-31',
      originalPrincipalCents: 1_200_000,
      originalDate: '2026-01-31',
      originalTermMonths: 12,
      annualRateBasisPoints: 0,
      balanceDate: '2026-01-31',
      accruedInterestCents: 0,
      nextPaymentDate: '2026-02-28',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.resolved).toMatchObject({
      principalCents: 1_200_000,
      paymentCents: 100_000,
      nextPaymentDate: '2026-02-28',
      maturityDate: '2027-01-31',
    });
    expect(result.inferredFields).toEqual(
      expect.arrayContaining(['principalCents', 'paymentCents', 'maturityDate']),
    );
    expect(result.payoff).toMatchObject({
      exact: true,
      payoffPeriods: 12,
      totalRemainingPaymentsCents: 1_200_000,
      remainingInterestCents: 0,
    });
  });

  it('infers APR from original terms and payment to whole-basis-point precision', () => {
    const priced = solveInstallmentLoanSetup({
      asOfDate: '2026-01-15',
      originalPrincipalCents: 2_400_000,
      originalDate: '2026-01-15',
      originalTermMonths: 36,
      annualRateBasisPoints: 675,
    });
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-01-15',
      originalPrincipalCents: 2_400_000,
      originalDate: '2026-01-15',
      originalTermMonths: 36,
      paymentCents: priced.resolved.paymentCents,
    });

    expect(['exact', 'approximate']).toContain(result.status);
    expect(result.resolved.annualRateBasisPoints).toBeGreaterThanOrEqual(670);
    expect(result.resolved.annualRateBasisPoints).toBeLessThanOrEqual(680);
    expect(result.inferredFields).toContain('annualRateBasisPoints');
    expect(result.diagnostics.reconciliations).toContainEqual(
      expect.objectContaining({ check: 'original-payment', outcome: 'matched' }),
    );
  });

  it('infers exact payoff and original term from original amount, date, APR, and payment', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-01-31',
      originalPrincipalCents: 1_200_000,
      originalDate: '2026-01-31',
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      balanceDate: '2026-01-31',
      accruedInterestCents: 0,
      nextPaymentDate: '2026-02-28',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.payoff).toMatchObject({
      payoffDate: '2027-01-31',
      payoffPeriods: 12,
      remainingInterestCents: 0,
    });
    expect(result.resolved.originalTermMonths).toBe(12);
    expect(result.resolved.maturityDate).toBe('2027-01-31');
  });

  it('returns an exact remaining payoff from a dated current snapshot', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2028-01-31',
      principalCents: 1_000_000,
      balanceDate: '2028-01-31',
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      nextPaymentDate: '2028-02-29',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.payoff).toEqual({
      exact: true,
      payoffDate: '2028-11-29',
      payoffPeriods: 10,
      payoffMonths: 10,
      totalRemainingPaymentsCents: 1_000_000,
      remainingInterestCents: 0,
      finalPaymentCents: 100_000,
      balloonCents: 0,
    });
  });

  it('solves payment and APR independently from a current balance and maturity', () => {
    const payment = solveInstallmentLoanSetup({
      asOfDate: '2028-01-31',
      principalCents: 1_200_000,
      balanceDate: '2028-01-31',
      annualRateBasisPoints: 0,
      maturityDate: '2029-01-31',
      accruedInterestCents: 0,
      nextPaymentDate: '2028-02-29',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(payment.status).toBe('exact');
    expect(payment.resolved.paymentCents).toBe(100_000);

    const rate = solveInstallmentLoanSetup({
      asOfDate: '2028-01-31',
      principalCents: 1_200_000,
      balanceDate: '2028-01-31',
      paymentCents: 100_000,
      maturityDate: '2029-01-31',
      accruedInterestCents: 0,
      nextPaymentDate: '2028-02-29',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(rate.status).toBe('exact');
    expect(rate.resolved.annualRateBasisPoints).toBe(0);
  });

  it('does not invent an extra maturity payment when a February date is a constrained anchor', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2028-01-31',
      principalCents: 300_000,
      balanceDate: '2028-01-31',
      annualRateBasisPoints: 0,
      nextPaymentDate: '2028-02-29',
      maturityDate: '2028-04-30',
      accruedInterestCents: 0,
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.resolved.paymentCents).toBe(100_000);
    expect(result.payoff).toMatchObject({
      payoffDate: '2028-04-30',
      payoffPeriods: 3,
      finalPaymentCents: 100_000,
      balloonCents: 0,
    });
  });

  it('projects current principal from the original schedule', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2025-06-30',
      originalPrincipalCents: 1_200_000,
      originalDate: '2025-01-31',
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      balanceDate: '2025-06-30',
      accruedInterestCents: 0,
      nextPaymentDate: '2025-07-31',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.resolved).toMatchObject({
      balanceDate: '2025-06-30',
      principalCents: 700_000,
      accruedInterestCents: 0,
      nextPaymentDate: '2025-07-31',
    });
  });

  it('solves payment from two authoritative dated principal snapshots when APR is known', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2025-06-30',
      principalCents: 700_000,
      balanceDate: '2025-06-30',
      accruedInterestCents: 0,
      originalPrincipalCents: 1_200_000,
      originalDate: '2025-01-31',
      annualRateBasisPoints: 0,
      nextPaymentDate: '2025-07-31',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.resolved.paymentCents).toBe(100_000);
    expect(result.inferredFields).toContain('paymentCents');
    expect(result.diagnostics.reconciliations).toContainEqual(
      expect.objectContaining({ check: 'current-balance', outcome: 'matched' }),
    );
    expect(result.payoff).toMatchObject({ payoffPeriods: 7, payoffDate: '2026-01-31' });
  });

  it('solves whole-basis-point APR from two dated snapshots when payment is known', () => {
    const priced = solveInstallmentLoanSetup({
      asOfDate: '2026-01-15',
      balanceDate: '2026-01-15',
      accruedInterestCents: 0,
      originalPrincipalCents: 2_400_000,
      originalDate: '2026-01-15',
      originalTermMonths: 36,
      annualRateBasisPoints: 675,
      nextPaymentDate: '2026-02-15',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    const paymentCents = priced.resolved.paymentCents!;
    const snapshot = solveInstallmentLoanSetup({
      asOfDate: '2026-07-15',
      balanceDate: '2026-07-15',
      accruedInterestCents: 0,
      originalPrincipalCents: 2_400_000,
      originalDate: '2026-01-15',
      annualRateBasisPoints: 675,
      paymentCents,
      nextPaymentDate: '2026-08-15',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-07-15',
      principalCents: snapshot.resolved.principalCents,
      balanceDate: '2026-07-15',
      accruedInterestCents: 0,
      originalPrincipalCents: 2_400_000,
      originalDate: '2026-01-15',
      paymentCents,
      nextPaymentDate: '2026-08-15',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(['exact', 'approximate']).toContain(result.status);
    expect(result.resolved.annualRateBasisPoints).toBeGreaterThanOrEqual(670);
    expect(result.resolved.annualRateBasisPoints).toBeLessThanOrEqual(680);
    expect(result.inferredFields).toContain('annualRateBasisPoints');
    expect(result.diagnostics.reconciliations).toContainEqual(
      expect.objectContaining({ check: 'current-balance', outcome: 'matched' }),
    );
  });

  it('infers original date at a whole cadence and reverse-solves unique original principal', () => {
    const date = solveInstallmentLoanSetup({
      asOfDate: '2025-06-30',
      principalCents: 700_000,
      balanceDate: '2025-06-30',
      originalPrincipalCents: 1_200_000,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      accruedInterestCents: 0,
      nextPaymentDate: '2025-07-31',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(date.status).toBe('approximate');
    expect(date.resolved.originalDate).toBe('2025-01-31');
    expect(date.inferredFields).toContain('originalDate');

    const principal = solveInstallmentLoanSetup({
      asOfDate: '2025-06-30',
      principalCents: 700_000,
      balanceDate: '2025-06-30',
      originalDate: '2025-01-31',
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      accruedInterestCents: 0,
      nextPaymentDate: '2025-07-31',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(principal.status).toBe('exact');
    expect(principal.resolved.originalPrincipalCents).toBe(1_200_000);
    expect(principal.inferredFields).toContain('originalPrincipalCents');
  });

  it('keeps an authoritative lender balance when a missing original date only reconciles approximately', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-07-13',
      principalCents: 550_000,
      balanceDate: '2026-07-12',
      originalPrincipalCents: 775_000,
      annualRateBasisPoints: 625,
      paymentCents: 18_500,
      accruedInterestCents: 0,
      nextPaymentDate: '2026-08-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('approximate');
    expect(result.resolved.principalCents).toBe(550_000);
    expect(result.inferredFields).toContain('originalDate');
    expect(result.diagnostics.reconciliations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'original-date', outcome: 'approximate' }),
        expect.objectContaining({ check: 'current-balance', outcome: 'approximate' }),
        expect.objectContaining({ check: 'current-accrued-interest', outcome: 'approximate' }),
      ]),
    );
    expect(result.diagnostics.contradictions).toEqual([]);
    expect(result.payoff?.payoffDate).toBeDefined();
  });

  it('handles leap/EOM anchors and biweekly payoff dates without wall-clock math', () => {
    const leap = solveInstallmentLoanSetup({
      asOfDate: '2028-01-31',
      originalPrincipalCents: 1_200_000,
      originalDate: '2028-01-31',
      originalTermMonths: 12,
      annualRateBasisPoints: 0,
      balanceDate: '2028-01-31',
      accruedInterestCents: 0,
      nextPaymentDate: '2028-02-29',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(leap.resolved.nextPaymentDate).toBe('2028-02-29');
    expect(leap.status).toBe('exact');

    const biweekly = solveInstallmentLoanSetup({
      asOfDate: '2028-01-01',
      principalCents: 260_000,
      annualRateBasisPoints: 0,
      paymentCents: 10_000,
      nextPaymentDate: '2028-01-15',
      paymentFrequency: 'biweekly',
      balanceDate: '2028-01-01',
      accruedInterestCents: 0,
      accrualConvention: 'actual-365',
    });
    expect(biweekly.status).toBe('exact');
    expect(biweekly.payoff).toMatchObject({
      payoffDate: '2028-12-30',
      payoffPeriods: 26,
      totalRemainingPaymentsCents: 260_000,
    });
  });

  it('keeps cash draft separate from debt amortization', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      cashPaymentCents: 135_000,
      nextPaymentDate: '2026-02-01',
      balanceDate: '2026-01-01',
      accruedInterestCents: 0,
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.resolved.cashPaymentCents).toBe(135_000);
    expect(result.payoff).toMatchObject({
      payoffPeriods: 12,
      totalRemainingPaymentsCents: 1_200_000,
    });

    const impossibleDraft = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      cashPaymentCents: 99_999,
      nextPaymentDate: '2026-02-01',
    });
    expect(impossibleDraft.status).toBe('inconsistent');
    expect(impossibleDraft.diagnostics.contradictions.join(' ')).toMatch(/cash payment/i);
  });

  it('labels a sparse current snapshot approximate when cadence and snapshot facts default', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
    });

    expect(result.status).toBe('approximate');
    expect(result.payoff).toMatchObject({ payoffPeriods: 12 });
    expect(result.inferredFields).toEqual(
      expect.arrayContaining([
        'balanceDate',
        'accruedInterestCents',
        'paymentFrequency',
        'accrualConvention',
        'nextPaymentDate',
      ]),
    );
    expect(result.assumptions.join(' ')).toMatch(/Balance date defaults/i);
    expect(result.assumptions.join(' ')).toMatch(/Accrued interest defaults/i);
    expect(result.assumptions.join(' ')).toMatch(/Payment frequency defaults/i);
    expect(result.assumptions.join(' ')).toMatch(/Interest accrual defaults/i);
    expect(result.assumptions.join(' ')).toMatch(/Next payment date defaults/i);
  });

  it('keeps origination date separate from an explicit monthly due-day anchor', () => {
    const setup = solveInstallmentLoanSetup({
      asOfDate: '2026-01-15',
      balanceDate: '2026-01-15',
      accruedInterestCents: 0,
      originalPrincipalCents: 1_200_000,
      originalDate: '2026-01-15',
      originalTermMonths: 12,
      annualRateBasisPoints: 0,
      nextPaymentDate: '2026-02-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(setup.status).toBe('exact');
    expect(setup.resolved).toMatchObject({
      paymentCents: 100_000,
      maturityDate: '2027-01-01',
    });
    expect(setup.payoff).toMatchObject({ payoffDate: '2027-01-01', payoffPeriods: 12 });

    const laterSnapshot = solveInstallmentLoanSetup({
      asOfDate: '2026-04-15',
      balanceDate: '2026-04-15',
      accruedInterestCents: 0,
      originalPrincipalCents: 1_200_000,
      originalDate: '2026-01-15',
      originalTermMonths: 12,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      nextPaymentDate: '2026-05-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(laterSnapshot.status).toBe('exact');
    expect(laterSnapshot.resolved.principalCents).toBe(900_000);
    expect(laterSnapshot.resolved.maturityDate).toBe('2027-01-01');

    const nonEomOrigination = solveInstallmentLoanSetup({
      asOfDate: '2026-01-30',
      balanceDate: '2026-01-30',
      accruedInterestCents: 0,
      originalPrincipalCents: 1_200_000,
      originalDate: '2026-01-30',
      originalTermMonths: 12,
      annualRateBasisPoints: 0,
      nextPaymentDate: '2026-02-28',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });
    expect(nonEomOrigination.status).toBe('exact');
    expect(nonEomOrigination.resolved.maturityDate).toBe('2027-01-28');
  });

  it('infers a delayed-first-payment monthly term from payment count and round-trips it', () => {
    const input = {
      asOfDate: '2026-01-15',
      principalCents: 1_200_000,
      balanceDate: '2026-01-15',
      accruedInterestCents: 0,
      originalPrincipalCents: 1_200_000,
      originalDate: '2026-01-15',
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      nextPaymentDate: '2026-03-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    } satisfies InstallmentLoanSetupInput;
    const inferred = solveInstallmentLoanSetup(input);

    expect(inferred.status).toBe('exact');
    expect(inferred.resolved.originalTermMonths).toBe(12);
    expect(inferred.resolved.maturityDate).toBe('2027-02-01');
    expect(inferred.payoff).toMatchObject({ payoffDate: '2027-02-01', payoffPeriods: 12 });

    const roundTrip = solveInstallmentLoanSetup({
      ...input,
      originalTermMonths: inferred.resolved.originalTermMonths,
    });
    expect(roundTrip.status).toBe('exact');
    expect(roundTrip.resolved.maturityDate).toBe(inferred.resolved.maturityDate);
    expect(roundTrip.resolved.paymentCents).toBe(input.paymentCents);
  });

  it('preserves an exact biweekly payoff without inventing an original month term', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2028-01-01',
      principalCents: 260_000,
      balanceDate: '2028-01-01',
      accruedInterestCents: 0,
      originalPrincipalCents: 260_000,
      originalDate: '2028-01-01',
      annualRateBasisPoints: 0,
      paymentCents: 10_000,
      nextPaymentDate: '2028-01-15',
      paymentFrequency: 'biweekly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('approximate');
    expect(result.resolved.originalTermMonths).toBeUndefined();
    expect(result.resolved.maturityDate).toBe('2028-12-30');
    expect(result.inferredFields).toContain('maturityDate');
    expect(result.inferredFields).not.toContain('originalTermMonths');
    expect(result.assumptions.join(' ')).toMatch(/calendar months is an approximate display/i);
    expect(result.payoff).toMatchObject({ payoffDate: '2028-12-30', payoffPeriods: 26 });
  });

  it('rejects a next contractual payment after maturity', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 100_000,
      balanceDate: '2026-01-01',
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      nextPaymentDate: '2026-03-01',
      maturityDate: '2026-02-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('inconsistent');
    expect(result.diagnostics.contradictions.join(' ')).toMatch(/next payment date.*maturity/i);
  });

  it('reconciles a delayed first payment against the cadence-aware original maturity', () => {
    const result = solveInstallmentLoanSetup({
      asOfDate: '2026-01-15',
      balanceDate: '2026-01-15',
      accruedInterestCents: 0,
      principalCents: 36_000_000,
      originalPrincipalCents: 36_000_000,
      originalDate: '2026-01-15',
      originalTermMonths: 360,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      nextPaymentDate: '2026-03-01',
      maturityDate: '2056-02-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    });

    expect(result.status).toBe('exact');
    expect(result.diagnostics.reconciliations).toContainEqual(
      expect.objectContaining({
        check: 'original-maturity',
        outcome: 'matched',
        residualDays: 0,
      }),
    );
    expect(result.payoff).toMatchObject({
      payoffDate: '2056-02-01',
      payoffPeriods: 360,
    });
  });

  it('reports contradictory redundant terms and non-amortizing payments', () => {
    const contradiction = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      originalPrincipalCents: 1_200_000,
      originalDate: '2026-01-01',
      originalTermMonths: 12,
      annualRateBasisPoints: 0,
      paymentCents: 90_000,
    });
    expect(contradiction.status).toBe('inconsistent');
    expect(contradiction.diagnostics.reconciliations).toContainEqual(
      expect.objectContaining({ check: 'original-payment', outcome: 'conflict' }),
    );

    const nonAmortizing = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_000_000,
      annualRateBasisPoints: 1_200,
      paymentCents: 500,
      nextPaymentDate: '2026-02-01',
    });
    expect(nonAmortizing.status).toBe('inconsistent');
    expect(nonAmortizing.diagnostics.nonAmortizing).toBe(true);
    expect(nonAmortizing.payoff).toBeNull();
  });

  it('accepts an explicit contractual balloon and rejects the same terms as fully amortizing', () => {
    const terms = {
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      balanceDate: '2026-01-01',
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      paymentCents: 50_000,
      nextPaymentDate: '2026-02-01',
      maturityDate: '2027-01-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
    } satisfies InstallmentLoanSetupInput;
    const balloon = solveInstallmentLoanSetup({
      ...terms,
      amortizationStructure: 'balloon',
      expectedBalloonCents: 600_000,
    });

    expect(balloon.status).toBe('exact');
    expect(balloon.payoff).toMatchObject({
      payoffDate: '2027-01-01',
      finalPaymentCents: 650_000,
      balloonCents: 600_000,
    });
    expect(balloon.diagnostics.reconciliations).toContainEqual(
      expect.objectContaining({ check: 'balloon', outcome: 'matched', residualCents: 0 }),
    );

    const calculatedBalloon = solveInstallmentLoanSetup({
      ...terms,
      amortizationStructure: 'balloon',
    });
    expect(calculatedBalloon.status).toBe('exact');
    expect(calculatedBalloon.resolved.expectedBalloonCents).toBe(600_000);
    expect(calculatedBalloon.inferredFields).toContain('expectedBalloonCents');

    const fullyAmortizing = solveInstallmentLoanSetup({
      ...terms,
      amortizationStructure: 'fully-amortizing',
    });
    expect(fullyAmortizing.status).toBe('inconsistent');
    expect(fullyAmortizing.diagnostics.contradictions.join(' ')).toMatch(/do not reconcile/i);
  });

  it('infers a regular payment from an explicit balloon and supports a zero-payment bullet loan', () => {
    const inferredPayment = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      balanceDate: '2026-01-01',
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      nextPaymentDate: '2026-02-01',
      maturityDate: '2027-01-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
      amortizationStructure: 'balloon',
      expectedBalloonCents: 600_000,
    });
    expect(inferredPayment.status).toBe('exact');
    expect(inferredPayment.resolved.paymentCents).toBe(50_000);
    expect(inferredPayment.payoff?.balloonCents).toBe(600_000);

    const bullet = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      balanceDate: '2026-01-01',
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      paymentCents: 0,
      nextPaymentDate: '2027-01-01',
      maturityDate: '2027-01-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
      amortizationStructure: 'balloon',
      expectedBalloonCents: 1_200_000,
    });
    expect(bullet.status).toBe('exact');
    expect(bullet.payoff).toMatchObject({
      payoffDate: '2027-01-01',
      finalPaymentCents: 1_200_000,
      balloonCents: 1_200_000,
    });
  });

  it('requires an explicit maturity and reconciles a stated balloon amount', () => {
    const missingMaturity = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      balanceDate: '2026-01-01',
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      paymentCents: 50_000,
      nextPaymentDate: '2026-02-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
      amortizationStructure: 'balloon',
    });
    expect(missingMaturity.status).toBe('inconsistent');
    expect(missingMaturity.diagnostics.contradictions.join(' ')).toMatch(/requires a maturity/i);

    const mismatch = solveInstallmentLoanSetup({
      asOfDate: '2026-01-01',
      principalCents: 1_200_000,
      balanceDate: '2026-01-01',
      accruedInterestCents: 0,
      annualRateBasisPoints: 0,
      paymentCents: 50_000,
      nextPaymentDate: '2026-02-01',
      maturityDate: '2027-01-01',
      paymentFrequency: 'monthly',
      accrualConvention: 'actual-365',
      amortizationStructure: 'balloon',
      expectedBalloonCents: 599_999,
    });
    expect(mismatch.status).toBe('inconsistent');
    expect(mismatch.diagnostics.reconciliations).toContainEqual(
      expect.objectContaining({ check: 'balloon', outcome: 'conflict' }),
    );
  });

  it('returns incomplete alternatives and contains malformed runtime input safely', () => {
    const incomplete = solveInstallmentLoanSetup({ asOfDate: '2026-01-01' });
    expect(incomplete.status).toBe('incomplete');
    expect(incomplete.missingAlternatives[0]?.missingFields.length).toBeGreaterThan(0);

    expect(() =>
      solveInstallmentLoanSetup({
        asOfDate: 'not-a-date',
        principalCents: Number.NaN,
        annualRateBasisPoints: -1,
      } as unknown as InstallmentLoanSetupInput),
    ).not.toThrow();
    const malformed = solveInstallmentLoanSetup({
      asOfDate: 'not-a-date',
      principalCents: Number.NaN,
      annualRateBasisPoints: -1,
    } as unknown as InstallmentLoanSetupInput);
    expect(malformed.status).toBe('inconsistent');
    expect(malformed.diagnostics.inputErrors.length).toBeGreaterThan(0);
    expectFiniteResult(malformed);
  });

  it('is deterministic and finite across all 128 subsets of seven consistent facts', () => {
    const facts = {
      originalPrincipalCents: 200_000,
      originalDate: '2026-01-31',
      originalTermMonths: 2,
      annualRateBasisPoints: 0,
      paymentCents: 100_000,
      principalCents: 200_000,
      maturityDate: '2026-03-31',
    } satisfies Omit<InstallmentLoanSetupInput, 'asOfDate'>;
    const entries = Object.entries(facts) as Array<
      [keyof typeof facts, (typeof facts)[keyof typeof facts]]
    >;

    for (let mask = 0; mask < 1 << entries.length; mask += 1) {
      const input: InstallmentLoanSetupInput = { asOfDate: '2026-01-31' };
      entries.forEach(([field, value], index) => {
        if ((mask & (1 << index)) !== 0) Object.assign(input, { [field]: value });
      });
      const first = solveInstallmentLoanSetup(input);
      const second = solveInstallmentLoanSetup(input);
      expect(second).toEqual(first);
      expect(['exact', 'approximate', 'incomplete', 'inconsistent']).toContain(first.status);
      expectFiniteResult(first);
      expect(first.diagnostics.iterations).toBeLessThan(500);
    }
  }, 15_000);
});
