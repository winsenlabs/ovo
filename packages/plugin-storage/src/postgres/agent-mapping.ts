import { AgentConfig } from '@winsendotai/ovo-contracts';
import type { AgentDraft } from '../models.ts';
import { toIso, type Row } from './shared.ts';

export function mapAgent(row: Row): AgentDraft {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    config: AgentConfig.parse(row.config),
    draftVersion: Number(row.draft_version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
