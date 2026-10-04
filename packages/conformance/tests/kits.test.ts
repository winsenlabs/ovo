import {
  FixtureInference,
  FixtureSpeechToText,
  FixtureTextToSpeech,
  createReferenceEngine,
  createReferenceTurnDetector,
  createReferenceVad,
  describeCarrier,
  describeEngine,
  describeInference,
  describeSpeechToText,
  describeTextToSpeech,
  describeTurnDetector,
  describeVad,
  fixtureCarrierControl,
  fixtureCarrierIngress,
  fixtureCarrierKitOptions,
  fixtureLlmTemplate,
  fixtureSttTemplate,
  fixtureTtsTemplate,
} from '../src/index.ts';

describeSpeechToText('fixture STT', ({ net, clock }) => new FixtureSpeechToText(net, { clock }), {
  template: fixtureSttTemplate,
});
describeTextToSpeech('fixture TTS', ({ net, clock }) => new FixtureTextToSpeech(net, { clock }), {
  template: fixtureTtsTemplate,
});
describeInference('fixture LLM', ({ net, usage }) => new FixtureInference(net, { usage }), {
  template: fixtureLlmTemplate,
});
describeVad('reference energy VAD', () => createReferenceVad());
describeTurnDetector('reference turn detector', () => createReferenceTurnDetector());
describeCarrier(
  'fixture carrier (at-dial)',
  ({ net }) => ({ control: fixtureCarrierControl(net), ingress: fixtureCarrierIngress() }),
  fixtureCarrierKitOptions('at-dial'),
);
describeCarrier(
  'fixture carrier (on-answer)',
  ({ net }) => ({
    control: fixtureCarrierControl(net, 'on-answer'),
    ingress: fixtureCarrierIngress('on-answer'),
  }),
  fixtureCarrierKitOptions('on-answer'),
);
describeEngine('reference engine with the kit turn detector', createReferenceEngine);
describeEngine('reference engine fallback path', createReferenceEngine, { turnDetector: 'none' });
