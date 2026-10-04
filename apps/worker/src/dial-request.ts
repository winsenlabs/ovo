import type { TelephonyDialRequest } from '@winsendotai/ovo-plugin-orchestration';

export function dialRequestFromJob(
  payload: Record<string, unknown>,
  job: { id: string; workspaceId: string; ownerEpoch: number },
  session?: { sessionId: string; token: string },
): TelephonyDialRequest {
  const read = (key: string): string => {
    const value = payload[key];
    if (typeof value !== 'string' || !value) throw new Error(`Job ${job.id} is missing ${key}`);
    return value;
  };
  return {
    requestId: `${job.id}:${job.ownerEpoch}`,
    jobId: job.id,
    workspaceId: job.workspaceId,
    to: read('to'),
    from: read('from'),
    streamUrl: new URL(read('streamUrl')).toString(),
    streamParameters: session
      ? { sessionId: session.sessionId, routeToken: session.token }
      : undefined,
    statusCallbackUrl: read('statusCallbackUrl'),
  };
}

import type { DialRequest } from '@winsendotai/ovo-contracts';
import type { CarrierJob, SelectedJobCarrier } from './carrier-runtime.ts';

/** Dial URLs are minted by the host for this request and binding. */
export function dialRequestV2(input: {
  job: CarrierJob;
  payload: Record<string, unknown>;
  route: { sessionId: string };
  token: string;
  selected: SelectedJobCarrier;
}): DialRequest {
  const { job, payload, selected } = input;
  const text = (key: string) => {
    const value = payload[key];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Job ${job.id} is missing ${key}`);
    return value;
  };
  const requestId = `${job.id}:${job.ownerEpoch}`;
  const { carrierId, bindingId, capabilities } = selected.carrier;
  const callback = (purpose: 'status' | 'answer' | 'amd' | 'resume') =>
    selected.ports.callbackUrl(carrierId, bindingId, purpose, { requestId });
  const ringTimeoutSec = Number(payload.ringTimeoutSec ?? 60);
  if (!Number.isSafeInteger(ringTimeoutSec) || ringTimeoutSec < 1 || ringTimeoutSec > 600)
    throw new Error('ringTimeoutSec must be an integer between 1 and 600');
  return {
    requestId,
    jobId: job.id,
    to: text('to'),
    from: text('from'),
    media: {
      url: selected.ports.mediaUrl(carrierId, bindingId),
      routeParams:
        capabilities.control.streamParams === 'at-dial'
          ? { sid: input.route.sessionId, rt: input.token }
          : {},
      format: capabilities.media.formats[0]!,
    },
    callbacks: {
      status: callback('status'),
      answer: callback('answer'),
      amd: callback('amd'),
      resume: callback('resume'),
    },
    ringTimeoutSec,
    maxDurationSec: (selected.release.config.costPolicy?.maxCallSeconds ?? 1800) + 30,
  };
}
