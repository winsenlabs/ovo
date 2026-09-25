import { describeTextToSpeech } from '@winsendotai/ovo-conformance';
import { OpenAiTts } from '../src/tts.ts';
import { openAiTtsTemplate } from '../src/testing.ts';

describeTextToSpeech('OpenAI native PCM 24 kHz', ({ net }) =>
  new OpenAiTts(net, 'fixture-key', { model: 'gpt-4o-mini-tts', voice: 'alloy' }), {
    template: openAiTtsTemplate,
  });
