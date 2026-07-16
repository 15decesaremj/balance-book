import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import rootPackage from '../../../package.json';
import {
  createPasswordRequestSchema,
  backupRequestSchema,
  combinedScenarioRequestSchema,
  commitRefinancePlanRequestSchema,
  cancelRefinancePlanRequestSchema,
  deleteManagedEntityRequestSchema,
  emptyRequestSchema,
  forecastSnapshotSchema,
  fileActionResultSchema,
  importReviewSchema,
  internalTransferRequestSchema,
  jsonImportRequestSchema,
  loginRequestSchema,
  managedRecordsSchema,
  onboardingDraftSchema,
  profileSummarySchema,
  receivableSettlementRequestSchema,
  resultSchema,
  scenarioRequestSchema,
  scenarioResponseSchema,
  saveOnboardingDraftRequestSchema,
  scenarioActionRequestSchema,
  sessionSchema,
  setThemeRequestSchema,
  restoreRequestSchema,
  resetUserDataRequestSchema,
  successSchema,
  verticalSliceInputSchema,
  upsertManagedEntityRequestSchema,
  upsertIncomePlanRequestSchema,
  updateCashPolicyRequestSchema,
  type BalanceBookApi,
} from './shared/contracts';

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
  getForecast: () => invoke('forecast:get', emptyRequestSchema, forecastSnapshotSchema, {}),
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
  createInternalTransfer: (input) =>
    invoke('transfer:create', internalTransferRequestSchema, managedRecordsSchema, input),
  commitRefinancePlan: (input) =>
    invoke('refinance:commit', commitRefinancePlanRequestSchema, managedRecordsSchema, input),
  cancelRefinancePlan: (input) =>
    invoke('refinance:cancel', cancelRefinancePlanRequestSchema, managedRecordsSchema, input),
  setTheme: (input) => invoke('theme:set', setThemeRequestSchema, sessionSchema, input),
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
};

contextBridge.exposeInMainWorld('balanceBook', api);
