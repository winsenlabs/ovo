import { describe, expect, it } from 'vitest';
import type { Call } from '../../src/call/call.ts';
import { refreshSession } from '../../src/call/in-dialog.ts';
import { SipHeaders, type SipResponse } from '../../src/sip/message.ts';

/** Just the Call surface refreshSession touches; the response is what the trunk answers. */
function fakeCall(direction: 'inbound' | 'outbound', reply: SipResponse | undefined) {
  const sent: [string, string][][] = [];
  const armed: [number, boolean][] = [];
  const ended: string[] = [];
  const call = {
    phase: 'confirmed',
    refreshing: false,
    direction,
    sessionSeconds: 1800,
    answer: 'v=0\r\n',
    async sendInDialog(_method: string, extra: [string, string][]) {
      sent.push(extra);
      return reply;
    },
    armSessionTimer: (seconds: number, weRefresh: boolean) => void armed.push([seconds, weRefresh]),
    end: (reason: string) => void ended.push(reason),
  };
  return { call: call as unknown as Call, sent, armed, ended };
}

function ok(sessionExpires?: string): SipResponse {
  const headers = new SipHeaders();
  if (sessionExpires) headers.append('session-expires', sessionExpires);
  return { kind: 'response', status: 200, reason: 'OK', headers, body: new Uint8Array() };
}

const sessionExpires = (extra: [string, string][]) =>
  extra.find(([name]) => name === 'Session-Expires')?.[1];

describe('our session refresh (RFC 4028 §7.4)', () => {
  it.each(['inbound', 'outbound'] as const)(
    'asks to stay refresher (refresher=uac) on an %s call, since we are the UAC of the refresh',
    async (direction) => {
      const { call, sent, armed } = fakeCall(direction, ok('1800;refresher=uac'));
      await refreshSession(call);
      expect(sessionExpires(sent[0]!)).toBe('1800;refresher=uac');
      expect(armed).toEqual([[1800, true]]);
    },
  );

  it("re-arms from the 2xx's Session-Expires, handing refreshing over when it says uas", async () => {
    const { call, armed } = fakeCall('inbound', ok('900;refresher=uas'));
    await refreshSession(call);
    expect(armed).toEqual([[900, false]]);
  });

  it('keeps refreshing at its own interval when the 2xx carries no Session-Expires', async () => {
    const { call, armed } = fakeCall('inbound', ok());
    await refreshSession(call);
    expect(armed).toEqual([[1800, true]]);
  });

  it('ends the call when the refresh times out', async () => {
    const { call, armed, ended } = fakeCall('inbound', undefined);
    await refreshSession(call);
    expect(armed).toEqual([]);
    expect(ended).toEqual(['session_refresh_failed']);
  });
});
