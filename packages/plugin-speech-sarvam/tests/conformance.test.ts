import { describeSpeechToText, describeTextToSpeech } from '@winsendotai/ovo-conformance';
import { SarvamStt } from '../src/stt.ts';
import { SarvamTts } from '../src/tts.ts';
import { sarvamSttTemplate, sarvamTtsTemplate } from '../src/testing.ts';

describeSpeechToText(
  'Sarvam Saaras realtime',
  ({ net, clock }) => new SarvamStt(net, 'fixture-key', {}, clock),
  { template: sarvamSttTemplate, language: 'hi-IN' },
);

describeTextToSpeech(
  'Sarvam Bulbul streaming',
  ({ net, clock }) => new SarvamTts(net, 'fixture-key', {}, clock),
  // Each utterance meters under its own requestId (Wave 2 request 4), though the fixture replays
  // one provider id.
  { template: sarvamTtsTemplate, language: 'hi-IN', distinctRequestIds: true },
);
