import {
  Cap,
  type EndReason,
  type RoutingHost,
  type RoutingReleaseSnapshot,
  type SegmentHandoffPort,
} from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { SegmentGraphShape } from './segment-ids.ts';

/** The host service offering the router behaviour its routing host and the handoff seam. */
export const ROUTING_HOST_SERVICE_ID = '@winsendotai/ovo-host-routing';

export function routingHostService(
  host: RoutingHost,
  handoff: SegmentHandoffPort,
): PluginDefinition {
  return definePlugin(
    {
      id: ROUTING_HOST_SERVICE_ID,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [],
      provides: [Cap.routing, Cap.segmentHandoff],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.routing, host);
      ctx.provide(Cap.segmentHandoff, handoff);
    },
  );
}

/**
 * Segment 0 of a routed call (routing design 7.3): the router release's graph (its engine, STT,
 * TTS, LLM, decision slot, turn detector and language) with its behaviour replaced by the router,
 * which reads the routing snapshot and the two host capabilities. The router release's own prompt,
 * opening and tools do not run.
 */
export function routerSegmentShape(input: {
  behavior: PluginDefinition;
  routerRelease: ReleaseRecord;
  snapshot: RoutingReleaseSnapshot;
  sessionId: string;
  host: RoutingHost;
  handoff: SegmentHandoffPort;
}): SegmentGraphShape {
  const { routerRelease } = input;
  return {
    behavior: {
      definition: input.behavior,
      config: {
        agent: structuredClone(routerRelease.config),
        workspaceId: routerRelease.workspaceId,
        sessionId: input.sessionId,
        routing: input.snapshot,
      },
    },
    services: [routingHostService(input.host, input.handoff)],
  };
}

/**
 * Segment 0's hang-up (or carrier transfer) with the router release, except while the call is
 * handing off: then the router's engine ending must leave the carrier leg to the next segment.
 */
export function routerMediaClose(
  handingOff: () => boolean,
  close: ((reason: EndReason) => Promise<void>) | undefined,
): (reason: EndReason) => Promise<void> {
  return async (reason) => {
    if (!handingOff()) await close?.(reason);
  };
}
