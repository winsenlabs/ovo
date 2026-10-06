import { MULAW_8K, type NetFixtureScript } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assemblyAiPlugin } from '../src/index.ts';
import { assemblyAiTurnDetection, updateConfigurationMessage } from '../src/endpointing.ts';
import { AssemblyAiStt, DEFAULT_CONNECT_TIMEOUT_MS, assemblyAiUrl } from '../src/provider.ts';

const source = 'https://www.assemblyai.com/docs/streaming/message-sequence';
const begin = JSON.stringify({
  type: 'Begin',
  id: 'aa-endpointing',
  expires_at: '2026-10-06T00:00:00Z',
  configuration: { model: 'universal-streaming-english' },
});

function socket(steps: NetFixtureScript['steps'] = []): NetFixtureScript {
  return {
    host: 'streaming.assemblyai.com',
    source,
    retrieved: '2026-10-06',
    steps: [{ expect: 'ws-open', url: /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/ }, ...steps],
  };
}

const input = () => ({
  sessionId: 'aa-endpointing',
  format: MULAW_8K,
  language: 'en-IN',
  signal: new AbortController().signal,
  onEvent: () => undefined,
  onUsage: () => undefined,
});

const params = (binding: Parameters<typeof assemblyAiUrl>[0], language = 'en-IN') =>
  Object.fromEntries(new URL(assemblyAiUrl(binding, MULAW_8K, language)).searchParams);

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('AssemblyAI endpointing presets (STT-4)', () => {
  it('sends the documented quick-start values for each preset', () => {
    expect(params({ endpointing: 'fast' })).toMatchObject({
      end_of_turn_confidence_threshold: '0.4',
      min_turn_silence: '160',
      max_turn_silence: '400',
    });
    expect(params({ endpointing: 'balanced' })).toMatchObject({
      min_turn_silence: '400',
      max_turn_silence: '1280',
    });
    expect(params({ endpointing: 'patient' })).toMatchObject({
      end_of_turn_confidence_threshold: '0.7',
      min_turn_silence: '800',
      max_turn_silence: '3600',
    });
  });

  it('lets explicit fields override the preset', () => {
    expect(assemblyAiTurnDetection({ endpointing: 'fast', maxTurnSilenceMs: 700 })).toEqual({
      endOfTurnConfidenceThreshold: 0.4,
      minTurnSilenceMs: 160,
      maxTurnSilenceMs: 700,
    });
  });

  it("connects with the 'fast' preset when the binding configures no turn detection", () => {
    expect(params({})).toMatchObject({
      end_of_turn_confidence_threshold: '0.4',
      min_turn_silence: '160',
      max_turn_silence: '400',
    });
  });

  it('sends only the fields a binding without a preset set, as it was published', () => {
    // Regression: the 'fast' default used to sit under explicit fields, so a published 800 ms
    // minimum connected with a 400 ms maximum below it.
    const turnFields = ['min_turn_silence', 'max_turn_silence', 'end_of_turn_confidence_threshold'];
    const tuned = (binding: Parameters<typeof params>[0]) =>
      Object.fromEntries(Object.entries(params(binding)).filter(([k]) => turnFields.includes(k)));
    expect(tuned({ minTurnSilenceMs: 800 })).toEqual({ min_turn_silence: '800' });
    expect(tuned({ maxTurnSilenceMs: 2000 })).toEqual({ max_turn_silence: '2000' });
    expect(tuned({ endOfTurnConfidenceThreshold: 0.6 })).toEqual({
      end_of_turn_confidence_threshold: '0.6',
    });
  });

  it('sends vad_threshold and inactivity_timeout, and the prompt only to the pro models', () => {
    expect(params({ vadThreshold: 0.5, inactivityTimeoutSec: 30, prompt: 'Loan EMIs' })).toEqual(
      expect.objectContaining({ vad_threshold: '0.5', inactivity_timeout: '30' }),
    );
    expect(params({ prompt: 'Loan EMIs' })).not.toHaveProperty('prompt');
    expect(params({ model: 'universal-3-6-pro', prompt: 'Loan EMIs' })).toMatchObject({
      prompt: 'Loan EMIs',
    });
  });

  it('validates the new binding fields against the documented ranges', () => {
    const registry = new PluginRegistry([assemblyAiPlugin]);
    const id = assemblyAiPlugin.manifest.id;
    const ok = (binding: Record<string, unknown>) => registry.validateBinding(id, binding).ok;
    expect(ok({ endpointing: 'fast', vadThreshold: 0.5, inactivityTimeoutSec: 5 })).toBe(true);
    expect(ok({ endpointing: 'eager' })).toBe(false);
    expect(ok({ minTurnSilenceMs: 40 })).toBe(false);
    expect(ok({ inactivityTimeoutSec: 4 })).toBe(false);
    expect(ok({ prompt: 'x'.repeat(1_751) })).toBe(false);
  });

  it('updates endpointing mid-call with a delta UpdateConfiguration', async () => {
    expect(
      JSON.parse(updateConfigurationMessage({ endpointing: 'patient', vadThreshold: 0.6 })),
    ).toEqual({
      type: 'UpdateConfiguration',
      end_of_turn_confidence_threshold: 0.7,
      min_turn_silence: 800,
      max_turn_silence: 3600,
      vad_threshold: 0.6,
    });
    const net = createFixtureNet([
      socket([
        { send: begin },
        {
          expect: 'ws-send',
          match: 'json',
          where: { type: 'UpdateConfiguration', max_turn_silence: 500 },
        },
      ]),
    ]);
    const session = await new AssemblyAiStt(net, 'fixture-key').start(input());
    await session.updateConfiguration({ maxTurnSilenceMs: 500 });
    await session.cancel('done');
    net.assertComplete();
  });
});

describe('AssemblyAI connect deadline for asia-south1', () => {
  it('defaults to 6 s and caps the binding at 15 s', () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(6_000);
    const schema = (
      assemblyAiPlugin.manifest as unknown as {
        bindingSchema: { properties: { connectTimeoutMs: { maximum: number; default: number } } };
      }
    ).bindingSchema.properties.connectTimeoutMs;
    expect(schema).toMatchObject({ maximum: 15_000, default: 6_000 });
  });

  it('keeps a 5 s Begin on the first attempt instead of abandoning it', async () => {
    // Regression: the 3 s default abandoned every handshake slower than 3 s, and the 2-5 s
    // handshakes measured from asia-south1 then needed a retry or failed the call.
    const clock = new FakeClock();
    const net = createFixtureNet([socket([{ delayMs: 5_000 }, { send: begin }])], { clock });
    const starting = new AssemblyAiStt(net, 'fixture-key', {}, clock).start(input());
    await clock.advanceAsync(5_000);
    const session = await starting;
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('stt_connect_retry'));
    await session.cancel('done');
    net.assertComplete();
  });
});
