// OPS-11/17 host tooling: the external uptime probe, the preemption shutdown script, the GCP setup
// plan and the unit installer. Fakes only: local HTTP servers, a stand-in `gcloud`/`systemctl`.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FALLBACK, INBOUND, NUMBER, ROOT, runScript, sandbox, startTwilio } from './fake-stack.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(handler: (path: string) => [number, string]) {
  const hits: Array<{ path: string; body: string }> = [];
  const instance: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      hits.push({ path: request.url ?? '/', body });
      const [status, text] = handler(request.url ?? '/');
      response.writeHead(status, { 'content-type': 'application/json' }).end(text);
    });
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => instance.close(resolve)));
  return { base: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`, hits };
}

function recorder(box: ReturnType<typeof sandbox>, tool: string) {
  const log = join(box.dir, `${tool}.log`);
  writeFileSync(join(box.dir, 'bin', tool), `#!/bin/sh\necho "$@" >> "${log}"\n`);
  chmodSync(join(box.dir, 'bin', tool), 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
}

describe('uptime-probe.sh', () => {
  it('alerts once after consecutive failures and once on recovery, never per run', async () => {
    let healthy = false;
    const site = await server(() =>
      healthy ? [200, '{"ready":true,"sessions":0}'] : [502, 'bad gateway'],
    );
    const hook = await server(() => [200, 'ok']);
    const box = sandbox();
    cleanups.push(box.cleanup);
    const state = join(box.dir, 'probe.state');
    const probe = () =>
      runScript(
        'scripts/ops/uptime-probe.sh',
        ['--url', `${site.base}/ovo-gateway-health`, '--state-file', state],
        {
          ...box.env,
          OVO_OPS_ALERT_WEBHOOK_URL: `${hook.base}/hook`,
        },
      );
    expect((await probe()).code).toBe(1);
    expect(hook.hits).toHaveLength(0);
    const second = await probe();
    expect(second.stdout).toContain('DOWN (2 consecutive)');
    expect((await probe()).code).toBe(1);
    expect(hook.hits).toHaveLength(1);
    expect(JSON.parse(hook.hits[0]!.body).text).toContain('OVO DOWN');
    healthy = true;
    expect((await probe()).code).toBe(0);
    expect((await probe()).code).toBe(0);
    expect(hook.hits.map((hit) => JSON.parse(hit.body).text.split(':')[0])).toEqual([
      'OVO DOWN',
      'OVO RECOVERED after 3 failed checks',
    ]);
  });

  it('treats a reachable but draining gateway as down', async () => {
    const site = await server(() => [200, '{"ready":false,"sessions":1}']);
    const box = sandbox();
    cleanups.push(box.cleanup);
    const run = await runScript(
      'scripts/ops/uptime-probe.sh',
      [
        '--url',
        `${site.base}/ovo-gateway-health`,
        '--state-file',
        join(box.dir, 's'),
        '--failures',
        '1',
        '--dry-run',
      ],
      box.env,
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('the gateway is not ready');
    expect(run.stdout).toContain('alert: {"text":"OVO DOWN');
  });
});

describe('preemption-shutdown.sh', () => {
  async function setup(preempted: string) {
    const metadata = await server((path) =>
      path === '/instance/preempted' ? [200, preempted] : [404, ''],
    );
    const twilio = await startTwilio({
      voice_url: INBOUND,
      voice_method: 'POST',
      voice_fallback_url: FALLBACK,
      voice_fallback_method: 'POST',
      status_callback: null,
      status_callback_method: 'POST',
    });
    cleanups.push(twilio.close);
    const box = sandbox();
    cleanups.push(box.cleanup);
    writeFileSync(join(box.dir, '.env'), '', { mode: 0o600 });
    writeFileSync(
      join(box.dir, '.env.ops'),
      `OVO_OPS_TWILIO_ACCOUNT_SID=AC1\nOVO_OPS_TWILIO_API_KEY_SID=SK1\nOVO_OPS_TWILIO_API_KEY_SECRET=key-secret\nOVO_OPS_TWILIO_NUMBER=${NUMBER}\nOVO_OPS_FALLBACK_URL=${FALLBACK}\nOVO_OPS_TWILIO_API_BASE=${twilio.base}\n`,
    );
    // The script reads the env files from <repo>/infra/compose; point it at a repo-shaped copy.
    const repo = join(box.dir, 'repo');
    for (const path of ['scripts/deploy', 'scripts/ops'])
      cpSync(join(ROOT, path), join(repo, path), {
        recursive: true,
        filter: (source) => !source.includes('/tests'),
      });
    mkdirSync(join(repo, 'infra/compose'), { recursive: true });
    for (const name of ['.env', '.env.ops'])
      copyFileSync(join(box.dir, name), join(repo, 'infra/compose', name));
    const run = () =>
      runScript(join(repo, 'scripts/ops/preemption-shutdown.sh'), [], {
        ...box.env,
        OVO_GCE_METADATA_URL: metadata.base,
      });
    return { twilio, run };
  }

  it('points the number at the fallback when GCE preempts the VM', async () => {
    const { twilio, run } = await setup('TRUE');
    const result = await run();
    expect(result.stdout).toContain('number switched to the fallback');
    expect(twilio.posts).toEqual([{ VoiceUrl: FALLBACK }]);
  });

  it('leaves the number alone on an ordinary shutdown', async () => {
    const { twilio, run } = await setup('FALSE');
    expect((await run()).stdout).toContain('not a preemption');
    expect(twilio.posts).toEqual([]);
  });
});

describe('gcp-monitoring-setup.sh', () => {
  const args = [
    '--project',
    'ovo-prod',
    '--zone',
    'asia-south1-a',
    '--instance',
    'ovo-dev',
    '--host',
    'voice.ovo.example',
    '--notification-channel',
    'projects/ovo-prod/notificationChannels/7',
  ];

  it('prints the plan without calling gcloud by default', async () => {
    const box = sandbox();
    cleanups.push(box.cleanup);
    const gcloud = recorder(box, 'gcloud');
    const run = await runScript('scripts/ops/gcp-monitoring-setup.sh', args, box.env);
    expect(run.code).toBe(0);
    expect(gcloud()).toEqual([]);
    expect(run.stdout).toContain('+ gcloud monitoring uptime create ovo-voice-ovo-example');
    expect(run.stdout).toContain('--path=/ovo-gateway-health --period=1');
    expect(run.stdout).toContain('--region=asia-south1 --daily-schedule');
    expect(run.stdout).toContain('--metadata-from-file=shutdown-script=');
    expect(run.stdout).not.toContain('set-scheduling');
  });

  it('applies the commands, wiring the alert policy to the created check', async () => {
    const box = sandbox();
    cleanups.push(box.cleanup);
    const log = join(box.dir, 'gcloud.log');
    writeFileSync(
      join(box.dir, 'bin', 'gcloud'),
      `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *policy-from-file=*) f=$(echo "$*" | sed 's/.*policy-from-file=\\([^ ]*\\).*/\\1/'); cp "$f" "${box.dir}/policy.json";; esac\ncase "$*" in "monitoring uptime list-configs"*) echo projects/ovo-prod/uptimeCheckConfigs/ovo-voice-abc123;; esac\n`,
    );
    chmodSync(join(box.dir, 'bin', 'gcloud'), 0o755);
    const run = await runScript(
      'scripts/ops/gcp-monitoring-setup.sh',
      [...args, '--on-demand', '--apply'],
      box.env,
    );
    expect(run.code).toBe(0);
    const policy = JSON.parse(readFileSync(join(box.dir, 'policy.json'), 'utf8'));
    expect(policy.conditions[0].conditionThreshold.filter).toContain(
      'metric.label.check_id="ovo-voice-abc123"',
    );
    expect(readFileSync(log, 'utf8')).toContain('compute instances set-scheduling ovo-dev');
  });
});

describe('install-host-units.sh', () => {
  it('renders the units for the checkout and enables the backup timer', async () => {
    const box = sandbox();
    cleanups.push(box.cleanup);
    const systemctl = recorder(box, 'systemctl');
    const root = join(box.dir, 'root');
    const run = await runScript(
      'scripts/ops/install-host-units.sh',
      ['--repo-dir', '/srv/ovo', '--apply'],
      { ...box.env, OVO_HOST_ROOT: root },
    );
    expect(run.code).toBe(0);
    const unit = readFileSync(join(root, 'etc/systemd/system/ovo-compose.service'), 'utf8');
    expect(unit).toContain('WorkingDirectory=/srv/ovo');
    expect(unit).not.toContain('__OVO_');
    expect(readFileSync(join(root, 'etc/systemd/system/ovo-backup.service'), 'utf8')).toContain(
      'ExecStart=/srv/ovo/scripts/backup/ovo-backup.sh',
    );
    expect(existsSync(join(root, 'etc/logrotate.d/ovo'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(root, 'etc/docker/daemon.json'), 'utf8'))['log-opts'][
        'max-size'
      ],
    ).toBe('20m');
    expect(systemctl()).toEqual([
      'daemon-reload',
      'enable ovo-compose.service',
      'enable --now ovo-backup.timer',
      'restart systemd-journald',
    ]);
  });
});
