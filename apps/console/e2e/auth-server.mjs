import { createServer } from 'node:http';
const server = createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200); response.end('ok'); return; }
  if (request.url !== '/v1/auth/me') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found' } }));
    return;
  }
  const cookie = request.headers.cookie ?? '';
  const role = cookie.includes('ovo_session=admin') ? 'admin' : cookie.includes('ovo_session=editor') ? 'editor' : cookie.includes('ovo_session=viewer') ? 'viewer' : undefined;
  response.writeHead(role ? 200 : 401, { 'content-type': 'application/json' });
  response.end(role ? JSON.stringify({ id: `fixture-${role}`, name: `Fixture ${role}`, role, workspaceId: 'fixture-workspace' }) : JSON.stringify({ error: { code: 'unauthorized' } }));
});
server.listen(4177, '127.0.0.1');
