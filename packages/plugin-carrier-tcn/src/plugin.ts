import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  Cap,
  type CarrierHttpRoute,
  type CarrierIngress,
  type CarrierMediaEvent,
  type Logger,
  type ResolvedBinding,
  type SipRequestVerifier,
  type SipTrunkControlClient,
} from '@winsendotai/ovo-contracts';
import {
  createSipControlFactory,
  createSipMediaSerializer,
  createSipRoutes,
  sipCarrierCapabilities,
} from '@winsendotai/ovo-sip-carrier-kit';
import { createSipFixtureFrameEncoder } from '@winsendotai/ovo-sip-carrier-kit/testing';
import { TCN_MAX_METADATA_HEADERS, tcnHostPorts } from './metadata.ts';

/**
 * TCN delivers calls to OVO's sip-gateway as an ordinary SIP trunk (W11 §8, option A). Every
 * SIP-level TCN fact is UNCONFIRMED. Handoff is SIP REFER through the sip-gateway, and whether
 * TCN's SBC accepts REFER is unconfirmed, so it only works on a trunk whose sip-trunks.json entry
 * sets `refer.enabled` (false by default; a TCN trunk keeps it off until TCN confirms). TCN's REST
 * transfer path (CallerRequeue, TransferColdToOutbound) is not used for this delivery model.
 */
export const tcnCapabilities = sipCarrierCapabilities('tcn');

/** TCN regions with a documented webphone host (https://docs.tcn.com/virtual-agent-870220m0.md). */
export const TCN_REGIONS = ['us', 'ca', 'uk', 'sg', 'au', 'useast', 'eur'] as const;

/**
 * Outbound is off unless the binding opts in: whether TCN accepts calls from us is unconfirmed.
 * The sip-gateway separately requires the trunk entry's `outbound.enabled`.
 */
export function tcnDialAllowed(binding: ResolvedBinding): string | undefined {
  return binding.config.outboundEnabled === true ? undefined : 'outbound_disabled';
}

type Lookups = { logger?: Logger };

export function createTcnCarrierIngress(
  input: Lookups & { verifier: () => SipRequestVerifier | undefined },
): CarrierIngress & { createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string } {
  // The kit's routes, except that an inbound admission first gains the binding's tcn.* keys.
  const routes = createSipRoutes({ ...input, carrierId: 'tcn' }).map((route): CarrierHttpRoute =>
    route.purpose !== 'inbound'
      ? route
      : { ...route, handle: (req, host) => route.handle(req, tcnHostPorts(host)) },
  );
  return {
    carrierId: 'tcn',
    capabilities: tcnCapabilities,
    routes,
    serializer: createSipMediaSerializer({ verifier: input.verifier }),
    operatorUrls: [
      {
        purpose: 'inbound',
        label: 'Admission URL for sip-trunks.json',
        help: 'The sip-gateway posts each INVITE TCN delivers here over loopback; set the TCN trunk entry bindingId to this binding.',
      },
      {
        purpose: 'status',
        label: 'TCN SIP status callback',
        help: 'The sip-gateway posts call progress and the final RTP stats here.',
      },
    ],
    createFixtureFrameEncoder: createSipFixtureFrameEncoder,
  };
}

export const createTcnControl = (
  input: Lookups & { client: () => SipTrunkControlClient | undefined },
) =>
  createSipControlFactory({ ...input, capabilities: tcnCapabilities, dialAllowed: tcnDialAllowed });

const bindingSchema = {
  type: 'object',
  required: ['trunkId'],
  additionalProperties: false,
  properties: {
    trunkId: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
    region: { type: 'string', enum: [...TCN_REGIONS], default: 'sg' },
    metadataHeaders: {
      type: 'array',
      maxItems: TCN_MAX_METADATA_HEADERS,
      items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$' },
    },
    outboundEnabled: { type: 'boolean', default: false },
    fromNumbers: { type: 'array', items: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' } },
    cps: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

const ui = {
  label: 'TCN (SIP delivery)',
  description:
    'TCN delivers calls to the OVO sip-gateway over SIP. Inbound only unless outbound is enabled; no transfer back to TCN in v1. See docs/runbooks/tcn-sip.md.',
  vendor: 'TCN',
  slot: 'carrier',
  docsUrl: 'docs/runbooks/tcn-sip.md',
  fields: {
    trunkId: {
      label: 'Trunk id',
      help: 'The id of this trunk in the sip-gateway trunk file (sip-trunks.json).',
      order: 1,
    },
    region: {
      label: 'TCN region',
      help: 'The TCN region that delivers the calls; sg serves India. Informational in v1.',
      widget: 'select',
      order: 2,
    },
    metadataHeaders: {
      label: 'Metadata headers',
      help: 'SIP X- headers from TCN to pass to the agent as tcn.<header-name> variables. The trunk entry must forward them too.',
      order: 3,
    },
    outboundEnabled: {
      label: 'Allow outbound calls',
      help: 'Off until TCN confirms it accepts calls from OVO.',
      advanced: true,
    },
    fromNumbers: {
      label: 'Outbound caller IDs',
      help: 'E.164 numbers this binding may dial from, once outbound is enabled.',
      advanced: true,
    },
    cps: { label: 'Calls per second', help: 'The trunk dialing limit.', advanced: true },
  },
} as const;

export const tcnCarrierPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-carrier-tcn',
    version: '0.1.0',
    contractVersion: 2,
    kind: 'carrier',
    provider: 'tcn',
    scope: 'process',
    capabilities: tcnCapabilities,
    provides: [Cap.carrierControl, Cap.carrierIngress],
    requires: [],
    // Worker hosts compose the control client and gateway hosts the verifier; both are looked up
    // per call, so the plugin loads in every role and refuses work where its capability is absent.
    optional: [Cap.sipTrunkControl, Cap.sipTrunkVerifier],
    configSchema: { type: 'object', additionalProperties: false },
    bindingSchema,
    secretFields: ['/credentialRef'],
    meters: [
      {
        key: 'tcn.carrier.audio_seconds',
        unit: 'audio_seconds',
        label: 'TCN SIP call audio',
        role: 'carrier',
      },
    ],
    // No TCN REST client in v1: the only transport is the host's sip-gateway capability.
    runtime: { egressHosts: [] },
    conformance: ['carrier@1'],
    ui,
  } as const,
  (ctx) => {
    const logger = ctx.logger;
    ctx.provide(
      Cap.carrierIngress,
      createTcnCarrierIngress({ logger, verifier: () => ctx.maybe(Cap.sipTrunkVerifier) }),
    );
    ctx.provide(
      Cap.carrierControl,
      createTcnControl({ logger, client: () => ctx.maybe(Cap.sipTrunkControl) }),
    );
  },
);

export const plugins = [tcnCarrierPlugin];
