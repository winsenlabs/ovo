import { randomBytes } from 'node:crypto';
import type { buildManagementApi } from '../../../apps/api/src/bootstrap.ts';

type FastifyInstance = Awaited<ReturnType<typeof buildManagementApi>>['app'];

export const OPERATOR_TOKEN = randomBytes(32).toString('hex');
const TWILIO = '@winsendotai/ovo-carrier-twilio';

export interface InboundAgent {
  agentId: string;
  releaseId: string;
  twilioBindingId: string;
  accountSid: string;
  authToken: string;
  number: string;
}

/** Authenticated operator calls against the in-process management API. */
export function operatorApi(app: FastifyInstance) {
  return async <T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300)
      throw new Error(`${method} ${url} returned ${response.statusCode}: ${response.body}`);
    return (response.body ? response.json() : {}) as T;
  };
}

/**
 * The operator steps of docs/runbooks/first-real-call.md as the first live call ran them on
 * 2026-10-05: credentials and bindings, price cards and a budget, an `agent`-mode release on
 * Twilio + AssemblyAI + OpenAI TTS + OpenAI inference, a `busy` overflow policy and one inbound
 * route. Provider keys are fakes; the providers are loopback fakes.
 */
export async function configureInboundAgent(app: FastifyInstance): Promise<InboundAgent> {
  const call = operatorApi(app);
  const accountSid = `AC${randomBytes(16).toString('hex')}`;
  const authToken = randomBytes(16).toString('hex');
  const bind = async (provider: string, pluginId: string, secret: string, config: object) => {
    const credential = await call<{ id: string }>('POST', '/v1/credentials', {
      label: `${provider} key`,
      provider,
      type: 'api-key',
      environment: 'live',
      value: secret,
    });
    const binding = await call<{ id: string }>('POST', '/v1/provider-bindings', {
      label: `${provider} ${pluginId}`,
      provider,
      pluginId,
      environment: 'live',
      credentialId: credential.id,
      config,
    });
    return binding.id;
  };
  const twilio = await bind('twilio', TWILIO, authToken, { accountSid });
  const stt = await bind('assemblyai', '@winsendotai/ovo-stt-assemblyai', 'fake-aai-key', {
    model: 'universal-streaming-english',
  });
  const tts = await bind('openai', '@winsendotai/ovo-provider-openai-tts', 'fake-openai-key', {
    model: 'gpt-4o-mini-tts',
    voice: 'coral',
  });
  const llm = await bind(
    'openai',
    '@winsendotai/ovo-provider-openai-inference',
    'fake-openai-key',
    { model: 'gpt-6-luna', api: 'responses' },
  );

  const version = '2026-10';
  const effectiveAt = '2026-10-01T00:00:00.000Z';
  await call('POST', '/v1/cost/fx-versions', {
    id: 'usd-inr',
    version,
    baseCurrency: 'USD',
    quoteCurrency: 'INR',
    rateNumerator: '88',
    rateDenominator: '1',
    effectiveAt,
    provenance: 'live-path test rate',
  });
  const cards: Record<string, [provider: string, unit: string]> = {
    'twilio.carrier.audio_seconds': ['twilio', 'audio_seconds'],
    'assemblyai.streaming-stt.session_seconds': ['assemblyai', 'session_seconds'],
    'openai.streaming-tts.characters': ['openai', 'characters'],
    'openai.streaming-tts.input_tokens': ['openai', 'input_tokens'],
    'openai.streaming-tts.audio_output_tokens': ['openai', 'audio_output_tokens'],
    'openai.inference.input_tokens': ['openai', 'input_tokens'],
    'openai.inference.uncached_input_tokens': ['openai', 'uncached_input_tokens'],
    'openai.inference.cache_read_input_tokens': ['openai', 'cache_read_input_tokens'],
    'openai.inference.cache_write_input_tokens': ['openai', 'cache_write_input_tokens'],
    'openai.inference.output_tokens': ['openai', 'output_tokens'],
  };
  const priceCards: Record<string, object> = {};
  for (const [meter, [provider, unit]] of Object.entries(cards)) {
    const id = meter.replace(/[^a-z0-9]+/g, '-');
    await call('POST', '/v1/cost/price-cards', {
      id,
      version,
      provider,
      unit,
      currency: 'USD',
      minorUnitsPerBlock: '1',
      blockQuantity: '1000',
      effectiveAt,
      provenance: 'live-path test price',
    });
    priceCards[meter] = { id, version, fxId: 'usd-inr', fxVersion: version };
  }
  await call('POST', '/v1/cost/budgets', {
    id: 'live-path',
    limitPaise: '100000',
    admissionOverspendPaise: '0',
  });

  const agent = await call<{ id: string }>('POST', '/v1/agents', {
    config: {
      name: 'Live path',
      mode: 'agent',
      language: 'en-IN',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      context: 'You are a polite support agent on a phone call. Reply in short spoken sentences.',
      recording: false,
      voice: {
        engine: { plugin: '@winsendotai/ovo-plugin-voice-session-engine', config: {} },
        carrier: { plugin: TWILIO, binding: twilio, config: {} },
        stt: { plugin: '@winsendotai/ovo-stt-assemblyai', binding: stt, config: {} },
        tts: { plugin: '@winsendotai/ovo-provider-openai-tts', binding: tts, config: {} },
        llm: { plugin: '@winsendotai/ovo-provider-openai-inference', binding: llm, config: {} },
      },
      costPolicy: {
        budgetId: 'live-path',
        reservationPaise: '5000',
        maxCallSeconds: 300,
        priceCards,
      },
    },
  });
  const release = await call<{ id: string }>('POST', `/v1/agents/${agent.id}/releases`, {});

  const number = '+12515550142';
  await call('PUT', '/v1/operations/inbound/policy', {
    expectedVersion: null,
    policy: { kind: 'busy', reason: 'All agents are busy.' },
  });
  await call('PUT', `/v1/operations/inbound/routes/${encodeURIComponent(number)}`, {
    expectedVersion: null,
    releaseId: release.id,
    variables: {},
    enabled: true,
    carrierPluginId: TWILIO,
    carrierBindingId: twilio,
  });
  return {
    agentId: agent.id,
    releaseId: release.id,
    twilioBindingId: twilio,
    accountSid,
    authToken,
    number,
  };
}

/** The Voice and status URLs the operator pastes into the Twilio number. */
export async function carrierUrls(app: FastifyInstance, bindingId: string) {
  const { items } = await operatorApi(app)<{ items: { purpose: string; url: string }[] }>(
    'GET',
    `/v1/provider-bindings/${bindingId}/carrier-urls`,
  );
  const url = (purpose: string) => {
    const found = items.find((item) => item.purpose === purpose)?.url;
    if (!found) throw new Error(`No ${purpose} carrier URL`);
    return found;
  };
  return { voice: url('inbound'), status: url('status') };
}
