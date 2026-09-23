import {
  MULAW_8K,
  PCM16_16K,
  PCM16_24K,
  PCM16_8K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetPort,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import { Failures, usageFailures, type KitCheck } from './runner.ts';

export type TtsFactory = (env: {
  net: NetPort;
  clock: Clock;
}) => TextToSpeech | Promise<TextToSpeech>;

export interface TtsKitOptions {
  template?: FixtureTemplate;
  /** Scripts for one synthesis when there is no template. */
  scripts?: (text: string, format: AudioFormat) => NetFixtureScript[];
  text?: string;
  voice?: string;
  language?: string;
}

export interface TtsKitContext {
  factory: TtsFactory;
  options: TtsKitOptions;
}

const CANDIDATES: readonly AudioFormat[] = [
  MULAW_8K,
  { encoding: 'alaw', sampleRate: 8000, channels: 1 },
  PCM16_8K,
  PCM16_16K,
  PCM16_24K,
];

function scriptsFor(context: TtsKitContext, text: string, format: AudioFormat) {
  if (context.options.scripts) return context.options.scripts(text, format);
  return context.options.template?.({
    format,
    language: context.options.language ?? 'en-US',
    sessionId: 'kit-session',
    turns: [],
    agentTexts: [text],
  });
}

async function synthesize(
  context: TtsKitContext,
  format: AudioFormat,
  text: string,
  consume: (chunk: Uint8Array, index: number, abort: AbortController) => void = () => undefined,
) {
  const scripts = scriptsFor(context, text, format);
  if (!scripts) throw new Error('no fixture template or scripts were supplied');
  const clock = acceleratedClock(0);
  const net = createFixtureNet(scripts, { clock });
  const usage: UsageMeter[] = [];
  const chunks: Uint8Array[] = [];
  const abort = new AbortController();
  let error: unknown;
  let chunksAfterAbort = 0;
  let endedMs = 0;
  const attempts = await withEgressSentinel(async (sentinel) => {
    const tts = await context.factory({ net, clock });
    let abortedAt = 0;
    try {
      for await (const chunk of tts.synthesize({
        sessionId: 'kit-session',
        text,
        format,
        language: context.options.language ?? 'en-US',
        ...(context.options.voice ? { voice: context.options.voice } : {}),
        signal: abort.signal,
        onUsage: (meter) => usage.push(meter),
      })) {
        if (abort.signal.aborted) chunksAfterAbort += 1;
        chunks.push(chunk);
        consume(chunk, chunks.length - 1, abort);
        if (abort.signal.aborted && !abortedAt) abortedAt = Date.now();
      }
    } catch (caught) {
      error = caught;
    }
    endedMs = abortedAt ? Date.now() - abortedAt : 0;
    return sentinel.attempts;
  });
  return { net, usage, chunks, error, attempts, chunksAfterAbort, endedMs };
}

function usageOnce(f: Failures, usage: readonly UsageMeter[], when: string): void {
  f.add(...usageFailures(usage, when));
}

const probe = (context: TtsKitContext) =>
  context.factory({ net: createFixtureNet([]), clock: acceleratedClock(0) });

export const TTS_CHECKS: readonly KitCheck<TtsKitContext>[] = [
  {
    name: 'templates render audio in every requested native format',
    async run(context) {
      const f = new Failures();
      const tts = await probe(context);
      const formats = tts.capabilities.outputFormats ?? [];
      f.expect(formats.length, 'outputFormats must list the native formats');
      const text = context.options.text ?? 'Your table for two is booked for seven tonight.';
      for (const format of formats) {
        const label = `${format.encoding}@${format.sampleRate}`;
        const run = await synthesize(context, format, text);
        if (run.error) f.add(`${label}: synthesis failed: ${String(run.error)}`);
        const bytes = run.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        f.expect(bytes > 0, `${label}: no audio`);
        if (format.encoding === 'pcm_s16le')
          f.expect(bytes % 2 === 0, `${label}: odd PCM16 byte count`);
        usageOnce(f, run.usage, label);
        f.expect(run.attempts.length === 0, `${label}: network bypassed the NetPort`);
        f.add(...run.net.mismatches.map((error) => `${label}: ${error.message}`));
        f.add(...run.net.pending().map((p) => `${label}: unconsumed ${p.description}`));
      }
      return f.messages;
    },
  },
  {
    name: 'a non-native format is refused (plugins never resample)',
    async run(context) {
      const tts = await probe(context);
      const native = tts.capabilities.outputFormats ?? [];
      const other = CANDIDATES.find((c) => !native.some((n) => sameFormat(n, c)));
      if (!other) return [];
      try {
        const iterator = tts
          .synthesize({
            sessionId: 'kit-session',
            text: 'hello',
            format: other,
            language: 'en-US',
            signal: new AbortController().signal,
            onUsage: () => undefined,
          })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        return first.done ? [] : [`${other.encoding}@${other.sampleRate} produced audio`];
      } catch {
        return [];
      }
    },
  },
  {
    name: 'abort stops a stream mid-way and usage is still emitted once',
    async run(context) {
      const f = new Failures();
      const tts = await probe(context);
      const format = tts.capabilities.outputFormats?.[0];
      if (!format) return ['outputFormats is empty'];
      const text =
        context.options.text ?? 'This sentence is long enough to arrive in several chunks.';
      const run = await synthesize(context, format, text, (_chunk, index, abort) => {
        if (index === 0) abort.abort(new DOMException('kit abort', 'AbortError'));
      });
      f.expect(run.chunks.length >= 1, 'no audio arrived before the abort');
      f.expect(run.chunksAfterAbort <= 1, `${run.chunksAfterAbort} chunks arrived after abort`);
      f.expect(run.endedMs <= 1000, `the stream took ${run.endedMs} ms to end after abort`);
      usageOnce(f, run.usage, 'abort');
      return f.messages;
    },
  },
  {
    name: 'cacheIdentity is stable and complete',
    async run(context) {
      const f = new Failures();
      const tts = await probe(context);
      for (const format of tts.capabilities.outputFormats ?? []) {
        const first = tts.cacheIdentity(format, context.options.voice);
        const second = tts.cacheIdentity(format, context.options.voice);
        f.expect(
          JSON.stringify(first) === JSON.stringify(second),
          'cacheIdentity changed between calls',
        );
        for (const key of ['provider', 'model', 'voice', 'revision'] as const)
          f.expect(
            typeof first[key] === 'string' && first[key].length > 0,
            `cacheIdentity.${key} is empty`,
          );
      }
      return f.messages;
    },
  },
];
