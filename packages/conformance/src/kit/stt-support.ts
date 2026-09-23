// Session plumbing and invariant helpers for the STT kit.
import {
  type AudioFormat,
  type Clock,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetFixtureStep,
  type NetPort,
  type SpeechToText,
  type SttEvent,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet, type FixtureNet } from '@winsendotai/ovo-plugin-kit';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import { Failures, usageFailures } from './runner.ts';

import type { SttKitContext, SttKitOptions } from './stt.ts';

export interface Run {
  stt: SpeechToText;
  net: FixtureNet;
  events: SttEvent[];
  usage: UsageMeter[];
  format: AudioFormat;
  attempts: readonly string[];
}

export const SESSION = 'kit-session';

export function settings(stt: SpeechToText, options: SttKitOptions) {
  const format = options.format ?? stt.capabilities.inputFormats?.[0];
  const language = options.language ?? stt.capabilities.languages.find((l) => l !== '*') ?? 'en-US';
  return { format, language, utterance: options.utterance ?? 'please book a table for two' };
}

export function utteranceScripts(
  context: SttKitContext,
  format: AudioFormat,
  language: string,
  utterance: string,
) {
  const { template, scripts } = context.options;
  if (scripts?.utterance) return scripts.utterance;
  if (!template) return undefined;
  return template({ format, language, sessionId: SESSION, turns: [{ atMs: 0, say: utterance }] });
}

/** A provider failure: the first socket closes with 1011 right after the first audio frame. */
export function failureScripts(
  scripts: readonly NetFixtureScript[],
): NetFixtureScript[] | undefined {
  const index = scripts.findIndex((s) =>
    s.steps.some((step) => 'expect' in step && step.expect === 'ws-open'),
  );
  if (index < 0) return undefined;
  const script = scripts[index]!;
  const open = script.steps.findIndex((step) => 'expect' in step && step.expect === 'ws-open');
  const send = script.steps.findIndex(
    (step, i) => i > open && 'expect' in step && step.expect === 'ws-send',
  );
  const steps: NetFixtureStep[] = [
    ...script.steps.slice(0, (send < 0 ? open : send) + 1),
    { close: { code: 1011, reason: 'fixture failure' } },
  ];
  return [{ ...script, steps }];
}

export async function session(
  context: SttKitContext,
  scripts: readonly NetFixtureScript[],
  drive: (run: Run, s: Awaited<ReturnType<SpeechToText['start']>>) => Promise<void>,
): Promise<Run> {
  const clock = acceleratedClock(0);
  const net = createFixtureNet(scripts, { clock });
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  let run!: Run;
  const attempts = await withEgressSentinel(async (sentinel) => {
    const stt = await context.factory({ net, clock });
    const { format } = settings(stt, context.options);
    if (!format) throw new Error('capabilities.inputFormats is empty');
    run = { stt, net, events, usage, format, attempts: sentinel.attempts };
    const started = await stt.start({
      sessionId: SESSION,
      format,
      language: settings(stt, context.options).language,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onUsage: (meter) => usage.push(meter),
    });
    await drive(run, started);
    return sentinel.attempts;
  });
  return { ...run, attempts };
}

export function writeSize(stt: SpeechToText, options: SttKitOptions): number {
  return options.writeMs ?? stt.capabilities.frameMs?.preferred ?? 20;
}

export function usageChecks(f: Failures, usage: readonly UsageMeter[], when: string): void {
  f.add(...usageFailures(usage, when, 'stt'));
}

export function transcriptChecks(f: Failures, events: readonly SttEvent[]): void {
  let last = 0;
  const locked = new Set<string>();
  for (const event of events) {
    if (event.type !== 'transcript') continue;
    const { segment } = event;
    f.expect(segment.revision > last, `revision ${segment.revision} is not above ${last}`);
    last = segment.revision;
    f.expect(
      !locked.has(segment.segmentId),
      `segment ${segment.segmentId} changed after its final`,
    );
    if (segment.stability === 'final') locked.add(segment.segmentId);
  }
}

export function finalText(events: readonly SttEvent[]): string {
  const finals = new Map<string, string>();
  for (const event of events)
    if (event.type === 'transcript' && event.segment.stability === 'final')
      finals.set(event.segment.segmentId, event.segment.text);
  return [...finals.values()].join(' ');
}

export async function rejects(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}
