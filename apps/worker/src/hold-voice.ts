import type { AudioFormat, UsageSink } from '@winsendotai/ovo-contracts';
import { createSpeechCacheKey, normalizeSpeechText } from '@winsendotai/ovo-plugin-speech-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { waitForSendSlot } from './cached-media-player.ts';
import { collectClip, segmentAudio } from './speech-cache-audio.ts';
import { DETACHED_RENDER_TIMEOUT_MS } from './speech-cache-fill.ts';
import { selectedVoice, speechCacheIdentity } from './speech-cache-identity.ts';
import type { ReleaseSpeech } from './speech-cache-release-tts.ts';
import type { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

/** A hold or timeout line that is not cached gets this long to render; otherwise it is skipped. */
export const HOLD_LINE_RENDER_MS = 3_000;

export interface HoldVoice {
  /** The line's audio in the carrier's format; throws when it cannot be had within the bound. */
  render(text: string, language: string, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * The point's house voice for hold and timeout lines (transfer design 7.6): the router release's
 * own TTS, through the speech cache. A line pre-rendered for the router release (its routed voice
 * lines) plays from the pinned or durable tier at once; a miss renders once, within the bound,
 * and is kept for later calls (durably only under a complete identity, like any fixed line). The
 * TTS is composed on the first miss and closed with the hold. Generation is call-level usage.
 */
export function createHoldVoice(input: {
  release: ReleaseRecord;
  format: AudioFormat;
  sessionId: string;
  open(usage: UsageSink): Promise<ReleaseSpeech>;
  usage: UsageSink;
  tiers?: WorkerSpeechClipCache;
  renderTimeoutMs?: number;
}): HoldVoice {
  const { release, format, tiers } = input;
  const bound = input.renderTimeoutMs ?? HOLD_LINE_RENDER_MS;
  let speech: Promise<ReleaseSpeech> | undefined;
  const pending = new Map<string, Promise<Uint8Array>>();
  const render = async (text: string, language: string, signal: AbortSignal) => {
    const limit = AbortSignal.any([signal, AbortSignal.timeout(bound)]);
    const opening = (speech ??= input.open(input.usage));
    const { tts, filters } = await waitForSendSlot(opening, limit);
    const spoken = normalizeSpeechText(filters, text, language);
    const identity = speechCacheIdentity(release, tts, format);
    const key = createSpeechCacheKey(identity.binding, spoken);
    const hit = tiers?.lookup(key, release.workspaceId);
    if (hit) return hit.audio;
    const stored = identity.persistent
      ? await waitForSendSlot(Promise.resolve(tiers?.fromDurable(key, release.workspaceId)), limit)
      : undefined;
    if (stored) {
      tiers?.pin(release, key, stored);
      return stored;
    }
    // The render outlives the hold's wait (bounded like any detached render), so a line that
    // missed this hold is kept for the next one.
    let rendering = pending.get(key);
    if (!rendering) {
      rendering = collectClip(
        segmentAudio(tts, {
          sessionId: input.sessionId,
          text: spoken,
          format,
          language,
          voice: selectedVoice(release),
          signal: AbortSignal.timeout(DETACHED_RENDER_TIMEOUT_MS),
          onUsage: input.usage,
        }),
        tiers?.maxClipBytes ?? 2 * 1024 * 1024,
      )
        .then((audio) => {
          if (identity.persistent && tiers) {
            tiers.pin(release, key, audio);
            void tiers.persist(release, {
              key,
              codec: format.encoding,
              sampleRate: format.sampleRate,
              audio,
            });
          } else tiers?.set(key, release.workspaceId, audio);
          return audio;
        })
        .finally(() => pending.delete(key));
      // swallow-ok: a failed render is the waiting hold's to report (it skips the line).
      rendering.catch(() => undefined);
      pending.set(key, rendering);
    }
    return waitForSendSlot(rendering, limit);
  };
  return {
    render,
    async close() {
      const opened = speech;
      speech = undefined;
      // swallow-ok: a TTS that never opened has nothing to close.
      await (await opened?.catch(() => undefined))?.close();
    },
  };
}
