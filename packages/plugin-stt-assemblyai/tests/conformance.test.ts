import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { describeSpeechToText } from '@winsendotai/ovo-conformance';
import { AssemblyAiStt } from '../src/provider.ts';
import { assemblyAiTemplate, terminationSteps } from '../src/testing.ts';

// OPS-18: a cancelled session sends Terminate and waits (bounded) for the billed Termination.
const [utterance] = assemblyAiTemplate({
  format: MULAW_8K,
  language: 'en',
  sessionId: 'kit-session',
  turns: [],
});
const opening = utterance!.steps.slice(0, 3);

describeSpeechToText(
  'AssemblyAI Universal Streaming',
  ({ net, clock }) => new AssemblyAiStt(net, 'fixture-key', {}, clock),
  {
    template: assemblyAiTemplate,
    scripts: { cancel: [{ ...utterance!, steps: [...opening, ...terminationSteps(0.4)] }] },
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
