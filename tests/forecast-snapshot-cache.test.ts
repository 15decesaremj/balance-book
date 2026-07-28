import { describe, expect, it, vi } from 'vitest';
import { ForecastSnapshotCache } from '../apps/desktop/src/forecast-snapshot-cache';

const request = {
  userId: 'profile-one',
  financialDate: '2026-07-27' as const,
  databaseRevision: '12:4',
};

describe('forecast snapshot cache', () => {
  it('reuses a snapshot for duplicate route and notification requests', () => {
    const cache = new ForecastSnapshotCache<{ marker: number }>();
    const create = vi.fn(() => ({ marker: 1 }));

    const first = cache.getOrCreate(request, create);
    const second = cache.getOrCreate(request, create);

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps different profile, date, and horizon requests isolated', () => {
    const cache = new ForecastSnapshotCache<{ marker: number }>();
    let marker = 0;
    const create = () => ({ marker: ++marker });

    const base = cache.getOrCreate(request, create);
    const otherProfile = cache.getOrCreate({ ...request, userId: 'profile-two' }, create);
    const otherDate = cache.getOrCreate({ ...request, financialDate: '2026-07-28' }, create);
    const otherHorizon = cache.getOrCreate({ ...request, requiredEndDate: '2027-12-31' }, create);

    expect([base.marker, otherProfile.marker, otherDate.marker, otherHorizon.marker]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('invalidates every cached horizon after the database revision changes', () => {
    const cache = new ForecastSnapshotCache<{ marker: number }>();
    let marker = 0;
    const create = () => ({ marker: ++marker });
    cache.getOrCreate(request, create);
    cache.getOrCreate({ ...request, requiredEndDate: '2027-12-31' }, create);

    const afterWrite = cache.getOrCreate({ ...request, databaseRevision: '13:4' }, create);
    const rebuiltHorizon = cache.getOrCreate(
      {
        ...request,
        databaseRevision: '13:4',
        requiredEndDate: '2027-12-31',
      },
      create,
    );

    expect(afterWrite.marker).toBe(3);
    expect(rebuiltHorizon.marker).toBe(4);
  });

  it('can be cleared explicitly on logout or profile transitions', () => {
    const cache = new ForecastSnapshotCache<{ marker: number }>();
    let marker = 0;
    const create = () => ({ marker: ++marker });
    cache.getOrCreate(request, create);

    cache.clear();

    expect(cache.getOrCreate(request, create).marker).toBe(2);
  });
});
