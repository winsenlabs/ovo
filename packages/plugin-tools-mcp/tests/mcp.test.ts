import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolConnection, ToolDefinition } from '@winsendotai/ovo-contracts';
import { ExecutionPolicyError } from '@winsendotai/ovo-plugin-tools';
import {
  createMcpConnector,
  mcpSchemaDigest,
  toolDefinitionMatchesDiscovery,
} from '../src/index.ts';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, 'close');
    }),
  );
});

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

async function startMcpServer() {
  const seenAuth: Array<string | undefined> = [];
  const calls: unknown[] = [];
  let schemaVersion = 1;
  const http = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    seenAuth.push(request.headers.authorization);
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405).end();
      return;
    }
    const server = new Server(
      { name: 'local-test-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'lookup',
          description: 'Looks up a customer',
          inputSchema: {
            type: 'object' as const,
            properties: {
              account: { type: 'string' },
              ...(schemaVersion === 2 ? { region: { type: 'string' } } : {}),
            },
            required: ['account'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object' as const,
            properties: { found: { type: 'boolean' } },
            required: ['found'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls.push(params.arguments);
      return {
        content: [{ type: 'text' as const, text: 'found' }],
        structuredContent: { found: true },
      };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, await bodyOf(request));
  });
  servers.push(http);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  return {
    endpoint: 'https://mcp.example.test/mcp',
    calls,
    seenAuth,
    changeSchema() {
      schemaVersion = 2;
    },
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const original = new URL(input instanceof Request ? input.url : input.toString());
      return globalThis.fetch(
        `http://127.0.0.1:${address.port}${original.pathname}${original.search}`,
        init,
      );
    }) as typeof globalThis.fetch,
  };
}

describe('remote HTTP MCP connector', () => {
  it('uses the actual MCP protocol while keeping discovery separate from approval', async () => {
    const fake = await startMcpServer();
    const connections: ToolConnection[] = [
      {
        id: 'connection-1',
        workspaceId: 'workspace-1',
        label: 'Test MCP',
        endpoint: fake.endpoint,
        auth: 'bearer',
        credentialId: 'credential-1',
      },
    ];
    const connector = createMcpConnector(connections, {
      secrets: {
        async resolve() {
          return 'server-secret';
        },
      },
      network: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: fake.fetch,
      },
    });

    const discovery = await connector.discover({
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
    });
    expect(discovery.tools).toHaveLength(1);
    expect(JSON.stringify(discovery)).not.toContain('server-secret');
    const remote = discovery.tools[0]!;
    expect(remote).toMatchObject({ remoteName: 'lookup', annotations: { readOnlyHint: true } });
    expect(remote.schemaDigest).toBe(mcpSchemaDigest(remote));

    const definition: ToolDefinition = {
      id: 'customer-lookup',
      description: 'Approved lookup',
      connector: 'mcp',
      connectionId: 'connection-1',
      remoteName: remote.remoteName,
      inputSchema: remote.inputSchema,
      outputSchema: remote.outputSchema,
      schemaDigest: remote.schemaDigest,
      effect: 'read',
      confirmation: false,
      timeoutMs: 1_000,
    };
    expect(toolDefinitionMatchesDiscovery(definition, remote)).toBe(true);
    await expect(
      connector.invoke(
        definition,
        { account: 'A-1' },
        {
          signal: new AbortController().signal,
          operationId: 'operation-1',
          workspaceId: 'workspace-1',
        },
      ),
    ).resolves.toEqual({ found: true });
    expect(fake.calls).toEqual([{ account: 'A-1' }]);
    expect(fake.seenAuth.every((value) => value === 'Bearer server-secret')).toBe(true);
  });

  it('blocks schema drift before invoking a remote tool', async () => {
    const fake = await startMcpServer();
    const connector = createMcpConnector(
      [
        {
          id: 'connection-1',
          workspaceId: 'workspace-1',
          label: 'Test',
          endpoint: fake.endpoint,
          auth: 'none',
        },
      ],
      {
        network: {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          fetch: fake.fetch,
        },
      },
    );
    const remote = (
      await connector.discover({ workspaceId: 'workspace-1', connectionId: 'connection-1' })
    ).tools[0]!;
    fake.changeSchema();
    await expect(
      connector.validateApproval({
        workspaceId: 'workspace-1',
        connectionId: 'connection-1',
        remoteName: remote.remoteName,
        schemaDigest: remote.schemaDigest,
      }),
    ).rejects.toThrow('schema drift');
    expect(fake.calls).toEqual([]);
  });

  it('enforces workspace scope before making a connection', async () => {
    const connector = createMcpConnector([
      {
        id: 'connection-1',
        workspaceId: 'workspace-1',
        label: 'Test',
        endpoint: 'https://mcp.example.test/mcp',
        auth: 'none',
      },
    ]);
    await expect(
      connector.discover({
        workspaceId: 'workspace-2',
        connectionId: 'connection-1',
      }),
    ).rejects.toBeInstanceOf(ExecutionPolicyError);
  });

  it('does not return secret resolver details to management callers', async () => {
    const connector = createMcpConnector(
      [
        {
          id: 'connection-1',
          workspaceId: 'workspace-1',
          label: 'Test',
          endpoint: 'https://mcp.example.test/mcp',
          auth: 'bearer',
          credentialId: 'credential-1',
        },
      ],
      {
        secrets: {
          async resolve() {
            throw new Error('server-secret must not escape');
          },
        },
        network: {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          fetch: async () => {
            throw new Error('fetch should not run');
          },
        },
      },
    );
    const failure = await connector
      .discover({
        workspaceId: 'workspace-1',
        connectionId: 'connection-1',
      })
      .catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected credential failure');
    expect(failure.message).toBe('MCP credential resolution failed');
    expect(failure.message).not.toContain('server-secret');
  });
});
