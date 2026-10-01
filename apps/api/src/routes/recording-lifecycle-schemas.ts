export { LimitQuery } from './route-page-schema.ts';
export { PageQuery } from './route-page-schema.ts';
import { z } from 'zod';

export const CallParams = z.object({ callId: z.uuid() }).strict();
export const RecordingParams = z.object({ callId: z.uuid(), recordingId: z.uuid() }).strict();
export const TrackParams = z
  .object({
    callId: z.uuid(),
    recordingId: z.uuid(),
    track: z.enum(['inbound', 'outbound']),
  })
  .strict();
export const SegmentParams = z
  .object({
    callId: z.uuid(),
    recordingId: z.uuid(),
    track: z.enum(['inbound', 'outbound']),
    sequence: z.coerce.number().int().min(0).max(9_999),
  })
  .strict();

export const SweepBody = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.object({ expiresAt: z.iso.datetime(), artifactId: z.uuid() }).strict().optional(),
  })
  .strict();
