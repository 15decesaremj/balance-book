import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  cashAccountSchema,
  decimalToCents,
  enumerateDates,
  receivableSchema,
} from '@balance-book/domain';
import {
  accrueSimpleInterest,
  allocateLoanPayment,
  expandRecurrence,
  roundInterestToCents,
} from '@balance-book/financial-engine';

describe('exact money and financial dates', () => {
  it('rounds half-up into exact integer cents', () => {
    expect(decimalToCents(new Decimal('10.005'))).toBe(1001);
  });

  it('keeps leap-day date math timezone-free', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(enumerateDates('2028-02-28', '2028-03-01')).toHaveLength(3);
  });

  it('shows cash accounts on Overview by default while preserving an explicit hidden choice', () => {
    const account = {
      id: 'cash-a',
      userId: 'profile-a',
      name: 'Synthetic checking',
      type: 'checking' as const,
      openingBalanceCents: 100_000,
      balanceAsOf: '2026-07-15',
    };

    expect(cashAccountSchema.parse(account).showOnOverview).toBe(true);
    expect(cashAccountSchema.parse({ ...account, showOnOverview: false }).showOnOverview).toBe(
      false,
    );
  });

  it('constrains monthly recurrences to month end', () => {
    expect(
      expandRecurrence({
        startDate: '2026-01-31',
        endDate: '2026-04-30',
        rule: { frequency: 'monthly', dayOfMonth: 31, interval: 1 },
      }),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('accrues actual/365 interest and allocates interest first', () => {
    const interest = roundInterestToCents(
      accrueSimpleInterest({
        principalCents: 100_000,
        annualRateBasisPoints: 3650,
        fromDate: '2026-01-01',
        toDate: '2026-01-11',
        convention: 'actual-365',
      }),
    );
    expect(interest).toBe(1_000);
    expect(
      allocateLoanPayment({
        principalCents: 100_000,
        accruedInterestCents: interest,
        paymentCents: 11_000,
      }),
    ).toEqual({
      interestPaidCents: 1_000,
      principalPaidCents: 10_000,
      remainingPrincipalCents: 90_000,
      remainingAccruedInterestCents: 0,
      unappliedPaymentCents: 0,
    });
  });

  it('rejects a receivable whose current balance exceeds the amount originally owed', () => {
    expect(() =>
      receivableSchema.parse({
        id: 'invalid-receivable',
        userId: 'profile-a',
        source: 'Synthetic source',
        description: 'Invalid current balance',
        originalAmountCents: 0,
        remainingAmountCents: 1,
        expectedDate: '2026-07-15',
        destinationAccountId: 'cash-a',
        certainty: 'confirmed',
      }),
    ).toThrow(/cannot exceed the original owed amount/i);
  });
});
