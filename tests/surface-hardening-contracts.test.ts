import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const corePagesSource = readFileSync(
  new URL('../apps/desktop/src/renderer/CorePages.tsx', import.meta.url),
  'utf8',
);
const appSource = readFileSync(
  new URL('../apps/desktop/src/renderer/App.tsx', import.meta.url),
  'utf8',
);

const pageSource = (source: string, name: string, nextName: string): string => {
  const start = source.indexOf(`export const ${name} =`);
  const end = source.indexOf(`export const ${nextName} =`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not isolate ${name}`);
  return source.slice(start, end);
};

const localHandlerSource = (source: string, name: string): string => {
  const start = source.indexOf(`const ${name} = async`);
  const end = source.indexOf('\n  };', start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not isolate ${name}`);
  return source.slice(start, end + 5);
};

const localFunctionSource = (source: string, name: string): string => {
  const start = source.indexOf(`const ${name} =`);
  const end = source.indexOf('\n  };', start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not isolate ${name}`);
  return source.slice(start, end + 5);
};

const expectProtectedMutation = (
  source: string,
  handlerName: string,
  beginGuard: string,
  finishCall: string,
): string => {
  const handler = localHandlerSource(source, handlerName);
  expect(handler).toContain(beginGuard);
  expect(handler).toContain('try {');
  expect(handler).toContain('catch (caught');
  expect(handler).toContain('finally {');
  expect(handler).toContain(finishCall);
  expect(handler.indexOf(beginGuard)).toBeLessThan(handler.indexOf('try {'));
  expect(handler.indexOf(finishCall)).toBeGreaterThan(handler.indexOf('finally {'));
  return handler;
};

describe('All Financial Records editor hardening', () => {
  const source = pageSource(corePagesSource, 'RecordsPage', 'IncomePage');

  it('re-reveals either guided or advanced editing and keeps only one editor active', () => {
    expect(source).toContain('const [editorRevealRequest, setEditorRevealRequest] = useState(0);');
    expect(source).toContain(
      'const activeEditorRef = useEditorReveal<HTMLDivElement>(activeEditorKey, editorRevealRequest);',
    );

    const advanced = localFunctionSource(source, 'startEditing');
    expect(advanced).toContain('if (mutationLock.active() !== null) return;');
    expect(advanced).toContain('setGuidedEditing(null);');
    expect(advanced).toContain('setEditing(request);');
    expect(advanced).toContain('setEditorRevealRequest((requestNumber) => requestNumber + 1);');

    const guided = localFunctionSource(source, 'startGuidedEditing');
    expect(guided).toContain('if (mutationLock.active() !== null) return;');
    expect(guided).toContain('setEditing(null);');
    expect(guided).toContain('setGuidedEditing({ entityType, entityId });');
    expect(guided).toContain('setEditorRevealRequest((requestNumber) => requestNumber + 1);');

    expect(source).toContain('ref={activeEditorRef}');
    expect(source).toContain('className={`${styles.panel} balance-editor-reveal`}');
    expect(source).toContain('tabIndex={-1}');
  });

  it('serializes create, edit, and delete mutations and refreshes persisted records', () => {
    for (const handlerName of ['submit', 'remove', 'saveGuidedEdit', 'saveEdit']) {
      const handler = expectProtectedMutation(
        source,
        handlerName,
        'if (!beginRecordMutation(action)) return;',
        'finishRecordMutation(action);',
      );
      expect(handler).toMatch(/setRecords\((result|response)\.value\);/);
    }
    expect(source).toContain('if (!mutationLock.acquire(action)) return false;');
    expect(source).toContain('mutationLock.release(action);');
    expect(source).toContain('disabled={pendingAction !== null}');
  });

  it('keeps success and failure feedback with the active editor', () => {
    expect(source).toContain('<GuidedEditorFeedback message={message} error={error} />');
    expect(source).toContain('message={message}');
    expect(source).toContain('error={error}');
    expect(source).toContain("aria-busy={pendingAction === 'save-advanced-record'}");
    expect(source).toContain("busy={pendingAction === 'save-guided-record'}");
  });
});

describe('Income editor hardening', () => {
  const source = pageSource(corePagesSource, 'IncomePage', 'BaselinePage');

  it('reveals plan and individual-event editors from every edit entry point', () => {
    expect(source).toContain(
      'const [incomePlanRevealRequest, setIncomePlanRevealRequest] = useState(0);',
    );
    expect(source).toContain(
      'const [incomeEventRevealRequest, setIncomeEventRevealRequest] = useState(0);',
    );
    expect(source).toContain('const incomePlanEditorRef = useEditorReveal<HTMLDivElement>(');
    expect(source).toContain('const incomeEventEditorRef = useEditorReveal<HTMLDivElement>(');

    for (const functionName of ['editIncomePlan', 'scheduleIncomePhase']) {
      const edit = localFunctionSource(source, functionName);
      expect(edit).toContain('if (mutationLock.active() !== null) return;');
      expect(edit).toContain('setIncomePlanRevealRequest((request) => request + 1);');
    }
    const eventEdit = localFunctionSource(source, 'toggleIncomeEventEdit');
    expect(eventEdit).toContain('if (mutationLock.active() !== null) return;');
    expect(eventEdit).toContain('setIncomeEventRevealRequest((request) => request + 1);');
    expect(eventEdit).not.toContain('setEditingIncomeId(null);');
    expect(source).toContain('ref={incomePlanEditorRef}');
    expect(source).toContain('ref={incomeEventEditorRef}');
  });

  it('locks every persistence path, refreshes the shared record set, and exposes busy state', () => {
    for (const handlerName of ['deleteIncomePlan', 'addIncome', 'addRaise', 'saveIncomeEdit']) {
      const handler = expectProtectedMutation(
        source,
        handlerName,
        'if (!beginIncomeMutation(action)) return;',
        'finishIncomeMutation(action);',
      );
      expect(handler).toMatch(/setRecords\((response\.value|updatedRecords)\);/);
    }
    expect(source).toContain('if (!mutationLock.acquire(action)) return false;');
    expect(source).toContain('disabled={pendingAction !== null}');
    expect(source).toContain("aria-busy={pendingAction === 'save-income'}");
    expect(source).toContain('busy={pendingAction === `save-income-event:${income.id}`}');
  });

  it('closes a saved event editor only after replacing records with the persisted response', () => {
    const handler = localHandlerSource(source, 'saveIncomeEdit');
    expect(handler.indexOf('setRecords(response.value);')).toBeLessThan(
      handler.indexOf('setEditingIncomeId(null);'),
    );
    expect(handler).toContain(
      "setMessage('Income changes saved and recalculated through the cash forecast.');",
    );
  });
});

describe('Baseline cash-event editor hardening', () => {
  const source = pageSource(corePagesSource, 'BaselinePage', 'CardsPage');

  it('increments the reveal request even when the same event is selected again', () => {
    expect(source).toContain('const [editorRevealRequest, setEditorRevealRequest] = useState(0);');
    expect(source).toContain(
      'const eventEditorRef = useEditorReveal<HTMLDivElement>(editingEventId, editorRevealRequest);',
    );
    expect(source).toContain('setEditingEventId(event.id);');
    expect(source).toContain('setEditorRevealRequest((request) => request + 1);');
    expect(source).toContain('ref={eventEditorRef}');
    expect(source).toContain('tabIndex={-1}');
  });

  it('protects transfer creation and event saving with one lock and local edit feedback', () => {
    for (const handlerName of ['createTransfer', 'saveEvent']) {
      const handler = expectProtectedMutation(
        source,
        handlerName,
        'if (!beginBaselineMutation(action)) return;',
        'finishBaselineMutation(action);',
      );
      expect(handler).toContain('setRecords(response.value);');
    }
    expect(source).toContain('if (!mutationLock.acquire(action)) return false;');
    expect(source).toContain('disabled={pendingAction !== null}');
    expect(source).toContain('busy={pendingAction === `save-event:${event.id}`}');
    expect(source).toContain('message={message}');
    expect(source).toContain('error={error}');
  });
});

describe('Loan editor hardening', () => {
  const source = pageSource(corePagesSource, 'LoansPage', 'ReceivablesPage');

  it('re-reveals the same loan editor and blocks editor replacement while saving', () => {
    expect(source).toContain('const [editorRevealRequest, setEditorRevealRequest] = useState(0);');
    expect(source).toContain(
      'const loanEditorRef = useEditorReveal<HTMLDivElement>(editingLoanId, editorRevealRequest);',
    );
    const startEdit = localFunctionSource(source, 'startLoanEdit');
    expect(startEdit).toContain('if (mutationLock.active() !== null) return;');
    expect(startEdit).toContain('setEditingLoanId(loanId);');
    expect(startEdit).toContain('setEditorRevealRequest((request) => request + 1);');
    expect(source).toContain('ref={loanEditorRef}');
    expect(source).toContain('aria-labelledby="loan-editor-title"');
  });

  it('locks loan saves immediately and keeps errors, progress, and controls in the editor', () => {
    const handler = expectProtectedMutation(
      source,
      'saveLoan',
      'if (!mutationLock.acquire(action)) return;',
      'mutationLock.release(action);',
    );
    expect(handler).toContain('setPendingAction(action);');
    expect(handler).toContain('setRecords(response.value);');
    expect(handler.indexOf('setRecords(response.value);')).toBeLessThan(
      handler.indexOf('setEditingLoanId(null);'),
    );
    expect(source).toContain("aria-busy={pendingAction === 'save-loan'}");
    expect(source).toContain('{error && <GuidedEditorFeedback message={null} error={error} />}');
    expect(source).toContain('disabled={pendingAction !== null}');
  });
});

describe('Money Owed editor hardening', () => {
  const source = pageSource(corePagesSource, 'ReceivablesPage', 'NetWorthPage');

  it('re-reveals an editor and refuses a competing edit during save or release', () => {
    expect(source).toContain('const receivableActionRef = useRef');
    expect(source).toContain('const [editorRevealRequest, setEditorRevealRequest] = useState(0);');
    expect(source).toContain('const receivableEditorRef = useEditorReveal<HTMLDivElement>(');
    const beginEdit = localFunctionSource(source, 'beginReceivableEdit');
    expect(beginEdit).toContain('if (receivableActionRef.current) return;');
    expect(beginEdit).toContain('setEditingReceivableId(receivableId);');
    expect(beginEdit).toContain('setEditorRevealRequest((request) => request + 1);');
    expect(source).toContain('ref={receivableEditorRef}');
  });

  it('uses a synchronous shared action guard for saving and releasing, always clearing it', () => {
    const save = localHandlerSource(source, 'saveReceivable');
    const settle = localHandlerSource(source, 'settle');
    for (const [handler, action] of [
      [save, 'save'],
      [settle, 'settle'],
    ] as const) {
      expect(handler).toContain('if (receivableActionRef.current) return;');
      expect(handler).toContain(`receivableActionRef.current = '${action}';`);
      expect(handler).toContain('try {');
      expect(handler).toContain('catch (caught)');
      expect(handler).toContain('finally {');
      expect(handler).toContain('receivableActionRef.current = null;');
      expect(handler).toContain('setReceivableAction(null);');
      expect(handler).toContain('setRecords(response.value);');
    }
    expect(source).toContain('disabled={receivableAction !== null}');
    expect(source).toContain("aria-busy={receivableAction === 'save'}");
    expect(source).toContain("aria-busy={receivableAction === 'settle'}");
  });

  it('keeps save and settlement failures on the surface that caused them', () => {
    expect(source).toContain("setErrorContext('editor');");
    expect(source).toContain("setErrorContext('settlement');");
    expect(source).toContain("errorContext === 'editor'");
    expect(source).toContain("errorContext === 'settlement'");
  });
});

describe('Net worth asset editor hardening', () => {
  const source = pageSource(corePagesSource, 'NetWorthPage', 'ReconciliationPage');

  it('re-reveals the same asset editor and prevents edit replacement during mutation', () => {
    expect(source).toContain('const [editorRevealRequest, setEditorRevealRequest] = useState(0);');
    expect(source).toContain(
      'const assetEditorRef = useEditorReveal<HTMLDivElement>(editingAssetId, editorRevealRequest);',
    );
    const startEdit = localFunctionSource(source, 'startAssetEdit');
    expect(startEdit).toContain('if (mutationLock.active() !== null) return;');
    expect(startEdit).toContain('setEditingAssetId(assetId);');
    expect(startEdit).toContain('setEditorRevealRequest((request) => request + 1);');
    expect(source).toContain('ref={assetEditorRef}');
    expect(source).toContain('aria-labelledby="asset-editor-title"');
  });

  it('serializes save and delete, refreshes persisted rows, and exposes editor-local state', () => {
    for (const handlerName of ['saveAsset', 'removeAsset']) {
      const handler = expectProtectedMutation(
        source,
        handlerName,
        'if (!mutationLock.acquire(action)) return;',
        'mutationLock.release(action);',
      );
      expect(handler).toContain('setRecords(response.value);');
    }
    expect(source).toContain("aria-busy={pendingAction === 'save-asset'}");
    expect(source).toContain('{error && <GuidedEditorFeedback message={null} error={error} />}');
    expect(source).toContain('disabled={pendingAction !== null}');
  });
});

describe('Purchase scenario control hardening', () => {
  const start = appSource.indexOf('const ScenarioPage =');
  const end = appSource.indexOf('\nconst AppRoutes =', start);
  const source = appSource.slice(start, end);

  it('guards every saved-scenario mutation and writes returned records back to the page', () => {
    for (const handlerName of [
      'saveScenario',
      'saveScenarioRecord',
      'duplicateScenario',
      'convertScenario',
      'deleteScenario',
    ]) {
      const handler = expectProtectedMutation(
        source,
        handlerName,
        'if (!beginScenarioAction(action)) return;',
        'finishScenarioAction(action);',
      );
      expect(handler).toContain('setRecords(response.value);');
    }
    const combined = expectProtectedMutation(
      source,
      'evaluateSavedScenarios',
      'if (!beginScenarioAction(action)) return;',
      'finishScenarioAction(action);',
    );
    expect(combined).toContain('setResult(response.value);');
    expect(source).toContain('if (!scenarioActionLock.acquire(action)) return false;');
    expect(source).toContain('disabled={scenarioControlsBusy}');
  });

  it('cannot save stale or duplicate evaluation output and exposes save progress', () => {
    const save = localHandlerSource(source, 'saveScenario');
    expect(save).toContain('evaluatedInputKey !== currentEvaluationKey');
    expect(save).toContain('savedEvaluationKey === evaluatedInputKey');
    expect(save).toContain('setSavedEvaluationKey(evaluationKeySnapshot);');
    expect(source).toContain('disabled={!canSaveEvaluatedScenario || scenarioControlsBusy}');
    expect(source).toContain("scenarioAction === 'save-evaluated-scenario'");
    expect(source).toContain("? 'Saving scenario...'\n");
  });
});
