import {
  MULAW_8K,
  type AudioFormat,
  type NetFixtureScript,
  type NetFixtureStep,
  type SynthesisInput,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { HTTP_SOURCE, RETRIEVED, WS_SOURCE } from '../src/testing.ts';

export function ttsInput(
  usage: UsageMeter[] = [],
  overrides: Partial<SynthesisInput> = {},
): Omit<SynthesisInput, 'text'> & { text: string } {
  return {
    sessionId: 'call-1',
    text: 'Namaste, this is Monika.',
    format: MULAW_8K,
    language: 'en-IN',
    signal: new AbortController().signal,
    onUsage: (meter) => usage.push(meter),
    ...overrides,
  };
}

export function wsScript(steps: NetFixtureStep[]): NetFixtureScript {
  return { host: 'api.elevenlabs.io', source: WS_SOURCE, retrieved: RETRIEVED, steps };
}

export function httpScript(steps: NetFixtureStep[]): NetFixtureScript {
  return { host: 'api.elevenlabs.io', source: HTTP_SOURCE, retrieved: RETRIEVED, steps };
}

export const audioFrame = (contextId: string, bytes: number[]) =>
  JSON.stringify({ audio: Buffer.from(bytes).toString('base64'), contextId });

export const fill = (length: number, value: number) => Array<number>(length).fill(value);

/** An audio frame whose alignment names `chars`, starting at the given ms from the frame start. */
export const aligned = (contextId: string, bytes: number[], chars: string, startsMs: number[]) =>
  JSON.stringify({
    audio: Buffer.from(bytes).toString('base64'),
    contextId,
    alignment: { chars: [...chars], charStartTimesMs: startsMs, charDurationsMs: startsMs },
  });

export const finalFrame = (contextId: string) => JSON.stringify({ isFinal: true, contextId });

/** A client frame for `contextId` that carries `extra` (subset match). */
export const sent = (
  contextId: string,
  extra: Record<string, unknown> = {},
  repeat = false,
): NetFixtureStep => ({
  expect: 'ws-send',
  match: 'json',
  where: { context_id: contextId, ...extra },
  ...(repeat ? { repeat: 'until-next' as const } : {}),
});

/** A whole context: one text frame, flush, close_context, then the given server frames. */
export function utterance(contextId: string, text: string, server: string[]): NetFixtureStep[] {
  return [
    sent(contextId, { text }),
    sent(contextId, { text: '', flush: true }),
    sent(contextId, { close_context: true }),
    ...server.map((send) => ({ send })),
  ];
}

export async function drain(audio: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of audio) out.push(...chunk);
  return out;
}

export function streamStep(
  reply: { status: number; headers?: Record<string, string>; body?: string; chunks?: string[] },
  format: AudioFormat = MULAW_8K,
  where?: Record<string, unknown>,
): NetFixtureStep {
  const encoding = format.encoding === 'mulaw' ? 'ulaw_8000' : `pcm_${format.sampleRate}`;
  return {
    expect: 'http',
    method: 'POST',
    url: new RegExp(
      `^https://api\\.elevenlabs\\.io/v1/text-to-speech/[^/?]+/stream\\?output_format=${encoding}`,
    ),
    headers: { 'xi-api-key': 'fixture-key' },
    body: 'json',
    ...(where ? { where } : {}),
    reply: {
      status: reply.status,
      ...(reply.headers ? { headers: reply.headers } : {}),
      ...(reply.body !== undefined ? { body: reply.body } : {}),
      ...(reply.chunks ? { chunks: reply.chunks.map((base64) => ({ base64 })) } : {}),
    },
  } as NetFixtureStep;
}
