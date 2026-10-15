'use client';
import { useEffect, useState } from 'react';
import type { CredentialMetadata, McpConnection } from '../../lib/api';
import { Drawer } from '../ui/drawer';
import { FormField } from '../ui/form-field';
import { Select } from '../ui/inputs';
import { InlineAlert } from '../ui/feedback-v2';

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
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  connection?: McpConnection;
  credentials: CredentialMetadata[];
  busy: boolean;
  error?: string;
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
  // A connection saved before the credential was retyped (or retired) away from `tool` still
  // carries that id; keep it selectable so editing doesn't silently show "No credential" while
  // submitting the old id unchanged underneath.
  const selectedCredential =
    draft.credentialId &&
    !toolCredentials.some((credential) => credential.id === draft.credentialId)
      ? credentials.find((credential) => credential.id === draft.credentialId)
      : undefined;

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
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
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
                options={[
                  ...(selectedCredential
                    ? [
                        {
                          value: selectedCredential.id,
                          label: `${selectedCredential.label} (not a tool credential)`,
                        },
                      ]
                    : []),
                  ...toolCredentials.map((credential) => ({
                    value: credential.id,
                    label: credential.label,
                  })),
                ]}
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
