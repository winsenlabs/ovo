import { describe, expect, it } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import {
  TwilioTelephonyControl,
  twilioControlFactory,
} from '@winsendotai/ovo-plugin-carrier-twilio';
import type { ParentView } from '@winsendotai/ovo-runtime';
import { fixtureParent } from '../../fixture-calls/src/execute.ts';

describe('fixture session parent isolation with installed Twilio controls', () => {
  const net = createFixtureNet([]);
  const carrierControl = twilioControlFactory(net);
  const legacyTelephony = new TwilioTelephonyControl(
    { accountSid: `AC${'0'.repeat(32)}`, authToken: 'fixture-only' },
    undefined,
    undefined,
    net,
  );
  const allowed = { now: () => 0 };
  const providers = new Map<string, unknown>([
    [Cap.carrierControl, carrierControl],
    [Cap.legacyTelephony, legacyTelephony],
    [Cap.clock, allowed],
  ]);
  const parent: ParentView = {
    keys: new Set(providers.keys()),
    get: (key) => providers.get(key),
    all: (key) => (providers.has(key) ? new Map([['twilio', providers.get(key)]]) : new Map()),
  };

  it.each([Cap.carrierControl, Cap.legacyTelephony])(
    'hides installed %s through keys, get and all',
    (blockedKey) => {
      expect(parent.all(blockedKey).get('twilio')).toBe(providers.get(blockedKey));
      const fixture = fixtureParent(parent)!;
      expect(fixture.keys.has(blockedKey)).toBe(false);
      expect(fixture.get(blockedKey)).toBeUndefined();
      expect([...fixture.all(blockedKey)]).toEqual([]);
      expect(fixture.keys.has(Cap.clock)).toBe(true);
      expect(fixture.get(Cap.clock)).toBe(allowed);
      expect(net.log).toEqual([]);
    },
  );
});
