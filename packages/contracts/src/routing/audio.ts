import { z } from 'zod';

/**
 * A hold clip (R2): an operator-uploaded WAV converted once to 8 kHz mu-law and kept in the
 * operations database. Bytes never change; a soft-deleted clip stays playable by its digest for
 * the releases that pinned it.
 */
export interface RoutingAudio {
  id: string;
  workspaceId: string;
  name: string;
  codec: 'audio/x-mulaw';
  sampleRate: 8000;
  durationMs: number;
  byteLength: number;
  /** sha256 of the stored mu-law bytes, hex. */
  sha256: string;
  /** What was uploaded. */
  source: RoutingAudioSource;
  createdAt: string;
  createdBy: string;
  deletedAt?: string;
}

export const RoutingAudioSource = z
  .object({
    container: z.literal('wav'),
    encoding: z.enum(['pcm_s16le', 'pcm_u8', 'mulaw', 'alaw']),
    sampleRate: z.number().int().min(8_000).max(48_000),
    channels: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
export type RoutingAudioSource = z.infer<typeof RoutingAudioSource>;

export const RoutingAudioName = z.string().trim().min(1).max(120);
/** Stored clips are 0.1-300 s of 8 kHz mu-law (one byte per sample). */
export const ROUTING_AUDIO_LIMITS = Object.freeze({
  minMs: 100,
  maxMs: 300_000,
  minBytes: 800,
  maxBytes: 2_400_000,
});
