import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import type { CarrierHttpReply, CarrierHttpRoute } from '@winsendotai/ovo-contracts';
import {
  createFakeCarrierHostPorts,
  type FakeHostPorts,
  type FakeHostPortsOptions,
} from '../drivers/carrier-host-ports.ts';
import type { CarrierKitContext } from './carrier-support.ts';

/** The kit's host ports, with per-check overrides (scripted grants, forced url-secret answers). */
export const hostFor = (
  context: CarrierKitContext,
  overrides: Partial<FakeHostPortsOptions> = {},
): FakeHostPorts =>
  context.options.host?.(overrides) ??
  createFakeCarrierHostPorts({
    bindings: { [context.options.binding.bindingId]: context.options.binding },
    ...overrides,
  });
export const refused = (reply: CarrierHttpReply) => reply.status === 401 || reply.status === 403;

export async function carrier(
  context: CarrierKitContext,
  scripts: Parameters<typeof createFixtureNet>[0] = [],
) {
  const net = createFixtureNet(scripts);
  const { control, ingress } = await context.factory({ net });
  return { net, control, ingress, telephony: control.create(context.options.binding) };
}

/**
 * Whether anything reached the NetPort. A request with no matching script never reaches the log,
 * it is recorded as a mismatch, so "no network" has to look at both.
 */
export const touchedNetwork = (net: ReturnType<typeof createFixtureNet>): boolean =>
  net.log.length > 0 || net.mismatches.length > 0;

export function routeOf(
  ingress: { routes: readonly CarrierHttpRoute[] },
  purpose: CarrierHttpRoute['purpose'],
) {
  return ingress.routes.find((route) => route.purpose === purpose);
}
