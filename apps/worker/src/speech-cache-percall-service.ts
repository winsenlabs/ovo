import {
  MULAW_8K,
  type AudioFormat,
  type Logger,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { PerCallClipOptions } from './speech-cache-env.ts';
import { selectedVoice } from './speech-cache-identity.ts';
import { CallClips, perCallLines, type PerCallLine } from './speech-cache-percall.ts';
import type { ReleaseSpeech } from './speech-cache-release-tts.ts';

export interface PrepareCallInput {
  /** The durable job id: the same key from dial hand-off (ringing) to the session that answers. */
  callKey: string;
  release: ReleaseRecord;
  variables: Readonly<Record<string, unknown>>;
  /** The call's own meter: early renders are the call's speech, not pre-render spend. */
  usage: UsageSink;
  format?: AudioFormat;
  /** Outbound legs may reach a machine, so their voicemail message is rendered early too. */
  answeringMachine: boolean;
  /** The session takes the clips now; an unclaimed set is discarded after `unclaimedTtlMs`. */
  claim?: boolean;
}

type OpenSpeech = (release: ReleaseRecord, usage: UsageSink) => Promise<ReleaseSpeech>;

/**
 * Per-call pre-render (TTS-10). At dial hand-off or admission a call's personal opening lines
 * (and an outbound voicemail message) start rendering on a provider composed for the purpose,
 * while the phone rings; the session renders its remaining templated lines with its own provider.
 * Everything is held in memory under the job id and dropped at session end, or when no session
 * claims it in time. Logs carry counts and ids, never the lines.
 */
export class PerCallClipService {
  private readonly calls = new Map<string, { clips: CallClips; timer?: NodeJS.Timeout }>();
  private openSpeech?: OpenSpeech;
  private readonly log: Logger;

  constructor(
    readonly options: PerCallClipOptions,
    private readonly maxClipBytes: number,
    log?: Logger,
  ) {
    this.log = log ?? createLogger({ service: 'worker', component: 'speech-percall' });
  }

  /** How early renders compose the release's TTS; without it the session renders everything. */
  attachSpeech(open: OpenSpeech): void {
    this.openSpeech = open;
  }

  get size(): number {
    return this.calls.size;
  }

  prepare(input: PrepareCallInput): CallClips | undefined {
    const existing = this.calls.get(input.callKey);
    if (existing && !existing.clips.discarded) {
      if (input.claim) this.claim(input.callKey);
      return existing.clips;
    }
    if (!this.options.enabled) return undefined;
    const lines = perCallLines(input.release, input.variables, {
      answeringMachine: input.answeringMachine,
      maxLines: this.options.maxLines,
    });
    if (!lines.length) return undefined;
    const clips = new CallClips(lines, input.format ?? MULAW_8K, {
      maxClipBytes: this.maxClipBytes,
      renderTimeoutMs: this.options.renderTimeoutMs,
      concurrency: this.options.concurrency,
    });
    const entry: { clips: CallClips; timer?: NodeJS.Timeout } = { clips };
    this.calls.set(input.callKey, entry);
    if (!input.claim) {
      entry.timer = setTimeout(() => this.release(input.callKey), this.options.unclaimedTtlMs);
      entry.timer.unref?.();
    }
    const early = this.openSpeech
      ? clips.reserve((line) => line.opening || line.source === 'voicemail')
      : [];
    if (early.length) void this.renderEarly(input, clips, early);
    return clips;
  }

  claim(callKey: string): CallClips | undefined {
    const entry = this.calls.get(callKey);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry) entry.timer = undefined;
    return entry?.clips;
  }

  /** The call ended (or never connected): its audio is dropped. */
  release(callKey: string): void {
    const entry = this.calls.get(callKey);
    if (!entry) return;
    this.calls.delete(callKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.clips.discard();
  }

  close(): void {
    for (const callKey of [...this.calls.keys()]) this.release(callKey);
  }

  private async renderEarly(
    input: PrepareCallInput,
    clips: CallClips,
    lines: PerCallLine[],
  ): Promise<void> {
    const startedAt = Date.now();
    let speech: ReleaseSpeech;
    try {
      speech = await this.openSpeech!(input.release, input.usage);
    } catch (error) {
      clips.abandon(lines, error);
      this.log.warn('speech_percall_open_failed', {
        jobId: input.callKey,
        releaseId: input.release.id,
        ...errorFields(error),
      });
      return;
    }
    try {
      await clips.render(
        {
          tts: speech.tts,
          filters: speech.filters,
          language: input.release.config.language,
          voice: selectedVoice(input.release),
          sessionId: `percall:${input.callKey}`,
          onUsage: input.usage,
        },
        lines,
      );
    } finally {
      await speech
        .close()
        .catch((error: unknown) =>
          this.log.warn('speech_percall_close_failed', errorFields(error)),
        );
    }
    this.log.info('speech_percall_rendered', {
      jobId: input.callKey,
      releaseId: input.release.id,
      lines: lines.length,
      ready: lines.filter((line) => clips.get(line.text)?.ready).length,
      elapsedMs: Date.now() - startedAt,
    });
  }
}
