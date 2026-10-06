import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { canonicalJson } from '@winsendotai/ovo-contracts';

export interface VariableValidationResult {
  valid: boolean;
  errors: string[];
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath || '/';
  return `${path} ${error.message ?? 'is invalid'}`;
}

const COMPILED_LIMIT = 64;
const compiled = new Map<string, ValidateFunction>();

/**
 * A release schema compiles once and is reused: campaign admission checks every contact against
 * the same few schemas. The cache is bounded; the oldest schema is dropped first.
 */
function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = canonicalJson(schema);
  const cached = compiled.get(key);
  if (cached) return cached;
  const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(
    schema,
  );
  if (compiled.size >= COMPILED_LIMIT) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, validate);
  return validate;
}

/** Validate call variables against the immutable release schema without logging values. */
export function validateReleaseVariables(
  schema: Record<string, unknown>,
  variables: Record<string, string>,
): VariableValidationResult {
  try {
    const validate = compile(schema);
    const valid = validate(variables);
    return {
      valid: Boolean(valid),
      errors: valid ? [] : (validate.errors ?? []).slice(0, 20).map(formatError),
    };
  } catch {
    return { valid: false, errors: ['Release variable schema is invalid'] };
  }
}
