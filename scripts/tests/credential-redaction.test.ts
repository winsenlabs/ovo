import { describe, expect, it } from 'vitest';
import { redactLogValue } from '../../packages/plugin-kit/src/index.ts';
import { redact } from '../../packages/plugin-observability/src/redaction.ts';

// One credential corpus for both redactors: the JSON-lines logger (plugin-kit) and telemetry's
// boundary redaction (plugin-observability). A shape taught to one and not the other fails here.
// Digits stay isolated, so telemetry's phone-number rule cannot hide a missed credential.
const SECRET = 'S3cr3tVa1ueXyZaBcDeFgH';
const TEXT_SHAPES: Record<string, string> = {
  bearer: `Authorization: Bearer ${SECRET}`,
  basic: `Authorization: Basic ${SECRET}`,
  tokenScheme: `Authorization: Token ${SECRET}`,
  lowerTokenScheme: `authorization: token ${SECRET}`,
  urlPassword: `postgres://ovo:${SECRET}@db.internal:5432/ovo`,
  urlPasswordWithAt: `postgres://ovo:pa@ss${SECRET}@db.internal/ovo`,
  xiApiKeyQuery: `wss://api.vendor.example/v1/stream?model=x&xi_api_key=${SECRET}`,
  apiKeyDashQuery: `https://api.vendor.example/v1?api-key=${SECRET}`,
  apikeyQuery: `https://api.vendor.example/v1?apikey=${SECRET}`,
  secretKeyQuery: `https://bucket.example/o?secretKey=${SECRET}&x=1`,
  accessKeyQuery: `https://bucket.example/o?accessKey=${SECRET}`,
  amzSignature: `https://bucket.example/o?X-Amz-Signature=${SECRET}`,
  routeToken: `wss://media.example/carriers/x/media?sid=s-1&rt=${SECRET}`,
};
const FIELD_SHAPES = [
  'secretKey',
  'accessKey',
  'accessKeyId',
  'xi-api-key',
  'apiKey',
  'clientSecret',
  'authToken',
  'x-signature',
];

const redactors = {
  logger: (value: unknown) => JSON.stringify(redactLogValue(value)),
  telemetry: (value: unknown) => JSON.stringify(redact(value)),
};

describe.each(Object.entries(redactors))('%s redaction', (_name, apply) => {
  it.each(Object.entries(TEXT_SHAPES))('scrubs a %s credential in free text', (_shape, text) => {
    expect(apply({ detail: text })).not.toContain(SECRET);
  });

  it.each(FIELD_SHAPES)('redacts the value of a %s field', (field) => {
    expect(apply({ [field]: SECRET })).not.toContain(SECRET);
  });

  it('keeps prose and count fields that only look like credential words', () => {
    const out = apply({ inputTokens: 12, note: 'token budget exceeded' });
    expect(out).toContain('"inputTokens":12');
    expect(out).toContain('token budget exceeded');
  });

  it('keeps the host of a URL whose userinfo it removed', () => {
    expect(apply({ detail: TEXT_SHAPES.urlPasswordWithAt })).toContain('[redacted]@db.internal');
  });
});
