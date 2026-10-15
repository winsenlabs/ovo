import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./compose.yaml', import.meta.url), 'utf8');
const script = (name: string) => new URL(`../../scripts/${name}`, import.meta.url);

function service(name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing Compose service ${name}`);
  const remainder = source.slice(start + 1);
  const end = remainder.slice(1).search(/\n  [a-z][a-z0-9-]*:\n|\n[^ \n]/);
  return end < 0 ? remainder : remainder.slice(0, end + 1);
}

describe('livekit room server (Wave 17, dark by default)', () => {
  const room = () => service('livekit');

  it('runs only in the livekit profile, on the host network, publishing no port', () => {
    expect(room()).toContain('    profiles: [livekit]\n');
    expect(room()).toContain('    network_mode: host\n');
    expect(room()).not.toContain('ports:');
    expect(room()).toContain('image: ${OVO_LIVEKIT_IMAGE:-livekit/livekit-server:v1.13.9}');
    expect(room()).toContain("command: ['--config', '/etc/livekit.yaml']");
  });

  it('pins the image to a version, never latest, and builds nothing', () => {
    expect(room()).not.toMatch(/image: .*:latest/);
    expect(room()).not.toContain('build:');
    expect(/livekit-server:v\d+\.\d+\.\d+/.test(room())).toBe(true);
  });

  it('mounts the rendered config read-only and ignores it in git', () => {
    expect(room()).toContain('- ./livekit.yaml:/etc/livekit.yaml:ro');
    const ignore = readFileSync(new URL('./.gitignore', import.meta.url), 'utf8');
    expect(ignore.split('\n')).toContain('/livekit.yaml');
    const template = readFileSync(new URL('./livekit.yaml.template', import.meta.url), 'utf8');
    expect(template).toContain('auto_create: false');
    expect(template).not.toMatch(/devkey|secret:/i);
  });

  it('checks health on the loopback signalling port and restarts without dropping calls on a deploy', () => {
    // The port the config is rendered with (OVO_LIVEKIT_SIGNAL_PORT), or `compose up --wait` fails.
    expect(room()).toContain(
      "'wget', '-q', '--spider', 'http://127.0.0.1:${OVO_LIVEKIT_SIGNAL_PORT:-7880}/'",
    );
    expect(room()).toContain('restart: unless-stopped');
    expect(room()).toContain('logging: *logging');
  });

  it('is never a dependency of the default stack', () => {
    for (const name of ['api', 'gateway', 'dispatcher', 'worker-1', 'worker-2', 'console'])
      expect(service(name), name).not.toMatch(/depends_on:[\s\S]*livekit:/);
    expect(source).not.toMatch(/\n {6}livekit: \{/);
  });

  it('gives the api and workers the room settings, off when unset, and never the bind settings', () => {
    for (const name of ['api', 'worker-1']) {
      expect(service(name)).toContain('OVO_LIVEKIT_ENABLED: ${OVO_LIVEKIT_ENABLED:-false}');
      expect(service(name)).toContain(
        'OVO_LIVEKIT_URL: ${OVO_LIVEKIT_URL:-ws://172.29.240.1:7880}',
      );
      expect(service(name)).toContain('OVO_LIVEKIT_API_SECRET: ${OVO_LIVEKIT_API_SECRET:-}');
      expect(service(name)).not.toContain('OVO_LIVEKIT_PUBLIC_ENABLED');
      expect(service(name)).not.toContain('OVO_LIVEKIT_NODE_IP');
    }
    expect(service('api')).toContain('OVO_LIVEKIT_PUBLIC_URL: ${OVO_LIVEKIT_PUBLIC_URL:-}');
    // The room plugin reads OVO_ROOM_TOKEN_TTL_SECONDS; the deployment sets one name, the LiveKit one.
    expect(service('api')).toContain(
      'OVO_ROOM_TOKEN_TTL_SECONDS: ${OVO_LIVEKIT_TOKEN_TTL_SECONDS:-}',
    );
    expect(service('api')).toContain(
      'OVO_LIVEKIT_TOKEN_TTL_SECONDS: ${OVO_LIVEKIT_TOKEN_TTL_SECONDS:-}',
    );
    expect(service('worker-1')).not.toContain('OVO_LIVEKIT_PUBLIC_URL');
    for (const name of ['gateway', 'dispatcher', 'console'])
      expect(service(name), name).not.toContain('OVO_LIVEKIT');
  });
});

describe('human queues (Wave 17, dark by default)', () => {
  it('gives the api, the workers and the dispatcher the master flag, off when unset', () => {
    for (const name of ['api', 'worker-1', 'dispatcher'])
      expect(service(name), name).toContain(
        'OVO_HUMAN_QUEUE_ENABLED: ${OVO_HUMAN_QUEUE_ENABLED:-false}',
      );
    for (const name of ['api', 'worker-1'])
      expect(service(name), name).toContain(
        'OVO_HUMAN_QUEUE_WEBHOOK_ENABLED: ${OVO_HUMAN_QUEUE_WEBHOOK_ENABLED:-false}',
      );
    for (const name of ['gateway', 'console', 'dispatcher'])
      expect(service(name), name).not.toContain('OVO_HUMAN_QUEUE_WEBHOOK_ENABLED');
    expect(service('worker-1')).toContain(
      'OVO_HUMAN_QUEUE_CALLBACK_BASE_URL: ${OVO_HUMAN_QUEUE_CALLBACK_BASE_URL:-}',
    );
    expect(service('worker-1')).toContain('OVO_HUMAN_QUEUE_POLL_MS: ${OVO_HUMAN_QUEUE_POLL_MS:-}');
    expect(service('dispatcher')).toContain(
      'OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS: ${OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS:-}',
    );
    expect(service('gateway')).not.toContain('OVO_HUMAN_QUEUE');
  });

  it('forwards the sip-gateway transfer settings, the bridge off', () => {
    expect(service('sip-gateway')).toContain(
      'OVO_SIP_REFER_TIMEOUT_MS: ${OVO_SIP_REFER_TIMEOUT_MS:-}',
    );
    expect(service('sip-gateway')).toContain(
      'OVO_SIP_BRIDGE_ENABLED: ${OVO_SIP_BRIDGE_ENABLED:-false}',
    );
  });

  it('ships every Wave 17 flag off in both env examples', () => {
    for (const file of ['./.env.example', '../../.env.example']) {
      const example = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const flag of [
        'OVO_HUMAN_QUEUE_ENABLED',
        'OVO_HUMAN_QUEUE_WEBHOOK_ENABLED',
        'OVO_LIVEKIT_ENABLED',
      ])
        expect(example, `${flag} in ${file}`).toContain(`\n${flag}=false\n`);
    }
    const compose = readFileSync(new URL('./.env.example', import.meta.url), 'utf8');
    expect(compose).toContain('\nOVO_LIVEKIT_PUBLIC_ENABLED=false\n');
    expect(compose).toContain('\nOVO_SIP_BRIDGE_ENABLED=false\n');
  });
});

describe('bootstrap human queue values (Wave 17)', () => {
  it('writes the flags off and generates a room key pair that a rerun keeps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovo-bootstrap-'));
    try {
      const envFile = join(directory, '.env');
      const run = () =>
        execFileSync('bash', [script('bootstrap-compose.sh').pathname, '--env-file', envFile], {
          env: { ...process.env, OVO_SEED_ADMIN_EMAIL: 'admin@ovo.test' },
          stdio: 'pipe',
        });
      const value = (key: string) =>
        readFileSync(envFile, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(`${key}=`))
          .map((line) => line.slice(key.length + 1));
      run();
      for (const flag of [
        'OVO_HUMAN_QUEUE_ENABLED',
        'OVO_HUMAN_QUEUE_WEBHOOK_ENABLED',
        'OVO_LIVEKIT_ENABLED',
        'OVO_LIVEKIT_PUBLIC_ENABLED',
      ])
        expect(value(flag), flag).toEqual(['false']);
      const [key] = value('OVO_LIVEKIT_API_KEY');
      const [secret] = value('OVO_LIVEKIT_API_SECRET');
      expect(key).toMatch(/^ovo[0-9a-f]{12}$/);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      run();
      expect(value('OVO_LIVEKIT_API_KEY')).toEqual([key]);
      expect(value('OVO_LIVEKIT_API_SECRET')).toEqual([secret]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
