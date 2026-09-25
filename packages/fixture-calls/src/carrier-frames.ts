import type { CarrierIngress, CarrierMediaEvent } from '@winsendotai/ovo-contracts';
import { FIXTURE_CARRIER_ID, fixtureInboundFrame } from '@winsendotai/ovo-conformance/drivers';

/** The reference carrier's documented inbound frames; vendors supply their own fixture builder. */
export function fixtureCarrierInboundFrame(
  ingress: CarrierIngress,
): ((event: CarrierMediaEvent) => string) | undefined {
  return ingress.carrierId === FIXTURE_CARRIER_ID ? fixtureInboundFrame : undefined;
}
