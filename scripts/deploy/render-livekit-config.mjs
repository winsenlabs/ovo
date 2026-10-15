#!/usr/bin/env node
// Renders infra/compose/livekit.yaml from the Compose environment and infra/compose/livekit.yaml.template.
//   node scripts/deploy/render-livekit-config.mjs --env-file infra/compose/.env [--out PATH]
// Library: renderLivekitConfig(env, { template, loopbackInterface }). Fails with a message naming the
// variable when the room server cannot be configured safely; nothing is guessed.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_TEMPLATE = path.join(root, 'infra/compose/livekit.yaml.template');
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const KEY = /^[A-Za-z0-9_-]{4,64}$/;
const SECRET = /^[\x21-\x7e]{32,128}$/;

const quote = (value) => JSON.stringify(value);

function port(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`${name} must be a port from 1 to 65535`);
  return value;
}

function address(env, name, fallback) {
  const value = env[name]?.trim() || fallback;
  if (!IPV4.test(value)) throw new Error(`${name} must be an IPv4 address`);
  return value;
}

/** Parses a Compose `.env` file: KEY=VALUE lines, `#` comments, one optional pair of quotes. */
export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

export function renderLivekitConfig(env, options = {}) {
  const template = options.template ?? readFileSync(DEFAULT_TEMPLATE, 'utf8');
  const loopback = options.loopbackInterface ?? 'lo';
  const publicOn = env.OVO_LIVEKIT_PUBLIC_ENABLED === 'true';
  const signal = port(env, 'OVO_LIVEKIT_SIGNAL_PORT', 7880);
  const tcp = port(env, 'OVO_LIVEKIT_RTC_TCP_PORT', 7881);
  const udp = port(env, 'OVO_LIVEKIT_RTC_UDP_PORT', 7882);
  if (new Set([signal, tcp, udp]).size !== 3)
    throw new Error(
      'OVO_LIVEKIT_SIGNAL_PORT, OVO_LIVEKIT_RTC_TCP_PORT and OVO_LIVEKIT_RTC_UDP_PORT differ',
    );

  const key = env.OVO_LIVEKIT_API_KEY?.trim();
  const secret = env.OVO_LIVEKIT_API_SECRET?.trim();
  if (!key || !KEY.test(key))
    throw new Error('OVO_LIVEKIT_API_KEY is required: 4-64 letters, digits, - or _');
  if (!secret || !SECRET.test(secret))
    throw new Error('OVO_LIVEKIT_API_SECRET is required: 32-128 printable characters, no spaces');
  const previousKey = env.OVO_LIVEKIT_API_KEY_PREVIOUS?.trim();
  const previousSecret = env.OVO_LIVEKIT_API_SECRET_PREVIOUS?.trim();
  if (Boolean(previousKey) !== Boolean(previousSecret))
    throw new Error('OVO_LIVEKIT_API_KEY_PREVIOUS and OVO_LIVEKIT_API_SECRET_PREVIOUS go together');
  if (previousKey && (!KEY.test(previousKey) || !SECRET.test(previousSecret)))
    throw new Error('OVO_LIVEKIT_API_KEY_PREVIOUS / OVO_LIVEKIT_API_SECRET_PREVIOUS are malformed');
  if (previousKey === key)
    throw new Error('The previous LiveKit key must differ from the current one');

  const bridge = address(env, 'OVO_LIVEKIT_BRIDGE_IP', '172.29.240.1');
  let binds;
  let nodeIp;
  let interfaces = '';
  if (publicOn) {
    nodeIp = env.OVO_LIVEKIT_NODE_IP?.trim();
    if (!nodeIp)
      throw new Error(
        'OVO_LIVEKIT_NODE_IP (the static IP) is required when OVO_LIVEKIT_PUBLIC_ENABLED=true',
      );
    nodeIp = address(env, 'OVO_LIVEKIT_NODE_IP', nodeIp);
    const bind = address(env, 'OVO_LIVEKIT_BIND_IP', '0.0.0.0');
    binds = [...new Set([bind, '127.0.0.1', bridge])];
  } else {
    nodeIp = '127.0.0.1';
    binds = [...new Set(['127.0.0.1', bridge])];
    // ICE binds the loopback interface only: no media port is reachable from outside.
    interfaces = `  interfaces:\n    includes:\n      - ${loopback}`;
  }

  let turn = 'turn:\n  enabled: false';
  if (env.OVO_LIVEKIT_TURN_ENABLED === 'true') {
    if (!publicOn)
      throw new Error(
        'OVO_LIVEKIT_TURN_ENABLED needs OVO_LIVEKIT_PUBLIC_ENABLED=true: TURN is for remote operators',
      );
    const domain = env.OVO_LIVEKIT_TURN_DOMAIN?.trim();
    if (!domain || !HOSTNAME.test(domain))
      throw new Error('OVO_LIVEKIT_TURN_DOMAIN must be the TURN host name');
    const lines = [
      'turn:',
      '  enabled: true',
      `  domain: ${quote(domain)}`,
      `  udp_port: ${port(env, 'OVO_LIVEKIT_TURN_UDP_PORT', 3478)}`,
    ];
    const tls = env.OVO_LIVEKIT_TURN_TLS_PORT?.trim()
      ? port(env, 'OVO_LIVEKIT_TURN_TLS_PORT', 5349)
      : undefined;
    // TLS is terminated by the certificate the deployment provides in front of the server.
    if (tls !== undefined) lines.push(`  tls_port: ${tls}`, '  external_tls: true');
    turn = lines.join('\n');
  }

  const keys = [`  ${quote(key)}: ${quote(secret)}`];
  if (previousKey) keys.push(`  ${quote(previousKey)}: ${quote(previousSecret)}`);
  const values = {
    SIGNAL_PORT: String(signal),
    TCP_PORT: String(tcp),
    UDP_PORT: String(udp),
    NODE_IP: quote(nodeIp),
    BIND_ADDRESSES: binds.map((bind) => `  - ${quote(bind)}`).join('\n'),
    RTC_INTERFACES: interfaces,
    KEYS: keys.join('\n'),
    TURN: turn,
  };
  const rendered = template.replace(/__([A-Z_]+)__/g, (whole, name) => {
    if (!(name in values)) throw new Error(`Unknown template field ${whole}`);
    return values[name];
  });
  return rendered.replace(/\n{3,}/g, '\n\n');
}

// A symlinked checkout path (macOS /var -> /private/var) must still run the command.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  try {
    const envFile = arg('--env-file');
    const env = {
      ...(envFile ? parseEnvFile(readFileSync(envFile, 'utf8')) : {}),
      ...(args.includes('--process-env') ? process.env : {}),
    };
    const out = arg('--out') ?? path.join(root, 'infra/compose/livekit.yaml');
    writeFileSync(
      out,
      renderLivekitConfig(env, { loopbackInterface: arg('--loopback-interface') }),
      { mode: 0o600 },
    );
    console.log(`rendered ${path.relative(process.cwd(), out)}`);
  } catch (error) {
    console.error(`render-livekit-config: ${error.message}`);
    process.exit(2);
  }
}
