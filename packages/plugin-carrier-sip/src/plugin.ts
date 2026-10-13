import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  Cap,
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

/** v1 declares no handoff: no trunk confirmed REFER, and the B2BUA path is a stretch (§5.6). */
export const sipCapabilities = sipCarrierCapabilities('sip');

/** `outboundEnabled: false` on the binding keeps a trunk inbound-only. */
export function sipDialAllowed(binding: ResolvedBinding): string | undefined {
  return binding.config.outboundEnabled === false ? 'outbound_disabled' : undefined;
}

export function createSipCarrierIngress(input: {
  verifier: () => SipRequestVerifier | undefined;
  logger?: Logger;
}): CarrierIngress & { createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string } {
  return {
    carrierId: 'sip',
    capabilities: sipCapabilities,
    serializer: createSipMediaSerializer({ verifier: input.verifier }),
    routes: createSipRoutes({
      carrierId: 'sip',
      verifier: input.verifier,
      ...(input.logger ? { logger: input.logger } : {}),
    }),
    createFixtureFrameEncoder: createSipFixtureFrameEncoder,
    operatorUrls: [
      {
        purpose: 'inbound',
        label: 'Admission URL for sip-trunks.json',
        help: 'The sip-gateway posts each inbound INVITE here over loopback; set the trunk bindingId to this binding.',
      },
      {
        purpose: 'status',
        label: 'SIP status callback',
        help: 'The sip-gateway posts call progress and the final RTP stats here.',
      },
    ],
  };
}

export function createSipControl(input: {
  client: () => SipTrunkControlClient | undefined;
  logger?: Logger;
}) {
  return createSipControlFactory({
    capabilities: sipCapabilities,
    client: input.client,
    dialAllowed: sipDialAllowed,
    ...(input.logger ? { logger: input.logger } : {}),
  });
}

export const sipCarrierPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-carrier-sip',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'carrier',
    provider: 'sip',
    provides: [Cap.carrierControl, Cap.carrierIngress],
    requires: [],
    // Worker hosts compose the control client and gateway hosts the verifier; neither is awaited,
    // and each is looked up per call, so the plugin loads in every role.
    optional: [Cap.sipTrunkControl, Cap.sipTrunkVerifier],
    configSchema: { type: 'object', additionalProperties: false },
    bindingSchema: {
      type: 'object',
      required: ['trunkId'],
      properties: {
        trunkId: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
        fromNumbers: { type: 'array', items: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' } },
        cps: { type: 'number', exclusiveMinimum: 0 },
        outboundEnabled: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    secretFields: ['/credentialRef'],
    capabilities: sipCapabilities,
    meters: [
      {
        key: 'sip.carrier.audio_seconds',
        unit: 'audio_seconds',
        label: 'SIP trunk call audio',
        role: 'carrier',
      },
    ],
    runtime: { egressHosts: [] },
    conformance: ['carrier@1'],
    ui: {
      label: 'SIP trunk (OVO sip-gateway)',
      vendor: 'OVO',
      slot: 'carrier',
      docsUrl: 'docs/runbooks/sip-trunk-onboarding.md',
    },
  } as const,
  (ctx) => {
    ctx.provide(
      Cap.carrierControl,
      createSipControl({ client: () => ctx.maybe(Cap.sipTrunkControl), logger: ctx.logger }),
    );
    ctx.provide(
      Cap.carrierIngress,
      createSipCarrierIngress({
        verifier: () => ctx.maybe(Cap.sipTrunkVerifier),
        logger: ctx.logger,
      }),
    );
  },
);

export const plugins = [sipCarrierPlugin];
