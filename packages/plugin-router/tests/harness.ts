import {
  readSessionEvent,
  type EventSink,
  type RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import { RouterBehavior } from '../src/behavior.ts';
import { RouterCore } from '../src/core.ts';
import { createRulesRunner } from '../src/engines/index.ts';
import {
  exampleRoutingSnapshot,
  fakeRoutingHost,
  fakeSegmentHandoffPort,
  scriptedEngines,
  type EngineScript,
} from '../src/testing.ts';

/** An event sink that checks every event is storable (`readSessionEvent`, §4.9 and AGT-8). */
export function checkedSink() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const sink: EventSink = {
    append: async (type, payload) => {
      readSessionEvent(type, payload);
      events.push({ type, payload });
    },
  };
  return { sink, events };
}

export type Harness = ReturnType<typeof routerHarness>;

/**
 * A router behaviour over fakes: the example snapshot (or `patch`ed), a fake host on a fake clock
 * (Thursday noon in Kolkata), a fake handoff port, scripted engines with the real rules engine, and
 * a checked event sink.
 */
export function routerHarness(
  options: {
    patch?: (raw: Record<string, any>) => void;
    snapshot?: RoutingReleaseSnapshot;
    script?: EngineScript;
    host?: Parameters<typeof fakeRoutingHost>[0];
    handoff?: Parameters<typeof fakeSegmentHandoffPort>[0];
  } = {},
) {
  const snapshot = options.snapshot ?? exampleRoutingSnapshot(options.patch);
  const host = fakeRoutingHost({ start: Date.UTC(2026, 9, 15, 6, 30), ...options.host });
  const handoff = fakeSegmentHandoffPort(options.handoff);
  const engines = scriptedEngines(options.script ?? {}, { rules: createRulesRunner(host) });
  const { sink, events } = checkedSink();
  const core = new RouterCore(snapshot, {
    host,
    handoff,
    runners: engines.runners,
    events: sink,
    timezone: 'Asia/Kolkata',
  });
  const behavior = new RouterBehavior(core);
  let epoch = 0;
  /** One engine turn: `beginTurn` with a new epoch, then `respond`. */
  const turn = async (input: string, variables: Record<string, unknown> = {}) => {
    behavior.beginTurn(++epoch);
    return { say: await behavior.respond(input, variables), epoch };
  };
  const receipt = (at: number, state: 'completed' | 'interrupted' = 'completed', text = '') =>
    behavior.onPlayback({ id: `r${at}`, text, epoch: at, state, evidence: 'simulated' });
  const types = () => events.map((event) => event.type);
  const of = (type: string) => events.filter((event) => event.type === type).map((e) => e.payload);
  return { snapshot, host, handoff, engines, events, core, behavior, turn, receipt, types, of };
}

export const opening = { inputEvent: 'opening' };
export const idle = { inputEvent: 'idle' };
export const dtmf = (digits: string) => ({ inputEvent: 'dtmf', digits });
