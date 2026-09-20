import { LoginThrottle } from '../user-passwords.ts';
import { EmailInput } from '../user-plugin.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';
export function registerAuthRoutes(dependencies: any) {
  const { app, auth, error, options, publicIdentity, requireRole, z, users } = dependencies;
  const throttle = new LoginThrottle();
  app.get('/health', async () => ({ status: 'ok', storage: 'ok' }));
  app.post('/v1/auth/session', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!throttle.take(request.ip, 30))
      return error(
        reply,
        429,
        'rate_limited',
        'Too many sign-in attempts; try again in one minute',
      );
    const body = z
      .union([
        z.object({ email: EmailInput, password: z.string().min(1).max(128) }).strict(),
        z
          .object({
            token: z.string().min(1).max(4096),
            workspaceId: z.string().min(1).max(100).optional(),
          })
          .strict(),
      ])
      .parse(request.body);
    if ('password' in body && options.requireTlsForSecrets && request.protocol !== 'https')
      return error(reply, 426, 'tls_required', 'Password submission requires TLS');
    const identity =
      'email' in body
        ? await users?.authenticate(body.email, body.password)
        : auth.identityForToken(body.token);
    if (!identity) return error(reply, 401, 'invalid_credentials', 'Invalid credentials');
    const workspaceId =
        ('workspaceId' in body ? body.workspaceId : undefined) ?? identity.defaultWorkspaceId,
      role = Object.hasOwn(identity.workspaces, workspaceId)
        ? identity.workspaces[workspaceId]
        : undefined;
    if (!role)
      return error(
        reply,
        403,
        'workspace_forbidden',
        'Identity is not authorized for that workspace',
      );
    const session = auth.createSession(identity, workspaceId),
      secure = options.secureSessionCookies ?? process.env.NODE_ENV === 'production';
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
