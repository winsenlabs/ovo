import { createHmac } from 'node:crypto';
import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import {
  fixtures,
  TwilioTelephonyControl,
  twilioControlFactory,
  twilioIngress,
  twilioMediaSerializer,
} from '../src/index.ts';

const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  workspaceId: 'w1',
  config: { accountSid: 'AC00000000000000000000000000000000' },
  secret: 'fixture-token',
};
const streamUrl = 'wss://voice.example.test:8443/carriers/twilio/b1/media';
const events = ['initiated', 'ringing', 'answered', 'completed'];
// Independent oracle: the documented HMAC recipe, without the implementation's URL handling.
const sign = (url: string, fields: Record<string, string> = {}) =>
  createHmac('sha1', binding.secret)
    .update(
      url +
        Object.keys(fields)
          .sort()
          .map((key) => key + fields[key])
          .join(''),
    )
    .digest('base64');

describe('Twilio documented HTTP wire rules', () => {
  // Call REST's statusCallbackEvent array is encoded as repeated form parameters.
  // https://www.twilio.com/docs/voice/api/call-resource (retrieved 2026-09-26)
  it.each(['v2', 'legacy'] as const)(
    'sends four separate callback event fields via %s',
    async (version) => {
      const net = createFixtureNet(fixtures['twilio.dial']!);
      const callback = 'https://voice.example.test/carriers/twilio/b1/status';
      const common = { requestId: 'r1', jobId: 'j1', to: '+15550123', from: '+15550456' };
      const result =
        version === 'v2'
          ? await twilioControlFactory(net)
              .create(binding)
              .dial({
                ...common,
                media: { url: streamUrl, routeParams: { sid: 's1', rt: 't1' }, format: MULAW_8K },
                callbacks: { status: callback, answer: callback, resume: callback },
                maxDurationSec: 60,
              })
          : await new TwilioTelephonyControl(
              { accountSid: binding.config.accountSid, authToken: binding.secret },
              undefined,
              undefined,
              net,
            ).dial({ ...common, streamUrl, statusCallbackUrl: callback });
      expect(result.kind).toBe('accepted');
      net.assertComplete();
      const body = new URLSearchParams(net.log[0]!.data as string);
      expect(body.getAll('StatusCallbackEvent')).toEqual(events);
    },
  );

  // The installed Twilio SDK accepts signatures with or without the HTTPS port.
  // WSS retains its separate exact-URL rule.
  it.each([false, true])(
    'validates HTTPS callback with port included in signature: %s',
    async (includePort) => {
      const host = createFakeCarrierHostPorts({
        bindings: { b1: binding },
        admitInbound: { kind: 'hangup' },
      });
      const url = 'https://voice.example.test:8443/carriers/twilio/b1/inbound?x=%2f+%20&x=%2F';
      const fields = {
        CallSid: 'CAfixture',
        AccountSid: binding.config.accountSid,
        From: '+15550123',
        To: '+15550456',
        Direction: 'inbound',
      };
      const result = await twilioIngress.routes
        .find((route) => route.purpose === 'inbound')!
        .handle(
          {
            method: 'POST',
            externalUrl: url,
            bindingId: 'b1',
            query: Object.fromEntries(new URL(url).searchParams),
            rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
            headers: {
              'x-twilio-signature': sign(includePort ? url : url.replace(':8443', ''), fields),
            },
          },
          host,
        );
      expect(result.status).toBe(200);
      expect(host.calls.filter((entry) => entry.method === 'admitInbound')).toHaveLength(1);
    },
  );

  it('rejects a query-bearing WSS URL even with its exact valid HMAC', async () => {
    const url = `${streamUrl}?edge=1`;
    expect(
      await twilioMediaSerializer.authenticateUpgrade(
        {
          url: new URL(url),
          externalUrl: url,
          headers: { 'x-twilio-signature': sign(url) },
        },
        { bindingId: 'b1', resolveBinding: async () => binding, verifyUrlSecret: () => false },
      ),
    ).toEqual({ ok: false, status: 403 });
  });

  it('preserves the exact WSS port and trailing-slash retry', async () => {
    const context = {
      bindingId: 'b1',
      resolveBinding: async () => binding,
      verifyUrlSecret: () => false,
    };
    for (const signedUrl of [streamUrl, `${streamUrl}/`]) {
      expect(
        await twilioMediaSerializer.authenticateUpgrade(
          {
            url: new URL(streamUrl),
            externalUrl: streamUrl,
            headers: { 'x-twilio-signature': sign(signedUrl) },
          },
          context,
        ),
      ).toMatchObject({ ok: true });
    }
    for (const signedUrl of [streamUrl.replace(':8443', ''), streamUrl.replace('8443', '8444')]) {
      expect(
        await twilioMediaSerializer.authenticateUpgrade(
          {
            url: new URL(streamUrl),
            externalUrl: streamUrl,
            headers: { 'x-twilio-signature': sign(signedUrl) },
          },
          context,
        ),
      ).toEqual({ ok: false, status: 403 });
    }
  });
});
