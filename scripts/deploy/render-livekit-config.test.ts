import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnvFile, renderLivekitConfig } from './render-livekit-config.mjs';

const KEY = 'ovoabc123def';
const SECRET = 'a'.repeat(64);
const base = { OVO_LIVEKIT_API_KEY: KEY, OVO_LIVEKIT_API_SECRET: SECRET };

describe('render-livekit-config (dark by default)', () => {
  it('binds loopback and the compose bridge and offers only loopback ICE until public', () => {
    const text = renderLivekitConfig(base);
    expect(text).toContain('port: 7880\n');
    expect(text).toContain('bind_addresses:\n  - "127.0.0.1"\n  - "172.29.240.1"\n');
    expect(text).toContain('  tcp_port: 7881\n  # One UDP port (mux)');
    expect(text).toContain('  udp_port: 7882\n');
    expect(text).toContain('  use_external_ip: false\n  node_ip: "127.0.0.1"\n');
    expect(text).toContain('  interfaces:\n    includes:\n      - lo\n');
    expect(text).toContain('auto_create: false');
    expect(text).toContain(`keys:\n  "${KEY}": "${SECRET}"\n`);
    expect(text).toContain('turn:\n  enabled: false\n');
    expect(text).not.toMatch(/0\.0\.0\.0/);
    expect(text).not.toMatch(/__[A-Z_]+__/);
  });

  it('uses the loopback interface name of the host (lo0 on macOS) and a bridge address override', () => {
    const text = renderLivekitConfig(
      { ...base, OVO_LIVEKIT_BRIDGE_IP: '10.9.8.1' },
      { loopbackInterface: 'lo0' },
    );
    expect(text).toContain('      - lo0\n');
    expect(text).toContain('  - "10.9.8.1"\n');
    const same = renderLivekitConfig({ ...base, OVO_LIVEKIT_BRIDGE_IP: '127.0.0.1' });
    expect(same.match(/- "127\.0\.0\.1"/g)).toHaveLength(1);
  });

  it('goes public only with the flag, the static IP and a bind address', () => {
    const text = renderLivekitConfig({
      ...base,
      OVO_LIVEKIT_PUBLIC_ENABLED: 'true',
      OVO_LIVEKIT_NODE_IP: '203.0.113.7',
      OVO_LIVEKIT_BIND_IP: '203.0.113.7',
      OVO_LIVEKIT_SIGNAL_PORT: '7000',
      OVO_LIVEKIT_RTC_TCP_PORT: '7001',
      OVO_LIVEKIT_RTC_UDP_PORT: '7002',
    });
    expect(text).toContain('port: 7000\n');
    expect(text).toContain('  - "203.0.113.7"\n  - "127.0.0.1"\n  - "172.29.240.1"\n');
    expect(text).toContain('  node_ip: "203.0.113.7"\n');
    expect(text).not.toContain('interfaces:');
    const open = renderLivekitConfig({
      ...base,
      OVO_LIVEKIT_PUBLIC_ENABLED: 'true',
      OVO_LIVEKIT_NODE_IP: '203.0.113.7',
    });
    expect(open).toContain('  - "0.0.0.0"\n');
    // Only the exact string `true` opens anything.
    for (const flag of ['TRUE', '1', 'yes', ' true', ''])
      expect(
        renderLivekitConfig({
          ...base,
          OVO_LIVEKIT_PUBLIC_ENABLED: flag,
          OVO_LIVEKIT_NODE_IP: '203.0.113.7',
        }),
        flag,
      ).toContain('node_ip: "127.0.0.1"');
  });

  it('requires the static IP when public, and refuses TURN while not public', () => {
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_PUBLIC_ENABLED: 'true' })).toThrow(
      /OVO_LIVEKIT_NODE_IP/,
    );
    expect(() =>
      renderLivekitConfig({
        ...base,
        OVO_LIVEKIT_PUBLIC_ENABLED: 'true',
        OVO_LIVEKIT_NODE_IP: 'rooms.example.com',
      }),
    ).toThrow(/IPv4/);
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_TURN_ENABLED: 'true' })).toThrow(
      /needs OVO_LIVEKIT_PUBLIC_ENABLED/,
    );
  });

  it('renders embedded TURN with an external TLS terminator only when asked', () => {
    const pub = { ...base, OVO_LIVEKIT_PUBLIC_ENABLED: 'true', OVO_LIVEKIT_NODE_IP: '203.0.113.7' };
    const text = renderLivekitConfig({
      ...pub,
      OVO_LIVEKIT_TURN_ENABLED: 'true',
      OVO_LIVEKIT_TURN_DOMAIN: 'turn.example.com',
      OVO_LIVEKIT_TURN_TLS_PORT: '5349',
    });
    expect(text).toContain(
      'turn:\n  enabled: true\n  domain: "turn.example.com"\n  udp_port: 3478\n  tls_port: 5349\n  external_tls: true\n',
    );
    const noTls = renderLivekitConfig({
      ...pub,
      OVO_LIVEKIT_TURN_ENABLED: 'true',
      OVO_LIVEKIT_TURN_DOMAIN: 'turn.example.com',
      OVO_LIVEKIT_TURN_UDP_PORT: '3479',
    });
    expect(noTls).toContain('  udp_port: 3479\n');
    expect(noTls).not.toContain('tls_port');
    expect(() =>
      renderLivekitConfig({
        ...pub,
        OVO_LIVEKIT_TURN_ENABLED: 'true',
        OVO_LIVEKIT_TURN_DOMAIN: 'not a host',
      }),
    ).toThrow(/OVO_LIVEKIT_TURN_DOMAIN/);
    expect(() => renderLivekitConfig({ ...pub, OVO_LIVEKIT_TURN_ENABLED: 'true' })).toThrow(
      /OVO_LIVEKIT_TURN_DOMAIN/,
    );
  });

  it('accepts the previous key pair while rotating, and only as a pair', () => {
    const text = renderLivekitConfig({
      ...base,
      OVO_LIVEKIT_API_KEY_PREVIOUS: 'oldkey123',
      OVO_LIVEKIT_API_SECRET_PREVIOUS: 'b'.repeat(40),
    });
    expect(text).toContain(`  "${KEY}": "${SECRET}"\n  "oldkey123": "${'b'.repeat(40)}"\n`);
    expect(() =>
      renderLivekitConfig({ ...base, OVO_LIVEKIT_API_KEY_PREVIOUS: 'oldkey123' }),
    ).toThrow(/go together/);
    expect(() =>
      renderLivekitConfig({
        ...base,
        OVO_LIVEKIT_API_KEY_PREVIOUS: KEY,
        OVO_LIVEKIT_API_SECRET_PREVIOUS: 'b'.repeat(40),
      }),
    ).toThrow(/differ/);
    expect(() =>
      renderLivekitConfig({
        ...base,
        OVO_LIVEKIT_API_KEY_PREVIOUS: 'old key',
        OVO_LIVEKIT_API_SECRET_PREVIOUS: 'b'.repeat(40),
      }),
    ).toThrow(/malformed/);
  });

  it('refuses a missing, short or odd key pair and bad or clashing ports', () => {
    expect(() => renderLivekitConfig({})).toThrow(/OVO_LIVEKIT_API_KEY/);
    expect(() => renderLivekitConfig({ OVO_LIVEKIT_API_KEY: KEY })).toThrow(
      /OVO_LIVEKIT_API_SECRET/,
    );
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_API_SECRET: 'short' })).toThrow(
      /32-128/,
    );
    expect(() =>
      renderLivekitConfig({ ...base, OVO_LIVEKIT_API_SECRET: `${'a'.repeat(31)} ` }),
    ).toThrow(/OVO_LIVEKIT_API_SECRET/);
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_API_KEY: 'a b' })).toThrow(
      /OVO_LIVEKIT_API_KEY/,
    );
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_SIGNAL_PORT: '0' })).toThrow(/port/);
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_RTC_UDP_PORT: '70000' })).toThrow(
      /port/,
    );
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_RTC_UDP_PORT: '7880' })).toThrow(
      /differ/,
    );
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_BRIDGE_IP: 'bridge' })).toThrow(/IPv4/);
  });

  it('quotes values so a secret cannot add keys to the YAML', () => {
    const hostile = 'x'.repeat(40) + '"\nrtc: {bad: true}';
    expect(() => renderLivekitConfig({ ...base, OVO_LIVEKIT_API_SECRET: hostile })).toThrow();
    const tricky = `${'y'.repeat(32)}:#{}[],&*!|>'%@\``;
    const text = renderLivekitConfig({ ...base, OVO_LIVEKIT_API_SECRET: tricky });
    expect(text).toContain(`"${KEY}": ${JSON.stringify(tricky)}`);
  });

  it('never leaves a template field behind and refuses an unknown one', () => {
    expect(() => renderLivekitConfig(base, { template: 'port: __NOPE__' })).toThrow(/__NOPE__/);
  });

  it('parses a Compose env file', () => {
    expect(
      parseEnvFile(
        '# comment\nOVO_LIVEKIT_API_KEY=abc\nOVO_LIVEKIT_API_SECRET="quoted value"\n  SPACED = x\nEMPTY=\nbad line\n',
      ),
    ).toEqual({ OVO_LIVEKIT_API_KEY: 'abc', OVO_LIVEKIT_API_SECRET: 'quoted value', EMPTY: '' });
  });
});

describe('render-livekit-config command line', () => {
  const script = new URL('./render-livekit-config.mjs', import.meta.url).pathname;

  it('writes an owner-only file from an env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovo-lk-'));
    try {
      const envFile = join(dir, '.env');
      writeFileSync(envFile, `OVO_LIVEKIT_API_KEY=${KEY}\nOVO_LIVEKIT_API_SECRET=${SECRET}\n`);
      const out = join(dir, 'livekit.yaml');
      execFileSync('node', [script, '--env-file', envFile, '--out', out], { stdio: 'pipe' });
      expect(readFileSync(out, 'utf8')).toContain(`"${KEY}"`);
      expect(statSync(out).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with exit 2 and names the variable when the environment cannot be rendered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovo-lk-'));
    try {
      const envFile = join(dir, '.env');
      writeFileSync(envFile, 'OVO_LIVEKIT_PUBLIC_ENABLED=true\n');
      const result = spawnSync(
        'node',
        [script, '--env-file', envFile, '--out', join(dir, 'x.yaml')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('OVO_LIVEKIT_API_KEY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
