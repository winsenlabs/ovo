import { LoginThrottle } from '../user-passwords.ts';
import { EmailInput } from '../user-plugin.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LoginLockout } from '../auth-login-limiter.ts';
import { PASSWORD_ISSUE_TEXT, passwordIssues } from '../auth-password-policy.ts';
import { PASSWORD_CHANGE_SESSION_SECONDS } from '../auth-env.ts';

/** HttpOnly, SameSite=Strict, and Secure whenever configured, in production or over HTTPS. */
function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `ovo_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function registerAuthRoutes(dependencies: any) {
  const { app, auth, error, options, publicIdentity, requireRole, z, users } = dependencies;
  const throttle = new LoginThrottle();
  const lockout = new LoginLockout();
  const secureCookie = (request: FastifyRequest) =>
    options.secureSessionCookies ??
    (process.env.NODE_ENV === 'production' || request.protocol === 'https');
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
    const account = 'email' in body ? `email:${body.email}` : undefined;
    const locked = account ? lockout.retryAfterSeconds(account) : 0;
    if (locked)
      return error(
        reply.header('retry-after', String(locked)),
        429,
        'account_locked',
        `Too many failed sign-ins for this account; try again in ${Math.ceil(locked / 60)} minutes`,
      );
    const identity =
      'email' in body
        ? await users?.authenticate(body.email, body.password)
        : auth.identityForToken(body.token);
    if (!identity) {
      if (account) lockout.failed(account);
      return error(reply, 401, 'invalid_credentials', 'Invalid credentials');
    }
    if (account) lockout.succeeded(account);
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
    // OPS-15: a password that fails the policy, or is still the bootstrap one in the server
    // environment, signs in only to change it, on a short session.
    const issues =
      'password' in body
        ? passwordIssues(body.password, {
            email: body.email,
            seedPassword: process.env.OVO_SEED_ADMIN_PASSWORD,
          })
        : [];
    const passwordChangeRequired = issues.length > 0;
    const ttlSeconds = passwordChangeRequired
      ? Math.min(PASSWORD_CHANGE_SESSION_SECONDS, auth.sessionTtlSeconds)
      : auth.sessionTtlSeconds;
    const session = auth.createSession(identity, workspaceId, {
      passwordChangeRequired,
      ttlSeconds,
    });
    reply.header('set-cookie', sessionCookie(session, ttlSeconds, secureCookie(request)));
    return {
      identity: { id: identity.id, label: identity.label, workspaceId, role },
      ...(passwordChangeRequired
        ? {
            passwordChangeRequired: true,
            passwordIssues: issues.map((code) => ({ code, message: PASSWORD_ISSUE_TEXT[code] })),
          }
        : {}),
    };
  });
  app.delete('/v1/auth/session', async (request: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('set-cookie', sessionCookie('', 0, secureCookie(request)))
      .code(204)
      .send(),
  );
  app.get('/v1/auth/me', async (request: FastifyRequest) =>
    publicIdentity(requireRole(request, 'viewer')),
  );
}
