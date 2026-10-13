import {
  MULAW_8K,
  type Logger,
  type NetFixtureScript,
  type NetFixtureStep,
  type SynthesisInput,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { RUMIK_HOST } from '../src/binding.ts';
import { RETRIEVED, STREAMING_SOURCE, SYNTHESIS_SOURCE } from '../src/testing.ts';

export function ttsInput(
  usage: UsageMeter[] = [],
  overrides: Partial<SynthesisInput> = {},
): SynthesisInput {
  return {
    sessionId: 'call-1',
    text: 'Namaste, main Ira bol rahi hoon.',
    format: MULAW_8K,
    language: 'hi-IN',
    signal: new AbortController().signal,
    onUsage: (meter) => usage.push(meter),
    ...overrides,
  };
}

export function script(steps: NetFixtureStep[], source = STREAMING_SOURCE): NetFixtureScript {
  return { host: RUMIK_HOST, source, retrieved: RETRIEVED, steps };
}

export const httpScript = (steps: NetFixtureStep[]) => script(steps, SYNTHESIS_SOURCE);

export const binary = (bytes: number[]): NetFixtureStep => ({
  send: { base64: Buffer.from(bytes).toString('base64') },
});

export const frame = (value: Record<string, unknown>): NetFixtureStep => ({
  send: JSON.stringify(value),
});

/** A client text frame matching `where` (subset). */
export const sent = (where: Record<string, unknown>): NetFixtureStep => ({
  expect: 'ws-send',
  match: 'json',
  where,
});

export const fill = (length: number, value: number) => Array<number>(length).fill(value);

export async function drain(audio: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of audio) out.push(...chunk);
  return out;
}

/** Drains, returning the bytes heard and the error that ended the stream, if any. */
export async function settle(
  audio: AsyncIterable<Uint8Array>,
): Promise<{ bytes: number[]; error?: unknown }> {
  const bytes: number[] = [];
  try {
    for await (const chunk of audio) bytes.push(...chunk);
    return { bytes };
  } catch (error) {
    return { bytes, error };
  }
}

/** An HTTP reply with an error body in the OpenAPI `Error` shape. */
export function refusal(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers, body: JSON.stringify({ error: 'refused', code }) };
}

export interface LogLine {
  level: string;
  event: string;
  fields?: Readonly<Record<string, unknown>>;
}

export function recordingLogger(lines: LogLine[] = []): Logger & { lines: LogLine[] } {
  const at = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) =>
    void lines.push({ level, event, ...(fields ? { fields } : {}) });
  const logger = {
    lines,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

/** Lets fixture microtasks (socket opens, server frames, queue hand-offs) run. */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
