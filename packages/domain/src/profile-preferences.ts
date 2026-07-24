import { z } from 'zod';

export const overviewForecastModeSchema = z.enum(['expected', 'conservative']);
export const updateChannelSchema = z.enum(['beta', 'stable']);

export const profilePreferencesSchema = z
  .object({
    overviewForecastMode: overviewForecastModeSchema,
    compactLayout: z.boolean(),
    reduceMotion: z.boolean(),
    sidebarCollapsed: z.boolean(),
    showOverviewDailySummary: z.boolean(),
    showOverviewUpcomingEvents: z.boolean(),
    showOverviewWiderPicture: z.boolean(),
    showIncomeTools: z.boolean(),
    showBills: z.boolean(),
    showCreditCards: z.boolean(),
    showLoans: z.boolean(),
    showMoneyOwed: z.boolean(),
    showAssetsAndNetWorth: z.boolean(),
    experimentalCardInterestForecastEnabled: z.boolean(),
    updateChannel: updateChannelSchema,
  })
  .strict();

export type ProfilePreferences = z.infer<typeof profilePreferencesSchema>;

export const defaultProfilePreferences: ProfilePreferences = {
  overviewForecastMode: 'expected',
  compactLayout: false,
  reduceMotion: false,
  sidebarCollapsed: false,
  showOverviewDailySummary: true,
  showOverviewUpcomingEvents: true,
  showOverviewWiderPicture: true,
  showIncomeTools: true,
  showBills: true,
  showCreditCards: true,
  showLoans: true,
  showMoneyOwed: true,
  showAssetsAndNetWorth: true,
  experimentalCardInterestForecastEnabled: false,
  updateChannel: 'beta',
};

/**
 * Stored preferences are additive so a profile created by an older release can adopt new defaults
 * without a data rewrite. IPC and current portable backups use the complete strict schema above.
 */
export const storedProfilePreferencesSchema = profilePreferencesSchema
  .partial()
  .transform((preferences): ProfilePreferences => ({
    ...defaultProfilePreferences,
    ...preferences,
  }));
