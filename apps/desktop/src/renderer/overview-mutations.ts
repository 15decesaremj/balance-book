import type { CashAccount, CreditCard, CreditCardCycle } from '@balance-book/domain';
import type { UpsertManagedEntityRequest } from '../shared/contracts';

export const overviewBalanceUpdateRequest = (
  account: CashAccount,
  openingBalanceCents: number,
  balanceAsOf: string,
): UpsertManagedEntityRequest => {
  const accountInput = Object.fromEntries(
    Object.entries(account).filter(([key]) => key !== 'userId'),
  ) as Omit<CashAccount, 'userId'>;
  return {
    entityType: 'cash-account',
    payload: {
      ...accountInput,
      openingBalanceCents,
      balanceAsOf,
    },
  };
};

export const overviewCardBalanceUpdateRequest = (
  card: CreditCard,
  reportedBalanceCents: number,
  reportedBalanceDate: string,
): UpsertManagedEntityRequest => {
  const cardInput = Object.fromEntries(
    Object.entries(card).filter(([key]) => key !== 'userId'),
  ) as Omit<CreditCard, 'userId'>;
  return {
    entityType: 'credit-card',
    payload: {
      ...cardInput,
      reportedBalanceCents,
      reportedBalanceDate,
    },
  };
};

export const overviewStatementBalanceUpdateRequest = (
  cycle: CreditCardCycle,
  lockedStatementCents: number,
): UpsertManagedEntityRequest => ({
  entityType: 'card-cycle',
  payload: {
    ...cycle,
    lockedStatementCents,
  },
});

export const overviewCashTransactionRequest = (
  account: CashAccount,
  input: {
    id: string;
    direction: 'inflow' | 'outflow';
    amountCents: number;
    label: string;
    date: string;
    notes?: string;
  },
): UpsertManagedEntityRequest => {
  if (input.date < account.balanceAsOf) {
    throw new Error(`Transaction date cannot be before ${account.balanceAsOf}`);
  }
  return {
    entityType: 'forecast-event',
    payload: {
      id: input.id,
      accountId: account.id,
      date: input.date,
      kind: 'manual-adjustment',
      direction: input.direction,
      amountCents: input.amountCents,
      certainty: 'confirmed',
      status: 'confirmed',
      label: input.label,
      hypothetical: false,
      accepted: false,
      paymentMethod: 'cash-account',
      appliesAfterBalanceSnapshot: input.date === account.balanceAsOf,
      notes: input.notes || undefined,
    },
  };
};

export const overviewCardTransactionRequest = (
  card: CreditCard,
  input: {
    id: string;
    direction: 'inflow' | 'outflow';
    amountCents: number;
    label: string;
    date: string;
    notes?: string;
  },
): UpsertManagedEntityRequest => ({
  entityType: 'forecast-event',
  payload: {
    id: input.id,
    accountId: card.fundingAccountId,
    date: input.date,
    kind: 'manual-adjustment',
    direction: input.direction,
    amountCents: input.amountCents,
    certainty: 'confirmed',
    status: 'confirmed',
    label: input.label,
    hypothetical: false,
    accepted: false,
    paymentMethod: 'credit-card',
    cardId: card.id,
    cardActivityTreatment: 'additional',
    appliesAfterBalanceSnapshot: input.date === card.reportedBalanceDate,
    notes: input.notes || undefined,
  },
});

export const statementBalanceEditIsUnusual = (
  cycle: Pick<CreditCardCycle, 'dueOn'>,
  asOfDate: string,
): boolean => cycle.dueOn < asOfDate;

export const compensatingForecastEventRequest = (
  event: {
    id: string;
    accountId: string;
    date: string;
    direction: 'inflow' | 'outflow';
    amountCents: number;
    paymentMethod?: 'cash-account' | 'credit-card' | 'payroll-deduction';
    cardId?: string;
    label: string;
  },
  reversalId: string,
  reversalDate = event.date,
): UpsertManagedEntityRequest => ({
  entityType: 'forecast-event',
  payload: {
    id: reversalId,
    accountId: event.accountId,
    date: reversalDate,
    kind: 'manual-adjustment',
    direction: event.direction === 'inflow' ? 'outflow' : 'inflow',
    amountCents: event.amountCents,
    certainty: 'confirmed',
    status: 'confirmed',
    label: `Reversal: ${event.label}`,
    hypothetical: false,
    accepted: false,
    paymentMethod: event.paymentMethod ?? 'cash-account',
    cardId: event.cardId,
    cardActivityTreatment: event.cardId ? 'additional' : undefined,
    sourceRecordId: event.id,
    notes: `Audited compensating reversal of ${event.id}.`,
  },
});
