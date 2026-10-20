import type { RouteNodePayload, RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import type { z } from 'zod';
import { SimulationRequest } from '../src/wire/index.ts';
import { simulateRoute, type SimulateInput } from '../src/simulate/index.ts';

/** Thursday 2026-10-15 noon in Kolkata (the Tamil agent's office is open). */
export const NOON = Date.UTC(2026, 9, 15, 6, 30);
/** The same Thursday at 22:30 in Kolkata (closed). */
export const NIGHT = Date.UTC(2026, 9, 15, 17, 0);

const Body = SimulationRequest.omit({ target: true });
export type SimBody = z.input<typeof Body>;

/** A parsed simulation request body (defaults applied) from the parts a test cares about. */
export const simRequest = (body: SimBody = {}) => Body.parse(body);

/** `simulateRoute` over `snapshot` with the Kolkata noon clock, transfers off and human queues on. */
export function simulate(
  snapshot: RoutingReleaseSnapshot,
  body: SimBody = {},
  over: Partial<Omit<SimulateInput, 'snapshot' | 'request'>> = {},
) {
  return simulateRoute({
    snapshot,
    request: simRequest(body),
    now: NOON,
    router: { timezone: 'Asia/Kolkata' },
    flags: { transferEnabled: false, humanQueueEnabled: true },
    ...over,
  });
}

/** The route.node payloads of a run, with whether each verdict was scripted. */
export function nodeSteps(run: Awaited<ReturnType<typeof simulate>>) {
  return run.turns.flatMap((turn) =>
    turn.steps.flatMap((step) =>
      step.type === 'route.node'
        ? [{ ...step.payload, mocked: step.mocked } as RouteNodePayload & { mocked: boolean }]
        : [],
    ),
  );
}

export const speech = (text: string) => ({ kind: 'speech' as const, text });
export const dtmf = (digits: string) => ({ kind: 'dtmf' as const, digits });
export const silence = { kind: 'silence' as const };

/** The route.* steps of a run, flattened, as `type:detail` for compact assertions. */
export function trace(run: Awaited<ReturnType<typeof simulate>>): string[] {
  return run.turns.flatMap((turn) =>
    turn.steps.map((step) => {
      const p = step.payload as Record<string, any>;
      if (step.type === 'route.node')
        return `node:${p.node}:${p.engine}:${p.outcome}${p.branch ? `>${p.branch}` : ''}`;
      if (step.type === 'route.fallback')
        return `fallback:${p.step}:${p.result}${p.reason ? `(${p.reason})` : ''}`;
      return step.type;
    }),
  );
}
