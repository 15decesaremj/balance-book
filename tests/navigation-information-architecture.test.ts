import { describe, expect, it } from 'vitest';
import {
  primaryPathForLocation,
  secondaryDestinationsFor,
  settingsSectionForLocation,
} from '../apps/desktop/src/renderer/App';

describe('five-destination information architecture', () => {
  it('keeps every supported deep route under one of the five stable primary destinations', () => {
    const expectedPrimaryByPath: Record<string, string> = {
      '/': '/',
      '/forecast': '/forecast',
      '/income': '/forecast',
      '/baseline': '/forecast',
      '/accounts': '/accounts',
      '/bills': '/accounts',
      '/cards': '/accounts',
      '/loans': '/accounts',
      '/receivables': '/accounts',
      '/net-worth': '/accounts',
      '/planning': '/planning',
      '/scenario': '/planning',
      '/refinance': '/planning',
      '/charts': '/planning',
      '/settings': '/settings',
      '/data': '/settings',
      '/reconcile': '/settings',
      '/setup': '/settings',
      '/records': '/settings',
    };

    for (const [path, primary] of Object.entries(expectedPrimaryByPath)) {
      expect(primaryPathForLocation(path), path).toBe(primary);
    }
    expect(new Set(Object.values(expectedPrimaryByPath))).toEqual(
      new Set(['/', '/forecast', '/accounts', '/planning', '/settings']),
    );
  });

  it('offers concise secondary navigation without removing any advanced destination', () => {
    expect(secondaryDestinationsFor('/income')).toEqual([
      ['Cash forecast', '/forecast'],
      ['Income and raises', '/income'],
      ['Recurring plan', '/baseline'],
    ]);
    expect(secondaryDestinationsFor('/cards')).toEqual([
      ['Accounts home', '/accounts'],
      ['Bills & subscriptions', '/bills'],
      ['Credit cards', '/cards'],
      ['Loans', '/loans'],
      ['Money owed', '/receivables'],
      ['Assets and net worth', '/net-worth'],
    ]);
    expect(secondaryDestinationsFor('/refinance')).toEqual([
      ['Planning home', '/planning'],
      ['Scenarios', '/scenario'],
      ['Refinance', '/refinance'],
      ['Trends', '/charts'],
    ]);
    expect(secondaryDestinationsFor('/records')).toEqual([
      ['Settings', '/settings'],
      ['Financial check-in', '/reconcile'],
      ['Setup status', '/setup'],
      ['Advanced records', '/records'],
    ]);
  });

  it('keeps preserved settings deep links synchronized with progressive categories', () => {
    expect(settingsSectionForLocation('/data', '')).toBe('data');
    expect(settingsSectionForLocation('/settings', '?section=accounts')).toBe('accounts');
    expect(settingsSectionForLocation('/settings', '?section=security')).toBe('security');
    expect(settingsSectionForLocation('/settings', '?section=unknown')).toBe('appearance');
    expect(settingsSectionForLocation('/settings', '')).toBe('appearance');
  });
});
