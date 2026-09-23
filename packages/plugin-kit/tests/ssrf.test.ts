import { describe, expect, it } from 'vitest';
import {
  ConnectorPolicyError,
  ExecutionPolicyError,
  assertPublicHost,
  isPublicAddress,
  parseIpv6,
} from '../src/index.ts';

const PRIVATE: readonly [string, string][] = [
  ['0.0.0.0', 'this network'],
  ['10.1.2.3', 'RFC 1918'],
  ['100.64.0.1', 'CGNAT'],
  ['127.0.0.1', 'loopback'],
  ['169.254.169.254', 'link-local metadata'],
  ['172.16.0.1', 'RFC 1918'],
  ['172.31.255.255', 'RFC 1918 edge'],
  ['192.0.0.8', 'IETF'],
  ['192.0.2.1', 'TEST-NET-1'],
  ['192.88.99.1', '6to4 relay anycast'],
  ['192.168.1.1', 'RFC 1918'],
  ['198.18.0.1', 'benchmarking'],
  ['198.51.100.7', 'TEST-NET-2'],
  ['203.0.113.9', 'TEST-NET-3'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['[::1]', 'bracketed loopback'],
  ['::127.0.0.1', 'IPv4-compatible loopback'],
  ['::10.0.0.1', 'IPv4-compatible private'],
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ['::ffff:7f00:1', 'IPv4-mapped loopback (hex)'],
  ['0:0:0:0:0:ffff:a9fe:a9fe', 'IPv4-mapped metadata (full form)'],
  ['::ffff:0:10.0.0.1', 'IPv4-translated private'],
  ['fc00::1', 'ULA'],
  ['fd12:3456::1', 'ULA'],
  ['fe80::1', 'link-local'],
  ['fe80::1%eth0', 'link-local with zone'],
  ['febf::1', 'link-local edge'],
  ['fec0::1', 'site-local'],
  ['feff::1', 'site-local edge'],
  ['ff02::1', 'multicast'],
  ['2001:db8::1', 'documentation'],
  ['2002:7f00:0001::1', '6to4 embedding 127.0.0.1'],
  ['2002:c0a8:0101::1', '6to4 embedding 192.168.1.1'],
  ['2001:0:4136:e378:8000:63bf:80ff:fffe', 'Teredo client 127.0.0.1 (obfuscated)'],
  ['2001:0:c0a8:0101:8000:63bf:3fff:fdd2', 'Teredo server 192.168.1.1'],
  ['64:ff9b::7f00:1', 'NAT64 embedding 127.0.0.1'],
  ['64:ff9b::10.0.0.1', 'NAT64 embedding 10.0.0.1'],
  ['64:ff9b:1::8.8.8.8', 'local-use NAT64'],
  ['100::1', 'discard-only'],
  ['2001:10::1', 'ORCHID'],
  ['2001:2::1', 'benchmarking'],
  ['3fff::1', 'documentation (RFC 9637)'],
  ['4000::1', 'outside global unicast'],
  ['010.0.0.1', 'octal-looking IPv4'],
  ['127.1', 'shorthand IPv4'],
  ['2130706433', 'decimal IPv4'],
  ['not-an-ip', 'garbage'],
  ['1::2::3', 'two compressions'],
];

const PUBLIC: readonly string[] = [
  '8.8.8.8',
  '1.1.1.1',
  '203.0.114.1',
  '172.32.0.1',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '[2001:4860:4860::8888]',
  '::ffff:8.8.8.8',
  '2002:0808:0808::1',
  '64:ff9b::8.8.8.8',
  '2001:0:0808:0808:8000:63bf:f7f7:f7f7',
];

describe('isPublicAddress (#24)', () => {
  it.each(PRIVATE)('rejects %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(PUBLIC)('accepts public %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('parses every IPv6 textual form to the same groups', () => {
    const groups = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1];
    expect(parseIpv6('::ffff:127.0.0.1')).toEqual(groups);
    expect(parseIpv6('0:0:0:0:0:FFFF:7F00:0001')).toEqual(groups);
    expect(parseIpv6('::FFFF:7f00:1')).toEqual(groups);
  });
});

describe('assertPublicHost', () => {
  const lookup = (answers: Record<string, string[]>) => async (host: string) =>
    (answers[host] ?? []).map(
      (address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const,
    );

  it('accepts a name that resolves only to public addresses', async () => {
    await expect(
      assertPublicHost('api.example.com', lookup({ 'api.example.com': ['8.8.8.8'] })),
    ).resolves.toHaveLength(1);
  });

  it.each([
    ['localhost', {}],
    ['svc.localhost', {}],
    ['rebind.example.com', { 'rebind.example.com': ['8.8.8.8', '10.0.0.5'] }],
    ['mapped.example.com', { 'mapped.example.com': ['::ffff:169.254.169.254'] }],
    ['empty.example.com', {}],
    ['127.0.0.1', {}],
    ['[fe80::1]', {}],
  ])('rejects %s with ConnectorPolicyError', async (host, answers) => {
    const error = await assertPublicHost(host, lookup(answers as Record<string, string[]>)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConnectorPolicyError);
    expect(error).toBeInstanceOf(ExecutionPolicyError);
  });
});
