import { describe, expect, it } from 'vitest';
import { forecastEventSchema } from '@balance-book/domain';
import { makeForecastEventEditRequest, makeRequest } from '../apps/desktop/src/renderer/CorePages';

const append = (form: FormData, values: Record<string, string>): FormData => {
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
};

const createEventForm = (kind: 'loan-payment' | 'card-payment'): FormData =>
  append(new FormData(), {
    accountId: 'checking',
    date: '2026-08-01',
    eventKind: kind,
    direction: 'outflow',
    amount: '100.00',
    certainty: 'confirmed',
    name: 'Synthetic debt payment',
    paymentMethod: 'cash-account',
    recurrenceFrequency: 'once',
    recurrenceEndDate: '',
  });

const editEventForm = (kind: 'loan-payment' | 'card-payment'): FormData =>
  append(new FormData(), {
    editEventAccountId: 'checking',
    editEventDate: '2026-08-01',
    editEventKind: kind,
    editEventDirection: 'outflow',
    editEventAmount: '100.00',
    editEventCertainty: 'confirmed',
    editEventStatus: 'paid',
    editEventLabel: 'Synthetic debt payment',
    editEventNotes: '',
    editEventPaymentMethod: 'cash-account',
    editEventRecurrence: 'one-time',
    editEventConservativeTreatment: 'automatic',
  });

const storedEvent = forecastEventSchema.parse({
  id: 'stored-debt-payment',
  userId: 'profile-a',
  accountId: 'checking',
  date: '2026-08-01',
  kind: 'loan-payment',
  direction: 'outflow',
  amountCents: 10_000,
  certainty: 'confirmed',
  status: 'paid',
  label: 'Synthetic debt payment',
  paymentMethod: 'cash-account',
  sourceRecordId: 'old-loan',
});

describe('guided debt-payment controls', () => {
  it('persists the selected installment loan on create and edit', () => {
    const create = createEventForm('loan-payment');
    create.set('loanId', 'selected-loan');
    create.set('loanPaymentTreatment', 'additional-principal');
    create.set('paymentMethod', 'payroll-deduction');
    expect(makeRequest('forecast-event', create)).toMatchObject({
      entityType: 'forecast-event',
      payload: {
        kind: 'loan-payment',
        sourceRecordId: 'selected-loan',
        paymentMethod: 'cash-account',
        loanPaymentTreatment: 'additional-principal',
      },
    });

    const edit = editEventForm('loan-payment');
    edit.set('editEventLoanId', 'replacement-loan');
    edit.set('editEventLoanPaymentTreatment', 'scheduled-draft-override');
    expect(makeForecastEventEditRequest(storedEvent, edit)).toMatchObject({
      entityType: 'forecast-event',
      payload: {
        kind: 'loan-payment',
        sourceRecordId: 'replacement-loan',
        loanPaymentTreatment: 'scheduled-draft-override',
      },
    });
  });

  it('keeps card payments as cash outflows and stores an optional statement source', () => {
    const linkedCreate = createEventForm('card-payment');
    linkedCreate.set('paymentMethod', 'credit-card');
    linkedCreate.set('cardId', 'selected-card');
    linkedCreate.set('cardCycleId', 'selected-cycle');
    expect(makeRequest('forecast-event', linkedCreate)).toMatchObject({
      entityType: 'forecast-event',
      payload: {
        kind: 'card-payment',
        direction: 'outflow',
        paymentMethod: 'cash-account',
        cardId: 'selected-card',
        sourceRecordId: 'selected-cycle',
      },
    });

    const unlinkedEdit = editEventForm('card-payment');
    unlinkedEdit.set('editEventCardId', 'selected-card');
    unlinkedEdit.set('editEventCardCycleId', '');
    expect(makeForecastEventEditRequest(storedEvent, unlinkedEdit)).toMatchObject({
      entityType: 'forecast-event',
      payload: {
        kind: 'card-payment',
        direction: 'outflow',
        paymentMethod: 'cash-account',
        cardId: 'selected-card',
        sourceRecordId: undefined,
      },
    });
  });
});
