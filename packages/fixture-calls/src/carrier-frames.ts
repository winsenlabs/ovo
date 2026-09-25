import type { CarrierIngress, CarrierMediaEvent } from '@winsendotai/ovo-contracts';
import { FIXTURE_CARRIER_ID, fixtureInboundFrame } from '@winsendotai/ovo-conformance/drivers';

/** The selected ingress owns the wire encoder; each call gets a fresh encoder instance. */
export function fixtureCarrierInboundFrame(
  ingress: CarrierIngress,
): ((event: CarrierMediaEvent) => string) | undefined {
  const create = (ingress as CarrierIngress & { createFixtureFrameEncoder?: () => unknown })
    .createFixtureFrameEncoder;
  if (typeof create === 'function') {
    const encoder = create.call(ingress);
    if (typeof encoder !== 'function')
      throw new Error(`fixture_unavailable: ${ingress.carrierId} fixture encoder is invalid`);
    return encoder as (event: CarrierMediaEvent) => string;
  }
  return ingress.carrierId === FIXTURE_CARRIER_ID ? fixtureInboundFrame : undefined;
}
