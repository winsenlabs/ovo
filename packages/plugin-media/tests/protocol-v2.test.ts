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
