import {
  Cap,
  type Clock,
  type SecretResolver,
  type TextFilter,
  type TextToSpeech,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { composeReleaseTextFilters } from '@winsendotai/ovo-plugin-speech-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { adaptDefinitionFormats } from '@winsendotai/ovo-session-host';
import {
  compose,
  definePlugin,
  PluginRegistry,
  type Composition,
  type ParentView,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';

export interface ReleaseSpeech {
  tts: TextToSpeech;
  filters: TextFilter[];
  close(): Promise<void>;
}

export class PrerenderSkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PrerenderSkipError';
  }
}

export interface ReleaseSpeechDeps {
  catalog: readonly PluginDefinition[];
  /** The worker's process composition: supplies `ovo.net` and the other process services. */
  parent: ParentView;
  secrets: { forAgent(agentId: string): SecretResolver };
  defaults?: { textFilters?: readonly string[] };
}

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = globalThis.setTimeout(fn, ms);
    return () => globalThis.clearTimeout(timer);
  },
};

/**
 * Composes one of a release's own provider selections (pinned plugin, binding, credential, host
 * format adapter) outside any call, through the same contracts a session uses. Nothing here is
 * provider-specific: whichever binding the release selects composes the same way.
 */
export async function composeReleaseProvider(
  release: ReleaseRecord,
  slot: 'tts' | 'stt',
  usage: UsageSink,
  deps: Omit<ReleaseSpeechDeps, 'defaults'>,
): Promise<Composition> {
  const selection = release.selections?.[slot];
  if (!selection) throw new PrerenderSkipError(`release has no pinned ${slot} selection`);
  let definition: PluginDefinition;
  try {
    definition = new PluginRegistry(deps.catalog).resolvePin(
      selection.pluginId,
      selection.version,
    ).definition;
  } catch (error) {
    throw new PrerenderSkipError(error instanceof Error ? error.message : String(error));
  }
  const binding =
    selection.binding ??
    Object.values(release.providerBindings).find((row) => row.id === selection.bindingId);
  // Mirrors session-host configFor and the worker's binding identity rows exactly.
  const config: Record<string, unknown> = {
    ...(binding
      ? {
          binding: binding.config ?? {},
          ...(binding.credentialId
            ? { credentialRef: { credentialId: binding.credentialId } }
            : {}),
        }
      : {}),
    ...selection.config,
    ...(selection.binding
      ? {
          workspaceId: release.workspaceId,
          bindingId: selection.bindingId,
          updatedAt: selection.binding.updatedAt,
        }
      : {}),
  };
  const credentialBinding = binding?.credentialId
    ? Object.values(release.providerBindings).find(
        (row) => row.credentialId === binding.credentialId,
      )
    : undefined;
  if (credentialBinding)
    Object.assign(config, {
      workspaceId: release.workspaceId,
      bindingId: credentialBinding.id,
      updatedAt: credentialBinding.updatedAt,
    });
  const host = definePlugin(
    {
      id: '@winsendotai/ovo-worker/prerender-host-services',
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [],
      provides: [Cap.secrets, Cap.usage, Cap.clock],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, deps.secrets.forAgent(release.agentId));
      ctx.provide(Cap.usage, usage);
      ctx.provide(Cap.clock, clock);
    },
  );
  const adapted = adaptDefinitionFormats(definition);
  return compose([{ id: host.manifest.id }, { id: adapted.manifest.id, config }], [host, adapted], {
    scope: 'session',
    parent: deps.parent,
    workspaceId: release.workspaceId,
  });
}

/** The release's TTS and its text filters, composed outside any call (TTS-9). */
export async function openReleaseSpeech(
  release: ReleaseRecord,
  usage: UsageSink,
  deps: ReleaseSpeechDeps,
): Promise<ReleaseSpeech> {
  const selection = release.selections?.tts;
  const composition = await composeReleaseProvider(release, 'tts', usage, deps);
  const filters = await composeReleaseTextFilters(release, deps.catalog, deps.defaults).catch(
    async (error: unknown) => {
      await composition.dispose();
      throw error;
    },
  );
  const close = async () => {
    await filters.close();
    await composition.dispose();
  };
  if (filters.unresolved.length) {
    await close();
    throw new PrerenderSkipError(`text filters not installed: ${filters.unresolved.join(', ')}`);
  }
  const tts = composition.get(Cap.tts) as TextToSpeech | undefined;
  if (!tts) {
    await close();
    throw new PrerenderSkipError(`${selection!.pluginId} did not provide a tts service`);
  }
  return { tts, filters: filters.filters, close };
}
