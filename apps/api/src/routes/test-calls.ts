import type { FastifyInstance } from 'fastify';

/** D1 fills this route after fixture-calls ships; no live provider path is exposed here. */
export function registerTestCallRoutes(input: { app: FastifyInstance }): void {
  input.app.post('/v1/test-calls', async (_request, reply) =>
    reply.code(404).send({ code: 'fixture_calls_disabled' }),
  );
}
