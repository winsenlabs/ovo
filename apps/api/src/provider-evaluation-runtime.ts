import {
  LedgerProviderEvaluationGate,
  ProviderEvaluationExecutor,
  releaseEvaluationFingerprint,
  type ProviderEvaluationInferenceFactory,
  type ProviderEvaluationAuthorizationResolver,
  type ProviderEvaluationReleaseLoader,
  type ReleaseEvaluationSnapshot,
  type EvaluationHostFactories,
} from '@winsendotai/ovo-plugin-evaluations';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import {
  ExecutingFaqBehavior,
  createAgentBehavior,
  createAnnouncementBehavior,
  createContextBehavior,
  createFaqBehavior,
  withScript,
} from '@winsendotai/ovo-behaviors';
import { createExecutionService } from '@winsendotai/ovo-plugin-tools';
import type { NetPort } from '@winsendotai/ovo-contracts';
import { PluginRegistry, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { InstalledProviderEvaluationInferenceFactory } from './provider-evaluation-inference.ts';

export const evaluationHostFactories: EvaluationHostFactories = {
  createExecution(config, deps) {
    return createExecutionService(
      {
        tools: config.tools,
        allowedTools: config.allowedTools,
        processing: config.processing,
      },
      deps,
    );
  },
  createBehavior(config, deps) {
    let behavior;
    if (config.mode === 'announcement') behavior = createAnnouncementBehavior(config);
    else if (config.mode === 'faq')
      behavior = config.faq.some((entry) => entry.requiresTool)
        ? new ExecutingFaqBehavior(config, deps.execution, {
            workspaceId: deps.workspaceId,
            sessionId: deps.sessionId,
          })
        : createFaqBehavior(config);
    else if (config.mode === 'context') behavior = createContextBehavior(config, deps.inference);
    else {
      let id = 0;
      behavior = createAgentBehavior(config, deps.inference, deps.execution, {
        workspaceId: deps.workspaceId,
        sessionId: deps.sessionId,
        operationId: () => `fixture-operation-${++id}`,
      });
    }
    return withScript(config, behavior);
  },
};

export interface ProviderEvaluationRuntimeOptions {
  ledger: CostLedgerService;
  secrets: SecretManager;
  store: Pick<ControlStore, 'getRelease'>;
  maxCaseDurationMs?: number;
  maxProviderRequestsPerCase?: number;
  maxOutputTokens?: number;
  inferenceFactory?: ProviderEvaluationInferenceFactory;
  authorizations: ProviderEvaluationAuthorizationResolver;
  hostFactories: EvaluationHostFactories;
  catalog?: readonly PluginDefinition[];
  net?: NetPort;
}

export function createProviderEvaluationRuntime(
  options: ProviderEvaluationRuntimeOptions,
  environment: { OVO_PROVIDER_EVALUATIONS_ENABLED?: string } = process.env,
) {
  if (environment.OVO_PROVIDER_EVALUATIONS_ENABLED !== 'true') return undefined;
  const releases = new StoreProviderEvaluationReleaseLoader(options.store);
  const registry = options.catalog ? new PluginRegistry(options.catalog) : undefined;
  const inference =
    options.inferenceFactory ??
    new InstalledProviderEvaluationInferenceFactory(
      options.catalog ?? [],
      options.secrets,
      options.net,
    );
  return {
    providerGate: new LedgerProviderEvaluationGate(
      options.ledger,
      releases,
      options.authorizations,
      registry,
    ),
    providerExecutor: new ProviderEvaluationExecutor({
      ledger: options.ledger,
      inference,
      hostFactories: options.hostFactories,
      authorizations: options.authorizations,
      maxCaseDurationMs: options.maxCaseDurationMs,
      maxProviderRequestsPerCase: options.maxProviderRequestsPerCase,
      maxOutputTokens: options.maxOutputTokens,
    }),
    releases,
  };
}

export class StoreProviderEvaluationReleaseLoader implements ProviderEvaluationReleaseLoader {
  constructor(private readonly store: Pick<ControlStore, 'getRelease'>) {}

  async load(workspaceId: string, releaseId: string): Promise<ReleaseEvaluationSnapshot> {
    const release = await this.store.getRelease(workspaceId, releaseId);
    if (!release)
      throw Object.assign(new Error('Release not found'), {
        statusCode: 404,
        code: 'release_not_found',
      });
    const selected = release.selections?.llm;
    const selectedBinding =
      selected?.binding && selected.bindingId
        ? {
            id: selected.bindingId,
            workspaceId: release.workspaceId,
            provider: selected.binding.provider,
            credentialId: selected.binding.credentialId,
            config: selected.binding.config,
            updatedAt: selected.binding.updatedAt,
            pluginId: selected.pluginId,
            pluginVersion: selected.version,
          }
        : undefined;
    return {
      id: release.id,
      workspaceId: release.workspaceId,
      agentId: release.agentId,
      fingerprint: releaseEvaluationFingerprint(release),
      config: release.config,
      providerBindings: {
        ...release.providerBindings,
        ...(selectedBinding
          ? { inference: selectedBinding }
          : release.providerBindings.inference
            ? {
                inference: {
                  ...release.providerBindings.inference,
                  pluginId: release.providerBindings.inference.pluginId,
                },
              }
            : {}),
      } as unknown as ReleaseEvaluationSnapshot['providerBindings'],
    };
  }
}
