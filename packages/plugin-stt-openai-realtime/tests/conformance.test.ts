import { describeSpeechToText } from '@winsendotai/ovo-conformance';
import { OpenAiRealtimeStt } from '../src/provider.ts';
import { realtimeSttTemplate } from '../src/testing.ts';

// The full kit, forceEndpoint included: a manual commit is an ordinary JSON client event, so the
// documented wire script expresses it without a protocol-specific subset.
describeSpeechToText(
  'OpenAI realtime transcription',
  ({ net, clock }) => new OpenAiRealtimeStt(net, 'fixture-key', {}, clock),
  { template: realtimeSttTemplate },
);
