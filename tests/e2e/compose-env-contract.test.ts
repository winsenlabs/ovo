import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPOSE_SOURCE, renderServiceEnv, serviceEnvironments } from './support/compose-env.ts';
import { goLiveComposeVariables } from './support/deployment-env.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const PROFILES = 'packages/distribution/src/profiles';

/** Startup code of each Compose service: the app entrypoint plus its distribution profile. */
const SOURCES: Record<string, readonly string[]> = {
  api: ['apps/api/src', `${PROFILES}/api.ts`],
  gateway: ['apps/media-gateway/src', `${PROFILES}/gateway.ts`],
  dispatcher: ['apps/dispatcher/src', `${PROFILES}/dispatcher.ts`, `${PROFILES}/worker.ts`],
  'worker-1': ['apps/worker/src', `${PROFILES}/worker.ts`],
  'worker-2': ['apps/worker/src', `${PROFILES}/worker.ts`],
};

/** Read only on the Fargate profile; each entry names the branch that keeps it off Compose. */
const FARGATE_ONLY: Record<string, [file: string, branch: RegExp]> = {
  OVO_ECS_CLUSTER: [
    'apps/dispatcher/src/dispatcher-process.ts',
    /profile === 'fargate'\s*\?\s*new EcsServiceReader\(\s*required\(env, 'OVO_ECS_CLUSTER'\)/,
  ],
  OVO_WORKER_SERVICE: [
    'apps/dispatcher/src/dispatcher-process.ts',
    /required\(env, 'OVO_ECS_CLUSTER'\),\s*\{ workers: required\(env, 'OVO_WORKER_SERVICE'\) \}/,
  ],
  ECS_CONTAINER_METADATA_URI_V4: [
    'apps/worker/src/worker-process.ts',
    /protectionMode === 'process-lifecycle' \? undefined : await ecsRuntimeConfig\(\)/,
  ],
};

/**
 * Required without a `required(...)` call: each fails a Compose deployment at startup or at the
 * first live call. The pattern pins the code that reads it, so this list cannot silently rot.
 */
const CONFIGURED: { services: string[]; name: string; file: string; read: RegExp }[] = [
  {
    // a6e1a2f: encrypted-store secrets throw without the key; the gateway restart-looped.
    services: ['gateway'],
    name: 'OVO_SECRETS_MASTER_KEY',
    file: 'apps/media-gateway/src/startup.ts',
    read: /'encrypted-store'\),\s*masterKey: env\.OVO_SECRETS_MASTER_KEY/,
  },
  {
    services: ['api'],
    name: 'OVO_SECRETS_MASTER_KEY',
    file: 'apps/api/src/index.ts',
    read: /secretsMasterKey: process\.env\.OVO_SECRETS_MASTER_KEY/,
  },
  {
    // 8b2cfdd: with OVO_ALLOW_LOCAL_HTTP=false every sign-in behind TLS returned 426 without it.
    services: ['api'],
    name: 'OVO_TRUSTED_PROXY_CIDRS',
    file: 'apps/api/src/index.ts',
    read: /process\.env\.OVO_TRUSTED_PROXY_CIDRS/,
  },
  {
    // b20ef08: live readiness reported "capacity ceiling is not configured" for every agent.
    services: ['api'],
    name: 'OVO_WORKER_MAX_CAPACITY',
    file: 'apps/api/src/infrastructure-runtime.ts',
    read: /optionalInteger\(environment\.OVO_WORKER_MAX_CAPACITY/,
  },
  {
    // Carrier URLs for the operator are refused with 409 without both.
    services: ['api'],
    name: 'OVO_MEDIA_PUBLIC_BASE_URL',
    file: 'apps/api/src/routes/credentials.ts',
    read: /process\.env\.OVO_MEDIA_PUBLIC_BASE_URL/,
  },
  {
    services: ['api'],
    name: 'OVO_INBOUND_ROUTE_SECRET',
    file: 'apps/api/src/routes/credentials.ts',
    read: /process\.env\.OVO_INBOUND_ROUTE_SECRET/,
  },
];

const REQUIRED_CALLS = [
  /\brequired(?:Env)?\(\s*(?:[\w.]+\s*,\s*)?['"]([A-Z][A-Z0-9_]+)['"]\s*\)/g,
  /\benv\(\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\)/g,
  /Missing required environment variable ([A-Z][A-Z0-9_]+)/g,
];

function files(path: string): string[] {
  const absolute = join(ROOT, path);
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(path, name));
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** Every environment variable the service's startup code reads through a required helper. */
function requiredByCode(service: string): Set<string> {
  const names = new Set<string>();
  for (const file of SOURCES[service]!.flatMap(files))
    for (const pattern of REQUIRED_CALLS)
      for (const match of read(file).matchAll(pattern)) names.add(match[1]!);
  for (const name of Object.keys(FARGATE_ONLY)) names.delete(name);
  for (const entry of CONFIGURED) if (entry.services.includes(service)) names.add(entry.name);
  return names;
}

/** `service: NAME` for every required variable Compose does not hand that service non-empty. */
function missingRequiredEnv(source: string): string[] {
  const variables = goLiveComposeVariables('postgresql://ovo:secret@postgres:5432/ovo');
  return Object.keys(SOURCES).flatMap((service) => {
    const rendered = renderServiceEnv(service, variables, source);
    return [...requiredByCode(service)]
      .filter((name) => !rendered[name])
      .map((name) => `${service}: ${name}`);
  });
}

/** compose.yaml with one variable removed from one service's own environment block. */
function withoutVariable(service: string, name: string): string {
  const start = COMPOSE_SOURCE.indexOf(`\n  ${service}:\n`);
  const line = new RegExp(`\\n {6}${name}: [^\\n]*`).exec(COMPOSE_SOURCE.slice(start + 1));
  if (start < 0 || !line) throw new Error(`${service} does not set ${name} itself`);
  const at = start + 1 + line.index;
  return COMPOSE_SOURCE.slice(0, at) + COMPOSE_SOURCE.slice(at + line[0].length);
}

describe('Compose environment contract', () => {
  it('reads the anchored service environments the way Compose merges them', () => {
    const services = serviceEnvironments(COMPOSE_SOURCE);
    expect(services['worker-2']).toMatchObject({
      OVO_WORKER_ID: 'compact-worker-2',
      OVO_PROTECTION_MODE: 'process-lifecycle',
      DATABASE_URL: '${DATABASE_URL:?run ./scripts/bootstrap-compose.sh first}',
    });
    expect(services.gateway).not.toHaveProperty('OVO_WORKER_ID');
  });

  it('finds the variables each service requires at startup', () => {
    expect([...requiredByCode('gateway')]).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'OVO_MEDIA_PUBLIC_BASE_URL',
        'OVO_INBOUND_ROUTE_SECRET',
        'OVO_MEDIA_WORKER_TOKEN',
        'OVO_ORGANIZATION_ID',
        'OVO_SECRETS_MASTER_KEY',
      ]),
    );
    expect([...requiredByCode('worker-1')]).toEqual(
      expect.arrayContaining([
        'OVO_QUEUE_URL',
        'OVO_MEDIA_GATEWAY_WS_URL',
        'OVO_MEDIA_READINESS_URL',
        'OVO_WORKER_ENDPOINT',
      ]),
    );
    expect([...requiredByCode('dispatcher')]).toEqual(expect.arrayContaining(['OVO_DLQ_URL']));
  });

  it('pins every Fargate-only and configuration-required read to the code that makes it so', () => {
    for (const [name, [file, branch]] of Object.entries(FARGATE_ONLY))
      expect(read(file), `${name} is no longer Fargate-only in ${file}`).toMatch(branch);
    expect(serviceEnvironments(COMPOSE_SOURCE)['worker-1']?.OVO_PROTECTION_MODE).toBe(
      'process-lifecycle',
    );
    for (const entry of CONFIGURED)
      expect(read(entry.file), `${entry.name} is no longer read in ${entry.file}`).toMatch(
        entry.read,
      );
  });

  it('supplies every service with every variable it requires', () => {
    expect(missingRequiredEnv(COMPOSE_SOURCE)).toEqual([]);
  });

  it.each([
    ['api', 'OVO_TRUSTED_PROXY_CIDRS', '8b2cfdd'],
    ['gateway', 'OVO_SECRETS_MASTER_KEY', 'a6e1a2f'],
    ['api', 'OVO_WORKER_MAX_CAPACITY', 'b20ef08'],
  ])('would have caught %s missing %s (fixed in %s)', (service, name) => {
    expect(missingRequiredEnv(withoutVariable(service, name))).toEqual([`${service}: ${name}`]);
  });
});

describe('Compose SIP environment (Wave 11)', () => {
  const DATABASE = 'postgresql://ovo:secret@postgres:5432/ovo';

  it('keeps SIP off, and the sip-gateway on loopback, when the .env says nothing about it', () => {
    const variables = goLiveComposeVariables(DATABASE);
    for (const service of ['gateway', 'worker-1', 'worker-2'])
      expect(renderServiceEnv(service, variables).OVO_SIP_ENABLED, service).toBe('false');
    const sip = renderServiceEnv('sip-gateway', variables);
    expect(sip).toMatchObject({
      OVO_SIP_PUBLIC_ENABLED: 'false',
      OVO_SIP_PUBLIC_IP: '',
      OVO_SIP_CONTROL_LISTEN: '0.0.0.0:5090',
      OVO_SIP_CONTROL_SOURCE_CIDRS: '172.29.240.0/24',
      OVO_SIP_MEDIA_INTERNAL_URL: 'http://127.0.0.1:4001',
      OVO_SIP_HEALTH_LISTEN: '127.0.0.1:5091',
      OVO_SIP_TRUNKS_FILE: '/etc/ovo/sip-trunks.json',
    });
    expect(renderServiceEnv('worker-1', variables).OVO_SIP_CONTROL_URL).toBe(
      'http://172.29.240.1:5090',
    );
  });

  it('hands the sip-gateway the key the gateway verifies with and the token the workers send', () => {
    const variables = {
      ...goLiveComposeVariables(DATABASE),
      OVO_SIP_ENABLED: 'true',
      OVO_SIP_CONTROL_TOKEN: 'c'.repeat(64),
      OVO_SIP_GATEWAY_SECRET: Buffer.alloc(32, 7).toString('base64'),
      GATEWAY_PORT: '4101',
    };
    const sip = renderServiceEnv('sip-gateway', variables);
    const gateway = renderServiceEnv('gateway', variables);
    const workers = ['worker-1', 'worker-2'].map((name) => renderServiceEnv(name, variables));
    expect(gateway.OVO_SIP_ENABLED).toBe('true');
    expect(sip.OVO_SIP_GATEWAY_SECRET).toBe(variables.OVO_SIP_GATEWAY_SECRET);
    expect(gateway.OVO_SIP_GATEWAY_SECRET).toBe(sip.OVO_SIP_GATEWAY_SECRET);
    for (const worker of workers) {
      expect(worker.OVO_SIP_ENABLED).toBe('true');
      expect(worker.OVO_SIP_CONTROL_TOKEN).toBe(sip.OVO_SIP_CONTROL_TOKEN);
    }
    // Signatures cover the public URL, so both sides must agree on it; the hop itself is loopback.
    expect(sip.OVO_MEDIA_PUBLIC_BASE_URL).toBe(gateway.OVO_MEDIA_PUBLIC_BASE_URL);
    expect(sip.OVO_SIP_MEDIA_INTERNAL_URL).toBe('http://127.0.0.1:4101');
  });
});

describe('Compose routing environment (Wave 15)', () => {
  const DATABASE = 'postgresql://ovo:secret@postgres:5432/ovo';

  it('keeps routing and its external engine off when the .env says nothing about them', () => {
    const variables = goLiveComposeVariables(DATABASE);
    for (const service of ['api', 'gateway'])
      expect(renderServiceEnv(service, variables).OVO_ROUTING_ENABLED, service).toBe('false');
    for (const service of ['api', 'worker-1', 'worker-2'])
      expect(renderServiceEnv(service, variables).OVO_ROUTING_EXTERNAL_ENABLED, service).toBe(
        'false',
      );
    for (const service of ['worker-1', 'worker-2'])
      expect(renderServiceEnv(service, variables).OVO_ROUTING_PREPARE_TIMEOUT_MS, service).toBe('');
    // Wave 16: in-call transfer is off on every service that reads it.
    for (const service of ['api', 'worker-1', 'worker-2'])
      expect(renderServiceEnv(service, variables).OVO_ROUTING_TRANSFER_ENABLED, service).toBe(
        'false',
      );
    for (const service of ['gateway', 'dispatcher'])
      expect(renderServiceEnv(service, variables), service).not.toHaveProperty(
        'OVO_ROUTING_TRANSFER_ENABLED',
      );
    for (const service of ['dispatcher', 'worker-1'])
      expect(renderServiceEnv(service, variables), service).not.toHaveProperty(
        'OVO_ROUTING_ENABLED',
      );
  });

  it('hands the switch to the api and the gateway together, and the worker settings to both workers', () => {
    const variables = {
      ...goLiveComposeVariables(DATABASE),
      OVO_ROUTING_ENABLED: 'true',
      OVO_ROUTING_EXTERNAL_ENABLED: 'true',
      OVO_ROUTING_PREPARE_TIMEOUT_MS: '4000',
      OVO_ROUTING_TRANSFER_ENABLED: 'true',
    };
    expect(renderServiceEnv('api', variables).OVO_ROUTING_ENABLED).toBe('true');
    expect(renderServiceEnv('gateway', variables).OVO_ROUTING_ENABLED).toBe('true');
    expect(renderServiceEnv('api', variables).OVO_ROUTING_TRANSFER_ENABLED).toBe('true');
    for (const service of ['worker-1', 'worker-2'])
      expect(renderServiceEnv(service, variables)).toMatchObject({
        OVO_ROUTING_EXTERNAL_ENABLED: 'true',
        OVO_ROUTING_PREPARE_TIMEOUT_MS: '4000',
        OVO_ROUTING_TRANSFER_ENABLED: 'true',
      });
  });
});

describe('Compose human queue environment (Wave 17)', () => {
  const DATABASE = 'postgresql://ovo:secret@postgres:5432/ovo';

  it('keeps human queues and the room server off when the .env says nothing about them', () => {
    const variables = goLiveComposeVariables(DATABASE);
    for (const service of ['api', 'worker-1', 'worker-2', 'dispatcher'])
      expect(renderServiceEnv(service, variables).OVO_HUMAN_QUEUE_ENABLED, service).toBe('false');
    for (const service of ['api', 'worker-1', 'worker-2']) {
      const rendered = renderServiceEnv(service, variables);
      expect(rendered.OVO_HUMAN_QUEUE_WEBHOOK_ENABLED, service).toBe('false');
      expect(rendered.OVO_LIVEKIT_ENABLED, service).toBe('false');
      expect(rendered.OVO_LIVEKIT_URL, service).toBe('ws://172.29.240.1:7880');
    }
    expect(renderServiceEnv('worker-1', variables).OVO_HUMAN_QUEUE_CALLBACK_BASE_URL).toBe('');
  });

  it('hands the api and the workers the same key pair the room server is configured with', () => {
    const variables = {
      ...goLiveComposeVariables(DATABASE),
      OVO_LIVEKIT_ENABLED: 'true',
      OVO_LIVEKIT_API_KEY: 'ovoabc123def',
      OVO_LIVEKIT_API_SECRET: 's'.repeat(40),
      OVO_LIVEKIT_PUBLIC_URL: 'wss://rooms.example.com',
      OVO_HUMAN_QUEUE_ENABLED: 'true',
      OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS: '48',
    };
    const api = renderServiceEnv('api', variables);
    const workers = ['worker-1', 'worker-2'].map((name) => renderServiceEnv(name, variables));
    expect(api).toMatchObject({
      OVO_LIVEKIT_ENABLED: 'true',
      OVO_LIVEKIT_API_KEY: 'ovoabc123def',
      OVO_LIVEKIT_PUBLIC_URL: 'wss://rooms.example.com',
      OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS: '48',
    });
    for (const worker of workers) {
      expect(worker.OVO_LIVEKIT_API_SECRET).toBe(variables.OVO_LIVEKIT_API_SECRET);
      expect(worker.OVO_HUMAN_QUEUE_ENABLED).toBe('true');
      expect(worker).not.toHaveProperty('OVO_LIVEKIT_PUBLIC_URL');
    }
    expect(renderServiceEnv('dispatcher', variables).OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS).toBe(
      '48',
    );
    expect(renderServiceEnv('gateway', variables)).not.toHaveProperty('OVO_LIVEKIT_ENABLED');
  });
});
