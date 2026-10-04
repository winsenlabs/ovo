import { describeVad } from '@winsendotai/ovo-conformance';
import { createEnergyVad } from '../src/index.ts';

describeVad('OVO energy VAD', () => createEnergyVad());
