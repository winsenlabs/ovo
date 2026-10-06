import type {
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
} from '@winsendotai/ovo-contracts';
import { errorFields } from '@winsendotai/ovo-plugin-kit';
import { twilioLog as log } from './log.ts';
import { validateTwilioSignature } from './signature.ts';

/** Shared by every Twilio callback route: reply shape, host-port failures, signed form parsing. */
export const reply = (status: number, body = ''): CarrierHttpReply => ({
  status,
  contentType: 'text/xml; charset=utf-8',
  body,
});

export class HostPortError extends Error {}

export async function hostPort<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new HostPortError('Twilio host port failed', { cause: error });
  }
}

/** The reply status is unchanged; the log keeps the cause the reply cannot carry. */
export function failure(
  error: unknown,
  req: CarrierHttpRequest,
  purpose: CarrierHttpRoute['purpose'],
): CarrierHttpReply {
  const status = error instanceof HostPortError ? 503 : error instanceof RangeError ? 413 : 400;
  log[status === 503 ? 'error' : 'warn']('twilio_callback_failed', {
    purpose,
    bindingId: req.bindingId,
    status,
    ...errorFields(error),
  });
  return reply(status);
}

function form(raw: Uint8Array): Record<string, string> {
  if (raw.byteLength > 64 * 1024) throw new RangeError('Twilio callback is too large');
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(
    new TextDecoder('utf-8', { fatal: true }).decode(raw),
  )) {
    if (Object.hasOwn(result, key)) throw new Error('Duplicate Twilio callback parameter');
    result[key] = value;
  }
  return result;
}

export function required(input: Record<string, string>, name: string): string {
  const value = input[name];
  if (!value || value.length > 256) throw new Error(`Invalid Twilio ${name}`);
  return value;
}

export async function signed(
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  purpose: CarrierHttpRoute['purpose'],
): Promise<Record<string, string> | undefined> {
  const params = form(req.rawBody);
  const binding = await hostPort(() => host.resolveBinding(req.bindingId));
  const signature = Object.entries(req.headers).find(
    ([key]) => key.toLowerCase() === 'x-twilio-signature',
  )?.[1];
  const rejected = (check: 'signature' | 'url-secret') => {
    log.warn('twilio_callback_unauthenticated', {
      purpose,
      bindingId: req.bindingId,
      check,
      carrierCallId: params.CallSid,
      signaturePresent: signature !== undefined,
    });
    return undefined;
  };
  if (
    !validateTwilioSignature({
      authToken: binding.secret,
      signature,
      externalUrl: req.externalUrl,
      parameters: params,
    })
  )
    return rejected('signature');
  if (
    purpose !== 'inbound' &&
    !(await hostPort(() => host.verifyUrlSecret(req, { purpose, requestId: req.query.r })))
  )
    return rejected('url-secret');
  return params;
}
