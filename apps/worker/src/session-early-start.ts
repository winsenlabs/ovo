import { MULAW_8K, type AudioFormat, type UsageSink } from '@winsendotai/ovo-contracts';
import type { DurableJob } from '@winsendotai/ovo-plugin-orchestration';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import { liveSessionRequiresInput } from './live-input-policy.ts';
import type { LiveGraphOptions } from './session-graph-runtime.ts';
import { openReleaseStt, SttPreconnect } from './session-stt-preconnect.ts';
import type { CallClips } from './speech-cache-percall.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';

/** What a live session starts before its own setup; given up together if that setup fails. */
export interface EarlyCallWork {
  release: ReleaseRecord;
  /** The job's call variables, as the session graph and the per-call clips both read them. */
  variables: Record<string, unknown>;
  format: AudioFormat;
  callClips?: CallClips;
  sttPreconnect?: SttPreconnect;
  abandon(): Promise<void>;
}

/**
 * Starts the slow provider work of a live call the moment its release is known, so it overlaps
 * the call record, telemetry, recording and graph composition instead of following them:
 *
 * - TTS-10: the call's personal opening renders, unless dialling already started it (the clips
 *   prepared while the phone rang are taken over under the same job id);
 * - STT-6: the release's STT starts its handshake; the engine adopts that session.
 *   `OVO_STT_PRECONNECT=false` connects at engine start instead.
 */
export function startEarlyCallWork(input: {
  job: Pick<DurableJob, 'id' | 'payload'>;
  release: ReleaseRecord;
  media: { sessionId: string; format?: unknown };
  graph?: LiveGraphOptions;
  speechCache?: WorkerSpeechCacheRuntime;
  extensions: InstalledSessionExtensions;
  secrets: SecretManager;
  /** The call's own meter; renders and handshakes made for it are its usage. */
  usage: UsageSink;
  env?: Readonly<Record<string, string | undefined>>;
}): EarlyCallWork {
  const { job, release, graph } = input;
  const raw = job.payload.variables;
  const variables =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const format = (input.media.format as AudioFormat | undefined) ?? MULAW_8K;
  if (!graph) return { release, variables, format, abandon: async () => undefined };
  const callClips = input.speechCache?.prepareCall({
    callKey: job.id,
    release,
    variables,
    usage: input.usage,
    format,
    answeringMachine: job.payload.kind !== 'inbound_call',
    claim: true,
  });
  const env = input.env ?? process.env;
  const sttPreconnect =
    env.OVO_STT_PRECONNECT !== 'false' &&
    release.selections?.stt &&
    liveSessionRequiresInput(release.config)
      ? new SttPreconnect(
          openReleaseStt(release, input.usage, {
            catalog: [...graph.distribution.catalog, ...input.extensions.plugins],
            parent: graph.parent,
            secrets: input.secrets,
          }),
          {
            sessionId: input.media.sessionId,
            format,
            language: release.config.language,
            // STT-11: the early session connects with this call's keyterms too.
            variables,
          },
          input.usage,
        )
      : undefined;
  return {
    release,
    variables,
    format,
    callClips,
    sttPreconnect,
    abandon: async () => {
      if (callClips) input.speechCache?.perCall.release(job.id);
      await sttPreconnect?.dispose();
    },
  };
}
