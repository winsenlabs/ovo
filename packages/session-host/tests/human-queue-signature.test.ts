import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature, webhookSignature } from '../src/human-queue/signature.ts';

const secret = 'route-secret';
const now = 1_760_000_000_000;
const signed = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) => ({
  secret,
  timestamp: '1760000000',
  id: 'evt-1',
  body: '{"event":"accepted"}',
  signature: webhookSignature(secret, '1760000000', 'evt-1', '{"event":"accepted"}'),
  now,
  ...over,
});

describe('the webhook signature (human queue design 4.2, 6.3)', () => {
  it('is the v1 scheme: HMAC-SHA256 over "<timestamp>.<id>.<body>" (fixed vector)', () => {
    // Computed independently: python3 hmac.new(b'route-secret', b'1760000000.req-1.' + body, sha256)
    expect(
      webhookSignature('route-secret', '1760000000', 'req-1', '{"schema":"ovo.route-decision/1"}'),
    ).toBe('v1=89b525d3dd7a82affe60cf6c0ffa4c57e2702fa87b53b36a36f07a9a45901be3');
  });

  it('accepts a signature within the tolerance and refuses everything else', () => {
    expect(verifyWebhookSignature(signed())).toBe('ok');
    expect(verifyWebhookSignature(signed({ now: now + 299_000 }))).toBe('ok');
    expect(verifyWebhookSignature(signed({ now: now + 301_000 }))).toBe('stale');
    expect(verifyWebhookSignature(signed({ now: now - 301_000 }))).toBe('stale');
    expect(verifyWebhookSignature(signed({ body: '{"event":"released"}' }))).toBe('mismatch');
    expect(verifyWebhookSignature(signed({ id: 'evt-2' }))).toBe('mismatch');
    expect(verifyWebhookSignature(signed({ secret: 'other' }))).toBe('mismatch');
  });

  it('calls a missing or malformed header malformed, never throws', () => {
    for (const over of [
      { signature: undefined },
      { signature: 'v2=abc' },
      { signature: `v1=${'g'.repeat(64)}` },
      { timestamp: undefined },
      { timestamp: 'yesterday' },
      { id: undefined },
    ])
      expect(verifyWebhookSignature(signed(over))).toBe('malformed');
  });
});
