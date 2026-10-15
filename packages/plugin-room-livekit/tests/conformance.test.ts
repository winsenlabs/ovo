import { describeMediaRoom, fakeMediaRoom } from '@winsendotai/ovo-conformance';

// The room-server contract every implementation passes. The media lane adds the real provider here,
// run against a local room server when one is available; the fake keeps the gate honest until then.
describeMediaRoom('fakeMediaRoom (reference)', () => fakeMediaRoom());
