import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import rootPackage from '../../../package.json';
import {
  createPasswordRequestSchema,
  auditHistoryEntrySchema,
  backupRequestSchema,
  billPlanRequestSchema,
  combinedScenarioRequestSchema,
  commitRefinancePlanRequestSchema,
  cancelRefinancePlanRequestSchema,
  deleteManagedEntityRequestSchema,
  emptyRequestSchema,
  forecastRequestSchema,
  forecastSnapshotSchema,
  fileActionResultSchema,
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
  sessionSchema,
  setMenuBarVisibilityRequestSchema,
  setPreferencesRequestSchema,
  setNotificationPresentationsRequestSchema,
  setThemeRequestSchema,
  restoreRequestSchema,
  resetUserDataRequestSchema,
  successSchema,
  updateStatusSchema,
  verticalSliceInputSchema,
  upsertManagedEntityRequestSchema,
  upsertIncomePlanRequestSchema,
  updateCashPolicyRequestSchema,
  type BalanceBookApi,
} from './shared/contracts';
import { installFormDirtyTracker } from './form-dirty-tracker';

const invoke = async <T>(
  channel: string,
  requestSchema: z.ZodType,
  responseSchema: z.ZodType<T>,
  input: unknown,
) => {
  const request = requestSchema.parse(input);
  const response: unknown = await ipcRenderer.invoke(channel, request);
  return resultSchema(responseSchema).parse(response);
};

const api: BalanceBookApi = {
  appVersion: rootPackage.version,
  platform: process.platform,
  listProfiles: () =>
    invoke('profiles:list', emptyRequestSchema, z.array(profileSummarySchema), {}),
  createPassword: (input) =>
    invoke('auth:create-password', createPasswordRequestSchema, sessionSchema, input),
  login: (input) => invoke('auth:login', loginRequestSchema, sessionSchema, input),
  logout: () => invoke('auth:logout', emptyRequestSchema, successSchema, {}),
  getSession: () => invoke('auth:session', emptyRequestSchema, sessionSchema.nullable(), {}),
  getForecast: (input = {}) =>
    invoke('forecast:get', forecastRequestSchema, forecastSnapshotSchema, input),
  saveVerticalSlice: (input) =>
    invoke('setup:save-vertical-slice', verticalSliceInputSchema, forecastSnapshotSchema, input),
  getOnboardingDraft: () =>
    invoke('setup:get-draft', emptyRequestSchema, onboardingDraftSchema, {}),
  saveOnboardingDraft: (input) =>
    invoke('setup:save-draft', saveOnboardingDraftRequestSchema, successSchema, input),
  evaluateScenario: (input) =>
    invoke('scenario:evaluate', scenarioRequestSchema, scenarioResponseSchema, input),
  evaluateCombinedScenarios: (input) =>
    invoke(
      'scenario:evaluate-combined',
      combinedScenarioRequestSchema,
      scenarioResponseSchema,
      input,
    ),
  convertScenario: (input) =>
    invoke('scenario:convert', scenarioActionRequestSchema, managedRecordsSchema, input),
  recordReceivableSettlement: (input) =>
    invoke('receivable:settle', receivableSettlementRequestSchema, managedRecordsSchema, input),
  recordUnattributedReceivableSettlement: (input) =>
    invoke(
      'receivable:settle-unattributed',
      unattributedReceivableSettlementRequestSchema,
      managedRecordsSchema,
      input,
    ),
  recordOverviewExpense: (input) =>
    invoke('overview:record-expense', overviewExpenseRequestSchema, managedRecordsSchema, input),
  upsertBillPlan: (input) =>
    invoke('bills:upsert', billPlanRequestSchema, managedRecordsSchema, input),
  createInternalTransfer: (input) =>
    invoke('transfer:create', internalTransferRequestSchema, managedRecordsSchema, input),
  commitRefinancePlan: (input) =>
    invoke('refinance:commit', commitRefinancePlanRequestSchema, managedRecordsSchema, input),
  cancelRefinancePlan: (input) =>
    invoke('refinance:cancel', cancelRefinancePlanRequestSchema, managedRecordsSchema, input),
  setTheme: (input) => invoke('theme:set', setThemeRequestSchema, sessionSchema, input),
  setPreferences: (input) =>
    invoke('preferences:set', setPreferencesRequestSchema, sessionSchema, input),
  setMenuBarVisibility: (input) =>
    invoke(
      'shell:set-menu-bar-visibility',
      setMenuBarVisibilityRequestSchema,
      successSchema,
      input,
    ),
  listNotificationPresentations: () =>
    invoke(
      'notifications:list-presentation',
      emptyRequestSchema,
      z.array(notificationPresentationSchema),
      {},
    ),
  listAuditHistory: () =>
    invoke('audit:list', emptyRequestSchema, z.array(auditHistoryEntrySchema), {}),
  setNotificationPresentations: (input) =>
    invoke(
      'notifications:set-presentation',
      setNotificationPresentationsRequestSchema,
      z.array(notificationPresentationSchema),
      input,
    ),
  updateCashPolicy: (input) =>
    invoke('policy:update', updateCashPolicyRequestSchema, managedRecordsSchema, input),
  listRecords: () => invoke('records:list', emptyRequestSchema, managedRecordsSchema, {}),
  upsertRecord: (input) =>
    invoke('records:upsert', upsertManagedEntityRequestSchema, managedRecordsSchema, input),
  upsertIncomePlan: (input) =>
    invoke('income-plan:upsert', upsertIncomePlanRequestSchema, managedRecordsSchema, input),
  deleteRecord: (input) =>
    invoke('records:delete', deleteManagedEntityRequestSchema, managedRecordsSchema, input),
  createBackup: (input) =>
    invoke('data:backup', backupRequestSchema, fileActionResultSchema, input),
  restoreBackup: (input) =>
    invoke('data:restore', restoreRequestSchema, fileActionResultSchema, input),
  exportData: () => invoke('data:export', emptyRequestSchema, fileActionResultSchema, {}),
  importJson: (input) =>
    invoke('data:import-json', jsonImportRequestSchema, fileActionResultSchema, input),
  resetUserData: (input) =>
    invoke('data:reset-user', resetUserDataRequestSchema, successSchema, input),
  getImportReview: () => invoke('import:review', emptyRequestSchema, importReviewSchema, {}),
  getUpdateStatus: () => invoke('updates:status', emptyRequestSchema, updateStatusSchema, {}),
  checkForUpdates: () => invoke('updates:check', emptyRequestSchema, updateStatusSchema, {}),
  deferUpdate: () => invoke('updates:defer', emptyRequestSchema, updateStatusSchema, {}),
  restartForUpdate: () => invoke('updates:restart', emptyRequestSchema, updateStatusSchema, {}),
  onUpdateStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const parsed = updateStatusSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on('updates:status-changed', handler);
    return () => ipcRenderer.removeListener('updates:status-changed', handler);
  },
  getPostUpdateNotice: () =>
    invoke('updates:post-update-notice', emptyRequestSchema, postUpdateNoticeSchema.nullable(), {}),
  acknowledgePostUpdateNotice: () =>
    invoke('updates:acknowledge-post-update', emptyRequestSchema, successSchema, {}),
};

const formDirtyTracker = installFormDirtyTracker(document, window);

ipcRenderer.on('updates:prepare-restart', (_event, raw: unknown) => {
  const request =
    typeof raw === 'object' && raw !== null ? (raw as { requestId?: unknown }) : undefined;
  if (typeof request?.requestId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(request.requestId)) {
    return;
  }
  ipcRenderer.send(`updates:restart-readiness:${request.requestId}`, {
    canRestart: !formDirtyTracker.hasUnsavedChanges(),
  });
});

contextBridge.exposeInMainWorld('balanceBook', api);
