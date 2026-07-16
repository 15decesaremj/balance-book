import Decimal from 'decimal.js';

export const formatMoney = (cents: number): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);

export const formatPlainDate = (value: string | undefined, locale?: string): string => {
  if (!value) return 'Not available';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year!, month! - 1, day)));
};

export const dollarsToCents = (value: string): number =>
  new Decimal(value.replaceAll(',', '').trim())
    .mul(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();

export const errorMessage = (error: unknown): string => {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues)) {
    const issue = issues[0] as { message?: unknown; path?: unknown } | undefined;
    if (!issue) return 'Invalid input';
    const path = Array.isArray(issue.path) ? issue.path : [];
    const location = path.length > 0 ? path.join('.') : 'request';
    return `${typeof issue.message === 'string' ? issue.message : 'Invalid input'} (${location})`;
  }
  return error instanceof Error ? error.message : 'The operation could not be completed';
};
