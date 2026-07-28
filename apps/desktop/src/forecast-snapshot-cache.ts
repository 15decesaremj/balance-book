import type { PlainDateString } from '@balance-book/domain';

interface ForecastSnapshotCacheRequest {
  userId: string;
  financialDate: PlainDateString;
  requiredEndDate?: PlainDateString;
  databaseRevision: string;
}

/**
 * Keeps expensive, immutable forecast snapshots available across route mounts.
 * The database revision is part of the contract: any committed write changes
 * the revision before another snapshot can be reused.
 */
export class ForecastSnapshotCache<Value> {
  private databaseRevision: string | undefined;
  private readonly values = new Map<string, Value>();

  getOrCreate(request: ForecastSnapshotCacheRequest, create: () => Value): Value {
    if (request.databaseRevision !== this.databaseRevision) {
      this.values.clear();
      this.databaseRevision = request.databaseRevision;
    }
    const key = JSON.stringify([
      request.userId,
      request.financialDate,
      request.requiredEndDate ?? null,
    ]);
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;
    const value = create();
    this.values.set(key, value);
    return value;
  }

  clear(): void {
    this.values.clear();
    this.databaseRevision = undefined;
  }
}
