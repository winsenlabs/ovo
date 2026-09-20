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
