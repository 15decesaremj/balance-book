import { type ForecastEvent } from '@balance-book/domain';

export interface DoubleCountRisk {
  sourceRecordId: string;
  eventIds: string[];
  reason: 'cash-and-card' | 'net-pay-and-payroll-deduction';
}

export const findDoubleCountRisks = (events: ForecastEvent[]): DoubleCountRisk[] => {
  const bySource = new Map<string, ForecastEvent[]>();
  for (const event of events) {
    if (!event.sourceRecordId) continue;
    const related = bySource.get(event.sourceRecordId) ?? [];
    related.push(event);
    bySource.set(event.sourceRecordId, related);
  }

  const risks: DoubleCountRisk[] = [];
  for (const [sourceRecordId, related] of bySource) {
    const kinds = new Set(related.map((event) => event.kind));
    if (kinds.has('direct-commitment') && kinds.has('card-payment')) {
      risks.push({
        sourceRecordId,
        eventIds: related.map((event) => event.id),
        reason: 'cash-and-card',
      });
    }
    if (kinds.has('income') && kinds.has('investment-contribution')) {
      risks.push({
        sourceRecordId,
        eventIds: related.map((event) => event.id),
        reason: 'net-pay-and-payroll-deduction',
      });
    }
  }
  return risks;
};

export const assertNoDoubleCountRisks = (events: ForecastEvent[]): void => {
  const risks = findDoubleCountRisks(events);
  if (risks.length === 0) return;
  const details = risks.map((risk) => `${risk.sourceRecordId}:${risk.reason}`).join(', ');
  throw new Error(`Potential double counting detected (${details})`);
};
