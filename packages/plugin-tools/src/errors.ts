import type { ErrorObject } from 'ajv';

export class ExecutionPolicyError extends Error {}
export class ConfirmationRequiredError extends ExecutionPolicyError {}
export class OperationCollisionError extends ExecutionPolicyError {}

export class ToolSchemaError extends ExecutionPolicyError {
  constructor(
    message: string,
    readonly errors: readonly ErrorObject[] = [],
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
