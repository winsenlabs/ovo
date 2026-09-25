import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InboundCarrierGateUnarmedError,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import {
  createTwilioInboundWebhookHandler,
  type TwilioInboundWebhookHandler,
} from '../src/inbound-webhook.ts';

const authToken = 'test-auth-token';
const externalUrl = 'https://voice.example.test/twilio/inbound';

function signature(values: Record<string, string>, url = externalUrl): string {
  const signed = Object.keys(values)
    .sort()
    .reduce((value, key) => value + key + values[key], url);
  return createHmac('sha1', authToken).update(signed).digest('base64');
}

async function listen(handler: TwilioInboundWebhookHandler): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function fakeOperations(
  admit: ReturnType<typeof vi.fn>,
  confirmCallback: ReturnType<typeof vi.fn> = vi.fn(),
): OperationsService {
  return {
    organizationId: 'one-org',
    inboundGateway: { admit, confirmCallback },
  } as unknown as OperationsService;
}

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((close) => close()));
});

describe('signed Twilio inbound webhook protocol', () => {
  const values = {
    AccountSid: `AC${'0'.repeat(32)}`,
    CallSid: `CA${'1'.repeat(32)}`,
    Direction: 'inbound',
    From: '+14155550101',
    To: '+14155550102',
  };

  it('accepts a valid signature and returns a media stream for the durable reservation', async () => {
    const admit = vi.fn().mockResolvedValue({
      kind: 'reserved',
      admissionId: 'admission-1',
      jobId: 'job-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      workerEndpoint: 'wss://worker.internal/session',
      releaseId: 'release-1',
      routeVersion: 4,
    });
    const handler = createTwilioInboundWebhookHandler({
      operations: fakeOperations(admit),
      accountSid: values.AccountSid,
      authToken,
      externalBaseUrl: 'https://voice.example.test',
      mediaStreamUrl: 'wss://media.example.test/twilio/media',
      routeTokenSecret: 'a'.repeat(32),
    });
    const server = await listen(handler);
    openServers.push(server.close);
    const response = await fetch(`${server.url}/twilio/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature(values),
      },
      body: new URLSearchParams(values),
    });
    expect(response.status).toBe(200);
    const twiml = await response.text();
    expect(twiml).toContain('<Connect><Stream url="wss://media.example.test/twilio/media">');
    expect(twiml).toContain('<Parameter name="sessionId" value="session-1"/>');
    expect(twiml).toContain('<Parameter name="routeToken"');
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        carrierCallId: values.CallSid,
        fromNumber: values.From,
        toNumber: values.To,
        handshakeTtlMs: 60_000,
        routeTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it('reports an unarmed admission service as configuration failure instead of caller busy', async () => {
    const admit = vi.fn().mockRejectedValue(new InboundCarrierGateUnarmedError());
    const handler = createTwilioInboundWebhookHandler({
      operations: fakeOperations(admit),
      accountSid: values.AccountSid,
      authToken,
      externalBaseUrl: 'https://voice.example.test',
      mediaStreamUrl: 'wss://media.example.test/twilio/media',
      routeTokenSecret: 'a'.repeat(32),
    });
    const server = await listen(handler);
    openServers.push(server.close);
    const response = await fetch(`${server.url}/twilio/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature(values),
      },
      body: new URLSearchParams(values),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Inbound carrier gate is not installed');
  });

  it('reports a durable carrier-configuration refusal without busy TwiML', async () => {
    const reason = 'inbound_carrier_configuration_env_unavailable';
    const admit = vi.fn().mockResolvedValue({ kind: 'busy', admissionId: 'admission-1', reason });
    const handler = createTwilioInboundWebhookHandler({
      operations: fakeOperations(admit),
      accountSid: values.AccountSid,
      authToken,
      externalBaseUrl: 'https://voice.example.test',
      mediaStreamUrl: 'wss://media.example.test/twilio/media',
      routeTokenSecret: 'a'.repeat(32),
    });
    const server = await listen(handler);
    openServers.push(server.close);
    const response = await fetch(`${server.url}/twilio/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature(values),
      },
      body: new URLSearchParams(values),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(reason);
  });

  it('rejects an invalid signature before durable admission', async () => {
    const admit = vi.fn();
    const handler = createTwilioInboundWebhookHandler({
      operations: fakeOperations(admit),
      accountSid: values.AccountSid,
      authToken,
      externalBaseUrl: 'https://voice.example.test',
      mediaStreamUrl: 'wss://media.example.test/twilio/media',
      routeTokenSecret: 'b'.repeat(32),
    });
    const server = await listen(handler);
    openServers.push(server.close);
    const response = await fetch(`${server.url}/twilio/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'invalid',
      },
      body: new URLSearchParams(values),
    });
    expect(response.status).toBe(403);
    expect(admit).not.toHaveBeenCalled();
  });

  it('renders truthful busy and human overflow TwiML', async () => {
    const admit = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'busy', admissionId: 'busy-1', reason: 'at_capacity' })
      .mockResolvedValueOnce({
        kind: 'human',
        admissionId: 'human-1',
        target: '+14155550999',
        announcement: 'Connecting',
      });
    const handler = createTwilioInboundWebhookHandler({
      operations: fakeOperations(admit),
      accountSid: values.AccountSid,
      authToken,
      externalBaseUrl: 'https://voice.example.test',
      mediaStreamUrl: 'wss://media.example.test/twilio/media',
      routeTokenSecret: 'c'.repeat(32),
    });
    const server = await listen(handler);
    openServers.push(server.close);
    const post = (callSid: string) => {
      const next = { ...values, CallSid: callSid };
      return fetch(`${server.url}/twilio/inbound`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(next),
        },
        body: new URLSearchParams(next),
      });
    };
    expect(await (await post(`CA${'2'.repeat(32)}`)).text()).toContain('<Reject reason="busy"/>');
    expect(await (await post(`CA${'3'.repeat(32)}`)).text()).toContain(
      '<Say>Connecting</Say><Dial><Number>+14155550999</Number></Dial>',
    );
  });

  it('renders signed bounded wait polls and can transition the same call to media', async () => {
    const admit = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'wait',
        admissionId: 'wait-1',
        announcement: 'Please wait',
        expiresAt: new Date(Date.now() + 30_000),
        pollAfterMs: 5_000,
      })
      .mockResolvedValueOnce({
        kind: 'reserved',
        admissionId: 'wait-1',
        jobId: 'job-wait',
        sessionId: 'session-wait',
        workerId: 'worker-wait',
        workerEndpoint: 'wss://worker.internal/session',
        releaseId: 'release-wait',
        routeVersion: 1,
      })
      .mockResolvedValueOnce({ kind: 'busy', admissionId: 'wait-2', reason: 'wait_expired' });
    const handler = createTwilioInboundWebhookHandler({
      operations: fakeOperations(admit),
      accountSid: values.AccountSid,
      authToken,
      externalBaseUrl: 'https://voice.example.test',
      mediaStreamUrl: 'wss://media.example.test/twilio/media',
      routeTokenSecret: 'd'.repeat(32),
    });
    const server = await listen(handler);
    openServers.push(server.close);
    const initial = await fetch(`${server.url}/twilio/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature(values),
      },
      body: new URLSearchParams(values),
    });
    expect(await initial.text()).toContain(
      '<Say>Please wait</Say><Pause length="5"/><Redirect method="POST">https://voice.example.test/twilio/inbound?stage=wait</Redirect>',
    );
    const pollUrl = `${externalUrl}?stage=wait`;
    const poll = () =>
      fetch(`${server.url}/twilio/inbound?stage=wait`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(values, pollUrl),
        },
        body: new URLSearchParams(values),
      });
    expect(await (await poll()).text()).toContain('session-wait');
    expect(await (await poll()).text()).toContain(
      '<Say>No agent became available. Please call again later.</Say><Hangup/>',
    );
  });

  it('collects callback consent only through an authenticated DTMF action', async () => {
    const admit = vi.fn().mockResolvedValue({
      kind: 'callback',
      admissionId: 'callback-1',
      state: 'prompt',
      announcement: 'We can call you back',
    });
    const confirmCallback = vi.fn().mockResolvedValue({
      kind: 'callback',
      admissionId: 'callback-1',
      state: 'queued',
      announcement: 'We can call you back',
      campaignId: 'campaign-1',
      contactId: 'contact-1',
      jobId: 'job-1',
    });
    const handler = createTwilioInboundWebhookHandler({
      operations: fakeOperations(admit, confirmCallback),
      accountSid: values.AccountSid,
      authToken,
      externalBaseUrl: 'https://voice.example.test',
      mediaStreamUrl: 'wss://media.example.test/twilio/media',
      routeTokenSecret: 'e'.repeat(32),
    });
    const server = await listen(handler);
    openServers.push(server.close);
    const initial = await fetch(`${server.url}/twilio/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature(values),
      },
      body: new URLSearchParams(values),
    });
    const prompt = await initial.text();
    expect(prompt).toContain(
      '<Gather action="https://voice.example.test/twilio/inbound?stage=callback"',
    );
    expect(prompt).toContain('Press 1 to request a callback.');

    const consent = { ...values, Digits: '1' };
    const actionUrl = `${externalUrl}?stage=callback`;
    const response = await fetch(`${server.url}/twilio/inbound?stage=callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature(consent, actionUrl),
      },
      body: new URLSearchParams(consent),
    });
    expect(await response.text()).toContain('Your callback request has been queued.');
    expect(confirmCallback).toHaveBeenCalledWith(
      expect.objectContaining({ carrierCallId: values.CallSid, digits: '1' }),
    );
    const rejected = await fetch(`${server.url}/twilio/inbound?stage=callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'invalid',
      },
      body: new URLSearchParams(consent),
    });
    expect(rejected.status).toBe(403);
    expect(confirmCallback).toHaveBeenCalledTimes(1);
  });
});
