import { describeSpeechToText } from '@winsendotai/ovo-conformance';
import { CartesiaAutoStt } from '../src/auto.ts';
import { CartesiaManualStt } from '../src/manual.ts';
import { cartesiaAutoTemplate, cartesiaManualTemplate } from '../src/testing.ts';

// Auto: binary audio frames, JSON `turn.*` events and the JSON `{"type":"close"}` are all
// expressible with today's fixture matchers. forceEndpoint is declared false, so that check skips.
describeSpeechToText(
  'Cartesia Ink-2 turns (Auto)',
  ({ net, clock }) => new CartesiaAutoStt(net, 'fixture-key', {}, clock),
  { template: cartesiaAutoTemplate },
);

// Manual sends the bare text frames `finalize` and `close`; plugin-kit's `match: 'any'` with
// `where.text` matches them exactly and never takes a binary audio frame for them.
describeSpeechToText(
  'Cartesia Ink manual finalize (Manual)',
  ({ net, clock }) => new CartesiaManualStt(net, 'fixture-key', {}, clock),
  { template: cartesiaManualTemplate },
);
