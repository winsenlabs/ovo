import {
  ExternalDecisionResponse,
  RoutingEngineError,
  type RoutingEngine,
  type RoutingHost,
} from '@winsendotai/ovo-contracts';
import {
  branchKeys,
  EngineTimeout,
  withDeadline,
  type EngineInput,
  type EngineResult,
  type EngineRunner,
} from './types.ts';

type ExternalEngine = Extract<RoutingEngine, { kind: 'external' }>;

/** A host error code safe to record (`http_503`, `redirect`, `policy`); anything else is its kind. */
const CODE = /^[a-z][a-z0-9_]{0,59}$/;
/** Grace over the engine's own timeout, so the host's bound (which knows the transport) fires first. */
const GRACE_MS = 250;

function fromHostError(error: RoutingEngineError): EngineResult {
  if (error.kind === 'timeout') return { outcome: 'timeout' };
  if (error.kind === 'disabled') return { outcome: 'disabled', reason: 'external_disabled' };
  const reason = CODE.test(error.message) ? error.message : error.kind;
  return { outcome: 'error', reason };
}

/**
 * The external decision engine (§7.6). The host signs and sends the webhook (the secret and the
 * egress policy never reach this plugin); this adapter decides what the host may send, bounds the
 * wait, and judges the answer: a branch the node lacks is an `error` (`unknown_branch`), a null
 * branch is `no_match`, a confidence under the threshold is `low_confidence`, and only slots in the
 * engine's allow-list survive. The caller's words go only with `send.turnText`.
 */
export function createExternalRunner(
  host: Pick<RoutingHost, 'external'>,
): EngineRunner<'external'> {
  return async (engine: ExternalEngine, input: EngineInput): Promise<EngineResult> => {
    const branches = branchKeys(input.node);
    const turn = engine.send.turnText && input.turn ? { ...input.turn } : undefined;
    let raw: unknown;
    try {
      raw = await withDeadline(engine.timeoutMs + GRACE_MS, input.signal, (signal) =>
        host.external(
          {
            node: input.node.id,
            engine,
            ...(turn ? { turn } : {}),
            context: input.context,
            branches,
          },
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof EngineTimeout) return { outcome: 'timeout' };
      input.signal.throwIfAborted();
      if (error instanceof RoutingEngineError) return fromHostError(error);
      return { outcome: 'error', reason: 'external_failed' };
    }
    const parsed = ExternalDecisionResponse.safeParse(raw);
    if (!parsed.success) return { outcome: 'error', reason: 'invalid' };
    const { branch, confidence } = parsed.data;
    if (branch === null) return { outcome: 'no_match', reason: 'external_no_branch' };
    if (!branches.includes(branch)) return { outcome: 'error', reason: 'unknown_branch' };
    const allowed = new Set(engine.slots);
    const slots = Object.fromEntries(
      Object.entries(parsed.data.slots).filter(([key]) => allowed.has(key)),
    );
    return {
      outcome: confidence >= engine.threshold ? 'matched' : 'low_confidence',
      branch,
      confidence,
      ...(Object.keys(slots).length ? { slots } : {}),
    };
  };
}
