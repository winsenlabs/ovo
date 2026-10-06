// In-process fakes for the ops script tests: the console API, dispatcher, workers and gateway of a
// running stack on one HTTP server, and Twilio's IncomingPhoneNumbers resource on another. Scripts
// under test reach them through OVO_OPS_ENDPOINTS, OVO_OPS_PUBLIC_PROBE_BASE and
// OVO_OPS_TWILIO_API_BASE; nothing leaves 127.0.0.1.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NUMBER = '+12025550123';
export const FALLBACK = 'https://handler.twilio.example/bin/fallback';
export const INBOUND = 'https://voice.ovo.test/carriers/twilio/bind-1/inbound?t=secret-inbound';
export const STATUS = 'https://voice.ovo.test/carriers/twilio/bind-1/status?t=secret-status';
export const ADMIN = { email: 'admin@ovo.test', password: 'admin-password-123' };

export interface StackState {
  workers: Record<string, string>;
  inbound: { ready: boolean; readyProtected: number; reasons: string[] };
  routes: Array<Record<string, unknown>>;
  liveReady: boolean;
  gatewayReady: boolean;
  upgradeStatus: number;
}

export function healthyStack(): StackState {
  return {
    workers: { 'worker-1': 'ready', 'worker-2': 'active' },
    inbound: { ready: true, readyProtected: 2, reasons: [] },
    routes: [
      { phoneNumber: NUMBER, releaseId: 'rel-1', enabled: true, carrierBindingId: 'bind-1' },
    ],
    liveReady: true,
    gatewayReady: true,
    upgradeStatus: 403,
  };
}

function send(response: ServerResponse, status: number, body: unknown, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startStack(state: StackState) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://stack');
    const path = url.pathname;
    const signedIn = request.headers.cookie === 'ovo_session=s1';
    if (path === '/api/v1/auth/session' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      if (body.email !== ADMIN.email || body.password !== ADMIN.password)
        return send(response, 401, {});
      return send(response, 201, {}, { 'set-cookie': 'ovo_session=s1; Path=/; HttpOnly; Secure' });
    }
    if (path === '/dispatcher/health') return send(response, 200, { inbound: state.inbound });
    if (path.startsWith('/workers/'))
      return send(response, 200, { state: state.workers[path.split('/')[2]!] });
    if (path === '/ovo-gateway-health')
      return send(response, 200, { ready: state.gatewayReady, sessions: 0 });
    if (!path.startsWith('/api/v1/')) return send(response, 404, {});
    if (!signedIn) return send(response, 401, {});
    const api = path.slice('/api'.length);
    if (api === '/v1/operations/inbound/capacity')
      return send(response, 200, { readyProtected: state.inbound.readyProtected });
    if (api === '/v1/operations/inbound/routes')
      return send(response, 200, { items: state.routes, nextCursor: null });
    if (api.startsWith('/v1/releases/'))
      return send(response, 200, { id: api.split('/')[3], agentId: 'agent-1' });
    if (api === '/v1/agents/agent-1/readiness')
      return send(response, 200, {
        liveReady: state.liveReady,
        liveBlockers: state.liveReady ? [] : ['No TTS binding'],
      });
    if (api === '/v1/provider-bindings/bind-1/carrier-urls')
      return send(response, 200, {
        items: [
          { purpose: 'inbound', url: INBOUND },
          { purpose: 'status', url: STATUS },
        ],
      });
    return send(response, 404, {});
  });
  // The gateway's authenticated upgrade handler refuses an unsigned carrier socket with 403.
  server.on('upgrade', (_request, socket) => {
    socket.end(`HTTP/1.1 ${state.upgradeStatus} Rejected\r\nConnection: close\r\n\r\n`);
  });
  const base = await listen(server);
  return {
    base,
    endpoints: {
      console: base,
      dispatcher: `${base}/dispatcher/health`,
      workers: { 'worker-1': `${base}/workers/worker-1`, 'worker-2': `${base}/workers/worker-2` },
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export interface TwilioNumberState {
  voice_url: string | null;
  voice_method: string;
  voice_fallback_url: string | null;
  voice_fallback_method: string;
  status_callback: string | null;
  status_callback_method: string;
}

export async function startTwilio(number: TwilioNumberState) {
  const posts: Array<Record<string, string>> = [];
  const authorizations: string[] = [];
  const row = () => ({ sid: 'PN1', phone_number: NUMBER, ...number });
  const server = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization ?? '');
    const url = new URL(request.url ?? '/', 'http://twilio');
    if (
      request.headers.authorization !== `Basic ${Buffer.from('SK1:key-secret').toString('base64')}`
    )
      return send(response, 401, {});
    if (url.pathname === '/2010-04-01/Accounts/AC1/IncomingPhoneNumbers.json')
      return send(response, 200, {
        incoming_phone_numbers: url.searchParams.get('PhoneNumber') === NUMBER ? [row()] : [],
      });
    if (
      url.pathname === '/2010-04-01/Accounts/AC1/IncomingPhoneNumbers/PN1.json' &&
      request.method === 'POST'
    ) {
      const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
      posts.push(form);
      const names: Record<string, keyof TwilioNumberState> = {
        VoiceUrl: 'voice_url',
        VoiceMethod: 'voice_method',
        VoiceFallbackUrl: 'voice_fallback_url',
        VoiceFallbackMethod: 'voice_fallback_method',
        StatusCallback: 'status_callback',
        StatusCallbackMethod: 'status_callback_method',
      };
      for (const [field, value] of Object.entries(form))
        (number as unknown as Record<string, string>)[names[field]!] = value;
      return send(response, 200, row());
    }
    return send(response, 404, {});
  });
  const base = await listen(server);
  return {
    base,
    number,
    posts,
    authorizations,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const ROOT = new URL('../../../', import.meta.url).pathname;

/** A scratch directory with the fake docker first on PATH, a docker log and a state file. */
export function sandbox(dockerState: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-ops-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'scripts/ops/tests/fake-docker.mjs')}" "$@"\n`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const state = join(dir, 'docker-state.json');
  writeFileSync(state, JSON.stringify(dockerState));
  const log = join(dir, 'docker.log');
  writeFileSync(log, '');
  return {
    dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: state,
      FAKE_DOCKER_LOG: log,
      OVO_OPS_POLL_SECONDS: '0',
    },
    dockerLog: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
  cwd = ROOT,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      { cwd, env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
