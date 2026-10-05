import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import { attachWorkerMediaServer } from '../src/worker-upgrade.ts';

const httpServer = createServer();
let opened = 0;
const events: unknown[] = [];
const detach = attachWorkerMediaServer({
  httpServer,
  token: 'fixture-token',
  logger: createLogger({}, { sink: (line) => events.push(JSON.parse(line).event) }),
  async onOpen() {
    opened += 1;
  },
});
httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const address = httpServer.address();
if (!address || typeof address === 'string') throw new Error('no fixture port');
const peer = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
  headers: { authorization: 'Bearer fixture-token' },
});
await once(peer, 'open');
const closed = once(peer, 'close');
peer.send(Buffer.alloc(1_048_577));
const [code] = await closed;
await detach();
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
console.log(JSON.stringify({ opened, code, events }));
