import {
  DecisionRequest,
  type Clock,
  type DecisionPort,
  type DecisionResponse,
  type NetPort,
  type UsageMeter,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import {
  abortError,
  decimal,
  isAbortError,
  readBoundedJson,
  syntheticRequestId,
  usageOnce,
  withDeadline,
} from '@winsendotai/ovo-plugin-kit';
import type { ResolvedJevBinding } from './binding.ts';
import {
  JevProtocolError,
  JevRequestError,
  JevTimeoutError,
  readUsage,
  toDecisionResponse,
  toJevBody,
  type JevUsage,
} from './wire.ts';

export const PROVIDER = 'typesafe';
export const METER_INPUT_TOKENS = 'typesafe.decision.input_tokens';

const MAX_BODY_BYTES = 1_048_576;

export interface JevDecisionOptions {
  sessionId?: string;
  clock?: Pick<Clock, 'setTimeout' | 'now'>;
}

const elapsed = (clock: JevDecisionOptions['clock'], from: number) =>
  clock ? Math.max(0, clock.now() - from) : 0;

/**
 * EXACTLY ONE meter per `decide()` — on success, on a vendor refusal, on a timeout and on a caller
 * abort. `reconciled` when the vendor reported a usage block, `estimated` when it did not (there is
 * nothing to reconcile against), so the ledger separates a priced decision from a failed one.
 *
 * Only `input_tokens` is metered. The published document calls `output_tokens` "Number of output
 * tokens used to answer the questions" against `input_tokens`'s "Number of BILLABLE input tokens",
 * so output is free; and `decision@1`'s `usage is emitted at most once per decision` check counts
 * sink calls, so a second unit per decision would fail it. The number is still read and validated
 * off the body (`readUsage`), so adding it is a one-line change if it ever starts billing.
 */
function meters(
  usage: JevUsage | undefined,
  requestId: string,
  elapsedMs: number,
): readonly UsageMeter[] {
  const state: UsageMeter['state'] = usage ? 'reconciled' : 'estimated';
  return [
    {
      provider: PROVIDER,
      operation: 'decision',
      state,
      requestId,
      elapsedMs,
      unit: 'input_tokens',
      quantity: decimal(usage?.input_tokens ?? 0),
    },
  ];
}

/**
 * The `DecisionPort` over TypeSafe System One. It never thresholds, never caches, never falls back
 * and never returns a substitute answer: on any failure it reports and the caller decides.
 */
export function jevDecision(
  net: Pick<NetPort, 'fetch'>,
  apiKey: string,
  binding: ResolvedJevBinding,
  usage?: UsageSink,
  options: JevDecisionOptions = {},
): DecisionPort {
  const sessionId = options.sessionId ?? 'session';
  const clock = options.clock;
  let calls = 0;

  return {
    async decide(rawRequest, callOptions): Promise<DecisionResponse> {
      const request = DecisionRequest.parse(rawRequest);
      const count = Object.keys(request.questions).length;
      if (count > binding.maxQuestionsPerRequest)
        throw new JevProtocolError(
          `Jev accepts at most ${binding.maxQuestionsPerRequest} questions per request (got ${count})`,
        );

      const requestId = syntheticRequestId(PROVIDER, sessionId, ++calls);
      const once = usage ? usageOnce(usage) : undefined;
      const startedAt = clock?.now() ?? 0;
      const caller = callOptions.signal;
      caller.throwIfAborted();
      const deadline = withDeadline(caller, binding.timeoutMs, 'Jev decision timed out', clock);
      const report = (reported: JevUsage | undefined) =>
        once?.emit(meters(reported, requestId, elapsed(clock, startedAt)));

      try {
        let response: Response;
        try {
          response = await net.fetch(binding.endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify(toJevBody(request, binding.model)),
            signal: deadline.signal,
          });
        } catch (error) {
          report(undefined);
          if (caller.aborted) throw abortError(caller);
          if (deadline.signal.aborted || isAbortError(error))
            throw new JevTimeoutError(`Jev decision timed out after ${binding.timeoutMs}ms`);
          throw error;
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          report(undefined);
          // 429 and 5xx may succeed later; 401/403 and every other 4xx will not. The published
          // document lists only 200 and 422, so this is decided on the status alone (UNCONFIRMED).
          const retryable = response.status === 429 || response.status >= 500;
          throw new JevRequestError(
            `Jev decision failed with HTTP ${response.status}`,
            response.status,
            retryable,
          );
        }

        let body: Record<string, unknown>;
        try {
          body = await readBounded(response);
        } catch (error) {
          report(undefined);
          if (caller.aborted) throw abortError(caller);
          throw error;
        }

        // Usage is read BEFORE validation, so a malformed answer set is still metered: the vendor
        // billed for the tokens whether or not the body satisfies the contract.
        const reported = readUsage(body);
        report(reported);
        return toDecisionResponse(request, body, binding.calibrationLabel);
      } finally {
        deadline.dispose();
        // A failure that reached none of the branches above still owes exactly one meter.
        report(undefined);
      }
    },
  };
}

/** `readBoundedJson` from the kit, with its failures renamed so a caller sees one error family. */
async function readBounded(response: Response): Promise<Record<string, unknown>> {
  try {
    return await readBoundedJson(response, MAX_BODY_BYTES);
  } catch (error) {
    throw new JevProtocolError(
      `Jev response body is unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
