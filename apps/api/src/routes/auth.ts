import type { FastifyReply, FastifyRequest } from 'fastify';
export function registerAuthRoutes(dependencies: any) {
  const { app, auth, error, options, publicIdentity, requireRole, z } = dependencies;
  app.get('/health', async () => ({ status: 'ok', storage: 'ok' }));
  app.post('/v1/auth/session', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = z
      .object({ token: z.string().min(1), workspaceId: z.string().min(1).optional() })
      .parse(request.body);
    const identity = auth.identityForToken(body.token);
    if (!identity) return error(reply, 401, 'invalid_credentials', 'Invalid bootstrap credential');
    const workspaceId = body.workspaceId ?? identity.defaultWorkspaceId,
      role = identity.workspaces[workspaceId];
    if (!role)
      return error(
        reply,
        403,
        'workspace_forbidden',
        'Identity is not authorized for that workspace',
      );
    const session = auth.createSession(identity, workspaceId),
      secure = process.env.NODE_ENV === 'production';
    reply.header(
      'set-cookie',
      `ovo_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${options.sessionTtlSeconds ?? 28_800}${secure ? '; Secure' : ''}`,
    );
    return { identity: { id: identity.id, label: identity.label, workspaceId, role } };
  });
  app.delete('/v1/auth/session', async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('set-cookie', 'ovo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
      .code(204)
      .send(),
  );
  app.get('/v1/auth/me', async (request: FastifyRequest) =>
    publicIdentity(requireRole(request, 'viewer')),
  );
}
