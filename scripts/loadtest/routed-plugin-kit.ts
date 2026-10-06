// plugin-kit for load-test processes: identical, except that `createNodeNet` sends each provider
// host to its loopback fake (OVO_LOADTEST_ROUTES, host → origin JSON) through the real net, TLS
// verification and address guard included. A host without a route is refused, so a load run can
// never reach a real provider.
import { createNodeNet as productionNet } from '../../packages/plugin-kit/src/index.ts';
import { routedNodeNet } from '../../tests/e2e/support/routed-net.ts';

export * from '../../packages/plugin-kit/src/index.ts';

export const createNodeNet = (() => {
  const routes = new Map(
    Object.entries(JSON.parse(process.env.OVO_LOADTEST_ROUTES ?? '{}') as Record<string, string>),
  );
  return routedNodeNet(productionNet, routes)();
}) as unknown as typeof productionNet;
