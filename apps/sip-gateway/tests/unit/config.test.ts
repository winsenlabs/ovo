import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.ts';
import { loadTrunkFile, parseTrunkFile, trunkForSource } from '../../src/config/trunks.ts';

const SECRET = Buffer.alloc(32, 7).toString('base64');

const TRUNK = {
  id: 'trunk-a',
  carrierId: 'sip',
  bindingId: 'b-1',
  transport: 'udp',
  signallingCidrs: ['198.51.100.0/28'],
  mediaCidrs: ['198.51.100.0/26'],
  codecs: ['PCMU', 'PCMA'],
  inbound: { enabled: true, numbers: ['+918000000000'] },
  outbound: {
    enabled: true,
    proxy: 'sip:198.51.100.2:5060',
    fromNumbers: ['+918000000000'],
    auth: 'ip',
  },
};

const ENV = {
  OVO_SIP_CONTROL_TOKEN: 'control-token-0123456789',
  OVO_SIP_GATEWAY_SECRET: SECRET,
  OVO_MEDIA_PUBLIC_BASE_URL: 'https://ovo.example.test',
};

const trunks = () => parseTrunkFile({ version: 1, trunks: [TRUNK] });

describe('environment (§11.1), fail closed', () => {
  it('applies the defaults and binds 127.0.0.1 while not public', () => {
    const config = loadConfig({ ...ENV, OVO_SIP_BIND_IP: '0.0.0.0' }, trunks);
    expect(config).toMatchObject({
      public: false,
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
      sipPort: 5060,
      transports: ['udp', 'tcp'],
      rtpPorts: { min: 40000, max: 40199 },
      maxCalls: 4,
      countryAllowlist: ['+91'],
      control: { host: '127.0.0.1', port: 5090, sourceCidrs: ['172.29.240.0/24'] },
      mediaInternalUrl: 'http://127.0.0.1:4001',
      drainTimeoutMs: 240_000,
      health: { host: '127.0.0.1', port: 5091, token: '' },
      inboundWaitMaxMs: 45_000,
      referTimeoutMs: 15_000,
    });
    expect(config.keys.current.byteLength).toBe(32);
  });

  it('binds OVO_SIP_BIND_IP and advertises OVO_SIP_PUBLIC_IP only when public', () => {
    const config = loadConfig(
      {
        ...ENV,
        OVO_SIP_PUBLIC_ENABLED: 'true',
        OVO_SIP_BIND_IP: '0.0.0.0',
        OVO_SIP_PUBLIC_IP: '203.0.113.10',
      },
      trunks,
    );
    expect(config).toMatchObject({
      public: true,
      bindHost: '0.0.0.0',
      advertisedHost: '203.0.113.10',
    });
  });

  it.each([
    ['no control token', { OVO_SIP_CONTROL_TOKEN: undefined }, 'OVO_SIP_CONTROL_TOKEN'],
    ['a short control token', { OVO_SIP_CONTROL_TOKEN: 'short' }, 'at least 16'],
    ['no gateway secret', { OVO_SIP_GATEWAY_SECRET: undefined }, 'OVO_SIP_GATEWAY_SECRET'],
    [
      'a short gateway secret',
      { OVO_SIP_GATEWAY_SECRET: Buffer.alloc(16).toString('base64') },
      '32 bytes',
    ],
    ['an http public base URL', { OVO_MEDIA_PUBLIC_BASE_URL: 'http://ovo.example.test' }, 'https'],
    ['public without a public IP', { OVO_SIP_PUBLIC_ENABLED: 'true' }, 'OVO_SIP_PUBLIC_IP'],
    ['a bad port', { OVO_SIP_PORT: '70000' }, 'OVO_SIP_PORT'],
    ['an unknown transport', { OVO_SIP_TRANSPORTS: 'udp,tls' }, 'OVO_SIP_TRANSPORTS'],
    [
      'an RTP range without a pair',
      { OVO_SIP_RTP_PORT_MIN: '40000', OVO_SIP_RTP_PORT_MAX: '40000' },
      'RTP',
    ],
    ['a bad listen address', { OVO_SIP_CONTROL_LISTEN: 'localhost:5090' }, 'ipv4:port'],
    ['a bad control CIDR', { OVO_SIP_CONTROL_SOURCE_CIDRS: '172.29.240.0/33' }, 'CIDR'],
    ['a bad country prefix', { OVO_SIP_COUNTRY_ALLOWLIST: '91' }, 'OVO_SIP_COUNTRY_ALLOWLIST'],
    ['a bad boolean', { OVO_SIP_PUBLIC_ENABLED: 'yes' }, 'OVO_SIP_PUBLIC_ENABLED'],
  ])('refuses %s', (_name, change, message) => {
    expect(() => loadConfig({ ...ENV, ...change }, trunks)).toThrow(message);
  });

  it('refuses to boot without a readable, valid trunk file', () => {
    expect(() =>
      loadConfig({ ...ENV, OVO_SIP_TRUNKS_FILE: '/nonexistent/sip-trunks.json' }),
    ).toThrow('Cannot read the trunk file');
    const dir = mkdtempSync(join(tmpdir(), 'sip-trunks-'));
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(() => loadTrunkFile(join(dir, 'bad.json'))).toThrow('not JSON');
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ version: 1, trunks: [TRUNK] }));
    expect(loadConfig({ ...ENV, OVO_SIP_TRUNKS_FILE: join(dir, 'ok.json') }).trunks[0]!.id).toBe(
      'trunk-a',
    );
  });
});

describe('OVO_SIP_REFER_TIMEOUT_MS', () => {
  it.each([
    ['2000', 2_000],
    ['60000', 60_000],
    ['', 15_000],
  ])('reads %j as %i', (value, expected) => {
    expect(loadConfig({ ...ENV, OVO_SIP_REFER_TIMEOUT_MS: value }, trunks).referTimeoutMs).toBe(
      expected,
    );
  });

  it.each(['1999', '60001', 'abc', '1.5', '-1'])('refuses %j', (value) => {
    expect(() => loadConfig({ ...ENV, OVO_SIP_REFER_TIMEOUT_MS: value }, trunks)).toThrow(
      'OVO_SIP_REFER_TIMEOUT_MS',
    );
  });
});

describe('trunk refer block (R3)', () => {
  const refer = (block: unknown) =>
    parseTrunkFile({ version: 1, trunks: [{ ...TRUNK, refer: block }] })[0]!.refer;

  it('is off by default: absent means disabled with an empty allow-list', () => {
    expect(trunks()[0]!.refer).toEqual({ enabled: false, allowedHosts: [] });
    expect(refer({})).toEqual({ enabled: false, allowedHosts: [] });
  });

  it('accepts a template and allow-list, lower-casing hosts', () => {
    expect(
      refer({
        enabled: true,
        phoneUriTemplate: 'sips:{e164}@SBC.example.net;user=phone',
        allowedHosts: ['.ACD.example.net', 'Transfer.example.net', '203.0.113.7'],
      }),
    ).toEqual({
      enabled: true,
      phoneUriTemplate: 'sips:{e164}@SBC.example.net;user=phone',
      allowedHosts: ['.acd.example.net', 'transfer.example.net', '203.0.113.7'],
    });
  });

  it.each([
    ['enabled with nothing to dial', { enabled: true }],
    ['a template without {e164}', { phoneUriTemplate: 'sip:agent@sbc.example.net' }],
    ['a template with {e164} twice', { phoneUriTemplate: 'sip:{e164}@sbc.example.net;x={e164}' }],
    ['a template that is not a sip URI', { phoneUriTemplate: 'tel:{e164}' }],
    ['a template with a host-less URI', { phoneUriTemplate: 'sip:{e164}' }],
    [
      'a template with {e164} outside the user part',
      { phoneUriTemplate: 'sip:x{e164}@sbc.example.net' },
    ],
    ['a template carrying headers', { phoneUriTemplate: 'sip:{e164}@sbc.example.net?X-A=1' }],
    ['a template with whitespace', { phoneUriTemplate: 'sip:{e164}@sbc.example.net ;user=phone' }],
    ['a host with a path', { allowedHosts: ['acd.example.net/x'] }],
    ['a host with an empty label', { allowedHosts: ['acd..example.net'] }],
    ['a wildcard host', { allowedHosts: ['*.example.net'] }],
    ['an unknown key', { enabled: false, bridge: true }],
  ])('refuses %s', (_name, block) => {
    expect(() => refer(block)).toThrow('Invalid trunk file');
  });
});

describe('trunk file (§11.2)', () => {
  const withTrunk = (change: Record<string, unknown>) => () =>
    parseTrunkFile({ version: 1, trunks: [{ ...TRUNK, ...change }] });

  it.each([
    ['a bad id', { id: 'Trunk A' }],
    ['a bad CIDR', { signallingCidrs: ['198.51.100.0/40'] }],
    ['no signalling CIDR', { signallingCidrs: [] }],
    ['an unknown codec', { codecs: ['G729'] }],
    ['a non-E.164 inbound number', { inbound: { enabled: true, numbers: ['08000000000'] } }],
    ['outbound without a proxy', { outbound: { enabled: true, fromNumbers: [] } }],
    ['a proxy outside signallingCidrs', { outbound: { enabled: true, proxy: 'sip:192.0.2.1' } }],
    ['an unknown auth', { outbound: { enabled: false, auth: 'tls' } }],
    ['an unknown key', { vendor: 'x' }],
    ['a non-X forwarded header', { forwardHeaders: ['Authorization'] }],
  ])('refuses %s', (_name, change) => {
    expect(withTrunk(change)).toThrow('Invalid trunk file');
  });

  it('refuses duplicate ids and a wrong version', () => {
    expect(() => parseTrunkFile({ version: 1, trunks: [TRUNK, TRUNK] })).toThrow('unique');
    expect(() => parseTrunkFile({ version: 2, trunks: [TRUNK] })).toThrow('Invalid trunk file');
  });

  it('finds the trunk of a source address, v4-mapped included', () => {
    const [trunk] = trunks();
    expect(trunkForSource([trunk!], '198.51.100.3')?.id).toBe('trunk-a');
    expect(trunkForSource([trunk!], '::ffff:198.51.100.3')?.id).toBe('trunk-a');
    expect(trunkForSource([trunk!], '198.51.100.99')).toBeUndefined();
  });
});

describe('the shipped example trunk file', () => {
  it('parses: an operator who copies it gets past validation, not a startup refusal', () => {
    const example = JSON.parse(
      readFileSync(
        new URL('../../../../infra/compose/sip-trunks.example.json', import.meta.url),
        'utf8',
      ),
    );
    expect(parseTrunkFile(example).map((trunk) => trunk.carrierId)).toEqual(['tcn', 'sip']);
  });
});
