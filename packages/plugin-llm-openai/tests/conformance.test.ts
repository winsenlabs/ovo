import { describeInference } from '@winsendotai/ovo-conformance';
import { openAiInference } from '../src/inference.ts';
import { openAiGenerateTemplate, openAiStreamTemplate } from '../src/testing.ts';

const factory = ({ net, usage }: Parameters<Parameters<typeof describeInference>[1]>[0]) =>
  openAiInference(net, 'fixture-key', { model: 'gpt-4o-mini' }, usage);

describeInference('OpenAI Responses generation', factory, {
  template: openAiGenerateTemplate,
  only: ['exposes provider', 'the template drives', 'an aborted request'],
});
describeInference('OpenAI Responses streaming', factory, {
  template: openAiStreamTemplate,
  only: ['stream() reaches'],
});
