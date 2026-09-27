export const fixtureSnapshotsV6 = `
ALTER TABLE ovo_ctl_releases ADD COLUMN purpose TEXT NOT NULL DEFAULT 'published'
  CHECK (purpose IN ('published','fixture-snapshot'));
ALTER TABLE ovo_ctl_releases DROP CONSTRAINT ovo_ctl_releases_workspace_id_agent_id_draft_version_key;
CREATE UNIQUE INDEX ovo_ctl_releases_published_draft_idx
  ON ovo_ctl_releases(workspace_id,agent_id,draft_version) WHERE purpose='published';
`;
