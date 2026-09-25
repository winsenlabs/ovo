'use client';
import { useState } from 'react';
import type { JsonShape, PluginOption } from './types';
import type { CredentialMetadata } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { JsonEditor } from '../forms/json-editor';

function fieldValue(value: Record<string, unknown>, key: string): string {
  return value[key] == null ? '' : String(value[key]);
}
function storedCredentialId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('credentialRef' in value)) return undefined;
  const reference = value.credentialRef;
  return reference &&
    typeof reference === 'object' &&
    'credentialId' in reference &&
    typeof reference.credentialId === 'string'
    ? reference.credentialId
    : undefined;
}
export function SchemaForm({
  plugin,
  schema = plugin.bindingSchema ?? plugin.configSchema,
  value,
  onChange,
  onSecret,
  fingerprints = {},
  credentials,
}: {
  plugin: PluginOption;
  schema?: JsonShape;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onSecret?: (pointer: string, secret: string) => void | Promise<void>;
  fingerprints?: Record<string, string>;
  credentials?: readonly CredentialMetadata[];
}) {
  const [secretErrors, setSecretErrors] = useState<Record<string, string>>({});
  const properties = Object.entries(schema?.properties ?? {});
  const patch = (key: string, next: unknown) => onChange({ ...value, [key]: next });
  return (
    <div className="ui-stack">
      {properties
        .filter(([key]) => !plugin.ui?.fields?.[key]?.advanced)
        .map(([key, shape]) => {
          const hint = plugin.ui?.fields?.[key];
          const id = `schema-${plugin.id.replace(/[^a-z0-9-]/gi, '-')}-${key}`;
          const required = schema?.required?.includes(key) ?? false;
          const label = hint?.label ?? key;
          const help = hint?.help ?? shape.description;
          if (plugin.secretFields?.includes(`/${key}`) || hint?.widget === 'secret') {
            if (!onSecret) {
              if (!credentials)
                return (
                  <p key={key}>
                    <strong>{label}:</strong> Use the binding credential above. Secret values cannot
                    be entered in binding configuration.
                  </p>
                );
              const selected = storedCredentialId(value[key]);
              const options = credentials.filter(
                (credential) => !plugin.provider || credential.provider === plugin.provider,
              );
              return (
                <div className="ui-stack" key={key}>
                  <FormField
                    id={id}
                    label={label}
                    help="Select a stored credential reference; secret values are never saved in plugin configuration."
                    required={required}
                  >
                    {(props) => (
                      <select
                        {...props}
                        value={selected ?? ''}
                        onChange={(event) =>
                          patch(
                            key,
                            event.target.value
                              ? { credentialRef: { credentialId: event.target.value } }
                              : undefined,
                          )
                        }
                      >
                        <option value="">Select stored credential</option>
                        {selected && !options.some((credential) => credential.id === selected) && (
                          <option value={selected}>Current stored credential</option>
                        )}
                        {options.map((credential) => (
                          <option key={credential.id} value={credential.id}>
                            {credential.label}
                            {credential.fingerprint ? ` · ${credential.fingerprint}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </FormField>
                  <a href="/settings/providers">Create a write-only credential</a>
                </div>
              );
            }
            const selected = storedCredentialId(value[key]);
            const fingerprint =
              fingerprints[key] ??
              credentials?.find((credential) => credential.id === selected)?.fingerprint;
            return (
              <FormField
                key={key}
                id={id}
                label={label}
                help={fingerprint ? `Stored · fingerprint ${fingerprint}` : help}
                error={secretErrors[key]}
                required={required}
              >
                {(props) => (
                  <input
                    {...props}
                    type="password"
                    autoComplete="off"
                    defaultValue=""
                    onBlur={(event) => {
                      const input = event.currentTarget;
                      if (!input.value) return;
                      const secret = input.value;
                      void (async () => {
                        try {
                          await onSecret(`/${key}`, secret);
                          input.value = '';
                          setSecretErrors((current) => ({ ...current, [key]: '' }));
                        } catch (failure) {
                          setSecretErrors((current) => ({
                            ...current,
                            [key]:
                              failure instanceof Error
                                ? failure.message
                                : 'Credential could not be saved',
                          }));
                        }
                      })();
                    }}
                  />
                )}
              </FormField>
            );
          }
          if (shape.const === true)
            return (
              <FormField key={key} id={id} label={label} help={help} required>
                {(props) => (
                  <label className="toggle-row">
                    <input
                      {...props}
                      type="checkbox"
                      checked={value[key] === true}
                      onChange={(event) => patch(key, event.target.checked)}
                    />
                    I attest this requirement is met
                  </label>
                )}
              </FormField>
            );
          if (shape.enum?.length)
            return (
              <FormField key={key} id={id} label={label} help={help} required={required}>
                {(props) => (
                  <select
                    {...props}
                    value={fieldValue(value, key)}
                    onChange={(event) => patch(key, event.target.value)}
                  >
                    <option value="">Select</option>
                    {shape.enum?.map((option) => (
                      <option key={String(option)} value={String(option)}>
                        {String(option)}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            );
          if (shape.type === 'boolean')
            return (
              <FormField key={key} id={id} label={label} help={help} required={required}>
                {(props) => (
                  <input
                    {...props}
                    type="checkbox"
                    role="switch"
                    checked={value[key] === true}
                    onChange={(event) => patch(key, event.target.checked)}
                  />
                )}
              </FormField>
            );
          if (shape.type === 'number' || shape.type === 'integer')
            return (
              <FormField key={key} id={id} label={label} help={help} required={required}>
                {(props) => (
                  <input
                    {...props}
                    type="number"
                    min={shape.minimum}
                    max={shape.maximum}
                    value={fieldValue(value, key)}
                    onChange={(event) =>
                      patch(key, event.target.value === '' ? undefined : Number(event.target.value))
                    }
                  />
                )}
              </FormField>
            );
          return (
            <FormField key={key} id={id} label={label} help={help} required={required}>
              {(props) => (
                <input
                  {...props}
                  type="text"
                  value={fieldValue(value, key)}
                  onChange={(event) => patch(key, event.target.value)}
                />
              )}
            </FormField>
          );
        })}
      <details>
        <summary>Advanced JSON</summary>
        <JsonEditor
          id={`schema-json-${plugin.id.replace(/[^a-z0-9-]/gi, '-')}`}
          value={value}
          onValid={(next) => onChange(next as Record<string, unknown>)}
        />
      </details>
    </div>
  );
}
