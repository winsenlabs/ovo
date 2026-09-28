import { createHmac } from 'node:crypto';
import { Cap, type CarrierControlFactory, type CarrierIngress } from '../../contracts/src/index.ts';
import { compose } from '@winsendotai/ovo-runtime';
import { createFixtureNet } from '../../plugin-kit/src/index.ts';
import { createFakeCarrierHostPorts } from '../../conformance/src/drivers/carrier-host-ports.ts';
import { withEgressSentinel } from '../../conformance/src/drivers/egress-sentinel.ts';
import { loadDistribution } from '../../distribution/src/load.ts';
import { CarrierRegistry } from '../../session-host/src/carrier-registry.ts';
import { MediaGateway } from '../../plugin-media/src/gateway.ts';
import { parse, stringify } from 'node:querystring';
import twilio from 'twilio';
import { expect, it, vi } from 'vitest';
import { validateTwilioSignature } from '../../plugin-carrier-twilio/src/index.ts';

it.each([
  ['absent query', ''],
  ['empty query', '?'],
  ['escapes and numeric keys', '?a=%2f+%20&b=%21%27%28%29%7E&2=two&1=one'],
  ['repeated and inherited keys', '?a=1&b=2&a=3&__proto__=data&constructor=value'],
  ['malformed escapes and empty fields', '?a=%FF&b=%&c=%E0%A4&empty=&bare&&=empty-key'],
  ['1000-key boundary', '?' + Array.from({ length: 1001 }, (_, i) => `k${i}=%2f+`).join('&')],
])('matches the genuine SDK legacy query handling for %s', (_name, query) => {
  const externalUrl = 'https://voice.example.test:8443/status' + query;
  const parsed = new URL(externalUrl);
  const legacy = parsed.search ? stringify(parse(parsed.search.slice(1))) : undefined;
  parsed.search = '';
  const signedUrl = legacy === undefined ? externalUrl : parsed.href + '?' + legacy;
  const authToken = 'synthetic-query-token';
  const signature = twilio.getExpectedTwilioSignature(authToken, signedUrl, {});
  expect(twilio.validateRequest(authToken, signature, externalUrl, {})).toBe(true);
  expect(validateTwilioSignature({ authToken, signature, externalUrl })).toBe(true);
  for (const token of ['', 'wrong-token']) {
    expect(twilio.validateRequest(token, signature, externalUrl, {})).toBe(false);
    expect(validateTwilioSignature({ authToken: token, signature, externalUrl })).toBe(false);
  }
});

const id = '@winsendotai/ovo-carrier-twilio';
const publicBase = 'https://voice.example.test';
const binding = {
  bindingId: 'b1',
  pluginId: id,
  workspaceId: 'w1',
  config: { accountSid: 'AC00000000000000000000000000000000' },
  secret: 'synthetic-c1-token',
};
const fields = { CallSid: 'CAfixture', CallStatus: 'completed', SequenceNumber: '3' };
const sign = (url: string, body: Record<string, string>) =>
  createHmac('sha1', binding.secret)
    .update(
      url +
        Object.keys(body)
          .sort()
          .map((key) => key + body[key])
          .join(''),
    )
    .digest('base64');

async function installed() {
  const distribution = await loadDistribution({
    role: 'gateway',
    profile: 'compose',
    env: {},
    log() {},
  });
  const definition = distribution.catalog.find((item) => item.manifest.id === id)!;
  const graph = await compose(
    distribution.processRows.filter((row) => row.id === id),
    [definition],
    {
      scope: 'process',
      net: createFixtureNet([]),
    },
  );
  const factory = graph.all(Cap.carrierControl).get('twilio') as CarrierControlFactory;
  const registry = new CarrierRegistry(
    new Map([[id, { version: definition.manifest.version, factory }]]),
    async () => binding,
  );
  const selected = await registry.forRelease({
    selections: {
      carrier: { pluginId: id, version: definition.manifest.version, bindingId: 'b1', config: {} },
    },
  });
  return {
    graph,
    ingress: graph.all(Cap.carrierIngress).get(selected.carrierId) as CarrierIngress | undefined,
  };
}

it.each([
  ['without port', false, false],
  ['with port', true, false],
  ['legacy query without port', false, true],
  ['legacy query with port', true, true],
] as const)(
  'accepts the SDK HTTPS signature variant: %s through the production gateway',
  async (_name, portInSignature, legacyQuery) => {
    await withEgressSentinel(
      async (sentinel) => {
        const loaded = await installed();
        try {
          // Both a supported nonstandard port and the absent-port/default-443 branch.
          for (const base of [publicBase + ':8443', publicBase]) {
            const callbackPath =
              '/carriers/twilio/b1/status?r=dial-1&t=token&raw=%2f+%20&other=%2F&punct=%21&2=two&1=one';
            const externalUrl = base + callbackPath;
            const candidate = new URL(externalUrl);
            candidate.port = '';
            let signedUrl = portInSignature
              ? base.includes(':8443')
                ? externalUrl
                : externalUrl.replace(publicBase, publicBase + ':443')
              : candidate.href;
            if (legacyQuery) {
              const parsed = new URL(signedUrl);
              const query = stringify(parse(parsed.search.slice(1)));
              parsed.search = '';
              signedUrl = parsed.href + '?' + query;
            }
            const signature = twilio.getExpectedTwilioSignature(binding.secret, signedUrl, fields);
            expect(signature).toBe(sign(signedUrl, fields));
            expect(twilio.validateRequest(binding.secret, signature, externalUrl, fields)).toBe(
              true,
            );
            const host = createFakeCarrierHostPorts({
              bindings: { b1: binding },
              verifyUrlSecret: true,
            });
            const gateway = new MediaGateway(
              {
                authenticateSessionRoute: vi.fn(),
                resolveSessionRoute: vi.fn(),
                bindCarrierCallId: vi.fn(),
                recordCarrierCallIdMismatch: vi.fn(),
              },
              {
                publicBaseUrl: base,
                workerToken: 'synthetic-worker-token',
                ingresses: loaded.ingress ? [loaded.ingress] : [],
                hostFor: () => host,
              },
            );
            try {
              const { port } = await gateway.listen();
              const response = await fetch(
                new Request(`http://127.0.0.1:${port}${callbackPath}`, {
                  method: 'POST',
                  headers: { 'x-twilio-signature': signature },
                  body: new URLSearchParams(fields),
                }),
              );
              expect(response.status).toBe(204);
              expect(host.events).toHaveLength(1);
              expect(host.events[0]).toMatchObject({ state: 'completed', dialRequestId: 'dial-1' });
            } finally {
              await gateway.close();
            }
          }
        } finally {
          await loaded.graph.dispose();
        }
        expect(sentinel.attempts).toEqual([]);
      },
      { allowLoopback: true },
    );
  },
);
