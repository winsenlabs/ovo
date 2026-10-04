import { describeKnowledge } from '@winsendotai/ovo-conformance';
import { InlineKnowledge } from '../src/index.ts';

describeKnowledge(
  'inline knowledge',
  ({ sources }) =>
    new InlineKnowledge({
      sources,
      maxPassageCharacters: 2_000,
    }),
);
