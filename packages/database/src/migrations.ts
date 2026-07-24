import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  sql: string;
  reapplyIfMissing?: boolean;
  run?: (database: Database.Database) => void;
}

interface LegacyIncomeRow {
  id: string;
  userId: string;
  accountId: string;
  date: string;
  amountCents: number;
  certainty: string;
  status: string;
  label: string;
  hypothetical: number;
  accepted: number;
  includeInConservative: number | null;
  recurrenceJson: string | null;
  recurrenceEndDate: string | null;
  paymentMethod: string;
  incomeType: string | null;
  parentIncomeEventId: string | null;
  incomePlanId: string | null;
  incomeStreamId: string | null;
  incomePlanTotalCents: number | null;
  incomeNominalDate: string | null;
  notes: string | null;
}

const dateMilliseconds = (value: string): number => Date.parse(`${value}T00:00:00Z`);

const daysBetweenDates = (start: string, end: string): number =>
  Math.round((dateMilliseconds(end) - dateMilliseconds(start)) / 86_400_000);

const addDateDays = (value: string, days: number): string => {
  const date = new Date(dateMilliseconds(value));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const isBiweekly = (value: string | null): boolean => {
  if (!value) return false;
  try {
    return (JSON.parse(value) as { frequency?: unknown }).frequency === 'biweekly';
  } catch {
    return false;
  }
};

const normalizedIncomeLabel = (value: string): string => value.trim().toLocaleLowerCase();

const incomeLabelStem = (value: string): string =>
  normalizedIncomeLabel(value)
    .split(/[\u2013\u2014:|-]/u)[0]!
    .trim();

const isExplicitSplitIncomeLabel = (value: string): boolean =>
  /\b(split|allocation|allocated|portion)\b/iu.test(value);

const isPaycheckLike = (row: LegacyIncomeRow): boolean =>
  row.incomeType === 'paycheck' || /\b(paycheck|payroll|salary|wages?)\b/iu.test(row.label);

const stableIncomeId = (prefix: string, values: string[]): string =>
  `${prefix}-${createHash('sha256')
    .update([...values].sort().join('\u0000'))
    .digest('hex')
    .slice(0, 32)}`;

const sameLegacyPhaseMetadata = (left: LegacyIncomeRow, right: LegacyIncomeRow): boolean =>
  left.userId === right.userId &&
  left.certainty === right.certainty &&
  left.status === right.status &&
  left.hypothetical === right.hypothetical &&
  left.accepted === right.accepted &&
  left.includeInConservative === right.includeInConservative &&
  left.paymentMethod === right.paymentMethod &&
  left.recurrenceJson === right.recurrenceJson &&
  left.notes === right.notes;

/**
 * The old routed-paycheck editor described the early secondary-account leg as a split and kept
 * the later primary-account leg's label/account when routing collapsed back to one destination.
 * Requiring that full signature prevents two independent jobs with coincidentally aligned dates
 * and amounts from being combined into one income stream.
 */
const hasLegacySplitRoutingSignature = (
  left: LegacyIncomeRow,
  right: LegacyIncomeRow,
  successor: LegacyIncomeRow,
  nominalDate: string,
): boolean => {
  const legs = [left, right];
  const continuingLegs = legs.filter(
    (leg) =>
      leg.accountId === successor.accountId &&
      normalizedIncomeLabel(leg.label) === normalizedIncomeLabel(successor.label),
  );
  if (continuingLegs.length !== 1) return false;

  const continuingLeg = continuingLegs[0]!;
  const splitLeg = legs.find((leg) => leg !== continuingLeg)!;
  return (
    continuingLeg.date === nominalDate &&
    splitLeg.date < continuingLeg.date &&
    isExplicitSplitIncomeLabel(splitLeg.label)
  );
};

const scopedIncomePlanKey = (userId: string, incomePlanId: string): string =>
  JSON.stringify([userId, incomePlanId]);

const requiredIncomeBackfillColumns = [
  'id',
  'user_id',
  'account_id',
  'date',
  'kind',
  'direction',
  'amount_cents',
  'certainty',
  'status',
  'label',
  'hypothetical',
  'accepted',
  'include_in_conservative',
  'recurrence_json',
  'recurrence_end_date',
  'payment_method',
  'income_type',
  'parent_income_event_id',
  'income_plan_id',
  'income_stream_id',
  'income_plan_total_cents',
  'income_nominal_date',
  'notes',
] as const;

const readIncomeRows = (database: Database.Database): LegacyIncomeRow[] =>
  database
    .prepare(
      `SELECT id,
              user_id AS userId,
              account_id AS accountId,
              date,
              amount_cents AS amountCents,
              certainty,
              status,
              label,
              hypothetical,
              accepted,
              include_in_conservative AS includeInConservative,
              recurrence_json AS recurrenceJson,
              recurrence_end_date AS recurrenceEndDate,
              payment_method AS paymentMethod,
              income_type AS incomeType,
              parent_income_event_id AS parentIncomeEventId,
              income_plan_id AS incomePlanId,
              income_stream_id AS incomeStreamId,
              income_plan_total_cents AS incomePlanTotalCents,
              income_nominal_date AS incomeNominalDate,
              notes
       FROM forecast_events
       WHERE kind = 'income' AND direction = 'inflow'`,
    )
    .all() as LegacyIncomeRow[];

const latestBiweeklyOccurrence = (startDate: string, endDate: string): string | undefined => {
  const spanDays = daysBetweenDates(startDate, endDate);
  if (!Number.isFinite(spanDays) || spanDays < 0) return undefined;
  return addDateDays(startDate, Math.floor(spanDays / 14) * 14);
};

/**
 * Conservatively recognizes the legacy representation used before routed-paycheck plans existed:
 * two account legs ending together, followed by their exact total on the next biweekly payday.
 * Ambiguous matches are deliberately left untouched.
 */
export const backfillLegacyIncomeStreams = (database: Database.Database): void => {
  const columns = new Set(
    (
      database.prepare("SELECT name FROM pragma_table_info('forecast_events')").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (columns.has('user_id') && columns.has('income_stream_id')) {
    database.exec(
      `CREATE INDEX IF NOT EXISTS forecast_events_income_stream_idx
       ON forecast_events(user_id, income_stream_id)`,
    );
  }
  if (requiredIncomeBackfillColumns.some((column) => !columns.has(column))) return;

  const rows = readIncomeRows(database);
  const standalone = rows.filter(
    (row) =>
      !row.incomePlanId &&
      !row.parentIncomeEventId &&
      row.paymentMethod === 'cash-account' &&
      row.amountCents > 0 &&
      row.status !== 'cancelled' &&
      row.status !== 'skipped' &&
      (row.incomeType === null || row.incomeType === 'paycheck') &&
      isBiweekly(row.recurrenceJson) &&
      isPaycheckLike(row),
  );
  const matches: Array<{
    legs: [LegacyIncomeRow, LegacyIncomeRow];
    successor: LegacyIncomeRow;
    nominalDate: string;
  }> = [];
  for (let leftIndex = 0; leftIndex < standalone.length; leftIndex += 1) {
    const left = standalone[leftIndex]!;
    if (!left.recurrenceEndDate) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < standalone.length; rightIndex += 1) {
      const right = standalone[rightIndex]!;
      if (
        !right.recurrenceEndDate ||
        left.recurrenceEndDate !== right.recurrenceEndDate ||
        left.accountId === right.accountId ||
        !sameLegacyPhaseMetadata(left, right)
      ) {
        continue;
      }
      const nominalDate = left.date > right.date ? left.date : right.date;
      const arrivalSpreadDays = Math.abs(daysBetweenDates(left.date, right.date));
      if (!Number.isFinite(arrivalSpreadDays) || arrivalSpreadDays > 7) continue;
      const lastOccurrence = latestBiweeklyOccurrence(nominalDate, left.recurrenceEndDate);
      if (!lastOccurrence) continue;
      const successorDate = addDateDays(lastOccurrence, 14);
      const totalCents = left.amountCents + right.amountCents;
      for (const successor of standalone) {
        if (
          successor.id === left.id ||
          successor.id === right.id ||
          successor.date !== successorDate ||
          successor.amountCents !== totalCents ||
          successor.recurrenceEndDate !== null ||
          !sameLegacyPhaseMetadata(left, successor) ||
          !hasLegacySplitRoutingSignature(left, right, successor, nominalDate)
        ) {
          continue;
        }
        matches.push({ legs: [left, right], successor, nominalDate });
      }
    }
  }

  const matchUseCount = new Map<string, number>();
  for (const match of matches) {
    for (const id of [...match.legs.map((leg) => leg.id), match.successor.id]) {
      matchUseCount.set(id, (matchUseCount.get(id) ?? 0) + 1);
    }
  }
  const updatePhase = database.prepare(
    `UPDATE forecast_events
     SET income_type = COALESCE(income_type, 'paycheck'),
         income_plan_id = @incomePlanId,
         income_stream_id = @incomeStreamId,
         income_plan_total_cents = @incomePlanTotalCents,
         income_nominal_date = @incomeNominalDate,
         income_arrival_offset_days = @incomeArrivalOffsetDays,
         income_allocation_rule = @incomeAllocationRule,
         income_allocation_order = @incomeAllocationOrder
     WHERE user_id = @userId AND id = @id AND income_plan_id IS NULL`,
  );
  const migratedIds = new Set<string>();
  for (const match of matches) {
    const ids = [...match.legs.map((leg) => leg.id), match.successor.id];
    if (ids.some((id) => matchUseCount.get(id) !== 1 || migratedIds.has(id))) continue;
    const streamId = stableIncomeId('legacy-income-stream', [match.legs[0].userId, ...ids]);
    const currentPlanId = stableIncomeId(
      'legacy-income-phase',
      match.legs.map((leg) => leg.id),
    );
    const successorPlanId = stableIncomeId('legacy-income-phase', [match.successor.id]);
    const rankedLegs = [...match.legs].sort((left, right) => {
      const leftContinuity =
        Number(left.accountId === match.successor.accountId) * 2 +
        Number(normalizedIncomeLabel(left.label) === normalizedIncomeLabel(match.successor.label));
      const rightContinuity =
        Number(right.accountId === match.successor.accountId) * 2 +
        Number(normalizedIncomeLabel(right.label) === normalizedIncomeLabel(match.successor.label));
      return (
        rightContinuity - leftContinuity ||
        right.date.localeCompare(left.date) ||
        left.id.localeCompare(right.id)
      );
    });
    const remainder = rankedLegs[0]!;
    const orderedLegs = [...match.legs].sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        Number(left === remainder) - Number(right === remainder) ||
        left.id.localeCompare(right.id),
    );
    orderedLegs.forEach((leg, incomeAllocationOrder) => {
      updatePhase.run({
        userId: leg.userId,
        id: leg.id,
        incomePlanId: currentPlanId,
        incomeStreamId: streamId,
        incomePlanTotalCents: match.legs[0].amountCents + match.legs[1].amountCents,
        incomeNominalDate: match.nominalDate,
        incomeArrivalOffsetDays: daysBetweenDates(match.nominalDate, leg.date),
        incomeAllocationRule: leg === remainder ? 'remainder' : 'fixed',
        incomeAllocationOrder,
      });
    });
    updatePhase.run({
      userId: match.successor.userId,
      id: match.successor.id,
      incomePlanId: successorPlanId,
      incomeStreamId: streamId,
      incomePlanTotalCents: match.successor.amountCents,
      incomeNominalDate: match.successor.date,
      incomeArrivalOffsetDays: 0,
      incomeAllocationRule: 'remainder',
      incomeAllocationOrder: 0,
    });
    ids.forEach((id) => migratedIds.add(id));
  }

  database.exec(
    `UPDATE forecast_events
     SET income_stream_id = income_plan_id
     WHERE income_plan_id IS NOT NULL AND income_stream_id IS NULL`,
  );

  const groupedRows = readIncomeRows(database).filter(
    (row) =>
      row.incomePlanId &&
      row.incomeStreamId === row.incomePlanId &&
      row.status !== 'cancelled' &&
      row.status !== 'skipped' &&
      (row.incomeType === null || row.incomeType === 'paycheck') &&
      isBiweekly(row.recurrenceJson) &&
      isPaycheckLike(row),
  );
  const groupedPlans = new Map<string, LegacyIncomeRow[]>();
  for (const row of groupedRows) {
    const planKey = scopedIncomePlanKey(row.userId, row.incomePlanId!);
    groupedPlans.set(planKey, [...(groupedPlans.get(planKey) ?? []), row]);
  }
  const phases = [...groupedPlans.values()]
    .map((events) => {
      const first = events[0]!;
      const planId = first.incomePlanId!;
      const valid = events.every(
        (event) =>
          event.userId === first.userId &&
          event.incomePlanTotalCents === first.incomePlanTotalCents &&
          event.incomeNominalDate === first.incomeNominalDate &&
          event.recurrenceEndDate === first.recurrenceEndDate &&
          event.recurrenceJson === first.recurrenceJson,
      );
      const allocatedCents = events.reduce((sum, event) => sum + event.amountCents, 0);
      return valid &&
        first.incomePlanTotalCents === allocatedCents &&
        first.incomeNominalDate &&
        first.incomePlanTotalCents
        ? { planId, events, first }
        : undefined;
    })
    .filter((phase): phase is NonNullable<typeof phase> => phase !== undefined);
  const phaseMatches: Array<[(typeof phases)[number], (typeof phases)[number]]> = [];
  for (const current of phases) {
    if (!current.first.recurrenceEndDate) continue;
    const lastOccurrence = latestBiweeklyOccurrence(
      current.first.incomeNominalDate!,
      current.first.recurrenceEndDate,
    );
    if (!lastOccurrence) continue;
    const nextDate = addDateDays(lastOccurrence, 14);
    for (const successor of phases) {
      if (
        successor.planId === current.planId ||
        successor.first.userId !== current.first.userId ||
        successor.first.incomeNominalDate !== nextDate ||
        successor.first.incomePlanTotalCents !== current.first.incomePlanTotalCents ||
        successor.first.recurrenceJson !== current.first.recurrenceJson
      ) {
        continue;
      }
      const currentStems = new Set(current.events.map((event) => incomeLabelStem(event.label)));
      const sharesStableLabel = successor.events.some((event) =>
        currentStems.has(incomeLabelStem(event.label)),
      );
      if (sharesStableLabel) phaseMatches.push([current, successor]);
    }
  }
  const phaseUseCount = new Map<string, number>();
  for (const [current, successor] of phaseMatches) {
    const currentKey = scopedIncomePlanKey(current.first.userId, current.planId);
    const successorKey = scopedIncomePlanKey(successor.first.userId, successor.planId);
    phaseUseCount.set(currentKey, (phaseUseCount.get(currentKey) ?? 0) + 1);
    phaseUseCount.set(successorKey, (phaseUseCount.get(successorKey) ?? 0) + 1);
  }
  const updateStream = database.prepare(
    `UPDATE forecast_events
     SET income_stream_id = ?
     WHERE user_id = ? AND income_plan_id IN (?, ?)`,
  );
  for (const [current, successor] of phaseMatches) {
    const currentKey = scopedIncomePlanKey(current.first.userId, current.planId);
    const successorKey = scopedIncomePlanKey(successor.first.userId, successor.planId);
    if (phaseUseCount.get(currentKey) !== 1 || phaseUseCount.get(successorKey) !== 1) {
      continue;
    }
    const streamId = stableIncomeId('legacy-income-stream', [
      current.first.userId,
      current.planId,
      successor.planId,
    ]);
    updateStream.run(streamId, current.first.userId, current.planId, successor.planId);
  }
};

interface RoutedPaycheckRow {
  id: string;
  userId: string;
  accountId: string;
  date: string;
  amountCents: number;
  certainty: string;
  status: string;
  label: string;
  sourceRecordId: string | null;
  hypothetical: number;
  accepted: number;
  includeInConservative: number | null;
  recurrenceJson: string | null;
  recurrenceEndDate: string | null;
  paymentMethod: string;
  incomeType: string | null;
  parentIncomeEventId: string | null;
  incomePlanId: string;
  incomeStreamId: string;
  incomePlanTotalCents: number;
  incomeNominalDate: string;
  incomeArrivalOffsetDays: number;
  incomeAllocationRule: string;
  incomeAllocationOrder: number;
  parentIncomePlanId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RoutedPaycheckTransferRow {
  id: string;
  userId: string;
  accountId: string;
  date: string;
  kind: string;
  direction: string;
  amountCents: number;
  certainty: string;
  status: string;
  transferId: string;
  sourceRecordId: string | null;
  hypothetical: number;
  accepted: number;
  includeInConservative: number | null;
  recurrenceJson: string | null;
  recurrenceEndDate: string | null;
  paymentMethod: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LegacyImportLineageSummary {
  entityId: string;
  fieldCount: number;
  editedFieldCount: number;
}

const requiredPaycheckTransferRepairColumns = [
  'id',
  'user_id',
  'account_id',
  'date',
  'kind',
  'direction',
  'amount_cents',
  'certainty',
  'status',
  'label',
  'manual_order',
  'source_record_id',
  'transfer_id',
  'hypothetical',
  'accepted',
  'include_in_conservative',
  'recurrence_json',
  'recurrence_end_date',
  'payment_method',
  'card_id',
  'card_activity_treatment',
  'loan_payment_treatment',
  'income_type',
  'parent_income_event_id',
  'income_plan_id',
  'income_stream_id',
  'income_plan_total_cents',
  'income_nominal_date',
  'income_arrival_offset_days',
  'income_allocation_rule',
  'income_allocation_order',
  'parent_income_plan_id',
  'receivable_occurrence_date',
  'receivable_occurrence_target_cents',
  'notes',
  'created_at',
  'updated_at',
] as const;

const routedPaycheckPhaseKey = (row: RoutedPaycheckRow): string =>
  JSON.stringify([row.userId, row.incomeStreamId, row.incomePlanId]);

const sameRoutedPaycheckMetadata = (left: RoutedPaycheckRow, right: RoutedPaycheckRow): boolean =>
  left.userId === right.userId &&
  left.incomeStreamId === right.incomeStreamId &&
  left.incomePlanTotalCents === right.incomePlanTotalCents &&
  left.certainty === right.certainty &&
  left.status === right.status &&
  left.hypothetical === right.hypothetical &&
  left.accepted === right.accepted &&
  left.includeInConservative === right.includeInConservative &&
  left.paymentMethod === right.paymentMethod &&
  left.recurrenceJson === right.recurrenceJson;

/**
 * Repairs one narrowly identifiable legacy import shape. Older seed logic represented a future
 * early-arriving paycheck allocation as a same-day internal transfer from the payday account.
 * That moved account cash early but delayed consolidated income until payday. When the preceding
 * phase proves the amount is an employer-routed allocation, replace the successor transfer with a
 * real allocation in the same paycheck plan and retain the cancelled transfer pair for audit.
 */
export const repairLegacyEarlyPaycheckTransfer = (database: Database.Database): void => {
  const columns = new Set(
    (
      database.prepare("SELECT name FROM pragma_table_info('forecast_events')").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (requiredPaycheckTransferRepairColumns.some((column) => !columns.has(column))) return;
  const tableNames = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  if (!tableNames.has('import_lineage')) return;
  const lineageColumns = new Set(
    (
      database.prepare("SELECT name FROM pragma_table_info('import_lineage')").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (
    !['entity_type', 'entity_id', 'destination_edited_at'].every((column) =>
      lineageColumns.has(column),
    )
  ) {
    return;
  }
  const lineageByEntityId = new Map(
    (
      database
        .prepare(
          `SELECT entity_id AS entityId,
                  COUNT(*) AS fieldCount,
                  SUM(CASE WHEN destination_edited_at IS NOT NULL THEN 1 ELSE 0 END) AS editedFieldCount
             FROM import_lineage
            WHERE entity_type = 'forecast-event'
            GROUP BY entity_id`,
        )
        .all() as LegacyImportLineageSummary[]
    ).map((summary) => [summary.entityId, summary]),
  );

  const incomeRows = database
    .prepare(
      `SELECT id,
              user_id AS userId,
              account_id AS accountId,
              date,
              amount_cents AS amountCents,
              certainty,
              status,
              label,
              source_record_id AS sourceRecordId,
              hypothetical,
              accepted,
              include_in_conservative AS includeInConservative,
              recurrence_json AS recurrenceJson,
              recurrence_end_date AS recurrenceEndDate,
              payment_method AS paymentMethod,
              income_type AS incomeType,
              parent_income_event_id AS parentIncomeEventId,
              income_plan_id AS incomePlanId,
              income_stream_id AS incomeStreamId,
              income_plan_total_cents AS incomePlanTotalCents,
              income_nominal_date AS incomeNominalDate,
              income_arrival_offset_days AS incomeArrivalOffsetDays,
              income_allocation_rule AS incomeAllocationRule,
              income_allocation_order AS incomeAllocationOrder,
              parent_income_plan_id AS parentIncomePlanId,
              notes,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM forecast_events
       WHERE kind = 'income'
         AND direction = 'inflow'
         AND income_type = 'paycheck'
         AND payment_method = 'cash-account'
         AND income_plan_id IS NOT NULL
         AND income_stream_id IS NOT NULL
         AND income_plan_total_cents IS NOT NULL
         AND income_nominal_date IS NOT NULL
         AND income_arrival_offset_days IS NOT NULL
         AND income_allocation_rule IS NOT NULL
         AND income_allocation_order IS NOT NULL
         AND status NOT IN ('cancelled', 'skipped')`,
    )
    .all() as RoutedPaycheckRow[];
  const phases = new Map<string, RoutedPaycheckRow[]>();
  for (const row of incomeRows) {
    const key = routedPaycheckPhaseKey(row);
    phases.set(key, [...(phases.get(key) ?? []), row]);
  }

  const transferRows = database
    .prepare(
      `SELECT id,
              user_id AS userId,
              account_id AS accountId,
              date,
              kind,
              direction,
              amount_cents AS amountCents,
              certainty,
              status,
              transfer_id AS transferId,
              source_record_id AS sourceRecordId,
              hypothetical,
              accepted,
              include_in_conservative AS includeInConservative,
              recurrence_json AS recurrenceJson,
              recurrence_end_date AS recurrenceEndDate,
              payment_method AS paymentMethod,
              notes,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM forecast_events
       WHERE transfer_id IS NOT NULL
         AND kind IN ('transfer-debit', 'transfer-credit')
         AND status NOT IN ('cancelled', 'skipped')`,
    )
    .all() as RoutedPaycheckTransferRow[];
  const transfers = new Map<string, RoutedPaycheckTransferRow[]>();
  for (const row of transferRows) {
    const key = JSON.stringify([row.userId, row.transferId]);
    transfers.set(key, [...(transfers.get(key) ?? []), row]);
  }

  const matches: Array<{
    early: RoutedPaycheckRow;
    payday: RoutedPaycheckRow;
    successor: RoutedPaycheckRow;
    debit: RoutedPaycheckTransferRow;
    credit: RoutedPaycheckTransferRow;
  }> = [];
  for (const current of phases.values()) {
    if (current.length !== 2) continue;
    const [first, second] = current;
    if (
      !first ||
      !second ||
      !sameRoutedPaycheckMetadata(first, second) ||
      first.notes !== second.notes
    ) {
      continue;
    }
    if (
      !first.recurrenceEndDate ||
      first.recurrenceEndDate !== second.recurrenceEndDate ||
      !isBiweekly(first.recurrenceJson) ||
      first.incomePlanTotalCents <= 0 ||
      first.amountCents + second.amountCents !== first.incomePlanTotalCents
    ) {
      continue;
    }
    const early = current.find(
      (row) =>
        row.incomeAllocationRule === 'fixed' &&
        row.incomeAllocationOrder === 0 &&
        row.incomeArrivalOffsetDays < 0 &&
        row.incomeArrivalOffsetDays >= -7 &&
        row.date === addDateDays(row.incomeNominalDate, row.incomeArrivalOffsetDays),
    );
    const payday = current.find(
      (row) =>
        row.incomeAllocationRule === 'remainder' &&
        row.incomeAllocationOrder === 1 &&
        row.incomeArrivalOffsetDays === 0 &&
        row.date === row.incomeNominalDate,
    );
    if (!early || !payday || early.accountId === payday.accountId) continue;
    const lastOccurrence = latestBiweeklyOccurrence(
      payday.incomeNominalDate,
      payday.recurrenceEndDate!,
    );
    if (!lastOccurrence) continue;
    const nextNominalDate = addDateDays(lastOccurrence, 14);
    const successorCandidates = [...phases.values()].filter((phase) => {
      if (phase.length !== 1) return false;
      const successor = phase[0]!;
      return (
        successor.incomePlanId !== payday.incomePlanId &&
        successor.userId === payday.userId &&
        successor.incomeStreamId === payday.incomeStreamId &&
        successor.accountId === payday.accountId &&
        successor.incomeNominalDate === nextNominalDate &&
        successor.date === nextNominalDate &&
        successor.amountCents === payday.incomePlanTotalCents &&
        successor.incomePlanTotalCents === payday.incomePlanTotalCents &&
        successor.incomeArrivalOffsetDays === 0 &&
        successor.incomeAllocationRule === 'remainder' &&
        successor.incomeAllocationOrder === 0 &&
        successor.recurrenceEndDate === null &&
        sameRoutedPaycheckMetadata(payday, successor)
      );
    });
    if (successorCandidates.length !== 1) continue;
    const successor = successorCandidates[0]![0]!;
    const earlyDate = addDateDays(nextNominalDate, early.incomeArrivalOffsetDays);
    const transferCandidates = [...transfers.values()].filter((pair) => {
      if (pair.length !== 2) return false;
      const debit = pair.find(
        (row) => row.kind === 'transfer-debit' && row.direction === 'outflow',
      );
      const credit = pair.find(
        (row) => row.kind === 'transfer-credit' && row.direction === 'inflow',
      );
      return Boolean(
        debit &&
        credit &&
        debit.userId === successor.userId &&
        debit.accountId === successor.accountId &&
        credit.accountId === early.accountId &&
        debit.amountCents === early.amountCents &&
        credit.amountCents === early.amountCents &&
        debit.date === earlyDate &&
        credit.date === earlyDate &&
        debit.certainty === successor.certainty &&
        credit.certainty === successor.certainty &&
        debit.status === successor.status &&
        credit.status === successor.status &&
        debit.recurrenceJson === successor.recurrenceJson &&
        debit.recurrenceEndDate === null &&
        credit.recurrenceJson === null &&
        credit.recurrenceEndDate === null &&
        debit.sourceRecordId === null &&
        credit.sourceRecordId === null &&
        debit.hypothetical === 0 &&
        credit.hypothetical === 0 &&
        debit.accepted === 0 &&
        credit.accepted === 0 &&
        debit.includeInConservative === null &&
        credit.includeInConservative === null &&
        debit.paymentMethod === 'cash-account' &&
        credit.paymentMethod === 'cash-account' &&
        debit.notes === null &&
        credit.notes === null,
      );
    });
    if (transferCandidates.length !== 1) continue;
    const transfer = transferCandidates[0]!;
    const debit = transfer.find((row) => row.kind === 'transfer-debit')!;
    const credit = transfer.find((row) => row.kind === 'transfer-credit')!;
    const provenanceRows = [early, payday, successor, debit, credit];
    const hasUntouchedLegacyProvenance = provenanceRows.every((row) => {
      const lineage = lineageByEntityId.get(row.id);
      return (
        row.createdAt === row.updatedAt &&
        lineage !== undefined &&
        lineage.fieldCount > 0 &&
        lineage.editedFieldCount === 0
      );
    });
    if (!hasUntouchedLegacyProvenance) continue;
    matches.push({
      early,
      payday,
      successor,
      debit,
      credit,
    });
  }

  const matchUseCount = new Map<string, number>();
  for (const match of matches) {
    for (const id of [
      match.early.id,
      match.payday.id,
      match.successor.id,
      match.debit.id,
      match.credit.id,
    ]) {
      matchUseCount.set(id, (matchUseCount.get(id) ?? 0) + 1);
    }
  }
  const timestamp = new Date().toISOString();
  const insertAllocation = database.prepare(
    `INSERT INTO forecast_events (
       id, user_id, account_id, date, kind, direction, amount_cents, certainty, status,
       label, manual_order, source_record_id, transfer_id, hypothetical, accepted,
       include_in_conservative, recurrence_json, recurrence_end_date, payment_method, card_id,
       card_activity_treatment, loan_payment_treatment, income_type, parent_income_event_id,
       income_plan_id, income_stream_id, income_plan_total_cents, income_nominal_date,
       income_arrival_offset_days, income_allocation_rule, income_allocation_order,
       parent_income_plan_id, receivable_occurrence_date, receivable_occurrence_target_cents,
       notes, created_at, updated_at
     )
     SELECT @id, user_id, @accountId, @date, kind, direction, @amountCents, certainty, status,
            label, manual_order, @sourceRecordId, NULL, hypothetical, accepted,
            include_in_conservative, recurrence_json, recurrence_end_date, payment_method, card_id,
            card_activity_treatment, loan_payment_treatment, income_type, parent_income_event_id,
            income_plan_id, income_stream_id, income_plan_total_cents, income_nominal_date,
            @offsetDays, 'fixed', 0, parent_income_plan_id, NULL, NULL,
            notes, @timestamp, @timestamp
       FROM forecast_events
      WHERE user_id = @userId AND id = @successorId`,
  );
  const updateSuccessor = database.prepare(
    `UPDATE forecast_events
        SET amount_cents = @amountCents,
            income_allocation_order = 1,
            updated_at = @timestamp
      WHERE user_id = @userId AND id = @successorId AND amount_cents = @priorAmountCents`,
  );
  const cancelTransfer = database.prepare(
    `UPDATE forecast_events
        SET status = 'cancelled',
            notes = CASE
              WHEN notes IS NULL OR trim(notes) = '' THEN @repairNote
              ELSE notes || ' ' || @repairNote
            END,
            updated_at = @timestamp
      WHERE user_id = @userId AND transfer_id = @transferId
        AND status NOT IN ('cancelled', 'skipped')`,
  );
  const insertAudit = tableNames.has('audit_events')
    ? database.prepare(
        `INSERT OR IGNORE INTO audit_events
         (id, user_id, action, entity_type, entity_id, payload_json, created_at)
         VALUES (@id, @userId, 'repair', 'income-plan', @entityId, @payloadJson, @timestamp)`,
      )
    : undefined;
  const markLineageEdited = tableNames.has('import_lineage')
    ? database.prepare(
        `UPDATE import_lineage
            SET destination_edited_at = COALESCE(destination_edited_at, @timestamp)
          WHERE user_id = @userId
            AND entity_type = 'forecast-event'
            AND entity_id IN (@successorId, @debitId, @creditId)`,
      )
    : undefined;

  const repairedIds = new Set<string>();
  for (const match of matches) {
    const sourceIds = [
      match.early.id,
      match.payday.id,
      match.successor.id,
      match.debit.id,
      match.credit.id,
    ];
    if (sourceIds.some((id) => matchUseCount.get(id) !== 1 || repairedIds.has(id))) continue;
    const remainderCents = match.successor.incomePlanTotalCents - match.early.amountCents;
    if (remainderCents <= 0) continue;
    const allocationId = stableIncomeId('paycheck-early-allocation', [
      match.successor.userId,
      match.successor.id,
      match.early.accountId,
      match.debit.transferId,
    ]);
    const allocationInsert = insertAllocation.run({
      id: allocationId,
      userId: match.successor.userId,
      successorId: match.successor.id,
      accountId: match.early.accountId,
      date: addDateDays(match.successor.incomeNominalDate, match.early.incomeArrivalOffsetDays),
      amountCents: match.early.amountCents,
      sourceRecordId: match.early.sourceRecordId ?? match.early.id,
      offsetDays: match.early.incomeArrivalOffsetDays,
      timestamp,
    });
    if (allocationInsert.changes !== 1) continue;
    const successorUpdate = updateSuccessor.run({
      userId: match.successor.userId,
      successorId: match.successor.id,
      amountCents: remainderCents,
      priorAmountCents: match.successor.amountCents,
      timestamp,
    });
    if (successorUpdate.changes !== 1) {
      throw new Error('Legacy paycheck repair could not update its matched successor phase');
    }
    const repairNote =
      'Replaced by the equivalent early-arriving paycheck allocation during schema migration v28; retained for audit history.';
    const cancelled = cancelTransfer.run({
      userId: match.successor.userId,
      transferId: match.debit.transferId,
      repairNote,
      timestamp,
    });
    if (cancelled.changes !== 2) {
      throw new Error('Legacy paycheck repair could not cancel its matched transfer pair');
    }
    markLineageEdited?.run({
      userId: match.successor.userId,
      successorId: match.successor.id,
      debitId: match.debit.id,
      creditId: match.credit.id,
      timestamp,
    });
    insertAudit?.run({
      id: stableIncomeId('audit-paycheck-early-allocation', sourceIds),
      userId: match.successor.userId,
      entityId: match.successor.incomePlanId,
      payloadJson: JSON.stringify({
        source: 'schema-migration-v28',
        replacementIncomeEventId: allocationId,
        cancelledTransferId: match.debit.transferId,
      }),
      timestamp,
    });
    sourceIds.forEach((id) => repairedIds.add(id));
  }
};

interface ImportedStaticReceivableRepairRow {
  id: string;
  userId: string;
  expectedDate: string;
  balanceAsOf: string;
}

const firstDayOfFollowingMonth = (value: string): string | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== value) return undefined;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  if (nextYear > 9999) return undefined;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
};

/**
 * Repairs untouched imported static receivables whose source supplied a balance but no receipt
 * date. Their required placeholder date matched the destination account snapshot and cash
 * forecasting was disabled. Move only that proven shape to the first day of the following month,
 * preserving the unconfirmed-date label and every noneligible row.
 */
export const repairImportedStaticReceivableDates = (database: Database.Database): void => {
  const requiredColumnsByTable = new Map<string, readonly string[]>([
    [
      'receivables',
      [
        'id',
        'user_id',
        'original_amount_cents',
        'remaining_amount_cents',
        'expected_date',
        'settlement_date_confirmed',
        'settlement_anchor_event_id',
        'settlement_offset_days',
        'certainty',
        'recurring_amount_cents',
        'recurrence_json',
        'recurrence_end_date',
        'accrual_amount_cents',
        'accrual_date',
        'accrual_recurrence_json',
        'include_in_cash_forecast',
        'destination_account_id',
        'created_at',
        'updated_at',
      ],
    ],
    ['cash_accounts', ['id', 'user_id', 'balance_as_of']],
    ['forecast_events', ['user_id', 'kind', 'source_record_id']],
    ['import_lineage', ['user_id', 'entity_type', 'entity_id', 'field', 'destination_edited_at']],
    [
      'audit_events',
      ['id', 'user_id', 'action', 'entity_type', 'entity_id', 'payload_json', 'created_at'],
    ],
  ]);
  for (const [table, requiredColumns] of requiredColumnsByTable) {
    const columns = new Set(
      (
        database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (requiredColumns.some((column) => !columns.has(column))) return;
  }

  const candidates = database
    .prepare(
      `SELECT receivable.id,
              receivable.user_id AS userId,
              receivable.expected_date AS expectedDate,
              account.balance_as_of AS balanceAsOf
         FROM receivables AS receivable
         JOIN cash_accounts AS account
           ON account.id = receivable.destination_account_id
          AND account.user_id = receivable.user_id
        WHERE receivable.remaining_amount_cents > 0
          AND receivable.original_amount_cents >= receivable.remaining_amount_cents
          AND receivable.settlement_date_confirmed = 0
          AND receivable.include_in_cash_forecast = 0
          AND receivable.expected_date = account.balance_as_of
          AND receivable.created_at = receivable.updated_at
          AND receivable.certainty IN ('confirmed', 'expected')
          AND receivable.recurring_amount_cents IS NULL
          AND receivable.recurrence_json IS NULL
          AND receivable.recurrence_end_date IS NULL
          AND receivable.settlement_anchor_event_id IS NULL
          AND receivable.settlement_offset_days IS NULL
          AND receivable.accrual_amount_cents IS NULL
          AND receivable.accrual_date IS NULL
          AND receivable.accrual_recurrence_json IS NULL
          AND EXISTS (
                SELECT 1
                  FROM import_lineage AS expected_lineage
                 WHERE expected_lineage.user_id = receivable.user_id
                   AND expected_lineage.entity_type = 'receivable'
                   AND expected_lineage.entity_id = receivable.id
                   AND expected_lineage.field = 'expectedDate'
              )
          AND EXISTS (
                SELECT 1
                  FROM import_lineage AS forecast_lineage
                 WHERE forecast_lineage.user_id = receivable.user_id
                   AND forecast_lineage.entity_type = 'receivable'
                   AND forecast_lineage.entity_id = receivable.id
                   AND forecast_lineage.field = 'includeInCashForecast'
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM import_lineage AS edited_lineage
                 WHERE edited_lineage.user_id = receivable.user_id
                   AND edited_lineage.entity_type = 'receivable'
                   AND edited_lineage.entity_id = receivable.id
                   AND edited_lineage.destination_edited_at IS NOT NULL
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM forecast_events AS settlement
                 WHERE settlement.user_id = receivable.user_id
                   AND settlement.kind = 'receivable-settlement'
                   AND (
                     settlement.source_record_id = receivable.id
                     OR substr(settlement.source_record_id, 1, length(receivable.id) + 1) =
                        receivable.id || '@'
                   )
              )
        ORDER BY receivable.user_id, receivable.id`,
    )
    .all() as ImportedStaticReceivableRepairRow[];

  const updateReceivable = database.prepare(
    `UPDATE receivables
        SET expected_date = @nextExpectedDate,
            include_in_cash_forecast = 1,
            updated_at = @timestamp
      WHERE id = @id
        AND user_id = @userId
        AND expected_date = @priorExpectedDate
        AND settlement_date_confirmed = 0
        AND include_in_cash_forecast = 0
        AND created_at = updated_at`,
  );
  const markAffectedLineage = database.prepare(
    `UPDATE import_lineage
        SET destination_edited_at = COALESCE(destination_edited_at, @timestamp)
      WHERE user_id = @userId
        AND entity_type = 'receivable'
        AND entity_id = @id
        AND field IN ('expectedDate', 'includeInCashForecast')`,
  );
  const insertAudit = database.prepare(
    `INSERT OR IGNORE INTO audit_events
     (id, user_id, action, entity_type, entity_id, payload_json, created_at)
     VALUES (@auditId, @userId, 'repair', 'receivable', @id, @payloadJson, @timestamp)`,
  );
  const timestamp = new Date().toISOString();
  for (const candidate of candidates) {
    if (candidate.expectedDate !== candidate.balanceAsOf) continue;
    const nextExpectedDate = firstDayOfFollowingMonth(candidate.balanceAsOf);
    if (!nextExpectedDate) continue;
    const updated = updateReceivable.run({
      id: candidate.id,
      userId: candidate.userId,
      priorExpectedDate: candidate.expectedDate,
      nextExpectedDate,
      timestamp,
    });
    if (updated.changes !== 1) continue;
    markAffectedLineage.run({
      id: candidate.id,
      userId: candidate.userId,
      timestamp,
    });
    insertAudit.run({
      auditId: stableIncomeId('audit-static-receivable-date-repair', [
        candidate.userId,
        candidate.id,
        candidate.expectedDate,
        nextExpectedDate,
      ]),
      userId: candidate.userId,
      id: candidate.id,
      payloadJson: JSON.stringify({
        source: 'schema-migration-v29',
        priorExpectedDate: candidate.expectedDate,
        expectedDate: nextExpectedDate,
        includeInCashForecast: true,
        settlementDateConfirmed: false,
      }),
      timestamp,
    });
  }
};

interface LegacyRefinancePlanRow {
  id: string;
  userId: string;
  replacementLoanId: string;
  assetRelinksJson: string;
}

/** Repairs durable refinance collateral lineage and compacts validated legacy commit audits. */
export const backfillRefinanceAssetRelinks = (database: Database.Database): void => {
  const tableNames = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  if (
    ![
      'committed_refinance_plans',
      'committed_refinance_payoffs',
      'audit_events',
      'assets',
      'loans',
    ].every((name) => tableNames.has(name))
  ) {
    return;
  }
  const columns = new Set(
    (
      database
        .prepare("SELECT name FROM pragma_table_info('committed_refinance_plans')")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (!columns.has('asset_relinks_json')) return;

  const plans = database
    .prepare(
      `SELECT id,
              user_id AS userId,
              replacement_loan_id AS replacementLoanId,
              asset_relinks_json AS assetRelinksJson
         FROM committed_refinance_plans`,
    )
    .all() as LegacyRefinancePlanRow[];
  for (const plan of plans) {
    try {
      const existing = JSON.parse(plan.assetRelinksJson) as unknown;
      if (!Array.isArray(existing)) continue;
      const audit = database
        .prepare(
          `SELECT id,
                  payload_json AS payloadJson
             FROM audit_events
            WHERE user_id = ?
              AND entity_type = 'committed-refinance-plan'
              AND entity_id = ?
              AND action = 'commit'
            ORDER BY created_at ASC
            LIMIT 1`,
        )
        .get(plan.userId, plan.id) as { id: string; payloadJson: string } | undefined;
      if (!audit) continue;
      const payload = JSON.parse(audit.payloadJson) as { assetRelinks?: unknown };
      if (!Array.isArray(payload.assetRelinks)) continue;
      const sourceLoanIds = new Set(
        (
          database
            .prepare(
              'SELECT source_loan_id AS sourceLoanId FROM committed_refinance_payoffs WHERE user_id = ? AND plan_id = ? ORDER BY source_loan_id',
            )
            .all(plan.userId, plan.id) as Array<{ sourceLoanId: string }>
        ).map((row) => row.sourceLoanId),
      );
      const assetIds = new Set(
        (
          database.prepare('SELECT id FROM assets WHERE user_id = ?').all(plan.userId) as Array<{
            id: string;
          }>
        ).map((row) => row.id),
      );
      const loanIds = new Set(
        (
          database.prepare('SELECT id FROM loans WHERE user_id = ?').all(plan.userId) as Array<{
            id: string;
          }>
        ).map((row) => row.id),
      );
      type LegacyRelink = {
        assetId: string;
        sourceLoanId: string;
        replacementLoanId: string;
      };
      const validateRelinks = (candidates: unknown[]): LegacyRelink[] | undefined => {
        const seenAssets = new Set<string>();
        const relinks: LegacyRelink[] = [];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object') return undefined;
          const relink = candidate as Record<string, unknown>;
          if (
            typeof relink.assetId !== 'string' ||
            typeof relink.sourceLoanId !== 'string' ||
            relink.replacementLoanId !== plan.replacementLoanId ||
            seenAssets.has(relink.assetId) ||
            !assetIds.has(relink.assetId) ||
            !sourceLoanIds.has(relink.sourceLoanId) ||
            !loanIds.has(relink.sourceLoanId) ||
            !loanIds.has(plan.replacementLoanId)
          ) {
            return undefined;
          }
          seenAssets.add(relink.assetId);
          relinks.push({
            assetId: relink.assetId,
            sourceLoanId: relink.sourceLoanId,
            replacementLoanId: plan.replacementLoanId,
          });
        }
        return relinks;
      };
      const legacyRelinks = validateRelinks(payload.assetRelinks);
      const durableRelinks = validateRelinks(existing);
      if (!legacyRelinks || legacyRelinks.length === 0 || !durableRelinks) continue;
      let relinks = legacyRelinks;
      if (durableRelinks.length > 0) {
        const durableByAsset = new Map(
          durableRelinks.map((relink) => [relink.assetId, relink] as const),
        );
        if (
          durableRelinks.length !== legacyRelinks.length ||
          legacyRelinks.some((relink) => {
            const durable = durableByAsset.get(relink.assetId);
            return (
              !durable ||
              durable.sourceLoanId !== relink.sourceLoanId ||
              durable.replacementLoanId !== relink.replacementLoanId
            );
          })
        ) {
          continue;
        }
        relinks = durableRelinks;
      } else {
        database
          .prepare(
            'UPDATE committed_refinance_plans SET asset_relinks_json = ? WHERE id = ? AND user_id = ?',
          )
          .run(JSON.stringify(relinks), plan.id, plan.userId);
      }
      database.prepare('UPDATE audit_events SET payload_json = ? WHERE id = ? AND user_id = ?').run(
        JSON.stringify({
          plan: {
            id: plan.id,
            replacementLoanId: plan.replacementLoanId,
            sourceLoanIds: [...sourceLoanIds],
          },
          assetRelinkCount: relinks.length,
          migratedLegacyAssetRelinks: true,
        }),
        audit.id,
        plan.userId,
      );
    } catch {
      // Corrupt or nonstandard legacy audit payloads are left unchanged for explicit validation.
    }
  }
};

const addColumnIfMissing = (
  database: Database.Database,
  table:
    | 'profiles'
    | 'cash_accounts'
    | 'forecast_events'
    | 'credit_cards'
    | 'credit_card_cycles'
    | 'loans'
    | 'receivables'
    | 'assets',
  column: string,
  definition: string,
): void => {
  const existing = database.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
    name: string;
  }>;
  if (existing.length === 0) return;
  if (existing.some((candidate) => candidate.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

const addCashAccountOverviewVisibility = (database: Database.Database): void => {
  addColumnIfMissing(database, 'cash_accounts', 'show_on_overview', 'INTEGER NOT NULL DEFAULT 1');
};

const addProfilePreferences = (database: Database.Database): void => {
  addColumnIfMissing(database, 'profiles', 'preferences_json', "TEXT NOT NULL DEFAULT '{}'");
};

const addRecordedCardPaymentAccount = (database: Database.Database): void => {
  addColumnIfMissing(database, 'credit_card_cycles', 'actual_payment_account_id', 'TEXT');
};

const addSameDayBalanceBoundaryTreatment = (database: Database.Database): void => {
  addColumnIfMissing(
    database,
    'forecast_events',
    'applies_after_balance_snapshot',
    'INTEGER NOT NULL DEFAULT 0',
  );
};

const addNotificationPresentationMetadata = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS notification_presentations (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      notification_id TEXT NOT NULL,
      condition_fingerprint TEXT NOT NULL,
      read_at TEXT,
      snoozed_until TEXT,
      dismissed_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = database
    .prepare("PRAGMA table_info('notification_presentations')")
    .all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'condition_fingerprint')) {
    database.exec(
      "ALTER TABLE notification_presentations ADD COLUMN condition_fingerprint TEXT NOT NULL DEFAULT 'legacy'",
    );
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS notification_presentations_user_notification_unique
      ON notification_presentations(user_id, notification_id);
    CREATE INDEX IF NOT EXISTS notification_presentations_user_updated_idx
      ON notification_presentations(user_id, updated_at);
  `);
};

const addInvestmentForecastAssumptions = (database: Database.Database): void => {
  addColumnIfMissing(database, 'assets', 'annual_growth_rate_basis_points', 'INTEGER');
  addColumnIfMissing(database, 'assets', 'contribution_gross_annual_income_cents', 'INTEGER');
};

const addCardInterestForecastControls = (database: Database.Database): void => {
  addColumnIfMissing(
    database,
    'credit_cards',
    'interest_forecast_enabled',
    'INTEGER NOT NULL DEFAULT 0',
  );
  addColumnIfMissing(
    database,
    'credit_cards',
    'promotional_carrying_balance',
    'INTEGER NOT NULL DEFAULT 0',
  );
  addColumnIfMissing(database, 'credit_cards', 'promotional_apr_basis_points', 'INTEGER');
};

const addDebtTrackingMetadata = (database: Database.Database): void => {
  addColumnIfMissing(
    database,
    'credit_cards',
    'account_kind',
    "TEXT NOT NULL DEFAULT 'credit-card'",
  );
  addColumnIfMissing(database, 'credit_cards', 'credit_limit_cents', 'INTEGER');
  addColumnIfMissing(database, 'credit_cards', 'reported_balance_cents', 'INTEGER');
  addColumnIfMissing(database, 'credit_cards', 'reported_balance_date', 'TEXT');
  addColumnIfMissing(database, 'credit_cards', 'reported_carrying_balance_cents', 'INTEGER');
  addColumnIfMissing(database, 'credit_cards', 'reported_carrying_balance_date', 'TEXT');
  addColumnIfMissing(database, 'credit_card_cycles', 'actual_payment_cents', 'INTEGER');
  addColumnIfMissing(database, 'loans', 'cash_payment_cents', 'INTEGER');
  addColumnIfMissing(database, 'loans', 'original_term_months', 'INTEGER');
  addColumnIfMissing(database, 'loans', 'inferred_fields_json', 'TEXT');
};

const addLoanPaymentTreatment = (database: Database.Database): void => {
  addColumnIfMissing(
    database,
    'forecast_events',
    'loan_payment_treatment',
    "TEXT NOT NULL DEFAULT 'scheduled-draft-override'",
  );
};

const addCardAccountLifecycle = (database: Database.Database): void => {
  addColumnIfMissing(database, 'credit_cards', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(database, 'credit_cards', 'closed_on', 'TEXT');
};

const addExplicitLoanBalloonTerms = (database: Database.Database): void => {
  addColumnIfMissing(
    database,
    'loans',
    'amortization_structure',
    "TEXT NOT NULL DEFAULT 'fully-amortizing'",
  );
  addColumnIfMissing(database, 'loans', 'expected_balloon_cents', 'INTEGER');
};

const addReceivableSettlementAnchors = (database: Database.Database): void => {
  // Existing rows continue to use expected_date plus recurrence_json. Nullable anchor fields make
  // the migration a metadata-only extension with no inferred links or changed cash dates.
  addColumnIfMissing(
    database,
    'receivables',
    'settlement_anchor_event_id',
    'TEXT REFERENCES forecast_events(id) ON DELETE RESTRICT',
  );
  addColumnIfMissing(database, 'receivables', 'settlement_offset_days', 'INTEGER');
};

const addReceivableOccurrenceMetadata = (database: Database.Database): void => {
  addColumnIfMissing(database, 'forecast_events', 'receivable_occurrence_date', 'TEXT');
  addColumnIfMissing(database, 'forecast_events', 'receivable_occurrence_target_cents', 'INTEGER');
  const columns = new Set(
    (database.prepare("PRAGMA table_info('forecast_events')").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (
    !['id', 'source_record_id', 'notes', 'kind', 'receivable_occurrence_date'].every((column) =>
      columns.has(column),
    )
  ) {
    return;
  }

  const occurrencePrefix = 'balance-book:receivable-occurrence=';
  const receivableColumns = new Set(
    (database.prepare("PRAGMA table_info('receivables')").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const exactReceivableIds = receivableColumns.has('id')
    ? new Set(
        (database.prepare('SELECT id FROM receivables').all() as Array<{ id: string }>).map(
          (row) => row.id,
        ),
      )
    : new Set<string>();
  const rows = database
    .prepare(
      `SELECT id,
              source_record_id AS sourceRecordId,
              notes
         FROM forecast_events
        WHERE kind = 'receivable-settlement'
          AND receivable_occurrence_date IS NULL`,
    )
    .all() as Array<{ id: string; sourceRecordId: string | null; notes: string | null }>;
  const update = database.prepare(
    'UPDATE forecast_events SET receivable_occurrence_date = ? WHERE id = ?',
  );
  const validPlainDate = (value: string | undefined): value is string => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const milliseconds = dateMilliseconds(value);
    return (
      Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
    );
  };
  for (const row of rows) {
    const notesDate = row.notes
      ?.split(/\r?\n/u)
      .find((line) => line.startsWith(occurrencePrefix))
      ?.slice(occurrencePrefix.length);
    const sourceDate = exactReceivableIds.has(row.sourceRecordId ?? '')
      ? undefined
      : row.sourceRecordId?.match(/@(\d{4}-\d{2}-\d{2})$/u)?.[1];
    const occurrenceDate = validPlainDate(notesDate)
      ? notesDate
      : validPlainDate(sourceDate)
        ? sourceDate
        : undefined;
    if (occurrenceDate) update.run(occurrenceDate, row.id);
  }
};

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial-local-finance-schema',
    sql: `
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        username TEXT NOT NULL,
        password_salt TEXT,
        password_hash TEXT,
        password_created_at TEXT,
        onboarding_complete INTEGER NOT NULL DEFAULT 0,
        theme_preference TEXT NOT NULL DEFAULT 'dark',
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX profiles_username_unique ON profiles(username);
      CREATE TABLE cash_accounts (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        opening_balance_cents INTEGER NOT NULL,
        balance_as_of TEXT NOT NULL,
        included_in_liquidity INTEGER NOT NULL DEFAULT 1,
        can_fund_other_accounts INTEGER NOT NULL DEFAULT 1,
        hard_floor_cents INTEGER,
        preferred_floor_cents INTEGER,
        transfer_delay_days INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX cash_accounts_user_idx ON cash_accounts(user_id);
      CREATE TABLE forecast_events (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        certainty TEXT NOT NULL,
        status TEXT NOT NULL,
        label TEXT NOT NULL,
        manual_order INTEGER,
        source_record_id TEXT,
        transfer_id TEXT,
        hypothetical INTEGER NOT NULL DEFAULT 0,
        accepted INTEGER NOT NULL DEFAULT 0,
        include_in_conservative INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX forecast_events_user_date_idx ON forecast_events(user_id, date);
      CREATE INDEX forecast_events_account_idx ON forecast_events(account_id);
      CREATE TABLE cash_floor_policies (
        user_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        hard_consolidated_floor_cents INTEGER NOT NULL,
        preferred_consolidated_floor_cents INTEGER,
        horizon_days INTEGER NOT NULL DEFAULT 90,
        include_confirmed_receivables_conservatively INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE credit_cards (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        funding_account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE CASCADE,
        default_future_statement_cents INTEGER NOT NULL,
        estimate_policy TEXT NOT NULL,
        payment_policy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX credit_cards_user_idx ON credit_cards(user_id);
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX audit_events_user_created_idx ON audit_events(user_id, created_at);
    `,
  },
  {
    version: 2,
    name: 'complete-core-financial-records',
    sql: `
      CREATE TABLE credit_card_cycles (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
        opens_on TEXT NOT NULL, closes_on TEXT NOT NULL, due_on TEXT NOT NULL,
        state TEXT NOT NULL, default_estimate_cents INTEGER NOT NULL,
        actual_activity_cents INTEGER NOT NULL DEFAULT 0,
        planned_activity_cents INTEGER NOT NULL DEFAULT 0,
        locked_statement_cents INTEGER, projection_override_cents INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX credit_card_cycles_user_card_idx ON credit_card_cycles(user_id, card_id);
      CREATE TABLE loans (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL, principal_cents INTEGER NOT NULL,
        accrued_interest_cents INTEGER NOT NULL DEFAULT 0, balance_date TEXT NOT NULL,
        annual_rate_basis_points INTEGER NOT NULL, accrual_convention TEXT NOT NULL,
        payment_cents INTEGER NOT NULL, next_payment_date TEXT NOT NULL,
        funding_account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE RESTRICT,
        exclude_from_economic_double_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX loans_user_idx ON loans(user_id);
      CREATE TABLE receivables (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        source TEXT NOT NULL, description TEXT NOT NULL,
        original_amount_cents INTEGER NOT NULL, remaining_amount_cents INTEGER NOT NULL,
        expected_date TEXT NOT NULL,
        destination_account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE RESTRICT,
        certainty TEXT NOT NULL, gross_expense_cents INTEGER, user_economic_share_cents INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX receivables_user_idx ON receivables(user_id);
      CREATE TABLE assets (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL, type TEXT NOT NULL, value_cents INTEGER NOT NULL,
        valuation_date TEXT NOT NULL, included_in_net_worth INTEGER NOT NULL DEFAULT 1,
        included_in_liquidity INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX assets_user_idx ON assets(user_id);
      CREATE TABLE reward_programs (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
        reward_type TEXT NOT NULL, base_rate_basis_points INTEGER NOT NULL,
        point_value_micros INTEGER, annual_fee_cents INTEGER NOT NULL DEFAULT 0,
        treatment TEXT NOT NULL, expected_receipt_date TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX reward_programs_user_idx ON reward_programs(user_id);
      CREATE TABLE reconciliations (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE CASCADE,
        date TEXT NOT NULL, forecast_balance_cents INTEGER NOT NULL,
        actual_balance_cents INTEGER NOT NULL, variance_cents INTEGER NOT NULL,
        resolution TEXT NOT NULL, note TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX reconciliations_user_date_idx ON reconciliations(user_id, date);
      CREATE TABLE saved_scenarios (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        description TEXT NOT NULL, amount_cents INTEGER NOT NULL,
        settlement_date TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL, notes TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX saved_scenarios_user_idx ON saved_scenarios(user_id);
    `,
  },
  {
    version: 3,
    name: 'workbook-import-lineage',
    sql: `
      CREATE TABLE import_batches (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        workbook_checksum TEXT NOT NULL, source_file_name TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, rolled_back_at TEXT
      );
      CREATE INDEX import_batches_user_idx ON import_batches(user_id, created_at);
      CREATE TABLE import_lineage (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL,
        source_sheet TEXT NOT NULL, source_range TEXT NOT NULL,
        raw_value_json TEXT NOT NULL, parsed_value_json TEXT,
        transformation TEXT NOT NULL, confidence TEXT NOT NULL, warning TEXT,
        source_checksum TEXT NOT NULL, destination_value_json TEXT,
        destination_edited_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX import_lineage_user_entity_idx ON import_lineage(user_id, entity_type, entity_id);
      CREATE UNIQUE INDEX import_lineage_source_field_unique ON import_lineage(
        user_id, source_checksum, source_sheet, source_range, entity_type, entity_id, field
      );
    `,
  },
  {
    version: 4,
    name: 'resumable-onboarding-drafts',
    sql: `
      CREATE TABLE onboarding_drafts (
        user_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        values_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'card-payment-and-promotion-terms',
    sql: `
      ALTER TABLE credit_cards ADD COLUMN fixed_payment_cents INTEGER;
      ALTER TABLE credit_cards ADD COLUMN minimum_payment_cents INTEGER;
      ALTER TABLE credit_cards ADD COLUMN apr_basis_points INTEGER;
      ALTER TABLE credit_cards ADD COLUMN promotion_end_date TEXT;
    `,
  },
  {
    version: 6,
    name: 'native-recurring-schedules-and-payment-timing',
    sql: `
      ALTER TABLE forecast_events ADD COLUMN recurrence_json TEXT;
      ALTER TABLE forecast_events ADD COLUMN recurrence_end_date TEXT;
      ALTER TABLE forecast_events ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash-account';
      ALTER TABLE forecast_events ADD COLUMN card_id TEXT;
      ALTER TABLE credit_cards ADD COLUMN payment_day_of_month INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE credit_cards ADD COLUMN statement_close_day_of_month INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE credit_card_cycles ADD COLUMN payment_on TEXT;
      ALTER TABLE loans ADD COLUMN payment_frequency TEXT NOT NULL DEFAULT 'monthly';
      ALTER TABLE loans ADD COLUMN include_in_cash_forecast INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE loans ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    `,
  },
  {
    version: 7,
    name: 'recurring-receivable-schedules',
    sql: `
      ALTER TABLE receivables ADD COLUMN recurring_amount_cents INTEGER;
      ALTER TABLE receivables ADD COLUMN recurrence_json TEXT;
      ALTER TABLE receivables ADD COLUMN recurrence_end_date TEXT;
      ALTER TABLE receivables ADD COLUMN include_in_cash_forecast INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 8,
    name: 'receivable-accrual-ledger',
    sql: `
      ALTER TABLE receivables ADD COLUMN accrual_amount_cents INTEGER;
      ALTER TABLE receivables ADD COLUMN accrual_date TEXT;
      ALTER TABLE receivables ADD COLUMN accrual_recurrence_json TEXT;
      ALTER TABLE receivables ADD COLUMN notes TEXT;
      ALTER TABLE receivables ADD COLUMN settlement_date_confirmed INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 9,
    name: 'typed-onboarding-record-metadata',
    sql: `
      ALTER TABLE cash_accounts ADD COLUMN available_balance_cents INTEGER;
      ALTER TABLE cash_accounts ADD COLUMN notes TEXT;
      ALTER TABLE credit_cards ADD COLUMN issuer TEXT;
      ALTER TABLE credit_cards ADD COLUMN last_four TEXT;
      ALTER TABLE loans ADD COLUMN lender TEXT;
      ALTER TABLE loans ADD COLUMN loan_type TEXT;
      ALTER TABLE loans ADD COLUMN maturity_date TEXT;
      ALTER TABLE loans ADD COLUMN original_principal_cents INTEGER;
      ALTER TABLE loans ADD COLUMN original_date TEXT;
      ALTER TABLE assets ADD COLUMN contribution_amount_cents INTEGER;
      ALTER TABLE assets ADD COLUMN contribution_rate_basis_points INTEGER;
      ALTER TABLE assets ADD COLUMN employer_match_basis_points INTEGER;
      ALTER TABLE assets ADD COLUMN restriction_status TEXT;
      ALTER TABLE assets ADD COLUMN linked_liability_id TEXT REFERENCES loans(id) ON DELETE SET NULL;
      ALTER TABLE receivables ADD COLUMN related_expense_id TEXT REFERENCES forecast_events(id) ON DELETE SET NULL;
      ALTER TABLE receivables ADD COLUMN payment_instrument TEXT;
    `,
  },
  {
    version: 10,
    name: 'card-activity-aggregate-treatment',
    sql: `
      ALTER TABLE forecast_events ADD COLUMN card_activity_treatment TEXT NOT NULL DEFAULT 'additional';
    `,
  },
  {
    version: 11,
    name: 'first-class-income-planning-metadata',
    sql: `
      ALTER TABLE forecast_events ADD COLUMN income_type TEXT;
      ALTER TABLE forecast_events ADD COLUMN parent_income_event_id TEXT;
      ALTER TABLE forecast_events ADD COLUMN notes TEXT;
    `,
  },
  {
    version: 12,
    name: 'saved-card-scenario-semantics',
    sql: `
      ALTER TABLE saved_scenarios ADD COLUMN funding_type TEXT NOT NULL DEFAULT 'cash';
      ALTER TABLE saved_scenarios ADD COLUMN card_id TEXT REFERENCES credit_cards(id) ON DELETE RESTRICT;
      ALTER TABLE saved_scenarios ADD COLUMN purchase_date TEXT;
    `,
  },
  {
    version: 13,
    name: 'dark-first-interface-default',
    reapplyIfMissing: true,
    sql: `
      UPDATE profiles SET theme_preference = 'dark' WHERE theme_preference = 'system';
    `,
  },
  {
    version: 14,
    name: 'preserve-incomplete-card-timing',
    sql: `
      ALTER TABLE credit_cards ADD COLUMN cycle_timing_complete INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 15,
    name: 'grouped-income-routing',
    sql: `
      ALTER TABLE forecast_events ADD COLUMN income_plan_id TEXT;
      ALTER TABLE forecast_events ADD COLUMN income_plan_total_cents INTEGER;
      ALTER TABLE forecast_events ADD COLUMN income_nominal_date TEXT;
      ALTER TABLE forecast_events ADD COLUMN income_arrival_offset_days INTEGER;
      ALTER TABLE forecast_events ADD COLUMN income_allocation_rule TEXT;
      ALTER TABLE forecast_events ADD COLUMN parent_income_plan_id TEXT;
      CREATE INDEX forecast_events_income_plan_idx ON forecast_events(income_plan_id);
    `,
  },
  {
    version: 16,
    name: 'durable-income-allocation-order',
    sql: `
      ALTER TABLE forecast_events ADD COLUMN income_allocation_order INTEGER;
    `,
  },
  {
    version: 17,
    name: 'effective-dated-income-streams',
    sql: `
      ALTER TABLE forecast_events ADD COLUMN income_stream_id TEXT;
    `,
    run: backfillLegacyIncomeStreams,
  },
  {
    version: 18,
    name: 'committed-refinance-plans',
    sql: `
      CREATE TABLE committed_refinance_plans (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        closing_date TEXT NOT NULL,
        payoff_date TEXT NOT NULL,
        first_payment_date TEXT NOT NULL,
        replacement_loan_id TEXT NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
        replacement_loan_snapshot_json TEXT NOT NULL,
        principal_cash_contribution_cents INTEGER NOT NULL DEFAULT 0,
        closing_costs_cents INTEGER NOT NULL DEFAULT 0,
        financed_fees_cents INTEGER NOT NULL DEFAULT 0,
        cash_source_account_id TEXT REFERENCES cash_accounts(id) ON DELETE RESTRICT,
        excess_proceeds_cents INTEGER NOT NULL DEFAULT 0,
        excess_proceeds_account_id TEXT REFERENCES cash_accounts(id) ON DELETE RESTRICT,
        notes TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX committed_refinance_plans_user_status_idx
        ON committed_refinance_plans(user_id, status);
      CREATE UNIQUE INDEX committed_refinance_plans_replacement_loan_unique
        ON committed_refinance_plans(replacement_loan_id);

      CREATE TABLE committed_refinance_payoffs (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES committed_refinance_plans(id) ON DELETE CASCADE,
        source_loan_id TEXT NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
        payoff_amount_cents INTEGER NOT NULL,
        source_refinance_plan_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX committed_refinance_payoffs_user_loan_idx
        ON committed_refinance_payoffs(user_id, source_loan_id);
      CREATE UNIQUE INDEX committed_refinance_payoffs_plan_loan_unique
        ON committed_refinance_payoffs(user_id, plan_id, source_loan_id);
    `,
  },
  {
    version: 19,
    name: 'durable-refinance-history-metadata',
    sql: `
      ALTER TABLE committed_refinance_plans
        ADD COLUMN asset_relinks_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 20,
    name: 'backfill-refinance-asset-relinks',
    sql: 'SELECT 1;',
    run: backfillRefinanceAssetRelinks,
  },
  {
    version: 21,
    name: 'compact-legacy-refinance-audit-payloads',
    // This repair is intentionally re-runnable. A later schema version can exist while a
    // partially restored database is missing the compaction marker; in that case MAX(version)
    // alone must not strand the validated legacy relink array in the audit payload.
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: backfillRefinanceAssetRelinks,
  },
  {
    version: 22,
    name: 'installment-and-revolving-debt-metadata',
    sql: 'SELECT 1;',
    run: addDebtTrackingMetadata,
  },
  {
    version: 23,
    name: 'typed-installment-loan-payment-treatment',
    sql: 'SELECT 1;',
    run: addLoanPaymentTreatment,
  },
  {
    version: 24,
    name: 'credit-card-account-lifecycle',
    sql: 'SELECT 1;',
    run: addCardAccountLifecycle,
  },
  {
    version: 25,
    name: 'explicit-installment-loan-balloon-terms',
    sql: 'SELECT 1;',
    run: addExplicitLoanBalloonTerms,
  },
  {
    version: 26,
    name: 'receivable-settlement-anchors',
    sql: 'SELECT 1;',
    run: addReceivableSettlementAnchors,
  },
  {
    version: 27,
    name: 'durable-receivable-occurrence-metadata',
    sql: 'SELECT 1;',
    run: addReceivableOccurrenceMetadata,
  },
  {
    version: 28,
    name: 'early-paycheck-allocation-repair',
    sql: 'SELECT 1;',
    run: repairLegacyEarlyPaycheckTransfer,
  },
  {
    version: 29,
    name: 'imported-static-receivable-date-repair',
    sql: 'SELECT 1;',
    run: repairImportedStaticReceivableDates,
  },
  {
    version: 30,
    name: 'cash-account-overview-visibility',
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: addCashAccountOverviewVisibility,
  },
  {
    version: 31,
    name: 'profile-experience-preferences',
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: addProfilePreferences,
  },
  {
    version: 32,
    name: 'recorded-card-payment-account',
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: addRecordedCardPaymentAccount,
  },
  {
    version: 33,
    name: 'same-day-balance-boundary-treatment',
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: addSameDayBalanceBoundaryTreatment,
  },
  {
    version: 34,
    name: 'notification-presentation-metadata',
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: addNotificationPresentationMetadata,
  },
  {
    version: 35,
    name: 'investment-forecast-assumptions',
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: addInvestmentForecastAssumptions,
  },
  {
    version: 36,
    name: 'card-interest-forecast-controls',
    reapplyIfMissing: true,
    sql: 'SELECT 1;',
    run: addCardInterestForecastControls,
  },
];

const currentVersion = (database: Database.Database): number => {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  return row.version ?? 0;
};

export const assertSupportedSchemaVersion = (database: Database.Database): void => {
  const migrationTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!migrationTable) return;
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  const version = row.version ?? 0;
  const supportedVersion = migrations.at(-1)?.version ?? 0;
  if (version > supportedVersion) {
    throw new Error(
      `This profile uses database schema ${version}, but this Balance Book version supports only schema ${supportedVersion}. Install a newer Balance Book version; the database was not changed.`,
    );
  }
};

export const applyMigrations = (input: {
  database: Database.Database;
  databasePath: string;
  backupDirectory: string;
}): void => {
  assertSupportedSchemaVersion(input.database);
  const version = currentVersion(input.database);
  const appliedVersions = new Set(
    (
      input.database.prepare('SELECT version FROM schema_migrations').all() as Array<{
        version: number;
      }>
    ).map((row) => row.version),
  );
  const pending = migrations.filter(
    (migration) =>
      migration.version > version ||
      (migration.reapplyIfMissing === true && !appliedVersions.has(migration.version)),
  );
  if (pending.length === 0) return;

  if (
    fs.existsSync(input.databasePath) &&
    fs.statSync(input.databasePath).size > 0 &&
    version > 0
  ) {
    fs.mkdirSync(input.backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const backupPath = path.join(
      input.backupDirectory,
      `pre-migration-v${version}-${timestamp}.sqlite`,
    );
    // A raw filesystem copy can omit committed pages that still live in SQLite's WAL file.
    // VACUUM INTO is a transactionally consistent standalone snapshot of the live connection.
    input.database.prepare('VACUUM INTO ?').run(backupPath);
  }

  for (const migration of pending) {
    input.database.transaction(() => {
      input.database.exec(migration.sql);
      migration.run?.(input.database);
      input.database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
};

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;
