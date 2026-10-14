'use client';
import { useEffect, useState } from 'react';
import type { CredentialMetadata, McpConnection } from '../../lib/api';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';

type ConnectionPayload = {
  label: string;
  endpoint: string;
  auth: 'none' | 'bearer';
  credentialId?: string;
};
const EMPTY: ConnectionPayload = { label: '', endpoint: '', auth: 'none', credentialId: '' };

export function ConnectionDrawer({
  open,
  connection,
  credentials,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  connection?: McpConnection;
  credentials: CredentialMetadata[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: ConnectionPayload) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ConnectionPayload>(EMPTY);
  useEffect(() => {
    if (!open) return;
    setDraft(
      connection
        ? {
            label: connection.label,
            endpoint: connection.endpoint,
            auth: connection.auth,
            credentialId: connection.credentialId ?? '',
          }
        : EMPTY,
    );
  }, [open, connection]);
  const patch = (value: Partial<ConnectionPayload>) =>
    setDraft((current) => ({ ...current, ...value }));
  const toolCredentials = credentials.filter((credential) => credential.type === 'tool');

  return (
    <Drawer
      open={open}
      title={connection ? `Edit ${connection.label}` : 'Add MCP connection'}
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit({ ...draft, credentialId: draft.credentialId || undefined });
        }}
      >
        <FormField id="mcp-label" label="Connection label" required>
          {(props) => (
            <input
              {...props}
              value={draft.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="mcp-endpoint"
          label="Remote HTTP endpoint"
          help="Arbitrary browser-entered shell commands are not supported."
          required
        >
          {(props) => (
            <input
              {...props}
              type="url"
              value={draft.endpoint}
              onChange={(e) => patch({ endpoint: e.target.value })}
            />
          )}
        </FormField>
        <div className="form-grid">
          <FormField id="mcp-auth" label="Authentication">
            {(props) => (
              <Select
                {...props}
                value={draft.auth}
                onChange={(value) => patch({ auth: value as ConnectionPayload['auth'] })}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'bearer', label: 'Bearer credential' },
                ]}
              />
            )}
          </FormField>
          <FormField id="mcp-credential" label="Credential reference">
            {(props) => (
              <Select
                {...props}
                value={draft.credentialId ?? ''}
                onChange={(value) => patch({ credentialId: value })}
                placeholder="No credential"
                options={toolCredentials.map((credential) => ({
                  value: credential.id,
                  label: credential.label,
                }))}
              />
            )}
          </FormField>
        </div>
        <div className="button-row">
          <button className="button primary" disabled={busy || !draft.label || !draft.endpoint}>
            {busy ? 'Saving…' : connection ? 'Save connection' : 'Create connection'}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
