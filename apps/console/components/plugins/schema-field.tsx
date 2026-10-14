// One schema property's control, recursively for a nested `object` shape (brief §3 "Agent
// plugins": object-typed properties — `session`, `engine`, `idle`… — used to render as a single
// flat text input; a nested, collapsible group of its own fields is the actual defect fix).
// Split out of `schema-form.tsx` to stay under the module-size gate.
import type { ReactNode } from 'react';
import type { JsonShape } from './types';
import { FormField } from '../ui/form-field';
import { TagInput } from '../ui/inputs';
import { LocatorListField } from './locator-list-field';
import { fieldValue, storedCredentialId, type FieldArgs } from './schema-field-helpers';

export type { FieldArgs };

export function renderSchemaField([key, shape]: [string, JsonShape], args: FieldArgs): ReactNode {
  const {
    plugin,
    value,
    patch,
    onSecret,
    fingerprints,
    credentials,
    secretErrors,
    setSecretErrors,
    prefix,
    requiredKeys,
  } = args;
  const hint = plugin.ui?.fields?.[key];
  const id = `schema-${prefix}${plugin.id.replace(/[^a-z0-9-]/gi, '-')}-${key}`;
  const required = requiredKeys.has(key);
  const label = hint?.label ?? key;
  const help = hint?.help ?? shape.description;

  if (plugin.secretFields?.includes(`/${key}`) || hint?.widget === 'secret') {
    if (!onSecret) {
      if (!credentials)
        return (
          <p key={key}>
            <strong>{label}:</strong> Use the binding credential above. Secret values cannot be
            entered in binding configuration.
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
                      failure instanceof Error ? failure.message : 'Credential could not be saved',
                  }));
                }
              })();
            }}
          />
        )}
      </FormField>
    );
  }

  if (shape.type === 'array' && shape.items?.properties?.id)
    return (
      <LocatorListField
        key={key}
        field={{ id, label, help, max: shape.maxItems ?? 3 }}
        value={value[key]}
        onChange={(next) => patch(key, next)}
      />
    );

  if (shape.type === 'array' && shape.items?.type === 'string')
    // Not `FormField`: it associates its label via `htmlFor`/`id` on the control `FormField`
    // renders, but `TagInput` takes no `id` prop to receive it, which left its one real input
    // unlabelled (axe `label`, critical). Wrapping it in a `<label>` instead gives that input
    // an accessible name by containment, the same technique `RadioCardGroup` already uses.
    return (
      <label key={key} className="field">
        {label}
        <TagInput
          values={Array.isArray(value[key]) ? (value[key] as string[]) : []}
          onChange={(next) => patch(key, next.length ? next : undefined)}
        />
        {help && <small>{help}</small>}
      </label>
    );

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

  if (shape.type === 'object' && shape.properties) {
    const nested = (value[key] ?? {}) as Record<string, unknown>;
    const nestedRequired = new Set(shape.required ?? []);
    return (
      <details key={key} className="ds-nested-fields" open={!hint?.advanced}>
        <summary>{label}</summary>
        <div className="form-grid">
          {Object.entries(shape.properties).map((entry) =>
            renderSchemaField(entry, {
              ...args,
              value: nested,
              patch: (nestedKey, nestedValue) =>
                patch(key, { ...nested, [nestedKey]: nestedValue }),
              prefix: `${prefix}${key}-`,
              requiredKeys: nestedRequired,
            }),
          )}
        </div>
      </details>
    );
  }

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
}
