import {
  createAgentBehavior,
  createAnnouncementBehavior,
  createContextBehavior,
  createFaqBehavior,
} from '@winsendotai/ovo-behaviors';
import {
  AgentConfig,
  type Behavior,
  type Clock,
  type EngineEvent,
  type Execution,
  type ExecutionRequest,
  type OperationRecord,
  type SessionInput,
  type Speech,
  type SpeechReceipt,
  type TurnConfig,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import {
  createFakeCarrier,
  type FakeCarrier,
  type FakeCarrierOptions,
} from '../drivers/fake-carrier.ts';
import { realClock } from '../drivers/fake-clock.ts';
import { createScriptedInference, type ScriptedReply } from '../drivers/scripted-inference.ts';
import {
  createScriptedStt,
  createScriptedTts,
  type ScriptedStt,
  type ScriptedTts,
  type ScriptedTtsOptions,
} from '../drivers/scripted-speech.ts';
import { createReferenceTurnDetector } from '../reference/turn-detector.ts';
import type { EngineFactory, EngineUnderTest } from './engine-ports.ts';
import { waitFor } from './runner.ts';

export interface EngineKitOptions {
  /** 'kit' (default) passes the reference turn detector; 'none' exercises the engine's fallback. */
  turnDetector?: 'kit' | 'none';
  /** Defaults to the wall clock: engines such as LiveKit use real timers internally. */
  clock?: Clock;
  timeoutMs?: number;
}

export interface EngineKitContext {
  factory: EngineFactory;
  options: EngineKitOptions;
}

export type HarnessEntry =
  | { kind: 'respond'; seq: number; input: string; variables: Record<string, unknown> }
  | { kind: 'receipt'; seq: number; receipt: SpeechReceipt }
  | { kind: 'event'; seq: number; event: EngineEvent }
  | { kind: 'execute'; seq: number; request: ExecutionRequest }
  | { kind: 'progress'; seq: number; receipt: SpeechReceipt };

type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

export interface ScenarioSetup {
  agent: Record<string, unknown> & { mode: AgentConfig['mode'] };
  replies?: ScriptedReply[];
  session?: Partial<SessionInput>;
  carrier?: Omit<FakeCarrierOptions, 'clock'>;
  tts?: ScriptedTtsOptions;
  hideSpeechKind?: boolean;
  detector?: Partial<TurnConfig>;
  progress?: string;
}

export const SESSION_VARIABLES = Object.freeze({ customer: 'Asha' });
const CONFIRM_PROMPT = /\bconfirm\b|\bsay yes\b/i;

export class EngineHarness {
  readonly log: HarnessEntry[] = [];
  readonly usage: UsageMeter[] = [];
  private seq = 0;
  underTest!: EngineUnderTest;

  constructor(
    readonly carrier: FakeCarrier,
    readonly stt: ScriptedStt,
    readonly tts: ScriptedTts,
    readonly session: SessionInput,
    readonly timeoutMs: number,
  ) {}

  record(entry: WithoutSeq<HarnessEntry>): void {
    this.log.push({ ...entry, seq: ++this.seq } as HarnessEntry);
  }

  get engine() {
    return this.underTest.engine;
  }
  events(): EngineEvent[] {
    return this.log.flatMap((e) => (e.kind === 'event' ? [e.event] : []));
  }
  responds() {
    return this.log.filter(
      (e): e is Extract<HarnessEntry, { kind: 'respond' }> => e.kind === 'respond',
    );
  }
  receipts() {
    return this.log.filter(
      (e): e is Extract<HarnessEntry, { kind: 'receipt' }> => e.kind === 'receipt',
    );
  }
  executes() {
    return this.log.filter(
      (e): e is Extract<HarnessEntry, { kind: 'execute' }> => e.kind === 'execute',
    );
  }
  phases(segmentText: RegExp) {
    return this.events().flatMap((e) =>
      e.type === 'speech' && segmentText.test(e.evidence.text) ? [e.evidence] : [],
    );
  }

  async say(text: string): Promise<void> {
    (await this.stt.session(0)).say(text);
  }
  until(predicate: () => boolean, what: string, ms = this.timeoutMs): Promise<void> {
    return waitFor(predicate, ms, what);
  }
  async close(): Promise<void> {
    await Promise.race([
      this.engine.dispose('drain', { deadlineMs: 1000 }),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }
}

function spyBehavior(inner: Behavior, harness: EngineHarness, hideSpeechKind: boolean): Behavior {
  const spy: Behavior = {
    respond: (input, variables = {}) => {
      harness.record({ kind: 'respond', input, variables });
      return inner.respond(input, variables);
    },
    onPlayback: (receipt) => {
      harness.record({ kind: 'receipt', receipt });
      return inner.onPlayback?.(receipt);
    },
  };
  if (inner.respondStream)
    spy.respondStream = (input, variables = {}) => {
      harness.record({ kind: 'respond', input, variables });
      return inner.respondStream!(input, variables);
    };
  if (inner.cancel) spy.cancel = () => inner.cancel!();
  if (inner.beginTurn) spy.beginTurn = (epoch) => inner.beginTurn!(epoch);
  if (inner.isComplete) spy.isComplete = () => inner.isComplete!();
  if (inner.subscribe) spy.subscribe = (fn) => inner.subscribe!(fn);
  if (!hideSpeechKind)
    spy.speechKind = (text) =>
      inner.speechKind?.(text) ?? (CONFIRM_PROMPT.test(text) ? 'confirmation' : undefined);
  return spy;
}

function kitExecution(harness: EngineHarness, speech: () => Speech, progress?: string): Execution {
  return {
    async execute(request) {
      harness.record({ kind: 'execute', request });
      if (progress) {
        const receipt = await speech().speak(progress, { kind: 'progress' });
        harness.record({ kind: 'progress', receipt });
      }
      const record: OperationRecord = {
        id: request.id,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        toolId: request.toolId,
        input: request.input,
        state: 'succeeded',
        result: { ok: true, balance: 42 },
        createdAt: new Date(0).toISOString(),
      };
      return record;
    },
  };
}

function behaviorFor(setup: ScenarioSetup, harness: EngineHarness, speech: () => Speech): Behavior {
  const config = AgentConfig.parse({ name: 'Kit agent', language: 'en-US', ...setup.agent });
  const inference = createScriptedInference(setup.replies ?? [{ kind: 'text', text: 'Okay.' }]);
  const execution = kitExecution(harness, speech, setup.progress);
  if (config.mode === 'announcement') return createAnnouncementBehavior(config);
  if (config.mode === 'faq') return createFaqBehavior(config);
  if (config.mode === 'context') return createContextBehavior(config, inference);
  return createAgentBehavior(config, inference, execution, {
    workspaceId: 'w1',
    sessionId: 'kit-session',
  });
}

/** Builds the ports, calls the factory with them and starts the engine. */
export async function startHarness(
  context: EngineKitContext,
  setup: ScenarioSetup,
): Promise<EngineHarness> {
  const clock = context.options.clock ?? realClock;
  const mode = setup.agent.mode;
  const session: SessionInput = {
    mode,
    language: 'en-US',
    inputEnabled: mode !== 'announcement',
    variables: SESSION_VARIABLES,
    maxCallSeconds: 600,
    acknowledgements: [],
    ...setup.session,
  };
  const carrier = createFakeCarrier({ clock, sessionId: 'kit-session', ...setup.carrier });
  const harness = new EngineHarness(
    carrier,
    createScriptedStt(),
    createScriptedTts(setup.tts),
    session,
    context.options.timeoutMs ?? 10_000,
  );
  let speech: Speech | undefined;
  const lateSpeech = () => {
    if (!speech) throw new Error('the engine companion speech is not attached yet');
    return speech;
  };
  const behavior = spyBehavior(
    behaviorFor(setup, harness, lateSpeech),
    harness,
    setup.hideSpeechKind ?? false,
  );
  harness.underTest = await context.factory({
    sessionId: 'kit-session',
    media: carrier.duplex,
    stt: harness.stt,
    tts: harness.tts,
    behavior,
    session,
    clock,
    usage: (meter) => harness.usage.push(meter),
    ...(context.options.turnDetector === 'none'
      ? {}
      : { turnDetector: createReferenceTurnDetector(setup.detector) }),
  });
  speech = harness.underTest.speech;
  harness.engine.subscribe((event) => harness.record({ kind: 'event', event }));
  await harness.engine.start();
  return harness;
}
