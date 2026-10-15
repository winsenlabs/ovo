import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./compose.yaml', import.meta.url), 'utf8');

function service(name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing Compose service ${name}`);
  const remainder = source.slice(start + 1);
  const end = remainder.slice(1).search(/\n  [a-z][a-z0-9-]*:\n|\n[^ \n]/);
  return end < 0 ? remainder : remainder.slice(0, end + 1);
}

it.each([
  ['api', 'OVO_MEDIA_PUBLIC_BASE_URL'],
  ['api', 'OVO_INBOUND_ROUTE_SECRET'],
  ['worker-1', 'OVO_INBOUND_ROUTE_SECRET'],
  ['worker-2', 'OVO_INBOUND_ROUTE_SECRET'],
])('supplies %s with its required %s', (name, key) => {
  let definition = service(name);
  if (name === 'worker-2') {
    expect(definition).toContain('<<: *worker');
    const worker = service('worker-1');
    expect(worker).toContain('environment: &worker');
    definition += worker;
  }
  expect(definition).toContain(`${key}: \${${key}:?set ${key}}`);
});

it('trusts forwarded TLS only from the pinned console address', () => {
  expect(service('api')).toContain(
    'OVO_TRUSTED_PROXY_CIDRS: ${OVO_CONSOLE_ADDRESS:-172.29.240.10}/32',
  );
  expect(service('console')).toContain('ipv4_address: ${OVO_CONSOLE_ADDRESS:-172.29.240.10}');
  expect(source).toContain('- subnet: ${OVO_COMPOSE_SUBNET:-172.29.240.0/24}');
});

it('verifies sign-in over forwarded TLS when local HTTP is disabled', () => {
  const verifier = readFileSync(
    new URL('../../scripts/verify-compose.sh', import.meta.url),
    'utf8',
  );
  expect(verifier).toContain("...(localHttp ? {} : { 'x-forwarded-proto': 'https' })");
  expect(verifier).toContain('TLS sign-in did not issue a Secure cookie');
});

it('passes OVO_LOG_LEVEL to every service and the transcript-text policy to the workers', () => {
  const common = source.slice(
    source.indexOf('x-common-environment'),
    source.indexOf('\nservices:'),
  );
  expect(common).toContain('OVO_LOG_LEVEL: ${OVO_LOG_LEVEL:-info}');
  for (const name of ['api', 'gateway', 'dispatcher', 'worker-1', 'secrets-rewrap'])
    expect(service(name)).toContain('<<: *common');
  expect(service('worker-1')).toContain(
    'OVO_TELEMETRY_TRANSCRIPT_TEXT: ${OVO_TELEMETRY_TRANSCRIPT_TEXT:-store}',
  );
  expect(service('worker-1')).toContain(
    'OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS: ${OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS:-}',
  );
  expect(service('worker-2')).toContain('<<: *worker');
});

it('gives the API the same capacity ceiling as the dispatcher', () => {
  expect(service('api')).toContain("OVO_WORKER_MAX_CAPACITY: '2'");
  expect(service('dispatcher')).toContain("OVO_WORKER_MAX_CAPACITY: '2'");
});

it('lets every service that decrypts credentials read the previous master key', () => {
  for (const name of ['api', 'gateway', 'worker-1', 'secrets-rewrap']) {
    expect(service(name)).toContain('OVO_SECRETS_MASTER_KEY: ${OVO_SECRETS_MASTER_KEY:?');
    expect(service(name)).toContain(
      'OVO_SECRETS_MASTER_KEY_PREVIOUS: ${OVO_SECRETS_MASTER_KEY_PREVIOUS:-}',
    );
  }
});

it('runs the master key rewrap only as an opt-in tool against the shipped command', () => {
  const tool = service('secrets-rewrap');
  expect(tool).toContain('profiles: [tools]');
  expect(tool).toContain('target: workspace');
  expect(tool).toContain('entrypoint: [pnpm, exec, tsx, apps/api/src/secrets-rewrap.ts]');
  expect(existsSync(new URL('../../apps/api/src/secrets-rewrap.ts', import.meta.url))).toBe(true);
});

const script = (name: string) => new URL(`../../scripts/${name}`, import.meta.url);

it('renders no env carrier binding and never interpolates Twilio credentials', () => {
  expect(source).toContain("  OVO_CARRIER_ENV_BINDINGS: '{}'\n");
  expect(source).not.toMatch(/\$\{TWILIO_/);
});

it('fails verification when any service still carries an env carrier binding', () => {
  const verifier = readFileSync(script('verify-compose.sh'), 'utf8');
  expect(verifier).toContain('for service in api gateway worker-1 worker-2; do');
  expect(verifier).toContain('Compose must not configure an env carrier binding');
});

describe('bootstrap Twilio values', () => {
  const run = (envFile: string) =>
    execFileSync('bash', [script('bootstrap-compose.sh').pathname, '--env-file', envFile], {
      env: { ...process.env, OVO_SEED_ADMIN_EMAIL: 'admin@ovo.test' },
      stdio: 'pipe',
    });
  const read = (envFile: string, key: string) =>
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith(`${key}=`));

  it('writes empty values and clears placeholders an older bootstrap wrote', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovo-bootstrap-'));
    try {
      const fresh = join(directory, 'fresh.env');
      run(fresh);
      expect(read(fresh, 'TWILIO_ACCOUNT_SID')).toEqual(['TWILIO_ACCOUNT_SID=']);
      expect(read(fresh, 'TWILIO_AUTH_TOKEN')).toEqual(['TWILIO_AUTH_TOKEN=']);

      const older = join(directory, 'older.env');
      writeFileSync(
        older,
        'OVO_SESSION_SECRET=kept-session-secret\nTWILIO_ACCOUNT_SID=disabled-local-account\nTWILIO_AUTH_TOKEN=disabled-local-token\n',
        { mode: 0o600 },
      );
      run(older);
      expect(read(older, 'TWILIO_ACCOUNT_SID')).toEqual(['TWILIO_ACCOUNT_SID=']);
      expect(read(older, 'TWILIO_AUTH_TOKEN')).toEqual(['TWILIO_AUTH_TOKEN=']);
      expect(read(older, 'OVO_SESSION_SECRET')).toEqual(['OVO_SESSION_SECRET=kept-session-secret']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('bootstrap SIP values (Wave 11)', () => {
  it('writes SIP off with generated internal secrets, and keeps them on a rerun', () => {
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
      expect(value('OVO_SIP_ENABLED')).toEqual(['false']);
      expect(value('OVO_SIP_PUBLIC_ENABLED')).toEqual(['false']);
      const [token] = value('OVO_SIP_CONTROL_TOKEN');
      const [secret] = value('OVO_SIP_GATEWAY_SECRET');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      // The gateway's verifier needs base64 of at least 32 bytes (ovo-sip/1 signing key).
      expect(Buffer.from(secret!, 'base64')).toHaveLength(32);
      run();
      expect(value('OVO_SIP_CONTROL_TOKEN')).toEqual([token]);
      expect(value('OVO_SIP_GATEWAY_SECRET')).toEqual([secret]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('sip-gateway (Wave 11, dark by default)', () => {
  const sip = () => service('sip-gateway');

  it('runs only in the sip profile, on the host network, publishing no port', () => {
    expect(sip()).toContain('    profiles: [sip]\n');
    expect(sip()).toContain('    network_mode: host\n');
    expect(sip()).not.toContain('ports:');
    expect(sip()).toContain('image: ${OVO_SIP_GATEWAY_IMAGE:-ovo-sip-gateway:local}');
    expect(sip()).toContain('target: sip-gateway');
  });

  it('keeps SIP and RTP on loopback unless the public flag is set', () => {
    expect(sip()).toContain('OVO_SIP_PUBLIC_ENABLED: ${OVO_SIP_PUBLIC_ENABLED:-false}');
    expect(sip()).toContain('OVO_SIP_PUBLIC_IP: ${OVO_SIP_PUBLIC_IP:-}');
    expect(sip()).toContain('OVO_SIP_RTP_PORT_MIN: ${OVO_SIP_RTP_PORT_MIN:-40000}');
    expect(sip()).toContain('OVO_SIP_RTP_PORT_MAX: ${OVO_SIP_RTP_PORT_MAX:-40199}');
    expect(sip()).toContain('OVO_SIP_HEALTH_LISTEN: 127.0.0.1:5091');
  });

  it('serves its control API to the compose subnet only, reached through the bridge gateway', () => {
    // 0.0.0.0, not the bridge address: that bind from a host-network container is unconfirmed.
    // No firewall rule exists for 5090; the bearer token and the source CIDRs guard it.
    expect(sip()).toContain('OVO_SIP_CONTROL_LISTEN: ${OVO_SIP_CONTROL_LISTEN:-0.0.0.0:5090}');
    expect(sip()).toContain('OVO_SIP_CONTROL_SOURCE_CIDRS: ${OVO_COMPOSE_SUBNET:-172.29.240.0/24}');
    expect(service('worker-1')).toContain(
      'OVO_SIP_CONTROL_URL: ${OVO_SIP_CONTROL_URL:-http://172.29.240.1:5090}',
    );
    expect(sip()).toContain('gateway: { condition: service_healthy }');
  });

  it('reaches the gateway over loopback with the same public base URL the gateway signs', () => {
    expect(sip()).toContain('OVO_SIP_MEDIA_INTERNAL_URL: http://127.0.0.1:${GATEWAY_PORT:-4001}');
    expect(sip()).toContain(
      'OVO_MEDIA_PUBLIC_BASE_URL: ${OVO_MEDIA_PUBLIC_BASE_URL:?set OVO_MEDIA_PUBLIC_BASE_URL}',
    );
    expect(service('gateway')).toContain("      - '127.0.0.1:${GATEWAY_PORT:-4001}:4001'\n");
  });

  it('mounts the trunk file read-only and ignores the real one in git', () => {
    expect(sip()).toContain('OVO_SIP_TRUNKS_FILE: /etc/ovo/sip-trunks.json');
    expect(sip()).toContain('- ./sip-trunks.json:/etc/ovo/sip-trunks.json:ro');
    const ignore = readFileSync(new URL('./.gitignore', import.meta.url), 'utf8');
    expect(ignore.split('\n')).toContain('/sip-trunks.json');
  });

  it('ships an example trunk file with documentation addresses only (RFC 5737)', () => {
    const example = JSON.parse(
      readFileSync(new URL('./sip-trunks.example.json', import.meta.url), 'utf8'),
    ) as { version: number; trunks: Array<Record<string, unknown>> };
    expect(example.version).toBe(1);
    const text = JSON.stringify(example);
    const addresses = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses)
      expect(address).toMatch(/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./);
    for (const trunk of example.trunks) {
      expect(['sip', 'tcn']).toContain(trunk.carrierId);
      expect((trunk.outbound as { enabled: boolean }).enabled).toBe(false);
    }
  });

  it('drains live SIP calls inside the stop grace period', () => {
    expect(sip()).toContain('stop_grace_period: 300s');
    const drain = /OVO_SIP_DRAIN_TIMEOUT_MS: '(\d+)'/.exec(sip());
    expect(Number(drain![1])).toBeLessThanOrEqual(300_000 - 30_000);
    expect(sip()).toContain("fetch('http://127.0.0.1:5091/health')");
  });

  it('gives the gateway and workers the SIP flag, off when unset', () => {
    for (const name of ['gateway', 'worker-1'])
      expect(service(name)).toContain('OVO_SIP_ENABLED: ${OVO_SIP_ENABLED:-false}');
    expect(service('gateway')).toContain(
      'OVO_SIP_GATEWAY_SECRET_PREVIOUS: ${OVO_SIP_GATEWAY_SECRET_PREVIOUS:-}',
    );
    expect(service('worker-1')).toContain('OVO_SIP_CONTROL_TOKEN: ${OVO_SIP_CONTROL_TOKEN:-}');
    expect(service('worker-2')).toContain('<<: *worker');
  });
});

it('keeps inbound admission tied to the flag and reports readiness from the dispatcher', () => {
  expect(service('worker-1')).toContain(
    'OVO_INBOUND_CAPACITY_ENABLED: ${OVO_INBOUND_ENABLED:-false}',
  );
  expect(service('dispatcher')).toContain('OVO_INBOUND_ENABLED: ${OVO_INBOUND_ENABLED:-false}');
  const verifier = readFileSync(script('verify-compose.sh'), 'utf8');
  expect(verifier).toContain("fetch('http://127.0.0.1:4002/health')");
  expect(verifier).toContain('Inbound admission is enabled but no protected slot is ready');
});

it('gives draining calls time before Docker escalates to SIGKILL', () => {
  for (const name of ['gateway', 'worker-1', 'worker-2'])
    expect(service(name)).toContain('stop_grace_period: 300s');
  const drain = /OVO_MEDIA_DRAIN_TIMEOUT_MS: '(\d+)'/.exec(service('gateway'));
  expect(drain).not.toBeNull();
  // The drain must finish, with room for cleanup, inside the 300s grace period.
  expect(Number(drain![1])).toBeLessThanOrEqual(300_000 - 30_000);
  expect(() => accessSync(script('wait-compose-idle.sh'), constants.X_OK)).not.toThrow();
});

describe('routing (Wave 15, dark by default)', () => {
  it('gives the api and the gateway the routing flag, off when unset', () => {
    for (const name of ['api', 'gateway'])
      expect(service(name)).toContain('OVO_ROUTING_ENABLED: ${OVO_ROUTING_ENABLED:-false}');
    for (const name of ['dispatcher', 'worker-1'])
      expect(service(name)).not.toContain('OVO_ROUTING_ENABLED:');
  });

  it('gives the workers the external engine flag (off) and the prepare bound (default)', () => {
    const worker = service('worker-1');
    expect(worker).toContain('environment: &worker');
    expect(worker).toContain(
      'OVO_ROUTING_EXTERNAL_ENABLED: ${OVO_ROUTING_EXTERNAL_ENABLED:-false}',
    );
    expect(worker).toContain('OVO_ROUTING_PREPARE_TIMEOUT_MS: ${OVO_ROUTING_PREPARE_TIMEOUT_MS:-}');
    expect(service('worker-2')).toContain('<<: *worker');
    // The API reports the external flag and warns at publish when it is off.
    expect(service('api')).toContain(
      'OVO_ROUTING_EXTERNAL_ENABLED: ${OVO_ROUTING_EXTERNAL_ENABLED:-false}',
    );
  });

  it('ships the routing flags off in both env examples', () => {
    for (const file of ['./.env.example', '../../.env.example']) {
      const example = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(example).toContain('\nOVO_ROUTING_ENABLED=false\n');
      expect(example).toContain('\nOVO_ROUTING_EXTERNAL_ENABLED=false\n');
    }
  });
});
