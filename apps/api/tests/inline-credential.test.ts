import { describe, expect, it } from 'vitest';
import { findInlineCredential, hasInlineCredential } from '../src/provider-config.ts';

describe('inline credential detection', () => {
  it.each([
    // LAT-7 needs output caps; the old substring check rejected all of these.
    { maxOutputTokens: 256 },
    { maxTokens: 512, tokenizer: 'cl100k' },
    { keyterms: ['OVO', 'Winsen'], tokenBudget: 3 },
    { accountSid: 'AC0123456789', model: 'nova-3', endpointing: 300 },
    { passwordPolicy: 'none', secretary: 'desk' },
    { voice: 'alloy', baseUrl: 'https://api.example.com/v1' },
  ])('accepts ordinary provider settings %j', (config) => {
    expect(findInlineCredential(config)).toBeUndefined();
  });

  it.each([
    [{ apiKey: 'x' }, 'apiKey'],
    [{ api_key: 'x' }, 'api_key'],
    [{ 'x-api-key': 'x' }, 'x-api-key'],
    [{ APIKey: 'x' }, 'APIKey'],
    [{ authToken: 'x' }, 'authToken'],
    [{ token: 'x' }, 'token'],
    [{ clientSecret: 'x' }, 'clientSecret'],
    [{ secretAccessKey: 'x' }, 'secretAccessKey'],
    [{ credentials: { user: 'a' } }, 'credentials'],
    [{ headers: { Authorization: 'x' } }, 'headers.Authorization'],
    [{ tools: [{ password: 'x' }] }, 'tools.0.password'],
  ])('rejects the credential-named field in %j', (config, path) => {
    expect(findInlineCredential(config)).toBe(path);
  });

  it.each([
    [{ note: 'sk-proj-abcdefghijklmnop1234' }, 'note'],
    [{ headers: { 'X-Upstream': 'Bearer abcdefgh12345678' } }, 'headers.X-Upstream'],
    [
      {
        session:
          'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      },
      'session',
    ],
    [{ endpoints: ['https://user:pass@example.com/hook'] }, 'endpoints.0'],
  ])('rejects a credential-shaped value in %j', (config, path) => {
    expect(findInlineCredential(config)).toBe(path);
  });

  it('keeps URL user-info detection for MCP endpoints', () => {
    expect(hasInlineCredential('https://user:secret@mcp.example.com')).toBe(true);
    expect(hasInlineCredential('https://mcp.example.com/sse')).toBe(false);
  });
});
