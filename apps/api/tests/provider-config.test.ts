import { expect, it } from 'vitest';
import { ProviderBindingBody, McpBody } from '../src/schemas.ts';
import { ToolDefinition } from '@winsendotai/ovo-contracts';

const binding = {
  label: 'Model',
  provider: 'openai',
  environment: 'test',
  credentialId: '44444444-4444-4444-8444-444444444444',
};

it('rejects inline credentials in readable provider metadata without echoing their values', () => {
  for (const config of [
    { apiKey: 'fixture-secret' },
    { headers: { Authorization: 'Bearer fixture-secret' } },
    { endpoint: 'https://user:fixture-secret@example.com' },
  ]) {
    const result = ProviderBindingBody.safeParse({ ...binding, config });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  }
  expect(
    ProviderBindingBody.safeParse({
      ...binding,
      config: { model: 'gpt-fixture', maxOutputTokens: 300 },
    }).success,
  ).toBe(true);
});

it('rejects credentials embedded in MCP endpoint URLs', () => {
  expect(
    McpBody.safeParse({
      label: 'MCP',
      endpoint: 'https://user:password@example.com/mcp',
      auth: 'none',
    }).success,
  ).toBe(false);
});

it('rejects credential-bearing HTTP tool URLs before drafts can persist them', () => {
  const tool = {
    id: 'http',
    description: 'HTTP fixture',
    connector: 'http',
    effect: 'read',
    inputSchema: {},
    outputSchema: {},
  };
  expect(
    ToolDefinition.safeParse({ ...tool, http: { endpoint: 'https://example.com' } }).success,
  ).toBe(true);
  for (const endpoint of ['https://user:secret@example.com', 'not a URL']) {
    expect(
      ToolDefinition.safeParse({
        ...tool,
        http: { endpoint },
      }).success,
    ).toBe(false);
  }
});
