import { carrier, hostFor, touchedNetwork } from './carrier-harness.ts';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { CARRIER_CONTROL_CHECKS } from './carrier-control-checks.ts';
import { CARRIER_INGRESS_CHECKS } from './carrier-ingress-checks.ts';
import { CARRIER_MEDIA_CHECKS } from './carrier-media-checks.ts';
import { CARRIER_ROUTE_CHECKS } from './carrier-route-checks.ts';
import { CARRIER_STATUS_CHECKS } from './carrier-status.ts';
import { baseDial, commandOf, eventsOf, same, type CarrierKitContext } from './carrier-support.ts';
import { Failures, type KitCheck } from './runner.ts';

export * from './carrier-support.ts';

const carrierChecks: readonly KitCheck<CarrierKitContext>[] = [
  {
    name: 'control and ingress declare the same capabilities',
    async run(context) {
      const { control, ingress } = await carrier(context);
      const f = new Failures();
      f.expect(
        ingress.carrierId === ingress.capabilities.carrierId,
        'ingress.carrierId differs from its capabilities',
      );
      f.expect(
        same(control.capabilities, ingress.capabilities),
        'control and ingress capabilities differ',
      );
      return f.messages;
    },
  },
  {
    name: 'jsonl transcripts run through the MediaSerializer and MediaCodecSession',
    async run(context) {
      const f = new Failures();
      const transcripts = context.options.transcripts ?? [];
      if (!transcripts.length) return ['no jsonl protocol transcripts were supplied'];
      const { ingress } = await carrier(context);
      for (const { fixture, params } of transcripts) {
        const session = ingress.serializer.createSession(params ?? {});
        fixture.lines.forEach((line, index) => {
          const where = `${fixture.name} line ${index + 2}`;
          try {
            if (line.dir === 'in') {
              const events = session.decode(JSON.stringify(line.frame));
              if (line.events)
                f.expect(same(events, eventsOf(line.events)), `${where}: decoded events differ`);
            } else if (line.command) {
              const frames = [
                ...(line.flush ? session.flush() : []),
                ...session.encode(commandOf(line.command)),
              ];
              f.expect(
                frames.some((frame) => same(JSON.parse(frame), line.frame)),
                `${where}: encoded frame differs`,
              );
            }
          } catch (error) {
            f.add(`${where}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
      return f.messages;
    },
  },
  {
    name: 'dial rejects a non-wss or query-bearing media URL without any REST call',
    async run(context) {
      const f = new Failures();
      const { net, telephony, ingress } = await carrier(context);
      const caps = ingress.capabilities;
      const host = hostFor(context);
      const base = baseDial(
        host,
        caps.carrierId,
        context.options.binding,
        caps.control.streamParams === 'at-dial',
        caps.media.formats[0]!,
      );
      const cases = [base.media.url.replace(/^wss:/, 'https:'), `${base.media.url}?sid=session-1`];
      for (const url of cases) {
        const result = await telephony.dial({ ...base, media: { ...base.media, url } });
        f.expect(
          result.kind === 'rejected' && !result.retryable,
          `dial(${url}) returned ${JSON.stringify(result)}`,
        );
      }
      f.expect(!touchedNetwork(net), 'dial reached the network for an invalid media URL');
      return f.messages;
    },
  },
  {
    name: 'REST shapes replay strictly against FixtureNet',
    async run(context) {
      const f = new Failures();
      const rest = context.options.rest;
      if (!rest) return ['no REST fixture scripts were supplied'];
      const dialNet = await carrier(context, rest.dial.scripts);
      const caps = dialNet.ingress.capabilities;
      const base = baseDial(
        hostFor(context),
        caps.carrierId,
        context.options.binding,
        caps.control.streamParams === 'at-dial',
        caps.media.formats[0]!,
      );
      const result = await dialNet.telephony.dial({ ...base, ...rest.dial.request });
      f.expect(
        result.kind === (rest.dial.expect ?? 'accepted'),
        `dial returned ${JSON.stringify(result)}`,
      );
      f.add(
        ...dialNet.net.mismatches.map((e) => e.message),
        ...dialNet.net.pending().map((p) => `dial: unconsumed ${p.description}`),
      );
      if (rest.hangup) {
        const hangup = await carrier(context, rest.hangup.scripts);
        const outcome = await hangup.telephony.hangup(rest.hangup.query);
        f.expect(outcome === rest.hangup.expect, `hangup returned ${outcome}`);
        f.add(
          ...hangup.net.mismatches.map((e) => e.message),
          // A hangup that never reaches the carrier is a lie, however it answers (#F1).
          ...hangup.net.pending().map((p) => `hangup: unconsumed ${p.description}`),
        );
      }
      return f.messages;
    },
  },
  {
    name: 'carriers that cancel before answer hang up by request id',
    async run(context) {
      const { ingress } = await carrier(context);
      if (!ingress.capabilities.control.cancelBeforeAnswer) return [];
      const cancel = context.options.rest?.cancel;
      if (!cancel) return ['cancelBeforeAnswer carriers must supply rest.cancel scripts'];
      const run = await carrier(context, cancel.scripts);
      const outcome = await run.telephony.hangup({ carrierRequestId: cancel.carrierRequestId });
      const f = new Failures();
      f.expect(outcome === 'ended', `hangup by request id returned ${outcome}`);
      f.add(
        ...run.net.mismatches.map((e) => e.message),
        ...run.net.pending().map((p) => `cancel: unconsumed ${p.description}`),
      );
      return f.messages;
    },
  },
  ...CARRIER_ROUTE_CHECKS,
  ...CARRIER_STATUS_CHECKS,
  ...CARRIER_CONTROL_CHECKS,
  ...CARRIER_INGRESS_CHECKS,
  ...CARRIER_MEDIA_CHECKS,
];

/** Keep the egress guard active across the factory, REST call and ingress route for every check. */
export const CARRIER_CHECKS: readonly KitCheck<CarrierKitContext>[] = carrierChecks.map(
  (check) => ({
    ...check,
    async run(context, signal) {
      return withEgressSentinel(async (sentinel) => {
        const failures = await check.run(context, signal);
        return [
          ...(failures ?? []),
          ...sentinel.attempts.map((attempt) => `network bypassed the NetPort: ${attempt}`),
        ];
      });
    },
  }),
);
