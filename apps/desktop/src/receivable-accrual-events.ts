import type { Receivable } from '@balance-book/domain';
import type { DailyReceivableBalance } from '@balance-book/financial-engine';
import { displayStateForForecastEvent, type ForecastDailyEventDto } from './shared/contracts';

type Accrual = DailyReceivableBalance['accruals'][number];

const accrualKey = (accrual: Accrual): string =>
  `${accrual.receivableId}@${accrual.occurrenceDate}`;

export const buildReceivableAccrualDailyEvents = (input: {
  date: string;
  expectedAccruals: Accrual[];
  conservativeAccruals: Accrual[];
  receivables: Receivable[];
}): ForecastDailyEventDto[] => {
  const receivableById = new Map(
    input.receivables.map((receivable) => [receivable.id, receivable]),
  );
  const expectedKeys = new Set(input.expectedAccruals.map(accrualKey));
  const conservativeKeys = new Set(input.conservativeAccruals.map(accrualKey));
  const uniqueAccruals = new Map(
    [...input.expectedAccruals, ...input.conservativeAccruals].map((accrual) => [
      accrualKey(accrual),
      accrual,
    ]),
  );

  return [...uniqueAccruals.entries()].flatMap(([key, accrual]) => {
    const receivable = receivableById.get(accrual.receivableId);
    if (!receivable) return [];
    const displayInput = {
      certainty: receivable.certainty,
      status: 'planned' as const,
      hypothetical: false,
    };
    return {
      id: `receivable-accrual-${accrual.receivableId}@${input.date}`,
      sourceRecordId: receivable.id,
      label: `${receivable.source}: ${receivable.description}`,
      accountName: 'Money Owed',
      amountCents: accrual.cents,
      direction: 'inflow',
      kind: 'receivable-accrual',
      certainty: receivable.certainty,
      status: displayInput.status,
      hypothetical: displayInput.hypothetical,
      displayState: displayStateForForecastEvent(displayInput),
      includedInExpected: expectedKeys.has(key),
      includedInConservative: conservativeKeys.has(key),
    };
  });
};
