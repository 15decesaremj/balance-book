import { describe, expect, it } from 'vitest';
import { defaultProfilePreferences } from '@balance-book/domain';
import {
  featureSettingsPath,
  financialFeaturePreferenceKeys,
  isFinancialFeatureVisible,
} from '../apps/desktop/src/renderer/feature-visibility';
import {
  activeSetupStepIds,
  secondaryDestinationsFor,
  settingsSectionForLocation,
} from '../apps/desktop/src/renderer/App';
import { searchSettings } from '../apps/desktop/src/renderer/settings-search';

describe('onboarding-driven feature visibility', () => {
  it('keeps every existing-profile feature visible by default', () => {
    for (const feature of Object.keys(financialFeaturePreferenceKeys)) {
      expect(
        isFinancialFeatureVisible(
          defaultProfilePreferences,
          feature as keyof typeof financialFeaturePreferenceKeys,
        ),
      ).toBe(true);
    }
  });

  it('skips optional onboarding steps after explicit No answers', () => {
    expect(
      activeSetupStepIds({
        usesIncome: 'no',
        usesBills: 'no',
        usesCreditCards: 'no',
        usesLoans: 'no',
        usesMoneyOwed: 'no',
        usesAssets: 'no',
      }),
    ).toEqual(['welcome', 'fit', 'cash', 'minimums', 'review']);

    expect(
      activeSetupStepIds({
        usesIncome: 'yes',
        usesBills: 'yes',
        usesCreditCards: 'yes',
      }),
    ).toEqual(['welcome', 'fit', 'cash', 'income', 'bill', 'cards', 'minimums', 'review']);
  });

  it('hides only disabled destinations and points direct links back to Settings', () => {
    const preferences = {
      ...defaultProfilePreferences,
      showBills: false,
      showLoans: false,
      showMoneyOwed: false,
    };
    expect(secondaryDestinationsFor('/accounts', preferences)).toEqual([
      ['Accounts home', '/accounts'],
      ['Credit cards', '/cards'],
      ['Assets and net worth', '/net-worth'],
    ]);
    expect(featureSettingsPath('loans')).toBe('/settings?section=features&feature=loans');
    expect(settingsSectionForLocation('/settings', '?section=features')).toBe('features');
  });

  it('finds settings by consumer terms across categories', () => {
    expect(searchSettings('credit card')[0]).toMatchObject({
      id: 'features',
      section: 'features',
    });
    expect(searchSettings('backup password')[0]).toMatchObject({
      id: 'backup',
      section: 'data',
    });
    expect(searchSettings('software update')[0]).toMatchObject({
      id: 'updates',
      section: 'updates',
    });
    expect(searchSettings('no such setting')).toEqual([]);
  });
});
