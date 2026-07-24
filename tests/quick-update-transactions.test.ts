import { describe, expect, it } from 'vitest';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  creditCardCycleSchema,
  creditCardSchema,
  forecastEventSchema,
  type ForecastEvent,
} from '@balance-book/domain';
import {
  buildForecast,
  enrichCardCyclesWithActivities,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';
import { compensatingForecastEventRequest } from '../apps/desktop/src/renderer/overview-mutations';
import {
  overviewCardTransactionRequest,
  overviewCashTransactionRequest,
} from '../apps/desktop/src/renderer/DashboardPage';

const userId = 'quick-update-user';

const account = cashAccountSchema.parse({
  id: 'checking',
  userId,
  name: 'Checking',
  type: 'checking',
  openingBalanceCents: 100_000,
  balanceAsOf: '2026-06-10',
  includedInLiquidity: true,
  canFundOtherAccounts: true,
  showOnOverview: true,
  hardFloorCents: 0,
  preferredFloorCents: 10_000,
  transferDelayDays: 0,
  notes: 'Preserved settings',
});

const card = creditCardSchema.parse({
  id: 'card',
  userId,
  name: 'Card',
  fundingAccountId: account.id,
  accountKind: 'credit-card',
  reportedBalanceCents: 50_000,
  reportedBalanceDate: '2026-06-10',
  defaultFutureStatementCents: 25_000,
  estimatePolicy: 'actual-reset',
  paymentPolicy: 'manual',
  creditLimitCents: 200_000,
  paymentDayOfMonth: 10,
  statementCloseDayOfMonth: 15,
});

const cashEvent = (overrides: Partial<ForecastEvent> = {}): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'cash-event',
    userId,
    accountId: account.id,
    date: '2026-06-10',
    kind: 'manual-adjustment',
    direction: 'inflow',
    amountCents: 25_000,
    certainty: 'confirmed',
    status: 'confirmed',
    label: 'Cash event',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'cash-account',
    ...overrides,
  });

const cardEvent = (overrides: Partial<ForecastEvent> = {}): ForecastEvent =>
  forecastEventSchema.parse({
    id: 'card-event',
    userId,
    accountId: account.id,
    date: '2026-06-10',
    kind: 'manual-adjustment',
    direction: 'outflow',
    amountCents: 4_000,
    certainty: 'confirmed',
    status: 'confirmed',
    label: 'Card event',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'credit-card',
    cardId: card.id,
    cardActivityTreatment: 'additional',
    ...overrides,
  });

const policy = cashFloorPolicySchema.parse({
  hardConsolidatedFloorCents: 0,
  preferredConsolidatedFloorCents: 10_000,
  horizonDays: 30,
  includeConfirmedReceivablesConservatively: true,
});

describe('Overview quick-update transaction accounting', () => {
  it('builds an audited compensating reversal without mutating the original entry', () => {
    const original = cardEvent();
    const request = compensatingForecastEventRequest(original, 'reversal-id', '2026-06-12');
    expect(request).toEqual({
      entityType: 'forecast-event',
      payload: expect.objectContaining({
        id: 'reversal-id',
        sourceRecordId: original.id,
        accountId: original.accountId,
        cardId: original.cardId,
        paymentMethod: 'credit-card',
        direction: 'inflow',
        amountCents: original.amountCents,
        date: '2026-06-12',
      }),
    });
    expect(original.direction).toBe('outflow');
  });

  it('marks only same-day cash activity as occurring after its balance snapshot', () => {
    const sameDay = overviewCashTransactionRequest(account, {
      id: 'same-day',
      direction: 'outflow',
      amountCents: 1_500,
      label: 'Same-day withdrawal',
      date: account.balanceAsOf,
    });
    const later = overviewCashTransactionRequest(account, {
      id: 'later',
      direction: 'inflow',
      amountCents: 2_500,
      label: 'Later deposit',
      date: '2026-06-11',
    });

    expect(sameDay.payload).toMatchObject({
      paymentMethod: 'cash-account',
      appliesAfterBalanceSnapshot: true,
    });
    expect(later.payload).toMatchObject({ appliesAfterBalanceSnapshot: false });
    expect(() =>
      overviewCashTransactionRequest(account, {
        id: 'historical',
        direction: 'inflow',
        amountCents: 1,
        label: 'Too old',
        date: '2026-06-09',
      }),
    ).toThrow(/cannot be before 2026-06-10/i);
  });

  it('applies a same-day cash transaction exactly once and only to its selected account', () => {
    const reserve = cashAccountSchema.parse({
      ...account,
      id: 'reserve',
      name: 'Reserve',
      openingBalanceCents: 40_000,
    });
    const flagged = cashEvent({ appliesAfterBalanceSnapshot: true });
    const legacySameDay = cashEvent({ id: 'already-in-snapshot' });
    const result = buildForecast({
      accounts: [account, reserve],
      events: [flagged, legacySameDay],
      policy,
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      mode: 'expected',
    });

    expect(result.days[0]!.accounts.find((row) => row.accountId === account.id)).toMatchObject({
      endingBalanceCents: 125_000,
      appliedEventIds: [flagged.id],
    });
    expect(result.days[0]!.accounts.find((row) => row.accountId === reserve.id)).toMatchObject({
      endingBalanceCents: 40_000,
      appliedEventIds: [],
    });
    expect(result.consolidatedTroughCents).toBe(140_000);
    expect(result.excludedEventIds).toContain(legacySameDay.id);
  });

  it('assigns purchases and credits to native open cycles at close, due, and payment dates', () => {
    const first = creditCardCycleSchema.parse({
      id: 'cycle-one',
      cardId: card.id,
      opensOn: '2026-06-01',
      closesOn: '2026-06-15',
      dueOn: '2026-07-10',
      paymentOn: '2026-07-08',
      state: 'open',
      defaultEstimateCents: 25_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });
    const second = creditCardCycleSchema.parse({
      id: 'cycle-two',
      cardId: card.id,
      opensOn: '2026-06-16',
      closesOn: '2026-07-15',
      dueOn: '2026-08-10',
      paymentOn: '2026-08-08',
      state: 'open',
      defaultEstimateCents: 25_000,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });
    const enriched = enrichCardCyclesWithActivities({
      cardCycles: [first, second],
      cardActivities: [
        cardEvent({ id: 'on-close', date: first.closesOn, amountCents: 10_000 }),
        cardEvent({ id: 'next-open', date: second.opensOn, amountCents: 20_000 }),
        cardEvent({ id: 'on-payment', date: first.paymentOn, amountCents: 3_000 }),
        cardEvent({
          id: 'credit-on-due',
          date: first.dueOn,
          direction: 'inflow',
          amountCents: 5_000,
        }),
      ],
      cards: [card],
      endDate: second.closesOn,
      asOfDate: first.dueOn,
    });

    expect(enriched.find((cycle) => cycle.id === first.id)?.actualActivityCents).toBe(10_000);
    expect(enriched.find((cycle) => cycle.id === second.id)?.actualActivityCents).toBe(18_000);
    expect(
      enriched.map(({ opensOn, closesOn, dueOn, paymentOn }) => ({
        opensOn,
        closesOn,
        dueOn,
        paymentOn,
      })),
    ).toEqual([
      {
        opensOn: first.opensOn,
        closesOn: first.closesOn,
        dueOn: first.dueOn,
        paymentOn: first.paymentOn,
      },
      {
        opensOn: second.opensOn,
        closesOn: second.closesOn,
        dueOn: second.dueOn,
        paymentOn: second.paymentOn,
      },
    ]);
  });

  it('rolls a purchase and card credit after a reported balance without moving cash', () => {
    const openCycle = creditCardCycleSchema.parse({
      id: 'open-cycle',
      cardId: card.id,
      opensOn: '2026-06-01',
      closesOn: '2026-06-30',
      dueOn: '2026-07-10',
      state: 'open',
      defaultEstimateCents: 0,
      actualActivityCents: 0,
      plannedActivityCents: 0,
    });
    const purchase = cardEvent({ appliesAfterBalanceSnapshot: true });
    const credit = cardEvent({
      id: 'later-credit',
      date: '2026-06-12',
      direction: 'inflow',
      amountCents: 5_000,
    });
    const debt = summarizeRevolvingDebt({
      card,
      cycles: [openCycle],
      events: [purchase, credit],
      asOfDate: '2026-06-12',
    });
    const cash = buildForecast({
      accounts: [account],
      events: [purchase, credit],
      policy,
      startDate: '2026-06-10',
      endDate: '2026-06-12',
      mode: 'expected',
    });

    expect(debt.currentBalanceCents).toBe(49_000);
    expect(debt.actualOpenCycleCents).toBe(0);
    expect(cash.days.at(-1)?.consolidatedCashCents).toBe(100_000);
    expect(cash.excludedEventIds).toEqual(expect.arrayContaining([purchase.id, credit.id]));
  });

  it('creates canonical card activity while preserving card terms and payment policy', () => {
    const request = overviewCardTransactionRequest(card, {
      id: 'quick-card-credit',
      direction: 'inflow',
      amountCents: 2_000,
      label: 'Card credit',
      date: card.reportedBalanceDate!,
      notes: 'Synthetic note',
    });

    expect(request).toMatchObject({
      entityType: 'forecast-event',
      payload: {
        accountId: account.id,
        paymentMethod: 'credit-card',
        cardId: card.id,
        direction: 'inflow',
        cardActivityTreatment: 'additional',
        appliesAfterBalanceSnapshot: true,
      },
    });
    expect(request.payload).not.toHaveProperty('paymentPolicy');
    expect(request.payload).not.toHaveProperty('fixedPaymentCents');
    expect(request.payload).not.toHaveProperty('reportedBalanceCents');
  });
});
