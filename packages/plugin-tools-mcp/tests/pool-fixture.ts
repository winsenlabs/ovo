import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Stateful loopback MCP protocol fixture, including real list_changed notifications. */
export async function poolFixture() {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  const counts = { initialize: 0, list: 0, call: 0, deleted: 0 };
  let changed = false;
  let callGate: Promise<void> | undefined;
  const auth: Array<string | undefined> = [];
  const http = createServer(async (req, res) => {
    auth.push(req.headers.authorization);
    const id = req.headers['mcp-session-id'] as string | undefined;
    let session = id ? sessions.get(id) : undefined;
    if (!session && req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    if (req.method === 'POST') for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (!session) {
      counts.initialize += 1;
      const server = new Server(
        { name: 'pool-fixture', version: '1' },
        { capabilities: { tools: { listChanged: true } } },
      );
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId): void => {
          sessions.set(sessionId, { server, transport });
        },
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        counts.list += 1;
        return {
          tools: [
            {
              name: 'lookup',
              inputSchema: {
                type: 'object',
                properties: { ...(changed ? { region: { type: 'string' } } : {}) },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        counts.call += 1;
        await callGate;
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
      });
      await server.connect(transport);
      session = { server, transport };
    }
    if (req.method === 'DELETE') counts.deleted += 1;
    await session.transport.handleRequest(req, res, body);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback socket');
  return {
    counts,
    auth,
    endpoint: 'https://mcp.example.test/mcp',
    network: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      fetch: ((input, init) =>
        globalThis.fetch(`http://127.0.0.1:${address.port}/mcp`, init)) as typeof globalThis.fetch,
    },
    holdCalls() {
      let release!: () => void;
      callGate = new Promise<void>((resolve) => {
        release = () => {
          callGate = undefined;
          resolve();
        };
      });
      return release;
    },
    async change(notify = true) {
      changed = true;
      if (notify)
        await Promise.all([...sessions.values()].map(({ server }) => server.sendToolListChanged()));
    },
    async close() {
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      http.close();
      http.closeAllConnections();
      await once(http, 'close');
    },
  };
}
