import { carrier, hostFor, refused, routeOf } from './carrier-harness.ts';
import { PER_CALL_PURPOSES, type CarrierKitContext } from './carrier-support.ts';
import { Failures, type KitCheck } from './runner.ts';

/** Carrier checks on HTTP routes, upgrade auth and stream termination. */
export const CARRIER_ROUTE_CHECKS: readonly KitCheck<CarrierKitContext>[] = [
  {
    name: 'signature vectors accept valid and refuse tampered requests',
    async run(context) {
      const f = new Failures();
      const vectors = context.options.vectors;
      const all = [...(vectors?.http ?? []), ...(vectors?.upgrade ?? [])];
      if (!all.some((v) => v.valid) || !all.some((v) => !v.valid))
        return ['supply at least one valid and one invalid signature vector'];
      const { ingress } = await carrier(context);
      const host = hostFor(context);
      for (const [i, vector] of (vectors?.http ?? []).entries()) {
        const route = routeOf(ingress, vector.purpose);
        if (!f.expect(route, `no ${vector.purpose} route for vector ${vector.label ?? i}`))
          continue;
        const reply = await route!.handle(vector.request, host);
        f.expect(
          refused(reply) !== vector.valid,
          `http vector ${vector.label ?? i} (${vector.valid ? 'valid' : 'invalid'}) got ${reply.status}`,
        );
      }
      for (const [i, vector] of (vectors?.upgrade ?? []).entries()) {
        const result = await ingress.serializer.authenticateUpgrade(vector.request, {
          bindingId: context.options.binding.bindingId,
          resolveBinding: (id) => host.resolveBinding(id),
          verifyUrlSecret: ({ purpose, requestId, token }) =>
            host.verifyUrlSecret(
              {
                method: 'GET',
                externalUrl: vector.request.externalUrl,
                query: token ? { t: token } : {},
                headers: {},
                rawBody: new Uint8Array(0),
                bindingId: context.options.binding.bindingId,
              },
              { purpose, ...(requestId ? { requestId } : {}) },
            ),
        });
        f.expect(
          result.ok === vector.valid,
          `upgrade vector ${vector.label ?? i} expected ok=${vector.valid}`,
        );
      }
      return f.messages;
    },
  },
  {
    name: 'on-answer carriers stream via host.streamForDial and hang up when the route has ended',
    async run(context) {
      const { ingress } = await carrier(context);
      if (ingress.capabilities.control.streamParams !== 'on-answer') return [];
      const f = new Failures();
      const purpose = routeOf(ingress, 'answer') ? 'answer' : 'media-url';
      const route = routeOf(ingress, purpose);
      const request = context.options.requests?.[purpose];
      if (!route || !request)
        return [`on-answer carriers need an ${purpose} route and a signed request`];
      const host = hostFor(context);
      const reply = await route.handle(request, host);
      const call = host.calls.find((c) => c.method === 'streamForDial')?.args as
        { carrierId?: string; bindingId?: string } | undefined;
      f.expect(reply.status === 200, `${purpose} replied ${reply.status}`);
      f.expect(
        call?.carrierId === ingress.carrierId && call?.bindingId === request.bindingId,
        'host.streamForDial was not called for this binding',
      );
      f.expect(
        reply.body.includes(new URL(host.mediaUrl(ingress.carrierId, request.bindingId)).host),
        'the reply does not carry the granted media URL',
      );
      const ended = await route.handle(
        request,
        hostFor(context, { streamForDial: { kind: 'ended' } }),
      );
      f.expect(
        (context.options.hangupMarkup ?? /hangup/i).test(ended.body),
        "an 'ended' grant did not produce hang-up markup",
      );
      return f.messages;
    },
  },
  {
    /**
     * Mandatory, not opt-in: a carrier that omits `options.requests` used to get zero callback
     * authentication checks and pass (#F2). Every per-call route it exposes must be proven.
     */
    name: 'per-call routes verify the url-secret',
    async run(context) {
      const f = new Failures();
      const { ingress } = await carrier(context);
      const purposes = PER_CALL_PURPOSES.filter((purpose) => routeOf(ingress, purpose));
      if (!purposes.length)
        return ['no per-call route (status, answer, amd or resume) is exposed at all'];
      for (const purpose of purposes) {
        const route = routeOf(ingress, purpose)!;
        const request = context.options.requests?.[purpose];
        if (
          !f.expect(
            request,
            `supply options.requests.${purpose}: every per-call route must be url-secret checked`,
          )
        )
          continue;
        const host = hostFor(context);
        host.setVerifyUrlSecret(false);
        f.expect(
          refused(await route.handle(request!, host)),
          `${purpose} accepted a bad url-secret`,
        );
        const ok = hostFor(context);
        f.expect(!refused(await route.handle(request!, ok)), `${purpose} refused a valid request`);
        const verified = ok.calls.find((c) => c.method === 'verifyUrlSecret')?.args as
          { requestId?: string } | undefined;
        f.expect(
          verified?.requestId,
          `${purpose} did not verify a per-call (request-scoped) secret`,
        );
      }
      return f.messages;
    },
  },
];
