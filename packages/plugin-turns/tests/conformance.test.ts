import { describeTurnDetector } from '@winsendotai/ovo-conformance';
import { createTurnDetector } from '../src/index.ts';

describeTurnDetector('OVO default turn detector', () => createTurnDetector());
