import { describeTurnDetector } from '@winsendotai/ovo-conformance';
import { createTurnDetector } from '../src/index.ts';

// turn@1 barges in on the call's first speech, which this detector protects as the opening by
// default (N8, covered by opening.test.ts); every other scenario runs on the defaults.
describeTurnDetector('OVO default turn detector', () =>
  createTurnDetector({ opening: { protectMs: 0, confirmWords: false } }),
);
