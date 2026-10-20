import { describe, expect, it } from 'vitest';
import { describeTurnDetector } from '@winsendotai/ovo-conformance';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { Cap, type TurnDetectorFactory } from '@winsendotai/ovo-contracts';
import { compose } from '@winsendotai/ovo-runtime';
import {
  createModelTurnDetector,
  modelDetectorSchema,
  modelTurnDetectorPlugin,
  turnShadowTelemetry,
  type TurnShadowEvent,
} from '../src/index.ts';
import { fakeModel, gateFixture, scribe, syncModel } from './model-gate-fixture.ts';

const fixture = gateFixture(() => new FakeClock());

/** A shadow detector, collecting what it reports. */
function shadow(
  model: Parameters<typeof fixture>[0],
  row: Record<string, unknown> = {},
  language = 'en-IN',
) {
  const events: TurnShadowEvent[] = [];
  const f = fixture(model, { mode: 'shadow', ...row }, language, {
    onShadow: (event) => events.push(event),
  });
  return { ...f, events };
}

describeTurnDetector('model gate in shadow mode (a model that holds every turn)', () =>
  createModelTurnDetector({ mode: 'shadow' }, syncModel(0)),
);

describe('model detector, shadow mode', () => {
  it('ends the turn exactly as the rules do, however the model reads it', async () => {
    const f = shadow(fakeModel(0.05));
    f.say('We are going to Budapest and Vienna.');
    await f.wait(1500);
    // The rules detector alone ends it at the same moment, with the same decision.
    const rules = fixture(fakeModel(1), { mode: 'shadow' });
    rules.say('We are going to Budapest and Vienna.');
    await rules.wait(1500);
    expect(f.stops()).toEqual([
      { text: 'We are going to Budapest and Vienna.', reason: 'complete' },
    ]);
    expect(f.decisions).toEqual(rules.decisions);
  });

  it('reports a turn the model would have ended too as ended, at once', async () => {
    const f = shadow(fakeModel(0.9));
    f.say('What is the capital of Croatia?');
    await f.wait(1000);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      language: 'en-IN',
      rules: { reason: 'complete', words: 6, segments: 1 },
      model: { name: 'fake', threshold: 0.5, probability: 0.9, decision: 'end', basis: 'model' },
      outcome: 'ended',
      afterMs: 0,
    });
    // Words are never in the report.
    expect(JSON.stringify(f.events[0])).not.toContain('Croatia');
  });

  it('reports a turn the model would have held and the caller went on with as continued', async () => {
    const f = shadow(fakeModel(0.1));
    f.say('We are going to Budapest and Vienna.');
    await f.wait(1200);
    expect(f.events).toEqual([]);
    expect(f.stops()).toHaveLength(1);
    f.say('Zagreb too.');
    await f.wait(2000);
    expect(f.events[0]).toMatchObject({
      model: { decision: 'hold', probability: 0.1 },
      outcome: 'continued',
    });
    expect(f.events[0]!.afterMs).toBeGreaterThan(0);
    // The caller's second part is a turn of its own: the rules did split it.
    expect(f.stops().map((s) => s.text)).toEqual([
      'We are going to Budapest and Vienna.',
      'Zagreb too.',
    ]);
    expect(f.controller.stats.merged).toBe(1);
  });

  it('reports a held turn nobody continued as expired after holdMs', async () => {
    const f = shadow(fakeModel(0.1), { model: { holdMs: 2000 } });
    f.say('I was thinking that maybe we could go');
    await f.wait(1000);
    expect(f.events).toEqual([]);
    await f.wait(2500);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ outcome: 'expired' });
    expect(f.events[0]!.afterMs).toBeGreaterThanOrEqual(2000);
  });

  it('reads a held turn again as the silence grows and reports when it would have released', async () => {
    let silence = 0;
    const model = fakeModel(() => (silence++ >= 3 ? 0.9 : 0.1), 'audio');
    const f = shadow(model, { model: { recheckMs: 300, holdMs: 3000 } });
    f.say('So what I wanted to ask is');
    // Audio the model reads: the caller's turn, then silence.
    for (let ms = 0; ms < 3000; ms += 20) {
      f.controller.audio(new Int16Array(320), 16000);
      await f.wait(20);
    }
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ outcome: 'released' });
    expect(f.events[0]!.model.rechecks.length).toBeGreaterThanOrEqual(1);
    expect(f.events[0]!.afterMs).toBeLessThan(3000);
    expect(f.controller.stats.released).toBe(1);
  });

  it('does not read what it should not: short answers, a language it lacks', async () => {
    const model = fakeModel(0.01);
    const f = shadow(model);
    f.say('Yes.');
    await f.wait(1200);
    expect(f.events[0]).toMatchObject({ model: { decision: 'end', basis: 'short-answer' } });
    expect(model.requests).toEqual([]);
    const tamil = shadow(model, {}, 'ta-IN');
    tamil.say('நான் நாளை வருகிறேன்');
    await tamil.wait(1200);
    expect(tamil.events[0]).toMatchObject({ model: { basis: 'language' }, outcome: 'ended' });
  });

  it('sees a failing model as no opinion, never as a hold, and counts it', async () => {
    const model = fakeModel(0.5);
    model.predict = () => Promise.reject(new Error('inference failed'));
    const f = shadow(model);
    f.say('We are going to Budapest and Vienna.');
    await f.wait(1200);
    expect(f.events[0]).toMatchObject({ model: { decision: 'end', basis: 'failure' } });
    expect(f.controller.stats.failures).toBe(1);
    expect(f.stops()).toHaveLength(1);
  });

  it('gives up on a reading slower than timeoutMs', async () => {
    const model = fakeModel(0.5);
    model.predict = () => new Promise(() => {});
    const f = shadow(model, { model: { timeoutMs: 200 } });
    f.say('We are going to Budapest and Vienna.');
    // The reading never settles, so the clock is advanced without waiting on it.
    f.clock.advance(1200);
    expect(f.events[0]).toMatchObject({ model: { decision: 'end', basis: 'timeout' } });
    expect(f.controller.stats.timeouts).toBe(1);
  });

  it('threshold decides the reading: the same probability ends at 0.3, holds at 0.5', async () => {
    const run = async (threshold: number) => {
      const f = shadow(fakeModel(0.4), { model: { threshold, holdMs: 1000 } });
      f.say('We are going to Budapest and Vienna.');
      await f.wait(2500);
      return f.events[0]!;
    };
    expect(await run(0.3)).toMatchObject({ model: { decision: 'end', threshold: 0.3 } });
    expect(await run(0.5)).toMatchObject({ model: { decision: 'hold', threshold: 0.5 } });
  });

  it('abandons a held turn when the call ends', async () => {
    const f = shadow(fakeModel(0.1));
    f.say('We are going to Budapest and Vienna.');
    await f.wait(1200);
    f.controller.dispose();
    expect(f.events.at(-1)).toMatchObject({ outcome: 'abandoned' });
  });
});

describe('model detector, active mode faults', () => {
  it('ends the turn as the rules did and reports the fault when a reading fails', async () => {
    const model = fakeModel(0.5);
    model.predict = () => Promise.reject(new Error('inference failed'));
    const faults: string[] = [];
    const clock = new FakeClock();
    const controller = createModelTurnDetector({ mode: 'active' }, model, {
      onFault: (fault) => faults.push(fault),
    }).create({ clock, vad: true, language: 'en-IN', mode: 'agent', stt: scribe });
    controller.observe({ type: 'bot.started', epoch: 0, atMs: 0, kind: 'response' });
    controller.observe({ type: 'bot.stopped', epoch: 0, atMs: 0, kind: 'response' });
    const f = fixture(model, { mode: 'active' }, 'en-IN', {
      onFault: (fault) => faults.push(fault),
    });
    f.say('We are going to Budapest and Vienna.');
    await f.wait(1500);
    expect(f.stops()).toEqual([
      { text: 'We are going to Budapest and Vienna.', reason: 'complete' },
    ]);
    expect(faults).toEqual(['failure']);
    controller.dispose();
  });
});

describe('model detector plugin: production selection', () => {
  const input = {
    clock: new FakeClock(),
    vad: true,
    language: 'en-IN',
    mode: 'agent',
    stt: scribe,
  };
  const factoryOf = async (plugin: ReturnType<typeof modelTurnDetectorPlugin>, config = {}) => {
    const graph = await compose([{ id: plugin.manifest.id, config }], [plugin], {
      scope: 'session',
    });
    return {
      graph,
      factory: graph.get(Cap.turnDetector) as TurnDetectorFactory,
    };
  };

  it('defaults to shadow, with the recheck and threshold the bake-off recommends', async () => {
    turnShadowTelemetry.reset();
    const requests: unknown[] = [];
    const model = fakeModel((request) => (requests.push(request), 0.1));
    const plugin = modelTurnDetectorPlugin(
      { id: '@winsendotai/ovo-turn-detector-test-model', provider: 'test' },
      async () => model,
      { mode: 'shadow', recheckMs: 300, threshold: 0.3 },
    );
    const { graph, factory } = await factoryOf(plugin);
    try {
      const controller = factory.create(input as Parameters<TurnDetectorFactory['create']>[0]);
      // Shadow: a model that always says "hold" changes nothing about the rules' turn.
      const decisions: string[] = [];
      controller.on((decision) => decisions.push(decision.type));
      controller.dispose();
    } finally {
      await graph.dispose();
    }
    const schema = modelDetectorSchema({ mode: 'shadow', recheckMs: 300, threshold: 0.3 });
    const parsed = schema.parse({});
    expect(parsed).toMatchObject({ mode: 'shadow', model: { recheckMs: 300, threshold: 0.3 } });
    expect(schema.parse({ mode: 'active', model: { recheckMs: 0 } })).toMatchObject({
      mode: 'active',
      model: { recheckMs: 0, threshold: 0.3 },
    });
  });

  it('active mode switches the rules trailing-word holds off', async () => {
    const plugin = modelTurnDetectorPlugin(
      { id: '@winsendotai/ovo-turn-detector-test-model', provider: 'test' },
      async () => fakeModel(0.9),
      { mode: 'shadow', recheckMs: 300, threshold: 0.3 },
    );
    // "...so I want to go to the" trails off: the rules hold it for cutoffHoldMs (700); active does not.
    const stopAfter = async (config: Record<string, unknown>) => {
      const { graph, factory } = await factoryOf(plugin, config);
      try {
        const clock = new FakeClock();
        const controller = factory.create({ ...input, clock } as Parameters<
          TurnDetectorFactory['create']
        >[0]);
        let stoppedAt: number | undefined;
        controller.on((d) => {
          if (d.type === 'turn.stopped') stoppedAt ??= clock.now();
        });
        controller.observe({ type: 'bot.started', epoch: 0, atMs: 0, kind: 'response' });
        controller.observe({ type: 'bot.stopped', epoch: 0, atMs: 0, kind: 'response' });
        controller.observe({ type: 'vad.start', atMs: clock.now() });
        controller.observe({
          type: 'stt',
          atMs: clock.now(),
          event: {
            type: 'transcript',
            segment: {
              segmentId: '0',
              revision: 1,
              text: 'so I want to go to the',
              stability: 'interim',
            },
          },
        });
        clock.advance(400);
        controller.observe({ type: 'vad.stop', atMs: clock.now() });
        for (let step = 0; step < 6000 && stoppedAt === undefined; step += 10) clock.advance(10);
        controller.dispose();
        return stoppedAt;
      } finally {
        await graph.dispose();
      }
    };
    const shadowStop = await stopAfter({ mode: 'shadow' });
    const activeStop = await stopAfter({ mode: 'active' });
    expect(shadowStop).toBeDefined();
    expect(activeStop).toBeDefined();
    expect(activeStop!).toBeLessThan(shadowStop!);
  });

  it('falls back to the rules, logged and counted, when the model cannot load', async () => {
    turnShadowTelemetry.reset();
    const plugin = modelTurnDetectorPlugin(
      { id: '@winsendotai/ovo-turn-detector-test-model', provider: 'test' },
      async () => {
        throw new Error('Smart Turn model file is missing');
      },
      { mode: 'active' },
    );
    for (let session = 0; session < 2; session++) {
      const { graph, factory } = await factoryOf(plugin, { mode: 'active' });
      try {
        // The agent still gets a working turn detector: the rules, with their holds on.
        const controller = factory.create(input as Parameters<TurnDetectorFactory['create']>[0]);
        expect(controller.audio).toBeUndefined();
        controller.dispose();
      } finally {
        await graph.dispose();
      }
    }
    // One failed load (retried only after retryLoadMs), two sessions given the rules.
    expect(turnShadowTelemetry.snapshot()).toMatchObject({
      modelUnavailable: 1,
      sessionFallbacks: 2,
    });
  });

  it('does not make a session wait on a model that is slow to load', async () => {
    turnShadowTelemetry.reset();
    const plugin = modelTurnDetectorPlugin(
      { id: '@winsendotai/ovo-turn-detector-test-model', provider: 'test' },
      () => new Promise(() => {}),
      { mode: 'active', loadWaitMs: 50 },
    );
    const { graph, factory } = await factoryOf(plugin);
    try {
      expect(
        factory.create(input as Parameters<TurnDetectorFactory['create']>[0]).audio,
      ).toBeUndefined();
    } finally {
      await graph.dispose();
    }
    expect(turnShadowTelemetry.snapshot().sessionFallbacks).toBe(1);
  });
});
