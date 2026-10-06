import type { ByteCache } from '@winsendotai/ovo-plugin-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { collectClip } from './speech-cache-audio.ts';
import type { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

/** A detached render still ends: a provider that never finishes cannot hold a slot forever. */
export const DETACHED_RENDER_TIMEOUT_MS = 30_000;
/**
 * The longest a live line waits on the durable tier before it renders instead: a slow or saturated
 * database must cost a caller this much at most, never the database's own timeouts.
 */
export const DURABLE_READ_BUDGET_MS = 200;

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
  /** Defaults to `DURABLE_READ_BUDGET_MS`. */
  durableBudgetMs?: number;
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
    const read = tiers.fromDurable(key, release.workspaceId);
    const stored = await within(read, input.durableBudgetMs ?? DURABLE_READ_BUDGET_MS);
    // A read that arrives after the budget still pins its clip for the next caller.
    if (stored === TIMED_OUT)
      void read.then((late) => {
        if (late) tiers.pin(release, key, late);
      });
    else if (stored) {
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

const TIMED_OUT = Symbol('timed out');

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
