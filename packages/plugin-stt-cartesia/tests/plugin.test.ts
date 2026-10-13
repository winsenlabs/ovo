import { Cap, MULAW_8K, meterKey, type SpeechToText } from '@winsendotai/ovo-contracts';
import { compose, definePlugin, loadInstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import * as stt from '../src/index.ts';
import {
  CARTESIA_AUTO_CAPABILITIES,
  CARTESIA_MANUAL_CAPABILITIES,
  CARTESIA_MANUAL_STT_METER_KEY,
  CARTESIA_STT_METER_KEY,
  CartesiaAutoStt,
  CartesiaManualStt,
  cartesiaManualSttPlugin,
  cartesiaSttPlugin,
  fixtureTemplates,
  fixtures,
  plugins,
} from '../src/index.ts';
import { fakeNet, recorder } from './support.ts';

describe('Cartesia STT registration', () => {
  it('ships two definitions, each on its own provider and meter, one egress host', () => {
    expect(
      plugins.map((plugin) => [
        plugin.manifest.id,
        (plugin.manifest as { provider?: string }).provider,
      ]),
    ).toEqual([
      ['@winsendotai/ovo-stt-cartesia', 'cartesia'],
      ['@winsendotai/ovo-stt-cartesia-manual', 'cartesia-manual'],
    ]);
    for (const plugin of plugins) {
      const manifest = plugin.manifest as {
        id: string;
        provider?: string;
        meters?: { key: string; unit: string }[];
        runtime?: { egressHosts: string[] };
        capabilities?: { forceEndpoint: boolean; turnSignals: readonly string[] };
      };
      // The worker prices usage by `meterKey()` of the usage provider, which is the manifest's.
      const key = meterKey({
        provider: manifest.provider!,
        operation: 'stt',
        unit: 'audio_seconds',
      });
      expect(key).toBe(
        plugin === cartesiaSttPlugin ? CARTESIA_STT_METER_KEY : CARTESIA_MANUAL_STT_METER_KEY,
      );
      expect(manifest.meters).toEqual([expect.objectContaining({ key, unit: 'audio_seconds' })]);
      expect(manifest.runtime?.egressHosts).toEqual(['api.cartesia.ai']);
      expect(manifest.capabilities).toEqual(
        plugin === cartesiaSttPlugin ? CARTESIA_AUTO_CAPABILITIES : CARTESIA_MANUAL_CAPABILITIES,
      );
      expect(fixtureTemplates[manifest.id]).toBeTypeOf('function');
      expect(fixtures[manifest.id]?.[0]).toMatchObject({
        host: 'api.cartesia.ai',
        retrieved: '2026-10-13',
      });
    }
    // Static capabilities: Auto relies on provider turns, Manual on a host finalize.
    expect(CARTESIA_AUTO_CAPABILITIES).toMatchObject({
      forceEndpoint: false,
      turnSignals: ['speech-start', 'end-of-turn', 'eager-end-of-turn', 'turn-resumed'],
    });
    expect(CARTESIA_MANUAL_CAPABILITIES).toMatchObject({
      forceEndpoint: true,
      turnSignals: [],
    });
  });

  it('installs both definitions side by side (one STT per provider)', async () => {
    const installed = await loadInstalledSessionExtensions(
      JSON.stringify(['@winsendotai/ovo-plugin-stt-cartesia']),
      async () => stt,
    );
    expect(installed.plugins.map((plugin) => plugin.manifest.id)).toEqual([
      '@winsendotai/ovo-stt-cartesia',
      '@winsendotai/ovo-stt-cartesia-manual',
    ]);
    expect(Object.keys(installed.fixtureTemplates ?? {})).toHaveLength(2);
  });

  it('composes each definition with the binding credential and the agent keyterms', async () => {
    const resolve = vi.fn(async () => 'fixture-key');
    const secrets = definePlugin(
      {
        id: 'fixture-secret-resolver',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'process',
        requires: [],
        provides: [Cap.secrets],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.secrets, { resolve });
      },
    );
    const parent = await compose([{ id: secrets.manifest.id }], [secrets], { scope: 'process' });
    try {
      for (const [plugin, type] of [
        [cartesiaSttPlugin, CartesiaAutoStt],
        [cartesiaManualSttPlugin, CartesiaManualStt],
      ] as const) {
        const net = fakeNet();
        const session = await compose(
          [
            {
              id: plugin.manifest.id,
              config: {
                binding: {},
                credentialRef: { credentialId: 'cred-car' },
                keyterms: ['Fanpit'],
              },
            },
          ],
          [plugin],
          { scope: 'session', parent, workspaceId: 'workspace-1', net },
        );
        const stt = session.get(Cap.stt) as SpeechToText;
        expect(stt).toBeInstanceOf(type);
        const live = await stt.start(recorder({ format: MULAW_8K }).input);
        expect(net.sockets[0]!.url).toContain('keyterm=Fanpit');
        expect(net.sockets[0]!.headers).toEqual({ 'X-API-Key': 'fixture-key' });
        await live.cancel('test over');
        await session.dispose();
      }
    } finally {
      await parent.dispose();
    }
    expect(resolve).toHaveBeenCalledWith('workspace-1', 'cred-car');
  });
});
