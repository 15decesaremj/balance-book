import type { ProfilePreferences } from '@balance-book/domain';

export type FinancialFeature =
  'income' | 'bills' | 'credit-cards' | 'loans' | 'money-owed' | 'assets';

export const financialFeatureLabels: Record<FinancialFeature, string> = {
  income: 'Income and raises',
  bills: 'Bills & subscriptions',
  'credit-cards': 'Credit cards',
  loans: 'Loans and refinancing',
  'money-owed': 'Money owed to you',
  assets: 'Assets and net worth',
};

export const financialFeaturePreferenceKeys: Record<
  FinancialFeature,
  keyof Pick<
    ProfilePreferences,
    | 'showIncomeTools'
    | 'showBills'
    | 'showCreditCards'
    | 'showLoans'
    | 'showMoneyOwed'
    | 'showAssetsAndNetWorth'
  >
> = {
  income: 'showIncomeTools',
  bills: 'showBills',
  'credit-cards': 'showCreditCards',
  loans: 'showLoans',
  'money-owed': 'showMoneyOwed',
  assets: 'showAssetsAndNetWorth',
};

export const isFinancialFeatureVisible = (
  preferences: ProfilePreferences,
  feature: FinancialFeature,
): boolean => preferences[financialFeaturePreferenceKeys[feature]];

export const featureSettingsPath = (feature?: FinancialFeature): string =>
  feature
    ? `/settings?section=features&feature=${encodeURIComponent(feature)}`
    : '/settings?section=features';
