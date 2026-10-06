import type { AgentConfig, TextFilter, UsageSink } from '@winsendotai/ovo-contracts';
import type { ByteCacheLimits } from '@winsendotai/ovo-plugin-cache';
import {
  normalizeSpeechInventory,
  normalizeSpeechText,
  staticSpeechInventory,
  type ApprovedSpeechPhrase,
  type SpeechInventoryRelease,
} from '@winsendotai/ovo-plugin-speech-cache';
import { openSpeechClipDatabase } from '@winsendotai/ovo-plugin-speech-cache/postgres';
import { DEFAULT_SPEECH_CACHE_OPTIONS, speechCacheOptionsFromEnv } from './speech-cache-env.ts';
import type { WorkerSpeechCacheOptions } from './speech-cache-env.ts';
import { openReleaseSpeech, type ReleaseSpeechDeps } from './speech-cache-release-tts.ts';
import { SpeechPrerenderService, type PrerenderServiceInput } from './speech-cache-service.ts';
import { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

export const HYBRID_SPEECH_CACHE_PLUGIN_ID = '@winsendotai/ovo-worker/hybrid-speech-cache-output';

/**
 * Owns the process speech cache: pinned and L1 tiers in memory, the optional durable Postgres
 * tier, and the pre-render service that fills them (TTS-7/8/9).
 */
export class WorkerSpeechCacheRuntime {
  readonly cache: WorkerSpeechClipCache;
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
    if (this.service || !this.options.prerender.enabled) return this.service;
    const openSpeech =
      'openSpeech' in input
        ? input.openSpeech
        : (release: Parameters<PrerenderServiceInput['openSpeech']>[0], usage: UsageSink) =>
            openReleaseSpeech(release, usage, input.speech);
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
