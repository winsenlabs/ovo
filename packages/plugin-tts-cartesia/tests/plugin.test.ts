import { Cap, MULAW_8K, meterKey, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  CARTESIA_TTS_METER_KEY,
  CartesiaTts,
  cartesiaTtsPlugin,
  fixtureTemplates,
  fixtures,
} from '../src/index.ts';
import { doneEvent, socketOpen } from '../src/testing.ts';
import { VOICE, chunk, drain, input, said, wsScript } from './support.ts';

const ID = cartesiaTtsPlugin.manifest.id;

describe('Cartesia TTS registration', () => {
  it('declares the character meter, the egress host and its fixtures', () => {
    const manifest = cartesiaTtsPlugin.manifest as {
      meters?: { key: string }[];
      runtime?: { egressHosts: string[] };
      provider?: string;
    };
    expect(manifest.meters?.map((meter) => meter.key)).toEqual([CARTESIA_TTS_METER_KEY]);
    expect(meterKey({ provider: 'cartesia', operation: 'tts', unit: 'characters' })).toBe(
      CARTESIA_TTS_METER_KEY,
    );
    expect(manifest.runtime?.egressHosts).toEqual(['api.cartesia.ai']);
    expect(manifest.provider).toBe('cartesia');
    expect(fixtureTemplates[ID]).toBeTypeOf('function');
    expect(fixtures[ID]?.[0]?.retrieved).toBe('2026-10-13');
  });

  it('composes with a nested credential reference and closes its socket at session end', async () => {
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
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...said('ovo-1', 'Namaste. '),
        { send: chunk('ovo-1', [8]) },
        { send: doneEvent('ovo-1') },
      ]),
    ]);
    const parent = await compose([{ id: secrets.manifest.id }], [secrets], { scope: 'process' });
    try {
      const session = await compose(
        [
          {
            id: ID,
            config: {
              binding: { voiceId: VOICE },
              credentialRef: { credentialRef: { credentialId: 'cred-car' } },
            },
          },
        ],
        [cartesiaTtsPlugin],
        { scope: 'session', parent, workspaceId: 'workspace-1', net },
      );
      const tts = session.get(Cap.tts) as TextToSpeech;
      expect(tts).toBeInstanceOf(CartesiaTts);
      expect(
        await drain(tts.synthesize({ ...input(), format: MULAW_8K, text: 'Namaste. ' })),
      ).toEqual([8]);
      await session.dispose();
    } finally {
      await parent.dispose();
    }
    expect(resolve).toHaveBeenCalledWith('workspace-1', 'cred-car');
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
    net.assertComplete();
  });
});
