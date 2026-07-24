import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceBookStore, applyMigrations, latestSchemaVersion } from '@balance-book/database';
import {
  cashAccountSchema,
  compareDates,
  committedRefinancePlanSchema,
  forecastEventInputSchema,
  forecastEventSchema,
  loanSchema,
  type ForecastEvent,
} from '@balance-book/domain';
import {
  activeLoansForDate,
  analyzeLoanContinuationFromPayoff,
  materializeForecastEvents,
  projectLoanBalanceAtEndOfDate,
  projectLoanPayoffAtDate,
  projectRefinancePayoffsAtDate,
} from '@balance-book/financial-engine';
import {
  refinanceLoanCandidates,
  refinancePlanLifecycle,
} from '../apps/desktop/src/renderer/refinance-view-model';

const account = cashAccountSchema.parse({
  id: 'checking',
  userId: 'user-a',
  name: 'Checking',
  type: 'checking',
  openingBalanceCents: 500_000,
  balanceAsOf: '2026-01-01',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  transferDelayDays: 0,
});

const otherAccount = cashAccountSchema.parse({
  ...account,
  id: 'other-checking',
  name: 'Other checking',
});

const loan = loanSchema.parse({
  id: 'installment-loan',
  userId: 'user-a',
  name: 'Installment loan',
  principalCents: 100_000,
  accruedInterestCents: 0,
  balanceDate: '2026-01-01',
  annualRateBasisPoints: 0,
  accrualConvention: 'actual-365',
  paymentCents: 20_000,
  nextPaymentDate: '2026-01-15',
  fundingAccountId: account.id,
  paymentFrequency: 'monthly',
  includeInCashForecast: true,
  status: 'active',
});

const loanPayment = (overrides: Partial<ForecastEvent> = {}): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'loan-payment-event',
    userId: loan.userId,
    accountId: loan.fundingAccountId,
    date: '2026-01-20',
    kind: 'loan-payment',
    direction: 'outflow',
    amountCents: 30_000,
    certainty: 'confirmed',
    status: 'confirmed',
    label: 'Extra principal',
    sourceRecordId: loan.id,
    paymentMethod: 'cash-account',
    loanPaymentTreatment: 'additional-principal',
    ...overrides,
  });

const withoutUserId = <T extends { userId: string }>(record: T): Omit<T, 'userId'> => {
  const { userId, ...payload } = record;
  void userId;
  return payload;
};

describe('typed installment-loan payment projection', () => {
  it('applies extra principal on its exact date and preserves the regular draft', () => {
    const extra = loanPayment();
    const before = projectLoanBalanceAtEndOfDate(loan, '2026-01-20');
    const after = projectLoanBalanceAtEndOfDate(loan, '2026-01-20', {
      loanPaymentEvents: [extra],
      actualThroughDate: '2026-01-20',
    });

    expect(before.totalCents).toBe(80_000);
    expect(after).toEqual({ principalCents: 50_000, accruedInterestCents: 0, totalCents: 50_000 });

    const cash = materializeForecastEvents({
      accounts: [account],
      events: [extra],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-01-02',
      endDate: '2026-02-15',
    })
      .filter((event) => event.kind === 'loan-payment')
      .map((event) => [event.date, event.amountCents]);
    expect(cash).toEqual([
      ['2026-01-20', 30_000],
      ['2026-01-15', 20_000],
      ['2026-02-15', 20_000],
    ]);
  });

  it('uses the final same-day state when a regular draft and extra principal share a date', () => {
    const sameDayExtra = loanPayment({ date: '2026-01-15' });
    expect(
      projectLoanBalanceAtEndOfDate(loan, '2026-01-15', {
        loanPaymentEvents: [sameDayExtra],
        actualThroughDate: '2026-01-15',
      }),
    ).toEqual({ principalCents: 50_000, accruedInterestCents: 0, totalCents: 50_000 });
  });

  it('caps an excess principal request so no cash disappears without reducing debt', () => {
    const excess = loanPayment({ amountCents: 100_000 });
    const payoff = projectLoanPayoffAtDate(loan, '2026-02-01', {
      loanPaymentEvents: [excess],
      actualThroughDate: '2026-01-01',
    });
    expect(payoff.payoffCents).toBe(0);
    expect(payoff.additionalPrincipalPayments).toEqual([
      expect.objectContaining({
        requestedPrincipalCents: 100_000,
        appliedPrincipalCents: 80_000,
        unappliedPrincipalCents: 20_000,
      }),
    ]);

    const cash = materializeForecastEvents({
      accounts: [account],
      events: [excess],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-01-02',
      endDate: '2026-02-28',
    }).filter((event) => event.kind === 'loan-payment');
    expect(cash.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-01-20', 80_000],
      ['2026-01-15', 20_000],
    ]);
    expect(cash.reduce((total, event) => total + event.amountCents, 0)).toBe(100_000);
  });

  it('applies a recurring extra-principal plan once per dated occurrence', () => {
    const recurringExtra = loanPayment({
      id: 'recurring-extra-principal',
      date: '2026-01-20',
      amountCents: 10_000,
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 20, interval: 1 },
      recurrenceEndDate: '2026-03-20',
    });
    expect(
      projectLoanBalanceAtEndOfDate(loan, '2026-03-20', {
        loanPaymentEvents: [recurringExtra],
        actualThroughDate: '2026-03-20',
      }),
    ).toEqual({ principalCents: 10_000, accruedInterestCents: 0, totalCents: 10_000 });

    const extraCash = materializeForecastEvents({
      accounts: [account],
      events: [recurringExtra],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-01-02',
      endDate: '2026-03-31',
    }).filter(
      (event) => event.kind === 'loan-payment' && event.id.startsWith('recurring-extra-principal@'),
    );
    expect(extraCash.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-01-20', 10_000],
      ['2026-02-20', 10_000],
      ['2026-03-20', 10_000],
    ]);
  });

  it('shortens payoff and lowers remaining interest on an interest-bearing loan', () => {
    const interestLoan = loanSchema.parse({ ...loan, annualRateBasisPoints: 1_200 });
    const extra = loanPayment({ sourceRecordId: interestLoan.id });
    const baseline = projectLoanPayoffAtDate(interestLoan, '2027-01-01');
    const accelerated = projectLoanPayoffAtDate(interestLoan, '2027-01-01', {
      loanPaymentEvents: [extra],
      actualThroughDate: '2026-01-01',
    });
    const interestPaid = (projection: typeof baseline) =>
      projection.scheduledPayments.reduce((total, payment) => total + payment.interestPaidCents, 0);
    expect(accelerated.payoffCents).toBe(0);
    expect(
      compareDates(
        accelerated.scheduledPayments.at(-1)!.date,
        baseline.scheduledPayments.at(-1)!.date,
      ),
    ).toBeLessThan(0);
    expect(interestPaid(accelerated)).toBeLessThan(interestPaid(baseline));
  });

  it('counts applied extra principal in continuation cost, interest, and the payoff date', () => {
    const interestLoan = loanSchema.parse({
      ...loan,
      principalCents: 1_000_000,
      annualRateBasisPoints: 1_200,
      paymentCents: 100_000,
      nextPaymentDate: '2026-02-01',
    });
    const payoffExtra = loanPayment({
      sourceRecordId: interestLoan.id,
      date: '2026-02-01',
      amountCents: 2_000_000,
    });
    const projection = projectLoanPayoffAtDate(interestLoan, '2027-01-01', {
      loanPaymentEvents: [payoffExtra],
      actualThroughDate: '2026-01-01',
    });
    const expectedTotalCents =
      projection.scheduledPayments.reduce(
        (total, payment) => total + payment.appliedPaymentCents,
        0,
      ) +
      projection.additionalPrincipalPayments.reduce(
        (total, payment) => total + payment.appliedPrincipalCents,
        0,
      );
    const continuation = analyzeLoanContinuationFromPayoff({
      loan: interestLoan,
      payoffDate: '2026-01-01',
      payoffAmountCents: 1_000_000,
      loanPaymentEvents: [payoffExtra],
      actualThroughDate: '2026-01-01',
    });

    expect(projection.payoffCents).toBe(0);
    expect(continuation).toMatchObject({
      costKnown: true,
      totalPaymentsCents: expectedTotalCents,
      remainingInterestCents: expectedTotalCents - 1_000_000,
      paidOffDate: '2026-02-01',
    });
    expect(continuation.remainingInterestCents).toBeGreaterThan(0);
  });

  it('does not turn an unresolved past plan into settled current debt reduction', () => {
    const stalePlan = loanPayment({ certainty: 'uncertain', status: 'planned' });
    expect(
      projectLoanBalanceAtEndOfDate(loan, '2026-01-31', {
        loanPaymentEvents: [stalePlan],
        actualThroughDate: '2026-01-31',
      }).totalCents,
    ).toBe(80_000);
    expect(
      projectLoanBalanceAtEndOfDate(loan, '2026-01-31', {
        loanPaymentEvents: [stalePlan],
        actualThroughDate: '2026-01-01',
      }).totalCents,
    ).toBe(50_000);
  });

  it('updates current debt, refinance payoff defaults, eligibility, and lifecycle', () => {
    const payoffExtra = loanPayment({ amountCents: 80_000 });
    expect(
      activeLoansForDate({
        accounts: [account],
        loans: [loan],
        plans: [],
        loanPaymentEvents: [payoffExtra],
        date: '2026-01-20',
      }),
    ).toEqual([]);
    expect(
      projectRefinancePayoffsAtDate({
        loans: [loan],
        sourceLoanIds: [loan.id],
        payoffDate: '2026-02-01',
        loanPaymentEvents: [payoffExtra],
        actualThroughDate: '2026-01-20',
      })[0]?.payoffAmountCents,
    ).toBe(0);
    expect(
      refinanceLoanCandidates({
        loans: [loan],
        plans: [],
        loanPaymentEvents: [payoffExtra],
        asOfDate: '2026-01-20',
      }),
    ).toEqual([]);

    const replacement = loanSchema.parse({
      ...loan,
      id: 'replacement-loan',
      name: 'Replacement loan',
      balanceDate: '2026-01-10',
      nextPaymentDate: '2026-02-15',
    });
    const plan = committedRefinancePlanSchema.parse({
      id: 'refinance-plan',
      userId: loan.userId,
      name: 'Refinance plan',
      status: 'committed',
      closingDate: '2026-01-10',
      payoffDate: '2026-01-12',
      firstPaymentDate: '2026-02-15',
      payoffs: [{ sourceLoanId: loan.id, payoffAmountCents: 100_000 }],
      replacementLoan: replacement,
      principalCashContributionCents: 0,
      closingCostsCents: 0,
      financedFeesCents: 0,
      excessProceedsCents: 0,
    });
    const replacementPayoff = loanPayment({
      id: 'replacement-extra',
      sourceRecordId: replacement.id,
      date: '2026-02-20',
      amountCents: 80_000,
    });
    expect(
      refinancePlanLifecycle({
        plan,
        plans: [plan],
        loanPaymentEvents: [replacementPayoff],
        asOfDate: '2026-02-20',
      }),
    ).toBe('completed');
  });
});

describe('loan payment cash-draft reconciliation', () => {
  it('deduplicates a normal override and keeps additional principal separate', () => {
    const override = loanPayment({
      id: 'regular-draft',
      date: '2026-01-15',
      amountCents: 20_000,
      loanPaymentTreatment: 'scheduled-draft-override',
      status: 'scheduled',
    });
    const extra = loanPayment();
    const events = materializeForecastEvents({
      accounts: [account],
      events: [override, extra],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-01-02',
      endDate: '2026-01-31',
    }).filter((event) => event.kind === 'loan-payment');
    expect(events.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-01-15', 20_000],
      ['2026-01-20', 30_000],
    ]);
  });

  it('reconciles a partial override but never lets it reduce principal twice', () => {
    const partialOverride = loanPayment({
      id: 'partial-draft',
      date: '2026-01-15',
      amountCents: 5_000,
      loanPaymentTreatment: 'scheduled-draft-override',
    });
    const events = materializeForecastEvents({
      accounts: [account],
      events: [partialOverride],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-01-02',
      endDate: '2026-01-31',
    }).filter((event) => event.kind === 'loan-payment');
    expect(events.map((event) => event.amountCents).sort((a, b) => a - b)).toEqual([5_000, 15_000]);
    expect(
      projectLoanBalanceAtEndOfDate(loan, '2026-01-15', {
        loanPaymentEvents: [partialOverride],
      }).totalCents,
    ).toBe(80_000);
  });

  it('keeps an over-override as authoritative cash without changing contractual principal', () => {
    const overOverride = loanPayment({
      id: 'over-draft',
      date: '2026-01-15',
      amountCents: 25_000,
      loanPaymentTreatment: 'scheduled-draft-override',
    });
    const events = materializeForecastEvents({
      accounts: [account],
      events: [overOverride],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-01-02',
      endDate: '2026-01-31',
    }).filter((event) => event.kind === 'loan-payment');

    expect(events.map((event) => event.amountCents)).toEqual([25_000]);
    expect(
      projectLoanBalanceAtEndOfDate(loan, '2026-01-15', {
        loanPaymentEvents: [overOverride],
      }).totalCents,
    ).toBe(80_000);
  });

  it('reconciles every occurrence of a recurring scheduled-draft override', () => {
    const recurringOverride = loanPayment({
      id: 'recurring-regular-draft',
      date: '2026-01-15',
      amountCents: 20_000,
      loanPaymentTreatment: 'scheduled-draft-override',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 15, interval: 1 },
      recurrenceEndDate: '2026-02-15',
    });
    const events = materializeForecastEvents({
      accounts: [account],
      events: [recurringOverride],
      cards: [],
      cardCycles: [],
      loans: [loan],
      startDate: '2026-01-02',
      endDate: '2026-02-28',
    }).filter((event) => event.kind === 'loan-payment');

    expect(events.map((event) => [event.date, event.amountCents])).toEqual([
      ['2026-01-15', 20_000],
      ['2026-02-15', 20_000],
    ]);
  });

  it('prevents stale linked instructions from leaking cash while preserving unlinked legacy cash', () => {
    const futureExtra = loanPayment({
      id: 'future-extra-principal',
      date: '2026-01-20',
      status: 'scheduled',
    });
    const cashFor = (candidateLoan: typeof loan, events: ForecastEvent[]) =>
      materializeForecastEvents({
        accounts: [account, otherAccount],
        events,
        cards: [],
        cardCycles: [],
        loans: [candidateLoan],
        startDate: '2026-01-02',
        endDate: '2026-01-31',
      }).filter((event) => event.kind === 'loan-payment');

    expect(cashFor(loanSchema.parse({ ...loan, status: 'paid-off' }), [futureExtra])).toEqual([]);
    expect(
      cashFor(loanSchema.parse({ ...loan, includeInCashForecast: false }), [futureExtra]),
    ).toEqual([]);

    const staleAccountOverride = loanPayment({
      id: 'stale-account-override',
      accountId: otherAccount.id,
      date: '2026-01-15',
      amountCents: 20_000,
      status: 'scheduled',
      loanPaymentTreatment: 'scheduled-draft-override',
    });
    expect(
      cashFor(loan, [staleAccountOverride]).map((event) => ({
        accountId: event.accountId,
        amountCents: event.amountCents,
        date: event.date,
      })),
    ).toEqual([{ accountId: account.id, amountCents: 20_000, date: '2026-01-15' }]);

    const unlinkedLegacy = loanPayment({
      id: 'unlinked-legacy-payment',
      sourceRecordId: undefined,
    });
    expect(cashFor(loan, [unlinkedLegacy]).some((event) => event.id === unlinkedLegacy.id)).toBe(
      true,
    );
  });

  it('rejects payroll deductions and non-cash methods at the input contract', () => {
    const payload = {
      id: 'invalid-payroll-loan-payment',
      accountId: account.id,
      date: '2026-01-20',
      kind: 'loan-payment' as const,
      direction: 'outflow' as const,
      amountCents: 10_000,
      certainty: 'confirmed' as const,
      status: 'planned' as const,
      label: 'Invalid payroll loan payment',
      sourceRecordId: loan.id,
      paymentMethod: 'payroll-deduction' as const,
      loanPaymentTreatment: 'additional-principal' as const,
    };
    expect(forecastEventInputSchema.safeParse(payload).success).toBe(false);
    expect(
      forecastEventInputSchema.safeParse({ ...payload, paymentMethod: 'credit-card' }).success,
    ).toBe(false);
  });
});

const directories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-loan-payment-'));
  directories.push(directory);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'backups'),
  });
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) if (store.raw.open) store.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('loan payment persistence and validation', () => {
  it('persists treatment and rejects wrong dates, accounts, methods, and payroll deductions', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'user-a', displayName: 'User A', username: 'user-a' }]);
    for (const cash of [account, otherAccount]) {
      store.upsertManagedEntity('user-a', 'cash-account', withoutUserId(cash));
    }
    store.updateCashFloorPolicy('user-a', {
      hardConsolidatedFloorCents: 0,
      horizonDays: 90,
      includeConfirmedReceivablesConservatively: true,
    });
    store.upsertManagedEntity('user-a', 'loan', withoutUserId(loan));

    const regular = loanPayment({
      id: 'stored-regular-draft',
      date: '2026-01-15',
      amountCents: 20_000,
      loanPaymentTreatment: undefined,
    });
    store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(regular));
    expect(store.getManagedRecords('user-a').events).toContainEqual(
      expect.objectContaining({
        id: regular.id,
        loanPaymentTreatment: 'scheduled-draft-override',
      }),
    );

    const late = loanPayment({ id: 'late-override', date: '2026-01-16' });
    expect(() =>
      store.upsertManagedEntity('user-a', 'forecast-event', {
        ...withoutUserId(late),
        loanPaymentTreatment: 'scheduled-draft-override',
      }),
    ).toThrow(/contractual payment schedule/i);

    const early = loanPayment({ id: 'early-override', date: '2026-01-14' });
    expect(() =>
      store.upsertManagedEntity('user-a', 'forecast-event', {
        ...withoutUserId(early),
        loanPaymentTreatment: 'scheduled-draft-override',
      }),
    ).toThrow(/contractual payment schedule/i);

    const wrongAccount = loanPayment({ id: 'wrong-account', accountId: otherAccount.id });
    expect(() =>
      store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(wrongAccount)),
    ).toThrow(/payment account/i);

    const wrongMethod = loanPayment({ id: 'wrong-method', paymentMethod: 'credit-card' });
    expect(() =>
      store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(wrongMethod)),
    ).toThrow(/cash-account outflow/i);

    const payroll = loanPayment({ id: 'payroll', paymentMethod: 'payroll-deduction' });
    expect(() =>
      store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(payroll)),
    ).toThrow(/cash-account outflow/i);
  });

  it('atomically moves only future linked payment instructions when the funding account changes', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'user-a', displayName: 'User A', username: 'user-a' }]);
    for (const cash of [account, otherAccount]) {
      store.upsertManagedEntity('user-a', 'cash-account', withoutUserId(cash));
    }
    store.updateCashFloorPolicy('user-a', {
      hardConsolidatedFloorCents: 0,
      horizonDays: 90,
      includeConfirmedReceivablesConservatively: true,
    });
    store.upsertManagedEntity('user-a', 'loan', withoutUserId(loan));

    const historicalDraft = loanPayment({
      id: 'historical-draft',
      date: '2026-01-15',
      amountCents: 20_000,
      status: 'paid',
      loanPaymentTreatment: 'scheduled-draft-override',
    });
    const futureDraft = loanPayment({
      id: 'future-draft',
      date: '2026-02-15',
      amountCents: 20_000,
      status: 'scheduled',
      loanPaymentTreatment: 'scheduled-draft-override',
    });
    const futureExtra = loanPayment({
      id: 'future-extra',
      date: '2026-02-20',
      status: 'scheduled',
    });
    for (const event of [historicalDraft, futureDraft, futureExtra]) {
      store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(event));
    }

    store.upsertManagedEntity(
      'user-a',
      'loan',
      withoutUserId(loanSchema.parse({ ...loan, fundingAccountId: otherAccount.id })),
      { asOfDate: '2026-01-20' },
    );

    const records = store.getManagedRecords('user-a');
    const eventById = new Map(records.events.map((event) => [event.id, event]));
    expect(eventById.get(historicalDraft.id)?.accountId).toBe(account.id);
    expect(eventById.get(futureDraft.id)?.accountId).toBe(otherAccount.id);
    expect(eventById.get(futureExtra.id)?.accountId).toBe(otherAccount.id);

    const futureCash = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: [],
      cardCycles: [],
      loans: records.loans,
      startDate: '2026-01-21',
      endDate: '2026-02-28',
    })
      .filter((event) => event.kind === 'loan-payment')
      .sort((left, right) => left.date.localeCompare(right.date));
    expect(
      futureCash.map((event) => ({
        accountId: event.accountId,
        amountCents: event.amountCents,
        date: event.date,
      })),
    ).toEqual([
      { accountId: otherAccount.id, amountCents: 20_000, date: '2026-02-15' },
      { accountId: otherAccount.id, amountCents: 30_000, date: '2026-02-20' },
    ]);

    const audit = store.raw
      .prepare(
        "SELECT payload_json AS payloadJson FROM audit_events WHERE user_id = ? AND entity_type = 'loan' AND entity_id = ? AND action = 'upsert' ORDER BY rowid DESC LIMIT 1",
      )
      .get('user-a', loan.id) as { payloadJson: string };
    const cascade = (
      JSON.parse(audit.payloadJson) as {
        loanPaymentInstructionCascadeSummary: {
          count: number;
          sample: Array<{ action: string; eventId: string }>;
          sha256: string;
        };
      }
    ).loanPaymentInstructionCascadeSummary;
    expect(cascade.count).toBe(2);
    expect(cascade.sample).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'move', eventId: futureDraft.id }),
        expect.objectContaining({ action: 'move', eventId: futureExtra.id }),
      ]),
    );
    expect(cascade.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('splits a recurring instruction at the effective date so past and future accounts stay true', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'user-a', displayName: 'User A', username: 'user-a' }]);
    for (const cash of [account, otherAccount]) {
      store.upsertManagedEntity('user-a', 'cash-account', withoutUserId(cash));
    }
    store.updateCashFloorPolicy('user-a', {
      hardConsolidatedFloorCents: 0,
      horizonDays: 90,
      includeConfirmedReceivablesConservatively: true,
    });
    store.upsertManagedEntity('user-a', 'loan', withoutUserId(loan));
    const recurringDraft = loanPayment({
      id: 'recurring-account-draft',
      date: '2026-01-15',
      amountCents: 20_000,
      status: 'scheduled',
      loanPaymentTreatment: 'scheduled-draft-override',
      recurrenceRule: { frequency: 'monthly', dayOfMonth: 15, interval: 1 },
      recurrenceEndDate: '2026-03-15',
    });
    store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(recurringDraft));

    store.upsertManagedEntity(
      'user-a',
      'loan',
      withoutUserId(loanSchema.parse({ ...loan, fundingAccountId: otherAccount.id })),
      { asOfDate: '2026-01-20' },
    );

    const records = store.getManagedRecords('user-a');
    const linked = records.events.filter(
      (event) => event.kind === 'loan-payment' && event.sourceRecordId === loan.id,
    );
    expect(linked).toHaveLength(2);
    expect(linked).toContainEqual(
      expect.objectContaining({
        id: recurringDraft.id,
        accountId: account.id,
        date: '2026-01-15',
        recurrenceEndDate: '2026-01-20',
      }),
    );
    expect(linked).toContainEqual(
      expect.objectContaining({
        accountId: otherAccount.id,
        date: '2026-02-15',
        recurrenceEndDate: '2026-03-15',
      }),
    );

    const futureCash = materializeForecastEvents({
      accounts: records.accounts,
      events: records.events,
      cards: [],
      cardCycles: [],
      loans: records.loans,
      startDate: '2026-01-21',
      endDate: '2026-03-31',
    })
      .filter((event) => event.kind === 'loan-payment')
      .sort((left, right) => left.date.localeCompare(right.date));
    expect(futureCash.map((event) => [event.date, event.accountId, event.amountCents])).toEqual([
      ['2026-02-15', otherAccount.id, 20_000],
      ['2026-03-15', otherAccount.id, 20_000],
    ]);
  });

  it('rejects an incompatible schedule edit without partially changing the loan or its drafts', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'user-a', displayName: 'User A', username: 'user-a' }]);
    store.upsertManagedEntity('user-a', 'cash-account', withoutUserId(account));
    store.updateCashFloorPolicy('user-a', {
      hardConsolidatedFloorCents: 0,
      horizonDays: 90,
      includeConfirmedReceivablesConservatively: true,
    });
    store.upsertManagedEntity('user-a', 'loan', withoutUserId(loan));
    const futureDraft = loanPayment({
      id: 'future-contractual-draft',
      date: '2026-02-15',
      amountCents: 20_000,
      status: 'scheduled',
      loanPaymentTreatment: 'scheduled-draft-override',
    });
    store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(futureDraft));

    expect(() =>
      store.upsertManagedEntity(
        'user-a',
        'loan',
        withoutUserId(loanSchema.parse({ ...loan, nextPaymentDate: '2026-01-20' })),
        { asOfDate: '2026-01-20' },
      ),
    ).toThrow(/edit or cancel that future payment instruction first/i);
    expect(() =>
      store.upsertManagedEntity(
        'user-a',
        'loan',
        withoutUserId(loanSchema.parse({ ...loan, paymentFrequency: 'biweekly' })),
        { asOfDate: '2026-01-20' },
      ),
    ).toThrow(/edit or cancel that future payment instruction first/i);

    const records = store.getManagedRecords('user-a');
    expect(records.loans.find((candidate) => candidate.id === loan.id)?.nextPaymentDate).toBe(
      loan.nextPaymentDate,
    );
    expect(records.events.find((event) => event.id === futureDraft.id)).toMatchObject({
      accountId: account.id,
      date: futureDraft.date,
    });
  });

  it('stops replacement-loan cash instructions immediately when a refinance is cancelled', () => {
    const store = openStore();
    store.initializeProfiles([{ id: 'user-a', displayName: 'User A', username: 'user-a' }]);
    store.upsertManagedEntity('user-a', 'cash-account', withoutUserId(account));
    store.updateCashFloorPolicy('user-a', {
      hardConsolidatedFloorCents: 0,
      horizonDays: 90,
      includeConfirmedReceivablesConservatively: true,
    });
    store.upsertManagedEntity('user-a', 'loan', withoutUserId(loan));
    const replacement = loanSchema.parse({
      ...loan,
      id: 'replacement-loan',
      name: 'Replacement loan',
      principalCents: 80_000,
      balanceDate: '2026-02-01',
      originalPrincipalCents: 80_000,
      originalDate: '2026-02-01',
      nextPaymentDate: '2026-03-01',
    });
    store.commitRefinancePlan(
      'user-a',
      {
        id: 'cancelled-refinance',
        name: 'Cancelled refinance',
        closingDate: '2026-02-01',
        payoffDate: '2026-02-01',
        firstPaymentDate: '2026-03-01',
        payoffs: [{ sourceLoanId: loan.id, payoffAmountCents: 80_000 }],
        replacementLoan: withoutUserId(replacement),
        principalCashContributionCents: 0,
        closingCostsCents: 0,
        financedFeesCents: 0,
        excessProceedsCents: 0,
      },
      '2026-01-20',
    );
    const replacementDraft = loanPayment({
      id: 'replacement-future-draft',
      sourceRecordId: replacement.id,
      date: '2026-03-01',
      amountCents: 20_000,
      status: 'scheduled',
      loanPaymentTreatment: 'scheduled-draft-override',
    });
    store.upsertManagedEntity('user-a', 'forecast-event', withoutUserId(replacementDraft));

    expect(
      store.cancelCommittedRefinancePlan('user-a', 'cancelled-refinance', '2026-01-20').status,
    ).toBe('cancelled');
    const records = store.getManagedRecords('user-a');
    expect(records.loans.find((candidate) => candidate.id === replacement.id)).toMatchObject({
      includeInCashForecast: false,
      status: 'paid-off',
    });
    expect(
      materializeForecastEvents({
        accounts: records.accounts,
        events: records.events,
        cards: [],
        cardCycles: [],
        loans: records.loans,
        startDate: '2026-01-21',
        endDate: '2026-03-31',
      }).filter((event) => event.sourceRecordId === replacement.id),
    ).toEqual([]);
  });

  it('migrates v22 rows to the safe scheduled-draft default', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-book-loan-payment-v23-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'balance-book.sqlite');
    const database = new BetterSqlite3(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES
        (13, 'dark-first-interface-default', '2026-01-01T00:00:00.000Z'),
        (21, 'compact-legacy-refinance-audit-payloads', '2026-01-01T00:00:00.000Z'),
        (22, 'installment-and-revolving-debt-metadata', '2026-01-01T00:00:00.000Z');
      CREATE TABLE forecast_events (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO forecast_events (id) VALUES ('legacy-loan-payment');
    `);
    applyMigrations({ database, databasePath, backupDirectory: path.join(directory, 'backups') });
    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      {
        version: latestSchemaVersion,
      },
    );
    expect(
      database.prepare('SELECT loan_payment_treatment AS treatment FROM forecast_events').get(),
    ).toEqual({ treatment: 'scheduled-draft-override' });
    database.close();
  });
});
