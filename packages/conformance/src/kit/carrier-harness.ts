import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import type { CarrierHttpReply, CarrierHttpRoute } from '@winsendotai/ovo-contracts';
import { createFakeCarrierHostPorts, type FakeHostPorts } from '../drivers/carrier-host-ports.ts';
import type { CarrierKitContext } from './carrier-support.ts';

export const hostFor = (context: CarrierKitContext): FakeHostPorts =>
  context.options.host?.() ??
  createFakeCarrierHostPorts({
    bindings: { [context.options.binding.bindingId]: context.options.binding },
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

export function routeOf(
  ingress: { routes: readonly CarrierHttpRoute[] },
  purpose: CarrierHttpRoute['purpose'],
) {
  return ingress.routes.find((route) => route.purpose === purpose);
}
