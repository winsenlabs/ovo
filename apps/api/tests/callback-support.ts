import { type HqApp, type TestRoom, useHq } from './human-queue-fixtures.ts';
import { external, makeQueue, openTicket, signedCallback } from './human-queue-data.ts';

export const SECRET = 'whsec-callback';
/** An app factory whose signing secret is `SECRET`; `makeRoom` is the conformance fake, passed in by the test. */
export function callbackApps(makeRoom: () => TestRoom) {
  const build = useHq(makeRoom);
  return (options: Parameters<typeof build>[0] = {}) => build({ secret: SECRET, ...options });
}

export async function setup(
  hq: HqApp,
  queuePatch: Record<string, unknown> = {},
  ticketPatch: Record<string, unknown> = {},
) {
  const queue = await makeQueue(hq, external(queuePatch));
  const ticket = await openTicket(hq, queue, ticketPatch);
  return { queue, ticket };
}

export const post = (
  hq: HqApp,
  ticketId: string,
  body: unknown,
  options: Parameters<typeof signedCallback>[2] = {},
  secret = SECRET,
) => {
  const signed = signedCallback(secret, body, { now: hq.now(), ...options });
  return {
    signed,
    response: hq.app.inject({
      method: 'POST',
      url: `/v1/human-queue/callbacks/${ticketId}`,
      payload: signed.payload,
      headers: signed.headers,
    }),
  };
};
export const send = async (...args: Parameters<typeof post>) => await post(...args).response;
