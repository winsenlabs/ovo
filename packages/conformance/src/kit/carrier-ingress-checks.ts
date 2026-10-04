import type { CallState } from '@winsendotai/ovo-contracts';
import { carrier, hostFor, routeOf } from './carrier-harness.ts';
import type { CarrierKitContext } from './carrier-support.ts';
import { Failures, type KitCheck } from './runner.ts';

const STATES: readonly CallState[] = [
  'queued',
  'ringing',
  'in_progress',
  'completed',
  'busy',
  'no_answer',
  'failed',
  'canceled',
];

/** The ingress routes the host depends on: resume continuation and status normalisation (#F7). */
export const CARRIER_INGRESS_CHECKS: readonly KitCheck<CarrierKitContext>[] = [
  {
    name: 'the resume route re-issues a stream through host.resumeStream',
    async run(context) {
      const { ingress } = await carrier(context);
      const route = routeOf(ingress, 'resume');
      if (ingress.capabilities.continuation !== 'markup-after-stream' && !route) return [];
      if (!route) return ["markup-after-stream carriers must expose a 'resume' route"];
      const request = context.options.requests?.resume;
      if (!request) return ['supply options.requests.resume: the resume route must be checked'];
      const f = new Failures();
      const mediaUrl = hostFor(context).mediaUrl(ingress.carrierId, request.bindingId);
      const host = hostFor(context, {
        resumeStream: {
          kind: 'stream',
          mediaUrl,
          routeParams: { sid: 'session-resume', rt: 'route-token-resume' },
        },
      });
      const reply = await route.handle(request, host);
      f.expect(reply.status === 200, `resume replied ${reply.status}`);
      const call = host.calls.find((c) => c.method === 'resumeStream')?.args as
        { carrierId?: string; bindingId?: string } | undefined;
      f.expect(
        call?.carrierId === ingress.carrierId && call?.bindingId === request.bindingId,
        'host.resumeStream was not called for this binding',
      );
      f.expect(
        reply.body.includes(new URL(mediaUrl).host),
        'the resume reply does not carry the re-issued media URL',
      );
      const ended = await route.handle(
        request,
        hostFor(context, { resumeStream: { kind: 'ended' } }),
      );
      f.expect(
        (context.options.hangupMarkup ?? /hangup/i).test(ended.body),
        "an 'ended' resume did not produce hang-up markup",
      );
      return f.messages;
    },
  },
  {
    name: 'the status route normalises into host.applyCallEvent',
    async run(context) {
      const { ingress } = await carrier(context);
      const route = routeOf(ingress, 'status');
      if (!route) return ["carriers must expose a 'status' route"];
      const request = context.options.requests?.status;
      if (!request) return ['supply options.requests.status: the status route must be checked'];
      const f = new Failures();
      const host = hostFor(context);
      const reply = await route.handle(request, host);
      f.expect(
        reply.status >= 200 && reply.status < 300,
        `the signed status callback replied ${reply.status}`,
      );
      if (!f.expect(host.events.length === 1, `status produced ${host.events.length} call events`))
        return f.messages;
      const event = host.events[0]!;
      f.expect(
        event.carrierId === ingress.carrierId,
        `the call event carrierId is ${event.carrierId}`,
      );
      f.expect(
        event.bindingId === request.bindingId,
        `the call event bindingId is ${event.bindingId}`,
      );
      f.expect(
        typeof event.eventId === 'string' && event.eventId.length > 0,
        'the call event has no eventId to deduplicate on',
      );
      f.expect(
        STATES.includes(event.state),
        `the call event state ${event.state} is not a CallState`,
      );
      f.expect(
        event.occurredAt instanceof Date && !Number.isNaN(event.occurredAt.getTime()),
        'the call event occurredAt is not a Date',
      );
      const replay = hostFor(context);
      await route.handle(request, replay);
      f.expect(
        replay.events[0]?.eventId === event.eventId,
        'replaying the same status callback produced a different eventId',
      );
      return f.messages;
    },
  },
];
