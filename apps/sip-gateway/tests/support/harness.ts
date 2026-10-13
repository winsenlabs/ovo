import type { Logger } from '@winsendotai/ovo-contracts';
import { loadConfig, type GatewayConfig } from '../../src/config/env.ts';
import { parseTrunkFile } from '../../src/config/trunks.ts';
import type { SipTimers } from '../../src/sip/flow.ts';
import { startSipGateway, type RunningGateway } from '../../src/service.ts';
import { FakeMediaGateway, PUBLIC_BASE, type FakeGatewayOptions } from './fake-media-gateway.ts';

export const KEY = new Uint8Array(32).fill(9);
export const CONTROL_TOKEN = 'control-token-for-tests-0123456789';
export const HEALTH_TOKEN = 'health-token-for-tests';
export const DID = '+918000000001';
export const FROM = '+918000000002';

/** A loopback trunk; override any field per test. */
export function loopbackTrunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loop',
    carrierId: 'sip',
    bindingId: 'binding-1',
    transport: 'udp',
    signallingCidrs: ['127.0.0.1/32'],
    mediaCidrs: ['127.0.0.1/32'],
    codecs: ['PCMU', 'PCMA'],
    numberFormat: { country: 'IN' },
    forwardHeaders: ['X-Account'],
    inviteRatePerSecond: 50,
    maxConcurrent: 8,
    optionsPingSeconds: 0,
    inbound: { enabled: true, numbers: [DID] },
    outbound: { enabled: false, fromNumbers: [], auth: 'ip' },
    ...overrides,
  };
}

/** An RTP range unlikely to collide with a parallel test file (the pool skips busy ports anyway). */
export function rtpRange(size = 40): { min: number; max: number } {
  const min = 42_000 + 2 * Math.floor(Math.random() * 3_000);
  return { min, max: min + size - 1 };
}

export function testConfig(input: {
  mediaUrl: string;
  trunks?: Record<string, unknown>[];
  env?: Record<string, string>;
}): GatewayConfig {
  const rtp = rtpRange();
  const config = loadConfig(
    {
      OVO_SIP_TRANSPORTS: 'udp,tcp',
      OVO_SIP_RTP_PORT_MIN: String(rtp.min),
      OVO_SIP_RTP_PORT_MAX: String(rtp.max),
      OVO_SIP_CONTROL_LISTEN: '127.0.0.1:0',
      OVO_SIP_HEALTH_LISTEN: '127.0.0.1:0',
      OVO_SIP_CONTROL_TOKEN: CONTROL_TOKEN,
      OVO_SIP_GATEWAY_SECRET: Buffer.from(KEY).toString('base64'),
      OVO_SIP_MEDIA_INTERNAL_URL: input.mediaUrl,
      OVO_MEDIA_PUBLIC_BASE_URL: PUBLIC_BASE,
      OVO_PERMITTED_FROM_NUMBERS: FROM,
      OVO_HEALTH_TOKEN: HEALTH_TOKEN,
      ...input.env,
    },
    () => parseTrunkFile({ version: 1, trunks: input.trunks ?? [loopbackTrunk()] }),
  );
  // An ephemeral SIP port (the schema rightly refuses 0 in production).
  return { ...config, sipPort: Number(input.env?.OVO_SIP_PORT ?? 0) };
}

/** Records log lines instead of printing them; tests read `lines` for the PII checks. */
export function recordingLogger(
  lines: { level: string; event: string; fields?: unknown }[] = [],
): Logger {
  const at = (level: string) => (event: string, fields?: unknown) =>
    void lines.push({ level, event, fields });
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

export interface Harness {
  media: FakeMediaGateway;
  logs: { level: string; event: string; fields?: unknown }[];
  running: RunningGateway;
  sipPort: number;
  control(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/** The fake media gateway plus a sip-gateway on ephemeral loopback ports. */
export async function startHarness(
  options: {
    media?: Omit<FakeGatewayOptions, 'key'>;
    trunks?: Record<string, unknown>[];
    env?: Record<string, string>;
    /** Shrunk RFC 3261 timers, for a real-clock test that must outlast 64·T1. */
    timers?: SipTimers;
  } = {},
): Promise<Harness> {
  const media = new FakeMediaGateway({ key: KEY, ...options.media });
  await media.start();
  const config = testConfig({
    mediaUrl: media.url,
    ...(options.trunks ? { trunks: options.trunks } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  if (options.timers) config.timers = options.timers;
  const logs: Harness['logs'] = [];
  const running = await startSipGateway({ config, logger: recordingLogger(logs) });
  return {
    media,
    logs,
    running,
    sipPort: running.ports.sip,
    async control(method, path, body, token = CONTROL_TOKEN) {
      const response = await fetch(`http://127.0.0.1:${running.ports.control}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      await Promise.all([running.close(), media.stop()]);
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
