import { describe, expect, it } from 'vitest';
import { FALLBACK, INBOUND, NUMBER, STATUS } from './fake-stack.ts';

type Result = { id: string; status: 'pass' | 'fail' | 'warn' | 'skip'; message: string };
type Snapshot = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const checks = {
  ...((await import('../live-checks.mjs' as string)) as {
    evaluateLive(snapshot: Snapshot): Result[];
  }),
  ...((await import('../live-collect.mjs' as string)) as {
    redactSnapshot(snapshot: Snapshot): Snapshot;
    parseEnvLines(text: string): Record<string, string>;
  }),
};
const switching = (await import('../live-switch.mjs' as string)) as {
  planLiveSwitch(
    direction: 'on' | 'off',
    current: Snapshot,
    targets: Snapshot,
  ): Record<string, string>;
  classifyNumber(current: Snapshot, targets: Snapshot): string;
};

const worker = {
  OVO_LIVE_DIAL_ENABLED: 'true',
  OVO_INBOUND_CAPACITY_ENABLED: 'true',
  OVO_TRANSPORT_CERTIFIED: 'true',
};

function liveSnapshot(): Snapshot {
  return {
    mode: 'full',
    apiEnv: {
      OVO_ALLOW_LOCAL_HTTP: 'false',
      OVO_LIVE_DIAL_ENABLED: 'true',
      OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.ovo.test',
    },
    serviceEnv: {
      gateway: { OVO_LIVE_DIAL_ENABLED: 'true', OVO_INBOUND_ENABLED: 'true' },
      dispatcher: { OVO_LIVE_DIAL_ENABLED: 'true', OVO_INBOUND_ENABLED: 'true' },
      'worker-1': worker,
      'worker-2': worker,
    },
    workers: { 'worker-1': { state: 'ready' }, 'worker-2': { state: 'active' } },
    dispatcher: { inbound: { ready: true, readyProtected: 1, reasons: [] } },
    capacity: { readyProtected: 1 },
    publicHealth: { status: 200, body: { ready: true } },
    upgrade: { status: 403 },
    routes: [
      { phoneNumber: NUMBER, releaseId: 'rel-1', enabled: true, carrierBindingId: 'bind-1' },
    ],
    releases: { 'rel-1': { agentId: 'agent-1', liveReady: true, liveBlockers: [] } },
    carrierUrls: { 'bind-1': { inbound: INBOUND, status: STATUS } },
    twilio: {
      number: NUMBER,
      fallbackUrl: FALLBACK,
      current: { voiceUrl: INBOUND, statusCallback: STATUS, voiceFallbackUrl: FALLBACK },
    },
  };
}

const failed = (snapshot: Snapshot) =>
  checks.evaluateLive(snapshot).filter((result) => result.status === 'fail');
const byId = (snapshot: Snapshot, id: string) =>
  checks.evaluateLive(snapshot).find((result) => result.id === id)!;

describe('evaluateLive (OPS-7)', () => {
  it('passes a stack that will answer the number', () => {
    expect(failed(liveSnapshot())).toEqual([]);
  });

  it.each([
    ['local-http-off', (s: Snapshot) => (s.apiEnv.OVO_ALLOW_LOCAL_HTTP = 'true'), 'must set false'],
    [
      'public-base-url',
      (s: Snapshot) => (s.apiEnv.OVO_MEDIA_PUBLIC_BASE_URL = 'https://voice.invalid'),
      'placeholder',
    ],
    [
      'public-base-url',
      (s: Snapshot) => (s.apiEnv.OVO_MEDIA_PUBLIC_BASE_URL = 'http://voice.ovo.test'),
      'https',
    ],
    [
      'live-flags',
      (s: Snapshot) => (s.serviceEnv['worker-2'] = { ...worker, OVO_TRANSPORT_CERTIFIED: 'false' }),
      'worker-2 OVO_TRANSPORT_CERTIFIED=false',
    ],
    [
      'live-flags',
      (s: Snapshot) => (s.serviceEnv.gateway.OVO_INBOUND_ENABLED = 'false'),
      'gateway OVO_INBOUND_ENABLED',
    ],
    [
      'public-tls',
      (s: Snapshot) => (s.publicHealth = { error: 'CERT_HAS_EXPIRED' }),
      'certificate',
    ],
    ['public-tls', (s: Snapshot) => (s.publicHealth = { status: 404, body: null }), 'Caddyfile'],
    [
      'wss-upgrade',
      (s: Snapshot) => (s.upgrade = { status: 426 }),
      'does not pass WebSocket upgrades',
    ],
    ['wss-upgrade', (s: Snapshot) => (s.upgrade = { status: 404 }), 'plain HTTP'],
    [
      'workers',
      (s: Snapshot) => (s.workers['worker-1'] = { state: 'dial-disabled' }),
      'worker-1=dial-disabled',
    ],
    [
      'protected-capacity',
      (s: Snapshot) => {
        s.dispatcher.inbound = {
          ready: false,
          readyProtected: 0,
          reasons: ['OVO_INBOUND_ENABLED=false'],
        };
        s.capacity.readyProtected = 0;
      },
      'OVO_INBOUND_ENABLED=false',
    ],
    ['routes', (s: Snapshot) => (s.routes = []), 'no enabled inbound route'],
    [
      'releases-live-ready',
      (s: Snapshot) =>
        (s.releases['rel-1'] = { liveReady: false, liveBlockers: ['No TTS binding'] }),
      'No TTS binding',
    ],
    [
      'carrier-number',
      (s: Snapshot) => (s.twilio.current.voiceUrl = FALLBACK),
      'fallback (live is off)',
    ],
    [
      'carrier-number',
      (s: Snapshot) => (s.twilio.current.statusCallback = 'https://old.example/status'),
      'status callback',
    ],
    [
      'carrier-number',
      (s: Snapshot) => (s.twilio.current = { error: 'Twilio number lookup returned 401' }),
      '401',
    ],
  ])('fails %s when it would not answer (%#)', (id, breakIt, message) => {
    const snapshot = liveSnapshot();
    breakIt(snapshot);
    const result = byId(snapshot, id);
    expect(result.status).toBe('fail');
    expect(result.message).toContain(message);
  });

  it('warns, without failing, when every worker is busy or the fallback is missing', () => {
    const snapshot = liveSnapshot();
    snapshot.workers['worker-1'] = { state: 'active' };
    snapshot.twilio.current.voiceFallbackUrl = null;
    expect(failed(snapshot)).toEqual([]);
    expect(byId(snapshot, 'workers').status).toBe('warn');
    expect(byId(snapshot, 'carrier-fallback').status).toBe('warn');
  });

  it('skips the carrier comparison before the switch and without carrier credentials', () => {
    const before = liveSnapshot();
    before.mode = 'pre-switch';
    before.twilio.current.voiceUrl = FALLBACK;
    expect(byId(before, 'carrier-number').status).toBe('skip');
    const unconfigured = liveSnapshot();
    delete unconfigured.twilio.current;
    expect(byId(unconfigured, 'carrier-number').status).toBe('skip');
  });

  it('redacts carrier URL tokens in a saved snapshot and still evaluates the same', () => {
    const redacted = checks.redactSnapshot(liveSnapshot());
    expect(JSON.stringify(redacted)).not.toContain('secret-');
    expect(failed(redacted)).toEqual([]);
    redacted.twilio.current.voiceUrl = checks.redactSnapshot({
      carrierUrls: { x: { inbound: `${INBOUND}x` } },
    }).carrierUrls.x.inbound;
    expect(byId(redacted, 'carrier-number').status).toBe('fail');
  });

  it('reads printenv output', () => {
    expect(checks.parseEnvLines('A=1\nB=\nC=x=y\n')).toEqual({ A: '1', B: '', C: 'x=y' });
  });
});

describe('planLiveSwitch (OPS-8)', () => {
  const targets = { targets: { inbound: INBOUND, status: STATUS }, fallbackUrl: FALLBACK };
  const fallbackNumber = {
    voiceUrl: FALLBACK,
    voiceMethod: 'POST',
    statusCallback: STATUS,
    statusCallbackMethod: 'POST',
  };

  it('points the number, its status callback and its fallback at the stack', () => {
    expect(switching.planLiveSwitch('on', fallbackNumber, targets)).toEqual({
      voiceUrl: INBOUND,
      voiceFallbackUrl: FALLBACK,
      voiceFallbackMethod: 'POST',
    });
  });

  it('switches off by changing only the Voice URL, keeping status callbacks on the stack', () => {
    const live = { ...fallbackNumber, voiceUrl: INBOUND };
    expect(switching.planLiveSwitch('off', live, targets)).toEqual({ voiceUrl: FALLBACK });
    expect(switching.planLiveSwitch('off', fallbackNumber, targets)).toEqual({});
  });

  it('refuses to switch without somewhere to send the calls', () => {
    expect(() => switching.planLiveSwitch('on', fallbackNumber, { fallbackUrl: FALLBACK })).toThrow(
      /voiceUrl/,
    );
    expect(() => switching.planLiveSwitch('off', fallbackNumber, {})).toThrow(/voiceUrl/);
  });

  it('classifies where the number points', () => {
    expect(switching.classifyNumber({ voiceUrl: INBOUND }, targets)).toBe('stack');
    expect(switching.classifyNumber({ voiceUrl: FALLBACK }, targets)).toBe('fallback');
    expect(switching.classifyNumber({ voiceUrl: 'https://elsewhere.example' }, targets)).toBe(
      'other',
    );
  });
});
