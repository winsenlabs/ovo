import type { ProviderEvaluationAuthorization } from '../../lib/operator-api';

export type ProviderEvaluationAvailability = 'unknown' | 'enabled' | 'disabled' | 'admin-only';

export function activeProviderAuthorizations(
  authorizations: ProviderEvaluationAuthorization[],
  releaseId: string,
): ProviderEvaluationAuthorization[] {
  return authorizations.filter(
    (authorization) => authorization.releaseId === releaseId && !authorization.revokedAt,
  );
}

export function providerRunAuthorization(
  authorizations: ProviderEvaluationAuthorization[],
  releaseId: string,
  authorizationId: string,
): { providerBindingVersion: string; budgetAuthorizationId: string } {
  const authorization = activeProviderAuthorizations(authorizations, releaseId).find(
    (candidate) => candidate.id === authorizationId,
  );
  if (!authorization) throw new Error('Select an active authorization for this immutable release.');
  return {
    providerBindingVersion: authorization.bindingVersion,
    budgetAuthorizationId: authorization.id,
  };
}
