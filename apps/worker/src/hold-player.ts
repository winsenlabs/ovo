import {
  bytesPerSecond,
  MULAW_8K,
  type AudioFormat,
  type HoldPolicy,
  type HoldStep,
  type RouteLines,
} from '@winsendotai/ovo-contracts';
import { convertClip } from '@winsendotai/ovo-session-host';
import type { HoldVoice } from './hold-voice.ts';

/** Audio is sent in 20 ms frames, at most this far ahead of the caller hearing it. */
export const HOLD_LOOKAHEAD_MS = 300;
const FRAME_MS = 20;
/** A pass over the steps that played nothing (every clip missing) waits this long before the next. */
const IDLE_PASS_MS = 1_000;

export interface HoldClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realHoldClock: HoldClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
    }),
};

/** The line for the call's language, else the default language's, else English, else the first. */
export function lineFor(
  lines: RouteLines,
  language: string | undefined,
  defaultLanguage: string,
): { text: string; language: string } {
  const pick = [language, defaultLanguage, 'en'].find(
    (code): code is string => code !== undefined && lines[code] !== undefined,
  );
  const [code, text] = pick ? [pick, lines[pick]!] : (Object.entries(lines)[0] ?? ['en', '']);
  return { text, language: code };
}

export interface HoldMedia {
  sendAudio(audio: Uint8Array, signal?: AbortSignal): Promise<void>;
  clear(): Promise<void>;
  release(): void;
}

export interface HoldPlayerInput {
  /** The hold's own live lease on the call's (recorded) media. */
  media: HoldMedia;
  format: AudioFormat;
  policy: HoldPolicy;
  /** The call's language (route context) and the point's default. */
  language: { call?: string; default: string };
  clips?: { get(id: string, sha256: string | undefined): Promise<Uint8Array | undefined> };
  voice?: HoldVoice;
  audit(type: string, payload: Record<string, unknown>): void;
  /** Stamped on every audit (absent for the router's own handoff). */
  tags: Record<string, unknown>;
  clock?: HoldClock;
}

/**
 * Plays a hold sequence on its own lease of the call's media (transfer design 7.6), so every byte
 * passes the recording tap: clips (8 kHz mu-law from the operations database, cut at their
 * `maxSeconds`), silences, and reassurance lines in the point's house voice, in order and then
 * from `loopFrom`, until stopped. A clip that cannot be read and a line that cannot be rendered
 * in time are skipped and audited. `stop` stops sending, clears what the carrier still holds and
 * gives the lease back; `say` replaces the sequence with one last line, played out in full.
 */
export class HoldPlayer {
  private readonly controller = new AbortController();
  private readonly clock: HoldClock;
  private readonly frameBytes: number;
  private readonly lines = new Map<string, Uint8Array | null>();
  private readonly warned = new Set<string>();
  private loop?: Promise<void>;
  private startedAt?: number;
  private finished?: Promise<void>;
  private sent = false;

  constructor(private readonly input: HoldPlayerInput) {
    this.clock = input.clock ?? realHoldClock;
    const sample = input.format.encoding === 'pcm_s16le' ? 2 : 1;
    this.frameBytes = Math.max(
      sample,
      Math.floor((bytesPerSecond(input.format) * FRAME_MS) / 1000 / sample) * sample,
    );
  }

  get started(): boolean {
    return this.startedAt !== undefined;
  }

  start(source: 'target' | 'point' | 'default' | 'queue'): void {
    if (this.startedAt !== undefined || this.finished) return;
    this.startedAt = this.clock.now();
    this.input.audit('transfer.hold.started', { ...this.input.tags, policy: source });
    this.loop = this.run(this.controller.signal).catch((error: unknown) =>
      // The link went away under the hold (the caller hung up): the call's close stops it.
      this.input.audit('transfer.hold.failed', {
        ...this.input.tags,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }

  /** Stops the sequence and releases the lease. Idempotent; resolves once the link is clear. */
  stop(why: string): Promise<void> {
    return (this.finished ??= this.halt(why, undefined));
  }

  /** Stops the sequence, then plays `lines` once, in full (a timeout chain's last words). */
  say(lines: RouteLines, why: string): Promise<void> {
    return (this.finished ??= this.halt(why, lines));
  }

  private async halt(why: string, last: RouteLines | undefined): Promise<void> {
    this.controller.abort();
    await this.loop;
    try {
      if (this.sent) await this.input.media.clear();
      if (last) await this.speak(last, new AbortController().signal);
    } catch (error) {
      // The link is gone (the caller hung up): there is nothing left to clear or say.
      this.input.audit('transfer.hold.failed', {
        ...this.input.tags,
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      this.input.media.release();
      if (this.startedAt !== undefined)
        this.input.audit('transfer.hold.stopped', {
          ...this.input.tags,
          ms: this.clock.now() - this.startedAt,
          why,
        });
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { steps, loopFrom } = this.input.policy;
    let index = 0;
    let played = false;
    while (!signal.aborted) {
      played = (await this.play(steps[index]!, signal)) || played;
      index += 1;
      if (index < steps.length) continue;
      index = Math.min(loopFrom, steps.length - 1);
      if (!played) await this.clock.sleep(IDLE_PASS_MS, signal);
      played = false;
    }
  }

  /** True when the step took time (audio or silence). */
  private async play(step: HoldStep, signal: AbortSignal): Promise<boolean> {
    try {
      if (step.kind === 'silence') {
        await this.clock.sleep(step.seconds * 1000, signal);
        return true;
      }
      if (step.kind === 'line') return await this.speak(step.line, signal);
      // swallow-ok: an unreadable clip is skipped and audited below, like a missing one.
      const clip = await this.input.clips?.get(step.assetId, step.sha256).catch(() => undefined);
      const cut = clip?.subarray(0, (step.maxSeconds ?? Infinity) * bytesPerSecond(MULAW_8K));
      const audio = cut?.byteLength ? convertClip(cut, MULAW_8K, this.input.format) : undefined;
      if (!audio) {
        this.warnOnce(`clip:${step.assetId}`, 'transfer.hold.clip_missing', {
          assetId: step.assetId,
        });
        return false;
      }
      await this.send(audio, signal);
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    }
  }

  private async speak(lines: RouteLines, signal: AbortSignal): Promise<boolean> {
    const { text, language } = lineFor(
      lines,
      this.input.language.call,
      this.input.language.default,
    );
    let audio = this.lines.get(text);
    if (audio === undefined) {
      audio = this.input.voice
        ? // swallow-ok: a line that cannot be rendered in time is skipped and audited below.
          await this.input.voice.render(text, language, signal).catch(() => null)
        : null;
      if (signal.aborted) return false;
      this.lines.set(text, audio);
    }
    if (!audio) {
      this.warnOnce(`line:${text}`, 'transfer.hold.line_failed', { language });
      return false;
    }
    await this.send(audio, signal);
    return true;
  }

  /** Sends `audio` in frames, paced to playback, and waits until the caller has heard it. */
  private async send(audio: Uint8Array, signal: AbortSignal): Promise<void> {
    const startedAt = this.clock.now();
    let frame = 0;
    for (let offset = 0; offset < audio.byteLength; offset += this.frameBytes, frame += 1) {
      const wait = startedAt + frame * FRAME_MS - HOLD_LOOKAHEAD_MS - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait, signal);
      if (signal.aborted) return;
      this.sent = true;
      await this.input.media.sendAudio(audio.subarray(offset, offset + this.frameBytes));
    }
    const playedOut = startedAt + frame * FRAME_MS - this.clock.now();
    if (playedOut > 0) await this.clock.sleep(playedOut, signal);
  }

  private warnOnce(key: string, type: string, payload: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.input.audit(type, { ...this.input.tags, ...payload });
  }
}
