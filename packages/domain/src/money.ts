import Decimal from 'decimal.js';
import { z } from 'zod';

export const moneyCentsSchema = z.number().int().safe();
export type MoneyCents = z.infer<typeof moneyCentsSchema>;

export const assertMoneyCents = (value: number): MoneyCents => moneyCentsSchema.parse(value);

export const decimalToCents = (value: Decimal.Value): MoneyCents =>
  assertMoneyCents(
    new Decimal(value).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
  );

export const centsToDecimal = (value: MoneyCents): Decimal =>
  new Decimal(assertMoneyCents(value)).div(100);

export const addCents = (...values: MoneyCents[]): MoneyCents =>
  assertMoneyCents(values.reduce((sum, value) => sum + assertMoneyCents(value), 0));

export const subtractCents = (left: MoneyCents, right: MoneyCents): MoneyCents =>
  assertMoneyCents(assertMoneyCents(left) - assertMoneyCents(right));
