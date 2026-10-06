import { describeSpeechToText } from '@winsendotai/ovo-conformance';
import { ElevenLabsStt } from '../src/provider.ts';
import { scribeTemplate } from '../src/testing.ts';

// The full kit, forceEndpoint included: a manual commit is an ordinary JSON audio chunk, so the
// documented wire script expresses it without a protocol-specific subset.
describeSpeechToText(
  'ElevenLabs Scribe v2 realtime',
  ({ net, clock }) => new ElevenLabsStt(net, 'fixture-key', {}, clock),
  { template: scribeTemplate },
);
