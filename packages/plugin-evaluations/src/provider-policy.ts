import { createHash } from 'node:crypto';
import {
  inferenceMeterKey,
  type CostLedgerService,
  type InferenceMeterUnit,
} from '@winsendotai/ovo-plugin-ledger';
import type { ReleaseEvaluationSnapshot } from './types.ts';

export interface ProviderEvaluationPriceReference {
  id: string;
  version: string;
  fxId?: string;
  fxVersion?: string;
}

export interface ProviderEvaluationPolicy {
  budgetId: string;
  reservationPaise: string;
  provider: string;
  modelId: string;
  bindingVersion: string;
  priceCards: ReadonlyMap<string, ProviderEvaluationPriceReference>;
}

export interface ProviderEvaluationAuthorization {
  id: string;
  workspaceId: string;
  releaseId: string;
  releaseFingerprint: string;
  bindingVersion: string;
  provider: string;
  modelId: string;
  budgetId: string;
  maximumReservationPaise: string;
  createdBy: string;
  createdAt: string;
  revokedBy?: string;
  revokedAt?: string;
}

export interface ProviderEvaluationAuthorizationResolver {
  get(id: string): Promise<ProviderEvaluationAuthorization | undefined>;
  withActive?<T>(
    id: string,
    operation: (authorization: ProviderEvaluationAuthorization) => Promise<T>,
  ): Promise<T | undefined>;
}

export interface ProviderEvaluationReleaseLoader {
  load(workspaceId: string, releaseId: string): Promise<ReleaseEvaluationSnapshot>;
}

export function providerEvaluationPolicy(
  release: ReleaseEvaluationSnapshot,
  requestedBindingVersion: string,
  workspaceId?: string,
): ProviderEvaluationPolicy {
  const binding = release.providerBindings?.inference;
  if (!binding) throw forbidden('The immutable release has no inference binding');
  if (
    (workspaceId && release.workspaceId && release.workspaceId !== workspaceId) ||
    (workspaceId && binding.workspaceId !== workspaceId)
  )
    throw forbidden('Provider evaluation release workspace mismatch');
  const bindingVersion = `${binding.id}:${binding.updatedAt}`;
  if (bindingVersion !== requestedBindingVersion)
    throw forbidden('Provider binding version does not match the immutable release');
  if (binding.provider !== 'openai')
    throw forbidden('Only the installed OpenAI inference provider is supported');
  const modelId = binding.config.model;
  if (typeof modelId !== 'string' || !modelId.trim())
    throw forbidden('The immutable inference model is invalid');
  const cost = release.config.costPolicy;
  if (!cost) throw forbidden('The immutable release has no cost policy');
  const priceCards = new Map(
    Object.entries(cost.priceCards).map(([key, reference]) => [
      key,
      Object.freeze({ ...reference }),
    ]),
  );
  for (const unit of requiredInferenceUnits()) {
    if (!priceCards.has(inferenceMeterKey(binding.provider, unit)))
      throw forbidden(`The release cost policy is missing ${unit}`);
  }
  return {
    budgetId: cost.budgetId,
    reservationPaise: cost.reservationPaise,
    provider: binding.provider,
    modelId,
    bindingVersion,
    priceCards,
  };
}

export class StaticProviderEvaluationAuthorizations implements ProviderEvaluationAuthorizationResolver {
  private readonly values = new Map<string, ProviderEvaluationAuthorization>();

  constructor(authorizations: readonly ProviderEvaluationAuthorization[]) {
    if (!authorizations.length || authorizations.length > 1_000)
      throw new TypeError('Provider evaluations require an admin-authorized budget policy');
    for (const authorization of authorizations) {
      if (
        !boundedText(authorization.id, 200) ||
        !boundedText(authorization.workspaceId, 200) ||
        !boundedText(authorization.releaseId, 200) ||
        !boundedText(authorization.releaseFingerprint, 512) ||
        !boundedText(authorization.bindingVersion, 512) ||
        !boundedText(authorization.provider, 100) ||
        !boundedText(authorization.modelId, 512) ||
        !boundedText(authorization.budgetId, 200) ||
        !boundedText(authorization.createdBy, 200) ||
        !boundedText(authorization.createdAt, 100) ||
        typeof authorization.maximumReservationPaise !== 'string' ||
        !/^[1-9][0-9]{0,59}$/.test(authorization.maximumReservationPaise) ||
        authorization.revokedAt ||
        this.values.has(authorization.id)
      )
        throw new TypeError('Provider evaluation authorization is invalid');
      this.values.set(authorization.id, Object.freeze({ ...authorization }));
    }
  }

  async get(id: string): Promise<ProviderEvaluationAuthorization | undefined> {
    const value = this.values.get(id);
    return value ? { ...value } : undefined;
  }
}

export async function validateProviderEvaluationPolicy(
  ledger: CostLedgerService,
  workspaceId: string,
  policy: ProviderEvaluationPolicy,
): Promise<void> {
  const budget = await ledger.getBudget(policy.budgetId);
  if (!budget || budget.workspaceId !== workspaceId)
    throw forbidden('The admin-authorized evaluation budget was not found');
  for (const [meterKey, reference] of policy.priceCards) {
    if (!meterKey.startsWith(`${policy.provider}.inference.`)) continue;
    const expectedUnit = meterKey.slice(`${policy.provider}.inference.`.length);
    const card = await ledger.getPriceCard(reference.id, reference.version);
    if (!card || card.provider !== policy.provider || card.unit !== expectedUnit)
      throw forbidden(`Price card ${meterKey} does not match the immutable policy`);
    if (card.currency !== 'INR') {
      if (!reference.fxId || !reference.fxVersion)
        throw forbidden(`Price card ${meterKey} requires an immutable INR FX reference`);
      const fx = await ledger.getFxVersion(reference.fxId, reference.fxVersion);
      if (!fx || fx.baseCurrency !== card.currency || fx.quoteCurrency !== 'INR')
        throw forbidden(`FX reference ${meterKey} does not match the immutable policy`);
    }
  }
}

export function providerEvaluationReservationId(input: {
  workspaceId: string;
  idempotencyKey: string;
}): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `evaluation-provider:${digest}`;
}

function requiredInferenceUnits(): InferenceMeterUnit[] {
  return [
    'uncached_input_tokens',
    'cache_read_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
  ];
}

function forbidden(message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: 403,
    code: 'provider_evaluation_not_authorized',
  });
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
}
