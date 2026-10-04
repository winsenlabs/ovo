import Ajv, { type ErrorObject } from 'ajv';

export interface VariableValidationResult {
  valid: boolean;
  errors: string[];
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath || '/';
  return `${path} ${error.message ?? 'is invalid'}`;
}

/** Validate call variables against the immutable release schema without logging values. */
export function validateReleaseVariables(
  schema: Record<string, unknown>,
  variables: Record<string, string>,
): VariableValidationResult {
  try {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    const valid = validate(variables);
    return {
      valid: Boolean(valid),
      errors: valid ? [] : (validate.errors ?? []).slice(0, 20).map(formatError),
    };
  } catch {
    return { valid: false, errors: ['Release variable schema is invalid'] };
  }
}
