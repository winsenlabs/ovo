import { createServer, type Server } from 'node:http';
import { bearerMatches } from './control/server.ts';
import type { SipGateway } from './gateway.ts';

/** Numbers only (§18): counters and pool state, never a Call-ID or a phone number. */
export function verboseHealth(gateway: SipGateway): Record<string, unknown> {
  const c = gateway.counters;
  return {
    ready: !gateway.draining,
    draining: gateway.draining,
    dialogs: gateway.registry.size,
    rtp: gateway.pool.stats(),
    transactions: gateway.transactions.counts,
    tcpConnections: gateway.endpoint.tcpConnections,
    invites: c.invites,
    outboundDials: c.outboundDials,
    decisions: { ...c.decisions },
    endings: { ...c.endings },
    drops: { ...c.drops },
    transactionTimeouts: c.transactionTimeouts,
    resume: { attempts: c.resumeAttempts, successes: c.resumeSuccesses },
    jitterUnderruns: c.jitterUnderruns,
    pacerMaxDriftMs: Math.round(c.pacerMaxDriftMs * 10) / 10,
    trunks: gateway.pinger.snapshot(),
  };
}

/**
 * `GET /health` → `{ready}` for the compose healthcheck; `?verbose=1` with
 * `Authorization: Bearer <OVO_HEALTH_TOKEN>` adds the counters. No token configured, no verbose.
 */
export function createHealthServer(gateway: SipGateway): Server {
  const token = gateway.config.health.token;
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://health');
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || url.pathname !== '/health')
      return reply(404, { error: 'not_found' });
    if (url.searchParams.get('verbose') !== '1')
      return reply(200, { ready: !gateway.draining, draining: gateway.draining });
    if (!token || !bearerMatches(req.headers.authorization, token))
      return reply(401, { error: 'unauthorized' });
    reply(200, verboseHealth(gateway));
  });
}
