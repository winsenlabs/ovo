import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { operatorApi, type InboundAgent, type Operator } from './operator-setup.ts';
import { freePort, hostEnv } from './stack.ts';

export const SIP = '@winsendotai/ovo-carrier-sip';
export const TCN = '@winsendotai/ovo-carrier-tcn';
export const SIP_GATEWAY_MAIN = 'apps/sip-gateway/src/main.ts';

/** The two carriers the sip-gateway delivers through (`/carriers/<carrierId>/…`). */
export type SipCarrierId = 'sip' | 'tcn';

export interface SipAgent {
  agentId: string;
  releaseId: string;
  bindingId: string;
  trunkId: string;
  /** The DID the trunk delivers and the inbound route answers, in E.164. */
  number: string;
  carrierId: SipCarrierId;
  pluginId: string;
  /** X- headers the trunk entry forwards (and, for TCN, the binding's `metadataHeaders`). */
  forwardHeaders: string[];
}

/** The Compose `.env` additions that turn SIP on (scripts/bootstrap-compose.sh generates both). */
export function sipComposeVariables(controlUrl: string): Record<string, string> {
  return {
    OVO_SIP_ENABLED: 'true',
    OVO_SIP_CONTROL_TOKEN: randomBytes(32).toString('hex'),
    OVO_SIP_GATEWAY_SECRET: randomBytes(32).toString('base64'),
    OVO_SIP_CONTROL_URL: controlUrl,
  };
}

export interface SipAgentOptions {
  number?: string;
  trunkId?: string;
  /** `sip` (generic trunk, the default) or `tcn` (TCN SIP delivery, docs/runbooks/tcn-sip.md). */
  carrierId?: SipCarrierId;
  /** X- headers to forward; for TCN also the binding's `metadataHeaders` (surfaced as `tcn.*`). */
  forwardHeaders?: string[];
}

/**
 * docs/runbooks/sip-trunk-onboarding.md section 3 as the operator runs it: a trunk binding for the
 * `sip` or `tcn` plugin (its credential would carry digest credentials for outbound; inbound never
 * reads it, so the TCN one is the IP-authenticated `{}`), the carrier meter's price card, the base
 * agent re-released with `voice.carrier` on that binding and the card in its `costPolicy`, and the
 * inbound route for the DID.
 */
export async function configureSipAgent(
  operator: Operator,
  base: InboundAgent,
  options: SipAgentOptions = {},
): Promise<SipAgent> {
  const {
    number = '+918000000001',
    trunkId = 'loop-trunk',
    carrierId = 'sip',
    forwardHeaders = [],
  } = options;
  const pluginId = carrierId === 'tcn' ? TCN : SIP;
  const call = operatorApi(operator);
  const credential = await call<{ id: string }>('POST', '/v1/credentials', {
    label: carrierId === 'tcn' ? 'TCN trunk (IP-authenticated)' : 'SIP trunk digest',
    provider: carrierId,
    type: 'api-key',
    environment: 'live',
    value:
      carrierId === 'tcn'
        ? '{}'
        : JSON.stringify({ username: 'ovo-e2e', password: randomBytes(12).toString('hex') }),
  });
  const binding = await call<{ id: string }>('POST', '/v1/provider-bindings', {
    label: carrierId === 'tcn' ? 'TCN loopback trunk' : 'SIP loopback trunk',
    provider: carrierId,
    pluginId,
    environment: 'live',
    credentialId: credential.id,
    config:
      carrierId === 'tcn'
        ? { trunkId, region: 'sg', metadataHeaders: forwardHeaders }
        : { trunkId },
  });
  const version = '2026-10';
  const cardId = `${carrierId}-carrier-audio-seconds`;
  await call('POST', '/v1/cost/price-cards', {
    id: cardId,
    version,
    provider: carrierId,
    unit: 'audio_seconds',
    currency: 'USD',
    minorUnitsPerBlock: '1',
    blockQuantity: '1000',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    provenance: 'sip-path test price (the trunk contract sets the real one)',
  });
  const { config } = await call<{ config: Record<string, any> }>(
    'GET',
    `/v1/agents/${base.agentId}`,
  );
  config.name = carrierId === 'tcn' ? 'TCN SIP path' : 'SIP path';
  config.voice.carrier = { plugin: pluginId, binding: binding.id, config: {} };
  config.costPolicy.priceCards[`${carrierId}.carrier.audio_seconds`] = {
    id: cardId,
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
    carrierPluginId: pluginId,
    carrierBindingId: binding.id,
  });
  return {
    agentId: agent.id,
    releaseId: release.id,
    bindingId: binding.id,
    trunkId,
    number,
    carrierId,
    pluginId,
    forwardHeaders,
  };
}

/** A loopback trunk entry (11.2): SIPp on 127.0.0.1 is the trunk, inbound only, PCMU first. */
export function loopbackTrunkFile(agent: SipAgent) {
  return {
    version: 1,
    trunks: [
      {
        id: agent.trunkId,
        carrierId: agent.carrierId,
        bindingId: agent.bindingId,
        transport: 'udp',
        signallingCidrs: ['127.0.0.1/32'],
        mediaCidrs: ['127.0.0.1/32'],
        codecs: ['PCMU', 'PCMA'],
        dtmf: 'rfc4733',
        numberFormat: { country: 'IN' },
        forwardHeaders: agent.forwardHeaders,
        inviteRatePerSecond: 5,
        maxConcurrent: 2,
        optionsPingSeconds: 30,
        inbound: { enabled: true, numbers: [agent.number] },
        outbound: {
          enabled: false,
          proxy: 'sip:127.0.0.1:5999;transport=udp',
          fromNumbers: [],
          auth: 'ip',
        },
      },
    ],
  };
}

export interface SipGatewayProcess {
  sipPort: number;
  child: ChildProcess;
  output(): string;
  close(): Promise<void>;
}

/**
 * The sip-gateway as its own process (it is a separate service in Compose), with the environment
 * compose.yaml renders for it and only its addresses moved to this host: SIP and RTP stay on
 * loopback because OVO_SIP_PUBLIC_ENABLED is false, as in the shipped default.
 */
export async function startSipGatewayProcess(input: {
  root: string;
  dir: string;
  variables: Record<string, string>;
  gatewayOrigin: string;
  controlPort: number;
  agent: SipAgent;
  rtpPorts: { min: number; max: number };
}): Promise<SipGatewayProcess> {
  const trunks = join(input.dir, 'sip-trunks.json');
  await writeFile(trunks, JSON.stringify(loopbackTrunkFile(input.agent), null, 2));
  const sipPort = await freePort();
  const healthPort = await freePort();
  const env = hostEnv('sip-gateway', input.variables, {
    OVO_SIP_PORT: String(sipPort),
    OVO_SIP_TRANSPORTS: 'udp',
    OVO_SIP_RTP_PORT_MIN: String(input.rtpPorts.min),
    OVO_SIP_RTP_PORT_MAX: String(input.rtpPorts.max),
    OVO_SIP_TRUNKS_FILE: trunks,
    OVO_SIP_CONTROL_LISTEN: `127.0.0.1:${input.controlPort}`,
    OVO_SIP_CONTROL_SOURCE_CIDRS: '127.0.0.1/32',
    OVO_SIP_MEDIA_INTERNAL_URL: input.gatewayOrigin,
    OVO_SIP_HEALTH_LISTEN: `127.0.0.1:${healthPort}`,
    OVO_SIP_DRAIN_TIMEOUT_MS: '2000',
  });
  const child = spawn(process.execPath, ['--import', 'tsx', SIP_GATEWAY_MAIN], {
    cwd: input.root,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (data) => (output += String(data)));
  child.stderr!.on('data', (data) => (output += String(data)));
  const exited = once(child, 'exit');
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`sip-gateway exited at startup:\n${output}`);
    const ready = await fetch(`http://127.0.0.1:${healthPort}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`sip-gateway never became healthy:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    sipPort,
    child,
    output: () => output,
    async close() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
