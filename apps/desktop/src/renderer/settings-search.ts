export type SettingsSection =
  'appearance' | 'features' | 'forecast' | 'accounts' | 'updates' | 'data' | 'security';

export type SettingsSearchEntry = {
  id: string;
  title: string;
  description: string;
  section: SettingsSection;
  keywords: readonly string[];
};

export const settingsSearchEntries: readonly SettingsSearchEntry[] = [
  {
    id: 'appearance',
    title: 'Theme, navigation, spacing, and motion',
    description:
      'Dark or light theme, collapsible navigation, compact spacing, and reduced animation.',
    section: 'appearance',
    keywords: [
      'appearance',
      'dark',
      'light',
      'theme',
      'sidebar',
      'navigation',
      'collapse',
      'menu',
      'spacing',
      'motion',
      'animation',
    ],
  },
  {
    id: 'overview',
    title: 'Overview defaults',
    description: 'Default forecast view and optional Overview sections.',
    section: 'appearance',
    keywords: ['overview', 'expected', 'conservative', 'daily', 'upcoming', 'wider picture'],
  },
  {
    id: 'features',
    title: 'Visible money tools',
    description: 'Show or hide income, bills, cards, loans, money owed, assets, and net worth.',
    section: 'features',
    keywords: [
      'features',
      'sections',
      'hide',
      'show',
      'income',
      'raises',
      'bonus',
      'bills',
      'subscriptions',
      'credit',
      'cards',
      'loans',
      'refinance',
      'money owed',
      'receivables',
      'assets',
      'investments',
      'net worth',
    ],
  },
  {
    id: 'forecast',
    title: 'Forecast safety',
    description: 'Protected minimums, preferred buffer, horizon, and conservative receipts.',
    section: 'forecast',
    keywords: ['forecast', 'minimum', 'floor', 'buffer', 'horizon', 'safe spend', 'receivables'],
  },
  {
    id: 'card-interest',
    title: 'Experimental card interest',
    description: 'Optionally forecast monthly interest on unpaid card balances.',
    section: 'forecast',
    keywords: [
      'credit card',
      'interest',
      'apr',
      'carry',
      'carried balance',
      'promotional',
      'experimental',
      'forecast',
    ],
  },
  {
    id: 'accounts',
    title: 'Account protection and visibility',
    description: 'Account minimums, transfers, liquidity, and Overview visibility.',
    section: 'accounts',
    keywords: ['accounts', 'checking', 'savings', 'minimum', 'transfer', 'overview', 'visibility'],
  },
  {
    id: 'updates',
    title: 'Application updates',
    description: 'Current version, Beta or Stable channel, and manual update checks.',
    section: 'updates',
    keywords: ['software', 'updates', 'version', 'beta', 'stable', 'restart', 'release'],
  },
  {
    id: 'backup',
    title: 'Backup, restore, and export',
    description: 'Encrypted portable backup, restore, and plaintext exports.',
    section: 'data',
    keywords: ['backup', 'restore', 'export', 'import', 'portable', 'password'],
  },
  {
    id: 'security',
    title: 'Security and profile reset',
    description: 'Local privacy boundary and permanent active-profile data reset.',
    section: 'security',
    keywords: ['security', 'privacy', 'local', 'password', 'reset', 'delete'],
  },
] as const;

const normalize = (value: string): string =>
  value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();

export const searchSettings = (
  query: string,
  entries: readonly SettingsSearchEntry[] = settingsSearchEntries,
): SettingsSearchEntry[] => {
  const terms = normalize(query).split(' ').filter(Boolean);
  if (terms.length === 0) return [];
  return entries.filter((entry) => {
    const haystack = normalize(
      [entry.title, entry.description, entry.section, ...entry.keywords].join(' '),
    );
    return terms.every((term) => haystack.includes(term));
  });
};
