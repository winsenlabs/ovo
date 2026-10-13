import { describeSpeechToText } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, it } from 'vitest';
import { CartesiaAutoStt } from '../src/auto.ts';
import { CartesiaManualStt } from '../src/manual.ts';
import { cartesiaAutoTemplate, cartesiaManualTemplate, textCommand } from '../src/testing.ts';

// Auto: binary audio frames, JSON `turn.*` events and the JSON `{"type":"close"}` are all
// expressible with today's fixture matchers. forceEndpoint is declared false, so that check skips.
describeSpeechToText(
  'Cartesia Ink-2 turns (Auto)',
  ({ net, clock }) => new CartesiaAutoStt(net, 'fixture-key', {}, clock),
  { template: cartesiaAutoTemplate },
);

/**
 * Manual sends the bare text frames `finalize` and `close`. A fixture step can only tell them from
 * binary audio once plugin-kit's `match: 'any'` honours `where.text` (cross-lane request to the
 * wiring lane, which owns packages/plugin-kit). Until then `any` accepts an audio frame as the
 * `finalize`, so the kit would fail on the matcher, not on the plugin: probe and skip loudly.
 */
async function exactTextFrames(): Promise<boolean> {
  const net = createFixtureNet([
    {
      host: 'probe.invalid',
      source: 'probe',
      retrieved: '2026-10-13',
      steps: [{ expect: 'ws-open', url: /^wss:\/\/probe\.invalid\// }, textCommand('finalize')],
    },
  ]);
  const socket = net.websocket('wss://probe.invalid/x');
  await new Promise<void>((open) => socket.on('open', open));
  try {
    socket.send(new Uint8Array(1));
  } catch {
    return true;
  }
  return false;
}

if (await exactTextFrames())
  describeSpeechToText(
    'Cartesia Ink manual finalize (Manual)',
    ({ net, clock }) => new CartesiaManualStt(net, 'fixture-key', {}, clock),
    { template: cartesiaManualTemplate },
  );
else
  describe('Cartesia Ink manual finalize (Manual)', () => {
    it.skip('needs exact-text WS fixture steps in plugin-kit (cross-lane request)', () => {});
  });
