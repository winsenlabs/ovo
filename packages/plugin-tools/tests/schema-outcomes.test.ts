import { expect, it } from 'vitest';
import type { OperationRecord, ToolDefinition } from '@winsendotai/ovo-contracts';
import { createExecutionService, ToolSchemaError } from '../src/index.ts';

it.each(['before dispatch', 'after result'])(
  'keeps a write schema refusal %s distinct from result validation',
  async (phase) => {
    let record: OperationRecord | undefined;
    const tool: ToolDefinition = {
      id: 'write',
      connector: 'mcp',
      description: '',
      connectionId: 'c',
      remoteName: 'r',
      schemaDigest: 'd',
      effect: 'write',
      confirmation: true,
      timeoutMs: 1_000,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      processing: { initial: 'Working.', failure: 'Failed.', maxProgress: 0, progressAfterMs: 500 },
    };
    const service = createExecutionService(
      { tools: [tool], allowedTools: ['write'] },
      {
        store: {
          async get() {
            return record;
          },
          async createIntent(value) {
            record = value;
            return true;
          },
          async settle(value) {
            record = value;
          },
        },
        speech: {
          async speak(text) {
            return { id: 'r', text, epoch: 0, state: 'completed', evidence: 'simulated' };
          },
          async interrupt() {},
        },
        connectors: {
          mcp: {
            async invoke() {
              if (phase === 'before dispatch')
                throw new ToolSchemaError('MCP schema drift detected');
              return 123;
            },
          },
        },
      },
    );
    const result = await service.execute({
      id: 'op',
      workspaceId: 'w',
      sessionId: 's',
      toolId: 'write',
      input: {},
      confirmed: true,
    });
    expect(result.state).toBe(phase === 'before dispatch' ? 'failed' : 'unknown');
  },
);
