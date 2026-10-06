// scripts/verify-compose.sh's console sign-in after OPS-15, against a stand-in docker that runs each
// heredoc with the host node and an in-process console: the bootstrap seed password only reaches
// the password change, so the check signs in as the OVO_OPS_ADMIN_* account when one is configured.
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/verify-compose.sh', import.meta.url));
const SEED = { email: 'seed@ovo.test', password: 'bootstrap-seed-pass' };
const OPS = { email: 'ops@ovo.test', password: 'a-long-ops-passphrase-2026' };

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** The console API as OPS-15 answers it; `seedChanged` once the seed password was replaced. */
async function console_(options: { seedChanged?: boolean; opsMustChange?: boolean } = {}) {
  const server: Server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const send = (status: number, payload: unknown, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(payload));
    };
    const url = request.url ?? '/';
    if (url === '/health')
      return send(200, {
        inbound: {
          ready: true,
          admissionEnabled: false,
          readyWorkers: 1,
          readyProtected: 0,
          warmFloor: 2,
          reasons: [],
        },
      });
    if (url === '/') return send(200, {});
    if (url === '/api/v1/auth/session') {
      const { email, password } = JSON.parse(body);
      const seed = email === SEED.email && password === SEED.password && !options.seedChanged;
      const ops = email === OPS.email && password === OPS.password;
      if (!seed && !ops) return send(401, {});
      const restricted = seed || options.opsMustChange === true;
      return send(201, restricted ? { passwordChangeRequired: true } : {}, {
        'set-cookie': `ovo_session=${restricted ? 'restricted' : 'full'}; Path=/; HttpOnly`,
      });
    }
    const restricted = request.headers.cookie === 'ovo_session=restricted';
    if (url === '/api/v1/auth/me') return send(200, {});
    if (url === '/api/v1/users')
      return restricted
        ? send(403, { code: 'password_change_required' })
        : send(200, {
            items: [
              { email: SEED.email, role: 'admin' },
              { email: OPS.email, role: 'admin' },
            ],
          });
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function verify(base: string, opsFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-verify-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // Every in-container URL (API, console, dispatcher) is answered by the fake console.
  writeFileSync(
    join(dir, 'preload.mjs'),
    `const real = globalThis.fetch;
globalThis.fetch = (url, init) =>
  real(String(url).replace(/^http:\\/\\/(console:3000|127\\.0\\.0\\.1:400[02])/, ${JSON.stringify(base)}), init);\n`,
  );
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
if [[ " $* " == *" ps "* ]]; then printf 'api\\trunning\\thealthy\\n'; exit 0; fi
exec "${process.execPath}" --import "${join(dir, 'preload.mjs')}" --input-type=module - x
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const envFile = join(dir, '.env');
  writeFileSync(envFile, '');
  if (opsFile !== undefined) writeFileSync(join(dir, '.env.ops'), opsFile);
  return new Promise<{ code: number; output: string }>((resolve) =>
    execFile(
      'bash',
      [SCRIPT, envFile],
      {
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          OVO_FIXTURE_TEST_CALLS: 'true',
          OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.ovo.test',
          OVO_INBOUND_ROUTE_SECRET: 'r'.repeat(32),
          OVO_SEED_ADMIN_EMAIL: SEED.email,
          OVO_SEED_ADMIN_PASSWORD: SEED.password,
          OVO_ALLOW_LOCAL_HTTP: 'true',
          OVO_CAPACITY_SIGNAL: 'log',
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, output: `${stdout}${stderr}` }),
    ),
  );
}

const opsFile = `OVO_OPS_ADMIN_EMAIL=${OPS.email}\nOVO_OPS_ADMIN_PASSWORD=${OPS.password}\n`;

describe('verify-compose.sh console sign-in (OPS-15)', () => {
  it('signs in as the ops administrator from the .env.ops beside the Compose environment', async () => {
    const run = await verify(await console_({ seedChanged: true }), opsFile);
    expect(run.output).toContain('ops administrator authenticated');
    expect(run.code).toBe(0);
  });

  it('accepts the seed administrator on its first, password-change-only sign-in', async () => {
    const run = await verify(await console_());
    expect(run.output).toContain('Seed administrator signed in with the bootstrap password');
    expect(run.code).toBe(0);
  });

  it('says what to configure once the seed password was changed', async () => {
    const run = await verify(await console_({ seedChanged: true }));
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('set OVO_OPS_ADMIN_EMAIL and OVO_OPS_ADMIN_PASSWORD');
  });

  it('fails while the ops administrator still has to change its password', async () => {
    const run = await verify(await console_({ opsMustChange: true }), opsFile);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('The ops administrator must change its password');
  });
});
