'use client';
import type { ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { ResponsiveTable, StatusBadge } from '../primitives';
export function ProviderAuthorizationsTable({
  authorizations,
  busy,
  revoke,
}: {
  authorizations: ProviderEvaluationAuthorization[];
  busy: boolean;
  revoke: (authorization: ProviderEvaluationAuthorization) => Promise<void>;
}) {
  return (
    <ResponsiveTable label="Provider evaluation authorizations">
      <thead>
        <tr>
          <th>Immutable release</th>
          <th>Provider binding</th>
          <th>Budget authorization</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {authorizations.map((authorization) => (
          <tr key={authorization.id}>
            <td>
              <span className="mono">{authorization.releaseId}</span>
              <small>{authorization.releaseFingerprint}</small>
            </td>
            <td>
              {authorization.provider} · {authorization.modelId}
              <small className="mono">{authorization.bindingVersion}</small>
            </td>
            <td>
              <span className="mono">{authorization.budgetId}</span>
              <small className="mono">Authorization {authorization.id}</small>
              <small>Maximum {authorization.maximumReservationPaise} paise</small>
            </td>
            <td>
              <StatusBadge tone={authorization.revokedAt ? 'warning' : 'good'}>
                {authorization.revokedAt ? 'Revoked' : 'Active'}
              </StatusBadge>
              <small>{new Date(authorization.createdAt).toLocaleString()}</small>
            </td>
            <td>
              <button
                className="button small danger"
                type="button"
                disabled={busy || Boolean(authorization.revokedAt)}
                onClick={() => void revoke(authorization)}
              >
                Revoke
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </ResponsiveTable>
  );
}
