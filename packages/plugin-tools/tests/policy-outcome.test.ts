import { describe, expect, it } from 'vitest';
import type {
  OperationRecord,
  OperationStore,
  Speech,
  SpeechReceipt,
  ToolConnector,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
import {
  ConnectorPolicyError,
  ExecutionPolicyError,
  createExecutionService,
} from '../src/index.ts';

class Store implements OperationStore {
  readonly records = new Map<string, OperationRecord>();
  readonly states: OperationRecord['state'][] = [];

  async createIntent(record: OperationRecord): Promise<boolean> {
    this.states.push(record.state);
    this.records.set(record.id, structuredClone(record));
    return true;
  }

  async get(_workspaceId: string, id: string): Promise<OperationRecord | undefined> {
    const record = this.records.get(id);
    return record && structuredClone(record);
  }

  async settle(record: OperationRecord): Promise<void> {
    this.states.push(record.state);
    this.records.set(record.id, structuredClone(record));
  }
}

const silence: Speech = {
  async speak(text): Promise<SpeechReceipt> {
    return { id: 's', text, epoch: 0, state: 'completed', evidence: 'confirmed' };
  },
  async interrupt() {},
};

const writeTool: ToolDefinition = {
  id: 'write',
  description: 'Writes a record',
  connector: 'native',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
  effect: 'write',
  confirmation: false,
  timeoutMs: 100,
  processing: {
    initial: 'Writing now.',
    progressAfterMs: 50,
    maxProgress: 0,
    failure: 'The write failed.',
  },
};

const request = {
  id: 'op-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  toolId: 'write',
  input: {},
  confirmed: true,
};

function run(connector: ToolConnector) {
  const store = new Store();
  const service = createExecutionService(
    { tools: [writeTool], allowedTools: ['write'] },
    { store, speech: silence, connectors: { native: connector } },
  );
  return { store, execute: () => service.execute(request) };
}

/**
 * Defect #12: a connector that refuses before dispatch knows the side effect never started, so the
 * operation is `failed`. Mapping it to `unknown` would trip the reconciliation latch on a write
 * that provably never left the process, and would bury the reason under "Tool connector failed".
 */
describe('a policy refusal is a known outcome (#12)', () => {
  it.each([
    ['ConnectorPolicyError', new ConnectorPolicyError('Host DNS contains a private address')],
    ['ExecutionPolicyError', new ExecutionPolicyError('Tool endpoints must use HTTPS')],
  ] as const)('settles a write refused by %s as failed, with its own message', async (_name, e) => {
    const { store, execute } = run({
      invoke() {
        throw e;
      },
    });
    await expect(execute()).resolves.toMatchObject({ state: 'failed', error: e.message });
    expect(store.states).toEqual(['intent', 'running', 'failed']);
  });

  it('still calls an unexplained connector failure on a write unknown', async () => {
    const { execute } = run({
      invoke() {
        throw new Error('socket hang up');
      },
    });
    await expect(execute()).resolves.toMatchObject({
      state: 'unknown',
      error: 'Tool connector failed',
    });
  });

  it('keeps an invalid result on a write unknown, because the connector already ran', async () => {
    const { execute } = run({ invoke: async () => ({ ok: 'yes' }) });
    await expect(execute()).resolves.toMatchObject({ state: 'unknown' });
  });
});
