import { describe, expect, it } from 'vitest';
import * as kit from '@winsendotai/ovo-plugin-kit';
import {
  ConfirmationRequiredError,
  ConnectorPolicyError,
  ExecutionPolicyError,
  OperationCollisionError,
  ToolInvocationError,
  ToolSchemaError,
} from '../src/index.ts';

/**
 * The tool error classes moved to plugin-kit (#12) and plugin-tools re-exports them. An `instanceof`
 * check in execution, in a connector and in the runtime must all mean the same class, so the two
 * surfaces have to be the same objects, not two copies with the same names. The assertion lives
 * here, in the package that does the re-export: a kit may not import a plugin, even from a test.
 */
describe('plugin-tools re-exports the kit error classes identically', () => {
  it.each([
    ['ExecutionPolicyError', ExecutionPolicyError],
    ['ConfirmationRequiredError', ConfirmationRequiredError],
    ['OperationCollisionError', OperationCollisionError],
    ['ConnectorPolicyError', ConnectorPolicyError],
    ['ToolSchemaError', ToolSchemaError],
    ['ToolInvocationError', ToolInvocationError],
  ] as const)('%s is the kit class itself', (name, exported) => {
    expect(exported).toBe((kit as unknown as Record<string, unknown>)[name]);
  });

  it('keeps ConnectorPolicyError under ExecutionPolicyError across the two surfaces', () => {
    expect(new ConnectorPolicyError('private DNS')).toBeInstanceOf(kit.ExecutionPolicyError);
    expect(new kit.ConnectorPolicyError('private DNS')).toBeInstanceOf(ExecutionPolicyError);
  });
});
