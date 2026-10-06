import type { AgentConfig, TextFilter, UsageSink } from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import type { ByteCacheLimits } from '@winsendotai/ovo-plugin-cache';
import {
  normalizeSpeechInventory,
  normalizeSpeechText,
  staticSpeechInventory,
  type ApprovedSpeechPhrase,
  type SpeechInventoryRelease,
} from '@winsendotai/ovo-plugin-speech-cache';
import { openSpeechClipDatabase } from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { DEFAULT_SPEECH_CACHE_OPTIONS, speechCacheOptionsFromEnv } from './speech-cache-env.ts';
import type { WorkerSpeechCacheOptions } from './speech-cache-env.ts';
import { PerCallClipService, type PrepareCallInput } from './speech-cache-percall-service.ts';
import type { CallClips } from './speech-cache-percall.ts';
import { openReleaseSpeech, type ReleaseSpeechDeps } from './speech-cache-release-tts.ts';
import { SpeechPrerenderService, type PrerenderServiceInput } from './speech-cache-service.ts';
import { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

const log = createLogger({ service: 'worker', component: 'speech-percall' });

export const HYBRID_SPEECH_CACHE_PLUGIN_ID = '@winsendotai/ovo-worker/hybrid-speech-cache-output';

/**
 * Owns the process speech cache: pinned and L1 tiers in memory, the optional durable Postgres
 * tier, and the pre-render service that fills them (TTS-7/8/9).
 */
export class WorkerSpeechCacheRuntime {
  readonly cache: WorkerSpeechClipCache;
  /** Each call's templated lines, rendered for that call alone and never persisted (TTS-10). */
  readonly perCall: PerCallClipService;
  private service?: SpeechPrerenderService;
  private database?: Awaited<ReturnType<typeof openSpeechClipDatabase>>;

  constructor(
    limits: ByteCacheLimits = {},
    readonly options: WorkerSpeechCacheOptions = DEFAULT_SPEECH_CACHE_OPTIONS,
  ) {
    this.cache = new WorkerSpeechClipCache(
      { ...options.l1, ...limits },
      { pinnedMaxBytes: options.pinnedMaxBytes, maxClipBytes: options.clipMaxBytes },
    );
    this.perCall = new PerCallClipService(
      options.perCall ?? DEFAULT_SPEECH_CACHE_OPTIONS.perCall,
      this.cache.maxClipBytes,
    );
  }

  /**
   * Starts a call's personal lines rendering (TTS-10): at dial hand-off while the phone rings, or
   * at admission. The session that answers takes the same clips by the job id.
   */
  prepareCall(input: PrepareCallInput): CallClips | undefined {
    return this.perCall.prepare(input);
  }

  /**
   * The dial hand-off hook: looks the job up and prepares its call. Best effort, like the provider
   * pre-warm it runs beside; it never throws and never delays the call.
   */
  async prepareJob(
    jobId: string,
    deps: {
      jobs: {
        get(
          id: string,
        ): Promise<{ workspaceId: string; payload: Record<string, unknown> } | undefined>;
      };
      releases: { getRelease(workspaceId: string, id: string): Promise<ReleaseRecord | undefined> };
      usage?: (jobId: string) => UsageSink | undefined;
    },
  ): Promise<CallClips | undefined> {
    try {
      const job = await deps.jobs.get(jobId);
      const releaseId = job?.payload.releaseId;
      if (!job || typeof releaseId !== 'string') return undefined;
      const release = await deps.releases.getRelease(job.workspaceId, releaseId);
      if (!release) return undefined;
      const variables = job.payload.variables;
      return this.prepareCall({
        callKey: jobId,
        release,
        variables:
          variables && typeof variables === 'object' && !Array.isArray(variables)
            ? (variables as Record<string, unknown>)
            : {},
        usage: (event) => deps.usage?.(jobId)?.(event),
        answeringMachine: job.payload.kind !== 'inbound_call',
      });
    } catch (error) {
      log.warn('speech_percall_prepare_failed', { jobId, ...errorFields(error) });
      return undefined;
    }
  }

  /** Env-configured runtime; with a database URL the durable tier and pre-render queue attach. */
  static async fromEnvironment(
    env: Readonly<Record<string, string | undefined>>,
    databaseUrl?: string,
  ): Promise<WorkerSpeechCacheRuntime> {
    const options = speechCacheOptionsFromEnv(env);
    const runtime = new WorkerSpeechCacheRuntime({}, options);
    if (databaseUrl) {
      runtime.database = await openSpeechClipDatabase(
        {
          connectionString: databaseUrl,
          maxConnections: 4,
          lockConnections: options.prerender.concurrency,
        },
        { maxClipBytes: options.clipMaxBytes, maxWorkspaceBytes: options.workspaceMaxBytes },
      );
      runtime.cache.attachDurable(runtime.database.clips);
    }
    return runtime;
  }

  /** Starts warming: routed releases now, publishes as they are queued, first calls as they come. */
  startPrerender(
    input: Pick<PrerenderServiceInput, 'workerId' | 'releases' | 'ledger' | 'log'> &
      ({ speech: ReleaseSpeechDeps } | Pick<PrerenderServiceInput, 'openSpeech'>),
  ): SpeechPrerenderService | undefined {
    const openSpeech =
      'openSpeech' in input
        ? input.openSpeech
        : (release: Parameters<PrerenderServiceInput['openSpeech']>[0], usage: UsageSink) =>
            openReleaseSpeech(release, usage, input.speech);
    // Per-call renders compose the release's TTS the same way, pre-render enabled or not.
    this.perCall.attachSpeech(openSpeech);
    if (this.service || !this.options.prerender.enabled) return this.service;
    this.service = new SpeechPrerenderService({
      workerId: input.workerId,
      releases: input.releases,
      ledger: input.ledger,
      log: input.log,
      openSpeech,
      cache: this.cache,
      clips: this.database?.clips,
      queue: this.database?.queue,
      options: this.options.prerender,
    });
    this.service.start();
    return this.service;
  }

  async close(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    this.perCall.close();
    this.cache.close();
    await service?.close();
    await this.database?.close();
    this.database = undefined;
  }
}

/** The pre-existing acknowledgement and announcement approvals, kept for compatibility. */
export function approvedSpeechPhrases(agent: AgentConfig): ApprovedSpeechPhrase[] {
  const policy = agent.speechCache;
  if (!policy?.enabled) return [];
  const phrases = new Map<string, ApprovedSpeechPhrase>();
  const approveStatic = (text: string | undefined) => {
    if (text?.trim()) phrases.set(`static:${text}`, { text, purpose: 'static-phrase' });
  };
  approveStatic(agent.processing.initial);
  approveStatic(agent.processing.progress);
  for (const tool of agent.tools) {
    approveStatic(tool.processing?.initial);
    approveStatic(tool.processing?.progress);
  }
  if (policy.announcement && agent.mode === 'announcement' && agent.message.trim())
    phrases.set(`announcement:${agent.message}`, {
      text: agent.message,
      purpose: 'announcement',
    });
  return [...phrases.values()];
}

/**
 * Every approval the live output checks, on the text the speaker will actually send: the legacy
 * approvals and the release's whole static inventory, each passed through the session's own text
 * filters (TTS-5/TTS-6). Templated lines are excluded; they carry caller data once rendered.
 */
export function sessionSpeechApprovals(
  release: SpeechInventoryRelease,
  filters: readonly TextFilter[],
): ApprovedSpeechPhrase[] {
  if (!release.config.speechCache?.enabled) return [];
  const language = release.config.language;
  const legacy = approvedSpeechPhrases(release.config).map((phrase) => ({
    ...phrase,
    text: normalizeSpeechText(filters, phrase.text, language),
  }));
  const scripted = normalizeSpeechInventory(
    staticSpeechInventory(release),
    filters,
    language,
  ).texts.map((text): ApprovedSpeechPhrase => ({ text, purpose: 'scripted' }));
  return [...legacy, ...scripted].filter((phrase) => phrase.text.trim());
}
