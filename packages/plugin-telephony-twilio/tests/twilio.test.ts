import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TwilioTelephonyControl,
  parseTwilioMediaMessage,
  twilioClear,
  twilioMark,
  validateTwilioSignature,
  type TwilioVoiceClient,
} from '../src/index.ts';

describe('Twilio media protocol', () => {
  it('parses the documented 8 kHz mu-law start and mark messages', () => {
    const start = parseTwilioMediaMessage(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid: 'MZ1',
        start: {
          accountSid: 'AC1',
          callSid: 'CA1',
          customParameters: { ovoJobId: 'job-1' },
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
      }),
    );
    expect(start).toMatchObject({
      type: 'start',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      callSid: 'CA1',
    });
    expect(
      parseTwilioMediaMessage(
        JSON.stringify({
          event: 'mark',
          sequenceNumber: '2',
          streamSid: 'MZ1',
          mark: { name: 'epoch-4-segment-2' },
        }),
      ),
    ).toMatchObject({ type: 'mark', name: 'epoch-4-segment-2' });
    expect(JSON.parse(twilioMark('MZ1', 'segment-1'))).toEqual({
      event: 'mark',
      streamSid: 'MZ1',
      mark: { name: 'segment-1' },
    });
    expect(JSON.parse(twilioClear('MZ1'))).toEqual({ event: 'clear', streamSid: 'MZ1' });
  });

  it('rejects an unsupported codec before accepting audio', () => {
    expect(() =>
      parseTwilioMediaMessage(
        JSON.stringify({
          event: 'start',
          sequenceNumber: '1',
          streamSid: 'MZ1',
          start: {
            accountSid: 'AC1',
            callSid: 'CA1',
            mediaFormat: { encoding: 'audio/opus', sampleRate: 48000, channels: 1 },
          },
        }),
      ),
    ).toThrow(/Unsupported Twilio media format/);
  });

  it('uses the Twilio SDK signature validator against the exact public URL', () => {
    const token = 'fixture-token-not-a-secret';
    const externalUrl = 'https://voice.example.test/media?session=123';
    const signature = createHmac('sha1', token).update(externalUrl).digest('base64');
    expect(validateTwilioSignature({ authToken: token, signature, externalUrl })).toBe(true);
    expect(
      validateTwilioSignature({
        authToken: token,
        signature,
        externalUrl: `${externalUrl}&tampered=1`,
      }),
    ).toBe(false);
  });
});

describe('Twilio call control (simulated client; no paid call)', () => {
  it('marks a network timeout unknown and reconciles by callback receipt without redial', async () => {
    let creates = 0;
    const fake: TwilioVoiceClient = {
      async createCall() {
        creates += 1;
        throw new Error('socket timed out after write');
      },
      async updateCall() {},
      async fetchCall(callSid) {
        return { sid: callSid, status: 'ringing' };
      },
    };
    const adapter = new TwilioTelephonyControl(
      { accountSid: 'ACfixture', authToken: 'fixture' },
      {
        async findCarrierCallId() {
          return 'CAaccepted';
        },
      },
      fake,
    );
    const result = await adapter.dial({
      requestId: 'request-1',
      jobId: 'job-1',
      workspaceId: 'ws-1',
      to: '+910000000001',
      from: '+910000000002',
      streamUrl: 'wss://voice.example.test/media',
      statusCallbackUrl: 'https://voice.example.test/status',
    });
    expect(result.kind).toBe('unknown');
    expect(await adapter.reconcile('request-1')).toEqual({
      kind: 'accepted',
      carrierCallId: 'CAaccepted',
    });
    expect(creates).toBe(1);
  });
});
