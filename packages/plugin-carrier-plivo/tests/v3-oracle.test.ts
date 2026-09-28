import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signatureInput, verifyHttpV3, verifyV3 } from '../src/signature.ts';
import { plivoSerializer } from '../src/serializer.ts';

// Oracle: Plivo's PHP SDK v3SignatureValidation.php constructs the URL with
// SORT_NATURAL for query keys, repeated values and POST field names, then signs
// `${constructedUrl}.${nonce}`. These literal inputs are independent of C4's
// signer. See https://github.com/plivo/plivo-php/blob/master/src/Plivo/Util/v3SignatureValidation.php
const token = 'offline-fixture-token';
const nonce = 'fixture-nonce';
const hmac = (input: string) => createHmac('sha256', token).update(input).digest('base64');
const vectors: {
  method: 'GET' | 'POST';
  url: string;
  params: Record<string, string>;
  signed: string;
}[] = [
  {
    method: 'GET',
    url: 'https://voice.example.test:8443/inbound?key10=x&key2=11&key2=2',
    params: {},
    signed: 'https://voice.example.test:8443/inbound?key2=2&key2=11&key10=x.fixture-nonce',
  },
  {
    method: 'POST',
    url: 'https://voice.example.test:8443/answer?q10=1&q2=2',
    params: { Field10: 'ten', Field2: 'two', A: 'upper', a: 'lower' },
    signed:
      'https://voice.example.test:8443/answer?q2=2&q10=1.AupperField2twoField10tenalower.fixture-nonce',
  },
];

describe('Plivo V3 reference construction', () => {
  it.each(vectors)(
    'accepts the SDK natural-order $method signature with explicit port',
    async (vector) => {
      expect(signatureInput(vector.url, nonce, vector.params, vector.method)).toBe(vector.signed);
      const signature = hmac(vector.signed);
      const headers = {
        'X-Plivo-Signature-V3': signature,
        'X-Plivo-Signature-V3-Nonce': nonce,
      };
      expect(
        await verifyV3({
          token,
          url: vector.url,
          params: vector.params,
          method: vector.method,
          headers,
        }),
      ).toBe(true);
      expect(
        await verifyV3({
          token,
          url: vector.url.replace(':8443', ''),
          params: vector.params,
          method: vector.method,
          headers,
        }),
      ).toBe(false);
    },
  );

  it('authenticates raw HTTPS query and POST body through the production HTTP verifier', async () => {
    const url = 'https://voice.example.test:8443/answer?q10=1&q2=2';
    const body = new TextEncoder().encode('Field10=ten&Field2=two&A=upper&a=lower');
    const headers = {
      'X-Plivo-Signature-V3': hmac(
        'https://voice.example.test:8443/answer?q2=2&q10=1.AupperField2twoField10tenalower.fixture-nonce',
      ),
      'X-Plivo-Signature-V3-Nonce': nonce,
    };
    const request = {
      method: 'POST' as const,
      externalUrl: url,
      query: { q10: '1', q2: '2' },
      headers,
      rawBody: body,
      bindingId: 'fixture-binding',
    };
    expect(await verifyHttpV3(request, token)).toBe(true);
    expect(await verifyHttpV3({ ...request, externalUrl: url.replace(':8443', '') }, token)).toBe(
      false,
    );
    expect(
      await verifyHttpV3(
        { ...request, rawBody: new TextEncoder().encode('Field2=changed') },
        token,
      ),
    ).toBe(false);
    expect(
      await verifyHttpV3(
        { ...request, headers: { ...headers, 'X-Plivo-Signature-V3-Nonce': '' } },
        token,
      ),
    ).toBe(false);
  });

  it('rejects absent signatures, wrong token, path and method with the same valid vector', async () => {
    const vector = vectors[1]!;
    const headers = {
      'X-Plivo-Signature-V3': hmac(vector.signed),
      'X-Plivo-Signature-V3-Nonce': nonce,
    };
    const valid = { token, url: vector.url, params: vector.params, method: vector.method, headers };
    expect(await verifyV3(valid)).toBe(true);
    expect(await verifyV3({ ...valid, headers: { 'X-Plivo-Signature-V3-Nonce': nonce } })).toBe(
      false,
    );
    expect(await verifyV3({ ...valid, token: 'wrong-fixture-token' })).toBe(false);
    expect(await verifyV3({ ...valid, url: vector.url.replace('/answer', '/status') })).toBe(false);
    expect(await verifyV3({ ...valid, method: 'GET' })).toBe(false);
  });

  it('accepts only signed query-free WSS/HTTPS upgrade forms and rejects ?edge=', async () => {
    const mediaUrl = 'wss://voice.example.test:8443/carriers/plivo/b1/media';
    const resolveBinding = async () => ({
      bindingId: 'b1',
      pluginId: '@winsendotai/ovo-carrier-plivo',
      workspaceId: 'workspace-1',
      config: { authId: 'AUTH1' },
      secret: token,
    });
    const context = { bindingId: 'b1', resolveBinding, verifyUrlSecret: () => false };
    const request = { url: new URL(mediaUrl), externalUrl: mediaUrl, headers: {} };
    for (const signedUrl of [mediaUrl, mediaUrl.replace('wss:', 'https:')]) {
      const headers = {
        'X-Plivo-Signature-V3': hmac(`${signedUrl}.${nonce}`),
        'X-Plivo-Signature-V3-Nonce': nonce,
      };
      expect(await plivoSerializer.authenticateUpgrade({ ...request, headers }, context)).toEqual({
        ok: true,
        params: {},
      });
      expect(
        await plivoSerializer.authenticateUpgrade(
          { ...request, url: new URL(`${mediaUrl}?edge=outside`), headers },
          context,
        ),
      ).toEqual({ ok: false, status: 403 });
      expect(
        await plivoSerializer.authenticateUpgrade(
          { ...request, headers: { ...headers, 'X-Plivo-Signature-V3-Nonce': '' } },
          context,
        ),
      ).toEqual({ ok: false, status: 403 });
    }
  });
});
