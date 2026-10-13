import { FakeClock } from '@winsendotai/ovo-conformance';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import {
  CartesiaAutoStt,
  ENDPOINTING,
  MAX_KEYTERM_CHARS,
  applyUpdate,
  autoUrl,
  callKeyterms,
  cartesiaManualSttPlugin,
  cartesiaSttPlugin,
} from '../src/index.ts';
import { fakeNet } from './support.ts';

const AUTO = cartesiaSttPlugin.manifest.id;
const MANUAL = cartesiaManualSttPlugin.manifest.id;
const registry = new PluginRegistry([cartesiaSttPlugin, cartesiaManualSttPlugin]);
const valid = (id: string, binding: unknown) => registry.validateBinding(id, binding);

describe('Cartesia Auto STT binding (C5)', () => {
  it('accepts the defaults, a preset, explicit thresholds and keyterms', () => {
    for (const ok of [
      {},
      { model: 'ink-2', endpointing: 'patient' },
      {
        turnStartThreshold: 0.9,
        turnEagerEndThreshold: 0.8,
        turnEndThreshold: 0.05,
        turnEndTimeoutMs: 640,
        keyterms: ['Fanpit', 'EMI due'],
        connectTimeoutMs: 6000,
        backlogMaxRate: 2,
      },
    ])
      expect(valid(AUTO, ok), JSON.stringify(ok)).toEqual({ ok: true });
  });

  it('rejects other models (ink-whisper has no turns endpoint, ink-preview is beta) and bad ranges', () => {
    for (const bad of [
      { model: 'ink-whisper' },
      { model: 'ink-preview' },
      { endpointing: 'eager' },
      { turnStartThreshold: 0.95 },
      { turnEagerEndThreshold: 0.2 },
      { turnEndThreshold: 0.6 },
      { turnEndTimeoutMs: 600 },
      { turnEndTimeoutMs: 11_201 },
      { keyterms: Array.from({ length: 101 }, (_, i) => `term${i}`) },
      { keyterms: [''] },
      { backlogMaxRate: 0.5 },
      { language: 'hi' },
      { apiKey: 'sk_car_never_here' },
    ])
      expect(valid(AUTO, bad), JSON.stringify(bad)).toMatchObject({ ok: false });
  });

  it('refuses thresholds out of the documented order start > eager_end > end at build time', () => {
    const make = (binding: object) => new CartesiaAutoStt(fakeNet(), 'k', binding, new FakeClock());
    expect(() => make({ turnStartThreshold: 0.6, turnEagerEndThreshold: 0.7 })).toThrow(/start/);
    expect(() => make({ turnEagerEndThreshold: 0.3, turnEndThreshold: 0.4 })).toThrow(/eager/);
    // A preset overlaid with explicit values must still be ordered.
    expect(() => make({ endpointing: 'patient', turnEndThreshold: 0.35 })).toThrow(/eager/);
    expect(() => make({ endpointing: 'fast', turnEndTimeoutMs: 700 })).not.toThrow();
  });

  it('maps each endpointing preset to the documented profile', () => {
    expect(ENDPOINTING).toEqual({
      fast: { startThreshold: 0.7, eagerEndThreshold: 0.6, endThreshold: 0.4, endTimeoutMs: 4500 },
      balanced: {
        startThreshold: 0.8,
        eagerEndThreshold: 0.6,
        endThreshold: 0.3,
        endTimeoutMs: 5600,
      },
      patient: {
        startThreshold: 0.8,
        eagerEndThreshold: 0.3,
        endThreshold: 0.1,
        endTimeoutMs: 8000,
      },
    });
    expect(applyUpdate(ENDPOINTING.balanced, { maxTurnSilenceMs: 100 }).endTimeoutMs).toBe(640);
    expect(applyUpdate(ENDPOINTING.balanced, { endpointing: 'fast' })).toEqual(ENDPOINTING.fast);
  });
});

describe('Cartesia keyterms (C5)', () => {
  it('validates the binding keyterms against 100 terms and 1200 characters in total', () => {
    const long = Array.from({ length: 13 }, (_, i) => `term${i} `.padEnd(100, 'x'));
    expect(() => callKeyterms(long, [])).toThrow(/1200/);
    expect(callKeyterms(long.slice(0, 12), [])).toHaveLength(12);
  });

  it('adds the agent terms while they fit, trimmed and de-duplicated case-insensitively', () => {
    const own = ['Fanpit', ' Winsen '];
    const agent = ['fanpit', 'EMI', '', 'y'.repeat(MAX_KEYTERM_CHARS)];
    expect(callKeyterms(own, agent)).toEqual(['Fanpit', 'Winsen', 'EMI']);
  });

  it('encodes multi-word keyterms with %20 as repeated parameters', () => {
    expect(autoUrl({}, MULAW_8K, ['due date', 'Rs.'])).toBe(
      'wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_mulaw&sample_rate=8000' +
        '&cartesia_version=2026-08-14&keyterm=due%20date&keyterm=Rs.',
    );
  });
});

describe('Cartesia Manual STT binding (C6)', () => {
  it('accepts ink-2 with keyterms and ink-whisper with a language and its silence settings', () => {
    for (const ok of [
      {},
      { model: 'ink-2', keyterms: ['Fanpit'] },
      { model: 'ink-whisper', language: 'ta' },
      { model: 'ink-whisper', language: 'hi', minVolume: 0.1, maxSilenceDurationSecs: 2 },
    ])
      expect(valid(MANUAL, ok), JSON.stringify(ok)).toEqual({ ok: true });
  });

  it('rejects whisper without a language or with keyterms, and whisper fields on ink-2', () => {
    for (const bad of [
      { model: 'ink-whisper' },
      { model: 'ink-whisper', language: 'xx' },
      { model: 'ink-whisper', language: 'ta', keyterms: ['a'] },
      { language: 'hi' },
      { model: 'ink-2', minVolume: 0.2 },
      { maxSilenceDurationSecs: 1 },
      { model: 'ink-preview' },
      { model: 'ink-whisper', language: 'ta', minVolume: 1.5 },
    ])
      expect(valid(MANUAL, bad), JSON.stringify(bad)).toMatchObject({ ok: false });
  });
});
