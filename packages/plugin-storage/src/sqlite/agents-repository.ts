import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AgentConfig, type AgentConfig as AgentConfigValue } from '@winsendotai/ovo-contracts';
import {
  DraftConflictError,
  ReferencedResourceError,
  type AgentDraft,
  type Page,
  type ReleaseRecord,
} from '../models.ts';
import { cursorValue, json, now, pageLimit, parseArray, type Row, transaction } from './shared.ts';

export class AgentsRepository {
  constructor(private readonly db: DatabaseSync) {}
  ensureWorkspace(id: string, name = id) {
    this.db
      .prepare(
        'INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(id, name, now());
  }
  private mapAgent(row: Row): AgentDraft {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      config: AgentConfig.parse(JSON.parse(String(row.config_json))),
      draftVersion: Number(row.draft_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  createAgent(workspaceId: string, config: AgentConfigValue, id = randomUUID()) {
    const at = now();
    this.db
      .prepare(
        'INSERT INTO agents(id,workspace_id,config_json,draft_version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, workspaceId, json(config), 1, at, at);
    return this.getAgent(workspaceId, id)!;
  }
  getAgent(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapAgent(row) : undefined;
  }
  listAgents(workspaceId: string, limit = 50, cursor?: string): Page<AgentDraft> {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM agents WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapAgent(row)),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
  updateAgent(workspaceId: string, id: string, expectedVersion: number, config: AgentConfigValue) {
    return transaction(this.db, () => {
      const current = this.getAgent(workspaceId, id);
      if (!current) throw new Error('Agent not found');
      if (current.draftVersion !== expectedVersion) throw new DraftConflictError(current);
      this.db
        .prepare(
          'UPDATE agents SET config_json=?,draft_version=draft_version+1,updated_at=? WHERE workspace_id=? AND id=? AND draft_version=?',
        )
        .run(json(config), now(), workspaceId, id, expectedVersion);
      return this.getAgent(workspaceId, id)!;
    });
  }
  deleteAgent(workspaceId: string, id: string, expectedVersion: number) {
    transaction(this.db, () => {
      const current = this.getAgent(workspaceId, id);
      if (!current) throw new Error('Agent not found');
      if (current.draftVersion !== expectedVersion) throw new DraftConflictError(current);
      const releases = Number(
        (
          this.db
            .prepare('SELECT COUNT(*) AS count FROM releases WHERE workspace_id=? AND agent_id=?')
            .get(workspaceId, id) as Row
        ).count,
      );
      if (releases)
        throw new ReferencedResourceError('Agent has immutable releases.', { releases });
      this.db.prepare('DELETE FROM agents WHERE workspace_id=? AND id=?').run(workspaceId, id);
    });
  }
  private mapRelease(row: Row): ReleaseRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      draftVersion: Number(row.draft_version),
      config: AgentConfig.parse(JSON.parse(String(row.config_json))),
      plugins: parseArray(row.plugins_json),
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    };
  }
  createRelease(input: {
    workspaceId: string;
    agent: AgentDraft;
    plugins: { id: string; version: string }[];
    createdBy: string;
    id?: string;
  }) {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        'INSERT INTO releases(id,workspace_id,agent_id,draft_version,config_json,plugins_json,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.workspaceId,
        input.agent.id,
        input.agent.draftVersion,
        json(input.agent.config),
        json(input.plugins),
        now(),
        input.createdBy,
      );
    return this.getRelease(input.workspaceId, id)!;
  }
  getRelease(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM releases WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapRelease(row) : undefined;
  }
  listReleases(workspaceId: string, agentId: string) {
    return (
      this.db
        .prepare(
          'SELECT * FROM releases WHERE workspace_id=? AND agent_id=? ORDER BY created_at DESC',
        )
        .all(workspaceId, agentId) as Row[]
    ).map((row) => this.mapRelease(row));
  }
}
