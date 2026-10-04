import { Cap, type Inference, type NetPort, type UsageMeter } from '@winsendotai/ovo-contracts';
import type {
  ProviderEvaluationInferenceFactory,
  ReleaseEvaluationSnapshot,
} from '@winsendotai/ovo-plugin-evaluations';
import type { InferenceUsageEvidence } from '@winsendotai/ovo-plugin-ledger';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import {
  compose,
  definePlugin,
  manifestKeys,
  PluginRegistry,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';

/** Evaluation creates the release-selected llm inside a bounded, per-request graph. */
export class InstalledProviderEvaluationInferenceFactory implements ProviderEvaluationInferenceFactory {
  private readonly registry: PluginRegistry;

  constructor(
    catalog: readonly PluginDefinition[],
    private readonly secrets: SecretManager,
    private readonly net?: NetPort,
  ) {
    this.registry = new PluginRegistry(catalog);
  }

  async create(input: {
    release: ReleaseEvaluationSnapshot;
    bindingVersion: string;
    provider: string;
    modelId: string;
    maxOutputTokens: number;
    signal: AbortSignal;
    onUsage(evidence: InferenceUsageEvidence): Promise<void>;
  }): Promise<Inference> {
    input.signal.throwIfAborted();
    const binding = input.release.providerBindings?.inference;
    if (!binding || !input.release.agentId || !input.release.workspaceId)
      throw new Error('Immutable provider evaluation release data is incomplete');
    if (
      binding.workspaceId !== input.release.workspaceId ||
      binding.provider !== input.provider ||
      `${binding.id}:${binding.updatedAt}` !== input.bindingVersion ||
      binding.config.model !== input.modelId
    )
      throw new Error('Immutable provider evaluation binding changed');
    const pinned = binding as typeof binding & { pluginId?: string | null; pluginVersion?: string };
    const id = pinned.pluginId;
    const selected = id
      ? pinned.pluginVersion
        ? this.registry.resolvePin(id, pinned.pluginVersion).definition
        : this.registry.get(id)
      : this.registry.resolve('llm', input.provider);
    if (
      !selected ||
      manifestKeys(selected.manifest).manifest.kind !== 'llm' ||
      manifestKeys(selected.manifest).manifest.provider !== input.provider
    )
      throw new Error(`Installed llm plugin for ${input.provider} is unavailable`);
    const config: Record<string, unknown> = {
      binding: structuredClone(binding.config),
      credentialRef: { credentialId: binding.credentialId },
      workspaceId: binding.workspaceId,
      bindingId: binding.id,
      updatedAt: binding.updatedAt,
    };
    if (
      'maxOutputTokens' in
      ((selected.manifest.configSchema.properties as Record<string, unknown>) ?? {})
    )
      config.maxOutputTokens = input.maxOutputTokens;

    const open = async () => {
      const metered = new Map<string, Record<string, number>>();
      let anonymous = 0;
      const host = definePlugin(
        {
          id: '@winsendotai/ovo-api/evaluation-host',
          version: '0.1.0',
          contractVersion: 2,
          scope: 'session',
          kind: 'host',
          provides: [Cap.usage, Cap.secrets, ...(this.net ? [Cap.net] : [])],
          requires: [],
          configSchema: { type: 'object', additionalProperties: false },
          secretFields: [],
        },
        (ctx) => {
          ctx.provide(Cap.secrets, this.secrets.forAgent(input.release.agentId!));
          ctx.provide(Cap.usage, (meter: UsageMeter) => {
            const id = meter.requestId || `evaluation:${++anonymous}`;
            const usage = metered.get(id) ?? {};
            const key = COUNTER[meter.unit];
            if (key) usage[key] = Number(meter.quantity);
            metered.set(id, usage);
          });
          if (this.net) ctx.provide(Cap.net, this.net);
        },
      );
      const composition = await compose(
        [{ id: host.manifest.id }, { id: selected.manifest.id, config }],
        [host, selected],
        {
          scope: 'session',
          workspaceId: input.release.workspaceId,
          net: this.net,
        },
      );
      const inference = composition.ctx.get(Cap.inference) as Inference | undefined;
      if (!inference) {
        await composition.dispose();
        throw new Error(`Selected llm ${selected.manifest.id} did not provide inference`);
      }
      const flush = async () => {
        for (const [requestId, usage] of metered)
          await input.onUsage({ requestId, modelId: input.modelId, usage });
      };
      return { composition, inference, flush };
    };
    return {
      provider: input.provider,
      model: input.modelId,
      generate: async (request) => {
        const call = await open();
        try {
          const result = await call.inference.generate(request);
          await call.flush();
          return result;
        } finally {
          await call.composition.dispose();
        }
      },
      stream: async function* (request) {
        const call = await open();
        try {
          if (!call.inference.stream) throw new Error('Selected llm does not support streaming');
          yield* call.inference.stream(request);
          await call.flush();
        } finally {
          await call.composition.dispose();
        }
      },
    };
  }
}

const COUNTER: Readonly<Record<string, string>> = {
  input_tokens: 'inputTokens',
  uncached_input_tokens: 'uncachedInputTokens',
  cache_read_input_tokens: 'cacheReadInputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens',
  output_tokens: 'outputTokens',
};
