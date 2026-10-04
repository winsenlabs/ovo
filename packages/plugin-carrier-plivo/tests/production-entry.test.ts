import { describe, expect, it } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type CarrierControlFactory,
  type CarrierIngress,
  type CarrierMediaEvent,
} from '@winsendotai/ovo-contracts';
import { loadDistribution } from '../../distribution/src/load.ts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose } from '@winsendotai/ovo-runtime';

describe('Plivo production catalog entry', () => {
  it('loads the first-party package and composes both real carrier capabilities', async () => {
    const loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    const id = '@winsendotai/ovo-carrier-plivo';
    expect(loaded.catalog.find((item) => item.manifest.id === id)?.manifest).toMatchObject({
      kind: 'carrier',
      provider: 'plivo',
      contractVersion: 2,
    });
    const net = createFixtureNet([]);
    const composition = await compose([{ id }], loaded.catalog, { scope: 'process', net });
    try {
      const control = composition.all(Cap.carrierControl).get('plivo') as
        CarrierControlFactory | undefined;
      const ingress = composition.all(Cap.carrierIngress).get('plivo') as
        CarrierIngress | undefined;
      expect(control?.capabilities.carrierId).toBe('plivo');
      expect(ingress?.routes.find((route) => route.purpose === 'answer')).toBeDefined();
      expect(ingress?.capabilities.media).toMatchObject({
        playbackEvidence: 'carrier-played',
        clearFlushesMarkers: 'unknown',
        queryOnMediaUrl: false,
      });
      const createEncoder = (
        ingress as CarrierIngress & {
          createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string;
        }
      ).createFixtureFrameEncoder;
      expect(createEncoder).toBeTypeOf('function');
      const encoder = createEncoder();
      expect(() =>
        encoder({ type: 'audio', seq: 1, timestampMs: 0, payload: new Uint8Array([1]) }),
      ).toThrow('has not started');
      const codec = ingress!.serializer.createSession({});
      expect(
        codec.decode(
          encoder({
            type: 'start',
            carrierCallId: 'call-1',
            streamId: 'stream-1',
            format: MULAW_8K,
            routeParams: { sid: 'session-1', rt: 'token-1' },
          }),
        ),
      ).toEqual([
        {
          type: 'start',
          carrierCallId: 'call-1',
          streamId: 'stream-1',
          format: MULAW_8K,
          routeParams: { sid: 'session-1', rt: 'token-1' },
        },
      ]);
      expect(
        codec.decode(
          encoder({ type: 'audio', seq: 2, timestampMs: 20, payload: new Uint8Array([1, 2]) }),
        ),
      ).toEqual([{ type: 'audio', seq: 2, timestampMs: 20, payload: new Uint8Array([1, 2]) }]);
      expect(codec.decode(encoder({ type: 'dtmf', digit: '5' }))).toEqual([
        { type: 'dtmf', digit: '5' },
      ]);
      expect(codec.decode(encoder({ type: 'played', name: 'mark-1' }))).toEqual([
        { type: 'played', name: 'mark-1' },
      ]);
      expect(codec.decode(encoder({ type: 'cleared' }))).toEqual([{ type: 'cleared' }]);
      expect(codec.decode(encoder({ type: 'stop', reason: 'stream-ended' }))).toEqual([
        { type: 'stop', reason: 'stream-ended' },
      ]);
      expect(net.log).toHaveLength(0);
    } finally {
      await composition.dispose();
    }
  });
});
