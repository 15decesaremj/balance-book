import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  cashAccountSchema,
  cashFloorPolicySchema,
  defaultProfilePreferences,
  creditCardCycleSchema,
  creditCardSchema,
  committedRefinancePlanInputSchema,
  committedRefinancePlanSchema,
  forecastEventSchema,
  assertValidIncomePlanGroups,
  assetSchema,
  loanSchema,
  maximumProfileAssetRecords,
  plainDateSchema,
  profilePreferencesSchema,
  receivableSchema,
  reconciliationSchema,
  rewardProgramSchema,
  savedScenarioSchema,
  storedProfilePreferencesSchema,
  addDays,
  compareDates,
  daysBetween,
  isRecurrenceOccurrence,
  type Asset,
  type CashAccount,
  type CashFloorPolicy,
  type CreditCard,
  type CommittedRefinancePlan,
  type CommittedRefinancePlanInput,
  type ForecastEvent,
  type CreditCardCycle,
  type Loan,
  type PlainDateString,
  type ProfilePreferences,
  type Receivable,
  type Reconciliation,
  type RefinanceAssetRelink,
  type RecurrenceRule,
  type RewardProgram,
  type SavedScenario,
} from '@balance-book/domain';
import {
  cardAllowsPurchasesOnDate,
  firstAnchoredReceivableSettlementDate,
  expandRecurrence,
  hasRecurringReceivableSchedule,
  parseReceivableOccurrenceNote,
  projectLoanPayoffAtDate,
  projectRollingReceivableBalances,
  receivableForSettlementSource,
  receivableForSettlementSourceFromIndex,
  receivableSettlementDates,
  receivableSettlementSourceOccurrenceDate,
  resolveCommittedRefinances,
  resolveRecordedReceivableOccurrenceDate,
  resolveReceivableScheduleOccurrenceDate,
} from '@balance-book/financial-engine';
import { applyMigrations, assertSupportedSchemaVersion, latestSchemaVersion } from './migrations';
import {
  auditEvents,
  assets,
  cashAccounts,
  cashFloorPolicies,
  creditCards,
  creditCardCycles,
  committedRefinancePayoffs,
  committedRefinancePlans,
  forecastEvents,
  importBatches,
  importLineage,
  loans,
  notificationPresentations,
  onboardingDrafts,
  profiles,
  receivables,
  reconciliations,
  rewardPrograms,
  savedScenarios,
  schema,
} from './schema';

export interface InitialProfile {
  id: string;
  displayName: string;
  username: string;
  onboardingComplete?: boolean;
}

export interface ProfileSummary {
  id: string;
  displayName: string;
  username: string;
  passwordSet: boolean;
  onboardingComplete: boolean;
}

export interface ProfileCredentials extends ProfileSummary {
  passwordSalt: string | null;
  passwordHash: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  themePreference: 'system' | 'light' | 'dark';
  preferences: ProfilePreferences;
}

export interface VerticalSliceInput {
  balanceAsOf: string;
  accountName: string;
  openingBalanceCents: number;
  incomeLabel?: string;
  incomeDate?: string;
  incomeAmountCents?: number;
  commitmentLabel?: string;
  commitmentDate?: string;
  commitmentAmountCents?: number;
  cardName?: string;
  cardEstimateCents?: number;
  cardPaymentDayOfMonth?: number;
  cardStatementCloseDayOfMonth?: number;
  cardEstimatePolicy?: 'actual-reset' | 'baseline-guardrail';
  cardPaymentPolicy?: 'full-statement' | 'minimum' | 'fixed' | 'manual';
  cardMinimumPaymentCents?: number;
  cardFixedPaymentCents?: number;
  hardFloorCents: number;
  preferredFloorCents?: number;
}

export interface UserForecastData {
  accounts: CashAccount[];
  events: ForecastEvent[];
  policy: CashFloorPolicy;
  cards: CreditCard[];
}

export type ManagedEntityType =
  | 'cash-account'
  | 'forecast-event'
  | 'credit-card'
  | 'card-cycle'
  | 'loan'
  | 'receivable'
  | 'asset'
  | 'reward-program'
  | 'reconciliation'
  | 'saved-scenario';

type LoanPaymentInstructionCascade = {
  action: 'move' | 'split';
  eventId: string;
  futureEventId?: string;
  fromAccountId: string;
  toAccountId: string;
  effectiveDate: PlainDateString;
};

const firstFutureLoanPaymentOccurrence = (
  event: ForecastEvent,
  asOfDate: PlainDateString,
): PlainDateString | undefined => {
  if (
    event.status === 'cancelled' ||
    event.status === 'skipped' ||
    (event.hypothetical && !event.accepted)
  ) {
    return undefined;
  }
  const sameDayIsSettled = event.status === 'confirmed' || event.status === 'paid';
  const dateComparison = compareDates(event.date, asOfDate);
  if (dateComparison > 0 || (dateComparison === 0 && !sameDayIsSettled)) return event.date;
  if (!event.recurrenceRule || event.recurrenceRule.frequency === 'once') return undefined;
  if (event.recurrenceEndDate) {
    const endComparison = compareDates(event.recurrenceEndDate, asOfDate);
    if (endComparison < 0 || (endComparison === 0 && sameDayIsSettled)) return undefined;
  }
  const searchEnd = event.recurrenceEndDate ?? addDays(asOfDate, 800);
  return expandRecurrence({
    startDate: event.date,
    endDate: searchEnd,
    rule: event.recurrenceRule,
  }).find((date) => {
    const comparison = compareDates(date, asOfDate);
    return comparison > 0 || (comparison === 0 && !sameDayIsSettled);
  });
};

const loanPaymentInstructionHasHistory = (
  event: ForecastEvent,
  asOfDate: PlainDateString,
): boolean => {
  const comparison = compareDates(event.date, asOfDate);
  return (
    comparison < 0 ||
    (comparison === 0 && (event.status === 'confirmed' || event.status === 'paid'))
  );
};

export interface ManagedRecords {
  accounts: CashAccount[];
  events: ForecastEvent[];
  policy?: CashFloorPolicy;
  cards: CreditCard[];
  cardCycles: CreditCardCycle[];
  loans: Loan[];
  committedRefinancePlans: CommittedRefinancePlan[];
  receivables: Receivable[];
  assets: Asset[];
  rewardPrograms: RewardProgram[];
  reconciliations: Reconciliation[];
  savedScenarios: SavedScenario[];
}

export interface NotificationPresentation {
  notificationId: string;
  conditionFingerprint: string;
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  updatedAt: string;
}

export interface NotificationPresentationUpdate {
  notificationId: string;
  conditionFingerprint: string;
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
}

export interface AuditHistoryEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export type CommitRefinancePlanInput = CommittedRefinancePlanInput;

export interface UserDataExport extends ManagedRecords {
  format: 'balance-book-user-data';
  version: 1;
  exportedAt: string;
  policy?: CashFloorPolicy;
}

export interface PortableAuditEvent {
  sourceId: string;
  action: string;
  entityType: string;
  entityId: string;
  payloadJson: string;
  createdAt: string;
}

export interface PortableImportBatch {
  sourceId: string;
  workbookChecksum: string;
  sourceFileName: string;
  status: string;
  createdAt: string;
  rolledBackAt: string | null;
}

export interface PortableImportLineage {
  sourceId: string;
  sourceBatchId: string;
  entityType: string;
  entityId: string;
  field: string;
  sourceSheet: string;
  sourceRange: string;
  rawValueJson: string;
  parsedValueJson: string | null;
  transformation: string;
  confidence: string;
  warning: string | null;
  sourceChecksum: string;
  destinationValueJson: string | null;
  destinationEditedAt: string | null;
  createdAt: string;
}

export interface PortableRecordTimestamp {
  entityType: ManagedEntityType | 'committed-refinance-plan';
  entityId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortableProfileBackup extends ManagedRecords {
  format: 'balance-book-portable-profile';
  version: 3;
  exportedAt: string;
  sourceAppVersion: string;
  sourceSchemaVersion: number;
  sourceProfile: {
    id: string;
    displayName: string;
    username: string;
    themePreference: 'system' | 'light' | 'dark';
    preferences: ProfilePreferences;
    onboardingComplete: boolean;
  };
  onboardingDraft: { values: Record<string, string>; updatedAt: string } | null;
  auditEvents: PortableAuditEvent[];
  importBatches: PortableImportBatch[];
  importLineage: PortableImportLineage[];
  recordTimestamps: PortableRecordTimestamp[];
  policyUpdatedAt: string | null;
  policy?: CashFloorPolicy;
}

interface ReceivableSettlementAssociation {
  receivable: Receivable;
  occurrenceDate: PlainDateString;
  usesStaticBalance: boolean;
}

export interface ImportReview {
  batches: Array<{
    id: string;
    sourceFileName: string;
    workbookChecksum: string;
    status: string;
    createdAt: string;
  }>;
  fields: Array<{
    entityType: string;
    entityId: string;
    field: string;
    sourceSheet: string;
    sourceRange: string;
    transformation: string;
    confidence: string;
    warning: string | null;
    destinationEdited: boolean;
    importedValueJson: string | null;
    currentValueJson: string;
    importedAt: string;
    lastModifiedAt: string | null;
    forecastImpact: string;
    relatedRecordIds: string[];
  }>;
}

const now = (): string => new Date().toISOString();

const deserializeProfilePreferences = (serialized: string): ProfilePreferences => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Profile preferences are invalid');
  }
  return storedProfilePreferencesSchema.parse(parsed);
};
const localPlainDate = (): PlainDateString => {
  const date = new Date();
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return plainDateSchema.parse(`${year}-${month}-${day}`);
};

const recurrenceInterval = (rule: RecurrenceRule): number =>
  'interval' in rule ? rule.interval : 1;

const recurrenceCadenceSpanDays = (rule: RecurrenceRule): number =>
  rule.frequency === 'weekly'
    ? 7 * rule.interval
    : rule.frequency === 'biweekly'
      ? 14
      : rule.frequency === 'semimonthly'
        ? 16
        : rule.frequency === 'monthly'
          ? 31 * rule.interval
          : 1;

const nearestRecurringEventOccurrence = (
  event: ForecastEvent,
  targetDate: PlainDateString,
): PlainDateString => {
  if (!event.recurrenceRule || event.recurrenceRule.frequency === 'once') {
    throw new Error('A recurring event is required');
  }
  const unconstrainedEnd = addDays(
    compareDates(targetDate, event.date) > 0 ? targetDate : event.date,
    800,
  );
  const endDate =
    event.recurrenceEndDate && compareDates(event.recurrenceEndDate, unconstrainedEnd) < 0
      ? event.recurrenceEndDate
      : unconstrainedEnd;
  const occurrences = expandRecurrence({
    startDate: event.date,
    endDate,
    rule: event.recurrenceRule,
  });
  if (occurrences.length === 0) throw new Error('Recurring event has no valid occurrence');
  return occurrences.reduce((closest, candidate) => {
    const closestDistance = Math.abs(daysBetween(targetDate, closest));
    const candidateDistance = Math.abs(daysBetween(targetDate, candidate));
    if (candidateDistance < closestDistance) return candidate;
    if (candidateDistance > closestDistance) return closest;
    const candidateIsUpcoming = compareDates(candidate, targetDate) >= 0;
    const closestIsUpcoming = compareDates(closest, targetDate) >= 0;
    return candidateIsUpcoming && !closestIsUpcoming ? candidate : closest;
  });
};

const nullable = <T>(value: T | undefined): T | null => value ?? null;

const serializeCashAccount = (entity: CashAccount) => ({
  ...entity,
  availableBalanceCents: nullable(entity.availableBalanceCents),
  hardFloorCents: nullable(entity.hardFloorCents),
  preferredFloorCents: nullable(entity.preferredFloorCents),
  notes: nullable(entity.notes),
});

const serializeForecastEvent = (entity: ForecastEvent) => {
  const { recurrenceRule, ...row } = entity;
  return {
    ...row,
    includeInConservative: nullable(entity.includeInConservative),
    recurrenceJson: recurrenceRule ? JSON.stringify(recurrenceRule) : null,
    recurrenceEndDate: nullable(entity.recurrenceEndDate),
    paymentMethod: entity.paymentMethod ?? 'cash-account',
    cardId: nullable(entity.cardId),
    cardActivityTreatment: entity.cardActivityTreatment ?? 'additional',
    loanPaymentTreatment: entity.loanPaymentTreatment ?? 'scheduled-draft-override',
    incomeType: nullable(entity.incomeType),
    parentIncomeEventId: nullable(entity.parentIncomeEventId),
    incomePlanId: nullable(entity.incomePlanId),
    incomeStreamId: nullable(entity.incomeStreamId),
    incomePlanTotalCents: nullable(entity.incomePlanTotalCents),
    incomeNominalDate: nullable(entity.incomeNominalDate),
    incomeArrivalOffsetDays: nullable(entity.incomeArrivalOffsetDays),
    incomeAllocationRule: nullable(entity.incomeAllocationRule),
    incomeAllocationOrder: nullable(entity.incomeAllocationOrder),
    parentIncomePlanId: nullable(entity.parentIncomePlanId),
    receivableOccurrenceDate: nullable(entity.receivableOccurrenceDate),
    receivableOccurrenceTargetCents: nullable(entity.receivableOccurrenceTargetCents),
    notes: nullable(entity.notes),
    appliesAfterBalanceSnapshot: entity.appliesAfterBalanceSnapshot ?? false,
  };
};

const deserializeForecastEvent = (row: typeof forecastEvents.$inferSelect): ForecastEvent =>
  forecastEventSchema.parse({
    ...row,
    manualOrder: row.manualOrder ?? undefined,
    sourceRecordId: row.sourceRecordId ?? undefined,
    transferId: row.transferId ?? undefined,
    includeInConservative: row.includeInConservative ?? undefined,
    recurrenceRule: row.recurrenceJson ? JSON.parse(row.recurrenceJson) : undefined,
    recurrenceEndDate: row.recurrenceEndDate ?? undefined,
    cardId: row.cardId ?? undefined,
    loanPaymentTreatment:
      row.kind === 'loan-payment'
        ? (row.loanPaymentTreatment ?? 'scheduled-draft-override')
        : undefined,
    incomeType: row.incomeType ?? undefined,
    parentIncomeEventId: row.parentIncomeEventId ?? undefined,
    incomePlanId: row.incomePlanId ?? undefined,
    incomeStreamId: row.incomeStreamId ?? undefined,
    incomePlanTotalCents: row.incomePlanTotalCents ?? undefined,
    incomeNominalDate: row.incomeNominalDate ?? undefined,
    incomeArrivalOffsetDays: row.incomeArrivalOffsetDays ?? undefined,
    incomeAllocationRule: row.incomeAllocationRule ?? undefined,
    incomeAllocationOrder: row.incomeAllocationOrder ?? undefined,
    parentIncomePlanId: row.parentIncomePlanId ?? undefined,
    receivableOccurrenceDate: row.receivableOccurrenceDate ?? undefined,
    receivableOccurrenceTargetCents: row.receivableOccurrenceTargetCents ?? undefined,
    notes: row.notes ?? undefined,
    appliesAfterBalanceSnapshot: row.appliesAfterBalanceSnapshot,
  });

const serializeCashFloorPolicy = (entity: CashFloorPolicy) => ({
  ...entity,
  preferredConsolidatedFloorCents: nullable(entity.preferredConsolidatedFloorCents),
});

const serializeCreditCard = (entity: CreditCard) => ({
  ...entity,
  issuer: nullable(entity.issuer),
  lastFour: nullable(entity.lastFour),
  creditLimitCents: nullable(entity.creditLimitCents),
  reportedBalanceCents: nullable(entity.reportedBalanceCents),
  reportedBalanceDate: nullable(entity.reportedBalanceDate),
  reportedCarryingBalanceCents: nullable(entity.reportedCarryingBalanceCents),
  reportedCarryingBalanceDate: nullable(entity.reportedCarryingBalanceDate),
  fixedPaymentCents: nullable(entity.fixedPaymentCents),
  minimumPaymentCents: nullable(entity.minimumPaymentCents),
  aprBasisPoints: nullable(entity.aprBasisPoints),
  promotionalAprBasisPoints: nullable(entity.promotionalAprBasisPoints),
  promotionEndDate: nullable(entity.promotionEndDate),
  closedOn: nullable(entity.closedOn),
  paymentDayOfMonth: entity.paymentDayOfMonth ?? 1,
  statementCloseDayOfMonth: entity.statementCloseDayOfMonth ?? 1,
  cycleTimingComplete:
    entity.paymentDayOfMonth !== undefined && entity.statementCloseDayOfMonth !== undefined,
});

const deserializeCreditCard = (row: typeof creditCards.$inferSelect): CreditCard =>
  creditCardSchema.parse({
    ...row,
    issuer: row.issuer ?? undefined,
    lastFour: row.lastFour ?? undefined,
    creditLimitCents: row.creditLimitCents ?? undefined,
    reportedBalanceCents: row.reportedBalanceCents ?? undefined,
    reportedBalanceDate: row.reportedBalanceDate ?? undefined,
    reportedCarryingBalanceCents: row.reportedCarryingBalanceCents ?? undefined,
    reportedCarryingBalanceDate: row.reportedCarryingBalanceDate ?? undefined,
    fixedPaymentCents: row.fixedPaymentCents ?? undefined,
    minimumPaymentCents: row.minimumPaymentCents ?? undefined,
    aprBasisPoints: row.aprBasisPoints ?? undefined,
    interestForecastEnabled: row.interestForecastEnabled,
    promotionalCarryingBalance: row.promotionalCarryingBalance,
    promotionalAprBasisPoints: row.promotionalAprBasisPoints ?? undefined,
    promotionEndDate: row.promotionEndDate ?? undefined,
    status: row.status ?? 'active',
    closedOn: row.closedOn ?? undefined,
    paymentDayOfMonth: row.cycleTimingComplete ? row.paymentDayOfMonth : undefined,
    statementCloseDayOfMonth: row.cycleTimingComplete ? row.statementCloseDayOfMonth : undefined,
  });

const serializeLoan = (entity: Loan) => {
  const { inferredFields, ...row } = entity;
  return {
    ...row,
    lender: nullable(entity.lender),
    loanType: nullable(entity.loanType),
    cashPaymentCents: nullable(entity.cashPaymentCents),
    maturityDate: nullable(entity.maturityDate),
    originalPrincipalCents: nullable(entity.originalPrincipalCents),
    originalDate: nullable(entity.originalDate),
    originalTermMonths: nullable(entity.originalTermMonths),
    amortizationStructure: entity.amortizationStructure,
    expectedBalloonCents: nullable(entity.expectedBalloonCents),
    inferredFieldsJson: inferredFields ? JSON.stringify(inferredFields) : null,
  };
};

const deserializeLoan = (row: typeof loans.$inferSelect): Loan =>
  loanSchema.parse({
    ...row,
    lender: row.lender ?? undefined,
    loanType: row.loanType ?? undefined,
    cashPaymentCents: row.cashPaymentCents ?? undefined,
    maturityDate: row.maturityDate ?? undefined,
    originalPrincipalCents: row.originalPrincipalCents ?? undefined,
    originalDate: row.originalDate ?? undefined,
    originalTermMonths: row.originalTermMonths ?? undefined,
    amortizationStructure: row.amortizationStructure ?? 'fully-amortizing',
    expectedBalloonCents: row.expectedBalloonCents ?? undefined,
    inferredFields: row.inferredFieldsJson ? JSON.parse(row.inferredFieldsJson) : undefined,
  });

const serializeCommittedRefinancePlan = (entity: CommittedRefinancePlan) => ({
  id: entity.id,
  userId: entity.userId,
  name: entity.name,
  status: entity.status,
  closingDate: entity.closingDate,
  payoffDate: entity.payoffDate,
  firstPaymentDate: entity.firstPaymentDate,
  replacementLoanId: entity.replacementLoan.id,
  replacementLoanSnapshotJson: JSON.stringify(
    entity.replacementLoanSnapshot ?? entity.replacementLoan,
  ),
  assetRelinksJson: JSON.stringify(entity.assetRelinks ?? []),
  principalCashContributionCents: entity.principalCashContributionCents,
  closingCostsCents: entity.closingCostsCents,
  financedFeesCents: entity.financedFeesCents,
  cashSourceAccountId: nullable(entity.cashSourceAccountId),
  excessProceedsCents: entity.excessProceedsCents,
  excessProceedsAccountId: nullable(entity.excessProceedsAccountId),
  notes: nullable(entity.notes),
});

const deserializeCommittedRefinancePlan = (
  row: typeof committedRefinancePlans.$inferSelect,
  payoffRows: Array<typeof committedRefinancePayoffs.$inferSelect>,
  replacementLoan: Loan,
): CommittedRefinancePlan => {
  const replacementLoanSnapshot = loanSchema.parse(JSON.parse(row.replacementLoanSnapshotJson));
  return committedRefinancePlanSchema.parse({
    id: row.id,
    userId: row.userId,
    name: row.name,
    status: row.status,
    closingDate: row.closingDate,
    payoffDate: row.payoffDate,
    firstPaymentDate: row.firstPaymentDate,
    payoffs: payoffRows.map((payoff) => ({
      sourceLoanId: payoff.sourceLoanId,
      payoffAmountCents: payoff.payoffAmountCents,
      sourceRefinancePlanId: payoff.sourceRefinancePlanId ?? undefined,
    })),
    replacementLoan,
    replacementLoanSnapshot,
    assetRelinks: JSON.parse(row.assetRelinksJson) as RefinanceAssetRelink[],
    principalCashContributionCents: row.principalCashContributionCents,
    closingCostsCents: row.closingCostsCents,
    financedFeesCents: row.financedFeesCents,
    cashSourceAccountId: row.cashSourceAccountId ?? undefined,
    excessProceedsCents: row.excessProceedsCents,
    excessProceedsAccountId: row.excessProceedsAccountId ?? undefined,
    notes: row.notes ?? undefined,
  });
};

const serializeAsset = (entity: Asset) => ({
  ...entity,
  annualGrowthRateBasisPoints: nullable(entity.annualGrowthRateBasisPoints),
  contributionGrossAnnualIncomeCents: nullable(entity.contributionGrossAnnualIncomeCents),
  contributionAmountCents: nullable(entity.contributionAmountCents),
  contributionRateBasisPoints: nullable(entity.contributionRateBasisPoints),
  employerMatchBasisPoints: nullable(entity.employerMatchBasisPoints),
  restrictionStatus: nullable(entity.restrictionStatus),
  linkedLiabilityId: nullable(entity.linkedLiabilityId),
});

const serializeCreditCardCycle = (entity: CreditCardCycle) => ({
  ...entity,
  lockedStatementCents: nullable(entity.lockedStatementCents),
  projectionOverrideCents: nullable(entity.projectionOverrideCents),
  paymentOn: nullable(entity.paymentOn),
  actualPaymentCents: nullable(entity.actualPaymentCents),
  actualPaymentAccountId: nullable(entity.actualPaymentAccountId),
});

const serializeReceivable = (entity: Receivable) => {
  const { recurrenceRule, accrualRecurrenceRule, ...row } = entity;
  return {
    ...row,
    grossExpenseCents: nullable(entity.grossExpenseCents),
    userEconomicShareCents: nullable(entity.userEconomicShareCents),
    relatedExpenseId: nullable(entity.relatedExpenseId),
    paymentInstrument: nullable(entity.paymentInstrument),
    recurringAmountCents: nullable(entity.recurringAmountCents),
    recurrenceJson: recurrenceRule ? JSON.stringify(recurrenceRule) : null,
    recurrenceEndDate: nullable(entity.recurrenceEndDate),
    accrualAmountCents: nullable(entity.accrualAmountCents),
    accrualDate: nullable(entity.accrualDate),
    accrualRecurrenceJson: accrualRecurrenceRule ? JSON.stringify(accrualRecurrenceRule) : null,
    settlementAnchorEventId: nullable(entity.settlementAnchorEventId),
    settlementOffsetDays: nullable(entity.settlementOffsetDays),
    settlementDateConfirmed: entity.settlementDateConfirmed ?? true,
    includeInCashForecast: entity.includeInCashForecast ?? true,
    notes: nullable(entity.notes),
  };
};

const deserializeReceivable = (row: typeof receivables.$inferSelect): Receivable =>
  receivableSchema.parse({
    ...row,
    grossExpenseCents: row.grossExpenseCents ?? undefined,
    userEconomicShareCents: row.userEconomicShareCents ?? undefined,
    relatedExpenseId: row.relatedExpenseId ?? undefined,
    paymentInstrument: row.paymentInstrument ?? undefined,
    recurringAmountCents: row.recurringAmountCents ?? undefined,
    recurrenceRule: row.recurrenceJson ? JSON.parse(row.recurrenceJson) : undefined,
    recurrenceEndDate: row.recurrenceEndDate ?? undefined,
    accrualAmountCents: row.accrualAmountCents ?? undefined,
    accrualDate: row.accrualDate ?? undefined,
    accrualRecurrenceRule: row.accrualRecurrenceJson
      ? JSON.parse(row.accrualRecurrenceJson)
      : undefined,
    settlementAnchorEventId: row.settlementAnchorEventId ?? undefined,
    settlementOffsetDays: row.settlementOffsetDays ?? undefined,
    notes: row.notes ?? undefined,
  });

const serializeRewardProgram = (entity: RewardProgram) => ({
  ...entity,
  pointValueMicros: nullable(entity.pointValueMicros),
  expectedReceiptDate: nullable(entity.expectedReceiptDate),
});

const serializeReconciliation = (entity: Reconciliation) => ({
  ...entity,
  note: nullable(entity.note),
});

const serializeSavedScenario = (entity: SavedScenario) => ({
  ...entity,
  fundingType: entity.fundingType ?? 'cash',
  cardId: nullable(entity.cardId),
  purchaseDate: nullable(entity.purchaseDate),
  notes: nullable(entity.notes),
});

export class BalanceBookStore {
  readonly raw: BetterSqlite3.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;

  constructor(input: { databasePath: string; backupDirectory: string }) {
    fs.mkdirSync(path.dirname(input.databasePath), { recursive: true });
    this.raw = new BetterSqlite3(input.databasePath);
    try {
      assertSupportedSchemaVersion(this.raw);
      this.raw.pragma('foreign_keys = ON');
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('busy_timeout = 5000');
      applyMigrations({
        database: this.raw,
        databasePath: input.databasePath,
        backupDirectory: input.backupDirectory,
      });
      this.orm = drizzle(this.raw, { schema });
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }

  initializeProfiles(initialProfiles: InitialProfile[]): void {
    const timestamp = now();
    this.raw.transaction(() => {
      for (const profile of initialProfiles) {
        this.orm
          .insert(profiles)
          .values({
            id: profile.id,
            displayName: profile.displayName,
            username: profile.username.toLowerCase(),
            onboardingComplete: profile.onboardingComplete ?? false,
            themePreference: 'dark',
            preferencesJson: JSON.stringify(defaultProfilePreferences),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing()
          .run();
      }
    })();
  }

  getOnboardingDraft(userId: string): { values: Record<string, string>; updatedAt: string } | null {
    const row = this.orm
      .select()
      .from(onboardingDrafts)
      .where(eq(onboardingDrafts.userId, userId))
      .get();
    if (!row) return null;
    const values: unknown = JSON.parse(row.valuesJson);
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Onboarding draft is invalid');
    }
    return { values: values as Record<string, string>, updatedAt: row.updatedAt };
  }

  saveOnboardingDraft(userId: string, values: Record<string, string>): void {
    if (!this.getCredentialsById(userId)) throw new Error('Unknown user');
    const timestamp = now();
    this.orm
      .insert(onboardingDrafts)
      .values({ userId, valuesJson: JSON.stringify(values), updatedAt: timestamp })
      .onConflictDoUpdate({
        target: onboardingDrafts.userId,
        set: { valuesJson: JSON.stringify(values), updatedAt: timestamp },
      })
      .run();
  }

  clearOnboardingDraft(userId: string): void {
    this.orm.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userId)).run();
  }

  listProfiles(): ProfileSummary[] {
    return this.orm
      .select()
      .from(profiles)
      .orderBy(asc(profiles.createdAt))
      .all()
      .map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        username: profile.username,
        passwordSet: Boolean(profile.passwordHash && profile.passwordSalt),
        onboardingComplete: profile.onboardingComplete,
      }));
  }

  getCredentialsById(profileId: string): ProfileCredentials | undefined {
    const profile = this.orm.select().from(profiles).where(eq(profiles.id, profileId)).get();
    return profile ? this.toCredentials(profile) : undefined;
  }

  getCredentialsByUsername(username: string): ProfileCredentials | undefined {
    const profile = this.orm
      .select()
      .from(profiles)
      .where(eq(profiles.username, username.toLowerCase()))
      .get();
    return profile ? this.toCredentials(profile) : undefined;
  }

  private toCredentials(profile: typeof profiles.$inferSelect): ProfileCredentials {
    return {
      id: profile.id,
      displayName: profile.displayName,
      username: profile.username,
      passwordSet: Boolean(profile.passwordHash && profile.passwordSalt),
      onboardingComplete: profile.onboardingComplete,
      passwordSalt: profile.passwordSalt,
      passwordHash: profile.passwordHash,
      failedLoginAttempts: profile.failedLoginAttempts,
      lockedUntil: profile.lockedUntil,
      themePreference: profile.themePreference,
      preferences: deserializeProfilePreferences(profile.preferencesJson),
    };
  }

  setPassword(
    profileId: string,
    salt: string,
    hash: string,
    identity?: { displayName: string; username: string },
  ): void {
    const timestamp = now();
    const displayName = identity?.displayName.trim();
    const username = identity?.username.trim().toLowerCase();
    if (
      identity &&
      (!displayName ||
        displayName.length > 120 ||
        !username ||
        username.length > 128 ||
        !/^[a-z0-9._-]+$/.test(username))
    ) {
      throw new Error('Profile name or username is invalid');
    }
    const changed = this.orm
      .update(profiles)
      .set({
        ...(identity ? { displayName, username } : {}),
        passwordSalt: salt,
        passwordHash: hash,
        passwordCreatedAt: timestamp,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: timestamp,
      })
      .where(and(eq(profiles.id, profileId), isNull(profiles.passwordHash)))
      .run();
    if (changed.changes !== 1) throw new Error('Profile not found or password already set');
  }

  recordFailedLogin(profileId: string, attempts: number, lockedUntil: string | null): void {
    this.orm
      .update(profiles)
      .set({ failedLoginAttempts: attempts, lockedUntil, updatedAt: now() })
      .where(eq(profiles.id, profileId))
      .run();
  }

  clearFailedLogins(profileId: string): void {
    this.orm
      .update(profiles)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: now() })
      .where(eq(profiles.id, profileId))
      .run();
  }

  setTheme(profileId: string, theme: 'system' | 'light' | 'dark'): void {
    this.orm
      .update(profiles)
      .set({ themePreference: theme, updatedAt: now() })
      .where(eq(profiles.id, profileId))
      .run();
  }

  setPreferences(profileId: string, preferences: ProfilePreferences): void {
    const parsed = profilePreferencesSchema.parse(preferences);
    const result = this.orm
      .update(profiles)
      .set({ preferencesJson: JSON.stringify(parsed), updatedAt: now() })
      .where(eq(profiles.id, profileId))
      .run();
    if (result.changes !== 1) throw new Error('Profile not found');
  }

  getNotificationPresentations(profileId: string): NotificationPresentation[] {
    return this.orm
      .select()
      .from(notificationPresentations)
      .where(eq(notificationPresentations.userId, profileId))
      .orderBy(asc(notificationPresentations.updatedAt))
      .all()
      .map((row) => ({
        notificationId: row.notificationId,
        conditionFingerprint: row.conditionFingerprint,
        readAt: row.readAt,
        snoozedUntil: row.snoozedUntil,
        dismissedAt: row.dismissedAt,
        updatedAt: row.updatedAt,
      }));
  }

  getAuditHistory(profileId: string): AuditHistoryEntry[] {
    if (!this.getCredentialsById(profileId)) throw new Error('Profile not found');
    return this.orm
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(eq(auditEvents.userId, profileId))
      .orderBy(asc(auditEvents.createdAt))
      .all();
  }

  setNotificationPresentations(
    profileId: string,
    updates: NotificationPresentationUpdate[],
  ): NotificationPresentation[] {
    if (!this.getCredentialsById(profileId)) throw new Error('Profile not found');
    const timestamp = now();
    this.raw.transaction(() => {
      for (const update of updates) {
        const id = createHash('sha256')
          .update(`${profileId}\u0000${update.notificationId}`)
          .digest('hex');
        this.orm
          .insert(notificationPresentations)
          .values({
            id,
            userId: profileId,
            notificationId: update.notificationId,
            conditionFingerprint: update.conditionFingerprint,
            readAt: update.readAt,
            snoozedUntil: update.snoozedUntil,
            dismissedAt: update.dismissedAt,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: notificationPresentations.id,
            set: {
              conditionFingerprint: update.conditionFingerprint,
              readAt: update.readAt,
              snoozedUntil: update.snoozedUntil,
              dismissedAt: update.dismissedAt,
              updatedAt: timestamp,
            },
          })
          .run();
      }
    })();
    return this.getNotificationPresentations(profileId);
  }

  saveVerticalSlice(userId: string, input: VerticalSliceInput): void {
    if (!this.getCredentialsById(userId)) throw new Error('Unknown user');
    if (
      this.orm
        .select({ id: cashAccounts.id })
        .from(cashAccounts)
        .where(eq(cashAccounts.userId, userId))
        .get()
    ) {
      throw new Error('Initial setup is already complete. Use the guided editors to make changes.');
    }
    const timestamp = now();
    const accountId = `${userId}-primary-cash`;
    const eventRows: ForecastEvent[] = [];
    if (
      input.incomeLabel !== undefined &&
      input.incomeDate !== undefined &&
      input.incomeAmountCents !== undefined
    ) {
      eventRows.push(
        forecastEventSchema.parse({
          id: `${userId}-income-1`,
          userId,
          accountId,
          date: input.incomeDate,
          kind: 'income',
          direction: 'inflow',
          amountCents: input.incomeAmountCents,
          certainty: 'expected',
          status: 'planned',
          label: input.incomeLabel,
        }),
      );
    }
    if (
      input.commitmentLabel !== undefined &&
      input.commitmentDate !== undefined &&
      input.commitmentAmountCents !== undefined
    ) {
      eventRows.push(
        forecastEventSchema.parse({
          id: `${userId}-commitment-1`,
          userId,
          accountId,
          date: input.commitmentDate,
          kind: 'direct-commitment',
          direction: 'outflow',
          amountCents: input.commitmentAmountCents,
          certainty: 'confirmed',
          status: 'planned',
          label: input.commitmentLabel,
        }),
      );
    }
    const accountRow = cashAccountSchema.parse({
      id: accountId,
      userId,
      name: input.accountName,
      type: 'checking',
      openingBalanceCents: input.openingBalanceCents,
      balanceAsOf: input.balanceAsOf,
      includedInLiquidity: true,
      canFundOtherAccounts: true,
      hardFloorCents: 0,
      preferredFloorCents: input.preferredFloorCents,
      transferDelayDays: 0,
    });
    const floor = cashFloorPolicySchema.parse({
      hardConsolidatedFloorCents: input.hardFloorCents,
      preferredConsolidatedFloorCents: input.preferredFloorCents,
      horizonDays: 90,
      includeConfirmedReceivablesConservatively: true,
    });
    let card: CreditCard | undefined;
    if (
      input.cardName !== undefined &&
      input.cardEstimateCents !== undefined &&
      input.cardEstimatePolicy !== undefined &&
      input.cardPaymentPolicy !== undefined
    ) {
      card = creditCardSchema.parse({
        id: `${userId}-card-1`,
        userId,
        name: input.cardName,
        fundingAccountId: accountId,
        defaultFutureStatementCents: input.cardEstimateCents,
        estimatePolicy: input.cardEstimatePolicy,
        paymentPolicy: input.cardPaymentPolicy,
        minimumPaymentCents:
          input.cardPaymentPolicy === 'minimum' ? input.cardMinimumPaymentCents : undefined,
        fixedPaymentCents:
          input.cardPaymentPolicy === 'fixed' ? input.cardFixedPaymentCents : undefined,
        paymentDayOfMonth: input.cardPaymentDayOfMonth,
        statementCloseDayOfMonth: input.cardStatementCloseDayOfMonth,
      });
    }

    this.raw.transaction(() => {
      this.orm
        .insert(cashAccounts)
        .values({ ...accountRow, createdAt: timestamp, updatedAt: timestamp })
        .run();
      if (eventRows.length > 0) {
        this.orm
          .insert(forecastEvents)
          .values(
            eventRows.map((row) => ({
              ...serializeForecastEvent(row),
              createdAt: timestamp,
              updatedAt: timestamp,
            })),
          )
          .run();
      }
      this.orm
        .insert(cashFloorPolicies)
        .values({ userId, ...floor, updatedAt: timestamp })
        .run();
      if (card) {
        this.orm
          .insert(creditCards)
          .values({ ...serializeCreditCard(card), createdAt: timestamp, updatedAt: timestamp })
          .run();
      }
      this.orm
        .update(profiles)
        .set({ onboardingComplete: true, updatedAt: timestamp })
        .where(eq(profiles.id, userId))
        .run();
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'create',
          entityType: 'vertical-slice',
          entityId: userId,
          payloadJson: JSON.stringify({
            accountCount: 1,
            eventCount: eventRows.length,
            cardCount: card ? 1 : 0,
            cardCycleCount: 0,
          }),
          createdAt: timestamp,
        })
        .run();
      this.orm.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userId)).run();
    })();
  }

  getForecastData(userId: string): UserForecastData | undefined {
    const accountRows = this.orm
      .select()
      .from(cashAccounts)
      .where(eq(cashAccounts.userId, userId))
      .all();
    if (accountRows.length === 0) return undefined;
    const eventRows = this.orm
      .select()
      .from(forecastEvents)
      .where(eq(forecastEvents.userId, userId))
      .orderBy(asc(forecastEvents.date))
      .all();
    const floor = this.orm
      .select()
      .from(cashFloorPolicies)
      .where(eq(cashFloorPolicies.userId, userId))
      .get();
    if (!floor) throw new Error('Cash floor policy is missing');
    const cardRows = this.orm
      .select()
      .from(creditCards)
      .where(eq(creditCards.userId, userId))
      .all();
    return {
      accounts: accountRows.map((row) =>
        cashAccountSchema.parse({
          ...row,
          availableBalanceCents: row.availableBalanceCents ?? undefined,
          hardFloorCents: row.hardFloorCents ?? undefined,
          preferredFloorCents: row.preferredFloorCents ?? undefined,
          notes: row.notes ?? undefined,
        }),
      ),
      events: eventRows.map(deserializeForecastEvent),
      policy: cashFloorPolicySchema.parse({
        ...floor,
        preferredConsolidatedFloorCents: floor.preferredConsolidatedFloorCents ?? undefined,
      }),
      cards: cardRows.map(deserializeCreditCard),
    };
  }

  getCommittedRefinancePlans(userId: string): CommittedRefinancePlan[] {
    const planRows = this.orm
      .select()
      .from(committedRefinancePlans)
      .where(eq(committedRefinancePlans.userId, userId))
      .orderBy(asc(committedRefinancePlans.closingDate), asc(committedRefinancePlans.createdAt))
      .all();
    const payoffRows = this.orm
      .select()
      .from(committedRefinancePayoffs)
      .where(eq(committedRefinancePayoffs.userId, userId))
      .orderBy(
        asc(committedRefinancePayoffs.createdAt),
        asc(committedRefinancePayoffs.sourceLoanId),
      )
      .all();
    const payoffsByPlan = new Map<string, Array<typeof committedRefinancePayoffs.$inferSelect>>();
    for (const payoff of payoffRows) {
      payoffsByPlan.set(payoff.planId, [...(payoffsByPlan.get(payoff.planId) ?? []), payoff]);
    }
    const currentLoans = new Map(
      this.orm
        .select()
        .from(loans)
        .where(eq(loans.userId, userId))
        .all()
        .map((row) => [row.id, deserializeLoan(row)]),
    );
    return planRows.map((row) => {
      const replacementLoan = currentLoans.get(row.replacementLoanId);
      if (!replacementLoan) throw new Error('Committed refinance replacement loan is missing');
      return deserializeCommittedRefinancePlan(
        row,
        payoffsByPlan.get(row.id) ?? [],
        replacementLoan,
      );
    });
  }

  getManagedRecords(userId: string): ManagedRecords {
    const core = this.getForecastData(userId);
    const cycleRows = this.orm
      .select()
      .from(creditCardCycles)
      .where(eq(creditCardCycles.userId, userId))
      .all();
    const loanRows = this.orm.select().from(loans).where(eq(loans.userId, userId)).all();
    const receivableRows = this.orm
      .select()
      .from(receivables)
      .where(eq(receivables.userId, userId))
      .all();
    const assetRows = this.orm.select().from(assets).where(eq(assets.userId, userId)).all();
    const rewardRows = this.orm
      .select()
      .from(rewardPrograms)
      .where(eq(rewardPrograms.userId, userId))
      .all();
    const reconciliationRows = this.orm
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.userId, userId))
      .all();
    const scenarioRows = this.orm
      .select()
      .from(savedScenarios)
      .where(eq(savedScenarios.userId, userId))
      .all();
    return {
      accounts: core?.accounts ?? [],
      events: core?.events ?? [],
      policy: core?.policy,
      cards: core?.cards ?? [],
      cardCycles: cycleRows.map((row) =>
        creditCardCycleSchema.parse({
          ...row,
          lockedStatementCents: row.lockedStatementCents ?? undefined,
          projectionOverrideCents: row.projectionOverrideCents ?? undefined,
          paymentOn: row.paymentOn ?? undefined,
          actualPaymentCents: row.actualPaymentCents ?? undefined,
          actualPaymentAccountId: row.actualPaymentAccountId ?? undefined,
        }),
      ),
      loans: loanRows.map(deserializeLoan),
      committedRefinancePlans: this.getCommittedRefinancePlans(userId),
      receivables: receivableRows.map(deserializeReceivable),
      assets: assetRows.map((row) =>
        assetSchema.parse({
          ...row,
          annualGrowthRateBasisPoints: row.annualGrowthRateBasisPoints ?? undefined,
          contributionGrossAnnualIncomeCents: row.contributionGrossAnnualIncomeCents ?? undefined,
          contributionAmountCents: row.contributionAmountCents ?? undefined,
          contributionRateBasisPoints: row.contributionRateBasisPoints ?? undefined,
          employerMatchBasisPoints: row.employerMatchBasisPoints ?? undefined,
          restrictionStatus: row.restrictionStatus ?? undefined,
          linkedLiabilityId: row.linkedLiabilityId ?? undefined,
        }),
      ),
      rewardPrograms: rewardRows.map((row) =>
        rewardProgramSchema.parse({
          ...row,
          pointValueMicros: row.pointValueMicros ?? undefined,
          expectedReceiptDate: row.expectedReceiptDate ?? undefined,
        }),
      ),
      reconciliations: reconciliationRows.map((row) =>
        reconciliationSchema.parse({ ...row, note: row.note ?? undefined }),
      ),
      savedScenarios: scenarioRows.map((row) =>
        savedScenarioSchema.parse({
          ...row,
          cardId: row.cardId ?? undefined,
          purchaseDate: row.purchaseDate ?? undefined,
          notes: row.notes ?? undefined,
        }),
      ),
    };
  }

  updateCashFloorPolicy(userId: string, input: CashFloorPolicy): CashFloorPolicy {
    const policy = cashFloorPolicySchema.parse(input);
    const policyRow = serializeCashFloorPolicy(policy);
    const timestamp = now();
    this.raw.transaction(() => {
      this.orm
        .insert(cashFloorPolicies)
        .values({ userId, ...policyRow, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: cashFloorPolicies.userId,
          set: { ...policyRow, updatedAt: timestamp },
        })
        .run();
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'update',
          entityType: 'cash-floor-policy',
          entityId: userId,
          payloadJson: JSON.stringify({ source: 'manual' }),
          createdAt: timestamp,
        })
        .run();
    })();
    return policy;
  }

  upsertManagedEntity(
    userId: string,
    entityType: ManagedEntityType,
    payload: unknown,
    options: { allowGroupedIncomeMutation?: boolean; asOfDate?: PlainDateString } = {},
  ): string {
    if (!this.getCredentialsById(userId)) throw new Error('Unknown user');
    const preliminaryId = (payload as { id?: unknown } | null)?.id;
    if (typeof preliminaryId !== 'string' || preliminaryId.length === 0) {
      throw new Error('Record ID is required');
    }
    this.assertManagedIdAvailable(userId, entityType, preliminaryId);
    const timestamp = now();
    const effectiveAsOfDate = options.asOfDate
      ? plainDateSchema.parse(options.asOfDate)
      : localPlainDate();
    let entityId: string;
    let auditPayload: Record<string, unknown> = { source: 'manual' };
    this.raw.transaction(() => {
      switch (entityType) {
        case 'cash-account': {
          const entity = cashAccountSchema.parse({ ...(payload as object), userId });
          const accountRow = serializeCashAccount(entity);
          entityId = entity.id;
          this.orm
            .insert(cashAccounts)
            .values({ ...accountRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: cashAccounts.id,
              set: { ...accountRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
        case 'forecast-event': {
          let entity = forecastEventSchema.parse({ ...(payload as object), userId });
          const existingRow = this.orm
            .select()
            .from(forecastEvents)
            .where(and(eq(forecastEvents.id, entity.id), eq(forecastEvents.userId, userId)))
            .get();
          const existingEvent = existingRow ? deserializeForecastEvent(existingRow) : undefined;
          const editsExistingReceivableSettlement = existingEvent?.kind === 'receivable-settlement';
          if (entity.kind === 'receivable-settlement' && !editsExistingReceivableSettlement) {
            throw new Error(
              'Record received money through Money Owed; receivable settlements cannot be created as generic forecast events',
            );
          }
          if (editsExistingReceivableSettlement && entity.kind !== 'receivable-settlement') {
            throw new Error(
              'A receivable settlement must remain linked to Money Owed; cancel it and record the correction there instead',
            );
          }
          const occurrenceMetadataFor = (
            candidate: ForecastEvent | undefined,
          ): PlainDateString | undefined => {
            if (!candidate) return undefined;
            const sourceOccurrence = candidate.sourceRecordId?.match(/@(\d{4}-\d{2}-\d{2})$/u)?.[1];
            const parsedSourceOccurrence = sourceOccurrence
              ? plainDateSchema.safeParse(sourceOccurrence)
              : undefined;
            return (
              candidate.receivableOccurrenceDate ??
              parseReceivableOccurrenceNote(candidate.notes) ??
              (parsedSourceOccurrence?.success ? parsedSourceOccurrence.data : undefined)
            );
          };
          const submittedOccurrenceMetadata = occurrenceMetadataFor(entity);
          const existingOccurrenceMetadata = occurrenceMetadataFor(existingEvent);
          const submittedInternalTarget = entity.receivableOccurrenceTargetCents;
          if (
            editsExistingReceivableSettlement &&
            existingEvent.sourceRecordId !== entity.sourceRecordId
          ) {
            throw new Error('A receivable settlement cannot be reassigned to a different balance');
          }
          if (
            editsExistingReceivableSettlement &&
            submittedOccurrenceMetadata !== undefined &&
            submittedOccurrenceMetadata !== existingOccurrenceMetadata
          ) {
            throw new Error(
              'A targeted receivable receipt cannot be reassigned; cancel it and record the correction instead',
            );
          }
          if (
            editsExistingReceivableSettlement &&
            submittedInternalTarget !== undefined &&
            submittedInternalTarget !== existingEvent.receivableOccurrenceTargetCents
          ) {
            throw new Error(
              'A recorded receivable occurrence target is managed internally and cannot be supplied or changed',
            );
          }
          if (editsExistingReceivableSettlement) {
            entity = forecastEventSchema.parse({
              ...entity,
              sourceRecordId: existingEvent.sourceRecordId,
              receivableOccurrenceDate:
                entity.receivableOccurrenceDate ??
                existingEvent.receivableOccurrenceDate ??
                parseReceivableOccurrenceNote(existingEvent.notes),
              receivableOccurrenceTargetCents: existingEvent.receivableOccurrenceTargetCents,
            });
          }
          const anchoredReceivables = this.orm
            .select()
            .from(receivables)
            .where(
              and(
                eq(receivables.userId, userId),
                eq(receivables.settlementAnchorEventId, entity.id),
              ),
            )
            .all()
            .map(deserializeReceivable);
          const anchorTimingChanged =
            existingEvent !== undefined &&
            anchoredReceivables.length > 0 &&
            JSON.stringify({
              date: existingEvent.date,
              recurrenceRule: existingEvent.recurrenceRule ?? null,
              recurrenceEndDate: existingEvent.recurrenceEndDate ?? null,
            }) !==
              JSON.stringify({
                date: entity.date,
                recurrenceRule: entity.recurrenceRule ?? null,
                recurrenceEndDate: entity.recurrenceEndDate ?? null,
              });
          const revisedAnchoredReceivables = anchoredReceivables.map((receivable) => {
            if (!anchorTimingChanged) return receivable;
            if (!entity.recurrenceRule || entity.recurrenceRule.frequency === 'once') {
              return receivable;
            }
            const offsetDays = receivable.settlementOffsetDays ?? 0;
            const previousAnchorOccurrence = addDays(receivable.expectedDate, -offsetDays);
            const revisedAnchorOccurrence = nearestRecurringEventOccurrence(
              entity,
              previousAnchorOccurrence,
            );
            return receivableSchema.parse({
              ...receivable,
              expectedDate: addDays(revisedAnchorOccurrence, offsetDays),
            });
          });
          for (const receivable of revisedAnchoredReceivables) {
            this.validateReceivableSettlementAnchor(receivable, entity);
          }
          if (anchorTimingChanged) {
            const profileEvents = this.orm
              .select()
              .from(forecastEvents)
              .where(eq(forecastEvents.userId, userId))
              .all()
              .map(deserializeForecastEvent);
            const profileReceivables = this.orm
              .select()
              .from(receivables)
              .where(eq(receivables.userId, userId))
              .all()
              .map(deserializeReceivable);
            const receivableById = new Map(
              profileReceivables.map((receivable) => [receivable.id, receivable]),
            );
            const anchorSnapshots: Array<{
              receivableId: string;
              eventId: string;
              occurrenceDate: PlainDateString;
            }> = [];
            for (const receivable of anchoredReceivables) {
              const revisedReceivable = revisedAnchoredReceivables.find(
                (candidate) => candidate.id === receivable.id,
              )!;
              const linkedSettlements = profileEvents.filter(
                (candidate) =>
                  candidate.kind === 'receivable-settlement' &&
                  candidate.direction === 'inflow' &&
                  receivableForSettlementSourceFromIndex(receivableById, candidate.sourceRecordId)
                    ?.id === receivable.id,
              );
              if (linkedSettlements.length === 0) continue;
              const oldRule = existingEvent.recurrenceRule!;
              const nextRule = entity.recurrenceRule!;
              if (
                oldRule.frequency !== nextRule.frequency ||
                recurrenceInterval(oldRule) !== recurrenceInterval(nextRule)
              ) {
                throw new Error(
                  'An anchor bill with recorded receipts cannot change recurrence cadence',
                );
              }
              const oldAnchorOccurrences = expandRecurrence({
                startDate: existingEvent.date,
                endDate: addDays(existingEvent.date, 800),
                rule: oldRule,
              });
              const nextOldAnchorOccurrence = oldAnchorOccurrences.find(
                (date) => compareDates(date, existingEvent.date) > 0,
              );
              const oldAnchorCadenceDays = nextOldAnchorOccurrence
                ? daysBetween(existingEvent.date, nextOldAnchorOccurrence)
                : recurrenceCadenceSpanDays(oldRule);
              if (Math.abs(daysBetween(existingEvent.date, entity.date)) >= oldAnchorCadenceDays) {
                throw new Error(
                  'An anchor bill start cannot skip a cycle that already has recorded receipts',
                );
              }
              const originalOccurrences = new Map(
                linkedSettlements.map((settlement) => [
                  settlement.id,
                  resolveRecordedReceivableOccurrenceDate({
                    receivable,
                    events: profileEvents,
                    settlementEvent: settlement,
                  }),
                ]),
              );
              const naturalAnchor = entity.recurrenceEndDate
                ? forecastEventSchema.parse({ ...entity, recurrenceEndDate: undefined })
                : entity;
              const revisedEvents = profileEvents.map((candidate) =>
                candidate.id === entity.id ? naturalAnchor : candidate,
              );
              const revisedOccurrenceByOriginal = new Map<PlainDateString, PlainDateString>();
              for (const occurrenceDate of new Set(originalOccurrences.values())) {
                const revisedOccurrence = resolveReceivableScheduleOccurrenceDate({
                  receivable: revisedReceivable,
                  events: revisedEvents,
                  settlementDate: occurrenceDate,
                });
                if (
                  entity.recurrenceEndDate &&
                  compareDates(
                    addDays(revisedOccurrence, -(receivable.settlementOffsetDays ?? 0)),
                    entity.recurrenceEndDate,
                  ) > 0
                ) {
                  throw new Error(
                    'An anchor bill cannot end before one of its recorded receipt occurrences',
                  );
                }
                revisedOccurrenceByOriginal.set(occurrenceDate, revisedOccurrence);
              }
              if (
                new Set(revisedOccurrenceByOriginal.values()).size !==
                revisedOccurrenceByOriginal.size
              ) {
                throw new Error(
                  'This anchor timing change would merge distinct recorded receipt occurrences',
                );
              }
              for (const settlement of linkedSettlements) {
                if (settlement.receivableOccurrenceDate !== undefined) continue;
                const occurrenceDate = originalOccurrences.get(settlement.id)!;
                this.orm
                  .update(forecastEvents)
                  .set({ receivableOccurrenceDate: occurrenceDate, updatedAt: timestamp })
                  .where(
                    and(eq(forecastEvents.id, settlement.id), eq(forecastEvents.userId, userId)),
                  )
                  .run();
                anchorSnapshots.push({
                  receivableId: receivable.id,
                  eventId: settlement.id,
                  occurrenceDate,
                });
              }
            }
            if (anchorSnapshots.length > 0) {
              auditPayload = {
                ...auditPayload,
                anchoredReceivableOccurrenceSnapshotSummary: {
                  count: anchorSnapshots.length,
                  sample: anchorSnapshots.slice(0, 20),
                  sha256: createHash('sha256')
                    .update(JSON.stringify(anchorSnapshots))
                    .digest('hex'),
                },
              };
            }
            const expectedDateCascades = revisedAnchoredReceivables
              .filter(
                (revised) =>
                  anchoredReceivables.find((original) => original.id === revised.id)
                    ?.expectedDate !== revised.expectedDate,
              )
              .map((revised) => ({ receivableId: revised.id, expectedDate: revised.expectedDate }));
            for (const cascade of expectedDateCascades) {
              this.orm
                .update(receivables)
                .set({ expectedDate: cascade.expectedDate, updatedAt: timestamp })
                .where(
                  and(eq(receivables.id, cascade.receivableId), eq(receivables.userId, userId)),
                )
                .run();
            }
            if (expectedDateCascades.length > 0) {
              auditPayload = {
                ...auditPayload,
                anchoredReceivableExpectedDateCascadeSummary: {
                  count: expectedDateCascades.length,
                  sample: expectedDateCascades.slice(0, 20),
                  sha256: createHash('sha256')
                    .update(JSON.stringify(expectedDateCascades))
                    .digest('hex'),
                },
              };
            }
          }
          if (
            !options.allowGroupedIncomeMutation &&
            (entity.incomePlanId || existingEvent?.incomePlanId)
          ) {
            throw new Error(
              'Edit grouped income from Income and raises so every allocation stays balanced',
            );
          }
          if (this.updatePairedInternalTransfer(userId, entity, timestamp)) {
            entityId = entity.id;
            break;
          }
          if (
            entity.transferId ||
            entity.kind === 'transfer-debit' ||
            entity.kind === 'transfer-credit'
          ) {
            throw new Error('Create transfers with the paired internal-transfer planner');
          }
          const eventRow = serializeForecastEvent(entity);
          this.assertOwnedAccount(userId, entity.accountId);
          if (entity.incomeType && (entity.kind !== 'income' || entity.direction !== 'inflow')) {
            throw new Error('Income metadata requires an income inflow record');
          }
          if (entity.parentIncomeEventId) {
            if (entity.incomeType !== 'raise-adjustment') {
              throw new Error('Only a raise adjustment can link to an income stream');
            }
            this.assertOwnedForecastEvent(userId, entity.parentIncomeEventId);
          }
          if (entity.parentIncomePlanId) {
            if (entity.incomeType !== 'raise-adjustment') {
              throw new Error('Only a raise adjustment can link to an income plan');
            }
            this.assertOwnedBaseIncomePlan(userId, entity.parentIncomePlanId);
          }
          if (
            entity.kind === 'loan-payment' &&
            (entity.paymentMethod !== 'cash-account' || entity.direction !== 'outflow')
          ) {
            throw new Error('An installment-loan payment must be a cash-account outflow');
          }
          if (entity.paymentMethod === 'credit-card' && !entity.cardId) {
            throw new Error('Card-funded activity requires a card');
          }
          if (entity.kind === 'card-payment') {
            if (!entity.cardId) throw new Error('A card payment must identify the card being paid');
            if (entity.paymentMethod !== 'cash-account' || entity.direction !== 'outflow') {
              throw new Error('A card payment must be a cash-account outflow');
            }
            if (entity.sourceRecordId) {
              this.assertOwnedCardCycleForCard(userId, entity.sourceRecordId, entity.cardId);
            }
          }
          if (entity.kind === 'loan-payment') {
            if (!entity.sourceRecordId) {
              throw new Error('A loan payment must identify the installment loan it reduces');
            }
            const linkedLoan = this.ownedLoan(userId, entity.sourceRecordId);
            if (entity.paymentMethod !== 'cash-account' || entity.direction !== 'outflow') {
              throw new Error('An installment-loan payment must be a cash-account outflow');
            }
            if (entity.amountCents <= 0) {
              throw new Error('An installment-loan payment must be greater than zero');
            }
            if (entity.accountId !== linkedLoan.fundingAccountId) {
              throw new Error(`Loan payments must leave ${linkedLoan.name}'s payment account`);
            }
            if (
              (entity.loanPaymentTreatment ?? 'scheduled-draft-override') ===
              'scheduled-draft-override'
            ) {
              this.assertScheduledLoanDraftOccurrence(linkedLoan, entity);
            }
          }
          if (entity.cardId) {
            const linkedCard = this.ownedCard(userId, entity.cardId);
            if (
              entity.paymentMethod === 'credit-card' &&
              !cardAllowsPurchasesOnDate(linkedCard, entity.date)
            ) {
              throw new Error(
                `${linkedCard.name} cannot fund purchases on or after its closure date`,
              );
            }
          }
          this.validateManagedReceivableSettlement(userId, entity, existingEvent);
          this.reconcileStaticReceivableSettlementMutation(
            userId,
            existingEvent,
            entity,
            timestamp,
          );
          entityId = entity.id;
          this.orm
            .insert(forecastEvents)
            .values({
              ...eventRow,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: forecastEvents.id,
              set: { ...eventRow, userId, updatedAt: timestamp },
            })
            .run();
          if (!entity.incomePlanId) this.cascadeLinkedRaiseEvents(userId, entity);
          break;
        }
        case 'credit-card': {
          const submitted = payload as Record<string, unknown>;
          const submittedId = typeof submitted.id === 'string' ? submitted.id : '';
          const existingCard = this.orm
            .select()
            .from(creditCards)
            .where(and(eq(creditCards.id, submittedId), eq(creditCards.userId, userId)))
            .get();
          const submittedStatus = Object.hasOwn(submitted, 'status')
            ? submitted.status
            : (existingCard?.status ?? 'active');
          const explicitlyReactivating =
            Object.hasOwn(submitted, 'status') && submittedStatus === 'active';
          const parsed = creditCardSchema.parse({
            ...submitted,
            userId,
            status: submittedStatus,
            closedOn: explicitlyReactivating
              ? undefined
              : Object.hasOwn(submitted, 'closedOn')
                ? submitted.closedOn
                : (existingCard?.closedOn ?? undefined),
          });
          const existingPaymentDay = existingCard?.cycleTimingComplete
            ? existingCard.paymentDayOfMonth
            : undefined;
          const existingStatementCloseDay = existingCard?.cycleTimingComplete
            ? existingCard.statementCloseDayOfMonth
            : undefined;
          const entity = creditCardSchema.parse({
            ...parsed,
            paymentDayOfMonth: Object.hasOwn(submitted, 'paymentDayOfMonth')
              ? parsed.paymentDayOfMonth
              : existingPaymentDay,
            statementCloseDayOfMonth: Object.hasOwn(submitted, 'statementCloseDayOfMonth')
              ? parsed.statementCloseDayOfMonth
              : existingStatementCloseDay,
          });
          const cardRow = serializeCreditCard(entity);
          this.assertOwnedAccount(userId, entity.fundingAccountId);
          entityId = entity.id;
          this.orm
            .insert(creditCards)
            .values({ ...cardRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: creditCards.id,
              set: {
                name: entity.name,
                issuer: cardRow.issuer,
                lastFour: cardRow.lastFour,
                fundingAccountId: entity.fundingAccountId,
                accountKind: entity.accountKind,
                creditLimitCents: cardRow.creditLimitCents,
                reportedBalanceCents: cardRow.reportedBalanceCents,
                reportedBalanceDate: cardRow.reportedBalanceDate,
                reportedCarryingBalanceCents: cardRow.reportedCarryingBalanceCents,
                reportedCarryingBalanceDate: cardRow.reportedCarryingBalanceDate,
                defaultFutureStatementCents: entity.defaultFutureStatementCents,
                estimatePolicy: entity.estimatePolicy,
                paymentPolicy: entity.paymentPolicy,
                fixedPaymentCents: cardRow.fixedPaymentCents,
                minimumPaymentCents: cardRow.minimumPaymentCents,
                aprBasisPoints: cardRow.aprBasisPoints,
                interestForecastEnabled: entity.interestForecastEnabled,
                promotionalCarryingBalance: entity.promotionalCarryingBalance,
                promotionalAprBasisPoints: cardRow.promotionalAprBasisPoints,
                promotionEndDate: cardRow.promotionEndDate,
                paymentDayOfMonth: cardRow.paymentDayOfMonth,
                statementCloseDayOfMonth: cardRow.statementCloseDayOfMonth,
                cycleTimingComplete: cardRow.cycleTimingComplete,
                status: entity.status,
                closedOn: cardRow.closedOn,
                updatedAt: timestamp,
              },
            })
            .run();
          break;
        }
        case 'card-cycle': {
          const entity = creditCardCycleSchema.parse(payload);
          if (entity.state === 'paid' && entity.lockedStatementCents === undefined) {
            throw new Error('A paid card cycle requires its locked statement amount');
          }
          const cycleRow = serializeCreditCardCycle(entity);
          const linkedCard = this.ownedCard(userId, entity.cardId);
          if (entity.actualPaymentAccountId) {
            this.assertOwnedAccount(userId, entity.actualPaymentAccountId);
          }
          if (
            linkedCard.status === 'closed' &&
            compareDates(entity.opensOn, linkedCard.closedOn!) >= 0
          ) {
            throw new Error(
              `A statement cycle cannot open on or after ${linkedCard.name}'s closure date`,
            );
          }
          const overlapping = this.orm
            .select()
            .from(creditCardCycles)
            .where(
              and(eq(creditCardCycles.userId, userId), eq(creditCardCycles.cardId, entity.cardId)),
            )
            .all()
            .find(
              (cycle) =>
                cycle.id !== entity.id &&
                entity.opensOn <= cycle.closesOn &&
                cycle.opensOn <= entity.closesOn,
            );
          if (overlapping) {
            throw new Error(
              `Card cycle overlaps the existing ${overlapping.opensOn} to ${overlapping.closesOn} cycle`,
            );
          }
          entityId = entity.id;
          this.orm
            .insert(creditCardCycles)
            .values({ userId, ...cycleRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: creditCardCycles.id,
              set: { ...cycleRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
        case 'loan': {
          const entity = loanSchema.parse({ ...(payload as object), userId });
          const loanRow = serializeLoan(entity);
          this.assertOwnedAccount(userId, entity.fundingAccountId);
          const existingLoanRow = this.orm
            .select()
            .from(loans)
            .where(and(eq(loans.id, entity.id), eq(loans.userId, userId)))
            .get();
          const existingLoan = existingLoanRow ? deserializeLoan(existingLoanRow) : undefined;
          const committedOrigin = this.orm
            .select({
              closingDate: committedRefinancePlans.closingDate,
              replacementLoanSnapshotJson: committedRefinancePlans.replacementLoanSnapshotJson,
            })
            .from(committedRefinancePlans)
            .where(
              and(
                eq(committedRefinancePlans.userId, userId),
                eq(committedRefinancePlans.replacementLoanId, entity.id),
                eq(committedRefinancePlans.status, 'committed'),
              ),
            )
            .get();
          const committedRetirement = this.raw
            .prepare(
              `SELECT plan.payoff_date AS payoffDate
                 FROM committed_refinance_payoffs AS payoff
                 JOIN committed_refinance_plans AS plan ON plan.id = payoff.plan_id
                WHERE payoff.user_id = ?
                  AND payoff.source_loan_id = ?
                  AND plan.status = 'committed'
                LIMIT 1`,
            )
            .get(userId, entity.id) as { payoffDate: PlainDateString } | undefined;
          if (
            (committedOrigin || committedRetirement) &&
            ((entity.status ?? 'active') !== 'active' || entity.includeInCashForecast === false)
          ) {
            throw new Error(
              'Loan lifecycle and cash inclusion are managed by its committed refinance plan',
            );
          }
          if (committedOrigin && compareDates(effectiveAsOfDate, committedOrigin.closingDate) < 0) {
            const committedSnapshot = loanSchema.parse(
              JSON.parse(committedOrigin.replacementLoanSnapshotJson),
            );
            if (JSON.stringify(entity) !== JSON.stringify(committedSnapshot)) {
              throw new Error(
                'Future replacement-loan terms are locked; cancel and recreate the refinance plan to change them',
              );
            }
          }
          if (existingLoan && committedRetirement) {
            const scheduleTerms = (candidate: Loan): string =>
              JSON.stringify({
                principalCents: candidate.principalCents,
                accruedInterestCents: candidate.accruedInterestCents,
                balanceDate: candidate.balanceDate,
                annualRateBasisPoints: candidate.annualRateBasisPoints,
                accrualConvention: candidate.accrualConvention,
                paymentCents: candidate.paymentCents,
                cashPaymentCents: candidate.cashPaymentCents ?? candidate.paymentCents,
                nextPaymentDate: candidate.nextPaymentDate,
                maturityDate: candidate.maturityDate,
                originalPrincipalCents: candidate.originalPrincipalCents,
                originalDate: candidate.originalDate,
                originalTermMonths: candidate.originalTermMonths,
                amortizationStructure: candidate.amortizationStructure,
                expectedBalloonCents: candidate.expectedBalloonCents,
                fundingAccountId: candidate.fundingAccountId,
                excludeFromEconomicNetWorthDoubleCount:
                  candidate.excludeFromEconomicNetWorthDoubleCount,
                paymentFrequency: candidate.paymentFrequency ?? 'monthly',
                includeInCashForecast: candidate.includeInCashForecast ?? true,
                status: candidate.status ?? 'active',
              });
            if (scheduleTerms(existingLoan) !== scheduleTerms(entity)) {
              throw new Error(
                'Source-loan schedule terms are locked by committed refinance history; cancel the upcoming plan before closing if those terms must change',
              );
            }
          }
          if (existingLoan) {
            const paymentInstructionCascades = this.reconcileLoanPaymentInstructionsForEdit({
              userId,
              previousLoan: existingLoan,
              nextLoan: entity,
              asOfDate: effectiveAsOfDate,
              timestamp,
            });
            if (paymentInstructionCascades.length > 0) {
              auditPayload = {
                ...auditPayload,
                loanPaymentInstructionCascadeSummary: {
                  count: paymentInstructionCascades.length,
                  sample: paymentInstructionCascades.slice(0, 20),
                  sha256: createHash('sha256')
                    .update(JSON.stringify(paymentInstructionCascades))
                    .digest('hex'),
                },
              };
            }
          }
          entityId = entity.id;
          this.orm
            .insert(loans)
            .values({ ...loanRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: loans.id,
              set: { ...loanRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
        case 'receivable': {
          const entity = receivableSchema.parse({ ...(payload as object), userId });
          const existingReceivableRow = this.orm
            .select()
            .from(receivables)
            .where(and(eq(receivables.id, entity.id), eq(receivables.userId, userId)))
            .get();
          const existingReceivable = existingReceivableRow
            ? deserializeReceivable(existingReceivableRow)
            : undefined;
          const receivableRow = serializeReceivable(entity);
          this.assertOwnedAccount(userId, entity.destinationAccountId);
          if (entity.settlementAnchorEventId) {
            this.validateReceivableSettlementAnchor(
              entity,
              this.ownedForecastEvent(userId, entity.settlementAnchorEventId),
            );
          }
          if (entity.relatedExpenseId) {
            this.assertOwnedForecastEvent(userId, entity.relatedExpenseId);
          }
          this.assertOwnedPaymentInstrument(userId, entity.paymentInstrument);
          const existingRunRateCents = existingReceivable
            ? (existingReceivable.recurringAmountCents ?? existingReceivable.originalAmountCents)
            : undefined;
          const nextRunRateCents = entity.recurringAmountCents ?? entity.originalAmountCents;
          const runRateChanged =
            existingRunRateCents !== undefined && existingRunRateCents !== nextRunRateCents;
          const timingChanged =
            existingReceivable !== undefined &&
            JSON.stringify({
              expectedDate: existingReceivable.expectedDate,
              recurrenceRule: existingReceivable.recurrenceRule ?? null,
              recurrenceEndDate: existingReceivable.recurrenceEndDate ?? null,
              settlementAnchorEventId: existingReceivable.settlementAnchorEventId ?? null,
              settlementOffsetDays: existingReceivable.settlementOffsetDays ?? null,
            }) !==
              JSON.stringify({
                expectedDate: entity.expectedDate,
                recurrenceRule: entity.recurrenceRule ?? null,
                recurrenceEndDate: entity.recurrenceEndDate ?? null,
                settlementAnchorEventId: entity.settlementAnchorEventId ?? null,
                settlementOffsetDays: entity.settlementOffsetDays ?? null,
              });
          if (
            existingReceivable &&
            hasRecurringReceivableSchedule(existingReceivable) &&
            (runRateChanged || timingChanged)
          ) {
            const scheduleEvents = this.orm
              .select()
              .from(forecastEvents)
              .where(eq(forecastEvents.userId, userId))
              .all()
              .map(deserializeForecastEvent);
            const profileReceivables = this.orm
              .select()
              .from(receivables)
              .where(eq(receivables.userId, userId))
              .all()
              .map(deserializeReceivable);
            const profileReceivableById = new Map(
              profileReceivables.map((receivable) => [receivable.id, receivable]),
            );
            const linkedSettlementEvents = scheduleEvents.filter(
              (candidate) =>
                candidate.kind === 'receivable-settlement' &&
                candidate.direction === 'inflow' &&
                receivableForSettlementSourceFromIndex(
                  profileReceivableById,
                  candidate.sourceRecordId,
                )?.id === existingReceivable.id,
            );
            const occurrenceIdentityByEvent = new Map(
              linkedSettlementEvents.map((settlementEvent) => [
                settlementEvent.id,
                resolveRecordedReceivableOccurrenceDate({
                  receivable: existingReceivable,
                  events: scheduleEvents,
                  settlementEvent,
                }),
              ]),
            );
            const targetByOccurrence = new Map<PlainDateString, number>();
            const appliedCentsByOccurrence = new Map<PlainDateString, number>();
            for (const settlementEvent of linkedSettlementEvents) {
              const occurrenceDate = occurrenceIdentityByEvent.get(settlementEvent.id)!;
              const targetCents = settlementEvent.receivableOccurrenceTargetCents;
              const storedTarget = targetByOccurrence.get(occurrenceDate);
              if (
                targetCents !== undefined &&
                storedTarget !== undefined &&
                storedTarget !== targetCents
              ) {
                throw new Error('Recorded receipts disagree on the recurring occurrence target');
              }
              if (targetCents !== undefined) targetByOccurrence.set(occurrenceDate, targetCents);
              if (this.isAppliedReceivableSettlement(settlementEvent)) {
                appliedCentsByOccurrence.set(
                  occurrenceDate,
                  (appliedCentsByOccurrence.get(occurrenceDate) ?? 0) + settlementEvent.amountCents,
                );
              }
            }
            if (timingChanged && linkedSettlementEvents.length > 0) {
              if (!hasRecurringReceivableSchedule(entity)) {
                throw new Error(
                  'A repeating receivable with recorded receipts cannot be converted to one-time timing',
                );
              }
              if (existingReceivable.settlementAnchorEventId !== entity.settlementAnchorEventId) {
                throw new Error(
                  'A receivable with recorded receipts cannot switch to a different timing anchor',
                );
              }
              if (!existingReceivable.settlementAnchorEventId) {
                const oldRule = existingReceivable.recurrenceRule!;
                const nextRule = entity.recurrenceRule!;
                if (
                  oldRule.frequency !== nextRule.frequency ||
                  recurrenceInterval(oldRule) !== recurrenceInterval(nextRule)
                ) {
                  throw new Error(
                    'A receivable with recorded receipts cannot change recurrence cadence',
                  );
                }
                const oldOccurrences = receivableSettlementDates({
                  receivable: existingReceivable,
                  events: scheduleEvents,
                  endDate: addDays(existingReceivable.expectedDate, 800),
                });
                const nextOldOccurrence = oldOccurrences.find(
                  (date) => compareDates(date, existingReceivable.expectedDate) > 0,
                );
                const maximumStartShiftDays = nextOldOccurrence
                  ? daysBetween(existingReceivable.expectedDate, nextOldOccurrence)
                  : recurrenceCadenceSpanDays(oldRule);
                if (
                  Math.abs(daysBetween(existingReceivable.expectedDate, entity.expectedDate)) >=
                  maximumStartShiftDays
                ) {
                  throw new Error(
                    'A receivable schedule start cannot skip a cycle that already has recorded receipts',
                  );
                }
              } else {
                const anchor = this.ownedForecastEvent(
                  userId,
                  existingReceivable.settlementAnchorEventId,
                );
                const anchorOccurrences = anchor.recurrenceRule
                  ? expandRecurrence({
                      startDate: anchor.date,
                      endDate: addDays(anchor.date, 800),
                      rule: anchor.recurrenceRule,
                    })
                  : [];
                const nextAnchorOccurrence = anchorOccurrences.find(
                  (date) => compareDates(date, anchor.date) > 0,
                );
                const anchorCadenceDays = nextAnchorOccurrence
                  ? daysBetween(anchor.date, nextAnchorOccurrence)
                  : anchor.recurrenceRule
                    ? recurrenceCadenceSpanDays(anchor.recurrenceRule)
                    : 1;
                if (
                  anchor.recurrenceRule &&
                  Math.abs(
                    (existingReceivable.settlementOffsetDays ?? 0) -
                      (entity.settlementOffsetDays ?? 0),
                  ) >= anchorCadenceDays
                ) {
                  throw new Error(
                    'A bill-relative receipt offset cannot jump across a recorded anchor cycle',
                  );
                }
              }
              const revisedOccurrenceByOriginal = new Map<PlainDateString, PlainDateString>();
              for (const occurrenceDate of new Set(occurrenceIdentityByEvent.values())) {
                const revisedOccurrence = resolveReceivableScheduleOccurrenceDate({
                  receivable: entity.recurrenceEndDate
                    ? receivableSchema.parse({ ...entity, recurrenceEndDate: undefined })
                    : entity,
                  events: scheduleEvents,
                  settlementDate: occurrenceDate,
                });
                if (
                  entity.recurrenceEndDate &&
                  compareDates(revisedOccurrence, entity.recurrenceEndDate) > 0
                ) {
                  throw new Error(
                    'A receivable schedule cannot end before one of its recorded receipt occurrences',
                  );
                }
                const wasStaticOpeningOccurrence =
                  occurrenceDate === existingReceivable.expectedDate &&
                  existingReceivable.originalAmountCents > 0;
                const becomesStaticOpeningOccurrence =
                  revisedOccurrence === entity.expectedDate && entity.originalAmountCents > 0;
                if (wasStaticOpeningOccurrence !== becomesStaticOpeningOccurrence) {
                  throw new Error(
                    'A receivable timing edit cannot turn recorded run-rate history into its static opening balance',
                  );
                }
                revisedOccurrenceByOriginal.set(occurrenceDate, revisedOccurrence);
              }
              if (
                new Set(revisedOccurrenceByOriginal.values()).size !==
                revisedOccurrenceByOriginal.size
              ) {
                throw new Error(
                  'This receivable timing change would merge distinct recorded receipt occurrences',
                );
              }
            }
            const occurrenceSnapshots: Array<{
              eventId: string;
              occurrenceDate: PlainDateString;
              targetCents?: number;
              targetInference?: 'stored' | 'run-rate' | 'settled-lower-bound';
            }> = [];
            for (const settlementEvent of linkedSettlementEvents) {
              const occurrenceDate = occurrenceIdentityByEvent.get(settlementEvent.id)!;
              const occurrenceUsesStaticBalance =
                occurrenceDate === existingReceivable.expectedDate &&
                existingReceivable.originalAmountCents > 0;
              const storedOccurrenceTarget = targetByOccurrence.get(occurrenceDate);
              const appliedOccurrenceCents = appliedCentsByOccurrence.get(occurrenceDate) ?? 0;
              const inferredOccurrenceTarget = Math.max(
                existingRunRateCents ?? 0,
                appliedOccurrenceCents,
              );
              const targetCents =
                runRateChanged &&
                !occurrenceUsesStaticBalance &&
                settlementEvent.receivableOccurrenceTargetCents === undefined
                  ? (storedOccurrenceTarget ??
                    (inferredOccurrenceTarget > 0 ? inferredOccurrenceTarget : undefined))
                  : settlementEvent.receivableOccurrenceTargetCents;
              const occurrenceDateToPersist =
                (timingChanged ||
                  targetCents !== settlementEvent.receivableOccurrenceTargetCents) &&
                settlementEvent.receivableOccurrenceDate === undefined
                  ? occurrenceDate
                  : settlementEvent.receivableOccurrenceDate;
              if (
                targetCents === settlementEvent.receivableOccurrenceTargetCents &&
                occurrenceDateToPersist === settlementEvent.receivableOccurrenceDate
              ) {
                continue;
              }
              this.orm
                .update(forecastEvents)
                .set({
                  receivableOccurrenceDate: occurrenceDateToPersist,
                  receivableOccurrenceTargetCents: targetCents,
                  updatedAt: timestamp,
                })
                .where(
                  and(eq(forecastEvents.id, settlementEvent.id), eq(forecastEvents.userId, userId)),
                )
                .run();
              occurrenceSnapshots.push({
                eventId: settlementEvent.id,
                occurrenceDate,
                targetCents,
                targetInference:
                  targetCents === undefined
                    ? undefined
                    : storedOccurrenceTarget !== undefined
                      ? 'stored'
                      : appliedOccurrenceCents > (existingRunRateCents ?? 0)
                        ? 'settled-lower-bound'
                        : 'run-rate',
              });
            }
            if (occurrenceSnapshots.length > 0) {
              auditPayload = {
                ...auditPayload,
                receivableOccurrenceSnapshotSummary: {
                  count: occurrenceSnapshots.length,
                  sample: occurrenceSnapshots.slice(0, 20),
                  sha256: createHash('sha256')
                    .update(JSON.stringify(occurrenceSnapshots))
                    .digest('hex'),
                },
              };
            }
          }
          entityId = entity.id;
          this.orm
            .insert(receivables)
            .values({ ...receivableRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: receivables.id,
              set: { ...receivableRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
        case 'asset': {
          const entity = assetSchema.parse({ ...(payload as object), userId });
          const assetRow = serializeAsset(entity);
          if (entity.linkedLiabilityId) {
            this.assertOwnedLoan(userId, entity.linkedLiabilityId);
          }
          const existingAsset = this.raw
            .prepare(
              'SELECT linked_liability_id AS linkedLiabilityId FROM assets WHERE id = ? AND user_id = ?',
            )
            .get(entity.id, userId) as { linkedLiabilityId: string | null } | undefined;
          if (!existingAsset) {
            const { count } = this.raw
              .prepare('SELECT COUNT(*) AS count FROM assets WHERE user_id = ?')
              .get(userId) as { count: number };
            if (count >= maximumProfileAssetRecords) {
              throw new Error(
                `A profile cannot contain more than ${maximumProfileAssetRecords.toLocaleString()} assets`,
              );
            }
          }
          const hasCommittedRelink = (
            this.raw
              .prepare(
                `SELECT asset_relinks_json AS assetRelinksJson
                   FROM committed_refinance_plans
                  WHERE user_id = ? AND status = 'committed'`,
              )
              .all(userId) as Array<{
              assetRelinksJson: string;
            }>
          ).some(({ assetRelinksJson }) =>
            (JSON.parse(assetRelinksJson) as RefinanceAssetRelink[]).some(
              (relink) => relink.assetId === entity.id,
            ),
          );
          if (entity.linkedLiabilityId) {
            const scheduledRetirement = this.raw
              .prepare(
                `SELECT plan.id
                   FROM committed_refinance_payoffs AS payoff
                   JOIN committed_refinance_plans AS plan ON plan.id = payoff.plan_id
                  WHERE payoff.user_id = ?
                    AND payoff.source_loan_id = ?
                    AND plan.status = 'committed'
                  LIMIT 1`,
              )
              .get(userId, entity.linkedLiabilityId);
            const futureReplacement = this.raw
              .prepare(
                `SELECT id
                   FROM committed_refinance_plans
                  WHERE user_id = ?
                    AND replacement_loan_id = ?
                    AND status = 'committed'
                    AND closing_date > ?
                  LIMIT 1`,
              )
              .get(userId, entity.linkedLiabilityId, effectiveAsOfDate);
            const changedLink =
              !existingAsset ||
              (existingAsset.linkedLiabilityId ?? undefined) !== entity.linkedLiabilityId;
            if (scheduledRetirement) {
              throw new Error(
                'This liability is already scheduled for a committed refinance payoff; link the asset to the effective replacement after closing',
              );
            }
            if (changedLink && futureReplacement) {
              throw new Error(
                'This replacement liability does not become effective until its upcoming refinance closes',
              );
            }
          }
          if (
            existingAsset &&
            (existingAsset.linkedLiabilityId ?? undefined) !== entity.linkedLiabilityId &&
            hasCommittedRelink
          ) {
            throw new Error(
              'This asset link is controlled by committed refinance history; use a later refinance to carry it forward',
            );
          }
          entityId = entity.id;
          this.orm
            .insert(assets)
            .values({ ...assetRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: assets.id,
              set: { ...assetRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
        case 'reward-program': {
          const entity = rewardProgramSchema.parse({ ...(payload as object), userId });
          const rewardRow = serializeRewardProgram(entity);
          this.assertOwnedCard(userId, entity.cardId);
          entityId = entity.id;
          this.orm
            .insert(rewardPrograms)
            .values({ ...rewardRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: rewardPrograms.id,
              set: { ...rewardRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
        case 'reconciliation': {
          const entity = reconciliationSchema.parse({ ...(payload as object), userId });
          const reconciliationRow = serializeReconciliation(entity);
          this.assertOwnedAccount(userId, entity.accountId);
          entityId = entity.id;
          this.orm
            .insert(reconciliations)
            .values({ ...reconciliationRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: reconciliations.id,
              set: { ...reconciliationRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
        case 'saved-scenario': {
          const entity = savedScenarioSchema.parse({ ...(payload as object), userId });
          const scenarioRow = serializeSavedScenario(entity);
          this.assertOwnedAccount(userId, entity.accountId);
          if (entity.fundingType === 'card') {
            const card = this.ownedCard(userId, entity.cardId!);
            if (!cardAllowsPurchasesOnDate(card, entity.purchaseDate!)) {
              throw new Error(`${card.name} cannot fund a scenario on or after its closure date`);
            }
            if (card.fundingAccountId !== entity.accountId) {
              throw new Error("Card scenario must use the selected card's funding account");
            }
          }
          entityId = entity.id;
          this.orm
            .insert(savedScenarios)
            .values({ ...scenarioRow, createdAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: savedScenarios.id,
              set: { ...scenarioRow, userId, updatedAt: timestamp },
            })
            .run();
          break;
        }
      }
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'upsert',
          entityType,
          entityId: entityId!,
          payloadJson: JSON.stringify(auditPayload),
          createdAt: timestamp,
        })
        .run();
      this.orm
        .update(importLineage)
        .set({ destinationEditedAt: timestamp })
        .where(
          and(
            eq(importLineage.userId, userId),
            eq(importLineage.entityType, entityType),
            eq(importLineage.entityId, entityId!),
          ),
        )
        .run();
    })();
    return entityId!;
  }

  upsertIncomePlan(userId: string, payloads: unknown[], replacePlanId?: string): string[] {
    if (payloads.length < 1 || payloads.length > 24) {
      throw new Error('An income change must contain between one and 24 records');
    }
    const events = payloads.map((payload) =>
      forecastEventSchema.parse({ ...(payload as object), userId }),
    );
    if (
      events.some(
        (event) => event.kind !== 'income' || event.direction !== 'inflow' || !event.incomeType,
      )
    ) {
      throw new Error('Income plans may contain only typed income inflows');
    }
    if (new Set(events.map((event) => event.id)).size !== events.length) {
      throw new Error('An income change cannot contain duplicate record IDs');
    }
    assertValidIncomePlanGroups(events);
    const submittedPlanIds = new Set(
      events
        .map((event) => event.incomePlanId)
        .filter((value): value is string => value !== undefined),
    );
    if (submittedPlanIds.size > 1) {
      throw new Error('An income change may create or replace only one grouped income plan');
    }
    const submittedPlanId = [...submittedPlanIds][0];
    if (replacePlanId) {
      if (events.some((event) => event.incomePlanId !== replacePlanId)) {
        throw new Error('A replacement must contain every allocation for exactly one income plan');
      }
      this.assertOwnedIncomePlan(userId, replacePlanId);
    }
    return this.raw.transaction(() => {
      if (submittedPlanId && !replacePlanId) {
        const existingPlan = this.orm
          .select({ id: forecastEvents.id })
          .from(forecastEvents)
          .where(
            and(
              eq(forecastEvents.userId, userId),
              eq(forecastEvents.incomePlanId, submittedPlanId),
            ),
          )
          .get();
        if (existingPlan) {
          throw new Error(
            `Income plan ${submittedPlanId} already exists; replace the income plan explicitly`,
          );
        }
      }
      for (const event of events) {
        const existing = this.orm
          .select()
          .from(forecastEvents)
          .where(eq(forecastEvents.id, event.id))
          .get();
        if (!existing) continue;
        if (existing.userId !== userId) throw new Error('Record ID belongs to another profile');
        if (!replacePlanId || existing.incomePlanId !== replacePlanId) {
          throw new Error(
            `Income allocation record ${event.id} already belongs to another income plan`,
          );
        }
      }
      const existingStreamEvents = this.orm
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, userId))
        .all()
        .map(deserializeForecastEvent)
        .filter((event) => !replacePlanId || event.incomePlanId !== replacePlanId);
      assertValidIncomePlanGroups([...existingStreamEvents, ...events]);
      if (replacePlanId) {
        const submittedIds = new Set(events.map((event) => event.id));
        const existingRows = this.orm
          .select()
          .from(forecastEvents)
          .where(
            and(eq(forecastEvents.userId, userId), eq(forecastEvents.incomePlanId, replacePlanId)),
          )
          .all();
        const timestamp = now();
        for (const row of existingRows) {
          if (submittedIds.has(row.id)) continue;
          this.orm
            .delete(forecastEvents)
            .where(and(eq(forecastEvents.userId, userId), eq(forecastEvents.id, row.id)))
            .run();
          this.orm
            .insert(auditEvents)
            .values({
              id: randomUUID(),
              userId,
              action: 'delete',
              entityType: 'forecast-event',
              entityId: row.id,
              payloadJson: JSON.stringify({
                source: 'income-plan-replacement',
                incomePlanId: replacePlanId,
              }),
              createdAt: timestamp,
            })
            .run();
          this.orm
            .update(importLineage)
            .set({ destinationEditedAt: timestamp })
            .where(
              and(
                eq(importLineage.userId, userId),
                eq(importLineage.entityType, 'forecast-event'),
                eq(importLineage.entityId, row.id),
              ),
            )
            .run();
        }
      }
      const savedIds = events.map((event) =>
        this.upsertManagedEntity(userId, 'forecast-event', event, {
          allowGroupedIncomeMutation: true,
        }),
      );
      if (replacePlanId) this.cascadeLinkedRaisePlans(userId, replacePlanId, events);
      return savedIds;
    })();
  }

  deleteManagedEntity(userId: string, entityType: ManagedEntityType, entityId: string): void {
    const tableByType = {
      'cash-account': cashAccounts,
      'forecast-event': forecastEvents,
      'credit-card': creditCards,
      'card-cycle': creditCardCycles,
      loan: loans,
      receivable: receivables,
      asset: assets,
      'reward-program': rewardPrograms,
      reconciliation: reconciliations,
      'saved-scenario': savedScenarios,
    } as const;
    const table = tableByType[entityType];
    const timestamp = now();
    this.raw.transaction(() => {
      const owned = this.raw
        .prepare(`SELECT 1 FROM ${this.managedTableName(entityType)} WHERE id = ? AND user_id = ?`)
        .get(entityId, userId);
      if (!owned) throw new Error('Record not found');
      if (entityType === 'forecast-event') {
        const eventRow = this.orm
          .select()
          .from(forecastEvents)
          .where(and(eq(forecastEvents.id, entityId), eq(forecastEvents.userId, userId)))
          .get();
        const settlementAssociation =
          eventRow?.kind === 'receivable-settlement'
            ? this.resolveReceivableSettlementAssociation(
                userId,
                deserializeForecastEvent(eventRow),
                false,
              )
            : undefined;
        if (
          eventRow?.kind === 'receivable-settlement' &&
          eventRow.receivableOccurrenceTargetCents !== null &&
          (!settlementAssociation ||
            hasRecurringReceivableSchedule(settlementAssociation.receivable))
        ) {
          throw new Error(
            'A receipt with frozen occurrence history cannot be deleted; cancel it to preserve the forecast baseline',
          );
        }
        const anchoredReceivable = this.orm
          .select({ id: receivables.id })
          .from(receivables)
          .where(
            and(eq(receivables.userId, userId), eq(receivables.settlementAnchorEventId, entityId)),
          )
          .get();
        if (anchoredReceivable) {
          throw new Error(
            'Move or remove the linked Money Owed receipt schedule before deleting its anchor bill',
          );
        }
        const linkedRaise = this.orm
          .select({ id: forecastEvents.id })
          .from(forecastEvents)
          .where(
            and(
              eq(forecastEvents.userId, userId),
              eq(forecastEvents.parentIncomeEventId, entityId),
            ),
          )
          .get();
        if (linkedRaise) {
          throw new Error('Delete linked raises before deleting their base income stream');
        }
        if (eventRow?.transferId) {
          const result = this.orm
            .delete(forecastEvents)
            .where(
              and(
                eq(forecastEvents.userId, userId),
                eq(forecastEvents.transferId, eventRow.transferId),
              ),
            )
            .run();
          if (result.changes !== 2) {
            throw new Error('Internal transfer pair is incomplete; no records were deleted');
          }
          this.orm
            .insert(auditEvents)
            .values({
              id: randomUUID(),
              userId,
              action: 'delete',
              entityType: 'internal-transfer',
              entityId: eventRow.transferId,
              payloadJson: JSON.stringify({ guarded: true, deletedPair: true }),
              createdAt: timestamp,
            })
            .run();
          return;
        }
        if (eventRow?.incomePlanId) {
          const dependent = this.orm
            .select({ id: forecastEvents.id })
            .from(forecastEvents)
            .where(
              and(
                eq(forecastEvents.userId, userId),
                eq(forecastEvents.parentIncomePlanId, eventRow.incomePlanId),
              ),
            )
            .get();
          if (dependent) {
            throw new Error('Delete linked raise plans before deleting their base income plan');
          }
          const group = this.orm
            .select({ id: forecastEvents.id })
            .from(forecastEvents)
            .where(
              and(
                eq(forecastEvents.userId, userId),
                eq(forecastEvents.incomePlanId, eventRow.incomePlanId),
              ),
            )
            .all();
          const result = this.orm
            .delete(forecastEvents)
            .where(
              and(
                eq(forecastEvents.userId, userId),
                eq(forecastEvents.incomePlanId, eventRow.incomePlanId),
              ),
            )
            .run();
          if (result.changes !== group.length || group.length === 0) {
            throw new Error('Income plan is incomplete; no allocations were deleted');
          }
          this.orm
            .insert(auditEvents)
            .values({
              id: randomUUID(),
              userId,
              action: 'delete',
              entityType: 'income-plan',
              entityId: eventRow.incomePlanId,
              payloadJson: JSON.stringify({ guarded: true, deletedAllocations: group.length }),
              createdAt: timestamp,
            })
            .run();
          for (const item of group) {
            this.orm
              .update(importLineage)
              .set({ destinationEditedAt: timestamp })
              .where(
                and(
                  eq(importLineage.userId, userId),
                  eq(importLineage.entityType, 'forecast-event'),
                  eq(importLineage.entityId, item.id),
                ),
              )
              .run();
          }
          return;
        }
      }
      this.assertNoManagedDeleteDependents(userId, entityType, entityId);
      if (entityType === 'forecast-event') {
        const eventRow = this.orm
          .select()
          .from(forecastEvents)
          .where(and(eq(forecastEvents.id, entityId), eq(forecastEvents.userId, userId)))
          .get();
        if (!eventRow) throw new Error('Record not found');
        this.reconcileStaticReceivableSettlementMutation(
          userId,
          deserializeForecastEvent(eventRow),
          undefined,
          timestamp,
        );
      }
      const result = this.orm
        .delete(table as never)
        .where(
          and(
            eq((table as typeof assets).id, entityId),
            eq((table as typeof assets).userId, userId),
          ),
        )
        .run();
      if (result.changes !== 1) throw new Error('Record not found');
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'delete',
          entityType,
          entityId,
          payloadJson: JSON.stringify({ guarded: true }),
          createdAt: timestamp,
        })
        .run();
    })();
  }

  exportUserData(userId: string): UserDataExport {
    const records = this.getManagedRecords(userId);
    return {
      format: 'balance-book-user-data',
      version: 1,
      exportedAt: now(),
      ...records,
      policy: this.getForecastData(userId)?.policy,
    };
  }

  exportPortableProfile(userId: string, sourceAppVersion: string): PortableProfileBackup {
    const profile = this.getCredentialsById(userId);
    if (!profile) throw new Error('Unknown user');
    const records = this.getManagedRecords(userId);
    const rawAuditEvents = this.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.userId, userId))
      .orderBy(asc(auditEvents.createdAt))
      .all();
    const rawImportBatches = this.orm
      .select()
      .from(importBatches)
      .where(eq(importBatches.userId, userId))
      .orderBy(asc(importBatches.createdAt))
      .all();
    const rawImportLineage = this.orm
      .select()
      .from(importLineage)
      .where(eq(importLineage.userId, userId))
      .orderBy(asc(importLineage.createdAt))
      .all();
    const recordTimestamps = this.raw
      .prepare(
        `SELECT 'cash-account' AS entityType, id AS entityId, created_at AS createdAt, updated_at AS updatedAt FROM cash_accounts WHERE user_id = ?
         UNION ALL SELECT 'forecast-event', id, created_at, updated_at FROM forecast_events WHERE user_id = ?
         UNION ALL SELECT 'credit-card', id, created_at, updated_at FROM credit_cards WHERE user_id = ?
         UNION ALL SELECT 'card-cycle', id, created_at, updated_at FROM credit_card_cycles WHERE user_id = ?
         UNION ALL SELECT 'loan', id, created_at, updated_at FROM loans WHERE user_id = ?
         UNION ALL SELECT 'receivable', id, created_at, updated_at FROM receivables WHERE user_id = ?
         UNION ALL SELECT 'asset', id, created_at, updated_at FROM assets WHERE user_id = ?
         UNION ALL SELECT 'reward-program', id, created_at, updated_at FROM reward_programs WHERE user_id = ?
         UNION ALL SELECT 'reconciliation', id, created_at, updated_at FROM reconciliations WHERE user_id = ?
         UNION ALL SELECT 'saved-scenario', id, created_at, updated_at FROM saved_scenarios WHERE user_id = ?
         UNION ALL SELECT 'committed-refinance-plan', id, created_at, updated_at FROM committed_refinance_plans WHERE user_id = ?`,
      )
      .all(
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
      ) as PortableRecordTimestamp[];
    const policyRow = this.orm
      .select({ updatedAt: cashFloorPolicies.updatedAt })
      .from(cashFloorPolicies)
      .where(eq(cashFloorPolicies.userId, userId))
      .get();
    return {
      format: 'balance-book-portable-profile',
      version: 3,
      exportedAt: now(),
      sourceAppVersion,
      sourceSchemaVersion: latestSchemaVersion,
      sourceProfile: {
        id: profile.id,
        displayName: profile.displayName,
        username: profile.username,
        themePreference: profile.themePreference,
        preferences: profile.preferences,
        onboardingComplete: profile.onboardingComplete,
      },
      onboardingDraft: this.getOnboardingDraft(userId),
      ...records,
      policy: this.getForecastData(userId)?.policy,
      auditEvents: rawAuditEvents.map((event) => ({
        sourceId: event.id,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        payloadJson: event.payloadJson,
        createdAt: event.createdAt,
      })),
      importBatches: rawImportBatches.map((batch) => ({
        sourceId: batch.id,
        workbookChecksum: batch.workbookChecksum,
        sourceFileName: batch.sourceFileName,
        status: batch.status,
        createdAt: batch.createdAt,
        rolledBackAt: batch.rolledBackAt,
      })),
      importLineage: rawImportLineage.map((field) => ({
        sourceId: field.id,
        sourceBatchId: field.batchId,
        entityType: field.entityType,
        entityId: field.entityId,
        field: field.field,
        sourceSheet: field.sourceSheet,
        sourceRange: field.sourceRange,
        rawValueJson: field.rawValueJson,
        parsedValueJson: field.parsedValueJson,
        transformation: field.transformation,
        confidence: field.confidence,
        warning: field.warning,
        sourceChecksum: field.sourceChecksum,
        destinationValueJson: field.destinationValueJson,
        destinationEditedAt: field.destinationEditedAt,
        createdAt: field.createdAt,
      })),
      recordTimestamps,
      policyUpdatedAt: policyRow?.updatedAt ?? null,
    };
  }

  getImportReview(userId: string): ImportReview {
    const batches = this.raw
      .prepare(
        'SELECT id, source_file_name AS sourceFileName, workbook_checksum AS workbookChecksum, status, created_at AS createdAt FROM import_batches WHERE user_id = ? ORDER BY created_at DESC',
      )
      .all(userId) as ImportReview['batches'];
    const fields = this.raw
      .prepare(
        `SELECT entity_type AS entityType, entity_id AS entityId, field,
        source_sheet AS sourceSheet, source_range AS sourceRange, transformation,
        confidence, warning, destination_value_json AS importedValueJson,
        created_at AS importedAt, destination_edited_at IS NOT NULL AS destinationEdited
        FROM import_lineage WHERE user_id = ? ORDER BY source_sheet, source_range, entity_type, field`,
      )
      .all(userId) as Array<
      Omit<
        ImportReview['fields'][number],
        | 'destinationEdited'
        | 'currentValueJson'
        | 'lastModifiedAt'
        | 'forecastImpact'
        | 'relatedRecordIds'
      > & { destinationEdited: number }
    >;
    const records = this.getManagedRecords(userId);
    const recordsByKey = new Map<string, Record<string, unknown>>();
    const addRecords = (entityType: ManagedEntityType, values: object[]): void => {
      for (const value of values) {
        const record = value as Record<string, unknown>;
        recordsByKey.set(`${entityType}:${String(record.id)}`, record);
      }
    };
    addRecords('cash-account', records.accounts);
    addRecords('forecast-event', records.events);
    addRecords('credit-card', records.cards);
    addRecords('card-cycle', records.cardCycles);
    addRecords('loan', records.loans);
    addRecords('receivable', records.receivables);
    addRecords('asset', records.assets);
    addRecords('reward-program', records.rewardPrograms);
    addRecords('reconciliation', records.reconciliations);
    addRecords('saved-scenario', records.savedScenarios);
    const modifiedAtByKey = new Map<string, string | null>();
    const forecastImpactByType: Record<string, string> = {
      'cash-account': 'Changes a cash starting point, account funding, or liquidity guardrail.',
      'forecast-event': 'Changes dated cash flow and may change account or consolidated lows.',
      'credit-card': 'Changes card payment timing, policy, or future statement estimates.',
      'card-cycle': 'Changes a statement obligation, current spending, or future card payment.',
      loan: 'Changes contractual debt, interest, and scheduled cash payments.',
      receivable: 'Changes money owed, expected receipts, or total financial position.',
      asset: 'Changes contractual or economic net worth; liquidity only when explicitly enabled.',
      'reward-program': 'Changes informational rewards or a dated reward treatment.',
      reconciliation: 'Records actual-versus-forecast evidence without rewriting history.',
      'saved-scenario': 'Changes a saved hypothetical comparison, not the base forecast.',
    };
    return {
      batches,
      fields: fields.map((field) => ({
        ...field,
        destinationEdited: Boolean(field.destinationEdited),
        currentValueJson: (() => {
          const record = recordsByKey.get(`${field.entityType}:${field.entityId}`);
          return JSON.stringify(record?.[field.field] ?? null);
        })(),
        lastModifiedAt: (() => {
          const key = `${field.entityType}:${field.entityId}`;
          if (modifiedAtByKey.has(key)) return modifiedAtByKey.get(key) ?? null;
          let modifiedAt: string | null = null;
          if (
            field.entityType in
            {
              'cash-account': true,
              'forecast-event': true,
              'credit-card': true,
              'card-cycle': true,
              loan: true,
              receivable: true,
              asset: true,
              'reward-program': true,
              reconciliation: true,
              'saved-scenario': true,
            }
          ) {
            const tableName = this.managedTableName(field.entityType as ManagedEntityType);
            const row = this.raw
              .prepare(
                `SELECT updated_at AS updatedAt FROM ${tableName} WHERE id = ? AND user_id = ?`,
              )
              .get(field.entityId, userId) as { updatedAt?: string } | undefined;
            modifiedAt = row?.updatedAt ?? null;
          }
          modifiedAtByKey.set(key, modifiedAt);
          return modifiedAt;
        })(),
        forecastImpact:
          forecastImpactByType[field.entityType] ?? 'Retained for source and calculation lineage.',
        relatedRecordIds: (() => {
          const record = recordsByKey.get(`${field.entityType}:${field.entityId}`);
          if (!record) return [];
          const ids = [
            record.accountId,
            record.fundingAccountId,
            record.cardId,
            record.destinationAccountId,
            record.relatedExpenseId,
            record.settlementAnchorEventId,
            record.linkedLiabilityId,
            record.sourceRecordId,
          ].filter((value): value is string => typeof value === 'string' && value.length > 0);
          if (
            typeof record.paymentInstrument === 'string' &&
            record.paymentInstrument.includes(':')
          ) {
            ids.push(record.paymentInstrument.slice(record.paymentInstrument.indexOf(':') + 1));
          }
          return [...new Set(ids)].filter((id) => id !== field.entityId);
        })(),
      })),
    };
  }

  private prepareRestoredRecords(
    userId: string,
    data: ManagedRecords,
    restoredAsOfDate: PlainDateString,
  ): ManagedRecords {
    if (data.assets.length > maximumProfileAssetRecords) {
      throw new Error(
        `A portable profile cannot contain more than ${maximumProfileAssetRecords.toLocaleString()} assets`,
      );
    }
    const records: ManagedRecords = {
      accounts: data.accounts.map((entity) =>
        cashAccountSchema.parse({ ...(entity as object), userId }),
      ),
      events: data.events.map((entity) =>
        forecastEventSchema.parse({ ...(entity as object), userId }),
      ),
      policy: data.policy ? cashFloorPolicySchema.parse(data.policy) : undefined,
      cards: data.cards.map((entity) => creditCardSchema.parse({ ...(entity as object), userId })),
      cardCycles: data.cardCycles.map((entity) => creditCardCycleSchema.parse(entity)),
      loans: data.loans.map((entity) => loanSchema.parse({ ...(entity as object), userId })),
      committedRefinancePlans: (data.committedRefinancePlans ?? []).map((entity) => {
        const plan = entity as CommittedRefinancePlan;
        if (!plan.replacementLoanSnapshot) {
          throw new Error(
            'A restored refinance plan is missing its immutable replacement-loan offer snapshot',
          );
        }
        if (!Object.hasOwn(entity as object, 'assetRelinks')) {
          throw new Error('A restored refinance plan is missing its durable asset-relink history');
        }
        return committedRefinancePlanSchema.parse({
          ...(entity as object),
          userId,
          replacementLoan: {
            ...(plan.replacementLoan as object),
            userId,
          },
          replacementLoanSnapshot: {
            ...(plan.replacementLoanSnapshot as object),
            userId,
          },
        });
      }),
      receivables: data.receivables.map((entity) =>
        receivableSchema.parse({ ...(entity as object), userId }),
      ),
      assets: data.assets.map((entity) => assetSchema.parse({ ...(entity as object), userId })),
      rewardPrograms: data.rewardPrograms.map((entity) =>
        rewardProgramSchema.parse({ ...(entity as object), userId }),
      ),
      reconciliations: data.reconciliations.map((entity) =>
        reconciliationSchema.parse({ ...(entity as object), userId }),
      ),
      savedScenarios: data.savedScenarios.map((entity) =>
        savedScenarioSchema.parse({ ...(entity as object), userId }),
      ),
    };
    assertValidIncomePlanGroups(records.events);
    if (records.accounts.length > 0 && !records.policy) {
      throw new Error('A portable profile with cash accounts must include forecast guardrails');
    }

    const uniqueIds = (label: string, ids: string[]): Set<string> => {
      const values = new Set(ids);
      if (values.size !== ids.length)
        throw new Error(`Portable profile has duplicate ${label} IDs`);
      return values;
    };
    const accountIds = uniqueIds(
      'cash account',
      records.accounts.map((item) => item.id),
    );
    const eventIds = uniqueIds(
      'forecast event',
      records.events.map((item) => item.id),
    );
    const incomePlanIds = new Set(
      records.events
        .map((item) => item.incomePlanId)
        .filter((value): value is string => value !== undefined),
    );
    const incomePlanEvents = new Map<string, ForecastEvent[]>();
    for (const event of records.events) {
      if (!event.incomePlanId) continue;
      incomePlanEvents.set(event.incomePlanId, [
        ...(incomePlanEvents.get(event.incomePlanId) ?? []),
        event,
      ]);
    }
    const cardIds = uniqueIds(
      'credit card',
      records.cards.map((item) => item.id),
    );
    uniqueIds(
      'card cycle',
      records.cardCycles.map((item) => item.id),
    );
    const loanIds = uniqueIds(
      'loan',
      records.loans.map((item) => item.id),
    );
    const refinancePlanIds = uniqueIds(
      'committed refinance plan',
      records.committedRefinancePlans.map((item) => item.id),
    );
    const receivableIds = uniqueIds(
      'receivable',
      records.receivables.map((item) => item.id),
    );
    const assetIds = uniqueIds(
      'asset',
      records.assets.map((item) => item.id),
    );
    uniqueIds(
      'reward program',
      records.rewardPrograms.map((item) => item.id),
    );
    uniqueIds(
      'reconciliation',
      records.reconciliations.map((item) => item.id),
    );
    uniqueIds(
      'saved scenario',
      records.savedScenarios.map((item) => item.id),
    );
    const requireReference = (ids: Set<string>, id: string, label: string): void => {
      if (!ids.has(id)) throw new Error(`Portable profile has an unavailable ${label} reference`);
    };

    for (const card of records.cards)
      requireReference(accountIds, card.fundingAccountId, 'card funding account');
    for (const cycle of records.cardCycles) {
      requireReference(cardIds, cycle.cardId, 'card cycle');
      if (cycle.actualPaymentAccountId) {
        requireReference(accountIds, cycle.actualPaymentAccountId, 'recorded card payment account');
      }
    }
    for (const loan of records.loans)
      requireReference(accountIds, loan.fundingAccountId, 'loan funding account');
    const committedPayoffLoanIds = new Set<string>();
    const committedReplacementLoanIds = new Set<string>();
    for (const plan of records.committedRefinancePlans) {
      requireReference(loanIds, plan.replacementLoan.id, 'replacement loan');
      const linkedReplacementLoan = records.loans.find(
        (loan) => loan.id === plan.replacementLoan.id,
      );
      if (JSON.stringify(linkedReplacementLoan) !== JSON.stringify(plan.replacementLoan)) {
        throw new Error(
          'Portable profile has replacement loan terms that do not match its loan record',
        );
      }
      if (plan.status === 'committed') {
        committedReplacementLoanIds.add(plan.replacementLoan.id);
      }
      if (plan.cashSourceAccountId)
        requireReference(accountIds, plan.cashSourceAccountId, 'refinance cash source account');
      if (plan.excessProceedsAccountId)
        requireReference(
          accountIds,
          plan.excessProceedsAccountId,
          'refinance excess proceeds account',
        );
      for (const relink of plan.assetRelinks ?? []) {
        requireReference(assetIds, relink.assetId, 'refinance relink asset');
        requireReference(loanIds, relink.sourceLoanId, 'refinance relink source loan');
        if (relink.replacementLoanId !== plan.replacementLoan.id) {
          throw new Error('Portable profile has inconsistent refinance asset relink history');
        }
      }
      for (const payoff of plan.payoffs) {
        requireReference(loanIds, payoff.sourceLoanId, 'refinance payoff loan');
        if (plan.status === 'committed') {
          if (committedPayoffLoanIds.has(payoff.sourceLoanId)) {
            throw new Error(
              'Portable profile assigns one payoff loan to multiple committed refinance plans',
            );
          }
          committedPayoffLoanIds.add(payoff.sourceLoanId);
        }
        if (!payoff.sourceRefinancePlanId) continue;
        requireReference(refinancePlanIds, payoff.sourceRefinancePlanId, 'source refinance plan');
        const sourcePlan = records.committedRefinancePlans.find(
          (candidate) => candidate.id === payoff.sourceRefinancePlanId,
        )!;
        if (
          sourcePlan.replacementLoan.id !== payoff.sourceLoanId ||
          compareDates(plan.closingDate, sourcePlan.payoffDate) <= 0 ||
          (plan.status === 'committed' && sourcePlan.status !== 'committed')
        ) {
          throw new Error('Portable profile has inconsistent stacked refinance lineage');
        }
      }
    }
    const refinanceManagedLoanIds = new Set([
      ...committedPayoffLoanIds,
      ...committedReplacementLoanIds,
    ]);
    for (const loan of records.loans) {
      if (
        refinanceManagedLoanIds.has(loan.id) &&
        ((loan.status ?? 'active') !== 'active' || loan.includeInCashForecast === false)
      ) {
        throw new Error(
          'Portable profile disables a loan whose lifecycle is managed by a committed refinance',
        );
      }
    }
    const futureCommittedReplacementLoanIds = new Set(
      records.committedRefinancePlans
        .filter(
          (plan) =>
            plan.status === 'committed' && compareDates(plan.closingDate, restoredAsOfDate) > 0,
        )
        .map((plan) => plan.replacementLoan.id),
    );
    const expectedCommittedAssetLinkById = new Map<string, string>();
    for (const plan of [...records.committedRefinancePlans]
      .filter((candidate) => candidate.status === 'committed')
      .sort(
        (left, right) =>
          compareDates(left.closingDate, right.closingDate) || left.id.localeCompare(right.id),
      )) {
      for (const relink of plan.assetRelinks ?? []) {
        const priorReplacement = expectedCommittedAssetLinkById.get(relink.assetId);
        if (
          futureCommittedReplacementLoanIds.has(relink.sourceLoanId) &&
          priorReplacement !== relink.sourceLoanId
        ) {
          throw new Error(
            'Portable profile is missing earlier future refinance asset-relink history',
          );
        }
        if (priorReplacement && priorReplacement !== relink.sourceLoanId) {
          throw new Error(
            'Portable profile has discontinuous committed refinance asset-relink history',
          );
        }
        expectedCommittedAssetLinkById.set(relink.assetId, relink.replacementLoanId);
      }
    }
    const futureRelinkAssetIdsByReplacement = new Map(
      records.committedRefinancePlans
        .filter(
          (plan) =>
            plan.status === 'committed' && compareDates(plan.closingDate, restoredAsOfDate) > 0,
        )
        .map(
          (plan) =>
            [
              plan.replacementLoan.id,
              new Set((plan.assetRelinks ?? []).map((relink) => relink.assetId)),
            ] as const,
        ),
    );
    for (const event of records.events) {
      requireReference(accountIds, event.accountId, 'event account');
      if (event.cardId) requireReference(cardIds, event.cardId, 'event card');
      if (event.paymentMethod === 'credit-card' && !event.cardId) {
        throw new Error('Portable profile has card-funded activity without a card');
      }
      if (
        event.kind === 'card-payment' &&
        (!event.cardId || event.paymentMethod !== 'cash-account' || event.direction !== 'outflow')
      ) {
        throw new Error('Portable profile has an invalid card payment link');
      }
      if (event.parentIncomeEventId) {
        requireReference(eventIds, event.parentIncomeEventId, 'parent income');
        const parent = records.events.find(
          (candidate) => candidate.id === event.parentIncomeEventId,
        );
        if (
          event.incomeType !== 'raise-adjustment' ||
          parent?.kind !== 'income' ||
          parent.direction !== 'inflow' ||
          parent.incomeType === 'raise-adjustment' ||
          !parent.recurrenceRule ||
          parent.recurrenceRule.frequency === 'once' ||
          !isRecurrenceOccurrence(parent.date, event.date, parent.recurrenceRule) ||
          JSON.stringify(event.recurrenceRule ?? null) !== JSON.stringify(parent.recurrenceRule) ||
          (event.recurrenceEndDate ?? null) !== (parent.recurrenceEndDate ?? null)
        ) {
          throw new Error('Portable profile has an invalid linked raise');
        }
      }
      if (event.parentIncomePlanId) {
        requireReference(incomePlanIds, event.parentIncomePlanId, 'parent income plan');
        const parentEvents = incomePlanEvents.get(event.parentIncomePlanId) ?? [];
        const parent = parentEvents[0];
        const destination = parentEvents.find(
          (candidate) => candidate.accountId === event.accountId,
        );
        const expectedOffset =
          destination?.incomeArrivalOffsetDays ?? event.incomeArrivalOffsetDays;
        if (
          event.incomeType !== 'raise-adjustment' ||
          !parent ||
          parent.incomeType === 'raise-adjustment' ||
          !parent.incomeNominalDate ||
          !parent.recurrenceRule ||
          parent.recurrenceRule.frequency === 'once' ||
          !event.incomeNominalDate ||
          !isRecurrenceOccurrence(
            parent.incomeNominalDate,
            event.incomeNominalDate,
            parent.recurrenceRule,
          ) ||
          JSON.stringify(event.recurrenceRule ?? null) !== JSON.stringify(parent.recurrenceRule) ||
          (event.recurrenceEndDate ?? null) !== (parent.recurrenceEndDate ?? null) ||
          event.incomeArrivalOffsetDays !== expectedOffset
        ) {
          throw new Error('Portable profile has an invalid linked raise plan');
        }
      }
    }
    for (const receivable of records.receivables) {
      requireReference(accountIds, receivable.destinationAccountId, 'receivable destination');
      if (receivable.settlementAnchorEventId) {
        requireReference(eventIds, receivable.settlementAnchorEventId, 'receivable anchor bill');
        const anchor = records.events.find(
          (event) => event.id === receivable.settlementAnchorEventId,
        )!;
        this.validateReceivableSettlementAnchor(receivable, anchor);
      }
      if (receivable.relatedExpenseId)
        requireReference(eventIds, receivable.relatedExpenseId, 'related expense');
      if (receivable.paymentInstrument) {
        const [kind, id] = receivable.paymentInstrument.split(':', 2);
        if (kind === 'cash-account' && id)
          requireReference(accountIds, id, 'receivable payment account');
        if (kind === 'credit-card' && id) requireReference(cardIds, id, 'receivable payment card');
      }
    }
    const receivableById = new Map(
      records.receivables.map((receivable) => [receivable.id, receivable]),
    );
    const restoredSettlementGroups = new Map<
      string,
      {
        receivable: Receivable;
        targetCents?: number;
        appliedCents: number;
        storedOccurrences: Set<PlainDateString>;
      }
    >();
    for (const event of records.events.filter(
      (candidate) => candidate.kind === 'receivable-settlement',
    )) {
      const receivable = receivableForSettlementSourceFromIndex(
        receivableById,
        event.sourceRecordId,
      );
      if (!receivable) {
        throw new Error('Portable profile has an unavailable receivable settlement');
      }
      if (
        event.direction !== 'inflow' ||
        (event.paymentMethod ?? 'cash-account') !== 'cash-account' ||
        event.recurrenceRule
      ) {
        throw new Error('Portable profile has an invalid receivable cash receipt');
      }
      const noteOccurrence = parseReceivableOccurrenceNote(event.notes);
      if (
        event.notes
          ?.split(/\r?\n/u)
          .some((line) => line.startsWith('balance-book:receivable-occurrence=')) &&
        noteOccurrence === undefined
      ) {
        throw new Error('Portable profile has a malformed receivable occurrence note');
      }
      const sourceOccurrence = receivableSettlementSourceOccurrenceDate(
        receivable.id,
        event.sourceRecordId,
      );
      const suppliedOccurrences = new Set(
        [event.receivableOccurrenceDate, noteOccurrence, sourceOccurrence].filter(
          (value): value is PlainDateString => value !== undefined,
        ),
      );
      if (suppliedOccurrences.size > 1) {
        throw new Error('Portable profile has conflicting receivable occurrence identities');
      }
      const repeating = hasRecurringReceivableSchedule(receivable);
      const occurrenceDate = repeating
        ? resolveRecordedReceivableOccurrenceDate({
            receivable,
            events: records.events,
            settlementEvent: event,
          })
        : receivable.expectedDate;
      const staticOpeningOccurrence =
        !repeating ||
        (occurrenceDate === receivable.expectedDate && receivable.originalAmountCents > 0);
      if (staticOpeningOccurrence && event.receivableOccurrenceTargetCents !== undefined) {
        throw new Error('Portable profile puts a recurring target on a static receivable balance');
      }
      const inactive = event.status === 'cancelled' || event.status === 'skipped';
      if (!inactive && event.status !== 'confirmed' && event.status !== 'paid') {
        throw new Error(
          'Portable profile has a receivable receipt that is not recorded or inactive',
        );
      }
      if (
        !inactive &&
        (event.amountCents <= 0 ||
          event.certainty !== 'confirmed' ||
          event.includeInConservative === false ||
          event.hypothetical)
      ) {
        throw new Error('Portable profile has an unconfirmed receivable cash receipt');
      }
      if (staticOpeningOccurrence) continue;
      const groupKey = `${receivable.id}\u0000${occurrenceDate}`;
      const group = restoredSettlementGroups.get(groupKey) ?? {
        receivable,
        appliedCents: 0,
        storedOccurrences: new Set<PlainDateString>(),
      };
      group.storedOccurrences.add([...suppliedOccurrences][0] ?? occurrenceDate);
      if (group.storedOccurrences.size > 1) {
        throw new Error(
          'Portable profile collapses distinct receivable occurrences onto one current installment',
        );
      }
      if (
        event.receivableOccurrenceTargetCents !== undefined &&
        group.targetCents !== undefined &&
        group.targetCents !== event.receivableOccurrenceTargetCents
      ) {
        throw new Error('Portable profile has conflicting receivable occurrence targets');
      }
      if (event.receivableOccurrenceTargetCents !== undefined) {
        group.targetCents = event.receivableOccurrenceTargetCents;
      }
      if (!inactive) group.appliedCents += event.amountCents;
      restoredSettlementGroups.set(groupKey, group);
    }
    for (const group of restoredSettlementGroups.values()) {
      if (group.targetCents !== undefined && group.appliedCents > group.targetCents) {
        throw new Error('Portable profile over-settles a receivable occurrence');
      }
    }
    for (const asset of records.assets) {
      if (asset.linkedLiabilityId) {
        requireReference(loanIds, asset.linkedLiabilityId, 'linked liability');
      }
      if (asset.linkedLiabilityId && committedPayoffLoanIds.has(asset.linkedLiabilityId)) {
        throw new Error(
          'Portable profile has an asset linked to a loan retired by a committed refinance',
        );
      }
      const futureRelinkAssetIds = asset.linkedLiabilityId
        ? futureRelinkAssetIdsByReplacement.get(asset.linkedLiabilityId)
        : undefined;
      if (futureRelinkAssetIds && !futureRelinkAssetIds.has(asset.id)) {
        throw new Error(
          'Portable profile links an asset to a future refinance replacement without durable relink history',
        );
      }
      const expectedCommittedLink = expectedCommittedAssetLinkById.get(asset.id);
      if (expectedCommittedLink && asset.linkedLiabilityId !== expectedCommittedLink) {
        throw new Error(
          'Portable profile has an asset link that does not match committed refinance history',
        );
      }
    }
    for (const reward of records.rewardPrograms)
      requireReference(cardIds, reward.cardId, 'reward card');
    for (const reconciliation of records.reconciliations)
      requireReference(accountIds, reconciliation.accountId, 'reconciliation account');
    for (const scenario of records.savedScenarios) {
      requireReference(accountIds, scenario.accountId, 'scenario account');
      if (scenario.fundingType === 'card') {
        requireReference(cardIds, scenario.cardId!, 'scenario card');
        const card = records.cards.find((candidate) => candidate.id === scenario.cardId);
        if (card?.fundingAccountId !== scenario.accountId) {
          throw new Error("Portable profile has a scenario that does not use its card's account");
        }
      }
    }

    const transferGroups = new Map<string, ForecastEvent[]>();
    for (const event of records.events) {
      const transferRole = event.kind === 'transfer-debit' || event.kind === 'transfer-credit';
      if (transferRole && !event.transferId)
        throw new Error('Portable profile has an unpaired transfer event');
      if (!event.transferId) continue;
      const group = transferGroups.get(event.transferId) ?? [];
      group.push(event);
      transferGroups.set(event.transferId, group);
    }
    for (const group of transferGroups.values()) {
      const debit = group.find((event) => event.kind === 'transfer-debit');
      const credit = group.find((event) => event.kind === 'transfer-credit');
      if (!debit || !credit || group.length !== 2) {
        throw new Error('Portable profile has an incomplete internal transfer pair');
      }
      if (
        debit.direction !== 'outflow' ||
        credit.direction !== 'inflow' ||
        debit.amountCents !== credit.amountCents ||
        debit.accountId === credit.accountId ||
        compareDates(credit.date, debit.date) < 0
      ) {
        throw new Error('Portable profile has an inconsistent internal transfer pair');
      }
      const source = records.accounts.find((account) => account.id === debit.accountId)!;
      if (daysBetween(debit.date, credit.date) < source.transferDelayDays) {
        throw new Error('Portable profile has a transfer shorter than its configured lead time');
      }
    }

    const tableEntries: Array<[ManagedEntityType, string[]]> = [
      ['cash-account', [...accountIds]],
      ['forecast-event', [...eventIds]],
      ['credit-card', [...cardIds]],
      ['card-cycle', records.cardCycles.map((item) => item.id)],
      ['loan', [...loanIds]],
      ['receivable', [...receivableIds]],
      ['asset', records.assets.map((item) => item.id)],
      ['reward-program', records.rewardPrograms.map((item) => item.id)],
      ['reconciliation', records.reconciliations.map((item) => item.id)],
      ['saved-scenario', records.savedScenarios.map((item) => item.id)],
    ];
    for (const [entityType, ids] of tableEntries) {
      const tableName = this.managedTableName(entityType);
      for (const id of ids) {
        const existing = this.raw
          .prepare(`SELECT user_id AS userId FROM ${tableName} WHERE id = ?`)
          .get(id) as { userId: string } | undefined;
        if (existing && existing.userId !== userId) {
          throw new Error(
            'A record ID in this backup already belongs to another local profile; restore on a fresh installation or the original profile',
          );
        }
      }
    }
    for (const id of refinancePlanIds) {
      const existing = this.raw
        .prepare('SELECT user_id AS userId FROM committed_refinance_plans WHERE id = ?')
        .get(id) as { userId: string } | undefined;
      if (existing && existing.userId !== userId) {
        throw new Error(
          'A refinance plan ID in this backup already belongs to another local profile',
        );
      }
    }
    resolveCommittedRefinances({
      accounts: records.accounts,
      loans: records.loans,
      plans: records.committedRefinancePlans,
    });
    return records;
  }

  private deleteRestoredData(userId: string): void {
    this.orm.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userId)).run();
    this.orm.delete(importLineage).where(eq(importLineage.userId, userId)).run();
    this.orm.delete(importBatches).where(eq(importBatches.userId, userId)).run();
    this.orm.delete(creditCardCycles).where(eq(creditCardCycles.userId, userId)).run();
    this.orm.delete(rewardPrograms).where(eq(rewardPrograms.userId, userId)).run();
    this.orm.delete(reconciliations).where(eq(reconciliations.userId, userId)).run();
    this.orm.delete(savedScenarios).where(eq(savedScenarios.userId, userId)).run();
    this.orm.delete(assets).where(eq(assets.userId, userId)).run();
    this.orm
      .delete(committedRefinancePayoffs)
      .where(eq(committedRefinancePayoffs.userId, userId))
      .run();
    this.orm
      .delete(committedRefinancePlans)
      .where(eq(committedRefinancePlans.userId, userId))
      .run();
    this.orm.delete(loans).where(eq(loans.userId, userId)).run();
    this.orm.delete(receivables).where(eq(receivables.userId, userId)).run();
    this.orm.delete(forecastEvents).where(eq(forecastEvents.userId, userId)).run();
    this.orm.delete(creditCards).where(eq(creditCards.userId, userId)).run();
    this.orm.delete(cashAccounts).where(eq(cashAccounts.userId, userId)).run();
    this.orm.delete(cashFloorPolicies).where(eq(cashFloorPolicies.userId, userId)).run();
  }

  private insertRestoredRecords(
    userId: string,
    records: ManagedRecords,
    fallbackTimestamp: string,
    portable?: Pick<PortableProfileBackup, 'recordTimestamps' | 'policyUpdatedAt'>,
  ): void {
    const timestamps = new Map(
      (portable?.recordTimestamps ?? []).map((item) => [
        `${item.entityType}:${item.entityId}`,
        { createdAt: item.createdAt, updatedAt: item.updatedAt },
      ]),
    );
    const timeFor = (
      entityType: ManagedEntityType | 'committed-refinance-plan',
      entityId: string,
    ) =>
      timestamps.get(`${entityType}:${entityId}`) ?? {
        createdAt: fallbackTimestamp,
        updatedAt: fallbackTimestamp,
      };
    if (records.policy) {
      this.orm
        .insert(cashFloorPolicies)
        .values({
          userId,
          ...serializeCashFloorPolicy(records.policy),
          updatedAt: portable?.policyUpdatedAt ?? fallbackTimestamp,
        })
        .run();
    }
    for (const entity of records.accounts)
      this.orm
        .insert(cashAccounts)
        .values({ ...serializeCashAccount(entity), ...timeFor('cash-account', entity.id) })
        .run();
    for (const entity of records.cards)
      this.orm
        .insert(creditCards)
        .values({ ...serializeCreditCard(entity), ...timeFor('credit-card', entity.id) })
        .run();
    for (const entity of records.cardCycles)
      this.orm
        .insert(creditCardCycles)
        .values({
          userId,
          ...serializeCreditCardCycle(entity),
          ...timeFor('card-cycle', entity.id),
        })
        .run();
    for (const entity of records.loans)
      this.orm
        .insert(loans)
        .values({ ...serializeLoan(entity), ...timeFor('loan', entity.id) })
        .run();
    for (const entity of records.committedRefinancePlans) {
      const planTime = timeFor('committed-refinance-plan', entity.id);
      this.orm
        .insert(committedRefinancePlans)
        .values({
          ...serializeCommittedRefinancePlan(entity),
          cancelledAt: entity.status === 'cancelled' ? planTime.updatedAt : null,
          ...planTime,
        })
        .run();
      for (const payoff of entity.payoffs) {
        this.orm
          .insert(committedRefinancePayoffs)
          .values({
            id: randomUUID(),
            userId,
            planId: entity.id,
            sourceLoanId: payoff.sourceLoanId,
            payoffAmountCents: payoff.payoffAmountCents,
            sourceRefinancePlanId: payoff.sourceRefinancePlanId ?? null,
            createdAt: planTime.createdAt,
          })
          .run();
      }
    }
    for (const entity of records.events)
      this.orm
        .insert(forecastEvents)
        .values({ ...serializeForecastEvent(entity), ...timeFor('forecast-event', entity.id) })
        .run();
    for (const entity of records.receivables)
      this.orm
        .insert(receivables)
        .values({ ...serializeReceivable(entity), ...timeFor('receivable', entity.id) })
        .run();
    for (const entity of records.assets)
      this.orm
        .insert(assets)
        .values({ ...serializeAsset(entity), ...timeFor('asset', entity.id) })
        .run();
    for (const entity of records.rewardPrograms)
      this.orm
        .insert(rewardPrograms)
        .values({ ...serializeRewardProgram(entity), ...timeFor('reward-program', entity.id) })
        .run();
    for (const entity of records.reconciliations)
      this.orm
        .insert(reconciliations)
        .values({
          ...serializeReconciliation(entity),
          ...timeFor('reconciliation', entity.id),
        })
        .run();
    for (const entity of records.savedScenarios)
      this.orm
        .insert(savedScenarios)
        .values({ ...serializeSavedScenario(entity), ...timeFor('saved-scenario', entity.id) })
        .run();
  }

  replaceUserData(userId: string, data: UserDataExport): void {
    if (data.format !== 'balance-book-user-data' || data.version !== 1) {
      throw new Error('Unsupported Balance Book export');
    }
    const records = this.prepareRestoredRecords(
      userId,
      data,
      plainDateSchema.parse(data.exportedAt.slice(0, 10)),
    );
    this.raw.transaction(() => {
      const timestamp = now();
      this.deleteRestoredData(userId);
      this.insertRestoredRecords(userId, records, timestamp);
      this.orm
        .update(profiles)
        .set({ onboardingComplete: records.accounts.length > 0, updatedAt: timestamp })
        .where(eq(profiles.id, userId))
        .run();
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'restore',
          entityType: 'user-data',
          entityId: userId,
          payloadJson: JSON.stringify({ formatVersion: data.version }),
          createdAt: timestamp,
        })
        .run();
    })();
  }

  replacePortableProfile(userId: string, data: PortableProfileBackup): void {
    if (data.format !== 'balance-book-portable-profile' || data.version !== 3) {
      throw new Error('Unsupported Balance Book portable profile');
    }
    if (data.sourceSchemaVersion > latestSchemaVersion) {
      throw new Error('This backup was created by a newer Balance Book data format');
    }
    const userOwnedRecords = [
      ...data.accounts,
      ...data.events,
      ...data.cards,
      ...data.loans,
      ...data.committedRefinancePlans,
      ...data.receivables,
      ...data.assets,
      ...data.rewardPrograms,
      ...data.reconciliations,
      ...data.savedScenarios,
    ];
    if (userOwnedRecords.some((record) => record.userId !== data.sourceProfile.id)) {
      throw new Error('Portable profile contains records owned by a different source profile');
    }
    const records = this.prepareRestoredRecords(
      userId,
      data,
      plainDateSchema.parse(data.exportedAt.slice(0, 10)),
    );
    const recordKeys = new Set<string>([
      ...records.accounts.map((record) => `cash-account:${record.id}`),
      ...records.events.map((record) => `forecast-event:${record.id}`),
      ...records.cards.map((record) => `credit-card:${record.id}`),
      ...records.cardCycles.map((record) => `card-cycle:${record.id}`),
      ...records.loans.map((record) => `loan:${record.id}`),
      ...records.committedRefinancePlans.map((record) => `committed-refinance-plan:${record.id}`),
      ...records.receivables.map((record) => `receivable:${record.id}`),
      ...records.assets.map((record) => `asset:${record.id}`),
      ...records.rewardPrograms.map((record) => `reward-program:${record.id}`),
      ...records.reconciliations.map((record) => `reconciliation:${record.id}`),
      ...records.savedScenarios.map((record) => `saved-scenario:${record.id}`),
    ]);
    const timestampKeys = new Set<string>();
    for (const timestamp of data.recordTimestamps) {
      const key = `${timestamp.entityType}:${timestamp.entityId}`;
      if (timestampKeys.has(key))
        throw new Error('Portable profile has duplicate record timestamps');
      if (!recordKeys.has(key))
        throw new Error('Portable profile has a timestamp for an unavailable record');
      timestampKeys.add(key);
    }
    if (timestampKeys.size !== recordKeys.size) {
      throw new Error('Portable profile is missing record timestamps');
    }
    if ((data.policy === undefined) !== (data.policyUpdatedAt === null)) {
      throw new Error('Portable profile has inconsistent policy timing');
    }
    const batchIds = new Set(data.importBatches.map((batch) => batch.sourceId));
    if (batchIds.size !== data.importBatches.length)
      throw new Error('Portable profile has duplicate import batch IDs');
    const lineageIds = new Set<string>();
    const lineageKeys = new Set<string>();
    for (const field of data.importLineage) {
      if (lineageIds.has(field.sourceId))
        throw new Error('Portable profile has duplicate import lineage IDs');
      lineageIds.add(field.sourceId);
      if (!batchIds.has(field.sourceBatchId))
        throw new Error('Portable profile has lineage without its import batch');
      const lineageKey = [
        field.sourceChecksum,
        field.sourceSheet,
        field.sourceRange,
        field.entityType,
        field.entityId,
        field.field,
      ].join('\u0000');
      if (lineageKeys.has(lineageKey))
        throw new Error('Portable profile has duplicate import lineage fields');
      lineageKeys.add(lineageKey);
    }
    this.raw.transaction(() => {
      const timestamp = now();
      this.deleteRestoredData(userId);
      this.orm.delete(auditEvents).where(eq(auditEvents.userId, userId)).run();
      this.insertRestoredRecords(userId, records, timestamp, data);

      const remappedBatchIds = new Map<string, string>();
      for (const batch of data.importBatches) {
        const id = randomUUID();
        remappedBatchIds.set(batch.sourceId, id);
        this.orm
          .insert(importBatches)
          .values({
            id,
            userId,
            workbookChecksum: batch.workbookChecksum,
            sourceFileName: batch.sourceFileName,
            status: batch.status,
            createdAt: batch.createdAt,
            rolledBackAt: batch.rolledBackAt,
          })
          .run();
      }
      for (const field of data.importLineage) {
        this.orm
          .insert(importLineage)
          .values({
            id: randomUUID(),
            userId,
            batchId: remappedBatchIds.get(field.sourceBatchId)!,
            entityType: field.entityType,
            entityId: field.entityId,
            field: field.field,
            sourceSheet: field.sourceSheet,
            sourceRange: field.sourceRange,
            rawValueJson: field.rawValueJson,
            parsedValueJson: field.parsedValueJson,
            transformation: field.transformation,
            confidence: field.confidence,
            warning: field.warning,
            sourceChecksum: field.sourceChecksum,
            destinationValueJson: field.destinationValueJson,
            destinationEditedAt: field.destinationEditedAt,
            createdAt: field.createdAt,
          })
          .run();
      }
      for (const event of data.auditEvents) {
        this.orm
          .insert(auditEvents)
          .values({
            id: randomUUID(),
            userId,
            action: event.action,
            entityType: event.entityType,
            entityId: event.entityId === data.sourceProfile.id ? userId : event.entityId,
            payloadJson: event.payloadJson,
            createdAt: event.createdAt,
          })
          .run();
      }
      if (data.onboardingDraft) {
        this.orm
          .insert(onboardingDrafts)
          .values({
            userId,
            valuesJson: JSON.stringify(data.onboardingDraft.values),
            updatedAt: data.onboardingDraft.updatedAt,
          })
          .run();
      }
      this.orm
        .update(profiles)
        .set({
          onboardingComplete: data.sourceProfile.onboardingComplete,
          themePreference: data.sourceProfile.themePreference,
          preferencesJson: JSON.stringify(data.sourceProfile.preferences),
          updatedAt: timestamp,
        })
        .where(eq(profiles.id, userId))
        .run();
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'restore',
          entityType: 'portable-profile',
          entityId: userId,
          payloadJson: JSON.stringify({
            formatVersion: data.version,
            sourceAppVersion: data.sourceAppVersion,
            sourceSchemaVersion: data.sourceSchemaVersion,
          }),
          createdAt: timestamp,
        })
        .run();
    })();
  }

  commitRefinancePlan(
    userId: string,
    input: CommittedRefinancePlanInput,
    asOfDate: PlainDateString = localPlainDate(),
  ): CommittedRefinancePlan {
    if (!this.getCredentialsById(userId)) throw new Error('Unknown user');
    const effectiveAsOfDate = plainDateSchema.parse(asOfDate);
    const parsedInput = committedRefinancePlanInputSchema.parse(input);
    const replacementLoan = loanSchema.parse({
      ...parsedInput.replacementLoan,
      userId,
      originalPrincipalCents:
        parsedInput.replacementLoan.originalPrincipalCents ??
        parsedInput.replacementLoan.principalCents,
      originalDate: parsedInput.replacementLoan.originalDate ?? parsedInput.closingDate,
      includeInCashForecast: parsedInput.replacementLoan.includeInCashForecast ?? true,
      status: parsedInput.replacementLoan.status ?? 'active',
    });
    let plan = committedRefinancePlanSchema.parse({
      ...parsedInput,
      userId,
      status: 'committed',
      replacementLoan,
    });
    const existingPlan = this.orm
      .select()
      .from(committedRefinancePlans)
      .where(eq(committedRefinancePlans.id, plan.id))
      .get();
    if (existingPlan) {
      if (existingPlan.userId !== userId) {
        throw new Error('Refinance plan ID belongs to another profile');
      }
      const existingPayoffs = this.orm
        .select()
        .from(committedRefinancePayoffs)
        .where(
          and(
            eq(committedRefinancePayoffs.userId, userId),
            eq(committedRefinancePayoffs.planId, plan.id),
          ),
        )
        .all();
      const historicalLoan = loanSchema.parse(JSON.parse(existingPlan.replacementLoanSnapshotJson));
      const historicalPlan = deserializeCommittedRefinancePlan(
        existingPlan,
        existingPayoffs,
        historicalLoan,
      );
      const retryPayoffs = plan.payoffs.map((payoff) => ({
        ...payoff,
        sourceRefinancePlanId:
          payoff.sourceRefinancePlanId ??
          historicalPlan.payoffs.find((candidate) => candidate.sourceLoanId === payoff.sourceLoanId)
            ?.sourceRefinancePlanId,
      }));
      const retryPlan = committedRefinancePlanSchema.parse({ ...plan, payoffs: retryPayoffs });
      const comparable = (candidate: CommittedRefinancePlan): string =>
        JSON.stringify({
          id: candidate.id,
          userId: candidate.userId,
          name: candidate.name,
          status: candidate.status,
          closingDate: candidate.closingDate,
          payoffDate: candidate.payoffDate,
          firstPaymentDate: candidate.firstPaymentDate,
          payoffs: [...candidate.payoffs].sort((left, right) =>
            left.sourceLoanId.localeCompare(right.sourceLoanId),
          ),
          replacementLoan: candidate.replacementLoanSnapshot ?? candidate.replacementLoan,
          principalCashContributionCents: candidate.principalCashContributionCents,
          closingCostsCents: candidate.closingCostsCents,
          financedFeesCents: candidate.financedFeesCents,
          cashSourceAccountId: candidate.cashSourceAccountId,
          excessProceedsCents: candidate.excessProceedsCents,
          excessProceedsAccountId: candidate.excessProceedsAccountId,
          notes: candidate.notes,
        });
      if (
        existingPlan.status === 'committed' &&
        comparable(historicalPlan) === comparable(retryPlan)
      ) {
        return this.getCommittedRefinancePlans(userId).find(
          (candidate) => candidate.id === plan.id,
        )!;
      }
      throw new Error('This refinance plan ID already exists with different committed terms');
    }
    if (compareDates(plan.closingDate, effectiveAsOfDate) < 0) {
      throw new Error('A refinance commitment cannot close before its effective financial date');
    }
    if (daysBetween(effectiveAsOfDate, plan.closingDate) > 3_650) {
      throw new Error('A refinance commitment must close within the next 10 years');
    }
    const existingReplacement = this.raw
      .prepare('SELECT user_id AS userId FROM loans WHERE id = ?')
      .get(plan.replacementLoan.id) as { userId: string } | undefined;
    if (existingReplacement) {
      throw new Error(
        existingReplacement.userId === userId
          ? 'The replacement loan ID is already in use'
          : 'Replacement loan ID belongs to another profile',
      );
    }

    this.assertOwnedAccount(userId, plan.replacementLoan.fundingAccountId);
    if (plan.cashSourceAccountId) this.assertOwnedAccount(userId, plan.cashSourceAccountId);
    if (plan.excessProceedsAccountId) this.assertOwnedAccount(userId, plan.excessProceedsAccountId);
    const requireEventAfterAccountSnapshot = (
      accountId: string,
      eventDate: PlainDateString,
      role: string,
    ): void => {
      const account = this.orm
        .select({ balanceAsOf: cashAccounts.balanceAsOf })
        .from(cashAccounts)
        .where(and(eq(cashAccounts.id, accountId), eq(cashAccounts.userId, userId)))
        .get();
      if (!account || compareDates(eventDate, account.balanceAsOf) <= 0) {
        throw new Error(`${role} must occur after that account's recorded balance date`);
      }
    };
    requireEventAfterAccountSnapshot(
      plan.replacementLoan.fundingAccountId,
      plan.firstPaymentDate,
      'The first replacement payment',
    );
    const bankOutflowAtClosingCents =
      plan.principalCashContributionCents + plan.closingCostsCents - plan.financedFeesCents;
    if (bankOutflowAtClosingCents > 0 && plan.cashSourceAccountId) {
      requireEventAfterAccountSnapshot(plan.cashSourceAccountId, plan.closingDate, 'Closing cash');
    }
    if (plan.excessProceedsCents > 0 && plan.excessProceedsAccountId) {
      requireEventAfterAccountSnapshot(
        plan.excessProceedsAccountId,
        plan.closingDate,
        'Excess refinance proceeds',
      );
    }

    const loanPaymentEvents = this.getForecastData(userId)?.events ?? [];
    const enrichedPayoffs = plan.payoffs.map((payoff) => {
      const sourceLoanRow = this.orm
        .select()
        .from(loans)
        .where(and(eq(loans.id, payoff.sourceLoanId), eq(loans.userId, userId)))
        .get();
      if (!sourceLoanRow) throw new Error('A payoff loan is not available to this profile');
      const sourceLoan = deserializeLoan(sourceLoanRow);
      if (sourceLoan.status === 'paid-off') throw new Error('A payoff loan is already paid off');
      if (sourceLoan.includeInCashForecast === false) {
        throw new Error(
          'Include the payoff loan payments in the cash forecast before committing its refinance',
        );
      }
      if (
        projectLoanPayoffAtDate(sourceLoan, plan.payoffDate, {
          loanPaymentEvents,
          actualThroughDate: effectiveAsOfDate,
        }).payoffCents === 0
      ) {
        throw new Error('A payoff loan has no modeled debt remaining on the selected payoff date');
      }

      const conflict = this.raw
        .prepare(
          `SELECT p.id
             FROM committed_refinance_payoffs AS payoff
             JOIN committed_refinance_plans AS p ON p.id = payoff.plan_id
            WHERE payoff.user_id = ? AND payoff.source_loan_id = ? AND p.status = 'committed'
            LIMIT 1`,
        )
        .get(userId, payoff.sourceLoanId) as { id: string } | undefined;
      if (conflict) {
        throw new Error('A payoff loan is already assigned to another committed refinance plan');
      }

      const origin = this.orm
        .select({
          id: committedRefinancePlans.id,
          payoffDate: committedRefinancePlans.payoffDate,
        })
        .from(committedRefinancePlans)
        .where(
          and(
            eq(committedRefinancePlans.userId, userId),
            eq(committedRefinancePlans.replacementLoanId, payoff.sourceLoanId),
            eq(committedRefinancePlans.status, 'committed'),
          ),
        )
        .get();
      if (payoff.sourceRefinancePlanId && payoff.sourceRefinancePlanId !== origin?.id) {
        throw new Error('Payoff refinance lineage does not match the source loan history');
      }
      if (origin && compareDates(plan.closingDate, origin.payoffDate) <= 0) {
        throw new Error('A stacked refinance must close after the source payoff settles');
      }
      return {
        ...payoff,
        sourceRefinancePlanId: origin?.id,
      };
    });
    plan = committedRefinancePlanSchema.parse({ ...plan, payoffs: enrichedPayoffs });

    const committedAssetTerminalLinkById = new Map<string, string>();
    const committedRelinkRows = this.raw
      .prepare(
        `SELECT asset_relinks_json AS assetRelinksJson
           FROM committed_refinance_plans
          WHERE user_id = ? AND status = 'committed'
          ORDER BY closing_date ASC, id ASC`,
      )
      .all(userId) as Array<{ assetRelinksJson: string }>;
    for (const row of committedRelinkRows) {
      for (const relink of JSON.parse(row.assetRelinksJson) as RefinanceAssetRelink[]) {
        const priorReplacement = committedAssetTerminalLinkById.get(relink.assetId);
        if (priorReplacement && priorReplacement !== relink.sourceLoanId) {
          throw new Error('Existing committed refinance asset-relink history is discontinuous');
        }
        committedAssetTerminalLinkById.set(relink.assetId, relink.replacementLoanId);
      }
    }
    const assetRelinks: RefinanceAssetRelink[] = enrichedPayoffs.flatMap((payoff) =>
      this.orm
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.userId, userId), eq(assets.linkedLiabilityId, payoff.sourceLoanId)))
        .all()
        .map((linkedAsset) => ({
          assetId: linkedAsset.id,
          sourceLoanId: payoff.sourceLoanId,
          replacementLoanId: plan.replacementLoan.id,
        })),
    );
    for (const relink of assetRelinks) {
      const priorReplacement = committedAssetTerminalLinkById.get(relink.assetId);
      if (priorReplacement && priorReplacement !== relink.sourceLoanId) {
        throw new Error('A linked asset must follow its committed refinance loan chain');
      }
    }
    if (assetRelinks.length > maximumProfileAssetRecords) {
      throw new Error(
        `A refinance cannot carry forward more than ${maximumProfileAssetRecords.toLocaleString()} linked assets`,
      );
    }
    plan = committedRefinancePlanSchema.parse({ ...plan, assetRelinks });

    const timestamp = now();
    this.raw.transaction(() => {
      this.orm
        .insert(loans)
        .values({
          ...serializeLoan(plan.replacementLoan),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      this.orm
        .insert(committedRefinancePlans)
        .values({
          ...serializeCommittedRefinancePlan(plan),
          cancelledAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      for (const payoff of plan.payoffs) {
        this.orm
          .insert(committedRefinancePayoffs)
          .values({
            id: randomUUID(),
            userId,
            planId: plan.id,
            sourceLoanId: payoff.sourceLoanId,
            payoffAmountCents: payoff.payoffAmountCents,
            sourceRefinancePlanId: payoff.sourceRefinancePlanId ?? null,
            createdAt: timestamp,
          })
          .run();
      }
      for (const relink of assetRelinks) {
        const update = this.orm
          .update(assets)
          .set({ linkedLiabilityId: relink.replacementLoanId, updatedAt: timestamp })
          .where(
            and(
              eq(assets.id, relink.assetId),
              eq(assets.userId, userId),
              eq(assets.linkedLiabilityId, relink.sourceLoanId),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new Error('A refinance-linked asset changed before the commitment could be saved');
        }
      }
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'commit',
          entityType: 'committed-refinance-plan',
          entityId: plan.id,
          payloadJson: JSON.stringify({
            plan: {
              id: plan.id,
              name: plan.name,
              status: plan.status,
              closingDate: plan.closingDate,
              payoffDate: plan.payoffDate,
              firstPaymentDate: plan.firstPaymentDate,
              replacementLoanId: plan.replacementLoan.id,
              sourceLoanIds: plan.payoffs.map((payoff) => payoff.sourceLoanId),
            },
            assetRelinkCount: assetRelinks.length,
          }),
          createdAt: timestamp,
        })
        .run();
    })();
    return this.getCommittedRefinancePlans(userId).find((candidate) => candidate.id === plan.id)!;
  }

  cancelCommittedRefinancePlan(
    userId: string,
    planId: string,
    asOfDate: PlainDateString = localPlainDate(),
  ): CommittedRefinancePlan {
    const row = this.orm
      .select()
      .from(committedRefinancePlans)
      .where(
        and(eq(committedRefinancePlans.id, planId), eq(committedRefinancePlans.userId, userId)),
      )
      .get();
    if (!row) throw new Error('Committed refinance plan not found');
    const current = this.getCommittedRefinancePlans(userId).find((plan) => plan.id === planId)!;
    if (row.status === 'cancelled') return current;
    if (compareDates(plainDateSchema.parse(asOfDate), row.closingDate) >= 0) {
      throw new Error('A refinance cannot be cancelled on or after its closing date');
    }

    const laterPlan = this.raw
      .prepare(
        `SELECT p.id
           FROM committed_refinance_payoffs AS payoff
           JOIN committed_refinance_plans AS p ON p.id = payoff.plan_id
          WHERE payoff.user_id = ? AND payoff.source_loan_id = ? AND p.status = 'committed'
          LIMIT 1`,
      )
      .get(userId, row.replacementLoanId) as { id: string } | undefined;
    if (laterPlan) {
      throw new Error('Cancel the later stacked refinance before cancelling this plan');
    }

    // Migration-backed durable relink history is the only cancellation authority. If all-or-none
    // legacy validation could not reconstruct it, cancellation must not trust weaker audit JSON
    // and rewrite collateral to an unverified loan.
    const originalAssetRelinks = current.assetRelinks ?? [];
    const durableRelinkAssetIds = new Set(originalAssetRelinks.map((relink) => relink.assetId));
    const untrackedReplacementAsset = this.orm
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.userId, userId), eq(assets.linkedLiabilityId, row.replacementLoanId)))
      .all()
      .find((asset) => !durableRelinkAssetIds.has(asset.id));
    if (untrackedReplacementAsset) {
      throw new Error(
        'A refinance cannot be cancelled while an asset links to its future replacement without durable relink history',
      );
    }

    const timestamp = now();
    const restoredAssetRelinks: typeof originalAssetRelinks = [];
    this.raw.transaction(() => {
      this.orm
        .update(committedRefinancePlans)
        .set({ status: 'cancelled', cancelledAt: timestamp, updatedAt: timestamp })
        .where(
          and(eq(committedRefinancePlans.id, planId), eq(committedRefinancePlans.userId, userId)),
        )
        .run();
      this.orm
        .update(loans)
        .set({ status: 'paid-off', includeInCashForecast: false, updatedAt: timestamp })
        .where(and(eq(loans.id, row.replacementLoanId), eq(loans.userId, userId)))
        .run();
      for (const relink of originalAssetRelinks) {
        const update = this.orm
          .update(assets)
          .set({ linkedLiabilityId: relink.sourceLoanId, updatedAt: timestamp })
          .where(
            and(
              eq(assets.id, relink.assetId),
              eq(assets.userId, userId),
              eq(assets.linkedLiabilityId, relink.replacementLoanId),
            ),
          )
          .run();
        if (update.changes === 1) restoredAssetRelinks.push(relink);
      }
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'cancel',
          entityType: 'committed-refinance-plan',
          entityId: planId,
          payloadJson: JSON.stringify({
            plan: { id: current.id, status: 'cancelled', cancelledAt: timestamp },
            restoredAssetRelinkCount: restoredAssetRelinks.length,
          }),
          createdAt: timestamp,
        })
        .run();
    })();
    return committedRefinancePlanSchema.parse({ ...current, status: 'cancelled' });
  }

  resetUserData(userId: string): void {
    if (!this.getCredentialsById(userId)) throw new Error('Unknown user');
    const timestamp = now();
    this.raw.transaction(() => {
      this.orm.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userId)).run();
      this.orm
        .delete(notificationPresentations)
        .where(eq(notificationPresentations.userId, userId))
        .run();
      this.orm.delete(importLineage).where(eq(importLineage.userId, userId)).run();
      this.orm.delete(importBatches).where(eq(importBatches.userId, userId)).run();
      this.orm.delete(creditCardCycles).where(eq(creditCardCycles.userId, userId)).run();
      this.orm.delete(rewardPrograms).where(eq(rewardPrograms.userId, userId)).run();
      this.orm.delete(reconciliations).where(eq(reconciliations.userId, userId)).run();
      this.orm.delete(savedScenarios).where(eq(savedScenarios.userId, userId)).run();
      this.orm
        .delete(committedRefinancePayoffs)
        .where(eq(committedRefinancePayoffs.userId, userId))
        .run();
      this.orm
        .delete(committedRefinancePlans)
        .where(eq(committedRefinancePlans.userId, userId))
        .run();
      this.orm.delete(loans).where(eq(loans.userId, userId)).run();
      this.orm.delete(receivables).where(eq(receivables.userId, userId)).run();
      this.orm.delete(assets).where(eq(assets.userId, userId)).run();
      this.orm.delete(forecastEvents).where(eq(forecastEvents.userId, userId)).run();
      this.orm.delete(creditCards).where(eq(creditCards.userId, userId)).run();
      this.orm.delete(cashAccounts).where(eq(cashAccounts.userId, userId)).run();
      this.orm.delete(cashFloorPolicies).where(eq(cashFloorPolicies.userId, userId)).run();
      this.orm
        .update(profiles)
        .set({ onboardingComplete: false, updatedAt: timestamp })
        .where(eq(profiles.id, userId))
        .run();
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'reset',
          entityType: 'user-data',
          entityId: userId,
          payloadJson: JSON.stringify({ scope: 'active-profile-financial-data' }),
          createdAt: timestamp,
        })
        .run();
    })();
  }

  convertScenarioToCommitment(userId: string, scenarioId: string): string {
    const scenario = this.orm
      .select()
      .from(savedScenarios)
      .where(and(eq(savedScenarios.id, scenarioId), eq(savedScenarios.userId, userId)))
      .get();
    if (!scenario || scenario.status === 'archived') throw new Error('Active scenario not found');
    this.assertOwnedAccount(userId, scenario.accountId);
    let cardFundingAccountId: string | undefined;
    if (scenario.fundingType === 'card') {
      if (!scenario.cardId || !scenario.purchaseDate) {
        throw new Error('Saved card scenario is missing its card or purchase date');
      }
      const card = this.ownedCard(userId, scenario.cardId);
      if (!cardAllowsPurchasesOnDate(card, scenario.purchaseDate)) {
        throw new Error(`${card.name} cannot fund a purchase on or after its closure date`);
      }
      cardFundingAccountId = card.fundingAccountId;
    }
    const timestamp = now();
    const eventId = randomUUID();
    this.raw.transaction(() => {
      this.orm
        .insert(forecastEvents)
        .values({
          id: eventId,
          userId,
          accountId: cardFundingAccountId ?? scenario.accountId,
          date: scenario.fundingType === 'card' ? scenario.purchaseDate! : scenario.settlementDate,
          kind: 'scenario',
          direction: 'outflow',
          amountCents: scenario.amountCents,
          certainty: 'confirmed',
          status: 'planned',
          label: scenario.description,
          sourceRecordId: scenario.id,
          hypothetical: false,
          accepted: true,
          paymentMethod: scenario.fundingType === 'card' ? 'credit-card' : 'cash-account',
          cardId: scenario.fundingType === 'card' ? scenario.cardId : null,
          cardActivityTreatment: 'additional',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      this.orm
        .update(savedScenarios)
        .set({ status: 'archived', updatedAt: timestamp })
        .where(and(eq(savedScenarios.id, scenario.id), eq(savedScenarios.userId, userId)))
        .run();
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId,
          action: 'convert',
          entityType: 'saved-scenario',
          entityId: scenario.id,
          payloadJson: JSON.stringify({
            destinationType: 'forecast-event',
            eventId,
            fundingType: scenario.fundingType,
          }),
          createdAt: timestamp,
        })
        .run();
    })();
    return eventId;
  }

  recordReceivableSettlement(input: {
    userId: string;
    receivableId: string;
    amountCents: number;
    date: string;
    asOfDate: string;
    occurrenceDate?: string;
    /** Per-release destination. The receivable account remains the default for legacy callers. */
    destinationAccountId?: string;
  }): string {
    return this.raw.transaction(() => this.recordReceivableSettlementInTransaction(input))();
  }

  private recordReceivableSettlementInTransaction(input: {
    userId: string;
    receivableId: string;
    amountCents: number;
    date: string;
    asOfDate: string;
    occurrenceDate?: string;
    destinationAccountId?: string;
  }): string {
    const settlementDate = plainDateSchema.parse(input.date);
    const asOfDate = plainDateSchema.parse(input.asOfDate);
    if (compareDates(settlementDate, asOfDate) > 0) {
      throw new Error('Date received cannot be in the future');
    }
    const requestedOccurrenceDate =
      input.occurrenceDate === undefined ? undefined : plainDateSchema.parse(input.occurrenceDate);
    const receivable = this.orm
      .select()
      .from(receivables)
      .where(and(eq(receivables.id, input.receivableId), eq(receivables.userId, input.userId)))
      .get();
    if (!receivable) throw new Error('Receivable not found');
    const parsedReceivable = deserializeReceivable(receivable);
    const repeating = hasRecurringReceivableSchedule(parsedReceivable);
    const scheduleEvents = parsedReceivable.settlementAnchorEventId
      ? this.orm
          .select()
          .from(forecastEvents)
          .where(eq(forecastEvents.userId, input.userId))
          .all()
          .map(deserializeForecastEvent)
      : [];
    if (requestedOccurrenceDate && !repeating) {
      throw new Error('Only a recurring receivable can select an installment occurrence');
    }
    const nearestOccurrenceDate = repeating
      ? resolveReceivableScheduleOccurrenceDate({
          receivable: parsedReceivable,
          events: scheduleEvents,
          settlementDate: requestedOccurrenceDate ?? settlementDate,
        })
      : parsedReceivable.expectedDate;
    if (requestedOccurrenceDate && nearestOccurrenceDate !== requestedOccurrenceDate) {
      throw new Error('Selected installment is not part of the receivable schedule');
    }
    const occurrenceDate = requestedOccurrenceDate ?? nearestOccurrenceDate;
    const oneTimeAccrualOnly =
      !repeating &&
      parsedReceivable.remainingAmountCents === 0 &&
      parsedReceivable.accrualDate !== undefined &&
      (parsedReceivable.accrualAmountCents ?? 0) > 0 &&
      parsedReceivable.accrualRecurrenceRule === undefined;
    if (oneTimeAccrualOnly && compareDates(settlementDate, parsedReceivable.accrualDate!) < 0) {
      throw new Error('This amount is not owed until its accrual date');
    }
    const occurrenceUsesStaticBalance =
      (!repeating && !oneTimeAccrualOnly) ||
      (repeating &&
        occurrenceDate === parsedReceivable.expectedDate &&
        parsedReceivable.originalAmountCents > 0);
    let availableAmountCents = parsedReceivable.remainingAmountCents;
    let occurrenceTargetCents: number | undefined;
    if (oneTimeAccrualOnly) {
      occurrenceTargetCents = parsedReceivable.accrualAmountCents!;
      const priorSettlements = this.orm
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, input.userId))
        .all()
        .map(deserializeForecastEvent)
        .filter(
          (event) =>
            event.kind === 'receivable-settlement' &&
            event.direction === 'inflow' &&
            event.sourceRecordId === parsedReceivable.id &&
            this.isAppliedReceivableSettlement(event),
        )
        .reduce((total, event) => total + event.amountCents, 0);
      availableAmountCents = Math.max(0, occurrenceTargetCents - priorSettlements);
    }
    if (repeating && !occurrenceUsesStaticBalance) {
      const occurrenceAmountCents =
        parsedReceivable.recurringAmountCents ?? parsedReceivable.originalAmountCents;
      const profileReceivableById = new Map(
        this.orm
          .select()
          .from(receivables)
          .where(eq(receivables.userId, input.userId))
          .all()
          .map(deserializeReceivable)
          .map((candidate) => [candidate.id, candidate]),
      );
      const priorSettlementEvents = this.orm
        .select()
        .from(forecastEvents)
        .where(eq(forecastEvents.userId, input.userId))
        .all()
        .map(deserializeForecastEvent)
        .filter(
          (event) =>
            event.kind === 'receivable-settlement' &&
            event.direction === 'inflow' &&
            receivableForSettlementSourceFromIndex(profileReceivableById, event.sourceRecordId)
              ?.id === parsedReceivable.id,
        )
        .filter(
          (event) =>
            resolveRecordedReceivableOccurrenceDate({
              receivable: parsedReceivable,
              events: scheduleEvents,
              settlementEvent: event,
            }) === occurrenceDate,
        );
      const recordedTargets = new Set(
        priorSettlementEvents.flatMap((event) =>
          event.receivableOccurrenceTargetCents === undefined
            ? []
            : [event.receivableOccurrenceTargetCents],
        ),
      );
      if (recordedTargets.size > 1) {
        throw new Error('Recorded receipts disagree on the recurring occurrence target');
      }
      occurrenceTargetCents = [...recordedTargets][0] ?? occurrenceAmountCents;
      const priorSettlements = priorSettlementEvents
        .filter((event) => this.isAppliedReceivableSettlement(event))
        .reduce((total, event) => total + event.amountCents, 0);
      availableAmountCents = Math.max(0, occurrenceTargetCents - priorSettlements);
    }
    if (input.amountCents <= 0 || input.amountCents > availableAmountCents) {
      throw new Error('Settlement must be positive and no more than the open occurrence amount');
    }
    const destinationAccountId = input.destinationAccountId ?? receivable.destinationAccountId;
    this.assertOwnedAccount(input.userId, destinationAccountId);
    const timestamp = now();
    const eventId = randomUUID();
    if (occurrenceUsesStaticBalance) {
      this.orm
        .update(receivables)
        .set({
          remainingAmountCents: receivable.remainingAmountCents - input.amountCents,
          updatedAt: timestamp,
        })
        .where(and(eq(receivables.id, receivable.id), eq(receivables.userId, input.userId)))
        .run();
    }
    this.orm
      .insert(forecastEvents)
      .values({
        id: eventId,
        userId: input.userId,
        accountId: destinationAccountId,
        date: settlementDate,
        kind: 'receivable-settlement',
        direction: 'inflow',
        amountCents: input.amountCents,
        certainty: 'confirmed',
        status: 'confirmed',
        label: `Settlement: ${receivable.description}`,
        sourceRecordId: receivable.id,
        hypothetical: false,
        accepted: false,
        receivableOccurrenceDate: repeating || oneTimeAccrualOnly ? occurrenceDate : null,
        receivableOccurrenceTargetCents: occurrenceTargetCents ?? null,
        notes: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    this.orm
      .insert(auditEvents)
      .values({
        id: randomUUID(),
        userId: input.userId,
        action: 'settle',
        entityType: 'receivable',
        entityId: receivable.id,
        payloadJson: JSON.stringify({
          eventId,
          amountCents: input.amountCents,
          date: settlementDate,
          occurrenceDate,
          occurrenceTargetCents,
          recurring: repeating,
          staticBalanceReducedCents: occurrenceUsesStaticBalance ? input.amountCents : 0,
          destinationAccountId,
          defaultDestinationAccountId: receivable.destinationAccountId,
        }),
        createdAt: timestamp,
      })
      .run();
    return eventId;
  }

  recordUnattributedReceivableSettlement(input: {
    userId: string;
    amountCents: number;
    date: string;
    asOfDate: string;
    destinationAccountId: string;
  }): string[] {
    const settlementDate = plainDateSchema.parse(input.date);
    const asOfDate = plainDateSchema.parse(input.asOfDate);
    if (compareDates(settlementDate, asOfDate) > 0) {
      throw new Error('Date received cannot be in the future');
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('Received amount must be a positive whole number of cents');
    }
    this.assertOwnedAccount(input.userId, input.destinationAccountId);
    const records = this.getManagedRecords(input.userId);
    if (!records.policy || records.accounts.length === 0) {
      throw new Error('Cash forecast setup is required before recording received money');
    }
    const replayStartDate = records.accounts
      .map((account) => account.balanceAsOf)
      .reduce((earliest, date) => (compareDates(date, earliest) < 0 ? date : earliest));
    const currentDay = projectRollingReceivableBalances({
      receivables: records.receivables,
      settlementEvents: records.events,
      replayStartDate,
      startDate: settlementDate,
      endDate: settlementDate,
      mode: 'expected',
      includeConfirmedReceivablesConservatively:
        records.policy.includeConfirmedReceivablesConservatively,
    })[0];
    const receivableById = new Map(
      records.receivables.map((receivable) => [receivable.id, receivable]),
    );
    const candidates = (currentDay?.occurrences ?? [])
      .filter(
        (occurrence) =>
          occurrence.endingOutstandingCents > 0 && receivableById.has(occurrence.receivableId),
      )
      .sort(
        (left, right) =>
          compareDates(left.occurrenceDate, right.occurrenceDate) ||
          left.receivableId.localeCompare(right.receivableId),
      );
    const totalOpenCents = candidates.reduce(
      (total, occurrence) => total + occurrence.endingOutstandingCents,
      0,
    );
    if (input.amountCents > totalOpenCents) {
      throw new Error('Received amount cannot be more than the Money Owed balance on that date');
    }

    return this.raw.transaction(() => {
      let remainingCents = input.amountCents;
      const eventIds: string[] = [];
      for (const candidate of candidates) {
        if (remainingCents === 0) break;
        const receivable = receivableById.get(candidate.receivableId)!;
        const allocatedCents = Math.min(remainingCents, candidate.endingOutstandingCents);
        eventIds.push(
          this.recordReceivableSettlementInTransaction({
            userId: input.userId,
            receivableId: receivable.id,
            amountCents: allocatedCents,
            date: settlementDate,
            asOfDate,
            ...(hasRecurringReceivableSchedule(receivable)
              ? { occurrenceDate: candidate.occurrenceDate }
              : {}),
            destinationAccountId: input.destinationAccountId,
          }),
        );
        remainingCents -= allocatedCents;
      }
      if (remainingCents !== 0) {
        throw new Error('Received money could not be fully applied to the Money Owed balance');
      }
      return eventIds;
    })();
  }

  recordOverviewExpense(input: {
    userId: string;
    paymentSource:
      { kind: 'cash-account'; accountId: string } | { kind: 'credit-card'; cardId: string };
    amountCents: number;
    date: string;
    label: string;
    notes?: string;
    owedTreatment: 'none' | 'reimbursable' | 'shared';
    owedBy?: string;
    asOfDate: string;
  }): { expenseEventId: string; receivableId?: string } {
    const expenseDate = plainDateSchema.parse(input.date);
    const asOfDate = plainDateSchema.parse(input.asOfDate);
    if (compareDates(expenseDate, asOfDate) > 0) {
      throw new Error('Expense date cannot be in the future');
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('Expense amount must be a positive whole number of cents');
    }
    const label = input.label.trim();
    if (!label) throw new Error('Expense description is required');
    const owedBy = input.owedBy?.trim();
    if (input.owedTreatment !== 'none' && !owedBy) {
      throw new Error('Enter who owes this amount');
    }
    if (input.owedTreatment === 'none' && owedBy) {
      throw new Error('An owed-by name requires a reimbursable or shared expense');
    }

    let accountId: string;
    let paymentMethod: 'cash-account' | 'credit-card';
    let cardId: string | undefined;
    let balanceSnapshotDate: PlainDateString | undefined;
    let destinationAccountId: string;
    let paymentInstrument: string;
    if (input.paymentSource.kind === 'cash-account') {
      const account = this.orm
        .select()
        .from(cashAccounts)
        .where(
          and(
            eq(cashAccounts.id, input.paymentSource.accountId),
            eq(cashAccounts.userId, input.userId),
          ),
        )
        .get();
      if (!account) throw new Error('Cash account is not available to this profile');
      if (compareDates(expenseDate, account.balanceAsOf) < 0) {
        throw new Error(`Expense date cannot be before ${account.balanceAsOf}`);
      }
      accountId = account.id;
      destinationAccountId = account.id;
      paymentMethod = 'cash-account';
      balanceSnapshotDate = account.balanceAsOf;
      paymentInstrument = `cash-account:${account.id}`;
    } else {
      const card = this.ownedCard(input.userId, input.paymentSource.cardId);
      if (!cardAllowsPurchasesOnDate(card, expenseDate)) {
        throw new Error(`${card.name} cannot fund purchases on or after its closure date`);
      }
      if (card.reportedBalanceDate && compareDates(expenseDate, card.reportedBalanceDate) < 0) {
        throw new Error(`Expense date cannot be before ${card.reportedBalanceDate}`);
      }
      accountId = card.fundingAccountId;
      destinationAccountId = card.fundingAccountId;
      paymentMethod = 'credit-card';
      cardId = card.id;
      balanceSnapshotDate = card.reportedBalanceDate;
      paymentInstrument = `credit-card:${card.id}`;
    }

    const timestamp = now();
    const expenseEventId = randomUUID();
    const expense = forecastEventSchema.parse({
      id: expenseEventId,
      userId: input.userId,
      accountId,
      date: expenseDate,
      kind: 'manual-adjustment',
      direction: 'outflow',
      amountCents: input.amountCents,
      certainty: 'confirmed',
      status: 'confirmed',
      label,
      hypothetical: false,
      accepted: false,
      paymentMethod,
      cardId,
      cardActivityTreatment: cardId ? 'additional' : undefined,
      appliesAfterBalanceSnapshot: expenseDate === balanceSnapshotDate,
      notes: input.notes?.trim() || undefined,
    });
    const owedAmountCents =
      input.owedTreatment === 'reimbursable'
        ? input.amountCents
        : input.owedTreatment === 'shared'
          ? Math.round(input.amountCents / 2)
          : 0;
    const receivableId = owedAmountCents > 0 ? randomUUID() : undefined;
    const receivable = receivableId
      ? receivableSchema.parse({
          id: receivableId,
          userId: input.userId,
          source: owedBy!,
          description: label,
          originalAmountCents: owedAmountCents,
          remainingAmountCents: owedAmountCents,
          expectedDate: expenseDate,
          settlementDateConfirmed: false,
          destinationAccountId,
          certainty: 'confirmed',
          grossExpenseCents: input.amountCents,
          userEconomicShareCents: input.amountCents - owedAmountCents,
          relatedExpenseId: expenseEventId,
          paymentInstrument,
          includeInCashForecast: false,
          notes: input.notes?.trim() || undefined,
        })
      : undefined;

    this.raw.transaction(() => {
      this.orm
        .insert(forecastEvents)
        .values({
          ...serializeForecastEvent(expense),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      if (receivable) {
        this.orm
          .insert(receivables)
          .values({
            ...serializeReceivable(receivable),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      }
      const auditPayload = {
        source: 'overview-expense',
        paymentSource: input.paymentSource,
        owedTreatment: input.owedTreatment,
        receivableId,
      };
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId: input.userId,
          action: 'log-expense',
          entityType: 'forecast-event',
          entityId: expenseEventId,
          payloadJson: JSON.stringify(auditPayload),
          createdAt: timestamp,
        })
        .run();
      if (receivableId) {
        this.orm
          .insert(auditEvents)
          .values({
            id: randomUUID(),
            userId: input.userId,
            action: 'create-from-expense',
            entityType: 'receivable',
            entityId: receivableId,
            payloadJson: JSON.stringify({
              ...auditPayload,
              expenseEventId,
              owedAmountCents,
            }),
            createdAt: timestamp,
          })
          .run();
      }
    })();
    return { expenseEventId, receivableId };
  }

  upsertBillPlan(input: {
    userId: string;
    eventId: string;
    linkedReceivableId?: string;
    paymentSource:
      | { kind: 'cash-account'; accountId: string }
      | { kind: 'credit-card'; cardId: string; addToCardBalance: boolean };
    amountCents: number;
    firstBillDate: string;
    label: string;
    recurrenceRule: RecurrenceRule;
    recurrenceEndDate?: string;
    certainty: 'confirmed' | 'expected' | 'uncertain';
    active: boolean;
    notes?: string;
    owedTreatment: 'none' | 'reimbursable' | 'shared';
    owedBy?: string;
    asOfDate: string;
  }): { eventId: string; receivableId?: string } {
    const firstBillDate = plainDateSchema.parse(input.firstBillDate);
    const recurrenceEndDate = input.recurrenceEndDate
      ? plainDateSchema.parse(input.recurrenceEndDate)
      : undefined;
    if (recurrenceEndDate && compareDates(recurrenceEndDate, firstBillDate) < 0) {
      throw new Error('Bill schedule end cannot precede its first date');
    }
    const label = input.label.trim();
    if (!label) throw new Error('Bill name is required');
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('Bill amount must be a positive whole number of cents');
    }
    const owedBy = input.owedBy?.trim();
    if (input.owedTreatment !== 'none' && !owedBy) {
      throw new Error('Enter who owes this amount');
    }
    if (input.owedTreatment === 'none' && owedBy) {
      throw new Error('An owed-by name requires a reimbursable or shared bill');
    }

    let accountId: string;
    let destinationAccountId: string;
    let paymentMethod: 'cash-account' | 'credit-card';
    let cardId: string | undefined;
    let cardActivityTreatment: 'additional' | 'included-in-cycle-total' | undefined;
    let paymentInstrument: string;
    if (input.paymentSource.kind === 'cash-account') {
      this.assertOwnedAccount(input.userId, input.paymentSource.accountId);
      accountId = input.paymentSource.accountId;
      destinationAccountId = input.paymentSource.accountId;
      paymentMethod = 'cash-account';
      paymentInstrument = `cash-account:${accountId}`;
    } else {
      const card = this.ownedCard(input.userId, input.paymentSource.cardId);
      if (!cardAllowsPurchasesOnDate(card, firstBillDate)) {
        throw new Error(`${card.name} cannot fund purchases on or after its closure date`);
      }
      accountId = card.fundingAccountId;
      destinationAccountId = card.fundingAccountId;
      paymentMethod = 'credit-card';
      cardId = card.id;
      cardActivityTreatment = input.paymentSource.addToCardBalance
        ? 'additional'
        : 'included-in-cycle-total';
      paymentInstrument = `credit-card:${card.id}`;
    }

    const existingEventRow = this.orm
      .select()
      .from(forecastEvents)
      .where(and(eq(forecastEvents.id, input.eventId), eq(forecastEvents.userId, input.userId)))
      .get();
    const existingEvent = existingEventRow ? deserializeForecastEvent(existingEventRow) : undefined;
    if (
      existingEvent &&
      (existingEvent.direction !== 'outflow' ||
        !['direct-commitment', 'payable', 'baseline-spending'].includes(existingEvent.kind))
    ) {
      throw new Error('Only an existing bill or subscription can be edited here');
    }

    const bill = forecastEventSchema.parse({
      ...(existingEvent ?? {}),
      id: input.eventId,
      userId: input.userId,
      accountId,
      date: firstBillDate,
      kind: existingEvent?.kind ?? 'direct-commitment',
      direction: 'outflow',
      amountCents: input.amountCents,
      certainty: input.certainty,
      status: input.active ? 'planned' : 'cancelled',
      label,
      hypothetical: false,
      accepted: false,
      recurrenceRule: input.recurrenceRule,
      recurrenceEndDate,
      paymentMethod,
      cardId,
      cardActivityTreatment,
      notes: input.notes?.trim() || undefined,
      appliesAfterBalanceSnapshot: undefined,
    });

    const existingLinkedRows = this.orm
      .select()
      .from(receivables)
      .where(eq(receivables.userId, input.userId))
      .all()
      .filter(
        (row) =>
          row.relatedExpenseId === input.eventId ||
          (input.linkedReceivableId !== undefined && row.id === input.linkedReceivableId),
      );
    if (existingLinkedRows.length > 1) {
      throw new Error('This bill has more than one linked Money Owed schedule');
    }
    const existingReceivable = existingLinkedRows[0]
      ? deserializeReceivable(existingLinkedRows[0])
      : undefined;
    if (
      existingReceivable?.relatedExpenseId &&
      existingReceivable.relatedExpenseId !== input.eventId
    ) {
      throw new Error('The selected Money Owed schedule belongs to another expense');
    }

    return this.raw.transaction(() => {
      this.upsertManagedEntity(input.userId, 'forecast-event', bill, {
        asOfDate: plainDateSchema.parse(input.asOfDate),
      });
      let receivableId = existingReceivable?.id;
      if (input.owedTreatment !== 'none') {
        const owedAmountCents =
          input.owedTreatment === 'reimbursable'
            ? input.amountCents
            : Math.round(input.amountCents / 2);
        receivableId ??= input.linkedReceivableId ?? randomUUID();
        const receivable = receivableSchema.parse({
          ...(existingReceivable ?? {}),
          id: receivableId,
          userId: input.userId,
          source: owedBy!,
          description: label,
          originalAmountCents: Math.max(
            existingReceivable?.originalAmountCents ?? 0,
            existingReceivable?.remainingAmountCents ?? 0,
          ),
          remainingAmountCents: existingReceivable?.remainingAmountCents ?? 0,
          expectedDate: firstBillDate,
          settlementDateConfirmed: false,
          destinationAccountId,
          certainty: input.certainty,
          grossExpenseCents: input.amountCents,
          userEconomicShareCents: input.amountCents - owedAmountCents,
          relatedExpenseId: input.eventId,
          paymentInstrument,
          accrualAmountCents: input.active ? owedAmountCents : undefined,
          accrualDate: input.active ? firstBillDate : undefined,
          accrualRecurrenceRule: input.active ? input.recurrenceRule : undefined,
          recurrenceEndDate: input.active ? recurrenceEndDate : undefined,
          includeInCashForecast: false,
          notes: input.notes?.trim() || undefined,
        });
        this.upsertManagedEntity(input.userId, 'receivable', receivable, {
          asOfDate: plainDateSchema.parse(input.asOfDate),
        });
      } else if (existingReceivable) {
        const stoppedReceivable = receivableSchema.parse({
          ...existingReceivable,
          accrualAmountCents: undefined,
          accrualDate: undefined,
          accrualRecurrenceRule: undefined,
          recurrenceEndDate: undefined,
        });
        this.upsertManagedEntity(input.userId, 'receivable', stoppedReceivable, {
          asOfDate: plainDateSchema.parse(input.asOfDate),
        });
      }
      return { eventId: bill.id, receivableId };
    })();
  }

  createInternalTransfer(input: {
    userId: string;
    sourceAccountId: string;
    destinationAccountId: string;
    amountCents: number;
    initiationDate: string;
    arrivalDate: string;
    label: string;
    recurrenceRule?: RecurrenceRule;
    recurrenceEndDate?: string;
    status?: 'planned' | 'scheduled' | 'confirmed';
    notes?: string;
  }): string {
    if (input.sourceAccountId === input.destinationAccountId) {
      throw new Error('Transfer accounts must differ');
    }
    if (input.arrivalDate < input.initiationDate) {
      throw new Error('Transfer arrival cannot precede initiation');
    }
    if (input.amountCents <= 0) throw new Error('Transfer amount must be positive');
    this.assertOwnedAccount(input.userId, input.sourceAccountId);
    this.assertOwnedAccount(input.userId, input.destinationAccountId);
    const source = this.orm
      .select({ transferDelayDays: cashAccounts.transferDelayDays })
      .from(cashAccounts)
      .where(and(eq(cashAccounts.id, input.sourceAccountId), eq(cashAccounts.userId, input.userId)))
      .get()!;
    if (
      daysBetween(
        plainDateSchema.parse(input.initiationDate),
        plainDateSchema.parse(input.arrivalDate),
      ) < source.transferDelayDays
    ) {
      throw new Error(
        `Transfer arrival must allow ${source.transferDelayDays} configured delay day(s)`,
      );
    }
    const transferId = randomUUID();
    const timestamp = now();
    this.raw.transaction(() => {
      this.orm
        .insert(forecastEvents)
        .values([
          {
            id: randomUUID(),
            userId: input.userId,
            accountId: input.sourceAccountId,
            date: input.initiationDate,
            kind: 'transfer-debit',
            direction: 'outflow',
            amountCents: input.amountCents,
            certainty: 'confirmed',
            status: input.status ?? 'planned',
            label: input.label,
            transferId,
            hypothetical: false,
            accepted: false,
            recurrenceJson: input.recurrenceRule ? JSON.stringify(input.recurrenceRule) : null,
            recurrenceEndDate: input.recurrenceEndDate ?? null,
            notes: input.notes ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            id: randomUUID(),
            userId: input.userId,
            accountId: input.destinationAccountId,
            date: input.arrivalDate,
            kind: 'transfer-credit',
            direction: 'inflow',
            amountCents: input.amountCents,
            certainty: 'confirmed',
            status: input.status ?? 'planned',
            label: input.label,
            transferId,
            hypothetical: false,
            accepted: false,
            recurrenceJson: null,
            recurrenceEndDate: null,
            notes: input.notes ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ])
        .run();
      this.orm
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          userId: input.userId,
          action: 'create',
          entityType: 'internal-transfer',
          entityId: transferId,
          payloadJson: JSON.stringify({
            amountCents: input.amountCents,
            initiationDate: input.initiationDate,
            arrivalDate: input.arrivalDate,
          }),
          createdAt: timestamp,
        })
        .run();
    })();
    return transferId;
  }

  private assertOwnedAccount(userId: string, accountId: string): void {
    const owned = this.orm
      .select({ id: cashAccounts.id })
      .from(cashAccounts)
      .where(and(eq(cashAccounts.id, accountId), eq(cashAccounts.userId, userId)))
      .get();
    if (!owned) throw new Error('Funding account is not available to this profile');
  }

  private assertOwnedIncomePlan(userId: string, incomePlanId: string): void {
    const owned = this.orm
      .select({ id: forecastEvents.id })
      .from(forecastEvents)
      .where(and(eq(forecastEvents.userId, userId), eq(forecastEvents.incomePlanId, incomePlanId)))
      .get();
    if (!owned) throw new Error('Parent income plan is not available to this profile');
  }

  private assertOwnedBaseIncomePlan(userId: string, incomePlanId: string): void {
    const owned = this.orm
      .select()
      .from(forecastEvents)
      .where(and(eq(forecastEvents.userId, userId), eq(forecastEvents.incomePlanId, incomePlanId)))
      .get();
    if (!owned) throw new Error('Parent income plan is not available to this profile');
    const parent = deserializeForecastEvent(owned);
    if (
      parent.kind !== 'income' ||
      parent.direction !== 'inflow' ||
      parent.incomeType === 'raise-adjustment' ||
      !parent.recurrenceRule ||
      parent.recurrenceRule.frequency === 'once'
    ) {
      throw new Error('A linked raise requires a recurring base income plan');
    }
  }

  private cascadeLinkedRaisePlans(
    userId: string,
    basePlanId: string,
    baseEvents: ForecastEvent[],
  ): void {
    const dependentRows = this.orm
      .select()
      .from(forecastEvents)
      .where(
        and(eq(forecastEvents.userId, userId), eq(forecastEvents.parentIncomePlanId, basePlanId)),
      )
      .all();
    if (dependentRows.length === 0) return;

    const base = baseEvents[0]!;
    if (
      base.incomeType === 'raise-adjustment' ||
      !base.incomeNominalDate ||
      !base.recurrenceRule ||
      base.recurrenceRule.frequency === 'once'
    ) {
      throw new Error('A paycheck with a linked raise must remain a recurring base income plan');
    }
    const updatedRaises = dependentRows.map((row) => {
      const raise = deserializeForecastEvent(row);
      const effectiveDate = raise.incomeNominalDate!;
      if (
        !isRecurrenceOccurrence(base.incomeNominalDate!, effectiveDate, base.recurrenceRule!) ||
        (base.recurrenceEndDate && compareDates(effectiveDate, base.recurrenceEndDate) > 0)
      ) {
        throw new Error(
          'The edited paycheck schedule no longer contains a linked raise payday; adjust or delete the raise first',
        );
      }
      const destinationAllocation = baseEvents.find((event) => event.accountId === raise.accountId);
      const arrivalOffsetDays =
        destinationAllocation?.incomeArrivalOffsetDays ?? raise.incomeArrivalOffsetDays ?? 0;
      return forecastEventSchema.parse({
        ...raise,
        date: addDays(effectiveDate, arrivalOffsetDays),
        recurrenceRule: base.recurrenceRule,
        recurrenceEndDate: base.recurrenceEndDate,
        incomeArrivalOffsetDays: arrivalOffsetDays,
      });
    });
    assertValidIncomePlanGroups(updatedRaises);
    for (const raise of updatedRaises) {
      this.upsertManagedEntity(userId, 'forecast-event', raise, {
        allowGroupedIncomeMutation: true,
      });
    }
  }

  private cascadeLinkedRaiseEvents(userId: string, base: ForecastEvent): void {
    const dependentRows = this.orm
      .select()
      .from(forecastEvents)
      .where(
        and(eq(forecastEvents.userId, userId), eq(forecastEvents.parentIncomeEventId, base.id)),
      )
      .all();
    if (dependentRows.length === 0) return;
    if (
      base.kind !== 'income' ||
      base.direction !== 'inflow' ||
      base.incomeType === 'raise-adjustment' ||
      !base.recurrenceRule ||
      base.recurrenceRule.frequency === 'once'
    ) {
      throw new Error('An income stream with a linked raise must remain recurring');
    }
    for (const row of dependentRows) {
      const raise = deserializeForecastEvent(row);
      if (
        !isRecurrenceOccurrence(base.date, raise.date, base.recurrenceRule) ||
        (base.recurrenceEndDate && compareDates(raise.date, base.recurrenceEndDate) > 0)
      ) {
        throw new Error(
          'The edited income schedule no longer contains a linked raise payday; adjust or delete the raise first',
        );
      }
      this.upsertManagedEntity(
        userId,
        'forecast-event',
        forecastEventSchema.parse({
          ...raise,
          recurrenceRule: base.recurrenceRule,
          recurrenceEndDate: base.recurrenceEndDate,
        }),
      );
    }
  }

  private updatePairedInternalTransfer(
    userId: string,
    submitted: ForecastEvent,
    timestamp: string,
  ): boolean {
    const existingRow = this.orm
      .select()
      .from(forecastEvents)
      .where(and(eq(forecastEvents.id, submitted.id), eq(forecastEvents.userId, userId)))
      .get();
    const existing = existingRow ? deserializeForecastEvent(existingRow) : undefined;
    if (!existing?.transferId) return false;
    if (submitted.transferId !== existing.transferId) {
      throw new Error('A transfer leg cannot change its paired transfer ID');
    }
    if (
      submitted.kind !== existing.kind ||
      submitted.direction !== existing.direction ||
      (submitted.paymentMethod ?? 'cash-account') !== (existing.paymentMethod ?? 'cash-account') ||
      submitted.cardId !== existing.cardId ||
      submitted.incomeType !== existing.incomeType ||
      submitted.parentIncomeEventId !== existing.parentIncomeEventId
    ) {
      throw new Error('A paired transfer leg cannot change its financial role');
    }

    const pair = this.orm
      .select()
      .from(forecastEvents)
      .where(
        and(eq(forecastEvents.userId, userId), eq(forecastEvents.transferId, existing.transferId)),
      )
      .all()
      .map(deserializeForecastEvent);
    const currentDebit = pair.find((event) => event.kind === 'transfer-debit');
    const currentCredit = pair.find((event) => event.kind === 'transfer-credit');
    if (!currentDebit || !currentCredit || pair.length !== 2) {
      throw new Error('Internal transfer pair is incomplete');
    }
    const editingDebit = existing.id === currentDebit.id;
    const priorDelayDays = daysBetween(currentDebit.date, currentCredit.date);
    if (priorDelayDays < 0) throw new Error('Internal transfer arrival precedes initiation');

    const debitDate = editingDebit ? submitted.date : currentDebit.date;
    const creditDate = editingDebit ? addDays(submitted.date, priorDelayDays) : submitted.date;
    if (creditDate < debitDate) throw new Error('Transfer arrival cannot precede initiation');
    const sourceAccountId = editingDebit ? submitted.accountId : currentDebit.accountId;
    const destinationAccountId = editingDebit ? currentCredit.accountId : submitted.accountId;
    if (sourceAccountId === destinationAccountId) throw new Error('Transfer accounts must differ');
    this.assertOwnedAccount(userId, sourceAccountId);
    this.assertOwnedAccount(userId, destinationAccountId);
    const source = this.orm
      .select({ transferDelayDays: cashAccounts.transferDelayDays })
      .from(cashAccounts)
      .where(and(eq(cashAccounts.id, sourceAccountId), eq(cashAccounts.userId, userId)))
      .get()!;
    if (daysBetween(debitDate, creditDate) < source.transferDelayDays) {
      throw new Error(
        `Transfer arrival must allow ${source.transferDelayDays} configured delay day(s)`,
      );
    }

    const shared = {
      amountCents: submitted.amountCents,
      certainty: 'confirmed' as const,
      status: submitted.status,
      label: submitted.label,
      notes: submitted.notes,
    };
    const debit = forecastEventSchema.parse({
      ...currentDebit,
      ...shared,
      accountId: sourceAccountId,
      date: debitDate,
      recurrenceRule: editingDebit ? submitted.recurrenceRule : currentDebit.recurrenceRule,
      recurrenceEndDate: editingDebit
        ? submitted.recurrenceEndDate
        : currentDebit.recurrenceEndDate,
    });
    const credit = forecastEventSchema.parse({
      ...currentCredit,
      ...shared,
      accountId: destinationAccountId,
      date: creditDate,
      recurrenceRule: undefined,
      recurrenceEndDate: undefined,
    });
    for (const event of [debit, credit]) {
      const row = serializeForecastEvent(event);
      this.orm
        .insert(forecastEvents)
        .values({ ...row, createdAt: timestamp, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: forecastEvents.id,
          set: { ...row, userId, updatedAt: timestamp },
        })
        .run();
    }
    this.orm
      .insert(auditEvents)
      .values({
        id: randomUUID(),
        userId,
        action: 'update',
        entityType: 'internal-transfer',
        entityId: existing.transferId,
        payloadJson: JSON.stringify({
          editedLegId: submitted.id,
          amountCents: submitted.amountCents,
          initiationDate: debitDate,
          arrivalDate: creditDate,
        }),
        createdAt: timestamp,
      })
      .run();
    return true;
  }

  private isAppliedReceivableSettlement(event: ForecastEvent): boolean {
    return (
      event.kind === 'receivable-settlement' &&
      event.direction === 'inflow' &&
      event.certainty === 'confirmed' &&
      (event.status === 'confirmed' || event.status === 'paid') &&
      (event.paymentMethod ?? 'cash-account') === 'cash-account' &&
      event.includeInConservative !== false &&
      !event.hypothetical
    );
  }

  private ownedReceivableForSettlementSource(
    userId: string,
    sourceRecordId: string,
  ): Receivable | undefined {
    const candidates = this.orm
      .select()
      .from(receivables)
      .where(eq(receivables.userId, userId))
      .all()
      .map(deserializeReceivable);
    return receivableForSettlementSource(candidates, sourceRecordId);
  }

  private resolveReceivableSettlementAssociation(
    userId: string,
    event: ForecastEvent,
    requireOwnedSource: boolean,
    allowHistoricalRemap = !requireOwnedSource,
  ): ReceivableSettlementAssociation | undefined {
    if (event.kind !== 'receivable-settlement') return undefined;
    if (!event.sourceRecordId) {
      if (requireOwnedSource) {
        throw new Error('A receivable settlement must link to a receivable owned by this profile');
      }
      return undefined;
    }
    const receivable = this.ownedReceivableForSettlementSource(userId, event.sourceRecordId);
    if (!receivable) {
      if (requireOwnedSource) {
        throw new Error('A receivable settlement must link to a receivable owned by this profile');
      }
      return undefined;
    }
    const repeating = hasRecurringReceivableSchedule(receivable);
    if (!repeating) {
      const oneTimeAccrualOnly =
        receivable.remainingAmountCents === 0 &&
        receivable.accrualDate !== undefined &&
        (receivable.accrualAmountCents ?? 0) > 0 &&
        receivable.accrualRecurrenceRule === undefined;
      return {
        receivable,
        // The expected receipt date identifies the one cash-settlement occurrence. The accrual
        // date only controls when the amount becomes owed and may legitimately be earlier.
        occurrenceDate: receivable.expectedDate,
        usesStaticBalance: !oneTimeAccrualOnly,
      };
    }
    const scheduleEvents = receivable.settlementAnchorEventId
      ? this.orm
          .select()
          .from(forecastEvents)
          .where(eq(forecastEvents.userId, userId))
          .all()
          .map(deserializeForecastEvent)
      : [];
    const sourceOccurrence = receivableSettlementSourceOccurrenceDate(
      receivable.id,
      event.sourceRecordId,
    );
    const explicitOccurrence =
      event.receivableOccurrenceDate ??
      parseReceivableOccurrenceNote(event.notes) ??
      sourceOccurrence;
    const occurrenceDate =
      explicitOccurrence && allowHistoricalRemap
        ? resolveRecordedReceivableOccurrenceDate({
            receivable,
            events: scheduleEvents,
            settlementEvent: event,
          })
        : (explicitOccurrence ??
          resolveReceivableScheduleOccurrenceDate({
            receivable,
            events: scheduleEvents,
            settlementDate: event.date,
          }));
    if (
      requireOwnedSource &&
      explicitOccurrence &&
      !allowHistoricalRemap &&
      resolveReceivableScheduleOccurrenceDate({
        receivable,
        events: scheduleEvents,
        settlementDate: explicitOccurrence,
      }) !== explicitOccurrence
    ) {
      throw new Error('The linked receivable occurrence is not part of its recurrence schedule');
    }
    return {
      receivable,
      occurrenceDate,
      usesStaticBalance:
        receivable.originalAmountCents > 0 && occurrenceDate === receivable.expectedDate,
    };
  }

  private validateManagedReceivableSettlement(
    userId: string,
    event: ForecastEvent,
    existingEvent?: ForecastEvent,
  ): void {
    if (event.kind !== 'receivable-settlement') return;
    if (event.direction !== 'inflow') {
      throw new Error('A receivable settlement must be a cash inflow');
    }
    if ((event.paymentMethod ?? 'cash-account') !== 'cash-account' || event.recurrenceRule) {
      throw new Error(
        'Record recurring receivable timing on Money Owed; a recorded settlement must be one cash receipt',
      );
    }
    const explicitOccurrenceFor = (candidate: ForecastEvent): PlainDateString | undefined => {
      const receivable = candidate.sourceRecordId
        ? this.ownedReceivableForSettlementSource(userId, candidate.sourceRecordId)
        : undefined;
      if (!receivable) return undefined;
      const sourceOccurrence = receivableSettlementSourceOccurrenceDate(
        receivable.id,
        candidate.sourceRecordId,
      );
      return (
        candidate.receivableOccurrenceDate ??
        parseReceivableOccurrenceNote(candidate.notes) ??
        sourceOccurrence
      );
    };
    const previousOccurrence = existingEvent ? explicitOccurrenceFor(existingEvent) : undefined;
    const nextOccurrence = explicitOccurrenceFor(event);
    const preservesHistoricalIdentity =
      existingEvent?.kind === 'receivable-settlement' &&
      existingEvent.sourceRecordId === event.sourceRecordId &&
      ((previousOccurrence !== undefined && previousOccurrence === nextOccurrence) ||
        (previousOccurrence === undefined &&
          nextOccurrence === undefined &&
          existingEvent.date === event.date));
    const association = this.resolveReceivableSettlementAssociation(
      userId,
      event,
      true,
      preservesHistoricalIdentity,
    )!;
    const preservesHistoricalAccount =
      preservesHistoricalIdentity &&
      existingEvent !== undefined &&
      event.accountId === existingEvent.accountId;
    if (
      event.accountId !== association.receivable.destinationAccountId &&
      !preservesHistoricalAccount
    ) {
      throw new Error(
        'A receivable settlement must deposit into the receivable destination account',
      );
    }
    const inactive = event.status === 'cancelled' || event.status === 'skipped';
    if (!inactive && event.status !== 'confirmed' && event.status !== 'paid') {
      throw new Error(
        'Financial Records can store a confirmed or paid receivable receipt; plan future timing on Money Owed',
      );
    }
    if (inactive) return;
    const repeating = hasRecurringReceivableSchedule(association.receivable);
    const oneTimeAccrualOnly =
      !repeating &&
      association.receivable.remainingAmountCents === 0 &&
      association.receivable.accrualDate !== undefined &&
      (association.receivable.accrualAmountCents ?? 0) > 0 &&
      association.receivable.accrualRecurrenceRule === undefined;
    if (oneTimeAccrualOnly && compareDates(event.date, association.receivable.accrualDate!) < 0) {
      throw new Error('This amount is not owed until its accrual date');
    }
    if (event.amountCents <= 0) {
      throw new Error('A recorded receivable receipt must be positive');
    }
    if (
      event.certainty !== 'confirmed' ||
      event.includeInConservative === false ||
      event.hypothetical
    ) {
      throw new Error('A recorded receivable receipt must be confirmed and non-hypothetical');
    }
    if (association.usesStaticBalance) return;
    if (!repeating && !oneTimeAccrualOnly) return;

    const relatedOtherOccurrenceEvents = this.orm
      .select()
      .from(forecastEvents)
      .where(eq(forecastEvents.userId, userId))
      .all()
      .filter((row) => row.id !== event.id)
      .map(deserializeForecastEvent)
      .flatMap((candidate) => {
        const candidateAssociation = this.resolveReceivableSettlementAssociation(
          userId,
          candidate,
          false,
        );
        return candidateAssociation?.receivable.id === association.receivable.id &&
          candidateAssociation.occurrenceDate === association.occurrenceDate
          ? [candidate]
          : [];
      });
    const currentOccurrenceAmountCents = repeating
      ? (association.receivable.recurringAmountCents ?? association.receivable.originalAmountCents)
      : association.receivable.accrualAmountCents!;
    const recordedTargets = new Set(
      [event, ...relatedOtherOccurrenceEvents].flatMap((candidate) =>
        candidate.receivableOccurrenceTargetCents === undefined
          ? []
          : [candidate.receivableOccurrenceTargetCents],
      ),
    );
    if (recordedTargets.size > 1) {
      throw new Error('Recorded receipts disagree on the receivable occurrence target');
    }
    const occurrenceAmountCents = [...recordedTargets][0] ?? currentOccurrenceAmountCents;
    if (
      !preservesHistoricalIdentity &&
      relatedOtherOccurrenceEvents.length === 0 &&
      event.receivableOccurrenceTargetCents !== undefined &&
      event.receivableOccurrenceTargetCents !== currentOccurrenceAmountCents
    ) {
      throw new Error('A new receivable occurrence target must match the current schedule');
    }
    const otherSettledCents = relatedOtherOccurrenceEvents
      .filter((candidate) => this.isAppliedReceivableSettlement(candidate))
      .reduce((total, candidate) => total + candidate.amountCents, 0);
    if (otherSettledCents + event.amountCents > occurrenceAmountCents) {
      throw new Error(
        repeating
          ? 'Settlement must be no more than the open recurring occurrence amount'
          : 'Settlement must be no more than the open occurrence amount',
      );
    }
  }

  private staticReceivableSettlementEffect(
    userId: string,
    event: ForecastEvent | undefined,
  ): { receivableId: string; amountCents: number } | undefined {
    if (!event || !this.isAppliedReceivableSettlement(event)) return undefined;
    const association = this.resolveReceivableSettlementAssociation(userId, event, false);
    if (!association?.usesStaticBalance) return undefined;
    return { receivableId: association.receivable.id, amountCents: event.amountCents };
  }

  private reconcileStaticReceivableSettlementMutation(
    userId: string,
    previous: ForecastEvent | undefined,
    next: ForecastEvent | undefined,
    timestamp: string,
  ): void {
    const deltas = new Map<string, number>();
    const previousEffect = this.staticReceivableSettlementEffect(userId, previous);
    const nextEffect = this.staticReceivableSettlementEffect(userId, next);
    if (previousEffect) {
      deltas.set(
        previousEffect.receivableId,
        (deltas.get(previousEffect.receivableId) ?? 0) + previousEffect.amountCents,
      );
    }
    if (nextEffect) {
      deltas.set(
        nextEffect.receivableId,
        (deltas.get(nextEffect.receivableId) ?? 0) - nextEffect.amountCents,
      );
    }

    const updates = [...deltas.entries()].flatMap(([receivableId, delta]) => {
      if (delta === 0) return [];
      const row = this.orm
        .select()
        .from(receivables)
        .where(and(eq(receivables.id, receivableId), eq(receivables.userId, userId)))
        .get();
      if (!row) throw new Error('Settlement receivable is not available to this profile');
      const remainingAmountCents = row.remainingAmountCents + delta;
      if (remainingAmountCents < 0 || remainingAmountCents > row.originalAmountCents) {
        throw new Error('Settlement amount exceeds the open static receivable balance');
      }
      return [{ receivableId, remainingAmountCents }];
    });
    for (const update of updates) {
      this.orm
        .update(receivables)
        .set({ remainingAmountCents: update.remainingAmountCents, updatedAt: timestamp })
        .where(and(eq(receivables.id, update.receivableId), eq(receivables.userId, userId)))
        .run();
      this.orm
        .update(importLineage)
        .set({ destinationEditedAt: timestamp })
        .where(
          and(
            eq(importLineage.userId, userId),
            eq(importLineage.entityType, 'receivable'),
            eq(importLineage.entityId, update.receivableId),
          ),
        )
        .run();
    }
  }

  private assertManagedIdAvailable(
    userId: string,
    entityType: ManagedEntityType,
    entityId: string,
  ): void {
    const existing = this.raw
      .prepare(`SELECT user_id AS userId FROM ${this.managedTableName(entityType)} WHERE id = ?`)
      .get(entityId) as { userId: string } | undefined;
    if (existing && existing.userId !== userId)
      throw new Error('Record ID belongs to another profile');
  }

  private managedTableName(entityType: ManagedEntityType): string {
    const tableNames: Record<ManagedEntityType, string> = {
      'cash-account': 'cash_accounts',
      'forecast-event': 'forecast_events',
      'credit-card': 'credit_cards',
      'card-cycle': 'credit_card_cycles',
      loan: 'loans',
      receivable: 'receivables',
      asset: 'assets',
      'reward-program': 'reward_programs',
      reconciliation: 'reconciliations',
      'saved-scenario': 'saved_scenarios',
    };
    return tableNames[entityType];
  }

  private assertNoManagedDeleteDependents(
    userId: string,
    entityType: ManagedEntityType,
    entityId: string,
  ): void {
    const dependencyQueries: Array<readonly [string, string]> =
      entityType === 'cash-account'
        ? [
            ['forecast_events', 'account_id'],
            ['credit_cards', 'funding_account_id'],
            ['credit_card_cycles', 'actual_payment_account_id'],
            ['loans', 'funding_account_id'],
            ['receivables', 'destination_account_id'],
            ['reconciliations', 'account_id'],
            ['saved_scenarios', 'account_id'],
            ['committed_refinance_plans', 'cash_source_account_id'],
            ['committed_refinance_plans', 'excess_proceeds_account_id'],
          ]
        : entityType === 'credit-card'
          ? [
              ['credit_card_cycles', 'card_id'],
              ['reward_programs', 'card_id'],
              ['forecast_events', 'card_id'],
              ['saved_scenarios', 'card_id'],
            ]
          : entityType === 'loan'
            ? [
                ['forecast_events', 'source_record_id'],
                ['committed_refinance_plans', 'replacement_loan_id'],
                ['committed_refinance_payoffs', 'source_loan_id'],
              ]
            : entityType === 'card-cycle'
              ? [['forecast_events', 'source_record_id']]
              : [];
    const hasRelinkedRefinanceAsset =
      entityType === 'asset' &&
      (
        this.raw
          .prepare(
            'SELECT asset_relinks_json AS assetRelinksJson FROM committed_refinance_plans WHERE user_id = ?',
          )
          .all(userId) as Array<{ assetRelinksJson: string }>
      ).some(({ assetRelinksJson }) =>
        (JSON.parse(assetRelinksJson) as RefinanceAssetRelink[]).some(
          (relink) => relink.assetId === entityId,
        ),
      );
    const hasReceivableSettlementHistory =
      entityType === 'receivable' &&
      this.orm
        .select({ sourceRecordId: forecastEvents.sourceRecordId })
        .from(forecastEvents)
        .where(
          and(eq(forecastEvents.userId, userId), eq(forecastEvents.kind, 'receivable-settlement')),
        )
        .all()
        .some(
          ({ sourceRecordId }) =>
            sourceRecordId !== null &&
            this.ownedReceivableForSettlementSource(userId, sourceRecordId)?.id === entityId,
        );
    const hasDependents =
      hasRelinkedRefinanceAsset ||
      hasReceivableSettlementHistory ||
      dependencyQueries.some(([tableName, fieldName]) =>
        this.raw
          .prepare(`SELECT 1 FROM ${tableName} WHERE user_id = ? AND ${fieldName} = ? LIMIT 1`)
          .get(userId, entityId),
      );
    if (!hasDependents) return;
    if (entityType === 'cash-account') {
      throw new Error(
        'This cash account still has linked events, cards, loans, receivables, reconciliations, scenarios, refinance plans, or recorded statement payments. Move or delete those records first so no financial history is lost.',
      );
    }
    if (entityType === 'loan') {
      throw new Error(
        'This loan still has linked payment history or instructions, or belongs to committed refinance history. Keep the loan and mark it paid off, or remove unneeded future instructions first; recorded lineage cannot be deleted.',
      );
    }
    if (entityType === 'card-cycle') {
      throw new Error(
        'This statement cycle still has linked payment history or instructions. Keep the statement, or remove an unneeded future payment instruction first so cash timing and statement lineage stay intact.',
      );
    }
    if (entityType === 'asset') {
      throw new Error(
        'This asset belongs to committed refinance history. Keep it so refinance lineage and portable backups remain complete.',
      );
    }
    if (entityType === 'receivable') {
      throw new Error(
        'This Money Owed item has recorded receipts. Delete those receipt records first so settlement history and portable backups stay complete.',
      );
    }
    throw new Error(
      'This credit card still has linked statement history, rewards, or card-funded activity. Delete those details first so no financial history is lost.',
    );
  }

  private assertOwnedCard(userId: string, cardId: string): void {
    void this.ownedCard(userId, cardId);
  }

  private ownedCard(userId: string, cardId: string): CreditCard {
    const owned = this.orm
      .select()
      .from(creditCards)
      .where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
      .get();
    if (!owned) throw new Error('Card is not available to this profile');
    return deserializeCreditCard(owned);
  }

  private assertOwnedCardCycleForCard(userId: string, cycleId: string, cardId: string): void {
    const owned = this.orm
      .select({ id: creditCardCycles.id })
      .from(creditCardCycles)
      .innerJoin(creditCards, eq(creditCards.id, creditCardCycles.cardId))
      .where(
        and(
          eq(creditCardCycles.id, cycleId),
          eq(creditCardCycles.cardId, cardId),
          eq(creditCards.userId, userId),
        ),
      )
      .get();
    if (!owned) {
      throw new Error('Statement cycle is not available for the selected card and profile');
    }
  }

  private assertOwnedForecastEvent(userId: string, eventId: string): void {
    void this.ownedForecastEvent(userId, eventId);
  }

  private ownedForecastEvent(userId: string, eventId: string): ForecastEvent {
    const owned = this.orm
      .select()
      .from(forecastEvents)
      .where(and(eq(forecastEvents.id, eventId), eq(forecastEvents.userId, userId)))
      .get();
    if (!owned) throw new Error('Related expense is not available to this profile');
    return deserializeForecastEvent(owned);
  }

  private validateReceivableSettlementAnchor(
    receivable: Receivable,
    anchorEvent: ForecastEvent,
  ): void {
    if (
      anchorEvent.userId !== receivable.userId ||
      anchorEvent.direction !== 'outflow' ||
      !anchorEvent.recurrenceRule ||
      anchorEvent.recurrenceRule.frequency === 'once' ||
      anchorEvent.hypothetical ||
      anchorEvent.status === 'cancelled' ||
      anchorEvent.status === 'skipped'
    ) {
      throw new Error(
        'Bill-relative receipt timing requires an active non-hypothetical recurring bill outflow owned by this profile',
      );
    }
    const firstReceipt = firstAnchoredReceivableSettlementDate({
      anchorEvent,
      settlementOffsetDays: receivable.settlementOffsetDays!,
      onOrAfter: receivable.expectedDate,
    });
    if (firstReceipt !== receivable.expectedDate) {
      throw new Error(
        `The first expected receipt must match the anchored bill schedule (${firstReceipt})`,
      );
    }
  }

  private assertOwnedLoan(userId: string, loanId: string): void {
    this.ownedLoan(userId, loanId);
  }

  private reconcileLoanPaymentInstructionsForEdit(input: {
    userId: string;
    previousLoan: Loan;
    nextLoan: Loan;
    asOfDate: PlainDateString;
    timestamp: string;
  }): LoanPaymentInstructionCascade[] {
    const nextCashScheduleIsActive =
      (input.nextLoan.status ?? 'active') === 'active' &&
      input.nextLoan.includeInCashForecast !== false;
    if (!nextCashScheduleIsActive) return [];

    const linkedEvents = this.orm
      .select()
      .from(forecastEvents)
      .where(
        and(
          eq(forecastEvents.userId, input.userId),
          eq(forecastEvents.sourceRecordId, input.nextLoan.id),
        ),
      )
      .all()
      .map(deserializeForecastEvent)
      .filter((event) => event.kind === 'loan-payment');
    const cascades: LoanPaymentInstructionCascade[] = [];
    const scheduleIdentity = (loan: Loan): string =>
      JSON.stringify({
        principalCents: loan.principalCents,
        accruedInterestCents: loan.accruedInterestCents,
        balanceDate: loan.balanceDate,
        annualRateBasisPoints: loan.annualRateBasisPoints,
        accrualConvention: loan.accrualConvention,
        paymentCents: loan.paymentCents,
        cashPaymentCents: loan.cashPaymentCents ?? loan.paymentCents,
        nextPaymentDate: loan.nextPaymentDate,
        maturityDate: loan.maturityDate,
        originalDate: loan.originalDate,
        amortizationStructure: loan.amortizationStructure,
        expectedBalloonCents: loan.expectedBalloonCents,
        paymentFrequency: loan.paymentFrequency ?? 'monthly',
      });
    const scheduleChanged =
      scheduleIdentity(input.previousLoan) !== scheduleIdentity(input.nextLoan);
    const cashScheduleActivated =
      (input.previousLoan.status ?? 'active') !== 'active' ||
      input.previousLoan.includeInCashForecast === false;

    for (const event of linkedEvents) {
      const firstFutureDate = firstFutureLoanPaymentOccurrence(event, input.asOfDate);
      if (!firstFutureDate) continue;
      const futureInstruction = forecastEventSchema.parse({ ...event, date: firstFutureDate });
      const accountNeedsMigration = event.accountId !== input.nextLoan.fundingAccountId;

      if (
        (scheduleChanged || cashScheduleActivated || accountNeedsMigration) &&
        (event.loanPaymentTreatment ?? 'scheduled-draft-override') === 'scheduled-draft-override'
      ) {
        try {
          this.assertScheduledLoanDraftOccurrence(input.nextLoan, futureInstruction);
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : 'the new schedule is incompatible';
          throw new Error(
            `Cannot update ${input.nextLoan.name} while ${event.label} is still scheduled: ${detail}. Edit or cancel that future payment instruction first.`,
            { cause: error },
          );
        }
      }

      if (!accountNeedsMigration) continue;
      if (
        event.recurrenceRule &&
        event.recurrenceRule.frequency !== 'once' &&
        loanPaymentInstructionHasHistory(event, input.asOfDate)
      ) {
        const futureEventId = randomUUID();
        const futureEvent = forecastEventSchema.parse({
          ...futureInstruction,
          id: futureEventId,
          accountId: input.nextLoan.fundingAccountId,
        });
        this.orm
          .update(forecastEvents)
          .set({
            recurrenceEndDate:
              firstFutureDate === input.asOfDate ? addDays(input.asOfDate, -1) : input.asOfDate,
            updatedAt: input.timestamp,
          })
          .where(and(eq(forecastEvents.id, event.id), eq(forecastEvents.userId, input.userId)))
          .run();
        this.orm
          .insert(forecastEvents)
          .values({
            ...serializeForecastEvent(futureEvent),
            createdAt: input.timestamp,
            updatedAt: input.timestamp,
          })
          .run();
        cascades.push({
          action: 'split',
          eventId: event.id,
          futureEventId,
          fromAccountId: event.accountId,
          toAccountId: input.nextLoan.fundingAccountId,
          effectiveDate: firstFutureDate,
        });
      } else {
        this.orm
          .update(forecastEvents)
          .set({ accountId: input.nextLoan.fundingAccountId, updatedAt: input.timestamp })
          .where(and(eq(forecastEvents.id, event.id), eq(forecastEvents.userId, input.userId)))
          .run();
        cascades.push({
          action: 'move',
          eventId: event.id,
          fromAccountId: event.accountId,
          toAccountId: input.nextLoan.fundingAccountId,
          effectiveDate: firstFutureDate,
        });
      }
      this.orm
        .update(importLineage)
        .set({ destinationEditedAt: input.timestamp })
        .where(
          and(
            eq(importLineage.userId, input.userId),
            eq(importLineage.entityType, 'forecast-event'),
            eq(importLineage.entityId, event.id),
          ),
        )
        .run();
    }
    return cascades;
  }

  private ownedLoan(userId: string, loanId: string): Loan {
    const owned = this.orm
      .select()
      .from(loans)
      .where(and(eq(loans.id, loanId), eq(loans.userId, userId)))
      .get();
    if (!owned) throw new Error('Linked liability is not available to this profile');
    return deserializeLoan(owned);
  }

  private assertScheduledLoanDraftOccurrence(loan: Loan, event: ForecastEvent): void {
    if (compareDates(event.date, loan.balanceDate) <= 0) {
      throw new Error('A scheduled loan draft must be after the lender balance date');
    }
    if (
      event.recurrenceRule &&
      event.recurrenceRule.frequency !== 'once' &&
      !event.recurrenceEndDate
    ) {
      throw new Error(
        'A repeating scheduled draft override needs an end date so cash drafts stop when the loan does',
      );
    }
    const validationEnd = event.recurrenceEndDate ?? event.date;
    const explicitDates = event.recurrenceRule
      ? expandRecurrence({
          startDate: event.date,
          endDate: validationEnd,
          rule: event.recurrenceRule,
        })
      : [event.date];
    const contractualDates = new Set(
      projectLoanPayoffAtDate(loan, addDays(validationEnd, 1)).scheduledPayments.map(
        (payment) => payment.date,
      ),
    );
    const invalidDate = explicitDates.find((date) => !contractualDates.has(date));
    if (invalidDate) {
      throw new Error(
        `A scheduled draft override must land on ${loan.name}'s contractual payment schedule; ${invalidDate} is not a scheduled payment date`,
      );
    }
  }

  private assertOwnedPaymentInstrument(userId: string, paymentInstrument?: string): void {
    if (!paymentInstrument) return;
    const [kind, id] = paymentInstrument.split(':', 2);
    if (!id) return;
    if (kind === 'cash-account') this.assertOwnedAccount(userId, id);
    if (kind === 'credit-card') this.assertOwnedCard(userId, id);
  }
}
