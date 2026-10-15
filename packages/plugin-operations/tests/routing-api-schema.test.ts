import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { operationsApiSchemas } from '../src/index.ts';

describe('inbound route body (Wave 15 target union)', () => {
  const base = { expectedVersion: null };

  it('takes exactly one of releaseId and routingReleaseId', () => {
    expect(
      operationsApiSchemas.inboundRoute.parse({ ...base, releaseId: randomUUID() }),
    ).toMatchObject({
      enabled: true,
      variables: {},
    });
    const routingReleaseId = randomUUID();
    expect(operationsApiSchemas.inboundRoute.parse({ ...base, routingReleaseId })).toMatchObject({
      routingReleaseId,
    });
    for (const body of [
      base,
      { ...base, releaseId: randomUUID(), routingReleaseId: randomUUID() },
      { ...base, routingReleaseId: 'latest' },
    ])
      expect(operationsApiSchemas.inboundRoute.safeParse(body).success).toBe(false);
    expect(
      operationsApiSchemas.inboundRoute.safeParse(base).error?.issues.map((issue) => issue.message),
    ).toContain('Give exactly one of releaseId or routingReleaseId');
  });

  it('still caps variables at 50', () => {
    const variables = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, 'x']));
    expect(
      operationsApiSchemas.inboundRoute.safeParse({ ...base, releaseId: randomUUID(), variables })
        .success,
    ).toBe(false);
  });
});
