import { compose } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import {
  createFocusedOvoCompositionSpec,
  createLiveKitCompositionSpec,
  expectExperimentService,
  FAQ_ANSWER,
  FAQ_INPUT,
  LIVEKIT_LOCAL_INFERENCE_MODELS_ENABLED,
  VOICE_EXPERIMENT_SERVICE,
  type ExperimentCompositionSpec,
  type ScenarioResult,
} from '../src/index.ts';

expect(LIVEKIT_LOCAL_INFERENCE_MODELS_ENABLED).toBe(false);

const candidates = [
  ['focused OVO production plugins', createFocusedOvoCompositionSpec],
  ['LiveKit AgentSession', createLiveKitCompositionSpec],
] as const;

async function withEngine<T>(
  spec: ExperimentCompositionSpec,
  run: (engine: ReturnType<typeof expectExperimentService>) => Promise<T>,
) {
  const composition = await compose(spec.rows, spec.catalog);
  try {
    return await run(expectExperimentService(composition.ctx.get(VOICE_EXPERIMENT_SERVICE)));
  } finally {
    await composition.dispose();
    await composition.dispose();
  }
}

function sequence(result: ScenarioResult, type: string): number {
  const event = result.trace.find((entry) => entry.type === type);
  if (!event) throw new Error(`missing trace event: ${type}`);
  return event.sequence;
}

describe.each(candidates)('%s comparative fixture', (_label, createSpec) => {
  it('mounts through the DeepSeek-derived compose/definePlugin foundation', async () => {
    await withEngine(createSpec(), async (engine) => {
      expect(engine.candidate).toMatch(/focused-ovo|livekit-agent-session/);
    });
  });

  it('answers the deterministic FAQ without an LLM request', async () => {
    const result = await withEngine(createSpec(), (engine) => engine.runFaq(FAQ_INPUT));

    expect(result.answer).toBe(FAQ_ANSWER);
    expect(result.modelRequests).toBe(0);
    expect(result.toolAttempts).toBe(0);
    expect(result.trace.map((event) => event.type)).not.toContain('model.requested');
  });

  it('orders acknowledgment before one tool attempt and blocks post-takeover speech', async () => {
    const result = await withEngine(createSpec(), (engine) => engine.runInterruptToolScenario());

    expect(result.toolAttempts).toBe(1);
    expect(result.operationState).toBe('succeeded');
    expect(result.stalePlaybackCount).toBe(0);
    expect(sequence(result, 'operation.intent.simulated-memory')).toBeLessThan(
      sequence(result, 'operation.running.simulated-memory'),
    );
    expect(sequence(result, 'acknowledgment.completed')).toBeLessThan(
      sequence(result, 'caller.takeover'),
    );
    expect(sequence(result, 'operation.running.simulated-memory')).toBeLessThan(
      sequence(result, 'caller.takeover'),
    );
    expect(sequence(result, 'caller.takeover')).toBeLessThan(
      sequence(result, 'operation.succeeded.simulated-memory'),
    );
    expect(sequence(result, 'turn.cancelled')).toBeLessThan(
      sequence(result, 'tool.result.stale.blocked'),
    );
  });
});

it('keeps SDK tool-loop ownership explicit and singular', async () => {
  const results = await Promise.all(
    candidates.map(([, createSpec]) =>
      withEngine(createSpec(), (engine) => engine.runInterruptToolScenario()),
    ),
  );

  expect(results.map((result) => result.toolOwner)).toEqual([
    'ovo-execution',
    'livekit-agent-session',
  ]);
  expect(results.every((result) => result.toolAttempts === 1)).toBe(true);
});

it('reuses one LiveKit AgentSession across hot-path calls', async () => {
  await withEngine(createLiveKitCompositionSpec(), async (engine) => {
    await engine.runFaq();
    const second = await engine.runFaq();
    expect(second.trace.map((event) => event.type)).toContain('livekit.agent-session.reused');
    expect(second.trace.map((event) => event.type)).not.toContain(
      'livekit.agent-session.constructed',
    );
  });
});
