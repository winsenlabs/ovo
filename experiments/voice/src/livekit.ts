import { Agent, AgentSession, initializeLogger, tool, voice } from '@livekit/agents';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { z } from 'zod';
import {
  type ExperimentCompositionSpec,
  type ScenarioResult,
  VOICE_EXPERIMENT_SERVICE,
  type VoiceExperimentEngine,
  type VoiceExperimentPlugin,
} from './contracts.ts';
import { ControlledOperationBoundary, settleWithin, TraceRecorder, TurnEpoch } from './harness.ts';
import { deterministicFaq, FAQ_INPUT } from './scenarios.ts';

initializeLogger({ pretty: false, level: 'silent' });

// @livekit/agents has a licensed local-inference/model transitive dependency.
// This deterministic spike must not load or execute it, or copy its weights.
export const LIVEKIT_LOCAL_INFERENCE_MODELS_ENABLED = false as const;

class CountingFakeLlm extends voice.testing.FakeLLM {
  requests = 0;

  override chat(options: Parameters<voice.testing.FakeLLM['chat']>[0]) {
    this.requests += 1;
    return super.chat(options);
  }
}

export class LiveKitAgentSessionEngine implements VoiceExperimentEngine {
  readonly candidate = 'livekit-agent-session' as const;
  #session?: AgentSession;
  #agent?: Agent;
  #llm?: CountingFakeLlm;
  #starting?: Promise<void>;
  #activeOperation?: ControlledOperationBoundary;

  async runFaq(input = FAQ_INPUT): Promise<ScenarioResult> {
    const trace = new TraceRecorder();
    await this.#ensureStarted(trace);
    const llm = this.#llm!;
    const modelRequests = llm.requests;
    trace.add('input.accepted', { mode: 'faq' });
    const answer = deterministicFaq(input);
    trace.add('faq.exact-match.selected');
    const speech = this.#session!.say(answer, { addToChatCtx: false });
    await settleWithin(speech.waitForPlayout());
    trace.add('playback.completed', { evidence: 'livekit-text-only-no-audio' });
    return {
      candidate: this.candidate,
      scenario: 'no-llm-faq',
      trace: trace.snapshot(),
      answer,
      modelRequests: llm.requests - modelRequests,
      toolAttempts: 0,
      toolOwner: 'none',
      stalePlaybackCount: 0,
    };
  }

  async runInterruptToolScenario(): Promise<ScenarioResult> {
    const trace = new TraceRecorder();
    await this.#ensureStarted(trace);
    const session = this.#session!;
    const agent = this.#agent!;
    const llm = this.#llm!;
    const modelRequests = llm.requests;
    const epoch = new TurnEpoch();
    const acceptedEpoch = epoch.capture();
    const operation = new ControlledOperationBoundary(trace, epoch, acceptedEpoch);
    const chatStart = agent.chatCtx.items.length;
    this.#activeOperation = operation;

    try {
      trace.add('input.accepted', { epoch: acceptedEpoch });
      trace.add('acknowledgment.requested');
      await settleWithin(
        session.say('Please wait while I check that.', { addToChatCtx: false }).waitForPlayout(),
      );
      trace.add('acknowledgment.completed', { evidence: 'livekit-text-only-no-audio' });

      const speech = session.generateReply({
        userInput: 'Check my balance.',
        allowInterruptions: true,
      });
      await operation.started.promise;
      trace.add('caller.takeover');
      epoch.interrupt();
      trace.add('turn.cancelled', { nextEpoch: acceptedEpoch + 1 });
      const interruption = session.interrupt();
      operation.release.resolve();
      await settleWithin(interruption.await);
      await settleWithin(speech.waitForPlayout());

      const stalePlaybackCount = agent.chatCtx.items
        .slice(chatStart)
        .filter(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            item.textContent?.includes('Your balance is 42.'),
        ).length;
      if (stalePlaybackCount === 0) trace.add('late.model.continuation.suppressed');
      else trace.add('late.model.output.observed', { count: stalePlaybackCount });
      trace.add('scenario.settled');

      return {
        candidate: this.candidate,
        scenario: 'interrupt-before-tool-settles',
        trace: trace.snapshot(),
        modelRequests: llm.requests - modelRequests,
        toolAttempts: operation.attempts,
        toolOwner: 'livekit-agent-session',
        stalePlaybackCount,
        operationState: operation.state === 'succeeded' ? 'succeeded' : undefined,
      };
    } finally {
      operation.release.resolve();
      this.#activeOperation = undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.#starting;
    if (this.#session) await this.#session.close();
    this.#session = undefined;
    this.#agent = undefined;
    this.#llm = undefined;
    this.#starting = undefined;
  }

  async #ensureStarted(trace: TraceRecorder): Promise<void> {
    if (this.#session) {
      trace.add('livekit.agent-session.reused');
      await this.#starting;
      return;
    }

    const llm = new CountingFakeLlm([
      {
        input: 'Check my balance.',
        toolCalls: [{ name: 'check_balance', args: { account: 'A-42' } }],
      },
      { input: '"balance:42"', content: 'Your balance is 42.' },
    ]);
    const agent = new Agent({
      instructions: 'Use exactly one approved tool boundary.',
      tools: {
        check_balance: tool({
          description: 'Return the balance for one account.',
          parameters: z.object({ account: z.string() }),
          execute: async () => {
            if (!this.#activeOperation) throw new Error('no active controlled operation');
            return this.#activeOperation.execute('livekit-agent-session');
          },
        }),
      },
    });
    const session = new AgentSession({
      llm,
      vad: null,
      turnHandling: { turnDetection: null, preemptiveGeneration: { enabled: false } },
      userAwayTimeout: null,
      transcriptionTimeout: null,
      aecWarmupDuration: null,
      expressive: false,
    });
    session.output.setAudioEnabled(false);
    session.output.setTranscriptionEnabled(false);
    this.#llm = llm;
    this.#agent = agent;
    this.#session = session;
    trace.add('livekit.agent-session.constructed');
    trace.add('livekit.local-inference-models.disabled');
    this.#starting = session.start({ agent }).then(() => undefined);
    await this.#starting;
    trace.add('livekit.agent-session.started');
  }
}

export function createLiveKitExperimentPlugin(): VoiceExperimentPlugin {
  return definePlugin(
    {
      id: 'experiment.voice.livekit-agent-session',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      provides: [VOICE_EXPERIMENT_SERVICE],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
      ui: { label: 'Disposable LiveKit AgentSession spike' },
    },
    (ctx) => {
      const engine = new LiveKitAgentSessionEngine();
      ctx.provide(VOICE_EXPERIMENT_SERVICE, engine);
      ctx.effect(() => () => engine.dispose(), 'dispose LiveKit AgentSession experiment');
    },
  );
}

export function createLiveKitCompositionSpec(): ExperimentCompositionSpec {
  const plugin = createLiveKitExperimentPlugin();
  return { rows: [{ id: plugin.manifest.id }], catalog: [plugin] };
}
