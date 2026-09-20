import {
  LedgerProviderEvaluationGate,
  ProviderEvaluationExecutor,
  releaseEvaluationFingerprint,
  type ProviderEvaluationInferenceFactory,
  type ProviderEvaluationAuthorizationResolver,
  type ProviderEvaluationReleaseLoader,
  type ReleaseEvaluationSnapshot,
} from '@winsendotai/ovo-plugin-evaluations';
import { AiSdkInference } from '@winsendotai/ovo-plugin-inference';
import type { CostLedgerService, InferenceUsageEvidence } from '@winsendotai/ovo-plugin-ledger';
import {
  createOpenAiModelFactory,
  openAiInferenceBindingFromRecord,
} from '@winsendotai/ovo-plugin-providers';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';

export interface ProviderEvaluationRuntimeOptions {
  ledger: CostLedgerService;
  secrets: SecretManager;
  store: Pick<ControlStore, 'getRelease'>;
  maxCaseDurationMs?: number;
  maxProviderRequestsPerCase?: number;
  maxOutputTokens?: number;
  inferenceFactory?: ProviderEvaluationInferenceFactory;
  authorizations: ProviderEvaluationAuthorizationResolver;
}

export function createProviderEvaluationRuntime(
  options: ProviderEvaluationRuntimeOptions,
  environment: { OVO_PROVIDER_EVALUATIONS_ENABLED?: string } = process.env,
) {
  if (environment.OVO_PROVIDER_EVALUATIONS_ENABLED !== 'true') return undefined;
  const releases = new StoreProviderEvaluationReleaseLoader(options.store);
  const inference =
    options.inferenceFactory ?? new OpenAiProviderEvaluationInferenceFactory(options.secrets);
  return {
    providerGate: new LedgerProviderEvaluationGate(
      options.ledger,
      releases,
      options.authorizations,
    ),
    providerExecutor: new ProviderEvaluationExecutor({
      ledger: options.ledger,
      inference,
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
    return {
      id: release.id,
      workspaceId: release.workspaceId,
      agentId: release.agentId,
      fingerprint: releaseEvaluationFingerprint(release),
      config: release.config,
      providerBindings: release.providerBindings,
    };
  }
}

class OpenAiProviderEvaluationInferenceFactory implements ProviderEvaluationInferenceFactory {
  constructor(private readonly secrets: SecretManager) {}

  async create(input: {
    release: ReleaseEvaluationSnapshot;
    bindingVersion: string;
    provider: string;
    modelId: string;
    maxOutputTokens: number;
    signal: AbortSignal;
    onUsage(evidence: InferenceUsageEvidence): Promise<void>;
  }) {
    input.signal.throwIfAborted();
    const record = input.release.providerBindings?.inference;
    if (!record || !input.release.agentId)
      throw new Error('Immutable provider evaluation release data is incomplete');
    const binding = openAiInferenceBindingFromRecord(record);
    if (
      input.provider !== 'openai' ||
      binding.bindingVersion !== input.bindingVersion ||
      binding.model !== input.modelId
    )
      throw new Error('Immutable provider evaluation binding changed');
    if (input.release.workspaceId && binding.workspaceId !== input.release.workspaceId)
      throw new Error('Provider evaluation binding workspace mismatch');
    const models = await createOpenAiModelFactory(
      binding,
      this.secrets.forAgent(input.release.agentId),
    );
    input.signal.throwIfAborted();
    return new AiSdkInference({
      model: models.model(),
      maxOutputTokens: input.maxOutputTokens,
      onUsage: input.onUsage,
    });
  }
}
