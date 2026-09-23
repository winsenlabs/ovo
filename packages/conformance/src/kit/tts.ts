import {
  sameFormat,
  type AudioFormat,
  type Clock,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetPort,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { Failures, type KitCheck } from './runner.ts';
import {
  CANDIDATES,
  formatFailures,
  identityFailures,
  label,
  probe,
  synthesize,
  usageOnce,
} from './tts-support.ts';

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

export { formatFailures, identityFailures, synthesize } from './tts-support.ts';

export const TTS_CHECKS: readonly KitCheck<TtsKitContext>[] = [
  {
    name: 'templates render audio in every requested native format',
    async run(context) {
      const f = new Failures();
      const tts = await probe(context);
      const formats = tts.capabilities.outputFormats ?? [];
      f.expect(formats.length, 'outputFormats must list the native formats');
      const text = context.options.text ?? 'Your table for two is booked for seven tonight.';
      const rendered: { format: AudioFormat; chunks: readonly Uint8Array[] }[] = [];
      for (const format of formats) {
        const where = label(format);
        const run = await synthesize(context, format, text);
        if (run.error) f.add(`${where}: synthesis failed: ${String(run.error)}`);
        rendered.push({ format, chunks: run.chunks });
        usageOnce(f, run.usage, where);
        f.expect(run.attempts.length === 0, `${where}: network bypassed the NetPort`);
        f.add(...run.net.mismatches.map((error) => `${where}: ${error.message}`));
        f.add(...run.net.pending().map((p) => `${where}: unconsumed ${p.description}`));
      }
      formatFailures(f, rendered);
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
        return first.done ? [] : [`${label(other)} produced audio`];
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
    name: 'cacheIdentity is stable, complete and discriminating',
    async run(context) {
      const f = new Failures();
      identityFailures(f, await probe(context), context.options.voice);
      return f.messages;
    },
  },
];
