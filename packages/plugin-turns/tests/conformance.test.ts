import { describeTurnDetector } from '@winsendotai/ovo-conformance';
import { createTurnDetector } from '../src/index.ts';

// turn@1's barge-in scenario barges in on the call's first speech, which this detector protects as
// the opening by default (N8, covered by opening.test.ts). Until the kit plays an opening before it
// (the ending lane's cross-lane request), the suite runs with the opening unprotected; every other
// default applies.
describeTurnDetector('OVO default turn detector', () =>
  createTurnDetector({ opening: { protectMs: 0, confirmWords: false } }),
);
