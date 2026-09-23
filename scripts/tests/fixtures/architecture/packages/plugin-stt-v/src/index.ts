// Known violation: vendor plugins reach the network only through ctx.net, never ws.
import WebSocket from 'ws';

export const Socket = WebSocket;
