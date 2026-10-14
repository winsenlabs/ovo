import { describe, expect, it } from 'vitest';
import { approvalFor, connectionHealthCounts, endpointHost, hasDrifted } from './mcp-helpers';
import type { DiscoveredTool, McpConnection, ToolApproval } from '../../lib/api';

const connection = (over: Partial<McpConnection>): McpConnection => ({
  id: 'mcp_1',
  label: 'Connection',
  endpoint: 'https://crm.sunrise.example/mcp',
  auth: 'none',
  ...over,
});

describe('connectionHealthCounts', () => {
  it('counts healthy connections as ok and error ones as needing attention', () => {
    expect(
      connectionHealthCounts([
        connection({ status: 'healthy' }),
        connection({ status: 'ready' }),
        connection({ status: 'error' }),
        connection({ status: undefined }),
      ]),
    ).toEqual({ ok: 2, attention: 1 });
  });
});

describe('endpointHost', () => {
  it('extracts the host from a full endpoint URL', () => {
    expect(endpointHost('https://crm.sunrise.example/mcp')).toBe('crm.sunrise.example');
  });
  it('falls back to the raw value when it cannot be parsed as a URL', () => {
    expect(endpointHost('not-a-url')).toBe('not-a-url');
  });
});

describe('approvalFor / hasDrifted', () => {
  const tool: DiscoveredTool = {
    id: 'lookup_borrower',
    remoteName: 'lookup_borrower',
    schemaDigest: 'sha256:new',
    inputSchema: {},
  };
  it('finds an approval by toolId, falling back to id', () => {
    const approvals: ToolApproval[] = [
      {
        toolId: 'lookup_borrower',
        connectionId: 'mcp_1',
        remoteName: 'lookup_borrower',
        schemaDigest: 'sha256:old',
      },
    ];
    expect(approvalFor(tool, approvals)?.schemaDigest).toBe('sha256:old');
  });
  it('flags drift when the stored digest no longer matches the discovered one', () => {
    const approvals: ToolApproval[] = [
      {
        toolId: 'lookup_borrower',
        connectionId: 'mcp_1',
        remoteName: 'lookup_borrower',
        schemaDigest: 'sha256:old',
      },
    ];
    expect(hasDrifted(tool, approvals)).toBe(true);
  });
  it('is not drifted when nothing is approved yet, or the digest matches', () => {
    expect(hasDrifted(tool, [])).toBe(false);
    expect(
      hasDrifted(tool, [
        {
          toolId: 'lookup_borrower',
          connectionId: 'mcp_1',
          remoteName: 'lookup_borrower',
          schemaDigest: 'sha256:new',
        },
      ]),
    ).toBe(false);
  });
});
