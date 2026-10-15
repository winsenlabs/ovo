import type { AgentConfig } from './agent.ts';

type Declared = { type?: unknown; enum?: unknown };

const JSON_TYPES: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
};

/** True when `value` has a JSON type the property declares (no or unknown type: any value). */
function matchesType(type: unknown, value: unknown): boolean {
  if (type === undefined) return true;
  const types: unknown[] = Array.isArray(type) ? type : [type];
  return types.some((one) => typeof one !== 'string' || (JSON_TYPES[one]?.(value) ?? true));
}

/**
 * The variables a release's schema accepts. With `additionalProperties: false` only declared names
 * whose value matches the declared JSON type (string, number, integer, boolean; `enum` respected)
 * pass; otherwise every variable does. Pure and Ajv-free: used where a call's variables reach a
 * release other than the one they were checked against (routed segments, transfer handovers,
 * routed and overflow callbacks).
 */
export function filterDeclaredVariables(
  config: Pick<AgentConfig, 'variables'>,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const schema = config.variables as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  if (schema.additionalProperties !== false) return { ...variables };
  const properties = schema.properties ?? {};
  return Object.fromEntries(
    Object.entries(variables).filter(([name, value]) => {
      if (!Object.hasOwn(properties, name)) return false;
      const declared = properties[name];
      if (typeof declared !== 'object' || declared === null) return true;
      const { type, enum: allowed } = declared as Declared;
      if (Array.isArray(allowed) && !allowed.includes(value)) return false;
      return matchesType(type, value);
    }),
  );
}
