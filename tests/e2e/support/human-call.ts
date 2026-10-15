import { expect, vi } from 'vitest';
import type { FakeTwilioCall } from './fake-twilio-caller.ts';
import { signedCallback } from './fake-acd.ts';
import type { HumanStack } from './human-setup.ts';
import { at, type SessionEvent } from './transfer-call.ts';

export { at };

/** The events of one type, in order. */
export const of = (events: SessionEvent[], type: string) =>
  events.filter((event) => event.type === type);

/** The `Twiml` a recorded carrier update carried. */
export function twimlOf(request: { body: string }): string {
  return new URLSearchParams(request.body).get('Twiml') ?? '';
}

/** The ticket the third party was told about (the last path segment of the callback URL it got). */
export function ticketOf(env: HumanStack, delivery = 0): string {
  const request = env.acd.deliveries()[delivery];
  if (!request) throw new Error('the third party has received no delivery yet');
  return String(request.json.replyTo).split('/').pop()!;
}

/** Waits until the third party has received `count` deliveries (first attempts). */
export async function deliveries(env: HumanStack, count = 1) {
  await vi.waitFor(() => expect(env.acd.deliveries().length).toBeGreaterThanOrEqual(count), {
    timeout: 30_000,
    interval: 100,
  });
}

/** Posts a callback to the api the way the third party does: from a public address, signed. */
export async function postCallback(
  env: HumanStack,
  ticketId: string,
  callback: ReturnType<typeof signedCallback>,
) {
  return env.stack.operator.app.inject({
    method: 'POST',
    url: `/v1/human-queue/callbacks/${ticketId}`,
    remoteAddress: '203.0.113.9',
    headers: callback.headers,
    payload: callback.body,
  });
}

/** Waits until the carrier was asked to move this call, and returns that update. */
export async function carrierUpdate(env: HumanStack, call: FakeTwilioCall) {
  await vi.waitFor(
    () =>
      expect(
        env.twilioRest.requests.filter((request) => request.url.includes(call.callSid)),
      ).not.toEqual([]),
    { timeout: 30_000, interval: 100 },
  );
  return env.twilioRest.requests.filter((request) => request.url.includes(call.callSid))[0]!;
}

/** The api's view of a finished call's outcome (what the inspector reads). */
export async function outcomeOf(env: HumanStack, jobId: string) {
  const { operatorApi } = await import('./operator-setup.ts');
  return operatorApi(env.stack.operator)<{
    summary: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    events: SessionEvent[];
  }>('GET', `/v1/calls/${jobId}/outcome`);
}

/** Waits until the platform asked the carrier to hang this call up (an end line was spoken). */
export async function hungUpByPlatform(env: HumanStack, call: FakeTwilioCall) {
  await vi.waitFor(
    () =>
      expect(
        env.twilioRest.requests.some(
          (request) => request.url.includes(call.callSid) && request.body === 'Status=completed',
        ),
        'the platform hung the call up',
      ).toBe(true),
    { timeout: 30_000, interval: 100 },
  );
}
