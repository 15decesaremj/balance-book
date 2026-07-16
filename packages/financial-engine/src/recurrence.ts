import { Temporal } from '@js-temporal/polyfill';
import {
  addDays,
  compareDates,
  plainDateSchema,
  toPlainDate,
  toPlainDateString,
  type PlainDateString,
  type RecurrenceRule,
} from '@balance-book/domain';

const constrainedDate = (year: number, month: number, day: number): PlainDateString => {
  const first = Temporal.PlainDate.from({ year, month, day: 1 });
  return toPlainDateString(first.with({ day }, { overflow: 'constrain' }));
};

export const expandRecurrence = (input: {
  startDate: PlainDateString;
  endDate: PlainDateString;
  rule: RecurrenceRule;
}): PlainDateString[] => {
  const startDate = plainDateSchema.parse(input.startDate);
  const endDate = plainDateSchema.parse(input.endDate);
  if (compareDates(startDate, endDate) > 0) return [];

  if (input.rule.frequency === 'once') return [startDate];

  if (input.rule.frequency === 'weekly' || input.rule.frequency === 'biweekly') {
    const days = input.rule.frequency === 'biweekly' ? 14 : 7 * input.rule.interval;
    const dates: PlainDateString[] = [];
    for (let date = startDate; compareDates(date, endDate) <= 0; date = addDays(date, days)) {
      dates.push(date);
    }
    return dates;
  }

  const start = toPlainDate(startDate);
  const end = toPlainDate(endDate);
  const dates: PlainDateString[] = [];

  if (input.rule.frequency === 'monthly') {
    for (
      let month = Temporal.PlainDate.from({ year: start.year, month: start.month, day: 1 });
      Temporal.PlainDate.compare(month, end) <= 0;
      month = month.add({ months: input.rule.interval })
    ) {
      const candidate = constrainedDate(month.year, month.month, input.rule.dayOfMonth);
      if (compareDates(candidate, startDate) >= 0 && compareDates(candidate, endDate) <= 0) {
        dates.push(candidate);
      }
    }
    return dates;
  }

  for (
    let month = Temporal.PlainDate.from({ year: start.year, month: start.month, day: 1 });
    Temporal.PlainDate.compare(month, end) <= 0;
    month = month.add({ months: 1 })
  ) {
    for (const day of [...input.rule.daysOfMonth].sort((a, b) => a - b)) {
      const candidate = constrainedDate(month.year, month.month, day);
      if (
        compareDates(candidate, startDate) >= 0 &&
        compareDates(candidate, endDate) <= 0 &&
        !dates.includes(candidate)
      ) {
        dates.push(candidate);
      }
    }
  }
  return dates.sort(compareDates);
};
