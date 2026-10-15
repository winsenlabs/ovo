import { filterDeclaredVariables, type AgentConfig } from '@winsendotai/ovo-contracts';

/**
 * The variable schema of the release a callback dials, or undefined when it cannot be read (the
 * live-call route then refuses the unknown release itself).
 */
export type DialledReleaseConfig = (
  releaseId: string,
) => Promise<Pick<AgentConfig, 'variables'> | undefined>;

/** What `POST /v1/calls` needs to dial a callback: the same release, numbers swapped for inbound. */
export interface CallbackDial {
  operationId: string;
  releaseId: string;
  to: string;
  fromNumber: string;
  variables: Record<string, string>;
}

/**
 * The caller of an inbound call is called back from the number they dialled; outbound repeats.
 * The release is the one that promised the callback when it was stamped (a routed call's agent),
 * else the call's own (`COALESCE(callback.release_id, call.release_id)`).
 */
export function dialFromJob(
  job: Record<string, unknown>,
  callbackReleaseId?: string | null,
): Omit<CallbackDial, 'operationId'> | undefined {
  const text = (key: string) => (typeof job[key] === 'string' && job[key] ? job[key] : undefined);
  const releaseId = callbackReleaseId ?? text('releaseId');
  const inbound = job.kind === 'inbound_call';
  const to = inbound ? text('from') : text('to');
  const fromNumber = inbound ? text('to') : text('from');
  if (!releaseId || !to || !fromNumber) return undefined;
  const raw = job.variables && typeof job.variables === 'object' ? job.variables : {};
  const variables = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => [key, String(value)]),
  );
  return { releaseId, to, fromNumber, variables };
}

/**
 * The dial with only the variables the dialled release declares (R1 audit 2). A routed call
 * carries the router's variables, which a member or default agent with a closed schema would
 * refuse with 422; the values are the strings a live call carries.
 */
export function declaredDial<T extends Pick<CallbackDial, 'variables'>>(
  dial: T,
  config: Pick<AgentConfig, 'variables'>,
): T {
  return {
    ...dial,
    variables: filterDeclaredVariables(config, dial.variables) as Record<string, string>,
  };
}
