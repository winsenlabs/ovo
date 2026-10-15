import { describe, expect, it } from 'vitest';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import type { HandoffTarget } from '@winsendotai/ovo-contracts';
import { twilioCapabilities } from '../src/capabilities.ts';
import { fixtures, twilioControlFactory } from '../src/index.ts';
import { handoffMarkup } from '../src/markup.ts';

const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  workspaceId: 'w1',
  config: { accountSid: 'AC00000000000000000000000000000000' },
  secret: 'synthetic-token',
};
const sip = (uri: string, headers?: Record<string, string>): HandoffTarget => ({
  kind: 'sip',
  uri,
  ...(headers ? { headers } : {}),
});

describe('Twilio <Dial><Sip> handoff markup', () => {
  it('declares sip next to the other handoff kinds', () => {
    expect(twilioCapabilities.control.handoff).toContain('sip');
  });

  it('dials a bare sip or sips URI', () => {
    expect(handoffMarkup(sip('sip:agent@acd.example.net'))).toBe(
      '<Response><Dial><Sip>sip:agent@acd.example.net</Sip></Dial></Response>',
    );
    expect(handoffMarkup(sip('SIPS:agent@acd.example.net;transport=tls'))).toContain(
      '<Sip>SIPS:agent@acd.example.net;transport=tls</Sip>',
    );
  });

  it.each(['tel:+15550123', 'http://acd.example.net', 'sip:', 'agent@acd.example.net', ''])(
    'refuses the scheme or shape %j',
    (uri) => expect(() => handoffMarkup(sip(uri))).toThrow('Invalid handoff SIP URI'),
  );

  it.each([
    'sip:a@b.example?X-Evil=1',
    'sip:a@b.example&X-Evil=1',
    'sip:a@b.example#frag',
    'sip:a@b.example"><Hangup/>',
    'sip:a@b .example',
  ])('refuses a URI that smuggles headers, markup or whitespace: %j', (uri) =>
    expect(() => handoffMarkup(sip(uri))).toThrow('Invalid handoff SIP URI'),
  );

  it('refuses a URI of 255 characters or more, accepts 254', () => {
    const host = (n: number) => `sip:${'a'.repeat(n - 4)}`;
    expect(() => handoffMarkup(sip(host(255)))).toThrow('Invalid handoff SIP URI');
    expect(handoffMarkup(sip(host(254)))).toContain('<Sip>');
  });

  it('puts headers in the URI query with percent-encoded values and XML-escaped separators', () => {
    const markup = handoffMarkup(
      sip('sips:acd@sbc.example.net', {
        'X-OVO-Ticket': 't-1',
        'X-OVO-Context-Url': 'https://ovo.example.test/c?t=a&b=c',
        'X-OVO-Language': 'en IN',
      }),
    );
    expect(markup).toBe(
      '<Response><Dial><Sip>sips:acd@sbc.example.net?X-OVO-Ticket=t-1&amp;X-OVO-Context-Url=https%3A%2F%2Fovo.example.test%2Fc%3Ft%3Da%26b%3Dc&amp;X-OVO-Language=en%20IN</Sip></Dial></Response>',
    );
  });

  it('encodes a value that tries to add a header, close the element or inject markup', () => {
    const markup = handoffMarkup(
      sip('sip:a@b.example', { 'X-Note': 'x&X-Admin=1</Sip><Hangup/>"\'' }),
    );
    expect(markup).not.toContain('<Hangup/>');
    expect(markup).not.toContain('X-Admin=1');
    expect(markup).toContain('X-Note=x%26X-Admin%3D1%3C%2FSip%3E%3CHangup%2F%3E%22%27');
    // The raw ampersand never survives: only the encoded form and the escaped separators.
    expect(markup.replaceAll('&amp;', '')).not.toContain('&');
  });

  it.each(['Via', 'To', 'Call-ID', 'X', 'X-', 'X-bad name', 'Remote-Party-ID', 'X-a=b'])(
    'refuses the header name %j (X- names only)',
    (name) =>
      expect(() => handoffMarkup(sip('sip:a@b.example', { [name]: 'v' }))).toThrow(
        'Invalid SIP handoff header name',
      ),
  );

  it.each(['line\nbreak', 'tab\there', 'é', 'x'.repeat(257)])(
    'refuses the header value %j (printable ASCII, at most 256)',
    (value) =>
      expect(() => handoffMarkup(sip('sip:a@b.example', { 'X-A': value }))).toThrow(
        'Invalid SIP handoff header value',
      ),
  );

  it('caps the header count at 16 and the encoded query at 1023 characters', () => {
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`X-H${i}`, 'v']));
    expect(() => handoffMarkup(sip('sip:a@b.example', many))).toThrow('Too many');
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`X-H${i}`, 'v']));
    expect(handoffMarkup(sip('sip:a@b.example', sixteen))).toContain('X-H15=v');
    // Percent-encoding triples the size of '/', so the cap is on the encoded text.
    const wide = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`X-W${i}`, '/'.repeat(256)]),
    );
    expect(() => handoffMarkup(sip('sip:a@b.example', wide))).toThrow('exceed 1023');
  });
});

describe('Twilio sip handoff over REST', () => {
  it('posts the TwiML to the call update URL and confirms (twilio.handoff.sip fixture)', async () => {
    const net = createFixtureNet(fixtures['twilio.handoff.sip']!);
    const result = await twilioControlFactory(net)
      .create(binding)
      .handoff(
        'CA00000000000000000000000000000000',
        sip('sips:acd@sbc.example.net', { 'X-OVO-Ticket': 't-1', 'X-OVO-Language': 'en IN' }),
        'h-sip',
      );
    expect(result).toEqual({
      kind: 'confirmed',
      receiptId: 'twilio:CA00000000000000000000000000000000:h-sip',
    });
    expect(net.mismatches).toEqual([]);
    expect(net.pending()).toEqual([]);
  });

  it('rejects a bad sip target before any REST call', async () => {
    const net = createFixtureNet([]);
    const result = await twilioControlFactory(net)
      .create(binding)
      .handoff('CA00000000000000000000000000000000', sip('tel:+15550123'), 'h-bad');
    expect(result).toMatchObject({ kind: 'rejected', retryable: false });
    expect(net.log).toEqual([]);
  });
});
