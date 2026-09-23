import {
  normalizeForMatch,
  type AudioFormat,
  type Clock,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetPort,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { msForBytes } from '@winsendotai/ovo-audio';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { framesOf, speechBytes } from '../drivers/audio-gen.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import { Failures, sleep, type KitCheck } from './runner.ts';

export type SttFactory = (env: {
  net: NetPort;
  clock: Clock;
}) => SpeechToText | Promise<SpeechToText>;

export interface SttKitOptions {
  /** The plugin's fixture template; the kit renders a scripted utterance through it. */
  template?: FixtureTemplate;
  /** Explicit scripts when there is no template (`failure` defaults to a truncated utterance). */
  scripts?: { utterance?: NetFixtureScript[]; failure?: NetFixtureScript[] };
  format?: AudioFormat;
  language?: string;
  utterance?: string;
  /** Size of each `write`, default `frameMs.preferred` or 20 ms. */
  writeMs?: number;
  /** Audio written for the utterance, default 1200 ms. */
  audioMs?: number;
}

export interface SttKitContext {
  factory: SttFactory;
  options: SttKitOptions;
}

import {
  failureScripts,
  finalText,
  rejects,
  session,
  settings,
  transcriptChecks,
  usageChecks,
  utteranceScripts,
  writeSize,
} from './stt-support.ts';

export { failureScripts } from './stt-support.ts';

export const STT_CHECKS: readonly KitCheck<SttKitContext>[] = [
  {
    name: 'capabilities are coherent',
    async run(context) {
      const f = new Failures();
      const stt = await context.factory({ net: createFixtureNet([]), clock: acceleratedClock(0) });
      const caps = stt.capabilities;
      f.expect(caps.inputFormats?.length, 'inputFormats must list the native formats');
      f.expect(caps.languages.length, 'languages must not be empty');
      if (caps.frameMs)
        f.expect(
          caps.frameMs.min <= caps.frameMs.preferred && caps.frameMs.preferred <= caps.frameMs.max,
          'frameMs must satisfy min ≤ preferred ≤ max',
        );
      return f.messages;
    },
  },
  {
    name: 'a scripted utterance yields monotonic revisions, locked finals and matching final text',
    async run(context) {
      const f = new Failures();
      const probe = await context.factory({
        net: createFixtureNet([]),
        clock: acceleratedClock(0),
      });
      const { format, language, utterance } = settings(probe, context.options);
      if (!format) return ['capabilities.inputFormats is empty'];
      const scripts = utteranceScripts(context, format, language, utterance);
      if (!scripts) return ['no fixture template or utterance scripts were supplied'];
      let lateWriteRejected = false;
      const run = await session(context, scripts, async (r, s) => {
        const audio = speechBytes(format, context.options.audioMs ?? 1200);
        for (const frame of framesOf(audio, format, writeSize(r.stt, context.options)))
          await s.write(frame);
        await s.finish();
        lateWriteRejected = await rejects(s.write(new Uint8Array(framesOf(audio, format, 20)[0]!)));
      });
      transcriptChecks(f, run.events);
      f.expect(
        normalizeForMatch(finalText(run.events)) === normalizeForMatch(utterance),
        `final text "${finalText(run.events)}" does not match "${utterance}"`,
      );
      usageChecks(f, run.usage, 'finish');
      f.expect(lateWriteRejected, 'write after finish must reject');
      f.expect(
        run.attempts.length === 0,
        `network bypassed the NetPort: ${run.attempts.join(', ')}`,
      );
      f.expect(run.net.log.length > 0, 'the plugin never used the injected NetPort');
      f.add(...run.net.mismatches.map((error) => error.message));
      f.add(...run.net.pending().map((step) => `unconsumed ${step.description}`));
      const frameMs = run.stt.capabilities.frameMs;
      if (frameMs) {
        const sent = run.net.log.filter((e) => e.kind === 'ws-out' && typeof e.data !== 'string');
        sent.forEach((entry, i) => {
          const ms = msForBytes(run.format, (entry.data as Uint8Array).byteLength);
          f.expect(ms <= frameMs.max + 0.5, `frame ${i} is ${ms.toFixed(1)} ms, above frameMs.max`);
          if (i < sent.length - 1)
            f.expect(
              ms >= frameMs.min - 0.5,
              `frame ${i} is ${ms.toFixed(1)} ms, below frameMs.min`,
            );
        });
      }
      return f.messages;
    },
  },
  {
    name: 'cancel closes within 1 s and emits usage exactly once',
    async run(context) {
      const f = new Failures();
      const probe = await context.factory({
        net: createFixtureNet([]),
        clock: acceleratedClock(0),
      });
      const { format, language, utterance } = settings(probe, context.options);
      if (!format) return ['capabilities.inputFormats is empty'];
      const scripts = utteranceScripts(context, format, language, utterance);
      if (!scripts) return ['no fixture template or utterance scripts were supplied'];
      let elapsed = 0;
      let lateWriteRejected = false;
      const run = await session(context, scripts, async (r, s) => {
        for (const frame of framesOf(
          speechBytes(format, 300),
          format,
          writeSize(r.stt, context.options),
        ))
          await s.write(frame);
        const started = Date.now();
        await s.cancel('kit cancel');
        elapsed = Date.now() - started;
        await s.cancel('kit cancel again');
        await s.finish().catch(() => undefined);
        lateWriteRejected = await rejects(s.write(new Uint8Array(160)));
      });
      f.expect(elapsed <= 1000, `cancel took ${elapsed} ms`);
      usageChecks(f, run.usage, 'cancel');
      f.expect(lateWriteRejected, 'write after cancel must reject');
      f.expect(
        run.attempts.length === 0,
        `network bypassed the NetPort: ${run.attempts.join(', ')}`,
      );
      f.add(...run.net.mismatches.map((error) => error.message));
      return f.messages;
    },
  },
  {
    name: 'a provider failure emits usage exactly once and rejects later writes',
    async run(context) {
      const f = new Failures();
      const probe = await context.factory({
        net: createFixtureNet([]),
        clock: acceleratedClock(0),
      });
      const { format, language, utterance } = settings(probe, context.options);
      if (!format) return ['capabilities.inputFormats is empty'];
      const base = utteranceScripts(context, format, language, utterance);
      const scripts = context.options.scripts?.failure ?? (base ? failureScripts(base) : undefined);
      if (!scripts) return [];
      let rejected = false;
      const run = await session(context, scripts, async (r, s) => {
        for (const frame of framesOf(
          speechBytes(format, 600),
          format,
          writeSize(r.stt, context.options),
        )) {
          if (await rejects(s.write(frame))) break;
          await sleep(1);
        }
        await sleep(50);
        rejected = await rejects(s.write(new Uint8Array(160)));
        await s.cancel('after failure').catch(() => undefined);
      });
      usageChecks(f, run.usage, 'failure');
      f.expect(rejected, 'write after a provider failure must reject');
      f.add(...run.net.mismatches.map((error) => error.message));
      f.add(...run.net.pending().map((step) => `unconsumed ${step.description}`));
      return f.messages;
    },
  },
];
