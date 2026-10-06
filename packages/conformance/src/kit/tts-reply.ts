// Reply-context and warm-up invariants (LAT-5, Wave 2 request #2): `openReply` renders every
// segment of one reply in one provider context and yields each segment's audio on its own, in
// order; `warm` connects ahead of the first utterance and never rejects.
import type { AudioFormat, TextToSpeech, UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import { Failures, type KitCheck } from './runner.ts';
import type { TtsKitContext } from './tts.ts';
import { formatFailures, label, probe } from './tts-support.ts';

const SEGMENTS = ['Your table for two is booked for seven tonight.', 'We will send a reminder.'];
const DEADLINE_MS = 1000;

function input(context: TtsKitContext, format: AudioFormat, usage: UsageMeter[]) {
  return {
    sessionId: 'kit-session',
    format,
    language: context.options.language ?? 'en-US',
    ...(context.options.voice ? { voice: context.options.voice } : {}),
    signal: new AbortController().signal,
    onUsage: (meter: UsageMeter) => usage.push(meter),
  };
}

const live = () => new AbortController().signal;

/** Each requestId is metered at most once; a reply that spoke is metered at all. */
function meterFailures(f: Failures, usage: readonly UsageMeter[], where: string): void {
  const ids = usage.map((meter) => meter.requestId);
  f.expect(usage.length > 0, `${where}: a reply that spoke emitted no usage`);
  f.expect(new Set(ids).size === ids.length, `${where}: a requestId was metered twice: ${ids}`);
}

async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle`)), DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const TTS_REPLY_CHECKS: readonly KitCheck<TtsKitContext>[] = [
  {
    name: 'reply: each segment yields its own native audio, and close meters once',
    async run(context) {
      const f = new Failures();
      const probed = await probe(context);
      const scripts = context.options.replyScripts;
      if (!probed.openReply) return [];
      if (!scripts) return ['openReply is implemented but the kit got no replyScripts'];
      for (const format of probed.capabilities.outputFormats ?? []) {
        const where = `reply ${label(format)}`;
        const clock = acceleratedClock(0);
        const net = createFixtureNet(scripts(SEGMENTS, format), { clock });
        const usage: UsageMeter[] = [];
        const heard: Uint8Array[][] = [];
        const attempts = await withEgressSentinel(async (sentinel) => {
          const tts = await context.factory({ net, clock });
          try {
            const reply = await tts.openReply!(input(context, format, usage));
            const audio = SEGMENTS.map((text) => reply.segment(text, live()));
            for (const segment of audio) {
              const chunks: Uint8Array[] = [];
              for await (const chunk of segment) chunks.push(chunk);
              heard.push(chunks);
            }
            await reply.close();
            await reply.close();
          } catch (error) {
            f.add(`${where}: ${String(error)}`);
          }
          return sentinel.attempts;
        });
        f.expect(heard.length === SEGMENTS.length, `${where}: ${heard.length} segments played`);
        for (const chunks of heard) formatFailures(f, [{ format, chunks }]);
        meterFailures(f, usage, where);
        f.expect(attempts.length === 0, `${where}: network bypassed the NetPort`);
        f.add(...net.mismatches.map((error) => `${where}: ${error.message}`));
        f.add(...net.pending().map((p) => `${where}: unconsumed ${p.description}`));
      }
      return f.messages;
    },
  },
  {
    name: 'reply: closing mid-reply (barge-in) ends every unfinished segment within 1 s',
    async run(context) {
      const f = new Failures();
      const probed = await probe(context);
      const scripts = context.options.replyScripts;
      if (!probed.openReply || !scripts) return [];
      const format = probed.capabilities.outputFormats![0]!;
      const clock = acceleratedClock(0);
      const net = createFixtureNet(scripts(SEGMENTS, format), { clock });
      const usage: UsageMeter[] = [];
      try {
        const tts = await context.factory({ net, clock });
        const reply = await tts.openReply!(input(context, format, usage));
        const [first, second] = SEGMENTS.map((text) => reply.segment(text, live()));
        const iterator = first![Symbol.asyncIterator]();
        f.expect(!(await iterator.next()).done, 'no audio arrived before the barge-in');
        await reply.close();
        await withTimeout(
          (async () => {
            for (let next = await iterator.next(); !next.done; next = await iterator.next());
            for await (const chunk of second!) void chunk;
          })(),
          'a segment of a closed reply',
        );
      } catch (error) {
        f.add(`barge-in: ${String(error)}`);
      }
      const ids = usage.map((meter) => meter.requestId);
      f.expect(new Set(ids).size === ids.length, `barge-in: a requestId was metered twice: ${ids}`);
      return f.messages;
    },
  },
  {
    name: 'warm: resolves, never rejects, when the provider cannot be reached',
    async run(context) {
      const probed = await probe(context);
      if (!probed.warm) return [];
      const f = new Failures();
      for (const format of probed.capabilities.outputFormats ?? []) {
        // An empty fixture network refuses every connection.
        const tts: TextToSpeech = await context.factory({
          net: createFixtureNet([]),
          clock: acceleratedClock(0),
        });
        try {
          await withTimeout(tts.warm!({ format }), 'warm');
        } catch (error) {
          f.add(`warm ${label(format)}: ${String(error)}`);
        }
      }
      return f.messages;
    },
  },
];
