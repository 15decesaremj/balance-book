import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    username: text('username').notNull(),
    passwordSalt: text('password_salt'),
    passwordHash: text('password_hash'),
    passwordCreatedAt: text('password_created_at'),
    onboardingComplete: integer('onboarding_complete', { mode: 'boolean' })
      .notNull()
      .default(false),
    themePreference: text('theme_preference', {
      enum: ['system', 'light', 'dark'],
    })
      .notNull()
      .default('dark'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: text('locked_until'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('profiles_username_unique').on(table.username)],
);

export const onboardingDrafts = sqliteTable('onboarding_drafts', {
  userId: text('user_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  valuesJson: text('values_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const cashAccounts = sqliteTable(
  'cash_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['checking', 'savings', 'cash', 'other'] }).notNull(),
    openingBalanceCents: integer('opening_balance_cents').notNull(),
    availableBalanceCents: integer('available_balance_cents'),
    balanceAsOf: text('balance_as_of').notNull(),
    includedInLiquidity: integer('included_in_liquidity', { mode: 'boolean' })
      .notNull()
      .default(true),
    canFundOtherAccounts: integer('can_fund_other_accounts', { mode: 'boolean' })
      .notNull()
      .default(true),
    showOnOverview: integer('show_on_overview', { mode: 'boolean' }).notNull().default(true),
    hardFloorCents: integer('hard_floor_cents'),
    preferredFloorCents: integer('preferred_floor_cents'),
    transferDelayDays: integer('transfer_delay_days').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('cash_accounts_user_idx').on(table.userId)],
);

export const forecastEvents = sqliteTable(
  'forecast_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => cashAccounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    kind: text('kind').notNull(),
    direction: text('direction', { enum: ['inflow', 'outflow'] }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    certainty: text('certainty', { enum: ['confirmed', 'expected', 'uncertain'] }).notNull(),
    status: text('status').notNull(),
    label: text('label').notNull(),
    manualOrder: integer('manual_order'),
    sourceRecordId: text('source_record_id'),
    transferId: text('transfer_id'),
    hypothetical: integer('hypothetical', { mode: 'boolean' }).notNull().default(false),
    accepted: integer('accepted', { mode: 'boolean' }).notNull().default(false),
    includeInConservative: integer('include_in_conservative', { mode: 'boolean' }),
    recurrenceJson: text('recurrence_json'),
    recurrenceEndDate: text('recurrence_end_date'),
    paymentMethod: text('payment_method', {
      enum: ['cash-account', 'credit-card', 'payroll-deduction'],
    })
      .notNull()
      .default('cash-account'),
    cardId: text('card_id'),
    cardActivityTreatment: text('card_activity_treatment', {
      enum: ['additional', 'included-in-cycle-total'],
    })
      .notNull()
      .default('additional'),
    loanPaymentTreatment: text('loan_payment_treatment', {
      enum: ['scheduled-draft-override', 'additional-principal'],
    })
      .notNull()
      .default('scheduled-draft-override'),
    incomeType: text('income_type', {
      enum: [
        'paycheck',
        'bonus',
        'commission',
        'self-employment',
        'partner-contribution',
        'raise-adjustment',
        'other',
      ],
    }),
    parentIncomeEventId: text('parent_income_event_id'),
    incomePlanId: text('income_plan_id'),
    incomeStreamId: text('income_stream_id'),
    incomePlanTotalCents: integer('income_plan_total_cents'),
    incomeNominalDate: text('income_nominal_date'),
    incomeArrivalOffsetDays: integer('income_arrival_offset_days'),
    incomeAllocationRule: text('income_allocation_rule', { enum: ['fixed', 'remainder'] }),
    incomeAllocationOrder: integer('income_allocation_order'),
    parentIncomePlanId: text('parent_income_plan_id'),
    receivableOccurrenceDate: text('receivable_occurrence_date'),
    receivableOccurrenceTargetCents: integer('receivable_occurrence_target_cents'),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('forecast_events_user_date_idx').on(table.userId, table.date),
    index('forecast_events_account_idx').on(table.accountId),
    index('forecast_events_income_plan_idx').on(table.incomePlanId),
    index('forecast_events_income_stream_idx').on(table.userId, table.incomeStreamId),
  ],
);

export const cashFloorPolicies = sqliteTable('cash_floor_policies', {
  userId: text('user_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  hardConsolidatedFloorCents: integer('hard_consolidated_floor_cents').notNull(),
  preferredConsolidatedFloorCents: integer('preferred_consolidated_floor_cents'),
  horizonDays: integer('horizon_days').notNull().default(90),
  includeConfirmedReceivablesConservatively: integer(
    'include_confirmed_receivables_conservatively',
    { mode: 'boolean' },
  )
    .notNull()
    .default(true),
  updatedAt: text('updated_at').notNull(),
});

export const creditCards = sqliteTable(
  'credit_cards',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    issuer: text('issuer'),
    lastFour: text('last_four'),
    fundingAccountId: text('funding_account_id')
      .notNull()
      .references(() => cashAccounts.id, { onDelete: 'cascade' }),
    accountKind: text('account_kind', {
      enum: ['credit-card', 'charge-card', 'line-of-credit'],
    })
      .notNull()
      .default('credit-card'),
    creditLimitCents: integer('credit_limit_cents'),
    reportedBalanceCents: integer('reported_balance_cents'),
    reportedBalanceDate: text('reported_balance_date'),
    reportedCarryingBalanceCents: integer('reported_carrying_balance_cents'),
    reportedCarryingBalanceDate: text('reported_carrying_balance_date'),
    defaultFutureStatementCents: integer('default_future_statement_cents').notNull(),
    estimatePolicy: text('estimate_policy', {
      enum: ['actual-reset', 'baseline-guardrail'],
    }).notNull(),
    paymentPolicy: text('payment_policy', {
      enum: ['full-statement', 'minimum', 'fixed', 'manual'],
    }).notNull(),
    fixedPaymentCents: integer('fixed_payment_cents'),
    minimumPaymentCents: integer('minimum_payment_cents'),
    aprBasisPoints: integer('apr_basis_points'),
    promotionEndDate: text('promotion_end_date'),
    paymentDayOfMonth: integer('payment_day_of_month').notNull().default(1),
    statementCloseDayOfMonth: integer('statement_close_day_of_month').notNull().default(1),
    cycleTimingComplete: integer('cycle_timing_complete', { mode: 'boolean' })
      .notNull()
      .default(true),
    status: text('status', { enum: ['active', 'closed'] })
      .notNull()
      .default('active'),
    closedOn: text('closed_on'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('credit_cards_user_idx').on(table.userId)],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('audit_events_user_created_idx').on(table.userId, table.createdAt)],
);

export const creditCardCycles = sqliteTable(
  'credit_card_cycles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    cardId: text('card_id')
      .notNull()
      .references(() => creditCards.id, { onDelete: 'cascade' }),
    opensOn: text('opens_on').notNull(),
    closesOn: text('closes_on').notNull(),
    dueOn: text('due_on').notNull(),
    state: text('state').notNull(),
    defaultEstimateCents: integer('default_estimate_cents').notNull(),
    actualActivityCents: integer('actual_activity_cents').notNull().default(0),
    plannedActivityCents: integer('planned_activity_cents').notNull().default(0),
    lockedStatementCents: integer('locked_statement_cents'),
    projectionOverrideCents: integer('projection_override_cents'),
    paymentOn: text('payment_on'),
    actualPaymentCents: integer('actual_payment_cents'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('credit_card_cycles_user_card_idx').on(table.userId, table.cardId)],
);

export const loans = sqliteTable(
  'loans',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lender: text('lender'),
    loanType: text('loan_type'),
    principalCents: integer('principal_cents').notNull(),
    accruedInterestCents: integer('accrued_interest_cents').notNull().default(0),
    balanceDate: text('balance_date').notNull(),
    annualRateBasisPoints: integer('annual_rate_basis_points').notNull(),
    accrualConvention: text('accrual_convention').notNull(),
    paymentCents: integer('payment_cents').notNull(),
    cashPaymentCents: integer('cash_payment_cents'),
    nextPaymentDate: text('next_payment_date').notNull(),
    maturityDate: text('maturity_date'),
    originalPrincipalCents: integer('original_principal_cents'),
    originalDate: text('original_date'),
    originalTermMonths: integer('original_term_months'),
    amortizationStructure: text('amortization_structure', {
      enum: ['fully-amortizing', 'balloon'],
    })
      .notNull()
      .default('fully-amortizing'),
    expectedBalloonCents: integer('expected_balloon_cents'),
    inferredFieldsJson: text('inferred_fields_json'),
    fundingAccountId: text('funding_account_id')
      .notNull()
      .references(() => cashAccounts.id, { onDelete: 'restrict' }),
    excludeFromEconomicNetWorthDoubleCount: integer('exclude_from_economic_double_count', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    paymentFrequency: text('payment_frequency', { enum: ['monthly', 'biweekly'] })
      .notNull()
      .default('monthly'),
    includeInCashForecast: integer('include_in_cash_forecast', { mode: 'boolean' })
      .notNull()
      .default(true),
    status: text('status', { enum: ['active', 'paid-off'] })
      .notNull()
      .default('active'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('loans_user_idx').on(table.userId)],
);

export const committedRefinancePlans = sqliteTable(
  'committed_refinance_plans',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['committed', 'cancelled'] }).notNull(),
    closingDate: text('closing_date').notNull(),
    payoffDate: text('payoff_date').notNull(),
    firstPaymentDate: text('first_payment_date').notNull(),
    replacementLoanId: text('replacement_loan_id')
      .notNull()
      .references(() => loans.id, { onDelete: 'restrict' }),
    /** Immutable terms as committed; the linked loan row may later receive balance updates. */
    replacementLoanSnapshotJson: text('replacement_loan_snapshot_json').notNull(),
    assetRelinksJson: text('asset_relinks_json').notNull().default('[]'),
    principalCashContributionCents: integer('principal_cash_contribution_cents')
      .notNull()
      .default(0),
    closingCostsCents: integer('closing_costs_cents').notNull().default(0),
    financedFeesCents: integer('financed_fees_cents').notNull().default(0),
    cashSourceAccountId: text('cash_source_account_id').references(() => cashAccounts.id, {
      onDelete: 'restrict',
    }),
    excessProceedsCents: integer('excess_proceeds_cents').notNull().default(0),
    excessProceedsAccountId: text('excess_proceeds_account_id').references(() => cashAccounts.id, {
      onDelete: 'restrict',
    }),
    notes: text('notes'),
    cancelledAt: text('cancelled_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('committed_refinance_plans_user_status_idx').on(table.userId, table.status),
    uniqueIndex('committed_refinance_plans_replacement_loan_unique').on(table.replacementLoanId),
  ],
);

export const committedRefinancePayoffs = sqliteTable(
  'committed_refinance_payoffs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => committedRefinancePlans.id, { onDelete: 'cascade' }),
    sourceLoanId: text('source_loan_id')
      .notNull()
      .references(() => loans.id, { onDelete: 'restrict' }),
    payoffAmountCents: integer('payoff_amount_cents').notNull(),
    sourceRefinancePlanId: text('source_refinance_plan_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('committed_refinance_payoffs_user_loan_idx').on(table.userId, table.sourceLoanId),
    uniqueIndex('committed_refinance_payoffs_plan_loan_unique').on(
      table.userId,
      table.planId,
      table.sourceLoanId,
    ),
  ],
);

export const receivables = sqliteTable(
  'receivables',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    description: text('description').notNull(),
    originalAmountCents: integer('original_amount_cents').notNull(),
    remainingAmountCents: integer('remaining_amount_cents').notNull(),
    expectedDate: text('expected_date').notNull(),
    settlementDateConfirmed: integer('settlement_date_confirmed', { mode: 'boolean' })
      .notNull()
      .default(true),
    settlementAnchorEventId: text('settlement_anchor_event_id').references(
      () => forecastEvents.id,
      { onDelete: 'restrict' },
    ),
    settlementOffsetDays: integer('settlement_offset_days'),
    destinationAccountId: text('destination_account_id')
      .notNull()
      .references(() => cashAccounts.id, { onDelete: 'restrict' }),
    certainty: text('certainty').notNull(),
    grossExpenseCents: integer('gross_expense_cents'),
    userEconomicShareCents: integer('user_economic_share_cents'),
    relatedExpenseId: text('related_expense_id').references(() => forecastEvents.id, {
      onDelete: 'set null',
    }),
    paymentInstrument: text('payment_instrument'),
    recurringAmountCents: integer('recurring_amount_cents'),
    recurrenceJson: text('recurrence_json'),
    recurrenceEndDate: text('recurrence_end_date'),
    accrualAmountCents: integer('accrual_amount_cents'),
    accrualDate: text('accrual_date'),
    accrualRecurrenceJson: text('accrual_recurrence_json'),
    includeInCashForecast: integer('include_in_cash_forecast', { mode: 'boolean' })
      .notNull()
      .default(true),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('receivables_user_idx').on(table.userId)],
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    valueCents: integer('value_cents').notNull(),
    valuationDate: text('valuation_date').notNull(),
    contributionAmountCents: integer('contribution_amount_cents'),
    contributionRateBasisPoints: integer('contribution_rate_basis_points'),
    employerMatchBasisPoints: integer('employer_match_basis_points'),
    restrictionStatus: text('restriction_status', {
      enum: ['unrestricted', 'partially-restricted', 'restricted', 'unknown'],
    }),
    linkedLiabilityId: text('linked_liability_id').references(() => loans.id, {
      onDelete: 'set null',
    }),
    includedInNetWorth: integer('included_in_net_worth', { mode: 'boolean' })
      .notNull()
      .default(true),
    includedInLiquidity: integer('included_in_liquidity', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('assets_user_idx').on(table.userId)],
);

export const rewardPrograms = sqliteTable(
  'reward_programs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    cardId: text('card_id')
      .notNull()
      .references(() => creditCards.id, { onDelete: 'cascade' }),
    rewardType: text('reward_type').notNull(),
    baseRateBasisPoints: integer('base_rate_basis_points').notNull(),
    pointValueMicros: integer('point_value_micros'),
    annualFeeCents: integer('annual_fee_cents').notNull().default(0),
    treatment: text('treatment').notNull(),
    expectedReceiptDate: text('expected_receipt_date'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('reward_programs_user_idx').on(table.userId)],
);

export const reconciliations = sqliteTable(
  'reconciliations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => cashAccounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    forecastBalanceCents: integer('forecast_balance_cents').notNull(),
    actualBalanceCents: integer('actual_balance_cents').notNull(),
    varianceCents: integer('variance_cents').notNull(),
    resolution: text('resolution').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('reconciliations_user_date_idx').on(table.userId, table.date)],
);

export const savedScenarios = sqliteTable(
  'saved_scenarios',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    settlementDate: text('settlement_date').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => cashAccounts.id, { onDelete: 'cascade' }),
    fundingType: text('funding_type', { enum: ['cash', 'card'] })
      .notNull()
      .default('cash'),
    cardId: text('card_id').references(() => creditCards.id, { onDelete: 'restrict' }),
    purchaseDate: text('purchase_date'),
    status: text('status').notNull(),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('saved_scenarios_user_idx').on(table.userId)],
);

export const importBatches = sqliteTable(
  'import_batches',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    workbookChecksum: text('workbook_checksum').notNull(),
    sourceFileName: text('source_file_name').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    rolledBackAt: text('rolled_back_at'),
  },
  (table) => [index('import_batches_user_idx').on(table.userId, table.createdAt)],
);

export const importLineage = sqliteTable(
  'import_lineage',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    batchId: text('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    sourceSheet: text('source_sheet').notNull(),
    sourceRange: text('source_range').notNull(),
    rawValueJson: text('raw_value_json').notNull(),
    parsedValueJson: text('parsed_value_json'),
    transformation: text('transformation').notNull(),
    confidence: text('confidence').notNull(),
    warning: text('warning'),
    sourceChecksum: text('source_checksum').notNull(),
    destinationValueJson: text('destination_value_json'),
    destinationEditedAt: text('destination_edited_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('import_lineage_user_entity_idx').on(table.userId, table.entityType, table.entityId),
    uniqueIndex('import_lineage_source_field_unique').on(
      table.userId,
      table.sourceChecksum,
      table.sourceSheet,
      table.sourceRange,
      table.entityType,
      table.entityId,
      table.field,
    ),
  ],
);

export const schema = {
  profiles,
  onboardingDrafts,
  cashAccounts,
  forecastEvents,
  cashFloorPolicies,
  creditCards,
  auditEvents,
  creditCardCycles,
  loans,
  committedRefinancePlans,
  committedRefinancePayoffs,
  receivables,
  assets,
  rewardPrograms,
  reconciliations,
  savedScenarios,
  importBatches,
  importLineage,
};
