import type { ManagedRecordsDto } from '../shared/contracts';

type SetupEvent = ManagedRecordsDto['events'][number];

const isActiveSetupEvent = (event: SetupEvent): boolean =>
  event.status !== 'cancelled' && event.status !== 'skipped';

export const countLogicalSetupIncomingCash = (events: SetupEvent[]): number => {
  const incomeEvents = events.filter(
    (event) => event.kind === 'income' && isActiveSetupEvent(event),
  );
  const incomePlanEvents = incomeEvents.filter((event) => event.incomePlanId !== undefined);
  const baseIncomePlanEvents = incomePlanEvents.filter(
    (event) => event.incomeType !== 'raise-adjustment',
  );
  const supersededIncomeEventIds = new Set(
    baseIncomePlanEvents
      .map((event) => event.sourceRecordId)
      .filter((recordId): recordId is string => recordId !== undefined),
  );
  const baseIncomeSourceIds = new Set(
    baseIncomePlanEvents.flatMap((event) => [event.incomePlanId!, event.id]),
  );
  const logicalIncomeStreamCount = new Set(
    baseIncomePlanEvents
      .map((event) => event.incomeStreamId ?? event.incomePlanId)
      .filter((streamId): streamId is string => streamId !== undefined),
  ).size;
  const standaloneIncomeCount = incomeEvents.filter(
    (event) =>
      event.incomePlanId === undefined &&
      !(event.incomeType === 'raise-adjustment' && event.parentIncomeEventId) &&
      !(event.sourceRecordId && baseIncomeSourceIds.has(event.sourceRecordId)) &&
      !(event.status === 'cancelled' && supersededIncomeEventIds.has(event.id)),
  ).length;
  const rewardDepositCount = events.filter(
    (event) => event.kind === 'reward-deposit' && isActiveSetupEvent(event),
  ).length;
  return logicalIncomeStreamCount + standaloneIncomeCount + rewardDepositCount;
};

export const countPotentialSetupDuplicateEvents = (events: SetupEvent[]): number => {
  const activeEvents = events.filter(isActiveSetupEvent);
  return (
    activeEvents.length -
    new Set(
      activeEvents.map(
        (event) =>
          `${event.accountId}|${event.incomeStreamId ?? event.incomePlanId ?? 'standalone'}|${event.kind}|${event.date}|${event.direction}|${event.amountCents}|${event.label.toLocaleLowerCase()}`,
      ),
    ).size
  );
};
