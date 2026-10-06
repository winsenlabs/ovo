// End-to-end runs of scripts/ops/verify-live.sh and scripts/deploy/ovo-live.sh against the fakes:
// a stand-in docker, an in-process stack (console API, dispatcher, workers, gateway) and a fake
// Twilio IncomingPhoneNumbers API. No container, carrier or real credential is involved.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  FALLBACK,
  INBOUND,
  NUMBER,
  STATUS,
  healthyStack,
  runScript,
  sandbox,
  startStack,
  startTwilio,
  type StackState,
} from './fake-stack.ts';

const LIVE_WORKER = {
  OVO_LIVE_DIAL_ENABLED: 'true',
  OVO_INBOUND_CAPACITY_ENABLED: 'true',
  OVO_TRANSPORT_CERTIFIED: 'true',
};
const LIVE_CONTAINERS = {
  api: {
    OVO_ALLOW_LOCAL_HTTP: 'false',
    OVO_LIVE_DIAL_ENABLED: 'true',
    OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.ovo.test',
  },
  gateway: { OVO_LIVE_DIAL_ENABLED: 'true', OVO_INBOUND_ENABLED: 'true' },
  dispatcher: { OVO_LIVE_DIAL_ENABLED: 'true', OVO_INBOUND_ENABLED: 'true' },
  'worker-1': LIVE_WORKER,
  'worker-2': LIVE_WORKER,
};
const SERVICES = ['api', 'console', 'gateway', 'dispatcher', 'worker-1', 'worker-2'];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  options: { stack?: Partial<StackState>; voiceUrl?: string | null; liveEnv?: boolean } = {},
) {
  const stack = await startStack({ ...healthyStack(), ...options.stack });
  const twilio = await startTwilio({
    voice_url: options.voiceUrl === undefined ? FALLBACK : options.voiceUrl,
    voice_method: 'POST',
    voice_fallback_url: null,
    voice_fallback_method: 'POST',
    status_callback: null,
    status_callback_method: 'POST',
  });
  const box = sandbox({
    env: LIVE_CONTAINERS,
    services: SERVICES,
    workers: { 'worker-1': 'ready', 'worker-2': 'ready' },
  });
  cleanups.push(stack.close, twilio.close, box.cleanup);
  const envFile = join(box.dir, '.env');
  const live = options.liveEnv ?? true;
  writeFileSync(
    envFile,
    [
      'OVO_MEDIA_PUBLIC_BASE_URL=https://voice.ovo.test',
      `OVO_LIVE_DIAL_ENABLED=${live}`,
      `OVO_INBOUND_ENABLED=${live}`,
      `OVO_TRANSPORT_CERTIFIED=${live}`,
      `OVO_ALLOW_LOCAL_HTTP=${!live}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const opsFile = join(box.dir, '.env.ops');
  writeFileSync(
    opsFile,
    [
      'OVO_OPS_TWILIO_ACCOUNT_SID=AC1',
      'OVO_OPS_TWILIO_API_KEY_SID=SK1',
      'OVO_OPS_TWILIO_API_KEY_SECRET=key-secret',
      `OVO_OPS_TWILIO_NUMBER=${NUMBER}`,
      `OVO_OPS_FALLBACK_URL=${FALLBACK}`,
      `OVO_OPS_TWILIO_API_BASE=${twilio.base}`,
      `OVO_OPS_PUBLIC_PROBE_BASE=${stack.base}`,
      `OVO_OPS_ADMIN_EMAIL=${ADMIN.email}`,
      `OVO_OPS_ADMIN_PASSWORD=${ADMIN.password}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const env = { ...box.env, OVO_OPS_ENDPOINTS: JSON.stringify(stack.endpoints) };
  const files = ['--env-file', envFile, '--ops-env', opsFile];
  // Drops the named OVO_OPS_* lines and appends others, as an operator editing .env.ops would.
  const editOps = (drop: string[], add: string[] = []) =>
    writeFileSync(
      opsFile,
      [
        ...readFileSync(opsFile, 'utf8')
          .split('\n')
          .filter((line) => line && !drop.includes(line.split('=', 1)[0]!)),
        ...add,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  return { stack, twilio, box, envFile, env, files, editOps };
}

describe('verify-live.sh (OPS-7)', () => {
  it('passes a live stack whose number points at it, without printing secrets', async () => {
    const { env, files, box, twilio } = await setup({ voiceUrl: INBOUND });
    twilio.number.status_callback = STATUS;
    twilio.number.voice_fallback_url = FALLBACK;
    const run = await runScript('scripts/ops/verify-live.sh', files, env);
    expect(run.stdout).toContain('Live verification passed.');
    expect(run.code).toBe(0);
    expect(`${run.stdout}${run.stderr}${box.dockerLog().join('\n')}`).not.toMatch(
      /key-secret|secret-inbound/,
    );
  });

  it('fails while the number still points at the fallback, and passes once switched', async () => {
    const { env, files, twilio } = await setup();
    let run = await runScript('scripts/ops/verify-live.sh', files, env);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('Voice URL is the fallback (live is off)');
    twilio.number.voice_url = INBOUND;
    twilio.number.status_callback = STATUS;
    twilio.number.voice_fallback_url = FALLBACK;
    run = await runScript('scripts/ops/verify-live.sh', files, env);
    expect(run.stdout).toContain('PASS carrier-number');
    expect(run.stdout).toContain('PASS wss-upgrade');
    expect(run.stdout).toContain('Live verification passed.');
    expect(run.code).toBe(0);
  });

  it('fails when the proxy does not pass WebSocket upgrades', async () => {
    const { env, files } = await setup({ stack: { upgradeStatus: 426 } });
    const run = await runScript('scripts/ops/verify-live.sh', [...files, '--pre-switch'], env);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL wss-upgrade: the proxy answered 426');
  });

  it('signs in only as the dedicated ops account, never as the seed administrator', async () => {
    const { env, files, box, editOps } = await setup({ voiceUrl: INBOUND });
    editOps(['OVO_OPS_ADMIN_EMAIL', 'OVO_OPS_ADMIN_PASSWORD']);
    const seeded = {
      ...env,
      OVO_SEED_ADMIN_EMAIL: ADMIN.email,
      OVO_SEED_ADMIN_PASSWORD: ADMIN.password,
    };
    const missing = await runScript('scripts/ops/verify-live.sh', files, seeded);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('OVO_OPS_ADMIN_EMAIL is not set');
    expect(box.dockerLog()).toEqual([]);

    editOps([], [`OVO_OPS_ADMIN_EMAIL=${ADMIN.email}`, `OVO_OPS_ADMIN_PASSWORD=${ADMIN.password}`]);
    const seedPassword = await runScript(
      'scripts/ops/verify-live.sh',
      [...files, '--skip-base'],
      seeded,
    );
    expect(seedPassword.code).toBe(1);
    expect(seedPassword.stderr).toContain('OVO_OPS_ADMIN_PASSWORD is the bootstrap seed password');
  });

  it('reports an ops account that must change its password (OPS-15) instead of failing every read', async () => {
    const { env, files } = await setup({
      voiceUrl: INBOUND,
      stack: { passwordChangeRequired: true },
    });
    const run = await runScript('scripts/ops/verify-live.sh', [...files, '--skip-base'], env);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('console sign-in needs a password change first');
  });

  it('saves a redacted snapshot that --snapshot re-evaluates offline without docker', async () => {
    const { env, files, box } = await setup({ voiceUrl: INBOUND });
    const saved = join(box.dir, 'snapshot.json');
    await runScript('scripts/ops/verify-live.sh', [...files, '--save-snapshot', saved], env);
    expect(readFileSync(saved, 'utf8')).not.toContain('secret-inbound');
    const before = box.dockerLog().length;
    const offline = await runScript('scripts/ops/verify-live.sh', ['--snapshot', saved], env);
    expect(box.dockerLog()).toHaveLength(before);
    expect(offline.stdout).toContain('FAIL carrier-number: +12025550123: status callback');
    expect(offline.code).toBe(1);
  });
});

describe('ovo-live.sh (OPS-8)', () => {
  it('off points the Voice URL at the fallback without touching any container', async () => {
    const { env, files, twilio, box } = await setup({ voiceUrl: INBOUND });
    twilio.number.status_callback = STATUS;
    const run = await runScript('scripts/deploy/ovo-live.sh', ['off', ...files], env);
    expect(run.code).toBe(0);
    expect(twilio.posts).toEqual([{ VoiceUrl: FALLBACK }]);
    expect(twilio.number.status_callback).toBe(STATUS);
    expect(box.dockerLog()).toEqual([]);
  });

  it('on turns the flags on with a drained restart, checks, then switches and re-verifies', async () => {
    const { env, files, twilio, box, envFile } = await setup({ liveEnv: false });
    const run = await runScript('scripts/deploy/ovo-live.sh', ['on', ...files], env);
    expect(run.stderr).toContain(
      'changed: OVO_LIVE_DIAL_ENABLED OVO_INBOUND_ENABLED OVO_TRANSPORT_CERTIFIED OVO_ALLOW_LOCAL_HTTP',
    );
    expect(run.code).toBe(0);
    const environment = readFileSync(envFile, 'utf8');
    for (const line of [
      'OVO_LIVE_DIAL_ENABLED=true',
      'OVO_INBOUND_ENABLED=true',
      'OVO_TRANSPORT_CERTIFIED=true',
      'OVO_ALLOW_LOCAL_HTTP=false',
    ])
      expect(environment).toContain(line);
    const ups = box.dockerLog().filter((line) => line.includes(' up -d --no-deps --wait '));
    expect(ups.map((line) => line.split(' ').at(-1))).toEqual([
      'api',
      'dispatcher',
      'worker-1',
      'worker-2',
      'gateway',
    ]);
    expect(twilio.posts).toEqual([
      { VoiceUrl: INBOUND, StatusCallback: STATUS, VoiceFallbackUrl: FALLBACK },
    ]);
    expect(run.stdout).toContain('Live verification passed.');
    expect(box.dockerLog().join('\n')).not.toContain('key-secret');
  });

  it('on refuses to switch the number when the live checks fail', async () => {
    const { env, files, twilio } = await setup({ stack: { liveReady: false } });
    const run = await runScript('scripts/deploy/ovo-live.sh', ['on', ...files], env);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain('FAIL releases-live-ready');
    expect(run.stderr).toContain('the number was not switched');
    expect(twilio.posts).toEqual([]);
  });

  it('--dry-run changes neither the environment nor the number', async () => {
    const { env, files, twilio, envFile } = await setup({ liveEnv: false });
    const before = readFileSync(envFile, 'utf8');
    const run = await runScript('scripts/deploy/ovo-live.sh', ['on', ...files, '--dry-run'], env);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('dry run: would set voiceUrl');
    expect(readFileSync(envFile, 'utf8')).toBe(before);
    expect(twilio.posts).toEqual([]);
  });

  it('status reports where the number points', async () => {
    const { env, files } = await setup();
    const run = await runScript('scripts/deploy/ovo-live.sh', ['status', ...files], env);
    expect(run.stdout).toContain(`${NUMBER}: OFF (fallback TwiML) ${FALLBACK} (POST)`);
    expect(run.stderr).toContain('OVO_INBOUND_ENABLED=true');
  });

  it('status never prints the signed token of the stack carrier URLs', async () => {
    const { env, files, twilio } = await setup({ voiceUrl: INBOUND });
    twilio.number.status_callback = STATUS;
    const run = await runScript('scripts/deploy/ovo-live.sh', ['status', ...files], env);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      'routed to https://voice.ovo.test/carriers/twilio/bind-1/inbound?redacted-',
    );
    expect(run.stdout).toContain(
      'status callback: https://voice.ovo.test/carriers/twilio/bind-1/status?redacted-',
    );
    expect(run.stdout).not.toMatch(/secret-inbound|secret-status/);
  });

  it('on refuses before changing anything without the ops console account', async () => {
    const { env, files, envFile, box, twilio, editOps } = await setup({ liveEnv: false });
    editOps(['OVO_OPS_ADMIN_PASSWORD']);
    const before = readFileSync(envFile, 'utf8');
    const run = await runScript('scripts/deploy/ovo-live.sh', ['on', ...files], env);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('OVO_OPS_ADMIN_PASSWORD is not set');
    expect(readFileSync(envFile, 'utf8')).toBe(before);
    expect(box.dockerLog()).toEqual([]);
    expect(twilio.posts).toEqual([]);
  });

  it('refuses to run without carrier control credentials', async () => {
    const { env, envFile, box } = await setup();
    const run = await runScript(
      'scripts/deploy/ovo-live.sh',
      ['off', '--env-file', envFile, '--ops-env', join(box.dir, 'none')],
      env,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('OVO_OPS_TWILIO_ACCOUNT_SID is not set');
  });
});
