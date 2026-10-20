import { createServer } from 'node:http';
import { handleDeskApi } from './fixtures/desk-api.mjs';
import { handleInspectorApi } from './fixtures/inspector-api.mjs';
import { handleRoutingApi } from './fixtures/routing-api.mjs';

const fixtureScenario = (request) =>
  /ovo_fixture=(rich|empty|down|disabled)/.exec(request.headers.cookie ?? '')?.[1] ?? 'rich';

const server = createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200);
    response.end('ok');
    return;
  }
  const scenario = fixtureScenario(request);
  // Routing and inspector first: the desk handler answers every other `/v1/*` GET with an empty page.
  if (await handleRoutingApi(request, response, scenario)) return;
  if (await handleInspectorApi(request, response, scenario)) return;
  if (await handleDeskApi(request, response, scenario)) return;
  if (request.url !== '/v1/auth/me') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found' } }));
    return;
  }
  const cookie = request.headers.cookie ?? '';
  const role = cookie.includes('ovo_session=admin')
    ? 'admin'
    : cookie.includes('ovo_session=editor')
      ? 'editor'
      : cookie.includes('ovo_session=viewer')
        ? 'viewer'
        : undefined;
  response.writeHead(role ? 200 : 401, { 'content-type': 'application/json' });
  response.end(
    role
      ? JSON.stringify({
          id: `fixture-${role}`,
          name: `Fixture ${role}`,
          role,
          workspaceId: 'fixture-workspace',
        })
      : JSON.stringify({ error: { code: 'unauthorized' } }),
  );
});
// The port is overridable so two checkouts can run their e2e suites on one machine.
server.listen(Number(process.env.OVO_E2E_API_PORT ?? 4177), '127.0.0.1');
