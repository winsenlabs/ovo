import { describe } from 'vitest';
import type { HqHarness } from './harness.ts';
import { describeAccept } from './suite-accept.ts';
import { describeAssign } from './suite-assign.ts';
import { describeContext } from './suite-context.ts';
import { describeCreate } from './suite-create.ts';
import { describeOperators } from './suite-operators.ts';
import { describePort } from './suite-port.ts';
import { describeQueues } from './suite-queues.ts';
import { describeRelease } from './suite-release.ts';
import { describeRooms } from './suite-rooms.ts';
import { describeSupport } from './suite-support.ts';

/** The human-queue rules (design 5.1): one suite, run against every store. */
export function describeHumanQueueService(name: string, make: () => Promise<HqHarness>) {
  describe(name, () => {
    describeQueues(make);
    describeOperators(make);
    describeCreate(make);
    describeAccept(make);
    describeAssign(make);
    describeRelease(make);
    describeRooms(make);
    describeSupport(make);
    describeContext(make);
    describePort(make);
  });
}
