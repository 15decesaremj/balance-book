import {
  addDays,
  addMonthsConstrained,
  compareDates,
  forecastEventSchema,
  moneyCentsSchema,
  plainDateSchema,
  type ForecastEvent,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import { shouldIncludeEvent } from './forecast';

export interface LongRunMonthlyFreeCashFlow {
  monthlyNetCents: MoneyCents;
  monthlyScheduledCardPaymentCents: MoneyCents;
  monthlyBeforeScheduledCardPaymentsCents: MoneyCents;
  windowStart: PlainDateString;
  windowEnd: PlainDateString;
  monthCount: number;
}

/**
 * Converts the change in expected total position across complete future months into a normalized
 * monthly budget margin. Total position is intentional: recurring money owed offsets shared
 * expenses when it accrues, while later receipt merely moves the same value from owed to cash.
 */
export const calculateLongRunMonthlyFreeCashFlow = (input: {
  positionBeforeWindowCents: MoneyCents;
  positionAtWindowEndCents: MoneyCents;
  /**
   * Opening position followed by one position for each complete month. When supplied, the metric
   * uses the weakest rolling three-month average so extra-paycheck months and later debt payoffs do
   * not inflate today's recurring budget margin.
   */
  monthlyPositionCents?: readonly MoneyCents[];
  events: readonly ForecastEvent[];
  scheduledCardCycleIds?: ReadonlySet<string>;
  scheduledCardPaymentEventIds?: ReadonlySet<string>;
  windowStart: PlainDateString;
  windowEnd: PlainDateString;
  monthCount: number;
}): LongRunMonthlyFreeCashFlow => {
  const positionBeforeWindowCents = moneyCentsSchema.parse(input.positionBeforeWindowCents);
  const positionAtWindowEndCents = moneyCentsSchema.parse(input.positionAtWindowEndCents);
  const windowStart = plainDateSchema.parse(input.windowStart);
  const windowEnd = plainDateSchema.parse(input.windowEnd);
  if (compareDates(windowEnd, windowStart) < 0) {
    throw new Error('Long-run cash-flow window must end on or after it starts');
  }
  if (!Number.isInteger(input.monthCount) || input.monthCount <= 0 || input.monthCount > 120) {
    throw new Error('Long-run cash-flow month count must be between 1 and 120');
  }

  const monthlyPositions = input.monthlyPositionCents?.map((value) =>
    moneyCentsSchema.parse(value),
  );
  if (monthlyPositions !== undefined && monthlyPositions.length !== input.monthCount + 1) {
    throw new Error('Monthly position series must contain one opening plus one value per month');
  }
  if (
    monthlyPositions !== undefined &&
    (monthlyPositions[0] !== positionBeforeWindowCents ||
      monthlyPositions.at(-1) !== positionAtWindowEndCents)
  ) {
    throw new Error('Monthly position series must match the supplied window boundaries');
  }
  const rollingMonthCount = Math.min(3, input.monthCount);
  let selectedOffset = 0;
  let selectedMonthCount = input.monthCount;
  let monthlyNetCents = moneyCentsSchema.parse(
    Math.round((positionAtWindowEndCents - positionBeforeWindowCents) / input.monthCount),
  );
  if (monthlyPositions !== undefined) {
    selectedMonthCount = rollingMonthCount;
    monthlyNetCents = moneyCentsSchema.parse(
      Math.round((monthlyPositions[rollingMonthCount]! - monthlyPositions[0]!) / rollingMonthCount),
    );
    for (let offset = 1; offset <= input.monthCount - rollingMonthCount; offset += 1) {
      const candidate = moneyCentsSchema.parse(
        Math.round(
          (monthlyPositions[offset + rollingMonthCount]! - monthlyPositions[offset]!) /
            rollingMonthCount,
        ),
      );
      if (candidate < monthlyNetCents) {
        monthlyNetCents = candidate;
        selectedOffset = offset;
      }
    }
  }
  const selectedWindowStart = addMonthsConstrained(windowStart, selectedOffset);
  const selectedWindowEnd = addDays(
    addMonthsConstrained(selectedWindowStart, selectedMonthCount),
    -1,
  );
  const scheduledCardCycleIds = input.scheduledCardCycleIds ?? new Set<string>();
  const scheduledCardPaymentEventIds = input.scheduledCardPaymentEventIds ?? new Set<string>();
  const scheduledCardPaymentTotalCents = input.events
    .map((event) => forecastEventSchema.parse(event))
    .filter(
      (event) =>
        event.kind === 'card-payment' &&
        ((event.sourceRecordId !== undefined && scheduledCardCycleIds.has(event.sourceRecordId)) ||
          scheduledCardPaymentEventIds.has(event.id)) &&
        compareDates(event.date, selectedWindowStart) >= 0 &&
        compareDates(event.date, selectedWindowEnd) <= 0 &&
        shouldIncludeEvent(event, 'expected'),
    )
    .reduce((total, event) => total + event.amountCents, 0);
  const monthlyScheduledCardPaymentCents = moneyCentsSchema
    .nonnegative()
    .parse(Math.round(scheduledCardPaymentTotalCents / selectedMonthCount));

  return {
    monthlyNetCents,
    monthlyScheduledCardPaymentCents,
    monthlyBeforeScheduledCardPaymentsCents: moneyCentsSchema.parse(
      monthlyNetCents + monthlyScheduledCardPaymentCents,
    ),
    windowStart: selectedWindowStart,
    windowEnd: selectedWindowEnd,
    monthCount: selectedMonthCount,
  };
};
