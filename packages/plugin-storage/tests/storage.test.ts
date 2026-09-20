import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { DraftConflictError, NodeSqliteControlStore } from '../src/index.ts';

const config = AgentConfig.parse({
  name: 'Reminder',
  mode: 'announcement',
  message: 'Hello {{name}}',
  variables: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
});

describe('NodeSqliteControlStore', () => {
  it('persists drafts and immutable releases across a reopened database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovo-storage-')),
      filename = join(directory, 'control.sqlite');
    try {
      let store = new NodeSqliteControlStore(filename);
      store.ensureWorkspace('workspace-a');
      const draft = store.createAgent('workspace-a', config);
      const updated = store.updateAgent('workspace-a', draft.id, 1, {
        ...config,
        name: 'Updated reminder',
      });
      expect(() => store.updateAgent('workspace-a', draft.id, 1, config)).toThrow(
        DraftConflictError,
      );
      const release = store.createRelease({
        workspaceId: 'workspace-a',
        agent: updated,
        plugins: [{ id: '@winsendotai/ovo-behavior-announcement', version: '0.1.0' }],
        createdBy: 'admin',
      });
      store.close();
      store = new NodeSqliteControlStore(filename);
      expect(store.getAgent('workspace-a', draft.id)?.draftVersion).toBe(2);
      expect(store.getRelease('workspace-a', release.id)?.config.name).toBe('Updated reminder');
      store.updateAgent('workspace-a', draft.id, 2, { ...config, name: 'Third draft' });
      expect(store.getRelease('workspace-a', release.id)?.config.name).toBe('Updated reminder');
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps workspace identifiers in every resource lookup', () => {
    const store = new NodeSqliteControlStore(':memory:');
    store.ensureWorkspace('a');
    store.ensureWorkspace('b');
    const agent = store.createAgent('a', config);
    expect(store.getAgent('b', agent.id)).toBeUndefined();
    store.close();
  });
});
