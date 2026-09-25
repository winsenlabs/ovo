import { describe, expect, it } from 'vitest';
import { createFakeCarrierHostPorts, loadJsonlFixture } from '@winsendotai/ovo-conformance';
import {
  MULAW_8K,
  type CarrierHttpRequest,
  type ResolvedBinding,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { plivoControl } from '../src/control.ts';
import { decodeExtraHeaders, encodeExtraHeaders } from '../src/extra-headers.ts';
import { streamMarkup } from '../src/markup.ts';
import { plivoRoutes } from '../src/routes.ts';
import { plivoSerializer } from '../src/serializer.ts';
import { signV3, verifyV3 } from '../src/signature.ts';
import { fixtures } from '../src/index.ts';

const binding: ResolvedBinding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-plivo',
  workspaceId: 'w1',
  config: { authId: 'AUTH1' },
  secret: 'plivo-test-token',
};
const host = () => createFakeCarrierHostPorts({ bindings: { b1: binding } });

function fixture(name: string) {
  return loadJsonlFixture(new URL(`./fixtures/${name}.jsonl`, import.meta.url));
}

function signedForm(
  purpose: 'answer' | 'status' | 'stream-status',
  form: Record<string, string>,
  requestId = 'dial-1',
): Promise<CarrierHttpRequest> {
  const url = host().callbackUrl('plivo', 'b1', purpose, { requestId });
  const nonce = `nonce-${purpose}`;
  return signV3(binding.secret, url, nonce, form).then((signature) => ({
    method: 'POST',
    externalUrl: url,
    query: Object.fromEntries(new URL(url).searchParams),
    headers: { 'X-Plivo-Signature-V3': signature, 'X-Plivo-Signature-V3-Nonce': nonce },
    rawBody: new TextEncoder().encode(new URLSearchParams(form).toString()),
    bindingId: 'b1',
  }));
}

describe('Plivo documented protocol', () => {
  it('uses the Stream XML attribute snapshot and bounded base32 extraHeaders', () => {
    const grant = {
      kind: 'stream' as const,
      mediaUrl: 'wss://voice.example.test/carriers/plivo/binding-1/media',
      routeParams: { sid: 'session', rt: 'route-token' },
      resumeUrl: 'https://voice.example.test/resume',
      statusUrl: 'https://voice.example.test/stream-status',
    };
    expect(streamMarkup(grant)).toBe(fixture('xml').lines[0]?.frame);
    expect(decodeExtraHeaders(encodeExtraHeaders(grant.routeParams))).toEqual(grant.routeParams);
    expect(() => encodeExtraHeaders({ sid: 's'.repeat(400), rt: 'token' })).toThrow(
      'exceed 512 bytes',
    );
    expect(() => encodeExtraHeaders({ 'sid!': 'bad' })).toThrow('alphanumeric');
  });

  it('keeps outbound base64 payloads at or below 16 KiB and maps playback evidence', () => {
    const session = plivoSerializer.createSession({});
    const start = fixture('frames').lines[0]?.frame;
    session.decode(JSON.stringify(start));
    const frames = session.encode({ type: 'audio', payload: new Uint8Array(25_001) });
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      const parsed = JSON.parse(frame) as { event: string; media: { payload: string } };
      expect(parsed.event).toBe('playAudio');
      expect(parsed.media.payload.length).toBeLessThanOrEqual(16_000);
    }
    expect(JSON.parse(session.encode({ type: 'mark', name: 'm1' })[0]!)).toMatchObject({
      event: 'checkpoint',
      name: 'm1',
    });
    expect(session.decode(JSON.stringify({ event: 'playedStream', name: 'm1' }))).toEqual([
      { type: 'played', name: 'm1' },
    ]);
    expect(JSON.parse(session.encode({ type: 'clear' })[0]!)).toMatchObject({
      event: 'clearAudio',
    });
    expect(session.decode(JSON.stringify({ event: 'clearedAudio' }))).toEqual([
      { type: 'cleared' },
    ]);
  });

  it('matches independent PHP-SDK-derived V3 GET, query POST, no-query POST and MA vectors', async () => {
    const vectors = fixture('v3').lines.map(
      (line) =>
        line.frame as {
          method: 'GET' | 'POST';
          url: string;
          nonce: string;
          params: Record<string, string>;
          signature: string;
        },
    );
    for (const vector of vectors) {
      expect(
        await signV3(binding.secret, vector.url, vector.nonce, vector.params, vector.method),
      ).toBe(vector.signature);
      expect(
        await verifyV3({
          token: binding.secret,
          url: vector.url,
          headers: {
            'X-Plivo-Signature-V3-Nonce': vector.nonce,
            'X-Plivo-Signature-Ma-V3': `invalid, ${vector.signature}`,
          },
          params: vector.params,
          method: vector.method,
        }),
      ).toBe(true);
      expect(
        await verifyV3({
          token: binding.secret,
          url: vector.url,
          headers: {
            'X-Plivo-Signature-V3-Nonce': `${vector.nonce}-changed`,
            'X-Plivo-Signature-V3': vector.signature,
          },
          params: vector.params,
          method: vector.method,
        }),
      ).toBe(false);
      expect(
        await verifyV3({
          token: binding.secret,
          url: `${vector.url}&tampered=1`,
          headers: {
            'X-Plivo-Signature-V3-Nonce': vector.nonce,
            'X-Plivo-Signature-V3': vector.signature,
          },
          params: vector.params,
          method: vector.method,
        }),
      ).toBe(false);
    }
  });

  it('uses request UUID only at dial, answer route then correlates CallUUID and RequestUUID', async () => {
    const ports = host();
    const answerUrl = ports.callbackUrl('plivo', 'b1', 'answer', { requestId: 'dial-1' });
    const net = createFixtureNet([
      {
        host: 'api.plivo.com',
        source: 'https://www.plivo.com/docs/voice/api/calls',
        retrieved: '2026-09-22',
        steps: [
          {
            expect: 'http',
            method: 'POST',
            url: 'https://api.plivo.com/v1/Account/AUTH1/Call/',
            body: 'json',
            where: {
              answer_url: answerUrl,
              answer_method: 'POST',
              time_limit: 600,
              machine_detection: 'true',
              machine_detection_time: 10_000,
            },
            reply: { status: 201, body: '{"request_uuid":"request-1"}' },
          },
        ],
      },
    ]);
    const control = plivoControl(net).create(binding);
    const result = await control.dial({
      requestId: 'dial-1',
      jobId: 'job-1',
      to: '+15550100',
      from: '+15550199',
      media: { url: ports.mediaUrl('plivo', 'b1'), routeParams: {}, format: MULAW_8K },
      callbacks: {
        answer: answerUrl,
        status: ports.callbackUrl('plivo', 'b1', 'status', { requestId: 'dial-1' }),
        amd: ports.callbackUrl('plivo', 'b1', 'amd', { requestId: 'dial-1' }),
      },
      amd: { mode: 'detect', timeoutMs: 20_000 },
      maxDurationSec: 600,
    });
    expect(result).toEqual({
      kind: 'accepted',
      requestId: 'dial-1',
      carrierRequestId: 'request-1',
    });
    expect(net.mismatches).toHaveLength(0);
    const request = await signedForm('answer', { CallUUID: 'call-1', RequestUUID: 'request-1' });
    const route = plivoRoutes().find((item) => item.purpose === 'answer')!;
    expect((await route.handle(request, ports)).body).toContain('<Stream');
    expect(ports.calls.find((call) => call.method === 'streamForDial')?.args).toMatchObject({
      dialRequestId: 'dial-1',
      carrierCallId: 'call-1',
      carrierRequestId: 'request-1',
    });
    expect(
      (
        await route.handle(
          request,
          createFakeCarrierHostPorts({
            bindings: { b1: binding },
            streamForDial: { kind: 'ended' },
          }),
        )
      ).body,
    ).toContain('<Hangup/>');
    const pendingNet = createFixtureNet([]);
    expect(
      await plivoControl(pendingNet)
        .create(binding)
        .reconcile({ requestId: 'dial-1', carrierRequestId: 'request-1' }),
    ).toEqual({ kind: 'pending' });
    expect(pendingNet.log).toHaveLength(0);
  });

  it('publishes the documented dial fixture for catalog consumers', async () => {
    const scripts = fixtures['@winsendotai/ovo-carrier-plivo'];
    expect(scripts?.[0]?.host).toBe('api.plivo.com');
    const net = createFixtureNet(scripts ?? []);
    const ports = host();
    const result = await plivoControl(net)
      .create(binding)
      .dial({
        requestId: 'dial-1',
        jobId: 'job-1',
        to: '+15550100',
        from: '+15550199',
        media: { url: ports.mediaUrl('plivo', 'b1'), routeParams: {}, format: MULAW_8K },
        callbacks: {
          answer: ports.callbackUrl('plivo', 'b1', 'answer', { requestId: 'dial-1' }),
          status: ports.callbackUrl('plivo', 'b1', 'status', { requestId: 'dial-1' }),
        },
        maxDurationSec: 600,
      });
    expect(result).toMatchObject({ kind: 'accepted', carrierRequestId: 'request-1' });
    expect(net.mismatches).toHaveLength(0);
  });

  it('looks up a live CallUUID before reading a documented terminal CDR', async () => {
    const net = createFixtureNet([
      {
        host: 'api.plivo.com',
        source: 'https://www.plivo.com/docs/voice/api/calls',
        retrieved: '2026-09-26',
        steps: [
          {
            expect: 'http',
            method: 'GET',
            url: 'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/?status=live',
            reply: { status: 404, body: '{}' },
          },
          {
            expect: 'http',
            method: 'GET',
            url: 'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/',
            reply: {
              status: 200,
              body: JSON.stringify({
                call_uuid: 'call-1',
                end_time: '2026-09-26 12:00:00',
                call_state: 'ANSWER',
                hangup_cause_name: 'No Answer',
              }),
            },
          },
        ],
      },
    ]);
    expect(
      await plivoControl(net)
        .create(binding)
        .reconcile({ requestId: 'dial-1', carrierRequestId: 'request-1', carrierCallId: 'call-1' }),
    ).toEqual({ kind: 'ended', carrierCallId: 'call-1', state: 'no_answer' });
    expect(net.mismatches).toHaveLength(0);
  });

  it('does not derive a terminal outcome from legacy call_state alone', async () => {
    const net = createFixtureNet([
      {
        host: 'api.plivo.com',
        source: 'https://www.plivo.com/docs/voice/api/calls',
        retrieved: '2026-09-26',
        steps: [
          {
            expect: 'http',
            method: 'GET',
            url: 'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/?status=live',
            reply: { status: 404, body: '{}' },
          },
          {
            expect: 'http',
            method: 'GET',
            url: 'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/',
            reply: {
              status: 200,
              body: JSON.stringify({ call_state: 'ANSWER', end_time: '2026-09-26 12:00:00' }),
            },
          },
        ],
      },
    ]);
    expect(
      await plivoControl(net)
        .create(binding)
        .reconcile({ requestId: 'dial-1', carrierRequestId: 'request-1', carrierCallId: 'call-1' }),
    ).toEqual({ kind: 'pending' });
    expect(net.mismatches).toHaveLength(0);
  });

  it('recognizes the documented started/stopped/failed stream-status events only after V3', async () => {
    const events: Record<string, string>[] = [];
    const route = plivoRoutes((event) => events.push(event)).find(
      (item) => item.purpose === 'stream-status',
    )!;
    const valid = await signedForm('stream-status', {
      Event: 'failed',
      CallUUID: 'call-1',
      StreamID: 'stream-1',
      StatusReason: 'disconnected',
    });
    expect((await route.handle(valid, host())).status).toBe(204);
    expect(events).toEqual([
      {
        event: 'plivo_stream_status',
        status: 'failed',
        carrierCallId: 'call-1',
        streamId: 'stream-1',
        reason: 'disconnected',
      },
    ]);
    expect((await route.handle({ ...valid, headers: {} }, host())).status).toBe(403);
    expect(events).toHaveLength(1);
  });

  it('does not confirm end handoff on an undocumented 200 DELETE response', async () => {
    const net = createFixtureNet([
      {
        host: 'api.plivo.com',
        source: 'https://www.plivo.com/docs/voice/api/calls',
        retrieved: '2026-09-26',
        steps: [
          {
            expect: 'http',
            method: 'DELETE',
            url: 'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/',
            reply: { status: 200, body: '{"message":"ambiguous"}' },
          },
        ],
      },
    ]);
    const result = await plivoControl(net)
      .create(binding)
      .handoff('call-1', { kind: 'end', message: 'goodbye' }, 'handoff-1');
    expect(result).toEqual({ kind: 'unknown', reason: 'Unexpected Plivo end status 200' });
    expect(net.mismatches).toHaveLength(0);
  });

  it('keeps status event identity distinct across signed request ids with the same body', async () => {
    const form = { CallUUID: 'call-1', RequestUUID: 'request-1', CallStatus: 'completed' };
    const route = plivoRoutes().find((item) => item.purpose === 'status')!;
    const ports = host();
    expect((await route.handle(await signedForm('status', form, 'dial-1'), ports)).status).toBe(
      204,
    );
    expect((await route.handle(await signedForm('status', form, 'dial-2'), ports)).status).toBe(
      204,
    );
    expect(ports.events).toHaveLength(2);
    expect(ports.events[0]?.dialRequestId).toBe('dial-1');
    expect(ports.events[1]?.dialRequestId).toBe('dial-2');
    expect(ports.events[0]?.eventId).not.toBe(ports.events[1]?.eventId);
  });
});
