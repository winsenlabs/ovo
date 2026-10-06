// Incremental-TTS invariants (TTS-12): open → push → flush → audio → close, as the speech output
// drives it, plus the cache-identity rule for binding fields that change the audio (TTS-13).
import type {
  AudioFormat,
  IncrementalTts,
  NetFixtureScript,
  TextToSpeech,
  UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet, type FixtureNet } from '@winsendotai/ovo-plugin-kit';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import { Failures, type KitCheck } from './runner.ts';
import type { TtsKitContext } from './tts.ts';
import { formatFailures, label, probe, usageOnce } from './tts-support.ts';

const TEXTS = [
  'Your table for two is booked for seven tonight.',
  'We will send a reminder an hour before.',
];
const ABORT_DEADLINE_MS = 1000;

/** Cuts `text` into `count` non-empty pieces on code-point boundaries. */
export function splitText(text: string, count: number): string[] {
  const points = [...text];
  const size = Math.ceil(points.length / Math.max(1, count));
  const out: string[] = [];
  for (let at = 0; at < points.length; at += size) out.push(points.slice(at, at + size).join(''));
  return out;
}

function scriptsForTexts(context: TtsKitContext, texts: readonly string[], format: AudioFormat) {
  if (context.options.scripts)
    return texts.flatMap((text) => context.options.scripts!(text, format));
  return context.options.template?.({
    format,
    language: context.options.language ?? 'en-US',
    sessionId: 'kit-session',
    turns: [],
    agentTexts: texts,
  });
}

interface Utterance {
  chunks: Uint8Array[];
  usage: UsageMeter[];
  error?: unknown;
  closeError?: unknown;
  chunksAfterAbort: number;
  endedMs: number;
}

type Driver = (tts: TextToSpeech, net: FixtureNet) => Promise<Utterance[]>;

async function withPlugin(
  context: TtsKitContext,
  scripts: NetFixtureScript[] | undefined,
  drive: Driver,
) {
  if (!scripts) throw new Error('no fixture template or scripts were supplied');
  const clock = acceleratedClock(0);
  const net = createFixtureNet(scripts, { clock });
  let utterances: Utterance[] = [];
  const attempts = await withEgressSentinel(async (sentinel) => {
    utterances = await drive(await context.factory({ net, clock }), net);
    return sentinel.attempts;
  });
  return { net, utterances, attempts };
}

/** One utterance through `open`: split pushes, flush, drain, then close twice (idempotency). */
async function speak(
  context: TtsKitContext,
  tts: TextToSpeech,
  format: AudioFormat,
  text: string,
  abortAfterFirst = false,
): Promise<Utterance> {
  const run: Utterance = { chunks: [], usage: [], chunksAfterAbort: 0, endedMs: 0 };
  const abort = new AbortController();
  let session: IncrementalTts | undefined;
  let abortedAt = 0;
  try {
    session = await tts.open!({
      sessionId: 'kit-session',
      format,
      language: context.options.language ?? 'en-US',
      ...(context.options.voice ? { voice: context.options.voice } : {}),
      signal: abort.signal,
      onUsage: (meter) => run.usage.push(meter),
    });
    for (const piece of splitText(text, context.options.incrementalPushes ?? 1))
      session.push(piece);
    session.flush();
    for await (const chunk of session.audio) {
      if (abort.signal.aborted) run.chunksAfterAbort += 1;
      run.chunks.push(chunk);
      if (abortAfterFirst && !abortedAt) {
        abort.abort(new DOMException('kit abort', 'AbortError'));
        abortedAt = Date.now();
      }
    }
  } catch (error) {
    run.error = error;
  }
  run.endedMs = abortedAt ? Date.now() - abortedAt : 0;
  try {
    await session?.close();
    await session?.close();
  } catch (error) {
    run.closeError = error;
  }
  return run;
}

const incremental = (tts: TextToSpeech) => Boolean(tts.capabilities.incrementalText && tts.open);

function netFailures(f: Failures, net: FixtureNet, attempts: readonly string[], where: string) {
  f.expect(attempts.length === 0, `${where}: network bypassed the NetPort`);
  f.add(...net.mismatches.map((error) => `${where}: ${error.message}`));
  f.add(...net.pending().map((p) => `${where}: unconsumed ${p.description}`));
}

export const TTS_INCREMENTAL_CHECKS: readonly KitCheck<TtsKitContext>[] = [
  {
    name: 'incremental: open → push → flush streams native audio and meters once on close',
    async run(context) {
      const f = new Failures();
      const tts = await probe(context);
      if (tts.capabilities.incrementalText && !tts.open)
        return ['capabilities.incrementalText is true but the plugin has no open()'];
      if (!incremental(tts)) return [];
      for (const format of tts.capabilities.outputFormats ?? []) {
        const where = `incremental ${label(format)}`;
        const { net, utterances, attempts } = await withPlugin(
          context,
          scriptsForTexts(context, [TEXTS[0]!], format),
          async (plugin) => [await speak(context, plugin, format, TEXTS[0]!)],
        );
        const [run] = utterances;
        if (run!.error) f.add(`${where}: ${String(run!.error)}`);
        if (run!.closeError) f.add(`${where}: close() threw: ${String(run!.closeError)}`);
        formatFailures(f, [{ format, chunks: run!.chunks }]);
        usageOnce(f, run!.usage, `${where} (close called twice)`);
        netFailures(f, net, attempts, where);
      }
      return f.messages;
    },
  },
  {
    name: 'incremental: two sequential open() calls on one instance both stream',
    async run(context) {
      const f = new Failures();
      const probed = await probe(context);
      if (!incremental(probed)) return [];
      const format = probed.capabilities.outputFormats![0]!;
      const { net, utterances, attempts } = await withPlugin(
        context,
        scriptsForTexts(context, TEXTS, format),
        async (plugin) => [
          await speak(context, plugin, format, TEXTS[0]!),
          await speak(context, plugin, format, TEXTS[1]!),
        ],
      );
      utterances.forEach((run, index) => {
        const where = `utterance ${index + 1}`;
        if (run.error) f.add(`${where}: ${String(run.error)}`);
        f.expect(run.chunks.length > 0, `${where}: no audio`);
        usageOnce(f, run.usage, where);
      });
      // The worker's usage idempotency key includes the requestId, so a shared id drops the
      // second utterance's meter. Opt-in until every incremental plugin's fixtures carry
      // per-request ids (Sarvam's fixture replays one id).
      const ids = utterances.flatMap((run) => run.usage.map((meter) => meter.requestId));
      if (context.options.distinctRequestIds)
        f.expect(new Set(ids).size === ids.length, `utterances share a usage requestId: ${ids}`);
      netFailures(f, net, attempts, 'sequential');
      return f.messages;
    },
  },
  {
    name: 'incremental: abort stops the audio within 1 s and meters once',
    async run(context) {
      const f = new Failures();
      const probed = await probe(context);
      if (!incremental(probed)) return [];
      const format = probed.capabilities.outputFormats![0]!;
      const { utterances, attempts } = await withPlugin(
        context,
        scriptsForTexts(context, [TEXTS[0]!], format),
        async (plugin) => [await speak(context, plugin, format, TEXTS[0]!, true)],
      );
      const [run] = utterances;
      f.expect(run!.chunks.length >= 1, 'no audio arrived before the abort');
      f.expect(run!.chunksAfterAbort <= 1, `${run!.chunksAfterAbort} chunks arrived after abort`);
      f.expect(
        run!.endedMs <= ABORT_DEADLINE_MS,
        `the audio took ${run!.endedMs} ms to end after abort`,
      );
      f.expect(attempts.length === 0, 'abort: network bypassed the NetPort');
      usageOnce(f, run!.usage, 'incremental abort');
      return f.messages;
    },
  },
  {
    name: 'incremental: close after a provider error resolves and meters once',
    async run(context) {
      const f = new Failures();
      const probed = await probe(context);
      const failing = context.options.incrementalFailure;
      if (!incremental(probed) || !failing) return [];
      const format = probed.capabilities.outputFormats![0]!;
      const { utterances } = await withPlugin(context, failing(format), async (plugin) => [
        await speak(context, plugin, format, TEXTS[0]!),
      ]);
      const [run] = utterances;
      f.expect(run!.error !== undefined, 'the scripted provider failure was not surfaced');
      f.expect(
        run!.closeError === undefined,
        `close() threw after a provider error: ${String(run!.closeError)}`,
      );
      usageOnce(f, run!.usage, 'close after error');
      return f.messages;
    },
  },
  {
    name: 'cacheIdentity changes with every audio-affecting binding field',
    async run(context) {
      const f = new Failures();
      const variants = context.options.identityVariants ?? [];
      if (!variants.length) return [];
      const base = await probe(context);
      const voice = context.options.voice;
      for (const format of base.capabilities.outputFormats ?? []) {
        const reference = JSON.stringify(base.cacheIdentity(format, voice));
        for (const variant of variants) {
          const other = await variant.factory({
            net: createFixtureNet([]),
            clock: acceleratedClock(0),
          });
          f.expect(
            JSON.stringify(other.cacheIdentity(format, voice)) !== reference,
            `${label(format)}: changing ${variant.name} keeps the same cacheIdentity, so cached clips would play the old voice`,
          );
        }
      }
      return f.messages;
    },
  },
];
