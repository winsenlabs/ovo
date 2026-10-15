import { describe, expect, it } from 'vitest';
import {
  RoutingReleaseSnapshot,
  routingVoiceLines,
  TRANSFER_BUILT_IN_LINES,
} from '../src/index.ts';
import {
  DEFAULT_RELEASE,
  ROUTER_RELEASE,
  SALES_EN_RELEASE,
  SALES_HI_RELEASE,
  SUPPORT_RELEASE,
  snapshot,
} from './routing-fixture.ts';
import { BILLING_RELEASE, transferSnapshotInput } from './transfer-fixture.ts';

describe('routingVoiceLines', () => {
  it('gives an R1 release only the router lines and the default hold in the house voice', () => {
    const lines = routingVoiceLines(snapshot());
    expect([...lines.keys()]).toEqual([ROUTER_RELEASE]);
    const router = lines.get(ROUTER_RELEASE)!;
    expect(router).toContain('Welcome to Acme. How can I help you today?');
    expect(router).toContain('Acme में आपका स्वागत है।');
    expect(router).toContain('Are you calling to buy something, or about an existing account?');
    expect(router).toContain('Sorry, I could not connect your call. Goodbye.');
    expect(router).toContain(TRANSFER_BUILT_IN_LINES.hold.en);
    expect(router).toContain(TRANSFER_BUILT_IN_LINES.hold.hi);
    expect(router).toContain(TRANSFER_BUILT_IN_LINES.end.en);
    expect(router).toContain(TRANSFER_BUILT_IN_LINES.queue.en);
    expect(new Set(router).size).toBe(router.length);
  });

  it('adds hold and timeout lines to the router and transfer lines to the granted agents', () => {
    const lines = routingVoiceLines(RoutingReleaseSnapshot.parse(transferSnapshotInput()));
    const router = lines.get(ROUTER_RELEASE)!;
    expect(router).toContain("Thanks for holding, you'll be connected shortly.");
    expect(router).toContain("We'll call you back. Goodbye.");
    // The support target's own hold falls back to no default lines, but the point's hold has none
    // either, and the built-in end line always closes an exhausted chain.
    expect(router).toContain(TRANSFER_BUILT_IN_LINES.end.hi);
    const announcement = 'Let me transfer you to the right team. Please stay on the line.';
    // `support` is granted to the sales pool only: each member in its own language.
    expect(lines.get(SALES_EN_RELEASE)).toContain(announcement);
    expect(lines.get(SALES_EN_RELEASE)).toContain(TRANSFER_BUILT_IN_LINES.returned.en);
    expect(lines.get(SALES_HI_RELEASE)).toContain(TRANSFER_BUILT_IN_LINES.returned.hi);
    expect(lines.get(SALES_HI_RELEASE)).not.toContain(TRANSFER_BUILT_IN_LINES.returned.en);
    // `senior` (confirm: ask, any segment) puts its question in every agent's languages.
    expect(lines.get(SUPPORT_RELEASE)).toContain('Shall I transfer you to senior?');
    expect(lines.get(SUPPORT_RELEASE)).toContain('क्या मैं आपको senior से जोड़ दूँ?');
    expect(lines.get(DEFAULT_RELEASE)).toContain('Shall I transfer you to senior?');
    expect(lines.get(BILLING_RELEASE)).toContain(announcement);
    expect(lines.get(SALES_EN_RELEASE)).toContain(TRANSFER_BUILT_IN_LINES.queue.en);
    // The router never speaks an agent's announcement.
    expect(router).not.toContain(announcement);
  });
});
