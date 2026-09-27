import { beforeAll, afterAll, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Cap, type CarrierIngress, type InboundDecision } from '@winsendotai/ovo-contracts';
import { compose, type Composition } from '@winsendotai/ovo-runtime';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { loadDistribution } from '../../distribution/src/load.ts';
import { createFakeCarrierHostPorts } from '../../conformance/src/drivers/carrier-host-ports.ts';
const binding = {
  bindingId: 'b1',
  workspaceId: 'w1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  config: { accountSid: 'AC00000000000000000000000000000000' },
  secret: 'synthetic-token',
};
let graph: Composition, ingress: CarrierIngress;
beforeAll(async () => {
  const distribution = await loadDistribution({
    role: 'gateway',
    profile: 'compose',
    env: {},
    log() {},
  });
  const plugin = distribution.catalog.find((p) => p.manifest.id === binding.pluginId)!;
  graph = await compose([{ id: plugin.manifest.id }], [plugin], {
    scope: 'process',
    net: createFixtureNet([]),
  });
  ingress = graph.all(Cap.carrierIngress).get('twilio') as CarrierIngress;
  expect(ingress, 'the installed carrier must supply the ingress').toBeDefined();
});
afterAll(async () => {
  await graph?.dispose();
});
const sign = (url: string, fields: Record<string, string>) =>
  createHmac('sha1', binding.secret)
    .update(
      url +
        Object.keys(fields)
          .sort()
          .map((k) => k + fields[k])
          .join(''),
    )
    .digest('base64');
const inbound = {
  CallSid: 'CAfixture',
  AccountSid: binding.config.accountSid,
  From: '+15550123',
  To: '+15550456',
  Direction: 'inbound',
};
function request(
  host: ReturnType<typeof createFakeCarrierHostPorts>,
  purpose: 'inbound' | 'status' | 'amd' | 'resume',
  fields: Record<string, string>,
) {
  const externalUrl = host.callbackUrl(
    'twilio',
    'b1',
    purpose,
    purpose === 'inbound' ? undefined : { requestId: 'r1' },
  );
  return {
    method: 'POST' as const,
    bindingId: 'b1',
    externalUrl,
    query: Object.fromEntries(new URL(externalUrl).searchParams),
    headers: { 'x-twilio-signature': sign(externalUrl, fields) },
    rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
  };
}
function route(purpose: string) {
  return ingress.routes.find((r) => r.purpose === purpose)!;
}

it.each([undefined, '', 'wrong'])(
  'refuses missing/invalid signatures %s on every HTTP route before host mutation',
  async (signature) => {
    for (const purpose of ['inbound', 'status', 'amd', 'resume'] as const) {
      const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
      const req = request(host, purpose, inbound);
      expect(
        (
          await route(purpose).handle(
            { ...req, headers: signature === undefined ? {} : { 'X-Twilio-Signature': signature } },
            host,
          )
        ).status,
      ).toBe(403);
      expect(host.calls.filter((c) => c.method !== 'resolveBinding')).toEqual([]);
    }
  },
);
it.each([undefined, '', 'wrong'])(
  'refuses absent/invalid host URL secret %s for status, AMD and resume',
  async (token) => {
    for (const purpose of ['status', 'amd', 'resume'] as const) {
      const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
      const req = request(host, purpose, {
        CallSid: 'CAfixture',
        CallStatus: 'completed',
        SequenceNumber: '1',
        AnsweredBy: 'human',
      });
      req.query.t = token as string;
      expect((await route(purpose).handle(req, host)).status).toBe(403);
      expect(host.events).toEqual([]);
      expect(host.calls.some((c) => c.method === 'resumeStream')).toBe(false);
    }
  },
);
it.each([undefined, '', '1'])(
  'dispatches optional callback digits %s deliberately',
  async (digits) => {
    const host = createFakeCarrierHostPorts({
      bindings: { b1: binding },
      admitInbound: { kind: 'hangup' },
    });
    expect(
      (
        await route('inbound').handle(
          request(host, 'inbound', {
            ...inbound,
            ...(digits === undefined ? {} : { Digits: digits }),
          }),
          host,
        )
      ).status,
    ).toBe(200);
    expect(
      host.calls
        .filter((c) => ['admitInbound', 'confirmCallback'].includes(c.method))
        .map((c) => c.method),
    ).toEqual([digits ? 'confirmCallback' : 'admitInbound']);
  },
);
it.each(['CallSid', 'AccountSid', 'Direction', 'From', 'To'])(
  'refuses missing or oversized inbound %s',
  async (key) => {
    for (const value of [undefined, 'x'.repeat(257)]) {
      const fields = { ...inbound } as Record<string, string>;
      if (value === undefined) delete fields[key];
      else fields[key] = value;
      const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
      expect((await route('inbound').handle(request(host, 'inbound', fields), host)).status).toBe(
        400,
      );
      expect(host.calls.some((c) => c.method === 'admitInbound')).toBe(false);
    }
  },
);
it.each(['future', 'constructor', '__proto__'])(
  'refuses unknown status %s without applying an event',
  async (state) => {
    const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
    expect(
      (
        await route('status').handle(
          request(host, 'status', { CallSid: 'CAfixture', CallStatus: state, SequenceNumber: '1' }),
          host,
        )
      ).status,
    ).toBe(400);
    expect(host.events).toEqual([]);
  },
);
it('returns 400 for duplicate/invalid UTF-8 body fields and 413 for oversized bodies', async () => {
  const host = createFakeCarrierHostPorts({ bindings: { b1: binding } }),
    req = request(host, 'inbound', inbound);
  for (const [rawBody, status] of [
    [new TextEncoder().encode('CallSid=a&CallSid=b'), 400],
    [Uint8Array.of(255), 400],
    [new Uint8Array(65537), 413],
  ] as const)
    expect((await route('inbound').handle({ ...req, rawBody }, host)).status).toBe(status);
  expect(host.calls).toEqual([]);
});
it.each(['applied', 'duplicate', 'unmatched', 'correlation_conflict'] as const)(
  'preserves host event outcome %s',
  async (kind) => {
    const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
    const adapter = { ...host, applyCallEvent: async () => ({ kind }) };
    for (const purpose of ['status', 'amd'] as const)
      expect(
        (
          await route(purpose).handle(
            request(host, purpose, {
              CallSid: 'CAfixture',
              CallStatus: 'completed',
              SequenceNumber: '1',
              AnsweredBy: 'machine_start',
            }),
            adapter,
          )
        ).status,
      ).toBe(kind === 'unmatched' ? 404 : kind === 'correlation_conflict' ? 409 : 204);
  },
);
it('renders every admission decision including optional announcements and generated resume callbacks', async () => {
  const decisions: Array<[InboundDecision, string]> = [
    [
      {
        kind: 'connect',
        mediaUrl: 'wss://voice.example.test/media',
        routeParams: { sid: 's1', rt: 't1' },
      },
      '<Redirect method="POST">',
    ],
    [
      {
        kind: 'connect',
        mediaUrl: 'wss://voice.example.test/media',
        routeParams: { sid: 's1', rt: 't1' },
        resumeUrl: 'https://voice.example.test/resume',
      },
      'https://voice.example.test/resume',
    ],
    [
      { kind: 'wait', pauseSeconds: 0.1, retryUrl: 'https://voice.example.test/retry' },
      '<Pause length="1"/>',
    ],
    [
      {
        kind: 'wait',
        pauseSeconds: 2,
        retryUrl: 'https://voice.example.test/retry',
        announce: true,
        message: 'Wait & see',
      },
      '<Say>Wait &amp; see</Say>',
    ],
    [
      {
        kind: 'wait',
        pauseSeconds: 2,
        retryUrl: 'https://voice.example.test/retry',
        announce: false,
        message: 'MUST NOT SAY',
      },
      '<Pause length="2"/>',
    ],
    [
      {
        kind: 'callback-offer',
        digitsUrl: 'https://voice.example.test/digits',
        timeoutSeconds: 3.2,
        prompt: 'Press 1',
      },
      'timeout="4"',
    ],
    [{ kind: 'human', e164: '+15550123' }, '<Dial><Number>+15550123</Number></Dial>'],
    [
      { kind: 'human', e164: '+15550123', callerId: '+15550456', timeoutSeconds: 5, message: 'Hi' },
      '<Say>Hi</Say><Dial callerId="+15550456" timeout="5">',
    ],
    [{ kind: 'busy' }, '<Reject reason="busy"/>'],
    [{ kind: 'busy', message: 'Busy' }, '<Say>Busy</Say>'],
    [{ kind: 'reject', reason: 'not available' }, '<Reject/>'],
    [{ kind: 'hangup' }, '<Hangup/>'],
    [{ kind: 'hangup', message: 'Bye' }, '<Say>Bye</Say>'],
  ];
  for (const [admitInbound, expected] of decisions) {
    const host = createFakeCarrierHostPorts({ bindings: { b1: binding }, admitInbound });
    const result = await route('inbound').handle(request(host, 'inbound', inbound), host);
    expect(result.status).toBe(200);
    expect(result.body).toContain(expected);
    expect(result.body).not.toContain('MUST NOT SAY');
  }
});
it('resumes with a fresh grant, including an absent optional resume URL, and never revives an ended route', async () => {
  for (const resumeUrl of [undefined, 'https://voice.example.test/resume']) {
    const host = createFakeCarrierHostPorts({
      bindings: { b1: binding },
      resumeStream: {
        kind: 'stream',
        mediaUrl: 'wss://voice.example.test/media',
        routeParams: { sid: 's1', rt: 't1' },
        resumeUrl,
      },
    });
    const result = await route('resume').handle(
      request(host, 'resume', { CallSid: 'CAfixture' }),
      host,
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain('<Connect>');
    expect(result.body).toContain('<Redirect method="POST">');
  }
  const host = createFakeCarrierHostPorts({
    bindings: { b1: binding },
    resumeStream: { kind: 'ended' },
  });
  expect(
    (await route('resume').handle(request(host, 'resume', { CallSid: 'CAfixture' }), host)).body,
  ).toBe('<Response><Hangup/></Response>');
});

const start = (customParameters?: Record<string, string>) => ({
  event: 'start',
  sequenceNumber: '1',
  streamSid: 'MZ1',
  start: {
    accountSid: binding.config.accountSid,
    callSid: 'CAfixture',
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    customParameters,
  },
});
it('accepts v1 route aliases and rejects absent, empty, or contradictory route parameters', () => {
  expect(
    ingress.serializer
      .createSession({})
      .decode(JSON.stringify(start({ sessionId: 's1', routeToken: 'rt1' })))[0],
  ).toMatchObject({ routeParams: { sid: 's1', rt: 'rt1' } });
  for (const params of [
    undefined,
    {},
    { sid: 's1' },
    { sid: '', rt: 'rt1' },
    { sid: 's1', rt: 'rt1', sessionId: 'other' },
    { sid: 's1', rt: 'rt1', routeToken: 'other' },
  ])
    expect(() =>
      ingress.serializer
        .createSession({})
        .decode(JSON.stringify(start(params as Record<string, string> | undefined))),
    ).toThrow(/route parameters|string/);
});
it('rejects absent or invalid DTMF tracks/digits and noncanonical audio, without leaking a decoded event', () => {
  for (const dtmf of [
    { digit: '1' },
    { track: 'outbound_track', digit: '1' },
    { track: 'inbound_track', digit: '' },
    { track: 'inbound_track', digit: 'yes' },
  ]) {
    const codec = ingress.serializer.createSession({});
    codec.decode(JSON.stringify(start({ sid: 's1', rt: 'rt1' })));
    expect(() =>
      codec.decode(JSON.stringify({ event: 'dtmf', sequenceNumber: '2', streamSid: 'MZ1', dtmf })),
    ).toThrow('Invalid Twilio inbound DTMF');
  }
  for (const payload of ['!', 'AQ', 'AR==', 'AQ==\n']) {
    const codec = ingress.serializer.createSession({});
    codec.decode(JSON.stringify(start({ sid: 's1', rt: 'rt1' })));
    expect(() =>
      codec.decode(
        JSON.stringify({
          event: 'media',
          sequenceNumber: '2',
          streamSid: 'MZ1',
          media: { track: 'inbound', chunk: '1', timestamp: '0', payload },
        }),
      ),
    ).toThrow();
  }
});
it('refuses unstarted encoding, ignores outbound audio, and treats empty output/flush/terminate as empty frames', () => {
  const codec = ingress.serializer.createSession({});
  expect(() => codec.encode({ type: 'mark', name: 'x' })).toThrow('stream id is unavailable');
  codec.decode(JSON.stringify(start({ sid: 's1', rt: 'rt1' })));
  expect(
    codec.decode(
      JSON.stringify({
        event: 'media',
        sequenceNumber: '2',
        streamSid: 'MZ1',
        media: { track: 'outbound', chunk: '1', timestamp: '0', payload: 'AQ==' },
      }),
    ),
  ).toEqual([]);
  expect(codec.encode({ type: 'audio', payload: new Uint8Array() })).toEqual([]);
  expect(codec.flush()).toEqual([]);
  expect(codec.terminate!()).toEqual([]);
});
it('refuses absent, blank, negative, fractional and unsafe frame numbers', () => {
  for (const field of ['chunk', 'timestamp', 'sequenceNumber'])
    for (const value of [undefined, '', -1, 0.5, 'wat', 9007199254740992]) {
      const codec = ingress.serializer.createSession({});
      codec.decode(JSON.stringify(start({ sid: 's1', rt: 'rt1' })));
      const frame = {
        event: 'media',
        sequenceNumber: '2' as unknown,
        streamSid: 'MZ1',
        media: {
          track: 'inbound',
          chunk: '1' as unknown,
          timestamp: '0' as unknown,
          payload: 'AQ==',
        },
      };
      if (field === 'sequenceNumber') frame.sequenceNumber = value;
      else frame.media[field as 'chunk' | 'timestamp'] = value;
      expect(() => codec.decode(JSON.stringify(frame))).toThrow('must be a non-negative integer');
    }
});
