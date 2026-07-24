import type { CreditCardCycle, ForecastEvent } from '@balance-book/domain';
import type { ReceivableSettlementRequest, UpsertManagedEntityRequest } from '../shared/contracts';

export const confirmScheduledCardPaymentRequest = (input: {
  cycle: CreditCardCycle;
  amountCents: number;
  paymentDate: string;
  fundingAccountId: string;
}): UpsertManagedEntityRequest => ({
  entityType: 'card-cycle',
  payload: {
    ...input.cycle,
    state: 'paid',
    paymentOn: input.paymentDate,
    actualPaymentCents: input.amountCents,
    actualPaymentAccountId: input.fundingAccountId,
  },
});

export const confirmExpectedEventRequest = (event: ForecastEvent): UpsertManagedEntityRequest => ({
  entityType: 'forecast-event',
  payload: {
    ...event,
    certainty: 'confirmed',
    status: event.kind === 'card-payment' || event.kind === 'loan-payment' ? 'paid' : 'confirmed',
  },
});

export const receiveMoneyOwedRequest = (input: {
  receivableId: string;
  amountCents: number;
  date: string;
  destinationAccountId: string;
  occurrenceDate?: string;
}): ReceivableSettlementRequest => ({
  receivableId: input.receivableId,
  amountCents: input.amountCents,
  date: input.date,
  destinationAccountId: input.destinationAccountId,
  occurrenceDate: input.occurrenceDate,
});
