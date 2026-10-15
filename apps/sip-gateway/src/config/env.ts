import { isIPv4 } from 'node:net';
import { decodeSipSecret } from '@winsendotai/ovo-sip-carrier-kit';
import { z } from 'zod';
import { DEFAULT_TIMERS, type SipTimers } from '../sip/flow.ts';
import { blockListOf, loadTrunkFile, parseCidr, type Trunk } from './trunks.ts';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) =>
      value === undefined || value === '' ? fallback : value === 'true' || value === '1',
    );
const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return fallback;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `expected an integer in [${min}, ${max}]` });
        return z.NEVER;
      }
      return parsed;
    });
const listen = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = value || fallback;
      const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(raw);
      if (!match || !isIPv4(match[1]!) || Number(match[2]) > 65535) {
        ctx.addIssue({ code: 'custom', message: 'expected ipv4:port' });
        return z.NEVER;
      }
      return { host: match[1]!, port: Number(match[2]) };
    });
const required = (what: string) =>
  z.string({ error: `${what} is required` }).min(1, `${what} is required`);

/** Every variable the sip-gateway reads (W11 §11.1). Parsing fails closed at boot. */
const EnvSchema = z.object({
  OVO_SIP_PUBLIC_ENABLED: bool(false),
  OVO_SIP_BIND_IP: z.string().optional().default('0.0.0.0'),
  OVO_SIP_PUBLIC_IP: z.string().optional().default(''),
  OVO_SIP_PORT: int(5060, 1, 65535),
  OVO_SIP_TRANSPORTS: z
    .string()
    .optional()
    .default('udp,tcp')
    .transform((value) => [
      ...new Set(
        value
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.enum(['udp', 'tcp'])).min(1)),
  OVO_SIP_RTP_PORT_MIN: int(40000, 1024, 65534),
  OVO_SIP_RTP_PORT_MAX: int(40199, 1025, 65535),
  OVO_SIP_TRUNKS_FILE: z.string().optional().default('/etc/ovo/sip-trunks.json'),
  OVO_SIP_MAX_CALLS: int(4, 1, 1000),
  OVO_SIP_COUNTRY_ALLOWLIST: z
    .string()
    .optional()
    .default('+91')
    .transform((value) =>
      value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^\+\d{1,6}$/)).min(1)),
  OVO_SIP_CONTROL_LISTEN: listen('127.0.0.1:5090'),
  OVO_SIP_CONTROL_SOURCE_CIDRS: z
    .string()
    .optional()
    .default('172.29.240.0/24')
    .transform((value) =>
      value
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  OVO_SIP_CONTROL_TOKEN: required('OVO_SIP_CONTROL_TOKEN').min(
    16,
    'OVO_SIP_CONTROL_TOKEN must be at least 16 characters',
  ),
  OVO_SIP_GATEWAY_SECRET: required('OVO_SIP_GATEWAY_SECRET'),
  OVO_SIP_MEDIA_INTERNAL_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .default('http://127.0.0.1:4001'),
  OVO_MEDIA_PUBLIC_BASE_URL: z.url({
    protocol: /^https$/,
    error: 'OVO_MEDIA_PUBLIC_BASE_URL must be an https URL',
  }),
  OVO_PERMITTED_FROM_NUMBERS: z
    .string()
    .optional()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  OVO_SIP_DRAIN_TIMEOUT_MS: int(240_000, 0, 3_600_000),
  OVO_SIP_HEALTH_LISTEN: listen('127.0.0.1:5091'),
  OVO_SIP_INBOUND_WAIT_MAX_MS: int(45_000, 0, 600_000),
  OVO_SIP_REFER_TIMEOUT_MS: int(15_000, 2_000, 60_000),
  OVO_SIP_BRIDGE_ENABLED: bool(false),
  OVO_HEALTH_TOKEN: z.string().optional().default(''),
});

export interface GatewayConfig {
  public: boolean;
  /** Where SIP and RTP sockets bind: 127.0.0.1 unless OVO_SIP_PUBLIC_ENABLED. */
  bindHost: string;
  /** What Via, Contact and SDP advertise. */
  advertisedHost: string;
  sipPort: number;
  transports: ('udp' | 'tcp')[];
  rtpPorts: { min: number; max: number };
  trunks: Trunk[];
  maxCalls: number;
  countryAllowlist: string[];
  control: { host: string; port: number; token: string; sourceCidrs: string[] };
  /** The ovo-sip/1 signing key (the media gateway's verifier also accepts the previous one). */
  keys: { current: Uint8Array };
  mediaInternalUrl: string;
  publicBaseUrl: string;
  permittedFromNumbers: string[];
  drainTimeoutMs: number;
  health: { host: string; port: number; token: string };
  inboundWaitMaxMs: number;
  /** REFER sent to its final sipfrag NOTIFY. */
  referTimeoutMs: number;
  /** Stretch S1: lets a trunk with `refer.mode: bridge` relay a handoff instead of sending REFER. */
  bridgeEnabled: boolean;
  /** RFC 3261 T1/T2/T4; fixed in production, overridable in tests. */
  timers: SipTimers;
}

/** Validates the environment and the trunk file; any problem is one thrown, readable error. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  readTrunks: (path: string) => Trunk[] = loadTrunkFile,
): GatewayConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success)
    throw new TypeError(
      `Invalid sip-gateway environment: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ')}`,
    );
  const e = parsed.data;
  if (e.OVO_SIP_RTP_PORT_MAX - e.OVO_SIP_RTP_PORT_MIN < 1)
    throw new TypeError('OVO_SIP_RTP_PORT_MAX must leave room for at least one RTP/RTCP pair');
  if (e.OVO_SIP_PUBLIC_ENABLED) {
    if (!isIPv4(e.OVO_SIP_PUBLIC_IP))
      throw new TypeError('OVO_SIP_PUBLIC_ENABLED=true needs OVO_SIP_PUBLIC_IP (IPv4)');
    if (!isIPv4(e.OVO_SIP_BIND_IP)) throw new TypeError('OVO_SIP_BIND_IP must be IPv4');
  }
  for (const value of e.OVO_SIP_CONTROL_SOURCE_CIDRS) parseCidr(value);
  blockListOf(e.OVO_SIP_CONTROL_SOURCE_CIDRS);
  const bindHost = e.OVO_SIP_PUBLIC_ENABLED ? e.OVO_SIP_BIND_IP : '127.0.0.1';
  return {
    public: e.OVO_SIP_PUBLIC_ENABLED,
    bindHost,
    advertisedHost: e.OVO_SIP_PUBLIC_ENABLED ? e.OVO_SIP_PUBLIC_IP : bindHost,
    sipPort: e.OVO_SIP_PORT,
    transports: e.OVO_SIP_TRANSPORTS,
    rtpPorts: { min: e.OVO_SIP_RTP_PORT_MIN, max: e.OVO_SIP_RTP_PORT_MAX },
    trunks: readTrunks(e.OVO_SIP_TRUNKS_FILE),
    maxCalls: e.OVO_SIP_MAX_CALLS,
    countryAllowlist: e.OVO_SIP_COUNTRY_ALLOWLIST,
    control: {
      ...e.OVO_SIP_CONTROL_LISTEN,
      token: e.OVO_SIP_CONTROL_TOKEN,
      sourceCidrs: e.OVO_SIP_CONTROL_SOURCE_CIDRS,
    },
    keys: { current: decodeSipSecret(e.OVO_SIP_GATEWAY_SECRET) },
    mediaInternalUrl: e.OVO_SIP_MEDIA_INTERNAL_URL,
    publicBaseUrl: e.OVO_MEDIA_PUBLIC_BASE_URL,
    permittedFromNumbers: e.OVO_PERMITTED_FROM_NUMBERS,
    drainTimeoutMs: e.OVO_SIP_DRAIN_TIMEOUT_MS,
    health: { ...e.OVO_SIP_HEALTH_LISTEN, token: e.OVO_HEALTH_TOKEN },
    inboundWaitMaxMs: e.OVO_SIP_INBOUND_WAIT_MAX_MS,
    referTimeoutMs: e.OVO_SIP_REFER_TIMEOUT_MS,
    bridgeEnabled: e.OVO_SIP_BRIDGE_ENABLED,
    timers: DEFAULT_TIMERS,
  };
}
