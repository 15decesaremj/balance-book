import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scenarioEvaluationKey, setupDraftPayloadValues } from '../apps/desktop/src/renderer/App';

const appSource = readFileSync(
  new URL('../apps/desktop/src/renderer/App.tsx', import.meta.url),
  'utf8',
);

describe('setup draft exit guard', () => {
  it('builds an immediate draft snapshot from the latest form and review values', () => {
    const values = {
      balanceAsOf: '2026-07-16',
      accountName: 'Everyday checking',
      openingBalance: '1234.56',
    };
    const reviews = {
      cards: 'reviewed' as const,
      rewards: 'not-applicable' as const,
    };

    const snapshot = setupDraftPayloadValues(values, reviews);
    values.accountName = 'Changed after snapshot';

    expect(snapshot).toEqual({
      balanceAsOf: '2026-07-16',
      accountName: 'Everyday checking',
      openingBalance: '1234.56',
      review_cards: 'reviewed',
      review_rewards: 'not-applicable',
    });
  });

  it('cancels the debounce, awaits the newest queued save, and only then navigates', () => {
    const start = appSource.indexOf('const exitSetup = async');
    const end = appSource.indexOf('\n  const submit =', start);
    const exitSetupSource = appSource.slice(start, end);

    expect(exitSetupSource).toContain('if (exitSetupLockRef.current) return');
    expect(exitSetupSource).toContain('clearTimeout(draftTimerRef.current)');
    expect(exitSetupSource).toContain('setupDraftPayloadValues(form.getValues(), reviewSections)');
    expect(exitSetupSource).toContain('await persistSetupDraft');
    expect(exitSetupSource).toContain("if (savedLatestDraft) navigate('/')");
    expect(exitSetupSource).toContain('finally');
    expect(exitSetupSource.indexOf('await persistSetupDraft')).toBeLessThan(
      exitSetupSource.indexOf("navigate('/')"),
    );
  });
});

describe('scenario evaluation lifecycle guard', () => {
  const values = {
    description: 'New laptop',
    amount: '1,250.00',
    settlementDate: '2026-08-15',
  };
  const cash = { fundingType: 'cash' as const, accountId: 'checking', cardId: 'card-a' };

  it('invalidates on every evaluated value and the active funding choice', () => {
    const original = scenarioEvaluationKey(values, cash);
    const changedKeys = [
      scenarioEvaluationKey({ ...values, description: 'New desktop' }, cash),
      scenarioEvaluationKey({ ...values, amount: '1,300.00' }, cash),
      scenarioEvaluationKey({ ...values, settlementDate: '2026-08-16' }, cash),
      scenarioEvaluationKey(values, { ...cash, accountId: 'savings' }),
      scenarioEvaluationKey(values, { ...cash, fundingType: 'card' }),
      scenarioEvaluationKey(values, {
        fundingType: 'card',
        accountId: 'checking',
        cardId: 'card-b',
      }),
    ];

    expect(changedKeys.every((key) => key !== original)).toBe(true);
  });

  it('ignores inactive selector state and harmless outer whitespace', () => {
    expect(scenarioEvaluationKey(values, cash)).toBe(
      scenarioEvaluationKey(
        { ...values, description: '  New laptop  ', amount: ' 1,250.00 ' },
        { ...cash, cardId: 'inactive-card' },
      ),
    );
    const card = { fundingType: 'card' as const, accountId: 'checking', cardId: 'card-a' };
    expect(scenarioEvaluationKey(values, card)).toBe(
      scenarioEvaluationKey(values, { ...card, accountId: 'inactive-account' }),
    );
  });

  it('uses immediate and completed-save locks with cleanup in a finally block', () => {
    const start = appSource.indexOf('const saveScenario = async');
    const end = appSource.indexOf('\n  type SavedScenario', start);
    const saveSource = appSource.slice(start, end);

    expect(saveSource).toContain('saveScenarioLockRef.current === evaluatedInputKey');
    expect(saveSource).toContain('evaluatedInputKey !== currentEvaluationKey');
    expect(saveSource).toContain('savedEvaluationKey === evaluatedInputKey');
    expect(saveSource).toContain('saveScenarioLockRef.current = evaluationKeySnapshot');
    expect(saveSource).toContain('savedSuccessfully = true');
    expect(saveSource).toContain('finally');
    expect(saveSource).toContain('saveScenarioLockRef.current = null');
    expect(appSource).toContain('onChange={invalidateScenarioEvaluation}');
    expect(appSource).toContain("? 'Saving scenario...'\n");
    expect(appSource).toContain("? 'Scenario saved'\n");
  });
});
