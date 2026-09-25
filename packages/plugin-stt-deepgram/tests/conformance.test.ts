import { describeSpeechToText } from '@winsendotai/ovo-conformance';
import { DeepgramStt } from '../src/deepgram.ts';
import { deepgramTemplate } from '../src/testing.ts';

describeSpeechToText(
  'Deepgram native streaming',
  ({ net, clock }) => new DeepgramStt(net, 'fixture-key', { model: 'nova-3' }, clock),
  {
    template: deepgramTemplate,
    // FixtureNet cannot express an optional Finalize followed by more binary writes.
    // The dedicated protocol test below covers that sequence with a strict wire script.
    only: ['capabilities are coherent', 'a scripted utterance', 'cancel closes', 'a provider failure'],
  },
);
