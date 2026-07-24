import { z } from 'zod';
import {
  assetSchema,
  cashAccountSchema,
  cashAccountInputSchema,
  cashFloorPolicySchema,
  committedRefinancePlanInputSchema,
  committedRefinancePlanSchema,
  creditCardCycleSchema,
  creditCardInputSchema,
  creditCardSchema,
  forecastEventSchema,
  forecastEventInputSchema,
  loanInputSchema,
  loanSchema,
  plainDateSchema,
  profilePreferencesSchema,
  recurrenceRuleSchema,
  receivableInputSchema,
  receivableSchema,
  reconciliationSchema,
  rewardProgramSchema,
  savedScenarioInputSchema,
  savedScenarioSchema,
  assertValidIncomePlanGroups,
  type ForecastEvent,
} from '@balance-book/domain';

export const themePreferenceSchema = z.enum(['system', 'light', 'dark']);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type ProfilePreferencesDto = z.infer<typeof profilePreferencesSchema>;

export const profileSummarySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  username: z.string().min(1),
  passwordSet: z.boolean(),
  onboardingComplete: z.boolean(),
});
export type ProfileSummaryDto = z.infer<typeof profileSummarySchema>;

export const sessionSchema = z.object({
  profile: profileSummarySchema,
  themePreference: themePreferenceSchema,
  preferences: profilePreferencesSchema,
});
export type SessionDto = z.infer<typeof sessionSchema>;

export const createPasswordRequestSchema = z
  .object({
    profileId: z.string().min(1).max(128),
    displayName: z.string().trim().min(1).max(120).optional(),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, periods, underscores, or hyphens')
      .optional(),
    password: z.string().min(12).max(128),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.displayName === undefined) !== (request.username === undefined)) {
      context.addIssue({
        code: 'custom',
        path: request.displayName === undefined ? ['displayName'] : ['username'],
        message: 'Profile name and username must be provided together',
      });
    }
  });
export type CreatePasswordRequest = z.infer<typeof createPasswordRequestSchema>;

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const verticalSliceInputSchema = z
  .object({
    balanceAsOf: plainDateSchema,
    accountName: z.string().trim().min(1).max(120),
    openingBalanceCents: z.number().int().safe(),
    incomeLabel: z.string().trim().min(1).max(240).optional(),
    incomeDate: plainDateSchema.optional(),
    incomeAmountCents: z.number().int().nonnegative().safe().optional(),
    commitmentLabel: z.string().trim().min(1).max(240).optional(),
    commitmentDate: plainDateSchema.optional(),
    commitmentAmountCents: z.number().int().nonnegative().safe().optional(),
    cardName: z.string().trim().min(1).max(120).optional(),
    cardEstimateCents: z.number().int().nonnegative().safe().optional(),
    cardPaymentDayOfMonth: z.number().int().min(1).max(31).optional(),
    cardStatementCloseDayOfMonth: z.number().int().min(1).max(31).optional(),
    cardEstimatePolicy: z.enum(['actual-reset', 'baseline-guardrail']).optional(),
    cardPaymentPolicy: z.enum(['full-statement', 'minimum', 'fixed', 'manual']).optional(),
    cardMinimumPaymentCents: z.number().int().positive().safe().optional(),
    cardFixedPaymentCents: z.number().int().positive().safe().optional(),
    hardFloorCents: z.number().int().nonnegative().safe(),
    preferredFloorCents: z.number().int().nonnegative().safe().optional(),
  })
  .superRefine((input, context) => {
    const groups = [
      {
        path: 'incomeLabel',
        label: 'income',
        values: [input.incomeLabel, input.incomeDate, input.incomeAmountCents],
      },
      {
        path: 'commitmentLabel',
        label: 'commitment',
        values: [input.commitmentLabel, input.commitmentDate, input.commitmentAmountCents],
      },
    ] as const;
    for (const group of groups) {
      const present = group.values.map((value) => value !== undefined);
      if (present.some(Boolean) && !present.every(Boolean)) {
        context.addIssue({
          code: 'custom',
          path: [group.path],
          message: `Complete every ${group.label} field or leave the whole step blank`,
        });
      }
    }
    const cardCore = [
      input.cardName,
      input.cardEstimateCents,
      input.cardEstimatePolicy,
      input.cardPaymentPolicy,
    ];
    const cardTiming = [input.cardPaymentDayOfMonth, input.cardStatementCloseDayOfMonth];
    if (
      [...cardCore, ...cardTiming, input.cardMinimumPaymentCents, input.cardFixedPaymentCents].some(
        (value) => value !== undefined,
      )
    ) {
      if (cardCore.some((value) => value === undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['cardName'],
          message: 'Complete the card identity and policies or leave the whole step blank',
        });
      } else if (
        input.cardPaymentPolicy === 'manual' &&
        cardTiming.some((value) => value !== undefined) &&
        cardTiming.some((value) => value === undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['cardStatementCloseDayOfMonth'],
          message: 'Enter both source timing days or leave both unknown for a manual card',
        });
      } else if (
        input.cardPaymentPolicy !== 'manual' &&
        cardTiming.some((value) => value === undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['cardStatementCloseDayOfMonth'],
          message: 'Automatic payment guidance needs complete card timing',
        });
      }
      if (input.cardPaymentPolicy === 'minimum' && input.cardMinimumPaymentCents === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['cardMinimumPaymentCents'],
          message: 'A minimum payment policy requires a positive minimum payment amount',
        });
      }
      if (input.cardPaymentPolicy === 'fixed' && input.cardFixedPaymentCents === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['cardFixedPaymentCents'],
          message: 'A fixed payment policy requires a positive fixed payment amount',
        });
      }
      if (input.cardPaymentPolicy !== 'minimum' && input.cardMinimumPaymentCents !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['cardMinimumPaymentCents'],
          message: 'A minimum payment amount is only valid with the minimum payment policy',
        });
      }
      if (input.cardPaymentPolicy !== 'fixed' && input.cardFixedPaymentCents !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['cardFixedPaymentCents'],
          message: 'A fixed payment amount is only valid with the fixed payment policy',
        });
      }
    }
  })
  .refine(
    (input) =>
      input.preferredFloorCents === undefined || input.preferredFloorCents >= input.hardFloorCents,
    { path: ['preferredFloorCents'], message: 'Preferred buffer must not be below hard floor' },
  );
export type VerticalSliceRequest = z.infer<typeof verticalSliceInputSchema>;

export const onboardingDraftValuesSchema = z.record(z.string().min(1).max(64), z.string().max(500));
export const saveOnboardingDraftRequestSchema = z
  .object({ values: onboardingDraftValuesSchema })
  .strict();
export type SaveOnboardingDraftRequest = z.infer<typeof saveOnboardingDraftRequestSchema>;
export const onboardingDraftSchema = z
  .object({ values: onboardingDraftValuesSchema, updatedAt: z.string().datetime() })
  .nullable();
export type OnboardingDraftDto = z.infer<typeof onboardingDraftSchema>;

export const forecastEventDisplayStateSchema = z.enum([
  'actual',
  'locked',
  'estimated',
  'hypothetical',
  'planned',
]);
export type ForecastEventDisplayState = z.infer<typeof forecastEventDisplayStateSchema>;

export const displayStateForForecastEvent = (
  event: Pick<ForecastEvent, 'certainty' | 'status' | 'hypothetical'>,
): ForecastEventDisplayState => {
  if (event.hypothetical) return 'hypothetical';
  if (event.status === 'confirmed' || event.status === 'paid') return 'actual';
  if (event.status === 'scheduled' && event.certainty === 'confirmed') return 'locked';
  if (event.certainty === 'expected' || event.certainty === 'uncertain') return 'estimated';
  return 'planned';
};

export const forecastDailyEventSchema = z
  .object({
    id: z.string(),
    sourceRecordId: z.string().optional(),
    label: z.string(),
    accountName: z.string(),
    amountCents: z.number().int().nonnegative().safe(),
    direction: z.enum(['inflow', 'outflow']),
    kind: z.string(),
    certainty: z.enum(['confirmed', 'expected', 'uncertain']),
    status: z.enum(['planned', 'scheduled', 'confirmed', 'paid', 'cancelled', 'skipped']),
    hypothetical: z.boolean(),
    displayState: forecastEventDisplayStateSchema,
    includedInExpected: z.boolean(),
    includedInConservative: z.boolean(),
  })
  .superRefine((event, context) => {
    const derived = displayStateForForecastEvent(event);
    if (event.displayState !== derived) {
      context.addIssue({
        code: 'custom',
        path: ['displayState'],
        message: `Display state must be ${derived} for this event`,
      });
    }
  });
export type ForecastDailyEventDto = z.infer<typeof forecastDailyEventSchema>;

export const dailyCashPointSchema = z.object({
  date: plainDateSchema,
  conservativeCashCents: z.number().int().safe(),
  expectedCashCents: z.number().int().safe(),
  conservativeInTransitCents: z.number().int().nonnegative().safe(),
  expectedInTransitCents: z.number().int().nonnegative().safe(),
  conservativeReceivableCents: z.number().int().nonnegative().safe(),
  expectedReceivableCents: z.number().int().nonnegative().safe(),
  conservativePositionCents: z.number().int().safe(),
  expectedPositionCents: z.number().int().safe(),
  conservativeNetWorthCents: z.number().int().safe().optional(),
  expectedNetWorthCents: z.number().int().safe().optional(),
  accountBalances: z.array(
    z.object({
      accountId: z.string(),
      accountName: z.string(),
      available: z.boolean(),
      conservativeCashCents: z.number().int().safe(),
      expectedCashCents: z.number().int().safe(),
    }),
  ),
  events: z.array(forecastDailyEventSchema),
});

const cardSpendingPowerSchema = z.array(
  z.object({
    cardId: z.string(),
    cardName: z.string(),
    fundingAccountId: z.string(),
    fundingAccountName: z.string(),
    statementCycleId: z.string().optional(),
    statementAmountCents: z.number().int().safe(),
    statementDueOn: plainDateSchema.optional(),
    statementState: z.string().optional(),
    currentCycleId: z.string().optional(),
    currentCycleAmountCents: z.number().int().safe(),
    currentCycleClosesOn: plainDateSchema.optional(),
    nextDueOn: plainDateSchema.optional(),
    nextStatementDueOn: plainDateSchema.optional(),
    nextStatementPositionCents: z.number().int().safe().optional(),
    purchaseAdvisorEligible: z.boolean(),
    currentCyclePaymentOn: plainDateSchema.optional(),
    spendingPowerCents: z.number().int().nonnegative().safe(),
    cashBackedCapacityCents: z.number().int().nonnegative().safe(),
    spendingPowerStatus: z.enum([
      'determinate',
      'conditional-existing-shortfall',
      'indeterminate-overdue-payment-timing',
      'indeterminate-payment-policy',
      'indeterminate-cycle-timing',
      'indeterminate-payment-outside-horizon',
      'indeterminate-account-balances',
    ]),
    prePaymentShortfallCents: z.number().int().nonnegative().safe(),
    prePaymentShortfallDate: plainDateSchema.optional(),
    prePaymentShortfallAccountId: z.string().optional(),
    baselineEstimateSlackCents: z.number().int().nonnegative().safe(),
    futurePositionLowCents: z.number().int().safe(),
    futurePositionLowDate: plainDateSchema,
    futurePositionLowCashCents: z.number().int().safe(),
    futurePositionLowReceivableCents: z.number().int().nonnegative().safe(),
    futurePositionLowAccountBalances: z.array(
      z.object({
        accountId: z.string(),
        accountName: z.string(),
        endingBalanceCents: z.number().int().safe(),
      }),
    ),
    futureAccountLows: z.array(
      z.object({
        accountId: z.string(),
        accountName: z.string(),
        endingBalanceCents: z.number().int().safe(),
        date: plainDateSchema,
      }),
    ),
    paymentDatePositionCents: z.number().int().safe().optional(),
    paymentDateCashCents: z.number().int().safe().optional(),
    paymentDateReceivableCents: z.number().int().nonnegative().safe().optional(),
    paymentDateAccountBalances: z
      .array(
        z.object({
          accountId: z.string(),
          accountName: z.string(),
          endingBalanceCents: z.number().int().safe(),
        }),
      )
      .optional(),
    futureCashLowCents: z.number().int().safe(),
    futureCashLowDate: plainDateSchema,
    fundingAccountLowCents: z.number().int().safe(),
    fundingAccountLowDate: plainDateSchema,
    rewardRateBasisPoints: z.number().int().nonnegative().safe().optional(),
    rewardType: z.enum(['cash-back', 'points']).optional(),
  }),
);

const revolvingDebtByCardSchema = z.array(
  z.object({
    cardId: z.string(),
    reportedBalanceCents: z.number().int().nonnegative().safe().optional(),
    reportedBalanceDate: plainDateSchema.optional(),
    calculatedThroughDate: plainDateSchema.optional(),
    postSourceActivityCents: z.number().int().safe().optional(),
    latestStatementCents: z.number().int().nonnegative().safe(),
    latestStatementDate: plainDateSchema.optional(),
    amountCurrentlyDueCents: z.number().int().nonnegative().safe(),
    actualOpenCycleCents: z.number().int().nonnegative().safe(),
    unreconciledPostCloseActivityCents: z.number().int().nonnegative().safe(),
    projectedOpenCycleCents: z.number().int().nonnegative().safe(),
    currentBalanceCents: z.number().int().nonnegative().safe(),
    availableCreditCents: z.number().int().nonnegative().safe().optional(),
    carryingBalanceCents: z.number().int().nonnegative().safe(),
    projectedCarryingBalanceCents: z.number().int().nonnegative().safe(),
    overdue: z.boolean(),
    source: z.enum(['reported', 'cycle-derived']),
    reportedBalanceHasUnresolvedSameCycleActivity: z.boolean(),
  }),
);

const transferNeedsSchema = z.array(
  z.object({
    accountId: z.string(),
    accountName: z.string(),
    sourceAccountId: z.string().optional(),
    sourceAccountName: z.string().optional(),
    date: plainDateSchema,
    shortfallCents: z.number().int().nonnegative().safe(),
    horizonDeepestShortfallCents: z.number().int().nonnegative().safe().optional(),
    horizonDeepestShortfallDate: plainDateSchema.optional(),
    horizonAdditionalShortfallCents: z.number().int().nonnegative().safe().optional(),
    receivableOutstandingCents: z.number().int().nonnegative().safe().optional(),
    receivableReleaseNeededCents: z.number().int().nonnegative().safe().optional(),
    uncoveredAfterReceivablesCents: z.number().int().nonnegative().safe().optional(),
    deepestReceivableOutstandingCents: z.number().int().nonnegative().safe().optional(),
    deepestReceivableReleaseNeededCents: z.number().int().nonnegative().safe().optional(),
    deepestUncoveredAfterReceivablesCents: z.number().int().nonnegative().safe().optional(),
    initiationDate: plainDateSchema.optional(),
    arrivalDate: plainDateSchema.optional(),
    sourceSurplusAfterFloorsCents: z.number().int().safe().optional(),
  }),
);

export const forecastSnapshotSchema = z.object({
  setupComplete: z.boolean(),
  startDate: plainDateSchema.optional(),
  endDate: plainDateSchema.optional(),
  accountName: z.string().optional(),
  cardName: z.string().optional(),
  conservativeTroughCents: z.number().int().safe().optional(),
  conservativeTroughDate: plainDateSchema.optional(),
  expectedTroughCents: z.number().int().safe().optional(),
  expectedTroughDate: plainDateSchema.optional(),
  conservativeIntradaySafetyLowCents: z.number().int().safe().optional(),
  conservativeIntradaySafetyLowDate: plainDateSchema.optional(),
  expectedIntradaySafetyLowCents: z.number().int().safe().optional(),
  expectedIntradaySafetyLowDate: plainDateSchema.optional(),
  hardFloorMarginCents: z.number().int().safe().optional(),
  conservativeHardFloorMarginCents: z.number().int().safe().optional(),
  expectedHardFloorMarginCents: z.number().int().safe().optional(),
  availableToDeployCents: z.number().int().safe().optional(),
  accountShortfallCount: z.number().int().nonnegative().optional(),
  currentConsolidatedCashCents: z.number().int().safe().optional(),
  currentAllCashCents: z.number().int().safe().optional(),
  currentReceivableCents: z.number().int().nonnegative().safe().optional(),
  currentTotalPositionCents: z.number().int().safe().optional(),
  longRunMonthlyFreeCashFlowCents: z.number().int().safe().optional(),
  longRunMonthlyScheduledCardPaymentCents: z.number().int().nonnegative().safe().optional(),
  longRunMonthlyBeforeScheduledCardPaymentCents: z.number().int().safe().optional(),
  longRunCashFlowWindowStart: plainDateSchema.optional(),
  longRunCashFlowWindowEnd: plainDateSchema.optional(),
  conservativePositionLowCents: z.number().int().safe().optional(),
  conservativePositionLowDate: plainDateSchema.optional(),
  expectedPositionLowCents: z.number().int().safe().optional(),
  expectedPositionLowDate: plainDateSchema.optional(),
  preferredFloorMarginCents: z.number().int().safe().optional(),
  conservativePreferredFloorMarginCents: z.number().int().safe().optional(),
  expectedPreferredFloorMarginCents: z.number().int().safe().optional(),
  hardFloorCents: z.number().int().nonnegative().safe().optional(),
  preferredFloorCents: z.number().int().nonnegative().safe().optional(),
  configuredHardFloorCents: z.number().int().nonnegative().safe().optional(),
  configuredPreferredFloorCents: z.number().int().nonnegative().safe().optional(),
  accountHardFloorTotalCents: z.number().int().nonnegative().safe().optional(),
  accountPreferredFloorTotalCents: z.number().int().nonnegative().safe().optional(),
  cashAccounts: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        balanceCents: z.number().int().safe(),
        sourceBalanceCents: z.number().int().safe().optional(),
        sourceBalanceDate: plainDateSchema.optional(),
        calculatedThroughDate: plainDateSchema.optional(),
        postSourceChangeCents: z.number().int().safe().optional(),
        hardFloorCents: z.number().int().nonnegative().safe(),
        preferredFloorCents: z.number().int().nonnegative().safe().optional(),
        showOnOverview: z.boolean().optional(),
      }),
    )
    .optional(),
  accountTroughs: z
    .array(
      z.object({
        accountId: z.string(),
        accountName: z.string(),
        balanceCents: z.number().int().safe(),
        date: plainDateSchema,
        expectedBalanceCents: z.number().int().safe(),
        expectedDate: plainDateSchema,
      }),
    )
    .optional(),
  transferNeeds: transferNeedsSchema.optional(),
  expectedTransferNeeds: transferNeedsSchema.optional(),
  upcomingEvents: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        accountName: z.string(),
        date: plainDateSchema,
        amountCents: z.number().int().nonnegative().safe(),
        direction: z.enum(['inflow', 'outflow']),
        kind: z.string(),
        certainty: z.string(),
      }),
    )
    .optional(),
  upcomingReceivables: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        date: plainDateSchema,
        amountCents: z.number().int().nonnegative().safe(),
        certainty: z.string(),
      }),
    )
    .optional(),
  cardSpendingPower: cardSpendingPowerSchema.optional(),
  conservativeCardSpendingPower: cardSpendingPowerSchema.optional(),
  totalLoansCents: z.number().int().nonnegative().safe().optional(),
  revolvingDebtByCard: revolvingDebtByCardSchema.optional(),
  totalRevolvingDebtCents: z.number().int().nonnegative().safe().optional(),
  totalCarryingDebtCents: z.number().int().nonnegative().safe().optional(),
  totalDebtCents: z.number().int().nonnegative().safe().optional(),
  modeledDailyInterestCents: z.number().int().nonnegative().safe().optional(),
  contractualNetWorthCents: z.number().int().safe().optional(),
  economicNetWorthCents: z.number().int().safe().optional(),
  restrictedRefinanceSettlementCents: z.number().int().nonnegative().safe().optional(),
  lastReconciliationDate: plainDateSchema.nullable().optional(),
  dependencies: z.array(z.string()).optional(),
  dailyCash: z.array(dailyCashPointSchema).optional(),
});
export type ForecastSnapshotDto = z.infer<typeof forecastSnapshotSchema>;

export const scenarioRequestSchema = z
  .object({
    description: z.string().trim().min(1).max(240),
    amountCents: z.number().int().positive().safe(),
    settlementDate: plainDateSchema,
    fundingType: z.enum(['cash', 'card']).default('cash'),
    forecastMode: z.enum(['expected', 'conservative']).default('conservative'),
    accountId: z.string().min(1).max(128).optional(),
    cardId: z.string().min(1).max(128).optional(),
  })
  .refine((input) => input.fundingType !== 'card' || Boolean(input.cardId), {
    path: ['cardId'],
    message: 'Choose a card',
  });
export type ScenarioRequest = z.infer<typeof scenarioRequestSchema>;

export const scenarioResponseSchema = z.object({
  verdict: z.enum([
    'affordable-under-current-assumptions',
    'above-hard-floor-below-preferred-buffer',
    'dependent-on-expected-income',
    'underfunded-account',
    'breaches-protected-floor',
  ]),
  settlementDate: plainDateSchema,
  beforeTroughCents: z.number().int().safe(),
  afterTroughCents: z.number().int().safe(),
  afterHardFloorMarginCents: z.number().int().safe(),
  afterAvailableToDeployCents: z.number().int().nonnegative().safe(),
  resultingAvailableSpendCents: z.number().int().nonnegative().safe().optional(),
  accountShortfallCount: z.number().int().nonnegative(),
  transferNeeds: transferNeedsSchema,
  fundingAccountName: z.string(),
  cardName: z.string().optional(),
  purchaseSafety: z
    .object({
      safe: z.boolean(),
      totalPositionLowCents: z.number().int().safe(),
      totalPositionLowDate: plainDateSchema,
      totalPositionMarginCents: z.number().int().safe(),
      fundingAccountLowCents: z.number().int().safe(),
      fundingAccountLowDate: plainDateSchema,
      fundingAccountFloorCents: z.number().int().nonnegative().safe(),
      fundingAccountShortfallCents: z.number().int().nonnegative().safe(),
      receivableOutstandingCents: z.number().int().nonnegative().safe(),
      receivableReleaseNeededCents: z.number().int().nonnegative().safe(),
      uncoveredFundingShortfallCents: z.number().int().nonnegative().safe(),
    })
    .optional(),
  baselineCardPaymentCents: z.number().int().nonnegative().safe().optional(),
  afterPurchaseCardPaymentCents: z.number().int().nonnegative().safe().optional(),
  incrementalCashPaymentCents: z.number().int().nonnegative().safe().optional(),
  owningStatementClosesOn: plainDateSchema.optional(),
  followingStatementDueOn: plainDateSchema.optional(),
  followingStatementPositionCents: z.number().int().safe().optional(),
});
export type ScenarioResponseDto = z.infer<typeof scenarioResponseSchema>;

export const combinedScenarioRequestSchema = z
  .object({ scenarioIds: z.array(z.string().min(1).max(128)).min(1).max(100) })
  .strict();
export type CombinedScenarioRequest = z.infer<typeof combinedScenarioRequestSchema>;
export const scenarioActionRequestSchema = z
  .object({ scenarioId: z.string().min(1).max(128) })
  .strict();
export type ScenarioActionRequest = z.infer<typeof scenarioActionRequestSchema>;
export const receivableSettlementRequestSchema = z
  .object({
    receivableId: z.string().min(1).max(128),
    amountCents: z.number().int().positive().safe(),
    date: plainDateSchema,
    occurrenceDate: plainDateSchema.optional(),
    destinationAccountId: z.string().min(1).max(128),
  })
  .strict();
export type ReceivableSettlementRequest = z.infer<typeof receivableSettlementRequestSchema>;
export const unattributedReceivableSettlementRequestSchema = z
  .object({
    amountCents: z.number().int().positive().safe(),
    date: plainDateSchema,
    destinationAccountId: z.string().min(1).max(128),
  })
  .strict();
export type UnattributedReceivableSettlementRequest = z.infer<
  typeof unattributedReceivableSettlementRequestSchema
>;
export const overviewExpenseRequestSchema = z
  .object({
    paymentSource: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('cash-account'),
          accountId: z.string().min(1).max(128),
        })
        .strict(),
      z
        .object({
          kind: z.literal('credit-card'),
          cardId: z.string().min(1).max(128),
        })
        .strict(),
    ]),
    amountCents: z.number().int().positive().safe(),
    date: plainDateSchema,
    label: z.string().trim().min(1).max(240),
    notes: z.string().trim().max(1000).optional(),
    owedTreatment: z.enum(['none', 'reimbursable', 'shared']),
    owedBy: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.owedTreatment !== 'none' && !input.owedBy) {
      context.addIssue({
        code: 'custom',
        path: ['owedBy'],
        message: 'Enter who owes this amount',
      });
    }
    if (input.owedTreatment === 'none' && input.owedBy !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['owedBy'],
        message: 'An owed-by name is only valid for a reimbursable or shared expense',
      });
    }
  });
export type OverviewExpenseRequest = z.infer<typeof overviewExpenseRequestSchema>;
export const billPlanRequestSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    linkedReceivableId: z.string().min(1).max(128).optional(),
    paymentSource: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('cash-account'),
          accountId: z.string().min(1).max(128),
        })
        .strict(),
      z
        .object({
          kind: z.literal('credit-card'),
          cardId: z.string().min(1).max(128),
          addToCardBalance: z.boolean().default(false),
        })
        .strict(),
    ]),
    amountCents: z.number().int().positive().safe(),
    firstBillDate: plainDateSchema,
    label: z.string().trim().min(1).max(240),
    recurrenceRule: recurrenceRuleSchema,
    recurrenceEndDate: plainDateSchema.optional(),
    certainty: z.enum(['confirmed', 'expected', 'uncertain']).default('confirmed'),
    active: z.boolean().default(true),
    notes: z.string().trim().max(1000).optional(),
    owedTreatment: z.enum(['none', 'reimbursable', 'shared']),
    owedBy: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.recurrenceEndDate && input.recurrenceEndDate < input.firstBillDate) {
      context.addIssue({
        code: 'custom',
        path: ['recurrenceEndDate'],
        message: 'Bill schedule end cannot precede its first date',
      });
    }
    if (input.owedTreatment !== 'none' && !input.owedBy) {
      context.addIssue({
        code: 'custom',
        path: ['owedBy'],
        message: 'Enter who owes this amount',
      });
    }
    if (input.owedTreatment === 'none' && input.owedBy !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['owedBy'],
        message: 'An owed-by name is only valid for a reimbursable or shared bill',
      });
    }
  });
export type BillPlanRequest = z.infer<typeof billPlanRequestSchema>;
export const internalTransferRequestSchema = z
  .object({
    sourceAccountId: z.string().min(1).max(128),
    destinationAccountId: z.string().min(1).max(128),
    amountCents: z.number().int().positive().safe(),
    initiationDate: plainDateSchema,
    arrivalDate: plainDateSchema,
    label: z.string().trim().min(1).max(240),
    recurrenceRule: recurrenceRuleSchema.optional(),
    recurrenceEndDate: plainDateSchema.optional(),
    status: z.enum(['planned', 'scheduled', 'confirmed']).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((input) => input.sourceAccountId !== input.destinationAccountId, {
    path: ['destinationAccountId'],
    message: 'Transfer destination must differ from source',
  })
  .refine((input) => input.arrivalDate >= input.initiationDate, {
    path: ['arrivalDate'],
    message: 'Arrival date cannot precede initiation date',
  })
  .refine((input) => !input.recurrenceEndDate || input.recurrenceEndDate >= input.initiationDate, {
    path: ['recurrenceEndDate'],
    message: 'Transfer recurrence end cannot precede initiation',
  });
export type InternalTransferRequest = z.infer<typeof internalTransferRequestSchema>;

export const setThemeRequestSchema = z.object({ theme: themePreferenceSchema });
export type SetThemeRequest = z.infer<typeof setThemeRequestSchema>;

export const setPreferencesRequestSchema = profilePreferencesSchema;
export type SetPreferencesRequest = z.infer<typeof setPreferencesRequestSchema>;

export const setMenuBarVisibilityRequestSchema = z.object({ visible: z.boolean() }).strict();
export type SetMenuBarVisibilityRequest = z.infer<typeof setMenuBarVisibilityRequestSchema>;

export const notificationPresentationSchema = z
  .object({
    notificationId: z.string().trim().min(1).max(240),
    conditionFingerprint: z.string().trim().min(1).max(1_000),
    readAt: z.string().datetime().nullable(),
    snoozedUntil: z.string().datetime().nullable(),
    dismissedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type NotificationPresentationDto = z.infer<typeof notificationPresentationSchema>;
export const auditHistoryEntrySchema = z
  .object({
    id: z.string(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AuditHistoryEntryDto = z.infer<typeof auditHistoryEntrySchema>;
export const setNotificationPresentationsRequestSchema = z
  .object({
    updates: z
      .array(notificationPresentationSchema.omit({ updatedAt: true }))
      .min(1)
      .max(200),
  })
  .strict();
export type SetNotificationPresentationsRequest = z.infer<
  typeof setNotificationPresentationsRequestSchema
>;

export const updateCashPolicyRequestSchema = cashFloorPolicySchema;
export type UpdateCashPolicyRequest = z.infer<typeof updateCashPolicyRequestSchema>;

export const emptyRequestSchema = z.object({}).strict();
export const forecastRequestSchema = z
  .object({ requiredEndDate: plainDateSchema.optional() })
  .strict()
  .default({});
export type ForecastRequest = z.infer<typeof forecastRequestSchema>;
export const successSchema = z.object({ success: z.literal(true) });

export const updateChannelSchema = z.enum(['beta', 'stable']);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export const updateStatusSchema = z
  .object({
    enabled: z.boolean(),
    delivery: z.enum(['balance-book', 'microsoft-store', 'none']),
    storeLinkAvailable: z.boolean(),
    state: z.enum([
      'disabled',
      'idle',
      'checking',
      'downloading',
      'current',
      'ready',
      'deferred',
      'installing',
      'offline',
      'failed',
    ]),
    channel: updateChannelSchema,
    currentVersion: z.string().min(1).max(40),
    message: z.string().min(1).max(300),
    checkedAt: z.string().datetime().optional(),
    releaseName: z.string().min(1).max(160).optional(),
    releaseDate: z.string().datetime().optional(),
    releaseNotes: z.string().max(2_000).optional(),
  })
  .strict();
export type UpdateStatusDto = z.infer<typeof updateStatusSchema>;
export const postUpdateNoticeSchema = z
  .object({
    oldVersion: z.string().min(1).max(40),
    newVersion: z.string().min(1).max(40),
    releaseName: z.string().min(1).max(160).optional(),
    releaseNotes: z.string().max(2_000).optional(),
    profileRetained: z.literal(true),
  })
  .strict();
export type PostUpdateNoticeDto = z.infer<typeof postUpdateNoticeSchema>;

export const managedRecordsSchema = z.object({
  accounts: z.array(cashAccountSchema),
  events: z.array(forecastEventSchema),
  cards: z.array(creditCardSchema),
  cardCycles: z.array(creditCardCycleSchema),
  loans: z.array(loanSchema),
  committedRefinancePlans: z.array(committedRefinancePlanSchema).default([]),
  receivables: z.array(receivableSchema),
  assets: z.array(assetSchema),
  rewardPrograms: z.array(rewardProgramSchema),
  reconciliations: z.array(reconciliationSchema),
  savedScenarios: z.array(savedScenarioSchema),
  policy: cashFloorPolicySchema.optional(),
});
export type ManagedRecordsDto = z.infer<typeof managedRecordsSchema>;

export const commitRefinancePlanRequestSchema = committedRefinancePlanInputSchema;
export type CommitRefinancePlanRequest = z.infer<typeof commitRefinancePlanRequestSchema>;

export const cancelRefinancePlanRequestSchema = z
  .object({
    planId: z.string().trim().min(1).max(128),
    confirmed: z.literal(true),
  })
  .strict();
export type CancelRefinancePlanRequest = z.infer<typeof cancelRefinancePlanRequestSchema>;

export const managedEntityTypeSchema = z.enum([
  'cash-account',
  'forecast-event',
  'credit-card',
  'card-cycle',
  'loan',
  'receivable',
  'asset',
  'reward-program',
  'reconciliation',
  'saved-scenario',
]);

export const upsertManagedEntityRequestSchema = z.discriminatedUnion('entityType', [
  z
    .object({
      entityType: z.literal('cash-account'),
      payload: cashAccountInputSchema,
    })
    .strict(),
  z
    .object({
      entityType: z.literal('forecast-event'),
      payload: forecastEventInputSchema,
    })
    .strict(),
  z
    .object({
      entityType: z.literal('credit-card'),
      payload: creditCardInputSchema,
    })
    .strict(),
  z.object({ entityType: z.literal('card-cycle'), payload: creditCardCycleSchema }).strict(),
  z.object({ entityType: z.literal('loan'), payload: loanInputSchema }).strict(),
  z
    .object({
      entityType: z.literal('receivable'),
      payload: receivableInputSchema,
    })
    .strict(),
  z
    .object({ entityType: z.literal('asset'), payload: assetSchema.omit({ userId: true }) })
    .strict(),
  z
    .object({
      entityType: z.literal('reward-program'),
      payload: rewardProgramSchema.omit({ userId: true }),
    })
    .strict(),
  z
    .object({
      entityType: z.literal('reconciliation'),
      payload: reconciliationSchema.omit({ userId: true }),
    })
    .strict(),
  z
    .object({
      entityType: z.literal('saved-scenario'),
      payload: savedScenarioInputSchema,
    })
    .strict(),
]);
export type UpsertManagedEntityRequest = z.infer<typeof upsertManagedEntityRequestSchema>;

export const upsertIncomePlanRequestSchema = z
  .object({
    events: z.array(forecastEventInputSchema).min(1).max(24),
    replacePlanId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    for (const [index, event] of input.events.entries()) {
      if (event.kind !== 'income' || event.direction !== 'inflow' || !event.incomeType) {
        context.addIssue({
          code: 'custom',
          path: ['events', index],
          message: 'Income plans may contain only typed income inflows',
        });
      }
    }
    if (
      input.replacePlanId &&
      input.events.some((event) => event.incomePlanId !== input.replacePlanId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['replacePlanId'],
        message: 'A replacement must contain every allocation for exactly one income plan',
      });
    }
    try {
      assertValidIncomePlanGroups(
        input.events.map((event) =>
          forecastEventSchema.parse({ ...event, userId: 'contract-user' }),
        ),
      );
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['events'],
        message: error instanceof Error ? error.message : 'Income plan allocations are invalid',
      });
    }
  });
export type UpsertIncomePlanRequest = z.infer<typeof upsertIncomePlanRequestSchema>;

export const deleteManagedEntityRequestSchema = z
  .object({
    entityType: managedEntityTypeSchema,
    entityId: z.string().min(1).max(128),
    confirmed: z.literal(true),
  })
  .strict();
export type DeleteManagedEntityRequest = z.infer<typeof deleteManagedEntityRequestSchema>;

export const backupRequestSchema = z.object({ password: z.string().min(12).max(128) }).strict();
export type BackupRequest = z.infer<typeof backupRequestSchema>;
export const restoreRequestSchema = backupRequestSchema
  .extend({ confirmReplace: z.literal(true) })
  .strict();
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;
export const jsonImportRequestSchema = z.object({ confirmReplace: z.literal(true) }).strict();
export type JsonImportRequest = z.infer<typeof jsonImportRequestSchema>;
export const resetUserDataRequestSchema = z
  .object({ confirmation: z.literal('DELETE ACTIVE PROFILE DATA') })
  .strict();
export type ResetUserDataRequest = z.infer<typeof resetUserDataRequestSchema>;
export const fileActionResultSchema = z.object({
  canceled: z.boolean(),
  itemCount: z.number().int().nonnegative(),
});
export type FileActionResultDto = z.infer<typeof fileActionResultSchema>;

export const importReviewSchema = z.object({
  batches: z.array(
    z.object({
      id: z.string(),
      sourceFileName: z.string(),
      workbookChecksum: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  fields: z.array(
    z.object({
      entityType: z.string(),
      entityId: z.string(),
      field: z.string(),
      sourceSheet: z.string(),
      sourceRange: z.string(),
      transformation: z.string(),
      confidence: z.string(),
      warning: z.string().nullable(),
      destinationEdited: z.boolean(),
      importedValueJson: z.string().nullable(),
      currentValueJson: z.string(),
      importedAt: z.string().datetime(),
      lastModifiedAt: z.string().datetime().nullable(),
      forecastImpact: z.string(),
      relatedRecordIds: z.array(z.string()),
    }),
  ),
});
export type ImportReviewDto = z.infer<typeof importReviewSchema>;

export const resultSchema = <T extends z.ZodType>(valueSchema: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: valueSchema }),
    z.object({ ok: z.literal(false), error: z.string().min(1).max(300) }),
  ]);

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface BalanceBookApi {
  appVersion: string;
  platform: string;
  listProfiles(): Promise<IpcResult<ProfileSummaryDto[]>>;
  createPassword(input: CreatePasswordRequest): Promise<IpcResult<SessionDto>>;
  login(input: LoginRequest): Promise<IpcResult<SessionDto>>;
  logout(): Promise<IpcResult<{ success: true }>>;
  getSession(): Promise<IpcResult<SessionDto | null>>;
  getForecast(input?: ForecastRequest): Promise<IpcResult<ForecastSnapshotDto>>;
  saveVerticalSlice(input: VerticalSliceRequest): Promise<IpcResult<ForecastSnapshotDto>>;
  getOnboardingDraft(): Promise<IpcResult<OnboardingDraftDto>>;
  saveOnboardingDraft(input: SaveOnboardingDraftRequest): Promise<IpcResult<{ success: true }>>;
  evaluateScenario(input: ScenarioRequest): Promise<IpcResult<ScenarioResponseDto>>;
  evaluateCombinedScenarios(
    input: CombinedScenarioRequest,
  ): Promise<IpcResult<ScenarioResponseDto>>;
  convertScenario(input: ScenarioActionRequest): Promise<IpcResult<ManagedRecordsDto>>;
  recordReceivableSettlement(
    input: ReceivableSettlementRequest,
  ): Promise<IpcResult<ManagedRecordsDto>>;
  recordUnattributedReceivableSettlement(
    input: UnattributedReceivableSettlementRequest,
  ): Promise<IpcResult<ManagedRecordsDto>>;
  recordOverviewExpense(input: OverviewExpenseRequest): Promise<IpcResult<ManagedRecordsDto>>;
  upsertBillPlan(input: BillPlanRequest): Promise<IpcResult<ManagedRecordsDto>>;
  createInternalTransfer(input: InternalTransferRequest): Promise<IpcResult<ManagedRecordsDto>>;
  commitRefinancePlan(input: CommitRefinancePlanRequest): Promise<IpcResult<ManagedRecordsDto>>;
  cancelRefinancePlan(input: CancelRefinancePlanRequest): Promise<IpcResult<ManagedRecordsDto>>;
  setTheme(input: SetThemeRequest): Promise<IpcResult<SessionDto>>;
  setPreferences(input: SetPreferencesRequest): Promise<IpcResult<SessionDto>>;
  setMenuBarVisibility(input: SetMenuBarVisibilityRequest): Promise<IpcResult<{ success: true }>>;
  listNotificationPresentations(): Promise<IpcResult<NotificationPresentationDto[]>>;
  listAuditHistory(): Promise<IpcResult<AuditHistoryEntryDto[]>>;
  setNotificationPresentations(
    input: SetNotificationPresentationsRequest,
  ): Promise<IpcResult<NotificationPresentationDto[]>>;
  updateCashPolicy(input: UpdateCashPolicyRequest): Promise<IpcResult<ManagedRecordsDto>>;
  listRecords(): Promise<IpcResult<ManagedRecordsDto>>;
  upsertRecord(input: UpsertManagedEntityRequest): Promise<IpcResult<ManagedRecordsDto>>;
  upsertIncomePlan(input: UpsertIncomePlanRequest): Promise<IpcResult<ManagedRecordsDto>>;
  deleteRecord(input: DeleteManagedEntityRequest): Promise<IpcResult<ManagedRecordsDto>>;
  createBackup(input: BackupRequest): Promise<IpcResult<FileActionResultDto>>;
  restoreBackup(input: RestoreRequest): Promise<IpcResult<FileActionResultDto>>;
  exportData(): Promise<IpcResult<FileActionResultDto>>;
  importJson(input: JsonImportRequest): Promise<IpcResult<FileActionResultDto>>;
  resetUserData(input: ResetUserDataRequest): Promise<IpcResult<{ success: true }>>;
  getImportReview(): Promise<IpcResult<ImportReviewDto>>;
  getUpdateStatus(): Promise<IpcResult<UpdateStatusDto>>;
  checkForUpdates(): Promise<IpcResult<UpdateStatusDto>>;
  deferUpdate(): Promise<IpcResult<UpdateStatusDto>>;
  restartForUpdate(): Promise<IpcResult<UpdateStatusDto>>;
  openMicrosoftStore(): Promise<IpcResult<{ success: true }>>;
  openPrivacyPolicy(): Promise<IpcResult<{ success: true }>>;
  onUpdateStatus(listener: (status: UpdateStatusDto) => void): () => void;
  getPostUpdateNotice(): Promise<IpcResult<PostUpdateNoticeDto | null>>;
  acknowledgePostUpdateNotice(): Promise<IpcResult<{ success: true }>>;
}
