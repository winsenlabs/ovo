import { randomBytes } from 'node:crypto';
import { operatorApi, type InboundAgent, type Operator } from './operator-setup.ts';

export const PLIVO = '@winsendotai/ovo-carrier-plivo';

export interface PlivoAgent {
  agentId: string;
  releaseId: string;
  bindingId: string;
  authId: string;
  authToken: string;
  /** The Indian DID the route answers, in E.164. */
  number: string;
}

/**
 * docs/runbooks/indian-did.md as the operator runs it: a Plivo credential (the auth token) and a
 * binding (auth id, 8 kHz mu-law), its price card, and the same agent as `base` re-released on
 * Plivo with an inbound route for an Indian DID. The speech and LLM bindings, the other price
 * cards and the budget are the base agent's.
 */
export async function configurePlivoAgent(
  operator: Operator,
  base: InboundAgent,
  number = '+918069450000',
): Promise<PlivoAgent> {
  const call = operatorApi(operator);
  const authId = `MA${randomBytes(9).toString('hex').toUpperCase()}`;
  const authToken = randomBytes(20).toString('hex');
  const credential = await call<{ id: string }>('POST', '/v1/credentials', {
    label: 'Plivo auth token',
    provider: 'plivo',
    type: 'api-key',
    environment: 'live',
    value: authToken,
  });
  const binding = await call<{ id: string }>('POST', '/v1/provider-bindings', {
    label: 'Plivo India DID',
    provider: 'plivo',
    pluginId: PLIVO,
    environment: 'live',
    credentialId: credential.id,
    config: { authId, contentType: 'audio/x-mulaw;rate=8000' },
  });
  const version = '2026-10';
  await call('POST', '/v1/cost/price-cards', {
    id: 'plivo-carrier-audio-seconds',
    version,
    provider: 'plivo',
    unit: 'audio_seconds',
    currency: 'USD',
    minorUnitsPerBlock: '1',
    blockQuantity: '1000',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    provenance: 'live-path test price',
  });
  const { config } = await call<{ config: Record<string, any> }>(
    'GET',
    `/v1/agents/${base.agentId}`,
  );
  config.name = 'Live path (Plivo India)';
  config.voice.carrier = { plugin: PLIVO, binding: binding.id, config: {} };
  config.costPolicy.priceCards['plivo.carrier.audio_seconds'] = {
    id: 'plivo-carrier-audio-seconds',
    version,
    fxId: 'usd-inr',
    fxVersion: version,
  };
  const agent = await call<{ id: string }>('POST', '/v1/agents', { config });
  const release = await call<{ id: string }>('POST', `/v1/agents/${agent.id}/releases`, {});
  await call('PUT', `/v1/operations/inbound/routes/${encodeURIComponent(number)}`, {
    expectedVersion: null,
    releaseId: release.id,
    variables: {},
    enabled: true,
    carrierPluginId: PLIVO,
    carrierBindingId: binding.id,
  });
  return {
    agentId: agent.id,
    releaseId: release.id,
    bindingId: binding.id,
    authId,
    authToken,
    number,
  };
}

/** The Answer and Hangup URLs the operator pastes into the Plivo application. */
export async function plivoApplicationUrls(operator: Operator, bindingId: string) {
  const { items } = await operatorApi(operator)<{ items: { purpose: string; url: string }[] }>(
    'GET',
    `/v1/provider-bindings/${bindingId}/carrier-urls`,
  );
  const answer = items.find((item) => item.purpose === 'inbound')?.url;
  const hangup = items.find((item) => item.purpose === 'status')?.url;
  if (!answer || !hangup) throw new Error(`Plivo carrier URLs missing: ${JSON.stringify(items)}`);
  return { answer, hangup };
}
