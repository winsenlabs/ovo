import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ProviderEvaluationGate } from './service.ts';
import {
  providerEvaluationPolicy,
  providerEvaluationReservationId,
  type ProviderEvaluationAuthorizationResolver,
  type ProviderEvaluationReleaseLoader,
  validateProviderEvaluationPolicy,
} from './provider-policy.ts';

export class LedgerProviderEvaluationGate implements ProviderEvaluationGate {
  constructor(
    private readonly ledger: CostLedgerService,
    private readonly releases: ProviderEvaluationReleaseLoader,
    private readonly authorizations: ProviderEvaluationAuthorizationResolver,
  ) {}

  async authorize(input: Parameters<ProviderEvaluationGate['authorize']>[0]): Promise<void> {
    const release = await this.releases.load(input.workspaceId, input.releaseId);
    if (!input.budgetAuthorizationId)
      throw Object.assign(new Error('Provider evaluation budget authorization was not found'), {
        statusCode: 403,
        code: 'provider_evaluation_not_authorized',
      });
    const policy = providerEvaluationPolicy(
      release,
      input.fixtureBindingVersion,
      input.workspaceId,
    );
    const reserve = async (authorization: Awaited<ReturnType<typeof this.authorizations.get>>) => {
      if (
        !authorization ||
        !matchesAuthorization(authorization, input, release.fingerprint, policy)
      )
        return undefined;
      await validateProviderEvaluationPolicy(this.ledger, input.workspaceId, policy);
      const reservationId = providerEvaluationReservationId({
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
      });
      const reservation = await this.ledger.reserveBudget({
        budgetId: policy.budgetId,
        reservationId,
        amountPaise: policy.reservationPaise,
        sourceRef: `evaluation:${input.releaseId}:${input.datasetId}:${input.datasetVersion}`,
      });
      if (!reservation.admitted)
        throw Object.assign(new Error('Provider evaluation budget threshold exceeded'), {
          statusCode: 402,
          code: 'provider_evaluation_budget_exceeded',
        });
      return true;
    };
    const authorized = this.authorizations.withActive
      ? await this.authorizations.withActive(input.budgetAuthorizationId, reserve)
      : await reserve(await this.authorizations.get(input.budgetAuthorizationId));
    if (!authorized)
      throw Object.assign(new Error('Provider evaluation budget authorization does not match'), {
        statusCode: 403,
        code: 'provider_evaluation_not_authorized',
      });
  }
}

function matchesAuthorization(
  authorization: NonNullable<Awaited<ReturnType<ProviderEvaluationAuthorizationResolver['get']>>>,
  input: Parameters<ProviderEvaluationGate['authorize']>[0],
  releaseFingerprint: string,
  policy: ReturnType<typeof providerEvaluationPolicy>,
) {
  return (
    authorization.workspaceId === input.workspaceId &&
    authorization.releaseId === input.releaseId &&
    authorization.releaseFingerprint === releaseFingerprint &&
    authorization.bindingVersion === input.fixtureBindingVersion &&
    authorization.provider === policy.provider &&
    authorization.modelId === policy.modelId &&
    authorization.budgetId === policy.budgetId &&
    BigInt(policy.reservationPaise) <= BigInt(authorization.maximumReservationPaise)
  );
}
