export const releaseMcpToolsV3 = `
ALTER TABLE ovo_ctl_releases
  ADD COLUMN mcp_tools JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(mcp_tools) = 'object');
`;
