import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildManagementApi } from '../src/bootstrap.ts';
import { UserDirectory } from '../src/user-directory.ts';
import { hashPassword, LoginThrottle, verifyPassword } from '../src/user-passwords.ts';

it('hashes passwords with unique salts and bounds login attempts', async () => {
  const first = await hashPassword('synthetic-password-one');
  const second = await hashPassword('synthetic-password-one');
  expect(first).not.toBe(second);
  expect(await verifyPassword('synthetic-password-one', first)).toBe(true);
  expect(await verifyPassword('incorrect', first)).toBe(false);
  const throttle = new LoginThrottle();
  expect(throttle.take('fixture', 1)).toBe(true);
  expect(throttle.take('fixture', 1)).toBe(false);
});

const url = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!url)('database team administration', () => {
  const organizationId = `team-test-${randomUUID()}`;
  const password = 'synthetic-first-admin-password';
  let pool: Pool;
  let directory: UserDirectory;
  let api: Awaited<ReturnType<typeof buildManagementApi>>;
  const login = async (email = 'admin@example.test', input = password) => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/session',
      payload: { email, password: input },
    });
    return { response, cookie: String(response.headers['set-cookie'] ?? '').split(';')[0]! };
  };
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    api = await buildManagementApi({
      identities: [
        {
          id: 'disabled-bootstrap',
          label: 'Installation',
          token: 'not-an-enabled-bootstrap-token-12345',
          authenticationDisabled: true,
          defaultWorkspaceId: organizationId,
          workspaces: { [organizationId]: 'admin' },
        },
      ],
      sessionSecret: 'synthetic-session-key-at-least-32-characters',
      storageAdapter: 'postgres',
      controlDatabaseUrl: url,
      secretBackend: 'encrypted-store',
      secretsMasterKey: 'ab'.repeat(32),
      requireTlsForSecrets: false,
      seedAdmin: { email: 'admin@example.test', password },
    });
    directory = new UserDirectory(pool, organizationId);
    await directory.initialize();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM ovo_team_users WHERE organization_id=$1', [organizationId]);
    await directory.create(
      { email: 'admin@example.test', label: 'Administrator', role: 'admin', password },
      true,
    );
  });
  afterAll(async () => {
    await api?.composition.dispose();
    if (pool) {
      await pool.query('DELETE FROM ovo_team_users WHERE organization_id=$1', [organizationId]);
      await pool.end();
    }
  });

  it('seeds once without resetting a changed password or enabling a bootstrap backdoor', async () => {
    await directory.create(
      {
        email: 'admin@example.test',
        label: 'Changed seed',
        role: 'admin',
        password: 'different-seed-password',
      },
      true,
    );
    expect((await login()).response.statusCode).toBe(200);
    expect((await login('admin@example.test', 'different-seed-password')).response.statusCode).toBe(
      401,
    );
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/session',
      payload: { token: 'not-an-enabled-bootstrap-token-12345' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates multiple administrators and normal users without returning password material', async () => {
    const { cookie } = await login();
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { cookie },
      payload: {
        email: 'SECOND@example.test',
        label: 'Second administrator',
        role: 'admin',
        password,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().email).toBe('second@example.test');
    expect(response.body).not.toContain(password);
    expect(response.body).not.toContain('password_hash');
    expect((await login('second@example.test')).response.statusCode).toBe(200);
    const duplicate = await api.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { cookie },
      payload: { email: 'second@example.test', label: 'Duplicate', role: 'admin', password },
    });
    expect(duplicate.statusCode).toBe(409);
    const user = await directory.create({
      email: 'user@example.test',
      label: 'User',
      role: 'editor',
      password,
    });
    expect(user?.role).toBe('editor');
    const member = await login('user@example.test');
    expect(
      (
        await api.app.inject({
          method: 'GET',
          url: '/v1/users',
          headers: { cookie: member.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('protects the last active admin and revokes sessions on disable/reset', async () => {
    const { cookie } = await login();
    const [first] = await directory.list();
    const last = await api.app.inject({
      method: 'PATCH',
      url: `/v1/users/${first!.id}`,
      headers: { cookie },
      payload: { disabled: true },
    });
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe('last_admin');
    const second = (await directory.create({
      email: 'second@example.test',
      label: 'Second',
      role: 'admin',
      password,
    }))!;
    const prior = await login('second@example.test');
    await directory.update(second.id, { password: 'replacement-fixture-password' });
    expect(
      (
        await api.app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { cookie: prior.cookie },
        })
      ).statusCode,
    ).toBe(401);
    const current = await login('second@example.test', 'replacement-fixture-password');
    expect(current.response.statusCode).toBe(200);
    await directory.update(second.id, { disabled: true });
    expect(
      (
        await api.app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { cookie: current.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await login('second@example.test', 'replacement-fixture-password')).response.statusCode,
    ).toBe(401);
  });

  it('requires explicit recovery and new credentials after a restore quarantine', async () => {
    const original = await login();
    await directory.create({
      email: 'second@example.test',
      label: 'Second',
      role: 'editor',
      password,
    });
    await pool.query(
      'UPDATE ovo_team_users SET disabled=true,restore_quarantined=true,session_version=session_version+1 WHERE organization_id=$1',
      [organizationId],
    );
    await directory.initialize({
      email: 'admin@example.test',
      label: 'Admin',
      role: 'admin',
      password,
    });
    expect((await login()).response.statusCode).toBe(401);
    await expect(
      directory.initialize(
        { email: 'admin@example.test', label: 'Admin', role: 'admin', password },
        true,
      ),
    ).rejects.toMatchObject({ code: 'restore_recovery_required' });
    const replacement = 'new-restore-administrator-password';
    await directory.initialize(
      { email: 'admin@example.test', label: 'Admin', role: 'admin', password: replacement },
      true,
    );
    expect((await login('admin@example.test', replacement)).response.statusCode).toBe(200);
    expect(
      (
        await api.app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { cookie: original.cookie },
        })
      ).statusCode,
    ).toBe(401);
    const second = (await directory.list()).find((user) => user.email === 'second@example.test')!;
    await expect(directory.update(second.id, { disabled: false })).rejects.toMatchObject({
      code: 'restore_recovery_required',
    });
    await directory.update(second.id, {
      disabled: false,
      password: 'new-restored-member-password',
    });
    expect(
      (await login('second@example.test', 'new-restored-member-password')).response.statusCode,
    ).toBe(200);
  });

  it('serializes concurrent admin demotions and checks the old password for self changes', async () => {
    const second = (await directory.create({
      email: 'second@example.test',
      label: 'Second',
      role: 'admin',
      password,
    }))!;
    const [first] = await directory.list();
    const results = await Promise.allSettled([
      directory.update(first!.id, { role: 'editor' }),
      directory.update(second.id, { role: 'editor' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await directory.list()).filter((user) => user.role === 'admin' && !user.disabled),
    ).toHaveLength(1);
    const { cookie } = await login();
    const bad = await api.app.inject({
      method: 'PATCH',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'wrong', newPassword: 'replacement-fixture-password' },
    });
    expect(bad.statusCode).toBe(401);
    const good = await api.app.inject({
      method: 'PATCH',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: password, newPassword: 'replacement-fixture-password' },
    });
    expect(good.statusCode).toBe(204);
    expect(
      (await api.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });
});
