import { createAgentBehaviorPlugin, createFaqBehavior } from '@winsendotai/ovo-behaviors';
import { AgentConfig, type Behavior, type Execution } from '@winsendotai/ovo-contracts';
import { createAiSdkInferencePlugin } from '@winsendotai/ovo-plugin-inference';
import { createExecutionPlugin, createNativeToolsPlugin } from '@winsendotai/ovo-plugin-tools';
import {
  BoundedSpeechScheduler,
  createSimulatedSpeechOutputPlugin,
  createSpeechSchedulerPlugin,
  VOICE_SERVICE_KEYS,
} from '@winsendotai/ovo-plugin-voice';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  type ExperimentCompositionSpec,
  type ScenarioResult,
  VOICE_EXPERIMENT_SERVICE,
  type VoiceExperimentEngine,
  type VoiceExperimentPlugin,
} from './contracts.ts';
import {
  ControlledNativeTool,
  createMemoryOperationStorePlugin,
  DeterministicToolModel,
  MemoryOperationStore,
} from './focused-services.ts';
import { TraceRecorder } from './harness.ts';
import { FAQ_ANSWER, FAQ_INPUT } from './scenarios.ts';

const WORKSPACE_ID = 'workspace-fixture';
const SESSION_ID = 'session-fixture';
const TOOL_ID = 'check_balance';

const FAQ_AGENT = AgentConfig.parse({
  name: 'FAQ fixture',
  mode: 'faq',
  locale: 'en-US',
  faq: [
    {
      id: 'support-hours',
      question: FAQ_INPUT,
      aliases: ['When is support open?'],
      answer: FAQ_ANSWER,
    },
  ],
});

const TOOL = {
  id: TOOL_ID,
  description: 'Return the fixture account balance.',
  connector: 'native' as const,
  inputSchema: {
    type: 'object',
    required: ['account'],
    properties: { account: { type: 'string' } },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    required: ['balance'],
    properties: { balance: { type: 'number' } },
    additionalProperties: false,
  },
  effect: 'read' as const,
  confirmation: false,
  timeoutMs: 5_000,
  processing: {
    initial: 'Please wait while I check that.',
    progressAfterMs: 5_000,
    maxProgress: 0,
    failure: 'I could not complete that check.',
  },
};

const AGENT = AgentConfig.parse({
  name: 'Tool fixture',
  mode: 'agent',
  locale: 'en-US',
  context: 'Use the approved balance tool.',
  tools: [TOOL],
  allowedTools: [TOOL_ID],
  maxSteps: 2,
});

interface CancellableBehavior extends Behavior {
  cancel(reason?: string): void;
}

interface FocusedDependencies {
  behavior: CancellableBehavior;
  execution: Execution;
  scheduler: BoundedSpeechScheduler;
  model: DeterministicToolModel;
  store: MemoryOperationStore;
  nativeTool: ControlledNativeTool;
}

export class FocusedOvoEngine implements VoiceExperimentEngine {
  readonly candidate = 'focused-ovo-ai-sdk' as const;
  readonly #faq = createFaqBehavior(FAQ_AGENT);

  constructor(private readonly dependencies: FocusedDependencies) {}

  async runFaq(input = FAQ_INPUT): Promise<ScenarioResult> {
    const trace = new TraceRecorder();
    const modelRequests = this.dependencies.model.requests;
    trace.add('input.accepted', { mode: 'faq' });
    const answer = await this.#faq.respond(input);
    trace.add('faq.production-behavior.selected');
    const receipt = await this.dependencies.scheduler.speak(answer, { kind: 'response' });
    trace.add('playback.completed', { evidence: receipt.evidence });
    return {
      candidate: this.candidate,
      scenario: 'no-llm-faq',
      trace: trace.snapshot(),
      answer,
      modelRequests: this.dependencies.model.requests - modelRequests,
      toolAttempts: 0,
      toolOwner: 'none',
      stalePlaybackCount: 0,
    };
  }

  async runInterruptToolScenario(): Promise<ScenarioResult> {
    const trace = new TraceRecorder();
    const historyStart = this.dependencies.scheduler.history.length;
    const modelRequests = this.dependencies.model.requests;
    this.dependencies.model.traceWith(trace);
    this.dependencies.store.traceWith(trace);
    this.dependencies.nativeTool.begin(trace);
    trace.add('input.accepted');

    const response = this.dependencies.behavior.respond('Check my balance.');
    await this.dependencies.nativeTool.started.promise;
    await this.dependencies.scheduler.idle();
    const acknowledgment = this.dependencies.scheduler.history
      .slice(historyStart)
      .find((event) => event.kind === 'acknowledgment' && event.phase === 'completed');
    if (!acknowledgment)
      throw new Error('production scheduler did not complete the acknowledgment');
    trace.add('acknowledgment.completed', { evidence: acknowledgment.evidence });

    trace.add('caller.takeover');
    const postTakeoverHistory = this.dependencies.scheduler.history.length;
    this.dependencies.behavior.cancel('caller takeover');
    await this.dependencies.scheduler.interrupt();
    trace.add('turn.cancelled');
    this.dependencies.nativeTool.release.resolve();

    try {
      await response;
      throw new Error('stale agent response unexpectedly completed');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
      trace.add('late.model.continuation.suppressed');
      trace.add('tool.result.stale.blocked');
    } finally {
      this.dependencies.model.traceWith();
      this.dependencies.store.traceWith();
      this.dependencies.nativeTool.clear();
    }

    const operation = this.dependencies.store.latest();
    const stalePlaybackCount = this.dependencies.scheduler.history
      .slice(postTakeoverHistory)
      .filter((event) => event.kind === 'response' && event.phase === 'completed').length;
    trace.add('scenario.settled');
    return {
      candidate: this.candidate,
      scenario: 'interrupt-before-tool-settles',
      trace: trace.snapshot(),
      modelRequests: this.dependencies.model.requests - modelRequests,
      toolAttempts: this.dependencies.nativeTool.attempts,
      toolOwner: 'ovo-execution',
      stalePlaybackCount,
      operationState: operation?.state === 'succeeded' ? 'succeeded' : undefined,
    };
  }

  async dispose(): Promise<void> {}
}

function createFocusedOvoExperimentPlugin(
  model: DeterministicToolModel,
  store: MemoryOperationStore,
  nativeTool: ControlledNativeTool,
): VoiceExperimentPlugin {
  return definePlugin(
    {
      id: 'experiment.voice.focused-ovo',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      provides: [VOICE_EXPERIMENT_SERVICE],
      requires: ['ovo.behavior', 'ovo.execution', VOICE_SERVICE_KEYS.scheduler],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
      ui: { label: 'Focused OVO production-plugin composition spike' },
    },
    (ctx) => {
      const engine = new FocusedOvoEngine({
        behavior: ctx.get('ovo.behavior') as CancellableBehavior,
        execution: ctx.get('ovo.execution') as Execution,
        scheduler: ctx.get(VOICE_SERVICE_KEYS.scheduler) as BoundedSpeechScheduler,
        model,
        store,
        nativeTool,
      });
      ctx.provide(VOICE_EXPERIMENT_SERVICE, engine);
    },
  );
}

export function createFocusedOvoCompositionSpec(): ExperimentCompositionSpec {
  const model = new DeterministicToolModel();
  const store = new MemoryOperationStore();
  const nativeTool = new ControlledNativeTool();
  const output = createSimulatedSpeechOutputPlugin();
  const scheduler = createSpeechSchedulerPlugin();
  const storePlugin = createMemoryOperationStorePlugin(store);
  const connector = createNativeToolsPlugin({ [TOOL_ID]: () => nativeTool.invoke() });
  const inference = createAiSdkInferencePlugin({ resolveModel: () => model.model });
  const execution = createExecutionPlugin({ tools: [TOOL], allowedTools: [TOOL_ID] });
  const behavior = createAgentBehaviorPlugin();
  const experiment = createFocusedOvoExperimentPlugin(model, store, nativeTool);
  return {
    catalog: [
      output,
      scheduler,
      storePlugin,
      connector,
      inference,
      execution,
      behavior,
      experiment,
    ],
    rows: [
      { id: output.manifest.id, config: { latencyMs: 0, evidence: 'simulated' } },
      { id: scheduler.manifest.id },
      { id: storePlugin.manifest.id },
      { id: connector.manifest.id },
      { id: inference.manifest.id, config: { model: 'deterministic-mock-v4' } },
      { id: execution.manifest.id },
      {
        id: behavior.manifest.id,
        config: { agent: AGENT, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID },
      },
      { id: experiment.manifest.id },
    ],
  };
}
