import { expect, it } from 'vitest';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { parseGatewayMessage } from '../src/protocol.ts';

const open = {
  type: 'session.open',
  protocol: 2,
  sessionId: 'session-1',
  carrierId: 'fixture',
  bindingId: 'env',
  carrierCallId: 'CA-1',
  streamId: 'MZ-1',
  ownerEpoch: 1,
  generation: 1,
  format: MULAW_8K,
  playbackEvidence: 'carrier-played',
  clearFlushesMarkers: true,
  routeToken: 'token',
};

it('requires canonical carrier call and stream fields on the gateway-worker protocol', () => {
  expect(parseGatewayMessage(JSON.stringify(open), 4096)).toMatchObject({
    carrierCallId: 'CA-1',
    streamId: 'MZ-1',
  });
  const { carrierCallId: _carrierCallId, streamId: _streamId, ...legacy } = open;
  expect(() =>
    parseGatewayMessage(JSON.stringify({ ...legacy, callSid: 'CA-1', streamSid: 'MZ-1' }), 4096),
  ).toThrow('invalid carrierCallId');
  expect(() =>
    parseGatewayMessage(
      JSON.stringify({ ...legacy, carrierCallId: 'CA-1', streamSid: 'MZ-1' }),
      4096,
    ),
  ).toThrow('invalid streamId');
});

it.each([
  ['none', false],
  ['carrier-processed', 'unknown'],
] as const)(
  'preserves %s playback evidence and %s clear behavior',
  (playbackEvidence, clearFlushesMarkers) => {
    expect(
      parseGatewayMessage(JSON.stringify({ ...open, playbackEvidence, clearFlushesMarkers }), 4096),
    ).toMatchObject({ playbackEvidence, clearFlushesMarkers });
  },
);

it('refuses missing media capability declarations instead of assuming the fixture defaults', () => {
  const { playbackEvidence: _evidence, clearFlushesMarkers: _clear, ...missing } = open;
  expect(() => parseGatewayMessage(JSON.stringify(missing), 4096)).toThrow(
    'invalid clearFlushesMarkers',
  );
  expect(() =>
    parseGatewayMessage(JSON.stringify({ ...missing, clearFlushesMarkers: false }), 4096),
  ).toThrow('invalid playback evidence');
});
