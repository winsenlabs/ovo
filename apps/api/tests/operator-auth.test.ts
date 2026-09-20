import { expect, it } from 'vitest';
import { bootstrapIdentitiesFromEnv } from '../src/auth-env.ts';
import { Authenticator } from '../src/auth-service.ts';

const environment = {
  OVO_ADMIN_TOKEN: 'a'.repeat(40),
  OVO_ADMIN_WORKSPACE_ID: 'installation',
  OVO_OPERATORS_JSON: JSON.stringify([
    { id: 'auditor', label: 'Auditor', role: 'viewer', tokenEnv: 'OVO_OPERATOR_AUDITOR_TOKEN' },
  ]),
  OVO_OPERATOR_AUDITOR_TOKEN: 'b'.repeat(40),
};

it('loads distinct operators into one installation namespace without token values in metadata', () => {
  const identities = bootstrapIdentitiesFromEnv(environment);
  expect(identities.map((identity) => identity.workspaces)).toEqual([
    { installation: 'admin' },
    { installation: 'viewer' },
  ]);
  expect(() =>
    bootstrapIdentitiesFromEnv({
      ...environment,
      OVO_OPERATOR_AUDITOR_TOKEN: environment.OVO_ADMIN_TOKEN,
    }),
  ).toThrow('distinct');
  expect(() =>
    bootstrapIdentitiesFromEnv({ ...environment, OVO_OPERATOR_AUDITOR_TOKEN: '' }),
  ).toThrow('32 characters');
  expect(() =>
    bootstrapIdentitiesFromEnv({ ...environment, OVO_OPERATORS_JSON: '{ secret-fragment' }),
  ).toThrow('valid operator metadata');
});

it('revokes existing sessions on operator token rotation and rejects malformed or inherited namespaces', () => {
  const identities = bootstrapIdentitiesFromEnv(environment);
  const options = { identities, sessionSecret: 'fixture-signing-secret' };
  const original = new Authenticator(options);
  const session = original.createSession(identities[1]!, 'installation');
  expect(original.fromSession(session)?.role).toBe('viewer');
  expect(() => original.createSession(identities[1]!, 'constructor')).toThrow('not authorized');
  expect(original.fromSession('bad.cookie')).toBeUndefined();
  const rotated = new Authenticator({
    ...options,
    identities: bootstrapIdentitiesFromEnv({
      ...environment,
      OVO_OPERATOR_AUDITOR_TOKEN: 'c'.repeat(40),
    }),
  });
  expect(rotated.fromSession(session)).toBeUndefined();
  const removed = new Authenticator({ ...options, identities: [identities[0]!] });
  expect(removed.fromSession(session)).toBeUndefined();
});
