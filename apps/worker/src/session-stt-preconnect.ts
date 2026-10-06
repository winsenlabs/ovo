import {
  Cap,
  sameFormat,
  type AudioFormat,
  type SpeechToText,
  type SttEvent,
  type SttSession,
  type UsageMeter,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { composeReleaseProvider, type ReleaseSpeechDeps } from './speech-cache-release-tts.ts';
import { instrumentPlugin } from './telemetry-stage-core.ts';

type StartInput = Parameters<SpeechToText['start']>[0];
type Early = { stt: SpeechToText; close(): Promise<void> };

const log = createLogger({ service: 'worker', component: 'stt-preconnect' });

/**
 * STT-6: the provider handshake (DNS, TLS, WebSocket, Begin; 2-5 s from asia-south1) starts as
 * soon as the media stream opens and the release is known, in parallel with the call record,
 * telemetry, recording and graph composition, instead of after all of them. The release's own STT
 * selection is composed for it exactly as the session composes it, and the session's engine adopts
 * the early session on its first `start()`. Readiness becomes max(setup, handshake), not the sum.
 *
 * Events and meters that arrive before adoption are held and handed over with the session. A
 * session nobody adopts (the call ended first, or the engine asked for another format) is
 * cancelled at session end and its usage charged to the call.
 *
 * STT-7 stops here on purpose. On the worker, an inbound call is admitted at session.open, so
 * this is already the earliest point; an earlier start needs the API to notify the worker when it
 * admits the carrier webhook. For outbound, a socket opened while the phone rings sits idle for
 * up to the ring timeout: AssemblyAI meters it by session duration (no inactivity timeout unless
 * one is set: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api,
 * retrieved 2026-10-06) and Scribe realtime documents no idle limit at all (unverified), so most
 * of that spend lands on calls nobody answers. A pool of warm sockets per slot costs the same
 * per hour whatever the traffic and needs the founder's cost decision; neither is built.
 */
export class SttPreconnect {
  private readonly controller = new AbortController();
  private readonly events: SttEvent[] = [];
  private readonly meters: UsageMeter[] = [];
  private target?: Pick<StartInput, 'onEvent' | 'onUsage'>;
  private adopted = false;
  private disposing?: Promise<void>;
  private engineAdopted = false;
  private readonly early: Promise<{ early: Early; session: Promise<SttSession> } | undefined>;
  readonly startedAt: number;
  readyAt?: number;

  constructor(
    open: () => Promise<Early | undefined>,
    readonly input: { sessionId: string; format: AudioFormat; language: string },
    private readonly usage: UsageSink,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.early = open().then(
      (early) => {
        if (!early) return undefined;
        const session = early.stt.start({
          ...input,
          signal: this.controller.signal,
          onEvent: (event) => (this.target ? this.target.onEvent(event) : this.events.push(event)),
          onUsage: (meter) => (this.target ? this.target.onUsage(meter) : this.meters.push(meter)),
        });
        session.then(
          () => (this.readyAt = this.now()),
          () => undefined, // swallow-ok: whoever adopts it sees the rejection and starts afresh.
        );
        return { early, session };
      },
      (error: unknown) => {
        log.warn('stt_preconnect_open_failed', errorFields(error));
        return undefined;
      },
    );
  }

  /** For the call's audit: whether the engine used the early session, and its handshake time. */
  summary(): { adopted: boolean; handshakeMs: number | null } {
    return {
      adopted: this.engineAdopted,
      handshakeMs: this.readyAt === undefined ? null : this.readyAt - this.startedAt,
    };
  }

  /**
   * The engine's first `start()`: the early session when it was opened for this request, else
   * undefined and the engine connects as it always has. A rejected early handshake also returns
   * undefined, so a fresh connect gets its own attempt.
   */
  async adopt(input: StartInput): Promise<SttSession | undefined> {
    if (this.adopted || this.controller.signal.aborted) return undefined;
    if (!sameFormat(input.format, this.input.format) || input.language !== this.input.language)
      return undefined;
    this.adopted = true;
    const opened = await this.early;
    if (!opened) return undefined;
    this.engineAdopted = true;
    this.target = { onEvent: input.onEvent, onUsage: input.onUsage };
    for (const meter of this.meters.splice(0)) input.onUsage(meter);
    for (const event of this.events.splice(0)) input.onEvent(event);
    const abort = () => this.controller.abort(input.signal.reason);
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });
    try {
      return await opened.session;
    } catch (error) {
      log.warn('stt_preconnect_failed', { sessionId: this.input.sessionId, ...errorFields(error) });
      return undefined;
    }
  }

  /** Session end: an early session nobody adopted is cancelled; its composition is closed. */
  dispose(): Promise<void> {
    return (this.disposing ??= this.close());
  }

  private async close(): Promise<void> {
    const wasAdopted = this.adopted;
    this.adopted = true;
    const opened = await this.early;
    if (!opened) return;
    if (!wasAdopted) {
      this.controller.abort(new DOMException('stt preconnect not adopted', 'AbortError'));
      const session = await opened.session.catch(() => undefined);
      await session?.cancel('not adopted').catch(() => undefined); // swallow-ok: never used.
      for (const meter of this.meters.splice(0)) this.usage(meter);
    }
    await opened.early.close();
  }
}

/** Opens the release's own STT selection for a preconnect; undefined when it has none to open. */
export function openReleaseStt(
  release: ReleaseRecord,
  usage: UsageSink,
  deps: Omit<ReleaseSpeechDeps, 'defaults'>,
): () => Promise<Early | undefined> {
  return async () => {
    if (!release.selections?.stt) return undefined;
    const composition = await composeReleaseProvider(release, 'stt', usage, deps);
    const stt = composition.get(Cap.stt) as SpeechToText | undefined;
    if (!stt) {
      await composition.dispose();
      return undefined;
    }
    return { stt, close: () => composition.dispose() };
  };
}

/**
 * The session's STT plugin, with its first `start()` adopting the preconnected session. Applied
 * inside telemetry, so `stt.ready` measures what the engine still waits once it starts.
 */
export function adoptPreconnectedStt(
  definition: PluginDefinition,
  preconnect: SttPreconnect,
): PluginDefinition {
  return instrumentPlugin(definition, Cap.stt, (service) => {
    const stt = service as SpeechToText | undefined;
    if (!stt) return;
    const start = stt.start.bind(stt);
    stt.start = async (input) => (await preconnect.adopt(input)) ?? start(input);
  });
}
