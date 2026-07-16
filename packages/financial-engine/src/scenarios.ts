import {
  addDays,
  compareDates,
  forecastEventSchema,
  moneyCentsSchema,
  type CashAccount,
  type CashFloorPolicy,
  type ForecastEvent,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import { buildForecastBundle, type ForecastBundle } from './forecast';

export type ScenarioVerdict =
  | 'affordable-under-current-assumptions'
  | 'above-hard-floor-below-preferred-buffer'
  | 'dependent-on-expected-income'
  | 'underfunded-account'
  | 'breaches-protected-floor';

export const evaluateScenarios = (input: {
  accounts: CashAccount[];
  baseEvents: ForecastEvent[];
  scenarioEvents: ForecastEvent[];
  policy: CashFloorPolicy;
  startDate: PlainDateString;
  endDate?: PlainDateString;
}): {
  before: ForecastBundle;
  after: ForecastBundle;
  troughChangeCents: MoneyCents;
  safeToDeployChangeCents: MoneyCents;
  verdict: ScenarioVerdict;
} => {
  const scenarioEvents = input.scenarioEvents.map((event) =>
    forecastEventSchema.parse({ ...event, hypothetical: true }),
  );
  const defaultEndDate = input.endDate ?? addDays(input.startDate, input.policy.horizonDays - 1);
  const extendedEndDate = scenarioEvents.reduce(
    (latest, event) => (compareDates(event.date, latest) > 0 ? event.date : latest),
    defaultEndDate,
  );
  const baseInput = {
    accounts: input.accounts,
    events: input.baseEvents,
    policy: input.policy,
    startDate: input.startDate,
    endDate: extendedEndDate,
  };
  const before = buildForecastBundle(baseInput);
  const after = buildForecastBundle({
    ...baseInput,
    events: [...input.baseEvents, ...scenarioEvents],
    includeHypothetical: true,
  });
  let verdict: ScenarioVerdict;
  if (after.conservative.hardFloorMarginCents < 0) verdict = 'breaches-protected-floor';
  else if (after.conservative.accountShortfalls.length > 0) verdict = 'underfunded-account';
  else if (
    after.conservative.preferredFloorMarginCents !== undefined &&
    after.conservative.preferredFloorMarginCents < 0
  ) {
    verdict = 'above-hard-floor-below-preferred-buffer';
  } else if (
    after.expected.consolidatedTroughCents > after.conservative.consolidatedTroughCents &&
    after.expected.dependencies.length > 0
  ) {
    verdict = 'dependent-on-expected-income';
  } else verdict = 'affordable-under-current-assumptions';

  return {
    before,
    after,
    troughChangeCents: moneyCentsSchema.parse(
      after.conservative.consolidatedTroughCents - before.conservative.consolidatedTroughCents,
    ),
    safeToDeployChangeCents: moneyCentsSchema.parse(
      after.rawSafeToDeployMarginCents - before.rawSafeToDeployMarginCents,
    ),
    verdict,
  };
};
