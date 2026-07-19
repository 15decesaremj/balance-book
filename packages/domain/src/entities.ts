import { z } from 'zod';
import { moneyCentsSchema } from './money';
import {
  addDays,
  compareDates,
  daysBetween,
  plainDateSchema,
  toPlainDate,
  type PlainDateString,
} from './dates';

export const idSchema = z.string().trim().min(1).max(128);
export const userIdSchema = idSchema;

const cashAccountBaseSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  name: z.string().trim().min(1).max(120),
  type: z.enum(['checking', 'savings', 'cash', 'other']),
  openingBalanceCents: moneyCentsSchema,
  availableBalanceCents: moneyCentsSchema.optional(),
  balanceAsOf: plainDateSchema,
  includedInLiquidity: z.boolean().default(true),
  canFundOtherAccounts: z.boolean().default(true),
  hardFloorCents: moneyCentsSchema.nonnegative().optional(),
  preferredFloorCents: moneyCentsSchema.nonnegative().optional(),
  transferDelayDays: z.number().int().min(0).max(30).default(0),
  notes: z.string().trim().max(1000).optional(),
});
const validateCashAccountFloors = (
  account: { hardFloorCents?: number; preferredFloorCents?: number },
  context: z.RefinementCtx,
): void => {
  if (
    account.preferredFloorCents !== undefined &&
    account.preferredFloorCents < (account.hardFloorCents ?? 0)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['preferredFloorCents'],
      message: 'Preferred account buffer must not be below the hard account floor',
    });
  }
};
export const cashAccountSchema = cashAccountBaseSchema.superRefine(validateCashAccountFloors);
export const cashAccountInputSchema = cashAccountBaseSchema
  .omit({ userId: true })
  .superRefine(validateCashAccountFloors);
export type CashAccount = z.infer<typeof cashAccountSchema>;

export const eventKindSchema = z.enum([
  'income',
  'direct-commitment',
  'payable',
  'transfer-debit',
  'transfer-credit',
  'card-payment',
  'loan-payment',
  'receivable-settlement',
  'reward-deposit',
  'manual-adjustment',
  'baseline-spending',
  'scenario',
  'investment-contribution',
]);

export const recurrenceRuleSchema = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('once') }),
  z.object({
    frequency: z.literal('weekly'),
    interval: z.number().int().min(1).max(52).default(1),
  }),
  z.object({ frequency: z.literal('biweekly') }),
  z.object({
    frequency: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(31),
    interval: z.number().int().min(1).max(24).default(1),
  }),
  z
    .object({
      frequency: z.literal('semimonthly'),
      daysOfMonth: z.tuple([z.number().int().min(1).max(31), z.number().int().min(1).max(31)]),
    })
    .refine((rule) => rule.daysOfMonth[0] !== rule.daysOfMonth[1], {
      path: ['daysOfMonth'],
      message: 'Semimonthly deposit days must differ',
    }),
]);
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

/** Returns whether a date belongs to a recurrence anchored at the supplied first date. */
export const isRecurrenceOccurrence = (
  startDateInput: PlainDateString,
  candidateDateInput: PlainDateString,
  ruleInput: RecurrenceRule,
): boolean => {
  const startDate = plainDateSchema.parse(startDateInput);
  const candidateDate = plainDateSchema.parse(candidateDateInput);
  const rule = recurrenceRuleSchema.parse(ruleInput);
  if (compareDates(candidateDate, startDate) < 0) return false;
  if (rule.frequency === 'once') return candidateDate === startDate;
  if (rule.frequency === 'weekly' || rule.frequency === 'biweekly') {
    const intervalDays = rule.frequency === 'biweekly' ? 14 : rule.interval * 7;
    return daysBetween(startDate, candidateDate) % intervalDays === 0;
  }

  const start = toPlainDate(startDate);
  const candidate = toPlainDate(candidateDate);
  if (rule.frequency === 'monthly') {
    const monthOffset = (candidate.year - start.year) * 12 + candidate.month - start.month;
    return (
      monthOffset >= 0 &&
      monthOffset % rule.interval === 0 &&
      candidate.day === Math.min(rule.dayOfMonth, candidate.daysInMonth)
    );
  }

  return rule.daysOfMonth.some(
    (dayOfMonth) => candidate.day === Math.min(dayOfMonth, candidate.daysInMonth),
  );
};

export const cardActivityTreatmentSchema = z.enum(['additional', 'included-in-cycle-total']);
export type CardActivityTreatment = z.infer<typeof cardActivityTreatmentSchema>;

/**
 * A linked installment-loan cash event has one of two deliberately different jobs.
 * A scheduled draft override reconciles cash timing only; additional principal changes debt.
 */
export const loanPaymentTreatmentSchema = z.enum([
  'scheduled-draft-override',
  'additional-principal',
]);
export type LoanPaymentTreatment = z.infer<typeof loanPaymentTreatmentSchema>;

export const incomeTypeSchema = z.enum([
  'paycheck',
  'bonus',
  'commission',
  'self-employment',
  'partner-contribution',
  'raise-adjustment',
  'other',
]);
export type IncomeType = z.infer<typeof incomeTypeSchema>;

const forecastEventBaseSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  accountId: idSchema,
  date: plainDateSchema,
  kind: eventKindSchema,
  direction: z.enum(['inflow', 'outflow']),
  amountCents: moneyCentsSchema.nonnegative(),
  certainty: z.enum(['confirmed', 'expected', 'uncertain']).default('confirmed'),
  status: z
    .enum(['planned', 'scheduled', 'confirmed', 'paid', 'cancelled', 'skipped'])
    .default('planned'),
  label: z.string().trim().min(1).max(240),
  manualOrder: z.number().int().optional(),
  sourceRecordId: idSchema.optional(),
  transferId: idSchema.optional(),
  hypothetical: z.boolean().default(false),
  accepted: z.boolean().default(false),
  includeInConservative: z.boolean().optional(),
  recurrenceRule: recurrenceRuleSchema.optional(),
  recurrenceEndDate: plainDateSchema.optional(),
  paymentMethod: z.enum(['cash-account', 'credit-card', 'payroll-deduction']).optional(),
  cardId: idSchema.optional(),
  cardActivityTreatment: cardActivityTreatmentSchema.default('additional').optional(),
  loanPaymentTreatment: loanPaymentTreatmentSchema.optional(),
  incomeType: incomeTypeSchema.optional(),
  parentIncomeEventId: idSchema.optional(),
  incomePlanId: idSchema.optional(),
  incomeStreamId: idSchema.optional(),
  incomePlanTotalCents: moneyCentsSchema.positive().optional(),
  incomeNominalDate: plainDateSchema.optional(),
  incomeArrivalOffsetDays: z.number().int().min(-31).max(31).optional(),
  incomeAllocationRule: z.enum(['fixed', 'remainder']).optional(),
  incomeAllocationOrder: z.number().int().nonnegative().optional(),
  parentIncomePlanId: idSchema.optional(),
  receivableOccurrenceDate: plainDateSchema.optional(),
  receivableOccurrenceTargetCents: moneyCentsSchema.positive().optional(),
  notes: z.string().trim().max(1000).optional(),
});
const validateForecastEvent = (
  event: Pick<
    z.infer<typeof forecastEventBaseSchema>,
    | 'date'
    | 'recurrenceEndDate'
    | 'kind'
    | 'direction'
    | 'incomeType'
    | 'parentIncomeEventId'
    | 'recurrenceRule'
    | 'incomePlanId'
    | 'incomeStreamId'
    | 'incomePlanTotalCents'
    | 'incomeNominalDate'
    | 'incomeArrivalOffsetDays'
    | 'incomeAllocationRule'
    | 'incomeAllocationOrder'
    | 'parentIncomePlanId'
    | 'receivableOccurrenceDate'
    | 'receivableOccurrenceTargetCents'
  >,
  context: z.RefinementCtx,
): void => {
  if (
    event.recurrenceEndDate &&
    event.recurrenceEndDate < (event.incomeNominalDate ?? event.date)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['recurrenceEndDate'],
      message: 'Recurrence end date cannot precede the first occurrence',
    });
  }
  if (event.incomeType && (event.kind !== 'income' || event.direction !== 'inflow')) {
    context.addIssue({
      code: 'custom',
      path: ['incomeType'],
      message: 'Income type is only valid on an income inflow',
    });
  }
  if (event.parentIncomeEventId && event.incomeType !== 'raise-adjustment') {
    context.addIssue({
      code: 'custom',
      path: ['parentIncomeEventId'],
      message: 'Only a raise adjustment can link to a base income stream',
    });
  }
  const incomePlanFields = [
    event.incomePlanId,
    event.incomePlanTotalCents,
    event.incomeNominalDate,
    event.incomeArrivalOffsetDays,
    event.incomeAllocationRule,
  ];
  const hasAnyIncomePlanField = incomePlanFields.some((value) => value !== undefined);
  const hasEveryIncomePlanField = incomePlanFields.every((value) => value !== undefined);
  if (hasAnyIncomePlanField && !hasEveryIncomePlanField) {
    context.addIssue({
      code: 'custom',
      path: ['incomePlanId'],
      message:
        'Grouped income requires a plan ID, total, nominal payday, arrival offset, and allocation rule',
    });
  }
  if (hasAnyIncomePlanField && (event.kind !== 'income' || event.direction !== 'inflow')) {
    context.addIssue({
      code: 'custom',
      path: ['incomePlanId'],
      message: 'Income plan metadata is only valid on an income inflow',
    });
  }
  if (hasAnyIncomePlanField && !event.incomeType) {
    context.addIssue({
      code: 'custom',
      path: ['incomeType'],
      message: 'Grouped income requires an income type',
    });
  }
  if (event.incomeAllocationOrder !== undefined && !hasEveryIncomePlanField) {
    context.addIssue({
      code: 'custom',
      path: ['incomeAllocationOrder'],
      message: 'Income allocation order is only valid on grouped income',
    });
  }
  if (event.incomeStreamId && !event.incomePlanId) {
    context.addIssue({
      code: 'custom',
      path: ['incomeStreamId'],
      message: 'An income stream phase must belong to a grouped income plan',
    });
  }
  if (
    hasEveryIncomePlanField &&
    event.date !== addDays(event.incomeNominalDate!, event.incomeArrivalOffsetDays!)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['date'],
      message: 'First arrival must equal the nominal payday plus its account timing offset',
    });
  }
  if (event.parentIncomePlanId && event.incomeType !== 'raise-adjustment') {
    context.addIssue({
      code: 'custom',
      path: ['parentIncomePlanId'],
      message: 'Only a raise adjustment can link to a base income plan',
    });
  }
  if (event.parentIncomePlanId && !event.incomePlanId) {
    context.addIssue({
      code: 'custom',
      path: ['parentIncomePlanId'],
      message: 'A plan-linked raise must belong to a grouped income plan',
    });
  }
  if (
    (event.receivableOccurrenceDate !== undefined ||
      event.receivableOccurrenceTargetCents !== undefined) &&
    (event.kind !== 'receivable-settlement' || event.direction !== 'inflow')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['receivableOccurrenceDate'],
      message: 'Receivable occurrence metadata is only valid on a receivable settlement inflow',
    });
  }
  if (
    event.receivableOccurrenceTargetCents !== undefined &&
    event.receivableOccurrenceDate === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['receivableOccurrenceTargetCents'],
      message: 'A receivable occurrence target requires an occurrence date',
    });
  }
  if (
    hasEveryIncomePlanField &&
    event.recurrenceRule?.frequency === 'semimonthly' &&
    !isRecurrenceOccurrence(
      event.incomeNominalDate!,
      event.incomeNominalDate!,
      event.recurrenceRule,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['incomeNominalDate'],
      message: 'Official payday must be one of the semimonthly schedule dates',
    });
  }
};
export const forecastEventSchema = forecastEventBaseSchema.superRefine(validateForecastEvent);
const validateForecastEventCardLink = (
  event: Pick<
    z.infer<typeof forecastEventBaseSchema>,
    'kind' | 'direction' | 'paymentMethod' | 'cardId'
  >,
  context: z.RefinementCtx,
): void => {
  if (event.paymentMethod === 'credit-card' && !event.cardId) {
    context.addIssue({
      code: 'custom',
      path: ['cardId'],
      message: 'Card-funded activity requires a credit card',
    });
  }
  if (event.kind !== 'card-payment') return;
  if (!event.cardId) {
    context.addIssue({
      code: 'custom',
      path: ['cardId'],
      message: 'A card payment must identify the card being paid',
    });
  }
  if (event.paymentMethod !== 'cash-account') {
    context.addIssue({
      code: 'custom',
      path: ['paymentMethod'],
      message: 'A card payment must leave a cash account',
    });
  }
  if (event.direction !== 'outflow') {
    context.addIssue({
      code: 'custom',
      path: ['direction'],
      message: 'A card payment must be a cash outflow',
    });
  }
};
const validateForecastEventLoanLink = (
  event: Pick<
    z.infer<typeof forecastEventBaseSchema>,
    | 'kind'
    | 'sourceRecordId'
    | 'direction'
    | 'paymentMethod'
    | 'amountCents'
    | 'loanPaymentTreatment'
  >,
  context: z.RefinementCtx,
): void => {
  if (event.kind !== 'loan-payment') {
    if (event.loanPaymentTreatment !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['loanPaymentTreatment'],
        message: 'Loan-payment treatment is only valid on an installment-loan payment',
      });
    }
    return;
  }
  if (!event.sourceRecordId) {
    context.addIssue({
      code: 'custom',
      path: ['sourceRecordId'],
      message: 'A loan payment must identify the installment loan it reduces',
    });
  }
  if (event.direction !== 'outflow') {
    context.addIssue({
      code: 'custom',
      path: ['direction'],
      message: 'An installment-loan payment must be a cash outflow',
    });
  }
  if (event.paymentMethod !== 'cash-account') {
    context.addIssue({
      code: 'custom',
      path: ['paymentMethod'],
      message: 'An installment-loan payment must leave a cash account',
    });
  }
  if (event.amountCents <= 0) {
    context.addIssue({
      code: 'custom',
      path: ['amountCents'],
      message: 'An installment-loan payment must be greater than zero',
    });
  }
};
export const forecastEventInputSchema = forecastEventBaseSchema
  .omit({ userId: true })
  .superRefine(validateForecastEvent)
  .superRefine(validateForecastEventCardLink)
  .superRefine(validateForecastEventLoanLink);
export type ForecastEvent = z.infer<typeof forecastEventSchema>;

const samePlanValue = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * A grouped income plan is persisted as one forecast-event leg per destination account. This
 * assertion keeps the denormalized legs equivalent to one atomic plan and prevents a split from
 * silently creating or destroying income.
 */
export const assertValidIncomePlanGroups = (input: ForecastEvent[]): void => {
  const events = input.map((event) => forecastEventSchema.parse(event));
  const groups = new Map<string, ForecastEvent[]>();
  for (const event of events) {
    if (!event.incomePlanId) continue;
    const group = groups.get(event.incomePlanId) ?? [];
    group.push(event);
    groups.set(event.incomePlanId, group);
  }
  for (const [planId, group] of groups) {
    const first = group[0]!;
    if (group.some((event) => event.amountCents <= 0)) {
      throw new Error(`Income plan ${planId} allocations must be greater than zero`);
    }
    if (new Set(group.map((event) => event.id)).size !== group.length) {
      throw new Error(`Income plan ${planId} contains duplicate allocation IDs`);
    }
    if (new Set(group.map((event) => event.accountId)).size !== group.length) {
      throw new Error(`Income plan ${planId} may allocate to each account only once`);
    }
    const allocationOrders = group
      .map((event) => event.incomeAllocationOrder)
      .filter((order): order is number => order !== undefined);
    if (new Set(allocationOrders).size !== allocationOrders.length) {
      throw new Error(`Income plan ${planId} contains duplicate allocation order values`);
    }
    if (group.filter((event) => event.incomeAllocationRule === 'remainder').length > 1) {
      throw new Error(`Income plan ${planId} may contain only one remainder allocation`);
    }
    const sharedFields: Array<keyof ForecastEvent> = [
      'userId',
      'incomeType',
      'incomeStreamId',
      'incomePlanTotalCents',
      'incomeNominalDate',
      'parentIncomePlanId',
      'certainty',
      'status',
      'recurrenceRule',
      'recurrenceEndDate',
      'includeInConservative',
      'hypothetical',
      'accepted',
      'notes',
    ];
    for (const field of sharedFields) {
      if (group.some((event) => samePlanValue(event[field]) !== samePlanValue(first[field]))) {
        throw new Error(`Income plan ${planId} has inconsistent ${field}`);
      }
    }
    if (
      group.some(
        (event) =>
          event.kind !== 'income' ||
          event.direction !== 'inflow' ||
          event.paymentMethod !== 'cash-account' ||
          event.cardId !== undefined ||
          event.parentIncomeEventId !== undefined,
      )
    ) {
      throw new Error(`Income plan ${planId} contains a non-cash income allocation`);
    }
    if (first.parentIncomePlanId === planId) {
      throw new Error(`Income plan ${planId} cannot be its own parent`);
    }
    const total = group.reduce((sum, event) => sum + event.amountCents, 0);
    if (total !== first.incomePlanTotalCents) {
      throw new Error(
        `Income plan ${planId} allocations total ${total} cents, expected ${first.incomePlanTotalCents} cents`,
      );
    }
  }

  const streams = new Map<
    string,
    Array<{
      planId: string;
      streamId: string;
      first: ForecastEvent;
      startDate: PlainDateString;
      endDate?: PlainDateString;
    }>
  >();
  for (const [planId, group] of groups) {
    const first = group[0]!;
    if (!first.incomeStreamId || first.status === 'cancelled' || first.status === 'skipped') {
      continue;
    }
    const streamKey = `${first.userId}:${first.incomeStreamId}`;
    const startDate = first.incomeNominalDate!;
    const recurring =
      first.recurrenceRule !== undefined && first.recurrenceRule.frequency !== 'once';
    const phase = {
      planId,
      streamId: first.incomeStreamId,
      first,
      startDate,
      endDate: recurring ? first.recurrenceEndDate : startDate,
    };
    streams.set(streamKey, [...(streams.get(streamKey) ?? []), phase]);
  }
  for (const phases of streams.values()) {
    const sorted = [...phases].sort(
      (left, right) =>
        compareDates(left.startDate, right.startDate) || left.planId.localeCompare(right.planId),
    );
    const firstPhase = sorted[0]!;
    for (const phase of sorted) {
      if (
        phase.first.incomeType !== firstPhase.first.incomeType ||
        samePlanValue(phase.first.recurrenceRule) !== samePlanValue(firstPhase.first.recurrenceRule)
      ) {
        throw new Error(
          `Income stream ${phase.streamId} must keep one income type and recurrence cadence across routing phases`,
        );
      }
    }
    if (firstPhase.first.recurrenceRule && firstPhase.first.recurrenceRule.frequency !== 'once') {
      for (const phase of sorted.slice(1)) {
        if (
          !isRecurrenceOccurrence(
            firstPhase.startDate,
            phase.startDate,
            firstPhase.first.recurrenceRule,
          )
        ) {
          throw new Error(
            `Income stream ${phase.streamId} routing phase ${phase.planId} must begin on an official payday`,
          );
        }
      }
    }
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (!previous.endDate || compareDates(current.startDate, previous.endDate) <= 0) {
        throw new Error(
          `Income stream ${current.streamId} has overlapping routing phases ${previous.planId} and ${current.planId}`,
        );
      }
    }
  }
};

export const cashFloorPolicySchema = z
  .object({
    hardConsolidatedFloorCents: moneyCentsSchema.nonnegative(),
    preferredConsolidatedFloorCents: moneyCentsSchema.nonnegative().optional(),
    horizonDays: z.number().int().min(1).max(730).default(90),
    includeConfirmedReceivablesConservatively: z.boolean().default(true),
  })
  .superRefine((policy, context) => {
    if (
      policy.preferredConsolidatedFloorCents !== undefined &&
      policy.preferredConsolidatedFloorCents < policy.hardConsolidatedFloorCents
    ) {
      context.addIssue({
        code: 'custom',
        path: ['preferredConsolidatedFloorCents'],
        message: 'Preferred consolidated buffer must not be below the hard floor',
      });
    }
  });
export type CashFloorPolicy = z.infer<typeof cashFloorPolicySchema>;

export const creditCardCycleSchema = z
  .object({
    id: idSchema,
    cardId: idSchema,
    opensOn: plainDateSchema,
    closesOn: plainDateSchema,
    dueOn: plainDateSchema,
    state: z.enum(['future-estimated', 'open', 'closed-statement', 'scheduled-payment', 'paid']),
    defaultEstimateCents: moneyCentsSchema,
    actualActivityCents: moneyCentsSchema.default(0),
    plannedActivityCents: moneyCentsSchema.default(0),
    lockedStatementCents: moneyCentsSchema.optional(),
    projectionOverrideCents: moneyCentsSchema.optional(),
    paymentOn: plainDateSchema.optional(),
    /** Actual cash received by the issuer for this statement. Paid legacy rows may omit it. */
    actualPaymentCents: moneyCentsSchema.nonnegative().optional(),
  })
  .superRefine((cycle, context) => {
    if (compareDates(cycle.opensOn, cycle.closesOn) > 0) {
      context.addIssue({
        code: 'custom',
        path: ['closesOn'],
        message: 'A card cycle cannot close before it opens',
      });
    }
    if (compareDates(cycle.closesOn, cycle.dueOn) > 0) {
      context.addIssue({
        code: 'custom',
        path: ['dueOn'],
        message: 'A card payment cannot be due before its statement closes',
      });
    }
    if (cycle.paymentOn && compareDates(cycle.closesOn, cycle.paymentOn) > 0) {
      context.addIssue({
        code: 'custom',
        path: ['paymentOn'],
        message: 'A card payment date cannot precede its statement close',
      });
    }
    if (
      (cycle.state === 'closed-statement' || cycle.state === 'scheduled-payment') &&
      cycle.lockedStatementCents === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lockedStatementCents'],
        message: 'A locked statement amount is required for closed or scheduled card cycles',
      });
    }
    if (cycle.actualPaymentCents !== undefined && cycle.state !== 'paid') {
      context.addIssue({
        code: 'custom',
        path: ['actualPaymentCents'],
        message: 'An actual card payment is only valid after the cycle is marked paid',
      });
    }
    if (cycle.actualPaymentCents !== undefined && cycle.paymentOn === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['paymentOn'],
        message: 'An actual card payment requires its payment date',
      });
    }
  });
export type CreditCardCycle = z.infer<typeof creditCardCycleSchema>;

const creditCardBaseSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  name: z.string().trim().min(1).max(120),
  issuer: z.string().trim().min(1).max(120).optional(),
  lastFour: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Last four must contain exactly four digits')
    .optional(),
  fundingAccountId: idSchema,
  accountKind: z.enum(['credit-card', 'charge-card', 'line-of-credit']).default('credit-card'),
  creditLimitCents: moneyCentsSchema.nonnegative().optional(),
  /** Optional issuer-reported total balance snapshot; cycle math remains separately auditable. */
  reportedBalanceCents: moneyCentsSchema.nonnegative().optional(),
  reportedBalanceDate: plainDateSchema.optional(),
  /** Optional issuer-reported balance carried past a due date. */
  reportedCarryingBalanceCents: moneyCentsSchema.nonnegative().optional(),
  reportedCarryingBalanceDate: plainDateSchema.optional(),
  defaultFutureStatementCents: moneyCentsSchema,
  estimatePolicy: z.enum(['actual-reset', 'baseline-guardrail']),
  paymentPolicy: z.enum(['full-statement', 'minimum', 'fixed', 'manual']),
  fixedPaymentCents: moneyCentsSchema.optional(),
  minimumPaymentCents: moneyCentsSchema.optional(),
  aprBasisPoints: z.number().int().min(0).max(100_000).optional(),
  promotionEndDate: plainDateSchema.optional(),
  paymentDayOfMonth: z.number().int().min(1).max(31).optional(),
  statementCloseDayOfMonth: z.number().int().min(1).max(31).optional(),
  status: z.enum(['active', 'closed']).default('active'),
  closedOn: plainDateSchema.optional(),
});

const validateCreditCardPaymentTerms = (
  card: {
    paymentPolicy: 'full-statement' | 'minimum' | 'fixed' | 'manual';
    fixedPaymentCents?: number;
    minimumPaymentCents?: number;
    reportedBalanceCents?: number;
    reportedBalanceDate?: PlainDateString;
    reportedCarryingBalanceCents?: number;
    reportedCarryingBalanceDate?: PlainDateString;
    status: 'active' | 'closed';
    closedOn?: PlainDateString;
  },
  context: z.RefinementCtx,
): void => {
  if (card.paymentPolicy === 'minimum' && (card.minimumPaymentCents ?? 0) <= 0) {
    context.addIssue({
      code: 'custom',
      path: ['minimumPaymentCents'],
      message: 'A positive minimum payment amount is required for the minimum payment policy',
    });
  }
  if (card.paymentPolicy === 'fixed' && (card.fixedPaymentCents ?? 0) <= 0) {
    context.addIssue({
      code: 'custom',
      path: ['fixedPaymentCents'],
      message: 'A positive fixed payment amount is required for the fixed payment policy',
    });
  }
  if ((card.reportedBalanceCents === undefined) !== (card.reportedBalanceDate === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['reportedBalanceDate'],
      message: 'A reported card balance and its as-of date must be entered together',
    });
  }
  if (
    (card.reportedCarryingBalanceCents === undefined) !==
    (card.reportedCarryingBalanceDate === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['reportedCarryingBalanceDate'],
      message: 'A reported carrying balance and its as-of date must be entered together',
    });
  }
  if (card.status === 'closed' && card.closedOn === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['closedOn'],
      message: 'A closed card requires its closure date',
    });
  }
  if (card.status === 'active' && card.closedOn !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['closedOn'],
      message: 'An active card cannot retain a closure date',
    });
  }
};

export const creditCardSchema = creditCardBaseSchema.superRefine(validateCreditCardPaymentTerms);
export const creditCardInputSchema = creditCardBaseSchema
  .omit({ userId: true })
  .superRefine(validateCreditCardPaymentTerms);
export type CreditCard = z.infer<typeof creditCardSchema>;

export const loanAmortizationStructureSchema = z.enum(['fully-amortizing', 'balloon']);
export type LoanAmortizationStructure = z.infer<typeof loanAmortizationStructureSchema>;

export const loanInferredFieldSchema = z.enum([
  'principalCents',
  'accruedInterestCents',
  'balanceDate',
  'annualRateBasisPoints',
  'accrualConvention',
  'paymentCents',
  'cashPaymentCents',
  'nextPaymentDate',
  'maturityDate',
  'originalPrincipalCents',
  'originalDate',
  'originalTermMonths',
  'paymentFrequency',
  'expectedBalloonCents',
]);
export type LoanInferredField = z.infer<typeof loanInferredFieldSchema>;

const loanBaseSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  name: z.string().trim().min(1).max(120),
  lender: z.string().trim().min(1).max(120).optional(),
  loanType: z.string().trim().min(1).max(120).optional(),
  principalCents: moneyCentsSchema.nonnegative(),
  accruedInterestCents: moneyCentsSchema.nonnegative().default(0),
  balanceDate: plainDateSchema,
  annualRateBasisPoints: z.number().int().min(0).max(100_000),
  accrualConvention: z.enum(['actual-365', 'actual-360', 'monthly']),
  paymentCents: moneyCentsSchema.nonnegative(),
  /** Total cash draft when taxes, insurance, or other non-debt items differ from debt service. */
  cashPaymentCents: moneyCentsSchema.nonnegative().optional(),
  nextPaymentDate: plainDateSchema,
  maturityDate: plainDateSchema.optional(),
  originalPrincipalCents: moneyCentsSchema.nonnegative().optional(),
  originalDate: plainDateSchema.optional(),
  originalTermMonths: z.number().int().min(1).max(1_200).optional(),
  amortizationStructure: loanAmortizationStructureSchema.default('fully-amortizing'),
  /** Contractual principal/interest residual due beyond the regular payment at maturity. */
  expectedBalloonCents: moneyCentsSchema.positive().optional(),
  inferredFields: z.array(loanInferredFieldSchema).max(14).optional(),
  fundingAccountId: idSchema,
  excludeFromEconomicNetWorthDoubleCount: z.boolean().default(false),
  paymentFrequency: z.enum(['monthly', 'biweekly']).optional(),
  includeInCashForecast: z.boolean().optional(),
  status: z.enum(['active', 'paid-off']).optional(),
});

const validateLoanTerms = (
  loan: {
    cashPaymentCents?: number;
    paymentCents: number;
    principalCents: number;
    accruedInterestCents: number;
    status?: 'active' | 'paid-off';
    inferredFields?: LoanInferredField[];
    originalDate?: PlainDateString;
    balanceDate: PlainDateString;
    maturityDate?: PlainDateString;
    amortizationStructure: LoanAmortizationStructure;
    expectedBalloonCents?: number;
  },
  context: z.RefinementCtx,
): void => {
  if (
    loan.inferredFields !== undefined &&
    new Set(loan.inferredFields).size !== loan.inferredFields.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['inferredFields'],
      message: 'Calculated loan fields cannot contain duplicates',
    });
  }
  if (loan.cashPaymentCents !== undefined && loan.cashPaymentCents < loan.paymentCents) {
    context.addIssue({
      code: 'custom',
      path: ['cashPaymentCents'],
      message: 'The total cash payment cannot be below the amount applied to debt',
    });
  }
  if (loan.originalDate && compareDates(loan.originalDate, loan.balanceDate) > 0) {
    context.addIssue({
      code: 'custom',
      path: ['originalDate'],
      message: 'The origination date cannot be after the lender balance date',
    });
  }
  if (
    loan.maturityDate &&
    (loan.status ?? 'active') === 'active' &&
    loan.principalCents + loan.accruedInterestCents > 0 &&
    compareDates(loan.maturityDate, loan.balanceDate) < 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['maturityDate'],
      message: 'The maturity date cannot be before the lender balance date',
    });
  }
  if (
    loan.amortizationStructure === 'fully-amortizing' &&
    loan.expectedBalloonCents !== undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expectedBalloonCents'],
      message: 'A fully amortizing loan cannot retain a contractual balloon amount',
    });
  }
  if (loan.amortizationStructure === 'balloon' && loan.maturityDate === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['maturityDate'],
      message: 'A balloon or bullet loan requires a contractual maturity date',
    });
  }
};

export const loanSchema = loanBaseSchema.superRefine(validateLoanTerms);
export const loanInputSchema = loanBaseSchema.omit({ userId: true }).superRefine(validateLoanTerms);
export type Loan = z.infer<typeof loanSchema>;

export const refinancePayoffSchema = z.object({
  sourceLoanId: idSchema,
  payoffAmountCents: moneyCentsSchema.positive(),
  /** The committed refinance plan that originated this source loan, when it was refinanced before. */
  sourceRefinancePlanId: idSchema.optional(),
});
export type RefinancePayoff = z.infer<typeof refinancePayoffSchema>;

export const refinanceAssetRelinkSchema = z.object({
  assetId: idSchema,
  sourceLoanId: idSchema,
  replacementLoanId: idSchema,
});
export type RefinanceAssetRelink = z.infer<typeof refinanceAssetRelinkSchema>;

/** Shared persistence ceiling for profile assets and refinance collateral lineage. */
export const maximumProfileAssetRecords = 50_000;

const committedRefinancePlanBaseSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  name: z.string().trim().min(1).max(120),
  status: z.enum(['committed', 'cancelled']),
  closingDate: plainDateSchema,
  payoffDate: plainDateSchema,
  firstPaymentDate: plainDateSchema,
  payoffs: z.array(refinancePayoffSchema).min(1).max(100),
  /** The replacement debt snapshot. Its ID is the durable link used by later stacked refinances. */
  replacementLoan: loanSchema,
  /** Immutable offer terms retained even after the current replacement-loan balance is updated. */
  replacementLoanSnapshot: loanSchema.optional(),
  /** Collateral links moved by this commitment so cancellation and backup restore are reversible. */
  assetRelinks: z.array(refinanceAssetRelinkSchema).max(maximumProfileAssetRecords).optional(),
  /** Cash applied to principal/payoffs, excluding cash-paid closing fees. */
  principalCashContributionCents: moneyCentsSchema.nonnegative().default(0),
  closingCostsCents: moneyCentsSchema.nonnegative().default(0),
  financedFeesCents: moneyCentsSchema.nonnegative().default(0),
  /** Pays principal cash contribution plus any closing costs that are not financed. */
  cashSourceAccountId: idSchema.optional(),
  excessProceedsCents: moneyCentsSchema.nonnegative().default(0),
  excessProceedsAccountId: idSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});

const validateCommittedRefinancePlan = (
  plan: z.infer<typeof committedRefinancePlanBaseSchema>,
  context: z.RefinementCtx,
  validateCommittedLoanTerms: boolean,
): void => {
  if (compareDates(plan.closingDate, plan.payoffDate) > 0) {
    context.addIssue({
      code: 'custom',
      path: ['payoffDate'],
      message: 'The payoff date cannot precede the refinance closing date',
    });
  }
  if (compareDates(plan.firstPaymentDate, plan.closingDate) <= 0) {
    context.addIssue({
      code: 'custom',
      path: ['firstPaymentDate'],
      message: 'The replacement loan first payment must be after the refinance closing date',
    });
  }
  if (daysBetween(plan.closingDate, plan.payoffDate) > 366) {
    context.addIssue({
      code: 'custom',
      path: ['payoffDate'],
      message: 'The refinance payoff must settle within one year of closing',
    });
  }
  if (daysBetween(plan.closingDate, plan.firstPaymentDate) > 366) {
    context.addIssue({
      code: 'custom',
      path: ['firstPaymentDate'],
      message: 'The replacement loan first payment must be within one year of closing',
    });
  }
  if (plan.replacementLoan.userId !== plan.userId) {
    context.addIssue({
      code: 'custom',
      path: ['replacementLoan', 'userId'],
      message: 'The replacement loan must belong to the same profile as the refinance plan',
    });
  }
  if (validateCommittedLoanTerms) {
    if (plan.replacementLoan.balanceDate !== plan.closingDate) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'balanceDate'],
        message: 'The replacement loan balance date must equal the refinance closing date',
      });
    }
    if (plan.replacementLoan.nextPaymentDate !== plan.firstPaymentDate) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'nextPaymentDate'],
        message:
          'The replacement loan next payment date must equal the refinance first payment date',
      });
    }
    if (
      plan.replacementLoan.originalDate !== undefined &&
      plan.replacementLoan.originalDate !== plan.closingDate
    ) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'originalDate'],
        message: 'The replacement loan original date must equal the refinance closing date',
      });
    }
    if (plan.replacementLoan.principalCents <= 0) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'principalCents'],
        message: 'The replacement loan principal must be greater than zero',
      });
    }
    if (plan.replacementLoan.paymentCents <= 0) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'paymentCents'],
        message: 'The replacement loan payment must be greater than zero',
      });
    }
    if (plan.replacementLoan.status === 'paid-off') {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'status'],
        message: 'A committed replacement loan cannot begin as paid off',
      });
    }
    if (plan.replacementLoan.includeInCashForecast === false) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'includeInCashForecast'],
        message: 'A committed replacement loan must be included in the cash forecast',
      });
    }
    if (
      plan.replacementLoan.maturityDate &&
      compareDates(plan.replacementLoan.maturityDate, plan.firstPaymentDate) < 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'maturityDate'],
        message: 'The replacement loan maturity cannot precede its first payment',
      });
    }
    if (
      plan.replacementLoan.maturityDate &&
      daysBetween(plan.firstPaymentDate, plan.replacementLoan.maturityDate) > 18_300
    ) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'maturityDate'],
        message: 'The replacement loan term cannot exceed 600 months',
      });
    }
  }

  const sourceLoanIds = plan.payoffs.map((payoff) => payoff.sourceLoanId);
  if (new Set(sourceLoanIds).size !== sourceLoanIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['payoffs'],
      message: 'Each source loan may appear only once in a refinance plan',
    });
  }
  if (sourceLoanIds.includes(plan.replacementLoan.id)) {
    context.addIssue({
      code: 'custom',
      path: ['replacementLoan', 'id'],
      message: 'The replacement loan cannot also be one of its own payoff loans',
    });
  }
  const assetRelinks = plan.assetRelinks ?? [];
  const assetRelinkIds = assetRelinks.map((relink) => relink.assetId);
  if (new Set(assetRelinkIds).size !== assetRelinkIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['assetRelinks'],
      message: 'Each asset may be relinked only once by a refinance plan',
    });
  }
  for (const [index, relink] of assetRelinks.entries()) {
    if (relink.replacementLoanId !== plan.replacementLoan.id) {
      context.addIssue({
        code: 'custom',
        path: ['assetRelinks', index, 'replacementLoanId'],
        message: "Asset relink must point to this plan's replacement loan",
      });
    }
    if (!sourceLoanIds.includes(relink.sourceLoanId)) {
      context.addIssue({
        code: 'custom',
        path: ['assetRelinks', index, 'sourceLoanId'],
        message: "Asset relink source must be one of this plan's payoff loans",
      });
    }
  }
  if (plan.financedFeesCents > plan.closingCostsCents) {
    context.addIssue({
      code: 'custom',
      path: ['financedFeesCents'],
      message: 'Financed fees cannot exceed total closing costs',
    });
  }

  const totalPayoffCents = plan.payoffs.reduce(
    (total, payoff) => total + payoff.payoffAmountCents,
    0,
  );
  const expectedPrincipalCents =
    totalPayoffCents -
    plan.principalCashContributionCents +
    plan.financedFeesCents +
    plan.excessProceedsCents;
  if (validateCommittedLoanTerms) {
    if (plan.replacementLoan.principalCents !== expectedPrincipalCents) {
      context.addIssue({
        code: 'custom',
        path: ['replacementLoan', 'principalCents'],
        message:
          'Replacement principal must equal payoffs minus principal cash contribution plus financed fees and excess proceeds',
      });
    }
  }
  if (plan.principalCashContributionCents > totalPayoffCents) {
    context.addIssue({
      code: 'custom',
      path: ['principalCashContributionCents'],
      message: 'Principal cash contribution cannot exceed the source loan payoffs',
    });
  }

  const cashPaidFeesCents = plan.closingCostsCents - plan.financedFeesCents;
  const closingCashOutflowCents = plan.principalCashContributionCents + cashPaidFeesCents;
  if (closingCashOutflowCents > 0 && !plan.cashSourceAccountId) {
    context.addIssue({
      code: 'custom',
      path: ['cashSourceAccountId'],
      message: 'Choose the bank account that will fund the closing cash outflow',
    });
  }
  if (closingCashOutflowCents === 0 && plan.cashSourceAccountId) {
    context.addIssue({
      code: 'custom',
      path: ['cashSourceAccountId'],
      message: 'A cash source account is only valid when closing requires cash',
    });
  }
  if (plan.excessProceedsCents > 0 && !plan.excessProceedsAccountId) {
    context.addIssue({
      code: 'custom',
      path: ['excessProceedsAccountId'],
      message: 'Choose the bank account that will receive excess refinance proceeds',
    });
  }
  if (plan.excessProceedsCents === 0 && plan.excessProceedsAccountId) {
    context.addIssue({
      code: 'custom',
      path: ['excessProceedsAccountId'],
      message: 'An excess-proceeds account is only valid when the refinance returns cash',
    });
  }
};

export const committedRefinancePlanSchema = committedRefinancePlanBaseSchema.superRefine(
  (plan, context) => {
    validateCommittedRefinancePlan(plan, context, false);
    if (plan.replacementLoanSnapshot) {
      if (plan.replacementLoanSnapshot.id !== plan.replacementLoan.id) {
        context.addIssue({
          code: 'custom',
          path: ['replacementLoanSnapshot', 'id'],
          message: 'Committed and current replacement loan IDs must match',
        });
      }
      validateCommittedRefinancePlan(
        {
          ...plan,
          replacementLoan: plan.replacementLoanSnapshot,
        },
        context,
        true,
      );
    }
  },
);
export type CommittedRefinancePlan = z.infer<typeof committedRefinancePlanSchema>;

const committedRefinancePlanInputBaseSchema = committedRefinancePlanBaseSchema
  .omit({
    userId: true,
    status: true,
    replacementLoan: true,
    replacementLoanSnapshot: true,
    assetRelinks: true,
  })
  .extend({ replacementLoan: loanInputSchema });
export const committedRefinancePlanInputSchema = committedRefinancePlanInputBaseSchema.superRefine(
  (input, context) =>
    validateCommittedRefinancePlan(
      {
        ...input,
        userId: '__refinance-input__',
        status: 'committed',
        replacementLoan: { ...input.replacementLoan, userId: '__refinance-input__' },
      },
      context,
      true,
    ),
);
export type CommittedRefinancePlanInput = z.infer<typeof committedRefinancePlanInputSchema>;

export const assetSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  name: z.string().trim().min(1).max(120),
  type: z.enum(['investment', 'tangible', 'other']),
  valueCents: moneyCentsSchema,
  valuationDate: plainDateSchema,
  contributionAmountCents: moneyCentsSchema.nonnegative().optional(),
  contributionRateBasisPoints: z.number().int().min(0).max(100_000).optional(),
  employerMatchBasisPoints: z.number().int().min(0).max(100_000).optional(),
  restrictionStatus: z
    .enum(['unrestricted', 'partially-restricted', 'restricted', 'unknown'])
    .optional(),
  linkedLiabilityId: idSchema.optional(),
  includedInNetWorth: z.boolean().default(true),
  includedInLiquidity: z.boolean().default(false),
});
export type Asset = z.infer<typeof assetSchema>;

const receivableObjectSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  source: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(240),
  originalAmountCents: moneyCentsSchema.nonnegative(),
  remainingAmountCents: moneyCentsSchema.nonnegative(),
  expectedDate: plainDateSchema,
  settlementDateConfirmed: z.boolean().optional(),
  /** Optional recurring bill whose occurrences control receipt timing. */
  settlementAnchorEventId: idSchema.optional(),
  /** Signed calendar-day offset from each anchored bill occurrence; -2 means two days before. */
  settlementOffsetDays: z.number().int().min(-366).max(366).optional(),
  destinationAccountId: idSchema,
  certainty: z.enum(['confirmed', 'expected', 'uncertain']),
  grossExpenseCents: moneyCentsSchema.nonnegative().optional(),
  userEconomicShareCents: moneyCentsSchema.nonnegative().optional(),
  relatedExpenseId: idSchema.optional(),
  paymentInstrument: z.string().trim().min(1).max(128).optional(),
  recurringAmountCents: moneyCentsSchema.nonnegative().optional(),
  recurrenceRule: recurrenceRuleSchema.optional(),
  recurrenceEndDate: plainDateSchema.optional(),
  accrualAmountCents: moneyCentsSchema.nonnegative().optional(),
  accrualDate: plainDateSchema.optional(),
  accrualRecurrenceRule: recurrenceRuleSchema.optional(),
  includeInCashForecast: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional(),
});
const hasValidReceivableBalance = (receivable: {
  originalAmountCents: number;
  remainingAmountCents: number;
}): boolean => receivable.remainingAmountCents <= receivable.originalAmountCents;
const receivableBalanceRefinement: { path: PropertyKey[]; message: string } = {
  path: ['remainingAmountCents'],
  message: 'Remaining amount cannot exceed the original owed amount',
};
const validateReceivableTiming = (
  receivable: {
    originalAmountCents: number;
    recurringAmountCents?: number;
    expectedDate: PlainDateString;
    settlementAnchorEventId?: string;
    settlementOffsetDays?: number;
    recurrenceRule?: RecurrenceRule;
    recurrenceEndDate?: PlainDateString;
  },
  context: z.RefinementCtx,
): void => {
  const hasAnchor = receivable.settlementAnchorEventId !== undefined;
  const hasOffset = receivable.settlementOffsetDays !== undefined;
  if (hasAnchor !== hasOffset) {
    context.addIssue({
      code: 'custom',
      path: [hasAnchor ? 'settlementOffsetDays' : 'settlementAnchorEventId'],
      message: 'Bill-relative receipt timing requires both an anchor bill and a day offset',
    });
  }
  if (hasAnchor && receivable.recurrenceRule !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['recurrenceRule'],
      message: 'Choose either a repeating receipt schedule or bill-relative timing, not both',
    });
  }
  if (
    receivable.recurrenceEndDate !== undefined &&
    compareDates(receivable.recurrenceEndDate, receivable.expectedDate) < 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['recurrenceEndDate'],
      message: 'Receipt schedule end cannot precede the first receipt',
    });
  }
  const repeats =
    hasAnchor ||
    (receivable.recurrenceRule !== undefined && receivable.recurrenceRule.frequency !== 'once');
  if (
    repeats &&
    receivable.originalAmountCents === 0 &&
    (receivable.recurringAmountCents ?? 0) <= 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['recurringAmountCents'],
      message: 'A repeating receivable with no current balance needs a positive recurring amount',
    });
  }
};
export const receivableInputSchema = receivableObjectSchema
  .omit({ userId: true })
  .refine(hasValidReceivableBalance, receivableBalanceRefinement)
  .superRefine(validateReceivableTiming);
export const receivableSchema = receivableObjectSchema
  .refine(hasValidReceivableBalance, receivableBalanceRefinement)
  .superRefine(validateReceivableTiming);
export type Receivable = z.infer<typeof receivableSchema>;

export const rewardProgramSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  cardId: idSchema,
  rewardType: z.enum(['cash-back', 'points']),
  baseRateBasisPoints: z.number().int().min(0).max(100_000),
  pointValueMicros: z.number().int().min(0).safe().optional(),
  annualFeeCents: moneyCentsSchema.nonnegative().default(0),
  treatment: z.enum(['informational', 'statement-credit', 'cash-deposit']),
  expectedReceiptDate: plainDateSchema.optional(),
});
export type RewardProgram = z.infer<typeof rewardProgramSchema>;

export const reconciliationSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  accountId: idSchema,
  date: plainDateSchema,
  forecastBalanceCents: moneyCentsSchema,
  actualBalanceCents: moneyCentsSchema,
  varianceCents: moneyCentsSchema,
  resolution: z.enum(['unresolved', 'explained', 'adjusted']),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type Reconciliation = z.infer<typeof reconciliationSchema>;

const savedScenarioBaseSchema = z.object({
  id: idSchema,
  userId: userIdSchema,
  description: z.string().trim().min(1).max(240),
  amountCents: moneyCentsSchema.positive(),
  settlementDate: plainDateSchema,
  accountId: idSchema,
  fundingType: z.enum(['cash', 'card']).default('cash'),
  cardId: idSchema.optional(),
  purchaseDate: plainDateSchema.optional(),
  status: z.enum(['saved', 'accepted', 'archived']),
  notes: z.string().trim().max(1000).optional(),
});
const validateSavedScenario = (
  scenario: Pick<
    z.infer<typeof savedScenarioBaseSchema>,
    'fundingType' | 'cardId' | 'purchaseDate'
  >,
  context: z.RefinementCtx,
): void => {
  if (scenario.fundingType !== 'card') return;
  if (!scenario.cardId) {
    context.addIssue({
      code: 'custom',
      path: ['cardId'],
      message: 'A card-funded scenario requires a card',
    });
  }
  if (!scenario.purchaseDate) {
    context.addIssue({
      code: 'custom',
      path: ['purchaseDate'],
      message: 'A card-funded scenario requires a purchase date',
    });
  }
};
export const savedScenarioSchema = savedScenarioBaseSchema.superRefine(validateSavedScenario);
export const savedScenarioInputSchema = savedScenarioBaseSchema
  .omit({ userId: true })
  .superRefine(validateSavedScenario);
export type SavedScenario = z.infer<typeof savedScenarioSchema>;
