import type { FastifyReply, FastifyRequest } from 'fastify';
import { Cap, type CarrierIngress } from '@winsendotai/ovo-contracts';
import { createCarrierHostPorts } from '@winsendotai/ovo-session-host';
import { manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';

function selectedBindingPlugin(
  body: { provider: string; pluginId?: string | null; config: Record<string, unknown> },
  catalog: readonly PluginDefinition[],
) {
  const registry = new PluginRegistry(catalog);
  const matches = registry.list().filter((definition) => {
    const manifest = manifestKeys(definition.manifest).manifest;
    return manifest.kind !== 'infra' && manifest.provider === body.provider;
  });
  const ids = [...new Set(matches.map((definition) => definition.manifest.id))];
  const pluginId = body.pluginId ?? (ids.length === 1 ? ids[0] : null);
  if (pluginId) {
    const definition = registry.get(pluginId);
    if (!definition || manifestKeys(definition.manifest).manifest.provider !== body.provider)
      throw Object.assign(
        new Error(`Plugin ${pluginId} does not match provider ${body.provider}`),
        { statusCode: 400, code: 'binding_plugin_mismatch' },
      );
    const validation = registry.validateBinding(pluginId, body.config);
    if (!validation.ok)
      throw Object.assign(new Error(`Invalid binding for ${pluginId}: ${validation.errors}`), {
        statusCode: 400,
        code: 'binding_schema_invalid',
      });
    return { pluginId, kind: manifestKeys(definition.manifest).manifest.kind };
  }
  return { pluginId: null, kind: null };
}

export function registerCredentialsRoutes(dependencies: any) {
  const {
    app,
    store,
    secrets,
    requireRole,
    options,
    isTls,
    error,
    CredentialBody,
    z,
    Id,
    ProviderBindingBody,
    rejectEmbeddedSecrets,
    queryPage,
    catalog,
    ctx,
  } = dependencies;
  app.get('/v1/credentials', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'admin');
    const page = queryPage(request);
    return await store.listCredentials(principal.workspaceId, page.limit, page.cursor);
  });
  app.post('/v1/credentials', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin');
    if (options.requireTlsForSecrets && !isTls(request))
      return error(reply, 426, 'tls_required', 'Credential submission requires TLS');
    const body = CredentialBody.parse(request.body),
      credential = await secrets.create({
        ...body,
        workspaceId: principal.workspaceId,
        createdBy: principal.identityId,
      });
    await store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'credential.create',
      resourceType: 'credential',
      resourceId: credential.id,
      payload: { provider: body.provider, type: body.type, environment: body.environment },
    });
    return reply.code(201).send(credential);
  });
  app.post(
    '/v1/credentials/:credentialId/rotate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin');
      if (options.requireTlsForSecrets && !isTls(request))
        return error(reply, 426, 'tls_required', 'Credential submission requires TLS');
      const { credentialId } = z.object({ credentialId: Id }).parse(request.params),
        { value } = z.object({ value: z.string().min(1).max(100_000) }).parse(request.body),
        credential = await secrets.rotate(principal.workspaceId, credentialId, value);
      await store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'credential.rotate',
        resourceType: 'credential',
        resourceId: credentialId,
        payload: { version: credential.currentVersion },
      });
      return credential;
    },
  );
  app.post(
    '/v1/credentials/:credentialId/retire',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin'),
        { credentialId } = z.object({ credentialId: Id }).parse(request.params),
        credential = await secrets.retire(principal.workspaceId, credentialId);
      await store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'credential.retire',
        resourceType: 'credential',
        resourceId: credentialId,
        payload: {
          references: await store.credentialReferences(principal.workspaceId, credentialId),
        },
      });
      return credential;
    },
  );

  app.get('/v1/provider-bindings', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    const page = queryPage(request);
    return await store.listProviderBindings(principal.workspaceId, page.limit, page.cursor);
  });
  app.post('/v1/provider-bindings', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin'),
      body = ProviderBindingBody.parse(request.body);
    rejectEmbeddedSecrets(body.config);
    const selected = selectedBindingPlugin(body, catalog);
    const binding = await store.createProviderBinding({
      ...body,
      ...selected,
      workspaceId: principal.workspaceId,
    });
    await store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'provider-binding.create',
      resourceType: 'provider-binding',
      resourceId: binding.id,
      payload: {
        provider: body.provider,
        environment: body.environment,
        credentialId: body.credentialId,
      },
    });
    return reply.code(201).send(binding);
  });
  app.put('/v1/provider-bindings/:bindingId', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'admin'),
      { bindingId } = z.object({ bindingId: Id }).parse(request.params),
      body = ProviderBindingBody.parse(request.body);
    rejectEmbeddedSecrets(body.config);
    const selected = selectedBindingPlugin(body, catalog);
    const binding = await store.updateProviderBinding(principal.workspaceId, bindingId, {
      ...body,
      ...selected,
    });
    await store.audit({
      workspaceId: principal.workspaceId,
      actorId: principal.identityId,
      action: 'provider-binding.update',
      resourceType: 'provider-binding',
      resourceId: bindingId,
      payload: { credentialId: body.credentialId },
    });
    return binding;
  });
  app.delete(
    '/v1/provider-bindings/:bindingId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin'),
        { bindingId } = z.object({ bindingId: Id }).parse(request.params);
      await store.deleteProviderBinding(principal.workspaceId, bindingId);
      await store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'provider-binding.delete',
        resourceType: 'provider-binding',
        resourceId: bindingId,
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/provider-bindings/:id/carrier-urls',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin');
      const { id } = z.object({ id: Id }).parse(request.params);
      const binding = await store.getProviderBinding(principal.workspaceId, id);
      if (!binding) return error(reply, 404, 'not_found', 'Provider binding not found');
      const publicBaseUrl = options.carrierPublicBaseUrl ?? process.env.OVO_MEDIA_PUBLIC_BASE_URL;
      const routeSecret = options.inboundRouteSecret ?? process.env.OVO_INBOUND_ROUTE_SECRET;
      if (!publicBaseUrl || !routeSecret)
        return error(
          reply,
          409,
          'carrier_urls_unavailable',
          'OVO_MEDIA_PUBLIC_BASE_URL and OVO_INBOUND_ROUTE_SECRET are required for carrier URLs',
        );
      const ingress = ctx.all(Cap.carrierIngress).get(binding.provider) as
        CarrierIngress | undefined;
      if (!ingress)
        return error(
          reply,
          409,
          'carrier_ingress_unavailable',
          `Carrier ingress is not installed for ${binding.provider}`,
        );
      const ports = createCarrierHostPorts({
        publicBaseUrl,
        routeSecret,
        operations: {
          admitInbound: async () => {
            throw new Error('URL renderer cannot admit inbound calls');
          },
          confirmCallback: async () => {
            throw new Error('URL renderer cannot confirm callbacks');
          },
        },
        orchestration: {
          applyCallEvent: async () => {
            throw new Error('URL renderer cannot apply call events');
          },
        } as unknown as Parameters<typeof createCarrierHostPorts>[0]['orchestration'],
        bindings: async () => {
          throw new Error('URL renderer cannot resolve bindings');
        },
      });
      return {
        items: ingress.operatorUrls.map((item) => ({
          ...item,
          url:
            item.purpose === 'media' || item.purpose === 'media-url'
              ? ports.mediaUrl(ingress.carrierId, binding.id)
              : ports.callbackUrl(ingress.carrierId, binding.id, item.purpose),
        })),
      };
    },
  );
}
