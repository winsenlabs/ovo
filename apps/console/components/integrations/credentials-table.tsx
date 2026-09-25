import type { CredentialMetadata, SessionIdentity } from '../../lib/api';
import { EmptyState, Panel, PanelHeader, ResponsiveTable, StatusBadge } from '../primitives';
export function CredentialMetadataTable({
  credentials,
  role,
  busy,
  rotate,
  retire,
}: {
  credentials: CredentialMetadata[];
  role: SessionIdentity['role'];
  busy?: string;
  rotate: (credential: CredentialMetadata) => Promise<void>;
  retire: (credential: CredentialMetadata) => Promise<void>;
}) {
  return (
    <Panel labelledBy="credentials-title">
      <PanelHeader
        id="credentials-title"
        title="Credential metadata"
        badge={<StatusBadge>{credentials.length}</StatusBadge>}
      />
      {credentials.length === 0 ? (
        <div className="panel-body">
          <EmptyState title="No credential metadata">
            The API returned an empty collection. No placeholder keys are displayed.
          </EmptyState>
        </div>
      ) : (
        <ResponsiveTable label="Credential metadata and lifecycle actions">
          <thead>
            <tr>
              <th>Credential</th>
              <th>Scope</th>
              <th>Safe metadata</th>
              <th>Rotate</th>
              <th>Lifecycle</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((credential) => (
              <tr key={credential.id}>
                <td>
                  <strong>{credential.label}</strong>
                  <small>
                    {credential.provider} · {credential.type}
                  </small>
                </td>
                <td>
                  {credential.environment}
                  <small>
                    {credential.permittedAgentIds?.length
                      ? `${credential.permittedAgentIds.length} permitted agents`
                      : 'No agent restriction returned'}
                  </small>
                </td>
                <td>
                  <span className="mono">
                    {credential.fingerprint ?? 'Fingerprint unavailable'}
                  </span>
                  <small>
                    {credential.status ?? 'Validation not reported'} ·{' '}
                    {credential.rotatedAt
                      ? `rotated ${new Date(credential.rotatedAt).toLocaleString()}`
                      : 'never rotated'}
                  </small>
                </td>
                <td>
                  <label className="sr-only" htmlFor={`rotate-${credential.id}`}>
                    New value for {credential.label}
                  </label>
                  <input
                    className="compact-secret"
                    id={`rotate-${credential.id}`}
                    type="password"
                    autoComplete="new-password"
                    placeholder="New value"
                  />
                  <button
                    className="button small"
                    disabled={role !== 'admin' || Boolean(busy)}
                    onClick={() => rotate(credential)}
                  >
                    Rotate
                  </button>
                </td>
                <td>
                  <button
                    className="button small danger"
                    disabled={role !== 'admin' || Boolean(busy)}
                    onClick={() => retire(credential)}
                  >
                    Retire
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      )}
    </Panel>
  );
}
