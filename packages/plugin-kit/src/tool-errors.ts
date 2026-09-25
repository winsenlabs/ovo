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

/**
 * Policy refused the operation. Nothing was sent, so the outcome is known.
 *
 * Every class below sets `this.name`, so a serialized error, a log line or a `cause` chain still
 * says which policy refused the call once the prototype is gone.
 */
export class ExecutionPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionPolicyError';
  }
}

export class ConfirmationRequiredError extends ExecutionPolicyError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfirmationRequiredError';
  }
}

export class OperationCollisionError extends ExecutionPolicyError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OperationCollisionError';
  }
}

/**
 * A connector refused before dispatch (#12): a private DNS result, a blocked address, a missing
 * credential binding, a disallowed method or endpoint. Execution records it as `failed`, never
 * `unknown`, because no request left the process.
 */
export class ConnectorPolicyError extends ExecutionPolicyError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectorPolicyError';
  }
}

export class ToolSchemaError extends ExecutionPolicyError {
  constructor(
    message: string,
    readonly errors: readonly ToolSchemaIssue[] = [],
  ) {
    super(message);
    this.name = 'ToolSchemaError';
  }
}

export class ToolInvocationError extends Error {
  constructor(
    message: string,
    readonly outcome: 'not-applied' | 'unknown',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolInvocationError';
  }
}
