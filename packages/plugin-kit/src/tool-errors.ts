/**
 * Tool execution errors shared by execution and every tool connector. Moved from
 * `plugin-tools/src/errors.ts`, which re-exports them, so connectors need no plugin→plugin import.
 */

/** A structural subset of an Ajv `ErrorObject`; Ajv errors are assignable to it. */
export interface ToolSchemaIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

/** Policy refused the operation. Nothing was sent, so the outcome is known. */
export class ExecutionPolicyError extends Error {}
export class ConfirmationRequiredError extends ExecutionPolicyError {}
export class OperationCollisionError extends ExecutionPolicyError {}

/**
 * A connector refused before dispatch (#12): a private DNS result, a blocked address, a missing
 * credential binding, a disallowed method or endpoint. Execution records it as `failed`, never
 * `unknown`, because no request left the process.
 */
export class ConnectorPolicyError extends ExecutionPolicyError {}

export class ToolSchemaError extends ExecutionPolicyError {
  constructor(
    message: string,
    readonly errors: readonly ToolSchemaIssue[] = [],
  ) {
    super(message);
  }
}

export class ToolInvocationError extends Error {
  constructor(
    message: string,
    readonly outcome: 'not-applied' | 'unknown',
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
