import { AgentVariables } from '@winsendotai/ovo-behaviors';
import type { AudioFormat, TextFilter, TextToSpeech, UsageSink } from '@winsendotai/ovo-contracts';
import {
  normalizeSpeechText,
  openingLineTemplates,
  staticSpeechInventory,
  type FixedLineSource,
} from '@winsendotai/ovo-plugin-speech-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { SpeechClipTooLargeError, segmentAudio } from './speech-cache-audio.ts';

/**
 * One templated line rendered with this call's variables (TTS-10). `text` is what the behaviour
 * will say, before the speaker's text filters. It carries caller data: it lives in this process's
 * memory for the call only, and is never logged, cached across calls or written anywhere.
 */
export interface PerCallLine {
  text: string;
  source: FixedLineSource;
  /** Spoken before the caller says anything, so worth having while the phone still rings. */
  opening: boolean;
}

/** The templates each mode renders through `AgentVariables`, exactly as its behaviour does. */
const AGENT_SOURCES: ReadonlySet<FixedLineSource> = new Set([
  'opening',
  'voicemail',
  'flow',
  'decision',
  'idle-prompt',
  'recovery',
]);

/**
 * A call's templated lines as its behaviour will speak them, opening first, then the voicemail
 * message, then the rest, at most `maxLines`. A line this call's data cannot fill is left out,
 * as the behaviour leaves it unspoken. Empty unless the release has its speech cache on.
 */
export function perCallLines(
  release: Pick<ReleaseRecord, 'config' | 'selections'>,
  variables: Readonly<Record<string, unknown>>,
  options: { answeringMachine: boolean; maxLines: number; now?: () => Date },
): PerCallLine[] {
  const { config } = release;
  if (!config.speechCache?.enabled || options.maxLines < 1) return [];
  let renderer: AgentVariables;
  try {
    renderer = new AgentVariables(config, options.now);
  } catch {
    // swallow-ok: a release whose templates do not validate renders every line live, as before.
    return [];
  }
  const opening = new Set(openingLineTemplates(config));
  const lines: PerCallLine[] = [];
  const seen = new Set<string>();
  for (const line of staticSpeechInventory(release).perCall) {
    const spoken =
      config.mode === 'agent'
        ? AGENT_SOURCES.has(line.source)
        : config.mode === 'announcement' && line.source === 'greeting';
    if (!spoken || (line.source === 'voicemail' && !options.answeringMachine)) continue;
    let text: string;
    try {
      text = renderer.render(line.text, variables);
    } catch {
      // swallow-ok: the behaviour skips a line it cannot fill, so there is nothing to render.
      continue;
    }
    if (!text.trim() || seen.has(text)) continue;
    seen.add(text);
    const first = opening.has(line.text) || line.source === 'greeting';
    lines.push({ text, source: line.source, opening: first });
  }
  const rank = (line: PerCallLine) => (line.opening ? 0 : line.source === 'voicemail' ? 1 : 2);
  return lines.sort((a, b) => rank(a) - rank(b)).slice(0, options.maxLines);
}

/** One personal line's audio as it renders, shared by every playback of it in the call. */
export class PerCallClip {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private state: 'waiting' | 'rendering' | 'ready' | 'failed' = 'waiting';
  private error?: unknown;
  private wake = new Set<() => void>();

  get failed(): boolean {
    return this.state === 'failed';
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  get byteLength(): number {
    return this.bytes;
  }

  append(chunk: Uint8Array, maxBytes: number): void {
    if (this.state === 'failed' || this.state === 'ready') return;
    if (this.bytes + chunk.byteLength > maxBytes) throw new SpeechClipTooLargeError(maxBytes);
    this.state = 'rendering';
    this.chunks.push(chunk.slice());
    this.bytes += chunk.byteLength;
    this.notify();
  }

  finish(): void {
    if (this.state === 'failed') return;
    this.state = this.bytes ? 'ready' : 'failed';
    if (!this.bytes) this.error = new Error('per-call clip rendered no audio');
    this.notify();
  }

  fail(error: unknown): void {
    if (this.state === 'ready' || this.state === 'failed') return;
    this.state = 'failed';
    this.error = error;
    this.notify();
  }

  /** Drops the audio: at session end, nothing of the call's data stays behind. */
  discard(): void {
    this.chunks = [];
    this.bytes = 0;
    this.state = 'failed';
    this.error = new DOMException('per-call clips discarded', 'AbortError');
    this.notify();
  }

  /** What has rendered so far, then the rest as it arrives; throws if the render fails. */
  async *stream(signal: AbortSignal): AsyncIterable<Uint8Array> {
    for (let index = 0; ;) {
      signal.throwIfAborted();
      if (index < this.chunks.length) {
        yield this.chunks[index++]!;
        continue;
      }
      if (this.state === 'ready') return;
      if (this.state === 'failed') throw this.error;
      await this.changed(signal);
    }
  }

  private changed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        this.wake.delete(done);
        signal.removeEventListener('abort', aborted);
        resolve();
      };
      const aborted = () => {
        this.wake.delete(done);
        reject(signal.reason);
      };
      this.wake.add(done);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  private notify(): void {
    for (const wake of [...this.wake]) wake();
  }
}

/** The provider a call's lines are rendered with: the session's own, or one composed early. */
export interface CallSpeech {
  tts: TextToSpeech;
  filters: readonly TextFilter[];
  language: string;
  voice?: string;
  sessionId: string;
  onUsage: UsageSink;
}

export interface CallClipOptions {
  maxClipBytes: number;
  /** A render that has not finished by then fails; playback falls back to live synthesis. */
  renderTimeoutMs: number;
  concurrency: number;
}

/**
 * One call's personal clips (TTS-10), keyed by the line as the behaviour speaks it. Lines are
 * reserved before their provider is ready, so playback can wait on a render already under way
 * instead of starting a second one. Discarded, audio and all, when the call ends.
 */
export class CallClips {
  private readonly slots = new Map<string, PerCallClip>();
  private readonly controller = new AbortController();

  constructor(
    readonly lines: readonly PerCallLine[],
    readonly format: AudioFormat,
    private readonly options: CallClipOptions,
  ) {}

  get discarded(): boolean {
    return this.controller.signal.aborted;
  }

  get(text: string): PerCallClip | undefined {
    return this.slots.get(text);
  }

  /** Claims the lines no render has claimed yet (those `which` selects); returns them. */
  reserve(which: (line: PerCallLine) => boolean = () => true): PerCallLine[] {
    if (this.discarded) return [];
    const claimed = this.lines.filter((line) => !this.slots.has(line.text) && which(line));
    for (const line of claimed) this.slots.set(line.text, new PerCallClip());
    return claimed;
  }

  /** Renders reserved lines a few at a time; a failed line plays live instead. Never throws. */
  async render(speech: CallSpeech, lines: readonly PerCallLine[]): Promise<void> {
    let next = 0;
    const one = async (line: PerCallLine) => {
      const clip = this.slots.get(line.text);
      if (!clip || this.discarded) return;
      try {
        const text = normalizeSpeechText(speech.filters, line.text, speech.language);
        if (!text.trim()) throw new Error('per-call line is empty after filtering');
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(this.options.renderTimeoutMs),
        ]);
        const audio = segmentAudio(speech.tts, {
          sessionId: speech.sessionId,
          text,
          format: this.format,
          language: speech.language,
          voice: speech.voice,
          signal,
          onUsage: speech.onUsage,
        });
        for await (const chunk of audio) clip.append(chunk, this.options.maxClipBytes);
        clip.finish();
      } catch (error) {
        clip.fail(error);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.options.concurrency, lines.length) }, async () => {
        while (next < lines.length) await one(lines[next++]!);
      }),
    );
  }

  /** Fails what is reserved and not rendered, e.g. when the early provider could not open. */
  abandon(lines: readonly PerCallLine[], error: unknown): void {
    for (const line of lines) this.slots.get(line.text)?.fail(error);
  }

  discard(): void {
    if (this.discarded) return;
    this.controller.abort(new DOMException('call ended', 'AbortError'));
    for (const clip of this.slots.values()) clip.discard();
    this.slots.clear();
  }
}

const TIMED_OUT = Symbol('timed out');

/**
 * Plays a per-call clip as it renders. When its first byte does not come within `budgetMs`, or its
 * render fails before then, the line is spoken live instead (`fellBack`); a clip that fails after
 * it started playing fails the segment, as a live render would.
 */
export async function* callClipAudio(
  clip: PerCallClip,
  signal: AbortSignal,
  budgetMs: number,
  live: () => AsyncIterable<Uint8Array>,
  fellBack: () => void,
): AsyncIterable<Uint8Array> {
  const iterator = clip.stream(signal)[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: IteratorResult<Uint8Array> | typeof TIMED_OUT;
  try {
    first = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
      }),
    ]);
  } catch (error) {
    if (signal.aborted) throw error;
    first = TIMED_OUT;
  } finally {
    clearTimeout(timer);
  }
  if (first === TIMED_OUT || first.done) {
    fellBack();
    yield* live();
    return;
  }
  yield first.value;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}
