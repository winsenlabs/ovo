import { AgentSession, initializeLogger, inference } from '@livekit/agents';
import {
  outcomeFor,
  type EndReason,
  type EngineOutcome,
  type VoiceSessionEngine,
} from '@winsendotai/ovo-contracts';
import { LiveKitCallControl } from './call-control.ts';
import { CarrierAudioInput } from './carrier-input.ts';
import { CarrierAudioOutput } from './carrier-output.ts';
import { Evidence } from './evidence.ts';
import { assertEnvironment, assertSession } from './guards.ts';
import { attachEvents } from './metrics-bridge.ts';
import { OvoAgent } from './ovo-agent.ts';
import { sessionOptions } from './session-options.ts';
import { LiveKitSpeech } from './speech.ts';
import { SttGate } from './stt-gate.ts';
import { OvoStt } from './stt-adapter.ts';
import { OvoTts } from './tts-adapter.ts';
import { TurnDriver } from './turn-driver.ts';
import type { LiveKitOptions, LiveKitPorts } from './types.ts';

// Invoke immediately, but isolate both synchronous throws and rejected cleanup promises.
function attempt(action: () => unknown): Promise<void> {
  try {
    return Promise.resolve(action()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

let loggerReady = false;
export class LiveKitEngine implements VoiceSessionEngine {
  readonly ended: Promise<EngineOutcome>;
  private resolveEnded!: (value: EngineOutcome) => void;
  private readonly evidence: Evidence;
  private readonly input: CarrierAudioInput;
  private readonly output: CarrierAudioOutput;
  private readonly driver: TurnDriver;
  private readonly control: LiveKitCallControl;
  readonly session: AgentSession;
  private readonly stt?: OvoStt;
  private readonly cleanup: (() => void)[] = [];
  private stopping?: Promise<EngineOutcome>;
  private started = false;
  constructor(
    private readonly ports: LiveKitPorts,
    readonly speech = new LiveKitSpeech(),
    private readonly options: LiveKitOptions = {},
  ) {
    assertEnvironment();
    if (!loggerReady) {
      initializeLogger({ pretty: false, level: 'silent' });
      loggerReady = true;
    }
    if (ports.session.inputEnabled && !ports.stt)
      throw new Error('Input-enabled LiveKit requires ovo.stt');
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
    this.evidence = new Evidence(ports.clock, ports.transcripts);
    const fail = () => {
      void this.dispose('error:livekit');
    };
    this.input = new CarrierAudioInput(ports.media, fail);
    this.output = new CarrierAudioOutput(
      ports.media,
      this.evidence,
      ports.session.acknowledgements.includes('weak-playback-evidence'),
      options.markTimeoutMs,
      fail,
    );
    const tts = new OvoTts(ports, () => {
      if (!this.driver.current) throw new Error('TTS has no OVO speech segment');
      return this.driver.current;
    });
    const gate = new SttGate(fail);
    this.stt = ports.session.inputEnabled ? new OvoStt(ports, gate) : undefined;
    this.session = new AgentSession(
      sessionOptions(this.stt, tts, options.minInterruptionWords ?? 2),
    );
    this.driver = new TurnDriver(
      ports,
      this.session,
      this.output,
      this.evidence,
      (reason) => {
        void this.dispose(reason);
      },
      gate,
    );
    this.control = new LiveKitCallControl(ports, this.driver);
    this.session.input.audio = this.input;
    this.session.output.audio = this.output;
    this.session.input.setAudioEnabled(ports.session.inputEnabled);
    this.session.output.setTranscriptionEnabled(false);
    this.cleanup.push(
      attachEvents(
        this.session,
        this.driver,
        this.evidence,
        options.minInterruptionWords ?? 2,
        fail,
      ),
    );
  }
  get ingressStats() {
    return { ...this.input.stats };
  }
  subscribe: VoiceSessionEngine['subscribe'] = (fn) => this.evidence.subscribe(fn);
  async start(): Promise<void> {
    if (this.started || this.stopping) throw new Error('LiveKit engine already started or stopped');
    this.started = true;
    const agent = new OvoAgent(this.driver);
    assertSession(this.session, agent, inference);
    let digits = '';
    let cancelDigits: (() => void) | undefined;
    const commitDigits = () => {
      cancelDigits?.();
      if (digits) this.driver.enqueue(digits, 'dtmf');
      digits = '';
    };
    this.cleanup.push(
      this.ports.media.onClose((reason) => {
        void this.dispose(reason);
      }),
      this.ports.media.onDtmf((digit) => {
        if (!this.ports.session.inputEnabled) return;
        void this.driver.interrupt();
        cancelDigits?.();
        if (digit === '#') commitDigits();
        else {
          digits += digit;
          cancelDigits = this.ports.clock.setTimeout(commitDigits, 1000);
        }
      }),
      () => cancelDigits?.(),
      this.ports.media.onAnsweredBy?.((result) => {
        this.evidence.emit({ type: 'voicemail', result });
        this.control.verdict(result);
      }) ?? (() => {}),
      () => this.control.stop(),
      this.ports.clock.setTimeout(() => {
        void this.dispose('max_duration');
      }, this.ports.session.maxCallSeconds * 1000),
    );
    try {
      await this.session.start({ agent });
      assertSession(this.session, agent, inference);
      this.speech.attach(this.driver);
      this.control.start();
    } catch (error) {
      await this.dispose('error:livekit-start');
      throw error;
    }
  }
  dispose(reason: EndReason, opts: { deadlineMs?: number } = {}): Promise<EngineOutcome> {
    this.stopping ??= Promise.resolve().then(() =>
      this.stop(reason, opts.deadlineMs ?? this.options.closeDeadlineMs ?? 2000),
    );
    return this.stopping;
  }
  private async stop(reason: EndReason, deadlineMs: number): Promise<EngineOutcome> {
    let cancel = () => {};
    const deadline = new Promise<void>((resolve) => {
      cancel = this.ports.clock.setTimeout(resolve, deadlineMs);
    });
    // Evaluate left to right: media close is initiated first, and no failed port can skip another.
    const work = Promise.all([
      attempt(() => this.ports.media.close(reason)),
      attempt(() => this.stt?.stop()),
      attempt(() => this.driver.stop()),
      attempt(() => this.speech.close()),
      attempt(() => this.input.close()),
      attempt(() => this.session.close()),
    ]);
    await Promise.race([work, deadline]);
    void attempt(cancel);
    for (const off of this.cleanup.splice(0)) void attempt(off);
    const outcome = { reason, outcome: outcomeFor(reason) };
    this.evidence.emit({ type: 'end', reason });
    this.resolveEnded(outcome);
    return outcome;
  }
}
