import { describeSpeechToText } from '@winsendotai/ovo-conformance';
import { AssemblyAiStt } from '../src/provider.ts';
import { assemblyAiTemplate } from '../src/testing.ts';

describeSpeechToText(
  'AssemblyAI Universal Streaming',
  ({ net, clock }) => new AssemblyAiStt(net, 'fixture-key', {}, clock),
  {
    template: assemblyAiTemplate,
    // The shared utterance script has no optional ForceEndpoint step. A strict protocol test
    // below exercises it without weakening the ordinary wire fixture.
    only: [
      'capabilities are coherent',
      'a scripted utterance',
      'cancel closes',
      'a provider failure',
    ],
  },
);
