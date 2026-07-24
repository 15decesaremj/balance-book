import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import {
  BalanceBookStore,
  LocalAuthService,
  parseUserDataExport,
  readEncryptedBackup,
  writeEncryptedBackup,
  writeUserExports,
  type InitialProfile,
  type ProfileSummary,
} from '@balance-book/database';
import {
  compareDates,
  forecastEventSchema,
  moneyCentsSchema,
  plainDateSchema,
  type ForecastEvent,
  type PlainDateString,
} from '@balance-book/domain';
import {
  accrueSimpleInterest,
  activeLoansForDate,
  assessReceivableFundingCoverageSequence,
  assessPurchaseSafety,
  effectiveAssetsForDate,
  assertCashBackedCardPurchaseEligibility,
  buildForecastBundle,
  calculateCardSpendingPower,
  calculateCardPurchaseCashImpact,
  calculateLongRunMonthlyFreeCashFlow,
  calculateNetWorth,
  cardsForInterestForecast,
  evaluateScenarios,
  generateCardCyclesThroughHorizon,
  lowestTotalPositionFromDate,
  materializeCommittedRefinanceEvents,
  pendingRefinanceSettlementCentsForDate,
  pendingRefinanceEconomicSettlementCentsForDate,
  prepareRollingForecastContext,
  projectAssetsAtDate,
  projectRollingReceivableBalances,
  roundInterestToCents,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';
import {
  createPasswordRequestSchema,
  auditHistoryEntrySchema,
  backupRequestSchema,
  billPlanRequestSchema,
  combinedScenarioRequestSchema,
  commitRefinancePlanRequestSchema,
  cancelRefinancePlanRequestSchema,
  deleteManagedEntityRequestSchema,
  displayStateForForecastEvent,
  emptyRequestSchema,
  forecastRequestSchema,
  fileActionResultSchema,
  forecastSnapshotSchema,
  importReviewSchema,
  internalTransferRequestSchema,
  jsonImportRequestSchema,
  loginRequestSchema,
  managedRecordsSchema,
  notificationPresentationSchema,
  onboardingDraftSchema,
  overviewExpenseRequestSchema,
  postUpdateNoticeSchema,
  profileSummarySchema,
  receivableSettlementRequestSchema,
  unattributedReceivableSettlementRequestSchema,
  resultSchema,
  scenarioRequestSchema,
  scenarioResponseSchema,
  saveOnboardingDraftRequestSchema,
  scenarioActionRequestSchema,
  restoreRequestSchema,
  resetUserDataRequestSchema,
  sessionSchema,
  setMenuBarVisibilityRequestSchema,
  setPreferencesRequestSchema,
  setNotificationPresentationsRequestSchema,
  setThemeRequestSchema,
  successSchema,
  updateStatusSchema,
  upsertManagedEntityRequestSchema,
  upsertIncomePlanRequestSchema,
  updateCashPolicyRequestSchema,
  verticalSliceInputSchema,
  type ForecastSnapshotDto,
  type PostUpdateNoticeDto,
  type SessionDto,
  type UpdateStatusDto,
} from './shared/contracts';
import { handleSquirrelStartupEvent } from './squirrel-startup';
import { buildReceivableAccrualDailyEvents } from './receivable-accrual-events';
import { BalanceBookUpdateService } from './update-service';
import { pendingUpdateMetadataSchema, postUpdateNoticeFromMetadata } from './update-metadata';
import { createVerifiedUpdateRecoverySnapshot } from './update-recovery';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'balance-book',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);
app.setName('Balance Book');
app.setAppUserModelId('com.squirrel.balance_book_mvp.BalanceBook');

let store: BalanceBookStore;
let auth: LocalAuthService;
let activeUserId: string | null = null;
let updateService: BalanceBookUpdateService;
let postUpdateNotice: PostUpdateNoticeDto | null = null;

const pendingUpdateMetadataPath = (): string =>
  path.join(app.getPath('userData'), 'pending-update.json');

const loadPostUpdateNotice = (): PostUpdateNoticeDto | null => {
  const metadataPath = pendingUpdateMetadataPath();
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return postUpdateNoticeFromMetadata(
      JSON.parse(fs.readFileSync(metadataPath, 'utf8')),
      app.getVersion(),
    );
  } catch {
    fs.rmSync(metadataPath, { force: true });
    return null;
  }
};

const broadcastUpdateStatus = (): void => {
  if (!updateService) return;
  const status = updateService.getStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('updates:status-changed', status);
  }
};

const rendererCanRestartForUpdate = async (): Promise<boolean> => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  const decisions = await Promise.all(
    windows.map(
      (window) =>
        new Promise<boolean>((resolve) => {
          const requestId = crypto.randomUUID();
          const channel = `updates:restart-readiness:${requestId}`;
          const timeout = setTimeout(() => {
            ipcMain.removeAllListeners(channel);
            resolve(false);
          }, 5_000);
          ipcMain.once(channel, (event, raw: unknown) => {
            clearTimeout(timeout);
            resolve(
              event.sender.id === window.webContents.id &&
                typeof raw === 'object' &&
                raw !== null &&
                (raw as { canRestart?: unknown }).canRestart === true,
            );
          });
          window.webContents.send('updates:prepare-restart', { requestId });
        }),
    ),
  );
  return decisions.every(Boolean);
};

const createUpdateRecoverySnapshot = async (): Promise<void> => {
  await createVerifiedUpdateRecoverySnapshot({
    database: store.raw,
    directory: path.join(app.getPath('userData'), 'update-backups'),
    currentVersion: app.getVersion(),
  });
};

const prepareUpdateInstall = async (status: UpdateStatusDto): Promise<void> => {
  if (!(await rendererCanRestartForUpdate())) {
    throw new Error('Save or cancel any open edits, then choose Update and restart again.');
  }
  await createUpdateRecoverySnapshot();
  const metadataPath = pendingUpdateMetadataPath();
  const temporaryPath = `${metadataPath}.tmp`;
  await fs.promises.writeFile(
    temporaryPath,
    JSON.stringify(
      pendingUpdateMetadataSchema.parse({
        oldVersion: app.getVersion(),
        releaseName: status.releaseName,
        releaseNotes: status.releaseNotes,
        initiatedAt: new Date().toISOString(),
      }),
    ),
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.promises.rename(temporaryPath, metadataPath);
};

const initialProfileSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(120),
  username: z.string().min(1).max(128),
  onboardingComplete: z.boolean().optional(),
});

const loadInitialProfiles = (): InitialProfile[] => {
  const explicitPath = process.env.BALANCE_BOOK_BOOTSTRAP_PROFILES;
  const localPath = path.join(process.cwd(), 'local-data', 'bootstrap-profiles.json');
  const configPath = explicitPath ?? (fs.existsSync(localPath) ? localPath : undefined);
  if (configPath) {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return z.array(initialProfileSchema).min(2).parse(parsed);
  }
  return [
    { id: 'profile-owner', displayName: 'Owner', username: 'owner' },
    { id: 'profile-new-user', displayName: 'New User', username: 'newuser' },
  ];
};

const safeError = (error: unknown): string => {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues)) {
    const issue = issues[0] as { message?: unknown; path?: unknown; code?: unknown } | undefined;
    if (!issue) return 'Invalid request';
    const path = Array.isArray(issue.path) ? issue.path : [];
    const location = path.length > 0 ? path.join('.') : 'request';
    const message = typeof issue.message === 'string' ? issue.message : 'Invalid input';
    const code = typeof issue.code === 'string' ? issue.code : 'validation';
    return `${message} (${location}; ${code})`.slice(0, 300);
  }
  if (error instanceof Error) return error.message.slice(0, 300);
  return 'The operation could not be completed';
};

const isTrustedRendererUrl = (value: string): boolean => {
  try {
    const candidate = new URL(value);
    if (candidate.protocol === 'balance-book:' && candidate.hostname === 'app') return true;
    if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) return false;
    return candidate.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
  } catch {
    return false;
  }
};

const validateSender = (event: IpcMainInvokeEvent): void => {
  const url = event.senderFrame?.url ?? '';
  if (!isTrustedRendererUrl(url)) throw new Error('Untrusted renderer');
};

const handle = <Request, Response>(
  channel: string,
  requestSchema: z.ZodType<Request>,
  responseSchema: z.ZodType<Response>,
  action: (request: Request) => Promise<Response> | Response,
): void => {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    try {
      validateSender(event);
      const request = requestSchema.parse(raw);
      const value = await action(request);
      return resultSchema(responseSchema).parse({ ok: true, value });
    } catch (error) {
      return resultSchema(responseSchema).parse({ ok: false, error: safeError(error) });
    }
  });
};

const requireUser = (): string => {
  if (!activeUserId) throw new Error('Please sign in');
  return activeUserId;
};

const sessionFor = (profile: ProfileSummary): SessionDto => {
  const credentials = store.getCredentialsById(profile.id);
  if (!credentials) throw new Error('Profile not found');
  return sessionSchema.parse({
    profile,
    themePreference: credentials.themePreference,
    preferences: credentials.preferences,
  });
};

const currentFinancialDate = (): PlainDateString =>
  plainDateSchema.parse(process.env.BALANCE_BOOK_TODAY ?? Temporal.Now.plainDateISO().toString());

const prepareForecast = (userId: string, requiredEndDate?: PlainDateString) => {
  const data = store.getForecastData(userId);
  if (!data) return undefined;
  const records = store.getManagedRecords(userId);
  const preferences = store.getCredentialsById(userId)?.preferences;
  const includeCardInterest = preferences?.experimentalCardInterestForecastEnabled ?? false;
  const forecastCards = cardsForInterestForecast(records.cards, includeCardInterest);
  const today = currentFinancialDate();
  const { accounts, startDate, endDate, replayStartDate } = prepareRollingForecastContext({
    accounts: data.accounts,
    events: data.events,
    cards: forecastCards,
    cardCycles: records.cardCycles,
    loans: records.loans,
    committedRefinancePlans: records.committedRefinancePlans,
    receivables: records.receivables,
    policy: data.policy,
    includeCardInterest,
    requestedStartDate: today,
    ...(requiredEndDate === undefined ? {} : { requiredEndDate }),
  });

  const scheduledEvents = materializeCommittedRefinanceEvents({
    accounts,
    events: data.events,
    cards: forecastCards,
    cardCycles: records.cardCycles,
    loans: records.loans,
    plans: records.committedRefinancePlans,
    receivables: records.receivables,
    includeCardInterest,
    startDate,
    endDate,
  });
  const bundle = buildForecastBundle({
    accounts,
    events: scheduledEvents,
    policy: data.policy,
    startDate,
    endDate,
  });
  return {
    data,
    records,
    accounts,
    scheduledEvents,
    bundle,
    startDate,
    endDate,
    replayStartDate,
  };
};

const buildLongRunMonthlyFreeCashFlow = (userId: string) => {
  const currentMonth = Temporal.PlainDate.from(currentFinancialDate()).with({ day: 1 });
  // Let current-cycle statements and the next two calendar months clear before measuring a stable
  // 12-month budget run. This avoids presenting near-term reconciliation noise as recurring margin.
  const windowStart = currentMonth.add({ months: 3 });
  const windowEnd = windowStart.add({ months: 12 }).subtract({ days: 1 });
  const positionDateBeforeWindow = windowStart.subtract({ days: 1 });
  const context = prepareForecast(userId, windowEnd.toString());
  if (!context) return undefined;

  const receivables = projectRollingReceivableBalances({
    receivables: context.records.receivables,
    settlementEvents: context.data.events,
    replayStartDate: context.replayStartDate,
    startDate: context.startDate,
    endDate: context.endDate,
    mode: 'expected',
    includeConfirmedReceivablesConservatively:
      context.data.policy.includeConfirmedReceivablesConservatively,
  });
  const positionOn = (date: PlainDateString): number => {
    const index = context.bundle.expected.days.findIndex((day) => day.date === date);
    if (index < 0) throw new Error(`Long-run cash-flow date ${date} is outside the forecast`);
    return moneyCentsSchema.parse(
      context.bundle.expected.days[index]!.consolidatedCashCents +
        receivables[index]!.endingOutstandingCents,
    );
  };

  return calculateLongRunMonthlyFreeCashFlow({
    positionBeforeWindowCents: positionOn(positionDateBeforeWindow.toString()),
    positionAtWindowEndCents: positionOn(windowEnd.toString()),
    monthlyPositionCents: [
      positionOn(positionDateBeforeWindow.toString()),
      ...Array.from({ length: 12 }, (_, offset) =>
        positionOn(
          windowStart
            .add({ months: offset + 1 })
            .subtract({ days: 1 })
            .toString(),
        ),
      ),
    ],
    events: context.scheduledEvents,
    scheduledCardCycleIds: new Set(
      context.records.cardCycles
        .filter((cycle) => cycle.state === 'scheduled-payment')
        .map((cycle) => cycle.id),
    ),
    scheduledCardPaymentEventIds: new Set(
      context.records.events
        .filter((event) => event.kind === 'card-payment')
        .map((event) => event.id),
    ),
    windowStart: windowStart.toString(),
    windowEnd: windowEnd.toString(),
    monthCount: 12,
  });
};

const buildSnapshot = (userId: string, requiredEndDate?: PlainDateString): ForecastSnapshotDto => {
  const context = prepareForecast(userId, requiredEndDate);
  if (!context) return { setupComplete: false };
  const { data, records, accounts, scheduledEvents, bundle, startDate, endDate, replayStartDate } =
    context;
  const conservativeReceivables = projectRollingReceivableBalances({
    receivables: records.receivables,
    settlementEvents: data.events,
    replayStartDate,
    startDate,
    endDate,
    mode: 'conservative',
    includeConfirmedReceivablesConservatively:
      data.policy.includeConfirmedReceivablesConservatively,
  });
  const expectedReceivables = projectRollingReceivableBalances({
    receivables: records.receivables,
    settlementEvents: data.events,
    replayStartDate,
    startDate,
    endDate,
    mode: 'expected',
    includeConfirmedReceivablesConservatively:
      data.policy.includeConfirmedReceivablesConservatively,
  });
  const conservativePositionDays = bundle.conservative.days.map((day, index) => ({
    day,
    receivableCents: conservativeReceivables[index]!.endingOutstandingCents,
    positionCents:
      day.consolidatedCashCents + conservativeReceivables[index]!.endingOutstandingCents,
  }));
  const expectedPositionDays = bundle.expected.days.map((day, index) => ({
    day,
    receivableCents: expectedReceivables[index]!.endingOutstandingCents,
    positionCents: day.consolidatedCashCents + expectedReceivables[index]!.endingOutstandingCents,
  }));
  const conservativePositionLow = conservativePositionDays.reduce((lowest, candidate) =>
    candidate.positionCents < lowest.positionCents ? candidate : lowest,
  );
  const expectedPositionLow = expectedPositionDays.reduce((lowest, candidate) =>
    candidate.positionCents < lowest.positionCents ? candidate : lowest,
  );
  const conservativeDailyLow = bundle.conservative.days.reduce((lowest, day) =>
    day.consolidatedCashCents < lowest.consolidatedCashCents ? day : lowest,
  );
  const expectedDailyLow = bundle.expected.days.reduce((lowest, day) =>
    day.consolidatedCashCents < lowest.consolidatedCashCents ? day : lowest,
  );
  const accountDailyLow = (
    days: typeof bundle.expected.days,
    accountId: string,
    balanceAsOf: PlainDateString,
  ): (typeof bundle.expected.days)[number] | undefined => {
    const activeDays = days.filter((day) => compareDates(day.date, balanceAsOf) >= 0);
    if (activeDays.length === 0) return undefined;
    return activeDays.reduce((lowest, day) => {
      const candidate = day.accounts.find((account) => account.accountId === accountId)!;
      const current = lowest.accounts.find((account) => account.accountId === accountId)!;
      return candidate.endingBalanceCents < current.endingBalanceCents ? day : lowest;
    });
  };
  const effectiveLoans = activeLoansForDate({
    accounts,
    loans: records.loans,
    plans: records.committedRefinancePlans,
    loanPaymentEvents: records.events,
    date: startDate,
  });
  const effectiveAssets = effectiveAssetsForDate({
    assets: records.assets,
    plans: records.committedRefinancePlans,
    date: startDate,
  });
  const restrictedRefinanceSettlementCents = pendingRefinanceSettlementCentsForDate({
    plans: records.committedRefinancePlans,
    date: startDate,
  });
  const economicRestrictedRefinanceSettlementCents = pendingRefinanceEconomicSettlementCentsForDate(
    {
      plans: records.committedRefinancePlans,
      loans: records.loans,
      date: startDate,
    },
  );
  const revolvingDebtEvents = [...records.events, ...scheduledEvents];
  const revolvingDebt = records.cards.map((card) => {
    const summary = summarizeRevolvingDebt({
      card,
      cycles: records.cardCycles,
      asOfDate: startDate,
      // Cash projection materialization intentionally omits card-funded purchases,
      // while it adds generated payment occurrences. Debt needs both sets; the
      // revolving engine de-duplicates materialized descendants by lineage.
      events: revolvingDebtEvents,
    });
    return {
      cardId: card.id,
      reportedBalanceCents: card.reportedBalanceCents,
      reportedBalanceDate: card.reportedBalanceDate,
      calculatedThroughDate: startDate,
      postSourceActivityCents:
        card.reportedBalanceCents === undefined
          ? undefined
          : summary.currentBalanceCents - card.reportedBalanceCents,
      ...summary,
    };
  });
  const totalRevolvingDebtCents = moneyCentsSchema.parse(
    revolvingDebt.reduce((total, card) => total + card.currentBalanceCents, 0),
  );
  const expectedCurrentDayAppliedEventIds = new Set(bundle.expected.days[0]!.appliedEventIds);
  const expectedCurrentDayDebtEvents = revolvingDebtEvents.filter(
    (event) =>
      event.kind !== 'card-payment' ||
      event.status === 'confirmed' ||
      event.status === 'paid' ||
      expectedCurrentDayAppliedEventIds.has(event.id),
  );
  const expectedCurrentDayRevolvingDebt = records.cards.map((card) =>
    summarizeRevolvingDebt({
      card,
      cycles: records.cardCycles,
      asOfDate: startDate,
      events: expectedCurrentDayDebtEvents,
      paymentEvidenceMode: 'include-projected-payments',
    }),
  );
  const expectedCurrentDayRevolvingDebtCents = moneyCentsSchema.parse(
    expectedCurrentDayRevolvingDebt.reduce((total, card) => total + card.currentBalanceCents, 0),
  );
  const totalCarryingDebtCents = moneyCentsSchema.parse(
    revolvingDebt.reduce((total, card) => total + card.carryingBalanceCents, 0),
  );
  const netWorth = calculateNetWorth({
    cashAccounts: records.accounts,
    assets: effectiveAssets,
    receivables: records.receivables,
    loans: effectiveLoans,
    // Today's expected cash close includes only applied ledger events. Use the same payment basis
    // for net-worth debt, while `revolvingDebt` above remains actual evidence for Overview.
    revolvingDebtCents: expectedCurrentDayRevolvingDebtCents,
    liquidCashCentsOverride: expectedPositionDays[0]!.day.consolidatedCashCents,
    allCashCentsOverride: moneyCentsSchema.parse(
      expectedPositionDays[0]!.day.accounts.reduce(
        (total, account) => total + account.endingBalanceCents,
        expectedPositionDays[0]!.day.inTransitCents,
      ),
    ),
    receivablesCentsOverride: expectedPositionDays[0]!.receivableCents,
    restrictedRefinanceSettlementCents,
    economicRestrictedRefinanceSettlementCents,
  });
  const accountNameById = new Map(accounts.map((account) => [account.id, account.name]));
  const accountBalanceAsOfById = new Map(
    accounts.map((account) => [account.id, account.balanceAsOf]),
  );
  const accountHardFloorCentsById = Object.fromEntries(
    accounts
      .filter((account) => account.includedInLiquidity)
      .map((account) => [account.id, account.hardFloorCents ?? 0]),
  );
  const rewardByCardId = new Map(records.rewardPrograms.map((reward) => [reward.cardId, reward]));
  const transferNeedWithReceivableCoverage = (
    need: (typeof bundle.conservative.transferNeeds)[number],
    receivableCoverage: ReturnType<typeof assessReceivableFundingCoverageSequence>[number],
  ) => {
    return {
      accountId: need.accountId,
      accountName: accountNameById.get(need.accountId) ?? 'Unknown account',
      sourceAccountId: need.suggestedSourceAccountId,
      sourceAccountName: need.suggestedSourceAccountId
        ? accountNameById.get(need.suggestedSourceAccountId)
        : undefined,
      date: need.date,
      shortfallCents: need.shortfallCents,
      horizonDeepestShortfallCents: need.horizonDeepestShortfallCents,
      horizonDeepestShortfallDate: need.horizonDeepestShortfallDate,
      horizonAdditionalShortfallCents: need.horizonAdditionalShortfallCents,
      ...receivableCoverage,
      initiationDate: need.initiationDate,
      arrivalDate: need.arrivalDate,
      sourceSurplusAfterFloorsCents: need.sourceSurplusAfterFloorsCents,
    };
  };
  const conservativeReceivableCoverage = assessReceivableFundingCoverageSequence({
    needs: bundle.conservative.transferNeeds,
    receivableDays: conservativeReceivables,
  });
  const expectedReceivableCoverage = assessReceivableFundingCoverageSequence({
    needs: bundle.expected.transferNeeds,
    receivableDays: expectedReceivables,
  });
  const expectedCardSpendingPower = calculateCardSpendingPower({
    cards: records.cards,
    cardCycles: records.cardCycles,
    cardActivities: data.events,
    asOfDate: startDate,
    hardFloorCents: bundle.expected.effectiveHardFloorCents,
    accountHardFloorCentsById,
    includedAccountIds: accounts
      .filter((account) => account.includedInLiquidity)
      .map((account) => account.id),
    days: expectedPositionDays.map(({ day, positionCents, receivableCents }) => ({
      date: day.date,
      consolidatedCashCents: day.consolidatedCashCents,
      minimumConsolidatedCashCents: day.minimumConsolidatedCashCents,
      receivableCents,
      totalPositionCents: positionCents,
      accountBalances: day.accounts.map((account) => ({
        accountId: account.accountId,
        endingBalanceCents: account.endingBalanceCents,
        minimumBalanceCents: account.minimumBalanceCents,
      })),
    })),
  });
  const conservativeCardSpendingPower = calculateCardSpendingPower({
    cards: records.cards,
    cardCycles: records.cardCycles,
    cardActivities: data.events,
    asOfDate: startDate,
    hardFloorCents: bundle.conservative.effectiveHardFloorCents,
    accountHardFloorCentsById,
    includedAccountIds: accounts
      .filter((account) => account.includedInLiquidity)
      .map((account) => account.id),
    days: conservativePositionDays.map(({ day, positionCents, receivableCents }) => ({
      date: day.date,
      consolidatedCashCents: day.consolidatedCashCents,
      minimumConsolidatedCashCents: day.minimumConsolidatedCashCents,
      receivableCents,
      totalPositionCents: positionCents,
      accountBalances: day.accounts.map((account) => ({
        accountId: account.accountId,
        endingBalanceCents: account.endingBalanceCents,
        minimumBalanceCents: account.minimumBalanceCents,
      })),
    })),
  });
  const activeLoans = effectiveLoans;
  const totalLoansCents = activeLoans.reduce(
    (total, loan) => total + loan.principalCents + loan.accruedInterestCents,
    0,
  );
  const totalDebtCents = moneyCentsSchema.parse(totalLoansCents + totalRevolvingDebtCents);
  const modeledDailyInterestCents = activeLoans.reduce(
    (total, loan) =>
      total +
      roundInterestToCents(
        accrueSimpleInterest({
          principalCents: loan.principalCents,
          annualRateBasisPoints: loan.annualRateBasisPoints,
          fromDate: '2026-01-01',
          toDate: '2026-01-02',
          convention: loan.accrualConvention,
        }),
      ),
    0,
  );
  const currentPositionDay = expectedPositionDays[0]!;
  const sourceAccountById = new Map(records.accounts.map((account) => [account.id, account]));
  const expectedExcludedEventIds = new Set(bundle.expected.excludedEventIds);
  const conservativeExcludedEventIds = new Set(bundle.conservative.excludedEventIds);
  const projectDailyNetWorth = (mode: 'expected' | 'conservative'): number[] => {
    const modeBundle = bundle[mode];
    const modeReceivables = mode === 'expected' ? expectedReceivables : conservativeReceivables;
    const excludedEventIds =
      mode === 'expected' ? expectedExcludedEventIds : conservativeExcludedEventIds;
    const debtEvents = revolvingDebtEvents.filter((event) => !excludedEventIds.has(event.id));
    return modeBundle.days.map((day, index) => {
      const loans = activeLoansForDate({
        accounts,
        loans: records.loans,
        plans: records.committedRefinancePlans,
        loanPaymentEvents: records.events,
        date: day.date,
      });
      const assets = projectAssetsAtDate(
        effectiveAssetsForDate({
          assets: records.assets,
          plans: records.committedRefinancePlans,
          date: day.date,
        }),
        day.date,
      );
      const revolvingDebtCents = moneyCentsSchema.parse(
        records.cards.reduce(
          (total, card) =>
            total +
            summarizeRevolvingDebt({
              card,
              cycles: records.cardCycles,
              asOfDate: day.date,
              events: debtEvents,
              paymentEvidenceMode: 'include-projected-payments',
            }).currentBalanceCents,
          0,
        ),
      );
      return calculateNetWorth({
        cashAccounts: records.accounts,
        assets,
        receivables: records.receivables,
        loans,
        revolvingDebtCents,
        allCashCentsOverride: moneyCentsSchema.parse(
          day.accounts.reduce(
            (total, account) => total + account.endingBalanceCents,
            day.inTransitCents,
          ),
        ),
        liquidCashCentsOverride: day.consolidatedCashCents,
        receivablesCentsOverride: modeReceivables[index]!.endingOutstandingCents,
        restrictedRefinanceSettlementCents: pendingRefinanceSettlementCentsForDate({
          plans: records.committedRefinancePlans,
          date: day.date,
        }),
        economicRestrictedRefinanceSettlementCents: pendingRefinanceEconomicSettlementCentsForDate({
          plans: records.committedRefinancePlans,
          loans: records.loans,
          date: day.date,
        }),
      }).contractualNetWorthCents;
    });
  };
  const conservativeDailyNetWorth = projectDailyNetWorth('conservative');
  const expectedDailyNetWorth = projectDailyNetWorth('expected');
  const longRunMonthlyFreeCashFlow = buildLongRunMonthlyFreeCashFlow(userId);
  const snapshot = forecastSnapshotSchema.safeParse({
    setupComplete: true,
    startDate,
    endDate,
    accountName: accounts[0]?.name,
    cardName: data.cards[0]?.name,
    conservativeTroughCents: conservativeDailyLow.consolidatedCashCents,
    conservativeTroughDate: conservativeDailyLow.date,
    expectedTroughCents: expectedDailyLow.consolidatedCashCents,
    expectedTroughDate: expectedDailyLow.date,
    conservativeIntradaySafetyLowCents: bundle.conservative.consolidatedTroughCents,
    conservativeIntradaySafetyLowDate: bundle.conservative.consolidatedTroughDate,
    expectedIntradaySafetyLowCents: bundle.expected.consolidatedTroughCents,
    expectedIntradaySafetyLowDate: bundle.expected.consolidatedTroughDate,
    hardFloorMarginCents: bundle.conservative.hardFloorMarginCents,
    conservativeHardFloorMarginCents: bundle.conservative.hardFloorMarginCents,
    expectedHardFloorMarginCents: bundle.expected.hardFloorMarginCents,
    availableToDeployCents: bundle.availableToDeployCents,
    accountShortfallCount: new Set(
      bundle.conservative.accountShortfalls.map((shortfall) => shortfall.accountId),
    ).size,
    currentConsolidatedCashCents: currentPositionDay.day.consolidatedCashCents,
    currentAllCashCents: moneyCentsSchema.parse(
      currentPositionDay.day.accounts.reduce(
        (total, account) => total + account.endingBalanceCents,
        currentPositionDay.day.inTransitCents,
      ),
    ),
    currentReceivableCents: currentPositionDay.receivableCents,
    currentTotalPositionCents: currentPositionDay.positionCents,
    longRunMonthlyFreeCashFlowCents: longRunMonthlyFreeCashFlow?.monthlyNetCents,
    longRunMonthlyScheduledCardPaymentCents:
      longRunMonthlyFreeCashFlow?.monthlyScheduledCardPaymentCents,
    longRunMonthlyBeforeScheduledCardPaymentCents:
      longRunMonthlyFreeCashFlow?.monthlyBeforeScheduledCardPaymentsCents,
    longRunCashFlowWindowStart: longRunMonthlyFreeCashFlow?.windowStart,
    longRunCashFlowWindowEnd: longRunMonthlyFreeCashFlow?.windowEnd,
    conservativePositionLowCents: conservativePositionLow.positionCents,
    conservativePositionLowDate: conservativePositionLow.day.date,
    expectedPositionLowCents: expectedPositionLow.positionCents,
    expectedPositionLowDate: expectedPositionLow.day.date,
    preferredFloorMarginCents: bundle.conservative.preferredFloorMarginCents,
    conservativePreferredFloorMarginCents: bundle.conservative.preferredFloorMarginCents,
    expectedPreferredFloorMarginCents: bundle.expected.preferredFloorMarginCents,
    hardFloorCents: bundle.conservative.effectiveHardFloorCents,
    preferredFloorCents: bundle.conservative.effectivePreferredFloorCents,
    configuredHardFloorCents: data.policy.hardConsolidatedFloorCents,
    configuredPreferredFloorCents: data.policy.preferredConsolidatedFloorCents,
    accountHardFloorTotalCents: bundle.conservative.accountHardFloorTotalCents,
    accountPreferredFloorTotalCents: bundle.conservative.accountPreferredFloorTotalCents,
    cashAccounts: accounts.map((account) => {
      const sourceAccount = sourceAccountById.get(account.id) ?? account;
      const calculatedBalanceCents =
        currentPositionDay.day.accounts.find((item) => item.accountId === account.id)
          ?.endingBalanceCents ?? account.openingBalanceCents;
      return {
        id: account.id,
        name: account.name,
        balanceCents: calculatedBalanceCents,
        sourceBalanceCents: sourceAccount.openingBalanceCents,
        sourceBalanceDate: sourceAccount.balanceAsOf,
        calculatedThroughDate: startDate,
        postSourceChangeCents: calculatedBalanceCents - sourceAccount.openingBalanceCents,
        hardFloorCents: account.hardFloorCents ?? 0,
        preferredFloorCents: account.preferredFloorCents,
        showOnOverview: account.showOnOverview,
      };
    }),
    accountTroughs: accounts.flatMap((account) => {
      const conservative = accountDailyLow(
        bundle.conservative.days,
        account.id,
        account.balanceAsOf,
      );
      const expected = accountDailyLow(bundle.expected.days, account.id, account.balanceAsOf);
      if (!conservative || !expected) return [];
      return {
        accountId: account.id,
        accountName: account.name,
        balanceCents: conservative.accounts.find((item) => item.accountId === account.id)!
          .endingBalanceCents,
        date: conservative.date,
        expectedBalanceCents: expected.accounts.find((item) => item.accountId === account.id)!
          .endingBalanceCents,
        expectedDate: expected.date,
      };
    }),
    transferNeeds: bundle.conservative.transferNeeds.map((need, index) =>
      transferNeedWithReceivableCoverage(need, conservativeReceivableCoverage[index]!),
    ),
    expectedTransferNeeds: bundle.expected.transferNeeds.map((need, index) =>
      transferNeedWithReceivableCoverage(need, expectedReceivableCoverage[index]!),
    ),
    upcomingEvents: scheduledEvents
      .filter((event) => event.date >= startDate && event.status !== 'cancelled')
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(0, 30)
      .map((event) => ({
        id: event.id,
        label: event.label,
        accountName: accountNameById.get(event.accountId) ?? 'Unknown account',
        date: event.date,
        amountCents: event.amountCents,
        direction: event.direction,
        kind: event.kind,
        certainty: event.certainty,
      })),
    upcomingReceivables: scheduledEvents
      .filter(
        (event) =>
          event.kind === 'receivable-settlement' &&
          event.date >= startDate &&
          event.status !== 'cancelled',
      )
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(0, 8)
      .map((event) => ({
        id: event.id,
        label: event.label,
        date: event.date,
        amountCents: event.amountCents,
        certainty: event.certainty,
      })),
    cardSpendingPower: expectedCardSpendingPower.map((card) => ({
      ...card,
      fundingAccountName: accountNameById.get(card.fundingAccountId) ?? 'Unknown account',
      futurePositionLowAccountBalances: card.futurePositionLowAccountBalances.map((account) => ({
        ...account,
        accountName: accountNameById.get(account.accountId) ?? 'Unknown account',
      })),
      futureAccountLows: card.futureAccountLows.map((account) => ({
        ...account,
        accountName: accountNameById.get(account.accountId) ?? 'Unknown account',
      })),
      paymentDateAccountBalances: card.paymentDateAccountBalances?.map((account) => ({
        ...account,
        accountName: accountNameById.get(account.accountId) ?? 'Unknown account',
      })),
      rewardRateBasisPoints: rewardByCardId.get(card.cardId)?.baseRateBasisPoints,
      rewardType: rewardByCardId.get(card.cardId)?.rewardType,
    })),
    conservativeCardSpendingPower: conservativeCardSpendingPower.map((card) => ({
      ...card,
      fundingAccountName: accountNameById.get(card.fundingAccountId) ?? 'Unknown account',
      futurePositionLowAccountBalances: card.futurePositionLowAccountBalances.map((account) => ({
        ...account,
        accountName: accountNameById.get(account.accountId) ?? 'Unknown account',
      })),
      futureAccountLows: card.futureAccountLows.map((account) => ({
        ...account,
        accountName: accountNameById.get(account.accountId) ?? 'Unknown account',
      })),
      paymentDateAccountBalances: card.paymentDateAccountBalances?.map((account) => ({
        ...account,
        accountName: accountNameById.get(account.accountId) ?? 'Unknown account',
      })),
      rewardRateBasisPoints: rewardByCardId.get(card.cardId)?.baseRateBasisPoints,
      rewardType: rewardByCardId.get(card.cardId)?.rewardType,
    })),
    totalLoansCents,
    revolvingDebtByCard: revolvingDebt,
    totalRevolvingDebtCents,
    totalCarryingDebtCents,
    totalDebtCents,
    modeledDailyInterestCents,
    contractualNetWorthCents: netWorth.contractualNetWorthCents,
    economicNetWorthCents: netWorth.economicNetWorthCents,
    restrictedRefinanceSettlementCents,
    lastReconciliationDate:
      records.reconciliations
        .map((item) => item.date)
        .sort()
        .at(-1) ?? null,
    dependencies: bundle.expected.dependencies,
    dailyCash: bundle.conservative.days.map((day, index) => ({
      date: day.date,
      conservativeCashCents: day.consolidatedCashCents,
      expectedCashCents: bundle.expected.days[index]!.consolidatedCashCents,
      conservativeInTransitCents: day.inTransitCents,
      expectedInTransitCents: bundle.expected.days[index]!.inTransitCents,
      conservativeReceivableCents: conservativeReceivables[index]!.endingOutstandingCents,
      expectedReceivableCents: expectedReceivables[index]!.endingOutstandingCents,
      conservativePositionCents:
        day.consolidatedCashCents + conservativeReceivables[index]!.endingOutstandingCents,
      expectedPositionCents:
        bundle.expected.days[index]!.consolidatedCashCents +
        expectedReceivables[index]!.endingOutstandingCents,
      conservativeNetWorthCents: conservativeDailyNetWorth[index],
      expectedNetWorthCents: expectedDailyNetWorth[index],
      accountBalances: day.accounts.map((account) => ({
        accountId: account.accountId,
        accountName: accountNameById.get(account.accountId) ?? 'Unknown account',
        available: compareDates(day.date, accountBalanceAsOfById.get(account.accountId)!) >= 0,
        conservativeCashCents: account.endingBalanceCents,
        expectedCashCents: bundle.expected.days[index]!.accounts.find(
          (candidate) => candidate.accountId === account.accountId,
        )!.endingBalanceCents,
      })),
      events: [
        ...scheduledEvents
          .filter(
            (event) =>
              event.date === day.date && event.status !== 'cancelled' && event.status !== 'skipped',
          )
          .map((event) => ({
            id: event.id,
            sourceRecordId: event.sourceRecordId,
            label: event.label,
            accountName: accountNameById.get(event.accountId) ?? 'Unknown account',
            amountCents: event.amountCents,
            direction: event.direction,
            kind: event.kind,
            certainty: event.certainty,
            status: event.status,
            hypothetical: event.hypothetical,
            displayState: displayStateForForecastEvent(event),
            includedInExpected: !expectedExcludedEventIds.has(event.id),
            includedInConservative: !conservativeExcludedEventIds.has(event.id),
          })),
        ...buildReceivableAccrualDailyEvents({
          date: day.date,
          expectedAccruals: expectedReceivables[index]!.accruals,
          conservativeAccruals: conservativeReceivables[index]!.accruals,
          receivables: records.receivables,
        }),
      ],
    })),
  });
  if (!snapshot.success) {
    const issue = snapshot.error.issues[0];
    const location = issue?.path.length ? issue.path.join('.') : 'snapshot';
    throw new Error(`${issue?.message ?? 'Invalid forecast snapshot'} (${location})`);
  }
  return snapshot.data;
};

const managedRecordsFor = (userId: string) => ({
  ...store.getManagedRecords(userId),
  policy: store.getForecastData(userId)?.policy,
});

const registerIpc = (): void => {
  handle('profiles:list', emptyRequestSchema, z.array(profileSummarySchema), () =>
    store.listProfiles(),
  );
  handle('auth:create-password', createPasswordRequestSchema, sessionSchema, async (request) => {
    const profile = await auth.createPassword(
      request.profileId,
      request.password,
      request.displayName && request.username
        ? { displayName: request.displayName, username: request.username }
        : undefined,
    );
    activeUserId = profile.id;
    const nextSession = sessionFor(profile);
    updateService.setChannel(nextSession.preferences.updateChannel);
    updateService.start();
    return nextSession;
  });
  handle('auth:login', loginRequestSchema, sessionSchema, async (request) => {
    const profile = await auth.login(request.username, request.password);
    activeUserId = profile.id;
    const nextSession = sessionFor(profile);
    updateService.setChannel(nextSession.preferences.updateChannel);
    updateService.start();
    return nextSession;
  });
  handle('auth:logout', emptyRequestSchema, successSchema, () => {
    activeUserId = null;
    return { success: true as const };
  });
  handle('auth:session', emptyRequestSchema, sessionSchema.nullable(), () => {
    if (!activeUserId) return null;
    const profile = store.getCredentialsById(activeUserId);
    return profile ? sessionFor(profile) : null;
  });
  handle('forecast:get', forecastRequestSchema, forecastSnapshotSchema, (request) =>
    buildSnapshot(requireUser(), request.requiredEndDate),
  );
  handle(
    'setup:save-vertical-slice',
    verticalSliceInputSchema,
    forecastSnapshotSchema,
    (request) => {
      const userId = requireUser();
      store.saveVerticalSlice(userId, request);
      return buildSnapshot(userId);
    },
  );
  handle('setup:get-draft', emptyRequestSchema, onboardingDraftSchema, () =>
    store.getOnboardingDraft(requireUser()),
  );
  handle('setup:save-draft', saveOnboardingDraftRequestSchema, successSchema, (request) => {
    store.saveOnboardingDraft(requireUser(), request.values);
    return { success: true as const };
  });
  handle('scenario:evaluate', scenarioRequestSchema, scenarioResponseSchema, (request) => {
    const userId = requireUser();
    const initialContext = prepareForecast(userId, request.settlementDate);
    if (!initialContext) throw new Error('Complete setup before evaluating a scenario');
    if (compareDates(request.settlementDate, initialContext.startDate) < 0) {
      throw new Error('Purchase date cannot be before the current forecast date');
    }
    const { records } = initialContext;
    const card = request.cardId
      ? records.cards.find((item) => item.id === request.cardId)
      : undefined;
    if (request.fundingType === 'card' && !card) throw new Error('Selected card is unavailable');
    if (request.fundingType === 'card') {
      assertCashBackedCardPurchaseEligibility(card!, request.settlementDate);
    }
    const cardImpact = card
      ? calculateCardPurchaseCashImpact({
          card,
          cardCycles: records.cardCycles,
          cardActivities: initialContext.data.events,
          includeInterest:
            store.getCredentialsById(userId)?.preferences.experimentalCardInterestForecastEnabled ??
            false,
          purchaseDate: request.settlementDate,
          amountCents: request.amountCents,
        })
      : undefined;
    const cashSettlementDate = cardImpact?.paymentDate ?? request.settlementDate;
    const context = prepareForecast(userId, cashSettlementDate)!;
    const { data, accounts, scheduledEvents, startDate, endDate, replayStartDate } = context;
    const accountId =
      request.fundingType === 'card'
        ? card!.fundingAccountId
        : (request.accountId ?? accounts[0]!.id);
    const account = accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('Selected funding account is unavailable');
    const scenarioCashAmountCents = cardImpact?.incrementalCashPaymentCents ?? request.amountCents;
    const scenarioEvent = forecastEventSchema.parse({
      id: `scenario-${crypto.randomUUID()}`,
      userId,
      accountId,
      date: cashSettlementDate,
      kind: 'scenario',
      direction: 'outflow',
      amountCents: scenarioCashAmountCents,
      certainty: 'confirmed',
      status: 'planned',
      label: request.description,
      hypothetical: true,
    });
    const result = evaluateScenarios({
      accounts,
      baseEvents: scheduledEvents,
      scenarioEvents: [scenarioEvent],
      policy: data.policy,
      startDate,
      endDate,
    });
    const forecastMode = request.forecastMode;
    const scenarioReceivables = projectRollingReceivableBalances({
      receivables: records.receivables,
      settlementEvents: data.events,
      replayStartDate,
      startDate,
      endDate,
      mode: forecastMode,
      includeConfirmedReceivablesConservatively:
        data.policy.includeConfirmedReceivablesConservatively,
    });
    const beforeForecast = result.before[forecastMode];
    const afterForecast = result.after[forecastMode];
    const purchaseSafety = assessPurchaseSafety({
      forecast: afterForecast,
      cashLeavesOn: cashSettlementDate,
      fundingAccountId: account.id,
      fundingAccountFloorCents: account.hardFloorCents ?? 0,
      protectedTotalFloorCents: afterForecast.effectiveHardFloorCents,
      receivableDays: scenarioReceivables,
      fundingNeeds: afterForecast.transferNeeds,
      enforceFundingAccountFloor: request.fundingType === 'cash',
    });
    const followingStatement =
      card && cardImpact
        ? generateCardCyclesThroughHorizon({
            card,
            cardCycles: records.cardCycles.filter((cycle) => cycle.cardId === card.id),
            startDate,
            endDate,
          })
            .filter((cycle) => cycle.dueOn > cardImpact.owningCycle.dueOn)
            .sort((left, right) => left.dueOn.localeCompare(right.dueOn))[0]
        : undefined;
    const followingStatementPositionCents = followingStatement
      ? lowestTotalPositionFromDate(
          afterForecast.days.flatMap((day, index) => {
            const receivable = scenarioReceivables[index]?.endingOutstandingCents;
            return receivable === undefined
              ? []
              : [
                  {
                    date: day.date,
                    totalPositionCents: moneyCentsSchema.parse(
                      day.consolidatedCashCents + receivable,
                    ),
                  },
                ];
          }),
          followingStatement.dueOn,
        )
      : undefined;
    return {
      verdict: result.verdict,
      settlementDate: cashSettlementDate,
      beforeTroughCents: beforeForecast.consolidatedTroughCents,
      afterTroughCents: afterForecast.consolidatedTroughCents,
      afterHardFloorMarginCents: afterForecast.hardFloorMarginCents,
      afterAvailableToDeployCents: result.after.availableToDeployCents,
      resultingAvailableSpendCents: result.after.availableToDeployCents,
      accountShortfallCount: new Set(
        afterForecast.accountShortfalls.map((shortfall) => shortfall.accountId),
      ).size,
      transferNeeds: afterForecast.transferNeeds.map((need) => ({
        accountId: need.accountId,
        accountName:
          accounts.find((candidate) => candidate.id === need.accountId)?.name ?? 'Unknown account',
        sourceAccountId: need.suggestedSourceAccountId,
        sourceAccountName: need.suggestedSourceAccountId
          ? accounts.find((candidate) => candidate.id === need.suggestedSourceAccountId)?.name
          : undefined,
        date: need.date,
        shortfallCents: need.shortfallCents,
        horizonDeepestShortfallCents: need.horizonDeepestShortfallCents,
        horizonDeepestShortfallDate: need.horizonDeepestShortfallDate,
        horizonAdditionalShortfallCents: need.horizonAdditionalShortfallCents,
        initiationDate: need.initiationDate,
        arrivalDate: need.arrivalDate,
        sourceSurplusAfterFloorsCents: need.sourceSurplusAfterFloorsCents,
      })),
      fundingAccountName: account.name,
      cardName: card?.name,
      purchaseSafety,
      baselineCardPaymentCents: cardImpact?.baselineScheduledPaymentCents,
      afterPurchaseCardPaymentCents: cardImpact?.afterPurchaseScheduledPaymentCents,
      incrementalCashPaymentCents: cardImpact?.incrementalCashPaymentCents,
      owningStatementClosesOn: cardImpact?.owningCycle.closesOn,
      followingStatementDueOn: followingStatement?.dueOn,
      followingStatementPositionCents,
    };
  });
  handle(
    'scenario:evaluate-combined',
    combinedScenarioRequestSchema,
    scenarioResponseSchema,
    (request) => {
      const userId = requireUser();
      const data = store.getForecastData(userId);
      if (!data) throw new Error('Complete setup before evaluating scenarios');
      const requestedIds = new Set(request.scenarioIds);
      const scenarios = store
        .getManagedRecords(userId)
        .savedScenarios.filter(
          (scenario) => requestedIds.has(scenario.id) && scenario.status !== 'archived',
        );
      if (scenarios.length !== requestedIds.size) {
        throw new Error('One or more scenarios are unavailable for this profile');
      }
      const records = store.getManagedRecords(userId);
      const rollingCardActivities: ForecastEvent[] = [...data.events];
      const evaluatedScenarios = [...scenarios]
        .sort((left, right) => {
          const dateDifference = (left.purchaseDate ?? left.settlementDate).localeCompare(
            right.purchaseDate ?? right.settlementDate,
          );
          return dateDifference !== 0 ? dateDifference : left.id.localeCompare(right.id);
        })
        .map((scenario) => {
          if (scenario.fundingType !== 'card') {
            return {
              scenario,
              card: undefined,
              accountId: scenario.accountId,
              cashDate: scenario.settlementDate,
              incrementalCashPaymentCents: scenario.amountCents,
              impact: undefined,
            };
          }
          const card = records.cards.find((candidate) => candidate.id === scenario.cardId);
          if (!card || !scenario.purchaseDate) {
            throw new Error(`Card scenario ${scenario.description} is missing its card details`);
          }
          assertCashBackedCardPurchaseEligibility(card, scenario.purchaseDate);
          const impact = calculateCardPurchaseCashImpact({
            card,
            cardCycles: records.cardCycles,
            cardActivities: rollingCardActivities,
            includeInterest:
              store.getCredentialsById(userId)?.preferences
                .experimentalCardInterestForecastEnabled ?? false,
            purchaseDate: scenario.purchaseDate,
            amountCents: scenario.amountCents,
          });
          rollingCardActivities.push(
            forecastEventSchema.parse({
              id: `saved-card-scenario-${scenario.id}`,
              userId,
              accountId: card.fundingAccountId,
              date: scenario.purchaseDate,
              kind: 'scenario',
              direction: 'outflow',
              amountCents: scenario.amountCents,
              certainty: 'confirmed',
              status: 'planned',
              label: scenario.description,
              hypothetical: true,
              accepted: true,
              paymentMethod: 'credit-card',
              cardId: card.id,
              cardActivityTreatment: 'additional',
            }),
          );
          return {
            scenario,
            card,
            accountId: card.fundingAccountId,
            cashDate: impact.paymentDate,
            incrementalCashPaymentCents: impact.incrementalCashPaymentCents,
            impact,
          };
        });
      const latestScenarioDate = evaluatedScenarios
        .map((scenario) => scenario.cashDate)
        .sort()
        .at(-1)!;
      const context = prepareForecast(userId, latestScenarioDate)!;
      const { accounts, scheduledEvents, startDate, endDate } = context;
      const scenarioEvents = evaluatedScenarios.map((evaluated) =>
        forecastEventSchema.parse({
          id: `scenario-${evaluated.scenario.id}`,
          userId,
          accountId: evaluated.accountId,
          date: evaluated.cashDate,
          kind: 'scenario',
          direction: 'outflow',
          amountCents: evaluated.incrementalCashPaymentCents,
          certainty: 'confirmed',
          status: 'planned',
          label: evaluated.scenario.description,
          hypothetical: true,
        }),
      );
      const result = evaluateScenarios({
        accounts,
        baseEvents: scheduledEvents,
        scenarioEvents,
        policy: data.policy,
        startDate,
        endDate,
      });
      return {
        verdict: result.verdict,
        settlementDate: latestScenarioDate,
        beforeTroughCents: result.before.conservative.consolidatedTroughCents,
        afterTroughCents: result.after.conservative.consolidatedTroughCents,
        afterHardFloorMarginCents: result.after.conservative.hardFloorMarginCents,
        afterAvailableToDeployCents: result.after.availableToDeployCents,
        accountShortfallCount: new Set(
          result.after.conservative.accountShortfalls.map((shortfall) => shortfall.accountId),
        ).size,
        transferNeeds: result.after.conservative.transferNeeds.map((need) => ({
          accountId: need.accountId,
          accountName:
            accounts.find((candidate) => candidate.id === need.accountId)?.name ??
            'Unknown account',
          sourceAccountId: need.suggestedSourceAccountId,
          sourceAccountName: need.suggestedSourceAccountId
            ? accounts.find((candidate) => candidate.id === need.suggestedSourceAccountId)?.name
            : undefined,
          date: need.date,
          shortfallCents: need.shortfallCents,
          horizonDeepestShortfallCents: need.horizonDeepestShortfallCents,
          horizonDeepestShortfallDate: need.horizonDeepestShortfallDate,
          horizonAdditionalShortfallCents: need.horizonAdditionalShortfallCents,
          initiationDate: need.initiationDate,
          arrivalDate: need.arrivalDate,
          sourceSurplusAfterFloorsCents: need.sourceSurplusAfterFloorsCents,
        })),
        fundingAccountName:
          new Set(evaluatedScenarios.map((scenario) => scenario.accountId)).size === 1
            ? (accounts.find((account) => account.id === evaluatedScenarios[0]!.accountId)?.name ??
              'Unknown account')
            : 'Multiple accounts',
        cardName: (() => {
          const names = [
            ...new Set(
              evaluatedScenarios.flatMap((scenario) => (scenario.card ? [scenario.card.name] : [])),
            ),
          ];
          return names.length === 1 ? names[0] : names.length > 1 ? 'Multiple cards' : undefined;
        })(),
        incrementalCashPaymentCents: evaluatedScenarios.some((scenario) => scenario.card)
          ? evaluatedScenarios
              .filter((scenario) => scenario.card)
              .reduce((total, scenario) => total + scenario.incrementalCashPaymentCents, 0)
          : undefined,
      };
    },
  );
  handle('scenario:convert', scenarioActionRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.convertScenarioToCommitment(userId, request.scenarioId);
    return managedRecordsFor(userId);
  });
  handle(
    'receivable:settle',
    receivableSettlementRequestSchema,
    managedRecordsSchema,
    (request) => {
      const userId = requireUser();
      store.recordReceivableSettlement({ userId, ...request, asOfDate: currentFinancialDate() });
      return managedRecordsFor(userId);
    },
  );
  handle(
    'receivable:settle-unattributed',
    unattributedReceivableSettlementRequestSchema,
    managedRecordsSchema,
    (request) => {
      const userId = requireUser();
      store.recordUnattributedReceivableSettlement({
        userId,
        ...request,
        asOfDate: currentFinancialDate(),
      });
      return managedRecordsFor(userId);
    },
  );
  handle(
    'overview:record-expense',
    overviewExpenseRequestSchema,
    managedRecordsSchema,
    (request) => {
      const userId = requireUser();
      store.recordOverviewExpense({
        userId,
        ...request,
        asOfDate: currentFinancialDate(),
      });
      return managedRecordsFor(userId);
    },
  );
  handle('bills:upsert', billPlanRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.upsertBillPlan({ userId, ...request, asOfDate: currentFinancialDate() });
    return managedRecordsFor(userId);
  });
  handle('transfer:create', internalTransferRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.createInternalTransfer({ userId, ...request });
    return managedRecordsFor(userId);
  });
  handle('theme:set', setThemeRequestSchema, sessionSchema, (request) => {
    const userId = requireUser();
    store.setTheme(userId, request.theme);
    return sessionFor(store.getCredentialsById(userId)!);
  });
  handle('preferences:set', setPreferencesRequestSchema, sessionSchema, (request) => {
    const userId = requireUser();
    store.setPreferences(userId, request);
    updateService.setChannel(request.updateChannel);
    return sessionFor(store.getCredentialsById(userId)!);
  });
  handle(
    'shell:set-menu-bar-visibility',
    setMenuBarVisibilityRequestSchema,
    successSchema,
    (request) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.setMenuBarVisibility(request.visible);
      }
      return { success: true as const };
    },
  );
  handle('updates:status', emptyRequestSchema, updateStatusSchema, () => updateService.getStatus());
  handle('updates:check', emptyRequestSchema, updateStatusSchema, () => updateService.check());
  handle('updates:defer', emptyRequestSchema, updateStatusSchema, () => updateService.defer());
  handle('updates:restart', emptyRequestSchema, updateStatusSchema, () =>
    updateService.restartAndInstall(),
  );
  handle(
    'updates:post-update-notice',
    emptyRequestSchema,
    postUpdateNoticeSchema.nullable(),
    () => postUpdateNotice,
  );
  handle('updates:acknowledge-post-update', emptyRequestSchema, successSchema, async () => {
    postUpdateNotice = null;
    await fs.promises.rm(pendingUpdateMetadataPath(), { force: true });
    return { success: true as const };
  });
  handle(
    'notifications:list-presentation',
    emptyRequestSchema,
    z.array(notificationPresentationSchema),
    () => store.getNotificationPresentations(requireUser()),
  );
  handle('audit:list', emptyRequestSchema, z.array(auditHistoryEntrySchema), () =>
    store.getAuditHistory(requireUser()),
  );
  handle(
    'notifications:set-presentation',
    setNotificationPresentationsRequestSchema,
    z.array(notificationPresentationSchema),
    (request) => store.setNotificationPresentations(requireUser(), request.updates),
  );
  handle('policy:update', updateCashPolicyRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.updateCashFloorPolicy(userId, request);
    return managedRecordsFor(userId);
  });
  handle('refinance:commit', commitRefinancePlanRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.commitRefinancePlan(userId, request, currentFinancialDate());
    return managedRecordsFor(userId);
  });
  handle('refinance:cancel', cancelRefinancePlanRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.cancelCommittedRefinancePlan(userId, request.planId, currentFinancialDate());
    return managedRecordsFor(userId);
  });
  handle('records:list', emptyRequestSchema, managedRecordsSchema, () =>
    managedRecordsFor(requireUser()),
  );
  handle('records:upsert', upsertManagedEntityRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.upsertManagedEntity(userId, request.entityType, request.payload, {
      asOfDate: currentFinancialDate(),
    });
    return managedRecordsFor(userId);
  });
  handle('income-plan:upsert', upsertIncomePlanRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.upsertIncomePlan(userId, request.events, request.replacePlanId);
    return managedRecordsFor(userId);
  });
  handle('records:delete', deleteManagedEntityRequestSchema, managedRecordsSchema, (request) => {
    const userId = requireUser();
    store.deleteManagedEntity(userId, request.entityType, request.entityId);
    return managedRecordsFor(userId);
  });
  handle('data:backup', backupRequestSchema, fileActionResultSchema, async (request) => {
    const userId = requireUser();
    const options: SaveDialogOptions = {
      title: 'Create encrypted Balance Book backup',
      defaultPath: `balance-book-${new Date().toISOString().slice(0, 10)}.balancebook-backup`,
      filters: [{ name: 'Balance Book encrypted backup', extensions: ['balancebook-backup'] }],
    };
    const owner = BrowserWindow.getFocusedWindow();
    const selected = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (selected.canceled || !selected.filePath) return { canceled: true, itemCount: 0 };
    await writeEncryptedBackup(
      selected.filePath,
      store.exportPortableProfile(userId, app.getVersion()),
      request.password,
    );
    return { canceled: false, itemCount: 1 };
  });
  handle('data:restore', restoreRequestSchema, fileActionResultSchema, async (request) => {
    const userId = requireUser();
    const options: OpenDialogOptions = {
      title: 'Restore encrypted Balance Book backup',
      properties: ['openFile'],
      filters: [{ name: 'Balance Book encrypted backup', extensions: ['balancebook-backup'] }],
    };
    const owner = BrowserWindow.getFocusedWindow();
    const selected = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true, itemCount: 0 };
    const data = await readEncryptedBackup(selected.filePaths[0], request.password);
    const dataDirectory = process.env.BALANCE_BOOK_DATA_DIR ?? app.getPath('userData');
    const recoveryPath = path.join(
      dataDirectory,
      'restore-safety',
      `before-restore-${new Date().toISOString().replaceAll(':', '-')}.balancebook-backup`,
    );
    await writeEncryptedBackup(
      recoveryPath,
      store.exportPortableProfile(userId, app.getVersion()),
      request.password,
    );
    if (data.format === 'balance-book-portable-profile') {
      store.replacePortableProfile(userId, data);
    } else {
      store.replaceUserData(userId, data);
    }
    return { canceled: false, itemCount: 1 };
  });
  handle('data:export', emptyRequestSchema, fileActionResultSchema, async () => {
    const userId = requireUser();
    const options: OpenDialogOptions = {
      title: 'Export Balance Book data',
      properties: ['openDirectory', 'createDirectory'],
    };
    const owner = BrowserWindow.getFocusedWindow();
    const selected = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true, itemCount: 0 };
    const files = writeUserExports(selected.filePaths[0], store.exportUserData(userId));
    return { canceled: false, itemCount: files.length };
  });
  handle('data:import-json', jsonImportRequestSchema, fileActionResultSchema, async () => {
    const userId = requireUser();
    const options: OpenDialogOptions = {
      title: 'Import Balance Book JSON export',
      properties: ['openFile'],
      filters: [{ name: 'Balance Book JSON export', extensions: ['json'] }],
    };
    const owner = BrowserWindow.getFocusedWindow();
    const selected = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true, itemCount: 0 };
    const selectedPath = selected.filePaths[0];
    if (fs.statSync(selectedPath).size > 25 * 1024 * 1024)
      throw new Error('Import file is too large');
    const untrusted: unknown = JSON.parse(fs.readFileSync(selectedPath, 'utf8'));
    store.replaceUserData(userId, parseUserDataExport(untrusted));
    return { canceled: false, itemCount: 1 };
  });
  handle('data:reset-user', resetUserDataRequestSchema, successSchema, () => {
    store.resetUserData(requireUser());
    return { success: true as const };
  });
  handle('import:review', emptyRequestSchema, importReviewSchema, () =>
    store.getImportReview(requireUser()),
  );
};

const installProductionProtocol = (): void => {
  const rendererRoot = path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  protocol.handle('balance-book', async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.resolve(rendererRoot, `.${relativePath}`);
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response('Not found', { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    const extension = path.extname(filePath).toLowerCase();
    const utf8ContentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml; charset=utf-8',
    };
    if (utf8ContentTypes[extension]) headers.set('content-type', utf8ContentTypes[extension]);
    return new Response(response.body, { status: response.status, headers });
  });
};

const createWindow = async (): Promise<void> => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f3f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadURL('balance-book://app/index.html');
  }
};

const squirrelStartupHandled = handleSquirrelStartupEvent({
  platform: process.platform,
  arguments_: process.argv,
  executablePath: process.execPath,
  quit: () => app.quit(),
});

if (!squirrelStartupHandled) {
  const enforceSingleInstance = !process.env.BALANCE_BOOK_DATA_DIR;
  const ownsSingleInstance = !enforceSingleInstance || app.requestSingleInstanceLock();
  if (!ownsSingleInstance) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const existingWindow = BrowserWindow.getAllWindows()[0];
      if (!existingWindow) return;
      if (existingWindow.isMinimized()) existingWindow.restore();
      existingWindow.show();
      existingWindow.focus();
    });

    app
      .whenReady()
      .then(async () => {
        const dataDirectory = process.env.BALANCE_BOOK_DATA_DIR ?? app.getPath('userData');
        store = new BalanceBookStore({
          databasePath: path.join(dataDirectory, 'balance-book.sqlite'),
          backupDirectory: path.join(dataDirectory, 'migration-backups'),
        });
        store.initializeProfiles(loadInitialProfiles());
        auth = new LocalAuthService(store);
        postUpdateNotice = loadPostUpdateNotice();
        updateService = new BalanceBookUpdateService(autoUpdater, {
          enabled:
            __BALANCE_BOOK_UPDATES_ENABLED__ &&
            app.isPackaged &&
            process.platform === 'win32' &&
            !process.env.BALANCE_BOOK_DATA_DIR,
          currentVersion: app.getVersion(),
          initialChannel: 'beta',
          firstRun: process.argv.includes('--squirrel-firstrun'),
          onStatus: broadcastUpdateStatus,
          prepareInstall: prepareUpdateInstall,
        });
        registerIpc();
        installProductionProtocol();
        session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
          callback(false),
        );
        await createWindow();
        app.on('activate', async () => {
          if (BrowserWindow.getAllWindows().length === 0) await createWindow();
        });
      })
      .catch((error: unknown) => {
        dialog.showErrorBox('Balance Book could not start', safeError(error));
        app.quit();
      });
  }

  app.on('will-quit', () => {
    updateService?.dispose();
    if (store?.raw.open) store.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
