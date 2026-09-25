import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import { TwilioTelephonyControl } from './control.ts';

function required(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${key}`);
  return value;
}

export const twilioTelephonyPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-telephony-twilio',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: ['telephony.control', 'telephony.media-protocol'],
    configSchema: {
      type: 'object',
      required: ['accountSid', 'authToken'],
      properties: { accountSid: { type: 'string' }, authToken: { type: 'string' } },
      additionalProperties: false,
    },
    secretFields: ['accountSid', 'authToken'],
    ui: { label: 'Twilio Programmable Voice' },
  },
  (ctx: Context, config) => {
    ctx.provide(
      'telephony.control',
      new TwilioTelephonyControl({
        accountSid: required(config, 'accountSid'),
        authToken: required(config, 'authToken'),
      }),
    );
    ctx.provide(
      'telephony.media-protocol',
      Object.freeze({
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        channels: 1,
        inboundTrack: true,
        outboundTrack: false,
        mark: true,
        clear: true,
        playbackEvidence: 'carrier-buffer-complete-not-human-hearing',
      }),
    );
  },
);
