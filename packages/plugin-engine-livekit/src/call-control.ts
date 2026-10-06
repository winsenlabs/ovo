import type { TurnDriver } from './turn-driver.ts';
import type { LiveKitPorts } from './types.ts';

type AnsweredBy = 'human' | 'machine' | 'unknown';

/**
 * How a LiveKit call starts and goes quiet, as the native engine does it (TTS-14 parity):
 * - a behaviour that speaks first gets its opening turn without waiting for the caller (AGT-2);
 * - on an outbound leg dialled with answering-machine detection the opening waits for the
 *   carrier's verdict, up to `session.amd.timeoutMs`, and a machine gets the voicemail path;
 * - a behaviour that times caller silence itself (AGT-11) gets an idle turn once its last line
 *   has played and the caller has said nothing for `idleTimeoutMs`.
 */
export class LiveKitCallControl {
  private state: 'idle' | 'holding' | 'opened' | 'voicemail' = 'idle';
  private early?: AnsweredBy;
  private cancelHold?: () => void;
  private cancelSilence?: () => void;

  constructor(
    private readonly ports: Pick<LiveKitPorts, 'behavior' | 'session' | 'clock'>,
    private readonly driver: Pick<TurnDriver, 'enqueue' | 'voicemail' | 'onSettled' | 'onCaller'>,
  ) {
    driver.onSettled = () => this.armSilence();
    driver.onCaller = () => this.cancelSilence?.();
  }

  /** The call's first turn, once the engine has started. */
  start(): void {
    const { session, behavior } = this.ports;
    // As natively: an initial input or an announcement plays at once; a behaviour that speaks
    // first gets its opening; an engine with no input still runs the one turn it will ever get.
    if (session.initialInput !== undefined || session.mode === 'announcement')
      return this.driver.enqueue(session.initialInput ?? '');
    if (!behavior.speaksFirst?.()) {
      if (!session.inputEnabled) this.driver.enqueue('');
      return;
    }
    if (this.state !== 'idle') return;
    if (this.early || !session.amd) return this.open(this.early);
    this.state = 'holding';
    this.cancelHold = this.ports.clock.setTimeout(() => this.open(), session.amd.timeoutMs);
  }

  /** The carrier's verdict on who answered. */
  verdict(result: AnsweredBy): void {
    if (this.state === 'voicemail') return;
    if (result === 'machine' && this.driver.voicemail()) {
      this.cancelHold?.();
      this.cancelSilence?.();
      this.state = 'voicemail';
    } else if (this.state === 'holding') this.open(result);
    else if (this.state === 'idle') this.early = result;
  }

  stop(): void {
    this.cancelHold?.();
    this.cancelSilence?.();
  }

  private open(answeredBy?: AnsweredBy): void {
    if (this.state !== 'idle' && this.state !== 'holding') return;
    this.cancelHold?.();
    this.state = 'opened';
    this.driver.enqueue('', 'speech', {
      inputEvent: 'opening',
      ...(answeredBy ? { answeredBy } : {}),
    });
  }

  private armSilence(): void {
    this.cancelSilence?.();
    const timeoutMs = this.ports.behavior.idleTimeoutMs?.();
    if (!timeoutMs || this.state === 'voicemail') return;
    this.cancelSilence = this.ports.clock.setTimeout(
      () => this.driver.enqueue('', 'speech', { inputEvent: 'idle' }),
      timeoutMs,
    );
  }
}
