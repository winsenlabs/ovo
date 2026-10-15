import { bytesForMs, padWithSilence } from '@winsendotai/ovo-audio';
import type { AudioFormat } from '@winsendotai/ovo-contracts';

/**
 * The least audio a commit may close. With less, Scribe answers `commit_throttled` ("Commit request
 * ignored: only 0.22s of uncommitted audio. You need at least 0.3s of uncommitted audio before
 * committing.") and then closes the socket with 1000 `commit_throttled`, observed live by the
 * Wave 13 STT bake-off (2026-10-14). A shorter commit is padded with silence to this, 20 ms over
 * the limit for the provider's rounding.
 */
export const MIN_COMMIT_AUDIO_MS = 320;

/** A commit's chunk, padded with silence so it closes at least `MIN_COMMIT_AUDIO_MS` of audio. */
export function commitTail(
  tail: Uint8Array,
  sentSinceCommit: number,
  format: AudioFormat,
): Uint8Array {
  return padWithSilence(tail, bytesForMs(format, MIN_COMMIT_AUDIO_MS) - sentSinceCommit, format);
}
