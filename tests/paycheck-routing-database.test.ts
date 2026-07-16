import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BalanceBookStore, type VerticalSliceInput } from '@balance-book/database';
import { type ForecastEvent } from '@balance-book/domain';

const temporaryDirectories: string[] = [];
const stores: BalanceBookStore[] = [];

const openStore = (prefix = 'balance-book-pay-routing-'): BalanceBookStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const store = new BalanceBookStore({
    databasePath: path.join(directory, 'balance-book.sqlite'),
    backupDirectory: path.join(directory, 'migration-backups'),
  });
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.raw.open) store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

const verticalSlice: VerticalSliceInput = {
  balanceAsOf: '2026-07-01',
  accountName: 'Synthetic primary checking',
  openingBalanceCents: 100_000,
  incomeLabel: 'Synthetic starter income',
  incomeDate: '2026-07-05',
  incomeAmountCents: 50_000,
  commitmentLabel: 'Synthetic starter commitment',
  commitmentDate: '2026-07-03',
  commitmentAmountCents: 20_000,
  cardName: 'Synthetic starter card',
  cardEstimateCents: 10_000,
  cardPaymentDayOfMonth: 15,
  cardStatementCloseDayOfMonth: 24,
  cardEstimatePolicy: 'baseline-guardrail',
  cardPaymentPolicy: 'full-statement',
  hardFloorCents: 10_000,
  preferredFloorCents: 20_000,
};

const setupProfile = (
  store: BalanceBookStore,
  userId: string,
): { earlyAccountId: string; primaryAccountId: string } => {
  store.saveVerticalSlice(userId, verticalSlice);
  const primary = store.getManagedRecords(userId).accounts[0]!;
  const earlyAccountId = `${userId}-early-checking`;
  store.upsertManagedEntity(userId, 'cash-account', {
    ...primary,
    id: earlyAccountId,
    name: 'Synthetic early checking',
    openingBalanceCents: 0,
  });
  return { earlyAccountId, primaryAccountId: primary.id };
};

const planId = 'synthetic-split-pay';
const streamId = 'synthetic-paycheck-stream';
const paycheckPlan = (
  userId: string,
  accounts: { earlyAccountId: string; primaryAccountId: string },
): ForecastEvent[] => [
  {
    id: 'synthetic-early-allocation',
    userId,
    accountId: accounts.earlyAccountId,
    date: '2026-07-15',
    kind: 'income',
    direction: 'inflow',
    amountCents: 45_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Synthetic split payroll',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'cash-account',
    recurrenceRule: { frequency: 'biweekly' },
    incomeType: 'paycheck',
    incomePlanId: planId,
    incomeStreamId: streamId,
    incomePlanTotalCents: 200_000,
    incomeNominalDate: '2026-07-17',
    incomeArrivalOffsetDays: -2,
    incomeAllocationRule: 'fixed',
    incomeAllocationOrder: 0,
  },
  {
    id: 'synthetic-primary-allocation',
    userId,
    accountId: accounts.primaryAccountId,
    date: '2026-07-17',
    kind: 'income',
    direction: 'inflow',
    amountCents: 155_000,
    certainty: 'confirmed',
    status: 'planned',
    label: 'Synthetic split payroll',
    hypothetical: false,
    accepted: false,
    paymentMethod: 'cash-account',
    recurrenceRule: { frequency: 'biweekly' },
    incomeType: 'paycheck',
    incomePlanId: planId,
    incomeStreamId: streamId,
    incomePlanTotalCents: 200_000,
    incomeNominalDate: '2026-07-17',
    incomeArrivalOffsetDays: 0,
    incomeAllocationRule: 'remainder',
    incomeAllocationOrder: 1,
  },
];

const initializeProfile = (store: BalanceBookStore, userId: string): void => {
  store.initializeProfiles([
    { id: userId, displayName: `Synthetic ${userId}`, username: `synthetic-${userId}` },
  ]);
};

describe('grouped paycheck database persistence', () => {
  it('creates every allocation atomically with grouped routing metadata intact', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');

    expect(store.upsertIncomePlan('profile-a', paycheckPlan('profile-a', accountIds))).toEqual([
      'synthetic-early-allocation',
      'synthetic-primary-allocation',
    ]);

    const stored = store
      .getManagedRecords('profile-a')
      .events.filter((event) => event.incomePlanId === planId)
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'synthetic-early-allocation',
          accountId: accountIds.earlyAccountId,
          amountCents: 45_000,
          incomePlanTotalCents: 200_000,
          incomeNominalDate: '2026-07-17',
          incomeArrivalOffsetDays: -2,
          incomeAllocationRule: 'fixed',
          incomeAllocationOrder: 0,
        }),
        expect.objectContaining({
          id: 'synthetic-primary-allocation',
          accountId: accountIds.primaryAccountId,
          amountCents: 155_000,
          incomePlanTotalCents: 200_000,
          incomeNominalDate: '2026-07-17',
          incomeArrivalOffsetDays: 0,
          incomeAllocationRule: 'remainder',
          incomeAllocationOrder: 1,
        }),
      ]),
    );
  });

  it('stores sequential routing phases under one stream and rejects an overlapping phase', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    const currentPhase = paycheckPlan('profile-a', accountIds).map((event) => ({
      ...event,
      recurrenceEndDate: '2026-09-25' as const,
    }));
    const futurePhase: ForecastEvent[] = [
      {
        ...currentPhase[1]!,
        id: 'synthetic-future-primary-allocation',
        date: '2026-10-09',
        amountCents: 200_000,
        incomePlanId: 'synthetic-primary-only-phase',
        incomeNominalDate: '2026-10-09',
        incomeAllocationOrder: 0,
        recurrenceEndDate: undefined,
      },
    ];

    store.upsertIncomePlan('profile-a', currentPhase);
    store.upsertIncomePlan('profile-a', futurePhase);

    const phases = store
      .getManagedRecords('profile-a')
      .events.filter((event) => event.incomeStreamId === streamId);
    expect(new Set(phases.map((event) => event.incomePlanId))).toEqual(
      new Set([planId, 'synthetic-primary-only-phase']),
    );
    expect(phases).toHaveLength(3);

    const overlappingPhase: ForecastEvent[] = [
      {
        ...futurePhase[0]!,
        id: 'synthetic-overlapping-primary-allocation',
        date: '2026-09-25',
        incomePlanId: 'synthetic-overlapping-phase',
        incomeNominalDate: '2026-09-25',
      },
    ];
    expect(() => store.upsertIncomePlan('profile-a', overlappingPhase)).toThrow(
      /overlapping routing phases/i,
    );
    expect(
      store
        .getManagedRecords('profile-a')
        .events.some((event) => event.incomePlanId === 'synthetic-overlapping-phase'),
    ).toBe(false);
  });

  it('atomically replaces a plan and removes an allocation omitted from the replacement', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    const [, primary] = paycheckPlan('profile-a', accountIds);
    store.upsertIncomePlan('profile-a', paycheckPlan('profile-a', accountIds));

    const replacement = {
      ...primary!,
      amountCents: 200_000,
      label: 'Synthetic consolidated payroll',
    };
    expect(store.upsertIncomePlan('profile-a', [replacement], planId)).toEqual([
      'synthetic-primary-allocation',
    ]);

    const stored = store
      .getManagedRecords('profile-a')
      .events.filter((event) => event.incomePlanId === planId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: 'synthetic-primary-allocation',
      accountId: accountIds.primaryAccountId,
      amountCents: 200_000,
      incomePlanTotalCents: 200_000,
      incomeAllocationRule: 'remainder',
    });
  });

  it('rejects creating a second group with an existing income-plan ID without replacement intent', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    const original = paycheckPlan('profile-a', accountIds);
    store.upsertIncomePlan('profile-a', original);

    const collidingPlan = [
      {
        ...original[1]!,
        id: 'synthetic-colliding-allocation',
        amountCents: 25_000,
        incomePlanTotalCents: 25_000,
        label: 'Synthetic colliding payroll',
      },
    ];

    expect(() => store.upsertIncomePlan('profile-a', collidingPlan)).toThrow(
      /income plan.*already exists|replace.*income plan/i,
    );
    const storedPlan = store
      .getManagedRecords('profile-a')
      .events.filter((event) => event.incomePlanId === planId);
    expect(storedPlan).toHaveLength(2);
    expect(storedPlan).toEqual(
      expect.arrayContaining(original.map((event) => expect.objectContaining(event))),
    );
  });

  it('rejects duplicate allocation order atomically', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    const duplicateOrder = paycheckPlan('profile-a', accountIds).map((event) => ({
      ...event,
      incomeAllocationOrder: 0,
    }));

    expect(() => store.upsertIncomePlan('profile-a', duplicateOrder)).toThrow(
      /duplicate allocation order/i,
    );
    expect(
      store.getManagedRecords('profile-a').events.filter((event) => event.incomePlanId === planId),
    ).toEqual([]);
  });

  it('rejects moving an existing allocation ID into a different income plan', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    const original = paycheckPlan('profile-a', accountIds);
    store.upsertIncomePlan('profile-a', original);

    const collidingAllocation = [
      {
        ...original[1]!,
        amountCents: 155_000,
        incomePlanId: 'synthetic-other-plan',
        incomePlanTotalCents: 155_000,
        label: 'Synthetic other payroll',
      },
    ];

    expect(() => store.upsertIncomePlan('profile-a', collidingAllocation)).toThrow(
      /allocation.*already belongs|record.*income plan/i,
    );
    expect(
      store
        .getManagedRecords('profile-a')
        .events.filter((event) => event.incomePlanId === planId)
        .map((event) => event.id)
        .sort(),
    ).toEqual(['synthetic-early-allocation', 'synthetic-primary-allocation']);
    expect(
      store
        .getManagedRecords('profile-a')
        .events.filter((event) => event.incomePlanId === 'synthetic-other-plan'),
    ).toEqual([]);
  });

  it('never leaves a linked raise on stale schedule mechanics after a base-plan edit', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    const original = paycheckPlan('profile-a', accountIds);
    store.upsertIncomePlan('profile-a', original);
    const linkedRaise: ForecastEvent = {
      ...original[0]!,
      id: 'synthetic-linked-raise',
      amountCents: 20_000,
      label: 'Synthetic split payroll raise adjustment',
      incomeType: 'raise-adjustment',
      incomePlanId: 'synthetic-linked-raise-plan',
      incomeStreamId: 'synthetic-linked-raise-stream',
      incomePlanTotalCents: 20_000,
      incomeNominalDate: '2026-07-31',
      date: '2026-07-29',
      incomeAllocationRule: 'remainder',
      parentIncomePlanId: planId,
      recurrenceEndDate: '2026-09-25',
    };
    store.upsertIncomePlan('profile-a', [linkedRaise]);

    const shortenedBase = original.map((event) => ({
      ...event,
      date: event.id === 'synthetic-early-allocation' ? ('2026-07-14' as const) : event.date,
      recurrenceRule: { frequency: 'weekly' as const, interval: 1 },
      recurrenceEndDate: '2026-08-14' as const,
      incomeArrivalOffsetDays:
        event.id === 'synthetic-early-allocation' ? -3 : event.incomeArrivalOffsetDays,
    }));

    try {
      store.upsertIncomePlan('profile-a', shortenedBase, planId);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/linked raise|raise.*schedule/i);
    }
    const stored = store.getManagedRecords('profile-a').events;
    const storedBase = stored.filter((event) => event.incomePlanId === planId);
    const storedRaise = stored.find(
      (event) => event.incomePlanId === 'synthetic-linked-raise-plan',
    );
    expect(storedRaise).toMatchObject({
      parentIncomePlanId: planId,
    });
    const baseEditWasApplied = storedBase.every(
      (event) => event.recurrenceEndDate === '2026-08-14',
    );
    if (baseEditWasApplied) {
      expect(storedRaise).toMatchObject({
        date: '2026-07-28',
        recurrenceRule: { frequency: 'weekly', interval: 1 },
        recurrenceEndDate: '2026-08-14',
        incomeArrivalOffsetDays: -3,
      });
    } else {
      expect(storedBase.every((event) => !event.recurrenceEndDate)).toBe(true);
      expect(storedRaise).toMatchObject({
        date: '2026-07-29',
        recurrenceRule: { frequency: 'biweekly' },
        recurrenceEndDate: '2026-09-25',
        incomeArrivalOffsetDays: -2,
      });
    }
  });

  it('rejects a generic one-allocation edit so a grouped plan cannot be unbalanced', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    store.upsertIncomePlan('profile-a', paycheckPlan('profile-a', accountIds));
    const early = store
      .getManagedRecords('profile-a')
      .events.find((event) => event.id === 'synthetic-early-allocation')!;

    expect(() =>
      store.upsertManagedEntity('profile-a', 'forecast-event', {
        ...early,
        amountCents: 50_000,
      }),
    ).toThrow(/edit grouped income from income and raises/i);
    expect(
      store
        .getManagedRecords('profile-a')
        .events.find((event) => event.id === 'synthetic-early-allocation')?.amountCents,
    ).toBe(45_000);
  });

  it('deletes the complete group when either allocation is deleted', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    const accountIds = setupProfile(store, 'profile-a');
    store.upsertIncomePlan('profile-a', paycheckPlan('profile-a', accountIds));

    store.deleteManagedEntity('profile-a', 'forecast-event', 'synthetic-early-allocation');

    expect(
      store.getManagedRecords('profile-a').events.filter((event) => event.incomePlanId === planId),
    ).toEqual([]);
  });

  it('rejects a cross-user destination and rolls back the otherwise valid allocation', () => {
    const store = openStore();
    initializeProfile(store, 'profile-a');
    initializeProfile(store, 'profile-b');
    const profileAAccounts = setupProfile(store, 'profile-a');
    const profileBAccounts = setupProfile(store, 'profile-b');
    const crossUserPlan = paycheckPlan('profile-a', {
      earlyAccountId: profileAAccounts.earlyAccountId,
      primaryAccountId: profileBAccounts.primaryAccountId,
    });

    expect(() => store.upsertIncomePlan('profile-a', crossUserPlan)).toThrow(
      /not available to this profile/i,
    );
    expect(
      store.getManagedRecords('profile-a').events.filter((event) => event.incomePlanId === planId),
    ).toEqual([]);
  });

  it('round-trips grouped routing metadata through a portable profile export and restore', () => {
    const source = openStore('balance-book-pay-routing-source-');
    initializeProfile(source, 'source-profile');
    const sourceAccounts = setupProfile(source, 'source-profile');
    source.upsertIncomePlan('source-profile', paycheckPlan('source-profile', sourceAccounts));
    const portable = source.exportPortableProfile('source-profile', '1.0.0-test');

    const destination = openStore('balance-book-pay-routing-destination-');
    initializeProfile(destination, 'destination-profile');
    destination.replacePortableProfile('destination-profile', portable);

    const restored = destination
      .getManagedRecords('destination-profile')
      .events.filter((event) => event.incomePlanId === planId)
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(restored).toHaveLength(2);
    expect(restored.every((event) => event.userId === 'destination-profile')).toBe(true);
    expect(
      restored.map(
        ({
          id,
          amountCents,
          incomePlanTotalCents,
          incomeStreamId,
          incomeNominalDate,
          incomeArrivalOffsetDays,
          incomeAllocationRule,
          incomeAllocationOrder,
          recurrenceRule,
        }) => ({
          id,
          amountCents,
          incomePlanTotalCents,
          incomeStreamId,
          incomeNominalDate,
          incomeArrivalOffsetDays,
          incomeAllocationRule,
          incomeAllocationOrder,
          recurrenceRule,
        }),
      ),
    ).toEqual([
      {
        id: 'synthetic-early-allocation',
        amountCents: 45_000,
        incomePlanTotalCents: 200_000,
        incomeStreamId: streamId,
        incomeNominalDate: '2026-07-17',
        incomeArrivalOffsetDays: -2,
        incomeAllocationRule: 'fixed',
        incomeAllocationOrder: 0,
        recurrenceRule: { frequency: 'biweekly' },
      },
      {
        id: 'synthetic-primary-allocation',
        amountCents: 155_000,
        incomePlanTotalCents: 200_000,
        incomeStreamId: streamId,
        incomeNominalDate: '2026-07-17',
        incomeArrivalOffsetDays: 0,
        incomeAllocationRule: 'remainder',
        incomeAllocationOrder: 1,
        recurrenceRule: { frequency: 'biweekly' },
      },
    ]);
  });
});
