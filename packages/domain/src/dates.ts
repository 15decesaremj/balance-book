import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export const plainDateSchema = z.string().refine(
  (value) => {
    try {
      Temporal.PlainDate.from(value);
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    } catch {
      return false;
    }
  },
  { message: 'Expected an ISO financial date (YYYY-MM-DD)' },
);

export type PlainDateString = z.infer<typeof plainDateSchema>;

export const toPlainDate = (value: PlainDateString): Temporal.PlainDate =>
  Temporal.PlainDate.from(plainDateSchema.parse(value));

export const toPlainDateString = (value: Temporal.PlainDate): PlainDateString =>
  plainDateSchema.parse(value.toString());

export const addDays = (value: PlainDateString, days: number): PlainDateString =>
  toPlainDateString(toPlainDate(value).add({ days }));

export const addMonthsConstrained = (value: PlainDateString, months: number): PlainDateString =>
  toPlainDateString(toPlainDate(value).add({ months }, { overflow: 'constrain' }));

export const compareDates = (left: PlainDateString, right: PlainDateString): number =>
  Temporal.PlainDate.compare(toPlainDate(left), toPlainDate(right));

export const daysBetween = (start: PlainDateString, end: PlainDateString): number =>
  toPlainDate(start).until(toPlainDate(end), { largestUnit: 'day' }).days;

export const enumerateDates = (start: PlainDateString, end: PlainDateString): PlainDateString[] => {
  if (compareDates(start, end) > 0) return [];
  const dates: PlainDateString[] = [];
  for (let date = start; compareDates(date, end) <= 0; date = addDays(date, 1)) dates.push(date);
  return dates;
};
