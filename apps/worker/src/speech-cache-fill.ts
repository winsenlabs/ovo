import type { ByteCache } from '@winsendotai/ovo-plugin-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { collectClip } from './speech-cache-audio.ts';
import type { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

/** A detached render still ends: a provider that never finishes cannot hold a slot forever. */
export const DETACHED_RENDER_TIMEOUT_MS = 30_000;

export interface FixedLineLoad {
  tiers?: WorkerSpeechClipCache;
  cache: ByteCache;
  release: Pick<ReleaseRecord, 'id' | 'agentId' | 'workspaceId'>;
  key: string;
  /** Fixed line under a complete identity: may be read from and written to the durable tier. */
  durable: boolean;
  producerSignal: AbortSignal;
  push(chunk: Uint8Array): Promise<void>;
  codec: string;
  sampleRate: number;
  maxBytes: number;
  fromDurable(): void;
  render(signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/**
 * Fills one cache miss for an approved line: durable tier first, then a live render that streams
 * to the caller while it lasts. The render is detached from the caller: a barge-in stops the
 * forwarding, never the render, so the first caller's interruption does not throw the clip away
 * and make the next caller miss again.
 */
export async function loadFixedLine(input: FixedLineLoad): Promise<Uint8Array> {
  const { tiers, release, key } = input;
  let listening = true;
  const forward = async (chunk: Uint8Array) => {
    if (!listening || input.producerSignal.aborted) {
      listening = false;
      return;
    }
    try {
      await input.push(chunk);
    } catch {
      // swallow-ok: the caller stopped listening; the render carries on detached.
      listening = false;
    }
  };
  if (input.durable && tiers) {
    const stored = await tiers.fromDurable(key, release.workspaceId);
    if (stored) {
      input.fromDurable();
      tiers.pin(release, key, stored);
      await forward(stored);
      return stored;
    }
  }
  const signal = AbortSignal.any([
    tiers?.signal ?? new AbortController().signal,
    AbortSignal.timeout(DETACHED_RENDER_TIMEOUT_MS),
  ]);
  const audio = await collectClip(input.render(signal), input.maxBytes, forward);
  // With nobody left waiting the pending load is discarded, so the clip is kept here instead.
  if (!listening || input.producerSignal.aborted) input.cache.set(key, release.workspaceId, audio);
  if (input.durable && tiers) {
    tiers.pin(release, key, audio);
    void tiers.persist(release, {
      key,
      codec: input.codec,
      sampleRate: input.sampleRate,
      audio,
    });
  }
  return audio;
}
