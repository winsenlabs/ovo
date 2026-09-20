import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@winsendotai/ovo-contracts';
import { ExecutionPolicyError, ToolInvocationError } from '@winsendotai/ovo-plugin-tools';
import { createHttpConnector, createPinnedFetch, isPublicAddress } from '../src/index.ts';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('HTTP connector network policy', () => {
  it('rejects private, metadata, loopback, and special-use destinations', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '::1',
      'fd00:ec2::254',
      '::ffff:a9fe:a9fe',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    await expect(createPinnedFetch('https://127.0.0.1/tool')).rejects.toThrow(ExecutionPolicyError);
    await expect(createPinnedFetch('https://[::1]/tool')).rejects.toThrow(ExecutionPolicyError);
    await expect(
      createPinnedFetch('https://tools.example.test/run', {
        lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      }),
    ).rejects.toThrow('private or special-use');
  });

  it('rejects redirects instead of following them', async () => {
    const policy = await createPinnedFetch('https://tools.example.test/run', {
      lookup: publicLookup,
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
    });
    await expect(policy.fetch('https://tools.example.test/run')).rejects.toBeInstanceOf(
      ToolInvocationError,
    );
    await policy.dispose();
  });

  it('allows only the approved path and origin', async () => {
    const policy = await createPinnedFetch('https://tools.example.test/run', {
      lookup: publicLookup,
      fetch: async () => new Response('{}', { status: 200 }),
    });
    await expect(policy.fetch('https://tools.example.test/admin')).rejects.toThrow(
      'operator-approved',
    );
    await expect(policy.fetch('https://other.example.test/run')).rejects.toThrow(
      'operator-approved',
    );
    await policy.dispose();
  });
});

describe('HTTP connector mapping', () => {
  it('resolves authentication server-side and maps only approved fields', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const connector = createHttpConnector(
      [
        {
          toolId: 'update-account',
          workspaceId: 'workspace-1',
          endpoint: 'https://tools.example.test/v1/account',
          method: 'POST',
          query: { account_id: '/account' },
          auth: { type: 'bearer', credentialId: 'credential-1' },
          idempotencyHeader: 'Idempotency-Key',
          response: { type: 'json', pointer: '/updated' },
        },
      ],
      {
        lookup: publicLookup,
        secrets: {
          async resolve() {
            return 'server-only-token';
          },
        },
        fetch: async (input, init) => {
          captured = { url: input.toString(), init };
          return new Response(JSON.stringify({ updated: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    const definition: ToolDefinition = {
      id: 'update-account',
      description: 'Updates one account',
      connector: 'http',
      inputSchema: { type: 'object' },
      effect: 'write',
      confirmation: true,
      timeoutMs: 1_000,
    };
    await expect(
      connector.invoke(
        definition,
        { account: 'A&B', enabled: true },
        {
          signal: new AbortController().signal,
          operationId: 'operation-1',
          workspaceId: 'workspace-1',
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(captured?.url).toBe('https://tools.example.test/v1/account?account_id=A%26B');
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer server-only-token');
    expect(headers.get('idempotency-key')).toBe('operation-1');
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ account: 'A&B', enabled: true });
  });

  it('enforces workspace ownership before secret or network access', async () => {
    let touched = false;
    const connector = createHttpConnector(
      [
        {
          toolId: 'lookup',
          workspaceId: 'workspace-1',
          endpoint: 'https://tools.example.test/lookup',
          method: 'GET',
        },
      ],
      {
        lookup: async () => {
          touched = true;
          return publicLookup();
        },
        fetch: async () => {
          touched = true;
          return new Response('{}');
        },
      },
    );
    await expect(
      connector.invoke(
        {
          id: 'lookup',
          description: '',
          connector: 'http',
          inputSchema: {},
          effect: 'read',
          confirmation: false,
          timeoutMs: 100,
        },
        {},
        {
          signal: new AbortController().signal,
          operationId: 'operation-1',
          workspaceId: 'workspace-2',
        },
      ),
    ).rejects.toThrow('another workspace');
    expect(touched).toBe(false);
  });
});
