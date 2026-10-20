import type { SimulationRequest, SimulationStep } from '../wire/index.ts';

/** A route event as the recorder kept it. */
export interface RecordedEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * A recorded event as a simulation step. The route.* events, dispositions and disclosures are the
 * trace; a `route.node` from a scripted engine is `mocked`, so the console can say which verdicts
 * were authored and which the router reached by itself.
 */
export function stepsOf(
  event: RecordedEvent,
  modes: SimulationRequest['engines']['mode'],
): SimulationStep[] {
  const payload = structuredClone(event.payload);
  switch (event.type) {
    case 'route.node': {
      const engine = payload.engine as string;
      const scripted = engine === 'decision' || engine === 'llm' || engine === 'external';
      return [
        { type: event.type, payload, mocked: scripted && modes[engine] === 'mock' },
      ] as SimulationStep[];
    }
    case 'route.fallback':
    case 'route.decision':
    case 'disposition':
    case 'disclosure':
      return [{ type: event.type, payload }] as SimulationStep[];
    default:
      return [];
  }
}
