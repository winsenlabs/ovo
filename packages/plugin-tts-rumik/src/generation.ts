import type { AudioFormat, Clock, UsageSink } from '@winsendotai/ovo-contracts';
import { synthesisFields, type RumikTtsBinding } from './binding.ts';
import { RumikTtsError, httpMayHelp } from './errors.ts';
import { AudioOut, WholeSamples } from './output.ts';
import type { GenerationSink, RumikSocket } from './socket.ts';

export interface Submission {
  /** The text as Rumik receives it (tone tag already placed). */
  spoken: string;
  voice?: string;
  requestId: string;
  /** Estimated billed characters (text, plus the mulberry description). */
  characters: number;
  onUsage: UsageSink;
  /** Aborting it fails this generation's audio with the abort reason. */
  signal: AbortSignal;
  /** Aborting it ends this generation's audio quietly: its reply was closed (barge-in). */
  quiet?: AbortSignal;
}

/** One line on the queue, from submission until its audio and meter are settled. */
export class Generation {
  state: 'queued' | 'running' | 'ended' = 'queued';
  readonly out = new AudioOut();
  readonly controller = new AbortController();
  /** Billed: the text frame went out, or HTTP accepted the request. */
  sent = false;
  heard = false;
  cancelling = false;
  /** `INVALID_TEXT` is not charged. */
  free = false;
  startedAt = 0;
  /** While on the socket: sends `{"type":"cancel"}` and starts waiting for the acknowledgement. */
  cancel?: () => void;
  detach: () => void = () => undefined;

  constructor(readonly request: Submission) {}
}

/** A cancel with no `cancelled` (or `done`) after this long gives up the socket, not the queue. */
export const CANCEL_ACK_MS = 2_000;

export interface SocketRun {
  binding: Readonly<RumikTtsBinding>;
  clock: Pick<Clock, 'setTimeout'>;
  format: AudioFormat;
}

/**
 * One generation on the socket: the text frame, then binary chunks until `done`. A cancel drops
 * every chunk until Rumik answers `cancelled` (or `done`, when the cancel lost the race), so the
 * next generation's text frame never interrupts audio that is still arriving. Resolves `fallback`
 * when the socket failed before any audio and HTTP may still render the line.
 */
export function runOnSocket(
  socket: RumikSocket,
  job: Generation,
  run: SocketRun,
): Promise<'done' | 'fallback'> {
  if (job.controller.signal.aborted) return Promise.resolve('done');
  const samples = new WholeSamples(run.format);
  return new Promise((resolve, reject) => {
    let stopWaiting: (() => void) | undefined;
    const release = () => {
      stopWaiting?.();
      socket.detach(sink);
      job.cancel = undefined;
    };
    const sink: GenerationSink = {
      audio(bytes) {
        if (job.cancelling) return;
        job.heard = true;
        job.out.push(samples.cut(bytes));
      },
      done() {
        release();
        if (job.cancelling) socket.expectStraggler();
        if (samples.partial && !job.cancelling)
          job.out.stop(new RumikTtsError('Rumik TTS returned an incomplete PCM sample', false));
        else job.out.end();
        resolve('done');
      },
      cancelled() {
        release();
        if (!job.cancelling)
          job.out.stop(new RumikTtsError('Rumik TTS cancelled the generation', true));
        resolve('done');
      },
      failed(error) {
        release();
        if (job.cancelling) return resolve('done');
        if (error instanceof RumikTtsError && error.code === 'INVALID_TEXT') job.free = true;
        if (!job.heard && run.binding.httpFallback !== false && httpMayHelp(error))
          return resolve('fallback');
        reject(error);
      },
    };
    job.cancel = () => {
      if (job.cancelling) return;
      job.cancelling = true;
      try {
        socket.send({ type: 'cancel' });
      } catch {
        return socket.abandon('cancel could not be sent');
      }
      stopWaiting = run.clock.setTimeout(
        () => socket.abandon('cancel was not acknowledged'),
        CANCEL_ACK_MS,
      );
    };
    try {
      socket.attach(sink);
      socket.send(synthesisFields(run.binding, job.request.spoken, job.request.voice));
      job.sent = true;
    } catch (error) {
      sink.failed(error instanceof Error ? error : new RumikTtsError(String(error), true), false);
    }
  });
}
