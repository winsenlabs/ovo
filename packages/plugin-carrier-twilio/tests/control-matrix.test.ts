import { beforeAll, expect, it } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type CarrierControlFactory,
  type DialRequest,
  type HandoffTarget,
  type ResolvedBinding,
} from '@winsendotai/ovo-contracts';
import { compose, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { loadDistribution } from '../../distribution/src/load.ts';
import { withEgressSentinel } from '../../conformance/src/drivers/egress-sentinel.ts';

const binding: ResolvedBinding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  workspaceId: 'w1',
  config: { accountSid: 'AC00000000000000000000000000000000' },
  secret: 'synthetic-token',
};
const resume = 'https://voice.example.test/carriers/twilio/b1/resume?r=req-1&t=synthetic-token';
const request: DialRequest = {
  requestId: 'req-1',
  jobId: 'j1',
  to: '+15550123',
  from: '+15550456',
  media: {
    url: 'wss://voice.example.test/carriers/twilio/b1/media',
    routeParams: { sid: 's1', rt: 't1' },
    format: MULAW_8K,
  },
  callbacks: {
    status: 'https://voice.example.test/status',
    answer: 'https://voice.example.test/answer',
    resume,
  },
  maxDurationSec: 60,
};
let definition: PluginDefinition;
beforeAll(async () => {
  definition = (
    await loadDistribution({ role: 'gateway', profile: 'compose', env: {}, log() {} })
  ).catalog.find((plugin) => plugin.manifest.id === binding.pluginId)!;
});

async function run(
  method: 'dial' | 'handoff' | 'hangup' | 'reconcile' | 'none',
  status: number,
  body: unknown,
  test: (
    control: ReturnType<CarrierControlFactory['create']>,
    net: ReturnType<typeof createFixtureNet>,
  ) => Promise<void>,
  selected = binding,
) {
  await withEgressSentinel(async (sentinel) => {
    const net = createFixtureNet(
      method === 'none'
        ? []
        : [
            {
              host: 'api.twilio.com',
              source: 'https://www.twilio.com/docs/voice/api/call-resource',
              retrieved: '2026-09-22',
              steps: [
                {
                  expect: 'http',
                  method: method === 'reconcile' ? 'GET' : 'POST',
                  url: `https://api.twilio.com/2010-04-01/Accounts/${binding.config.accountSid}/Calls${method === 'dial' ? '' : '/CAfixture'}.json`,
                  ...(method === 'reconcile' ? {} : { body: 'form' as const }),
                  reply: { status, body: typeof body === 'string' ? body : JSON.stringify(body) },
                },
              ],
            },
          ],
    );
    const graph = await compose([{ id: definition.manifest.id }], [definition], {
      scope: 'process',
      net,
    });
    try {
      await test(
        (graph.all(Cap.carrierControl).get('twilio') as CarrierControlFactory).create(selected),
        net,
      );
      net.assertComplete();
      expect(sentinel.attempts).toEqual([]);
    } finally {
      await graph.dispose();
    }
  });
}

it.each([
  undefined,
  { mode: 'off' as const },
  { mode: 'detect' as const },
  { mode: 'hangup-on-machine' as const },
])('handles AMD absence/off/enabled and omitted timeout: %j', async (amd) => {
  await run('dial', 201, { sid: 'CAfixture' }, async (control, net) => {
    expect(
      await control.dial({
        ...request,
        amd,
        callbacks: { ...request.callbacks, amd: 'https://voice.example.test/amd' },
      }),
    ).toMatchObject({ kind: 'accepted' });
    const form = new URLSearchParams(net.log[0]!.data as string);
    expect(form.get('Timeout')).toBe('60');
    expect(form.get('MachineDetection')).toBe(
      amd && amd.mode !== 'off' ? 'DetectMessageEnd' : null,
    );
    expect(form.get('AsyncAmdStatusCallback')).toBe(
      amd && amd.mode !== 'off' ? 'https://voice.example.test/amd' : null,
    );
  });
});
it('refuses enabled AMD without its callback and a missing resume without touching NetPort', async () => {
  await run('none', 200, {}, async (control) => {
    expect(await control.dial({ ...request, amd: { mode: 'detect' } })).toMatchObject({
      kind: 'rejected',
      reason: 'Twilio AMD callback is missing',
      retryable: false,
    });
    expect(
      await control.dial({ ...request, callbacks: { ...request.callbacks, resume: undefined } }),
    ).toMatchObject({
      kind: 'rejected',
      reason: 'Twilio continuation needs resumeUrl',
      retryable: false,
    });
  });
});
it.each([400, 401, 408, 429, 500, 503])('classifies dial and handoff HTTP %s', async (status) => {
  for (const method of ['dial', 'handoff'] as const)
    await run(method, status, { code: 123 }, async (control) => {
      const outcome =
        method === 'dial'
          ? await control.dial(request)
          : await control.handoff('CAfixture', { kind: 'end', message: 'done' }, 'h1');
      expect(outcome).toMatchObject(
        status === 408 || status >= 500
          ? { kind: 'unknown' }
          : { kind: 'rejected', retryable: status === 429 },
      );
    });
});
it.each([{}, { sid: '' }, null, [], 'not json'].map((value) => [value]))(
  'keeps malformed or missing REST receipts unknown: %j',
  async (body) => {
    for (const method of ['dial', 'handoff'] as const)
      await run(method, 200, body, async (control) => {
        expect(
          (method === 'dial'
            ? await control.dial(request)
            : await control.handoff('CAfixture', { kind: 'end', message: '' }, 'h1')
          ).kind,
        ).toBe('unknown');
      });
  },
);
it('keeps transport failures unknown or pending and never redials', async () => {
  await withEgressSentinel(async (sentinel) => {
    const fetch = async () => {
      throw new Error('fixture timeout after write');
    };
    const graph = await compose([{ id: definition.manifest.id }], [definition], {
      scope: 'process',
      net: {
        fetch,
        websocket() {
          throw new Error('unexpected socket');
        },
      },
    });
    try {
      const control = (graph.all(Cap.carrierControl).get('twilio') as CarrierControlFactory).create(
        binding,
      );
      expect(await control.dial(request)).toMatchObject({
        kind: 'unknown',
        reason: 'fixture timeout after write',
      });
      expect(await control.handoff('CAfixture', { kind: 'end', message: '' }, 'h1')).toMatchObject({
        kind: 'unknown',
      });
      expect(await control.reconcile({ requestId: 'r1', carrierCallId: 'CAfixture' })).toEqual({
        kind: 'pending',
      });
      await expect(control.hangup({ carrierCallId: 'CAfixture' })).rejects.toThrow(
        'fixture timeout',
      );
      expect(sentinel.attempts).toEqual([]);
    } finally {
      await graph.dispose();
    }
  });
});
it.each([
  undefined,
  '',
  'https://voice.example.test/resume',
  resume.replace('/b1/', '/foreign/'),
  resume.replace('https:', 'http:'),
  resume.replace('voice.', 'user:pass@voice.'),
  `${resume}#fragment`,
  resume.replace('&t=synthetic-token', ''),
])(
  'refuses absent/unsafe per-call resume callback %s even if binding hides a URL',
  async (resumeUrl) => {
    await run(
      'none',
      200,
      {},
      async (control) => {
        const target = { kind: 'resume' as const, resumeUrl };
        expect(await control.handoff('CAfixture', target, 'h1')).toMatchObject({
          kind: 'rejected',
          retryable: false,
        });
      },
      { ...binding, config: { ...binding.config, resumeUrl: resume } },
    );
  },
);
it('resumes with a host-built scoped authenticated callback and a schema-valid binding', async () => {
  await run('handoff', 200, { sid: 'CAfixture' }, async (control, net) => {
    const target = { kind: 'resume' as const, resumeUrl: resume };
    expect(await control.handoff('CAfixture', target, 'h1')).toEqual({
      kind: 'confirmed',
      receiptId: 'twilio:CAfixture:h1',
    });
    expect(Object.fromEntries(new URLSearchParams(net.log[0]!.data as string))).toEqual({
      Url: resume,
      Method: 'POST',
    });
  });
});
it.each([
  { kind: 'phone', e164: '' },
  { kind: 'phone', e164: '123' },
  { kind: 'queue', name: '' },
  { kind: 'queue', name: '\n' },
])('refuses invalid handoff target %j before REST', async (target) => {
  await run('none', 200, {}, async (control) =>
    expect(await control.handoff('CAfixture', target as HandoffTarget, 'h1')).toMatchObject({
      kind: 'rejected',
      retryable: false,
    }),
  );
});
it.each([undefined, 'bad'])(
  'refuses absent/invalid binding account %s before REST',
  async (accountSid) => {
    await run(
      'none',
      200,
      {},
      async (control) =>
        expect(await control.dial(request)).toMatchObject({
          kind: 'unknown',
          reason: 'Invalid Twilio accountSid binding',
        }),
      { ...binding, config: { accountSid } },
    );
  },
);
it.each([{}, { status: 'future' }, [], 'bad json'].map((value) => [value]))(
  'does not invent reconciliation state from %j',
  async (body) => {
    await run('reconcile', 200, body, async (control) =>
      expect(await control.reconcile({ requestId: 'r1', carrierCallId: 'CAfixture' })).toEqual({
        kind: 'pending',
      }),
    );
  },
);
it.each([
  [undefined, undefined],
  ['human', 'human'],
  ['machine_end_beep', 'machine'],
  ['machine', 'machine'],
  ['fax', 'unknown'],
  ['other', 'unknown'],
])('maps optional answering-machine evidence %s', async (answered_by, expected) => {
  await run('reconcile', 200, { status: 'completed', answered_by }, async (control) =>
    expect(await control.reconcile({ requestId: 'r1', carrierCallId: 'CAfixture' })).toEqual({
      kind: 'ended',
      state: 'completed',
      carrierCallId: 'CAfixture',
      ...(expected ? { answeredBy: expected } : {}),
    }),
  );
});
it('honors the already-ended error code independently of HTTP status and throws other hangup errors', async () => {
  await run('hangup', 400, { code: 20404 }, async (control) =>
    expect(await control.hangup({ carrierCallId: 'CAfixture' })).toBe('already_ended'),
  );
  await run('hangup', 500, {}, async (control) => {
    await expect(control.hangup({ carrierCallId: 'CAfixture' })).rejects.toThrow('Twilio HTTP 500');
  });
});

it('refuses incomplete, oversized, or invalid XML stream parameters before REST', async () => {
  for (const routeParams of [
    {},
    { sid: 's1' },
    { sid: '', rt: 'rt1' },
    { sid: 's1', rt: 'x'.repeat(498) },
    { sid: 's1', rt: 'bad\u0001' },
  ] as Record<string, string>[]) {
    await run('none', 200, {}, async (control) =>
      expect(
        await control.dial({ ...request, media: { ...request.media, routeParams } }),
      ).toMatchObject({ kind: 'rejected', retryable: false }),
    );
  }
});
it('preserves a valid 499-character parameter and XML-escapes values', async () => {
  await run('dial', 201, { sid: 'CAfixture' }, async (control, net) => {
    expect(
      await control.dial({
        ...request,
        media: {
          ...request.media,
          routeParams: { sid: 's1', rt: 't1', k: 'x'.repeat(498), quoted: '<&"\'' },
        },
      }),
    ).toMatchObject({ kind: 'accepted' });
    const markup = new URLSearchParams(net.log[0]!.data as string).get('Twiml')!;
    expect(markup).toContain(`name="k" value="${'x'.repeat(498)}"`);
    expect(markup).toContain('value="&lt;&amp;&quot;&apos;"');
  });
});
it('ends without a Say when the end message is empty', async () => {
  await run('handoff', 200, { sid: 'CAfixture' }, async (control, net) => {
    expect(await control.handoff('CAfixture', { kind: 'end', message: '' }, 'h1')).toMatchObject({
      kind: 'confirmed',
    });
    expect(new URLSearchParams(net.log[0]!.data as string).get('Twiml')).toBe(
      '<Response><Hangup/></Response>',
    );
  });
});
