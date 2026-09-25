import type { ProviderBinding, SessionIdentity } from '../../lib/api';
import { EmptyState, JsonEvidence, ResponsiveTable } from '../primitives';
export function BindingsTable({ bindings, role, busy, onEdit, onRemove }: {
  bindings: ProviderBinding[]; role: SessionIdentity['role']; busy: boolean;
  onEdit: (binding: ProviderBinding) => void;
  onRemove: (binding: ProviderBinding) => Promise<void>;
}) {
  return <>
        {!bindings.length ? (
          <EmptyState title="No provider bindings">
            Create a binding before assigning provider roles to an agent.
          </EmptyState>
        ) : (
          <ResponsiveTable label="Provider bindings">
            <thead>
              <tr>
                <th>Binding</th>
                <th>Provider</th>
                <th>Environment</th>
                <th>Credential</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((binding) => (
                <tr key={binding.id}>
                  <td>
                    <strong>{binding.label}</strong>
                    <small className="mono">{binding.id}</small>
                  </td>
                  <td>
                    {binding.provider}
                    <JsonEvidence label="Configuration" value={binding.config ?? {}} />
                  </td>
                  <td>{binding.environment}</td>
                  <td className="mono">{binding.credentialId}</td>
                  <td>
                    <div className="button-row">
                      <button
                        className="button small"
                        type="button"
                        disabled={role !== 'admin' || busy}
                        onClick={() => onEdit(binding)}
                      >
                        Edit
                      </button>
                      <button
                        className="button small danger"
                        type="button"
                        disabled={role !== 'admin' || busy}
                        onClick={() => void onRemove(binding)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
  </>;
}
