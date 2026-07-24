import { describe, expect, it } from 'vitest';
import {
  pendingUpdateMetadataSchema,
  postUpdateNoticeFromMetadata,
} from '../apps/desktop/src/update-metadata';

const metadata = {
  oldVersion: '2.0.5',
  releaseName: 'Balance Book 2.0.6 Beta',
  releaseNotes: 'A safer onboarding and update experience.',
  initiatedAt: '2026-07-23T12:00:00.000Z',
};

describe('post-update metadata', () => {
  it('creates a one-time confirmation only after the version changes', () => {
    expect(postUpdateNoticeFromMetadata(metadata, '2.0.6')).toEqual({
      oldVersion: '2.0.5',
      newVersion: '2.0.6',
      releaseName: 'Balance Book 2.0.6 Beta',
      releaseNotes: 'A safer onboarding and update experience.',
      profileRetained: true,
    });
    expect(postUpdateNoticeFromMetadata(metadata, '2.0.5')).toBeNull();
  });

  it('rejects malformed, oversized, and private-data-shaped metadata', () => {
    expect(() =>
      pendingUpdateMetadataSchema.parse({
        ...metadata,
        accountBalances: [{ name: 'Synthetic checking', amount: 100 }],
      }),
    ).toThrow();
    expect(() =>
      pendingUpdateMetadataSchema.parse({
        ...metadata,
        releaseNotes: 'x'.repeat(2_001),
      }),
    ).toThrow();
  });
});
