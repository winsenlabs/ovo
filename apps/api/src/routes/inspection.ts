import type { PriceCard } from '@winsendotai/ovo-plugin-observability';
import type { FastifyReply, FastifyRequest } from 'fastify';
export function registerInspectionRoutes(dependencies: any) {
  const {
    app,
    store,
    requireRole,
    queryPage,
    z,
    Id,
    error,
    UsageBody,
    priceUsage,
    summarizeUsage,
  } = dependencies;
  app.get('/v1/calls', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer'),
      page = queryPage(request);
    return store.listCalls(principal.workspaceId, page.limit, page.cursor);
  });
  app.get('/v1/calls/:callId', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { callId } = z.object({ callId: Id }).parse(request.params),
      call = store.getCall(principal.workspaceId, callId);
    return call ?? error(reply, 404, 'not_found', 'Call not found');
  });
  app.get('/v1/calls/:callId/events', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { callId } = z.object({ callId: Id }).parse(request.params);
    if (!store.getCall(principal.workspaceId, callId))
      return error(reply, 404, 'not_found', 'Call not found');
    return { items: store.listCallEvents(principal.workspaceId, callId), nextCursor: null };
  });
  app.post('/v1/calls/:callId/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin'),
      { callId } = z.object({ callId: Id }).parse(request.params);
    if (!store.getCall(principal.workspaceId, callId))
      return error(reply, 404, 'not_found', 'Call not found');
    const body = UsageBody.parse(request.body),
      priced = priceUsage(
        {
          id: body.id,
          workspaceId: principal.workspaceId,
          sessionId: callId,
          provider: body.provider,
          providerRequestId: body.providerRequestId,
          quantity: body.quantity,
          unit: body.unit,
          state: body.state,
        },
        body.priceCard as PriceCard,
      );
    const entry = store.addUsage({
      id: priced.id,
      workspaceId: principal.workspaceId,
      callId,
      provider: priced.provider,
      requestId: priced.providerRequestId,
      quantity: priced.quantity,
      unit: priced.unit,
      priceCardId: priced.priceCardId,
      priceCardVersion: priced.priceCardVersion,
      amountMinor: priced.amountMinor,
      currency: priced.currency,
      state: priced.state,
    });
    return reply.code(201).send(entry);
  });
  app.get('/v1/calls/:callId/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      { callId } = z.object({ callId: Id }).parse(request.params);
    if (!store.getCall(principal.workspaceId, callId))
      return error(reply, 404, 'not_found', 'Call not found');
    const items = store.listUsage(principal.workspaceId, callId),
      summary = summarizeUsage(
        items.map((item: any) => ({
          id: item.id,
          workspaceId: item.workspaceId,
          sessionId: item.callId,
          provider: item.provider,
          providerRequestId: item.requestId,
          quantity: item.quantity,
          unit: item.unit,
          state: item.state,
          amountMinor: item.amountMinor,
          currency: item.currency,
          priceCardId: item.priceCardId,
          priceCardVersion: item.priceCardVersion,
          rounding: 'half-up',
        })),
      );
    return { items, summary, nextCursor: null };
  });
  app.get('/v1/audit', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'admin'),
      page = queryPage(request);
    return store.listAudit(principal.workspaceId, page.limit, page.cursor);
  });
}
