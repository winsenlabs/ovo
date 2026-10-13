import {
  MULAW_8K,
  type AudioFormat,
  type NetFixtureScript,
  type NetFixtureStep,
  type SynthesisInput,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { RETRIEVED, WS_SOURCE, chunkEvent, sent } from '../src/testing.ts';

export const VOICE = 'f91ab3e6-5071-4e15-b016-cde6f2bcd222';

export function input(
  usage: UsageMeter[] = [],
  overrides: Partial<SynthesisInput> = {},
): Omit<SynthesisInput, 'text'> {
  return {
    sessionId: 'call-1',
    format: MULAW_8K,
    language: 'en-IN',
    signal: new AbortController().signal,
    onUsage: (meter) => usage.push(meter),
    ...overrides,
  };
}

export function wsScript(steps: NetFixtureStep[]): NetFixtureScript {
  return { host: 'api.cartesia.ai', source: WS_SOURCE, retrieved: RETRIEVED, steps };
}

/** A chunk of `bytes` (plain numbers) on `contextId`. */
export const chunk = (contextId: string, bytes: number[]) =>
  chunkEvent(contextId, Uint8Array.from(bytes));

/** The frames of one whole utterance spoken in one push: text, end of input. */
export function said(contextId: string, text: string, format: AudioFormat = MULAW_8K) {
  return [
    sent(contextId, format, { transcript: text, continue: true }),
    sent(contextId, format, { transcript: '', continue: false }),
  ];
}

export async function drain(audio: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const piece of audio) out.push(...piece);
  return out;
}

/** Lets fixture microtasks and settled promises run. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((done) => setImmediate(done));
}
