import { randomUUID } from 'node:crypto';
import {
  ExternalDecisionResponse,
  ROUTE_DECISION_SCHEMA,
  RoutingEngineError,
  type RouteContext,
  type RoutingHost,
  type SecretResolver,
} from '@winsendotai/ovo-contracts';
import {
  createPinnedFetch,
  ResponseBodyLimitError,
  type SecureNetworkDependencies,
} from '@winsendotai/ovo-plugin-tools-http';
import { ConnectorPolicyError } from '@winsendotai/ovo-plugin-kit';
import { webhookSignature } from './human-queue/signature.ts';

/** The most an external decision webhook may answer. */
export const EXTERNAL_DECISION_MAX_BYTES = 16 * 1024;

type ExternalInput = Parameters<RoutingHost['external']>[0];

export interface ExternalRouteOptions {
  /** `OVO_ROUTING_EXTERNAL_ENABLED`: off, every external engine reports `disabled`. */
  enabled: boolean;
  workspaceId: string;
  /** The router agent's resolver: its credential policy must allow the webhook secret. */
  secrets: SecretResolver;
  call: RoutingHost['call'];
  /** Test injection (DNS lookup, fetch); production resolves and pins with Undici. */
  network?: Pick<SecureNetworkDependencies, 'lookup' | 'fetch'>;
  now?: () => number;
  requestId?: () => string;
  /**
   * Marks the request as a simulation (`simulated: true` in the body, additive to
   * `ovo.route-decision/1`), so a receiver can tell a route tester's call from a caller's.
   * Only the console's route tester sets it, with a `callId` that starts `sim-`.
   */
  simulated?: boolean;
}

/**
 * `v1=<hex HMAC-SHA256(secret, "<timestamp>.<requestId>.<body>")>` (routing design 7.6): the one
 * scheme every OVO webhook is signed with (`webhookSignature` in the session host).
 */
export const routeDecisionSignature = webhookSignature;

/**
 * Asks an external decision engine for a branch (`ovo.route-decision/1`): one signed HTTPS POST
 * to a public, DNS-pinned address, no redirects, within the engine's timeout, reading at most
 * 16 KiB. The secret and the egress stay in the worker; the router plugin sees only the parsed
 * answer, or a `RoutingEngineError` whose message is the reason code it records.
 */
export async function callExternalRouteEngine(
  options: ExternalRouteOptions,
  input: ExternalInput,
  signal: AbortSignal,
): Promise<ExternalDecisionResponse> {
  if (!options.enabled) throw new RoutingEngineError('disabled', 'disabled');
  const { engine } = input;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(engine.timeoutMs)]);
  const work = exchange(options, input, deadline);
  const expired = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new RoutingEngineError('timeout', 'timeout'));
    if (deadline.aborted) fail();
    deadline.addEventListener('abort', fail, { once: true });
  });
  // A slow DNS answer or secret read counts against the same deadline as the request.
  work.catch(() => undefined);
  return Promise.race([work, expired]);
}

async function exchange(
  options: ExternalRouteOptions,
  input: ExternalInput,
  signal: AbortSignal,
): Promise<ExternalDecisionResponse> {
  const { engine } = input;
  let secret: string;
  try {
    secret = await options.secrets.resolve(options.workspaceId, engine.credentialId);
  } catch {
    throw new RoutingEngineError('transport', 'credential_unavailable');
  }
  const requestId = options.requestId?.() ?? randomUUID();
  const now = options.now?.() ?? Date.now();
  const body = JSON.stringify(requestBody(options, input, requestId, now));
  const timestamp = String(Math.floor(now / 1000));
  let pinned;
  try {
    pinned = await createPinnedFetch(engine.endpoint, {
      ...options.network,
      maxResponseBytes: EXTERNAL_DECISION_MAX_BYTES,
    });
  } catch (error) {
    throw transportError(error);
  }
  try {
    const response = await pinned
      .fetch(engine.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ovo-request-id': requestId,
          'x-ovo-timestamp': timestamp,
          'x-ovo-signature': routeDecisionSignature(secret, timestamp, requestId, body),
        },
        body,
        signal,
      })
      .catch((error: unknown) => {
        throw transportError(error);
      });
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => undefined);
      throw new RoutingEngineError('transport', `http_${response.status}`);
    }
    const text = await response.text().catch((error: unknown) => {
      throw transportError(error);
    });
    return decisionFrom(text, input);
  } finally {
    await pinned.dispose();
  }
}

function requestBody(
  { call, simulated }: Pick<ExternalRouteOptions, 'call' | 'simulated'>,
  input: ExternalInput,
  requestId: string,
  now: number,
): Record<string, unknown> {
  const { engine, turn } = input;
  const sent: { text?: string; digits?: string } = {};
  if (engine.send.turnText && turn?.text !== undefined) sent.text = turn.text;
  if (turn?.digits !== undefined) sent.digits = turn.digits;
  const variables = Object.fromEntries(
    engine.send.variables
      .filter((name) => isScalar(call.variables[name]))
      .map((name) => [name, call.variables[name]]),
  );
  return {
    schema: ROUTE_DECISION_SCHEMA,
    requestId,
    routingPointId: call.routingPointId,
    routingReleaseId: call.routingReleaseId,
    node: input.node,
    callId: call.callId,
    sentAt: new Date(now).toISOString(),
    branches: [...input.branches],
    context: contextOf(input.context),
    ...(Object.keys(sent).length ? { turn: sent } : {}),
    ...(engine.send.callerId ? { caller: { from: call.from, to: call.to } } : {}),
    ...(engine.send.variables.length ? { variables } : {}),
    ...(simulated ? { simulated: true } : {}),
  };
}

function decisionFrom(text: string, input: ExternalInput): ExternalDecisionResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RoutingEngineError('invalid', 'invalid');
  }
  const parsed = ExternalDecisionResponse.safeParse(raw);
  if (!parsed.success) throw new RoutingEngineError('invalid', 'invalid');
  const decision = parsed.data;
  if (decision.branch !== null && !input.branches.includes(decision.branch))
    throw new RoutingEngineError('invalid', 'unknown_branch');
  if (Object.keys(decision.slots).some((key) => !input.engine.slots.includes(key)))
    throw new RoutingEngineError('invalid', 'slot_not_allowed');
  return decision;
}

/** The reason code a transport failure is recorded with; never a URL, host or message. */
function transportError(error: unknown): RoutingEngineError {
  if (error instanceof RoutingEngineError) return error;
  if (error instanceof ResponseBodyLimitError)
    return new RoutingEngineError('transport', 'oversize');
  if (error instanceof ConnectorPolicyError) return new RoutingEngineError('transport', 'policy');
  if (error instanceof Error && /redirect/i.test(error.message))
    return new RoutingEngineError('transport', 'redirect');
  if (error instanceof Error && error.name === 'AbortError')
    return new RoutingEngineError('timeout', 'timeout');
  return new RoutingEngineError('transport', 'transport');
}

function contextOf(context: RouteContext): Record<string, unknown> {
  return { ...(context.language ? { language: context.language } : {}), values: context.values };
}

function isScalar(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}
