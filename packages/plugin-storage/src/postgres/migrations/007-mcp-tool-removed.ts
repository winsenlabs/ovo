export const mcpToolRemovedV7 = `
ALTER TABLE ovo_ctl_mcp_discovered_tools ADD COLUMN removed_at TIMESTAMPTZ NULL;
`;
