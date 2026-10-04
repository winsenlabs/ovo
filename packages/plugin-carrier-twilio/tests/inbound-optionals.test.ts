import { beforeAll, afterAll, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Cap, type CarrierIngress, type InboundDecision } from '@winsendotai/ovo-contracts';
import { compose, type Composition } from '@winsendotai/ovo-runtime';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { loadDistribution } from '../../distribution/src/load.ts';
import { createFakeCarrierHostPorts } from '../../conformance/src/drivers/carrier-host-ports.ts';
const binding = {
  bindingId: 'b1',
  workspaceId: 'w1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  config: { accountSid: 'AC00000000000000000000000000000000' },
  secret: 'synthetic-token',
};
let graph: Composition, ingress: CarrierIngress;
beforeAll(async () => {
  const distribution = await loadDistribution({
    role: 'gateway',
    profile: 'compose',
    env: {},
  });
  const plugin = distribution.catalog.find((p) => p.manifest.id === binding.pluginId)!;
  graph = await compose([{ id: plugin.manifest.id }], [plugin], {
    scope: 'process',
    net: createFixtureNet([]),
  });
  ingress = graph.all(Cap.carrierIngress).get('twilio') as CarrierIngress;
  expect(ingress, 'the installed carrier must supply the ingress').toBeDefined();
});
afterAll(async () => {
  await graph?.dispose();
});
const sign = (url: string, fields: Record<string, string>) =>
  createHmac('sha1', binding.secret)
    .update(
      url +
        Object.keys(fields)
          .sort()
          .map((k) => k + fields[k])
          .join(''),
    )
    .digest('base64');
const inbound = {
  CallSid: 'CAfixture',
  AccountSid: binding.config.accountSid,
  From: '+15550123',
  To: '+15550456',
  Direction: 'inbound',
};
function request(
  host: ReturnType<typeof createFakeCarrierHostPorts>,
  purpose: 'inbound' | 'status' | 'amd' | 'resume',
  fields: Record<string, string>,
) {
  const externalUrl = host.callbackUrl(
    'twilio',
    'b1',
    purpose,
    purpose === 'inbound' ? undefined : { requestId: 'r1' },
  );
  return {
    method: 'POST' as const,
    bindingId: 'b1',
    externalUrl,
    query: Object.fromEntries(new URL(externalUrl).searchParams),
    headers: { 'x-twilio-signature': sign(externalUrl, fields) },
    rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
  };
}
function route(purpose: string) {
  return ingress.routes.find((r) => r.purpose === purpose)!;
}

it.each<[string, InboundDecision, string]>([
  [
    'callerId only',
    { kind: 'human', e164: '+15550123', callerId: '+15550456' },
    '<Dial callerId="+15550456"><Number>+15550123</Number></Dial>',
  ],
  [
    'timeout only',
    { kind: 'human', e164: '+15550123', timeoutSeconds: 3.2 },
    '<Dial timeout="4"><Number>+15550123</Number></Dial>',
  ],
  [
    'zero timeout',
    { kind: 'human', e164: '+15550123', timeoutSeconds: 0 },
    '<Dial><Number>+15550123</Number></Dial>',
  ],
  [
    'announcement without message',
    { kind: 'wait', pauseSeconds: 2, retryUrl: 'https://voice.example.test/retry', announce: true },
    '<Pause length="2"/><Redirect method="POST">https://voice.example.test/retry</Redirect>',
  ],
])('renders partial inbound optionals: %s', async (_name, admitInbound, markup) => {
  const host = createFakeCarrierHostPorts({ bindings: { b1: binding }, admitInbound });
  const result = await route('inbound').handle(request(host, 'inbound', inbound), host);
  expect(result.status).toBe(200);
  expect(result.body).toBe(`<Response>${markup}</Response>`);
});
