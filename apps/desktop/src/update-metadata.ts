import { z } from 'zod';
import { postUpdateNoticeSchema, type PostUpdateNoticeDto } from './shared/contracts';

export const pendingUpdateMetadataSchema = z
  .object({
    oldVersion: z.string().min(1).max(40),
    releaseName: z.string().min(1).max(160).optional(),
    releaseNotes: z.string().max(2_000).optional(),
    initiatedAt: z.string().datetime(),
  })
  .strict();

export type PendingUpdateMetadata = z.infer<typeof pendingUpdateMetadataSchema>;

export const postUpdateNoticeFromMetadata = (
  raw: unknown,
  currentVersion: string,
): PostUpdateNoticeDto | null => {
  const metadata = pendingUpdateMetadataSchema.parse(raw);
  if (metadata.oldVersion === currentVersion) return null;
  return postUpdateNoticeSchema.parse({
    oldVersion: metadata.oldVersion,
    newVersion: currentVersion,
    releaseName: metadata.releaseName,
    releaseNotes: metadata.releaseNotes,
    profileRetained: true,
  });
};
