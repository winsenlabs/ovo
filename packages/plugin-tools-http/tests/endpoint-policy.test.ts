import { it, expect } from 'vitest';
import { parseApprovedEndpoint } from '../src/network.ts';
it('shares one strict endpoint policy with MCP configuration', () => {
  for (const endpoint of [
    'http://localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://169.254.169.254/mcp',
    'https://user:password@example.com/mcp',
    'https://example.com/mcp#fragment',
    'https://example.com/mcp?token=credential',
  ])
    expect(() => parseApprovedEndpoint(endpoint, { allowQuery: false })).toThrow();
  expect(parseApprovedEndpoint('https://example.com/mcp', { allowQuery: false }).hostname).toBe(
    'example.com',
  );
  expect(parseApprovedEndpoint('https://example.com/tool?query=allowed').search).toBe(
    '?query=allowed',
  );
});
