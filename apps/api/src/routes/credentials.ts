import type { FastifyReply, FastifyRequest } from 'fastify';
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
  } = dependencies;
  app.get('/v1/credentials', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'admin');
    return { items: store.listCredentials(principal.workspaceId), nextCursor: null };
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
    store.audit({
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
      store.audit({
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
      store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'credential.retire',
        resourceType: 'credential',
        resourceId: credentialId,
        payload: { references: store.credentialReferences(principal.workspaceId, credentialId) },
      });
      return credential;
    },
  );

  app.get('/v1/provider-bindings', async (request: FastifyRequest) => {
    const principal = requireRole(request, 'viewer');
    return { items: store.listProviderBindings(principal.workspaceId), nextCursor: null };
  });
  app.post('/v1/provider-bindings', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'admin'),
      body = ProviderBindingBody.parse(request.body);
    rejectEmbeddedSecrets(body.config);
    const binding = store.createProviderBinding({ ...body, workspaceId: principal.workspaceId });
    store.audit({
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
    const binding = store.updateProviderBinding(principal.workspaceId, bindingId, body);
    store.audit({
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
      store.deleteProviderBinding(principal.workspaceId, bindingId);
      store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'provider-binding.delete',
        resourceType: 'provider-binding',
        resourceId: bindingId,
      });
      return reply.code(204).send();
    },
  );
}
