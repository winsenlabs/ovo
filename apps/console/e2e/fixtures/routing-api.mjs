// The routing fixture API (Wave 18), served by e2e/auth-server.mjs beside the session check. The
// scenario comes from the `ovo_fixture` cookie: `rich` (a published point, pools, clips, numbers),
// `empty` (nothing yet), `down` (every GET answers 503) and `disabled` (`routing_disabled`, and
// `human_queue_disabled` for the queue activity route). Writes are echoes, never shared state, so
// parallel browsers cannot disturb one another.
import { handleDeskApi } from './desk-api.mjs';
import {
  activity,
  agents,
  audio,
  draft,
  IDS,
  numbers,
  point,
  pools,
  QUEUE_ID_MAP,
  release,
  releases,
  stats,
  summaryOf,
  utilisation,
} from './routing-data.mjs';
import { simulate } from './routing-simulate.mjs';

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};
const error = (response, status, code, message) =>
  send(response, status, { error: { code, message } });
const readBody = (request) =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
const page = (items) => ({ items, nextCursor: null });

/** The desk fixture's queue list, with ids the routing contracts accept (UUIDs). */
async function queueList(request, scenario) {
  let captured = { status: 200, body: '{"items":[]}' };
  const fake = {
    writeHead: (status) => (captured.status = status),
    end: (body) => (captured.body = body),
  };
  await handleDeskApi(
    { url: '/v1/human-queues', method: 'GET', headers: request.headers },
    fake,
    scenario,
  );
  const parsed = JSON.parse(captured.body);
  if (captured.status !== 200) return { status: captured.status, body: parsed };
  parsed.items = parsed.items.map((q) => ({
    ...q,
    id: QUEUE_ID_MAP[q.id] ?? q.id,
    usedBy: scenario === 'empty' ? [] : [IDS.point],
  }));
  return { status: 200, body: parsed };
}

const publishPreview = () => ({
  issues: [
    {
      code: 'routing_member_meter_uncovered',
      severity: 'warning',
      path: ['nodes', 0, 'branches', 0, 'target'],
      message: 'Member sales-ta has no priced meter',
    },
  ],
  blockers: [],
  warnings: [
    {
      code: 'routing_member_meter_uncovered',
      severity: 'warning',
      path: ['nodes', 0, 'branches', 0, 'target'],
      message: 'Member sales-ta has no priced meter',
    },
  ],
  canPublish: true,
  nextVersion: 4,
  digest: 'd'.repeat(64),
  previous: {
    id: IDS.r3,
    version: 3,
    digest: 'c'.repeat(64),
    createdAt: '2026-10-12T09:00:00.000Z',
  },
  unchanged: false,
  changes: [
    {
      area: 'node',
      op: 'changed',
      key: 'node intent',
      path: ['nodes', 'intent'],
      summary: 'The question on intent changed',
    },
    {
      area: 'branch',
      op: 'added',
      key: 'branch intent > person',
      path: ['nodes', 'intent', 'branches', 'person'],
      summary: 'Added branch intent > person',
    },
    {
      area: 'queue',
      op: 'added',
      key: 'queue binding desk',
      path: ['humanQueues', 'desk'],
      summary: 'Added queue binding desk',
    },
  ],
  pins: [
    {
      path: ['router'],
      agentId: 'agent-front',
      was: 'latest',
      releaseId: 'f1111111-1111-4111-8111-111111111111',
    },
  ],
});

/** Answers a `/v1/routing/*` (and neighbouring) request; false when the path is not ours. */
export async function handleRoutingApi(request, response, scenario) {
  const url = new URL(request.url, 'http://fixture');
  const path = url.pathname;
  const method = request.method;
  const ours =
    /^\/v1\/(routing|agents|operations\/inbound\/routes)(\/|$)/.test(path) ||
    path === '/v1/human-queues' ||
    /^\/v1\/human-queues\/[^/]+\/activity$/.test(path);
  if (!ours) return false;
  const rich = scenario === 'rich';
  if (path === '/v1/routing/status')
    return (
      scenario === 'down'
        ? error(response, 503, 'unavailable', 'Routing is unavailable')
        : send(response, 200, {
            enabled: scenario !== 'disabled',
            externalEnabled: true,
            transferEnabled: true,
            humanQueueEnabled: scenario !== 'disabled',
            simulate: { enabled: true, liveLlm: false, liveExternal: false },
            evalRuns: true,
            outcomesAvailable: true,
          }),
      true
    );
  if (/^\/v1\/human-queues\/[^/]+\/activity$/.test(path)) {
    if (scenario === 'disabled')
      return (error(response, 404, 'human_queue_disabled', 'Human queues are not enabled'), true);
    if (scenario === 'down') return (error(response, 503, 'unavailable', 'Unavailable'), true);
    return (
      send(response, 200, activity(path.split('/')[3], url.searchParams.get('window') ?? '24h')),
      true
    );
  }
  if (path === '/v1/human-queues') {
    const { status, body } = await queueList(request, scenario);
    return (send(response, status, body), true);
  }
  if (path.startsWith('/v1/routing') && scenario === 'disabled')
    return (error(response, 404, 'routing_disabled', 'Routing is not enabled'), true);
  if (scenario === 'down' && method === 'GET')
    return (error(response, 503, 'unavailable', 'Service unavailable'), true);

  if (path === '/v1/agents') return (send(response, 200, page(rich ? agents() : [])), true);
  const agent = /^\/v1\/agents\/([^/]+)(?:\/(releases))?$/.exec(path);
  if (agent) {
    const found = agents().find((a) => a.id === agent[1]);
    if (agent[2])
      return (
        send(
          response,
          200,
          page(
            found
              ? [
                  {
                    id: `f${agent[1].length}111111-1111-4111-8111-111111111111`,
                    version: 2,
                    createdAt: '2026-10-01T09:00:00.000Z',
                  },
                ]
              : [],
          ),
        ),
        true
      );
    return found
      ? (send(response, 200, found), true)
      : (error(response, 404, 'not_found', 'Agent missing'), true);
  }
  if (path === '/v1/operations/inbound/routes') {
    return (send(response, 200, page(rich ? numbers() : [])), true);
  }
  const bind = /^\/v1\/operations\/inbound\/routes\/([^/]+)$/.exec(path);
  if (bind && method === 'PUT') {
    const body = await readBody(request);
    const rel = releases().find((r) => r.id === body.routingReleaseId);
    const row =
      numbers().find((n) => n.phoneNumber === decodeURIComponent(bind[1])) ?? numbers()[0];
    return (
      send(response, 200, {
        ...row,
        releaseId: null,
        routingReleaseId: body.routingReleaseId,
        routing: { pointId: IDS.point, pointName: 'Main line', version: rel?.version ?? 3 },
        version: (body.expectedVersion ?? 1) + 1,
      }),
      true
    );
  }

  if (path === '/v1/routing/stats') {
    const window = url.searchParams.get('window') ?? '24h';
    if (!rich)
      return (
        send(response, 200, {
          ...stats(window),
          series: [],
          totals: {
            ...stats(window).totals,
            routed: 0,
            withFallback: 0,
            reachedPerson: 0,
            routeMsP50: null,
            routeMsP95: null,
            byTarget: { agent: 0, human: 0, end: 0, callback: 0 },
          },
        }),
        true
      );
    return (send(response, 200, stats(window)), true);
  }
  if (path === '/v1/routing/points' && method === 'GET')
    return (
      send(
        response,
        200,
        page(
          rich
            ? [point(IDS.point), point(IDS.point2)].map((p) =>
                url.searchParams.get('include') === 'summary' ? { ...p, summary: summaryOf(p) } : p,
              )
            : [],
        ),
      ),
      true
    );
  if (path === '/v1/routing/points' && method === 'POST') {
    const body = await readBody(request);
    return (
      send(
        response,
        201,
        { ...point(IDS.point), id: IDS.point2, draft: body.draft, draftVersion: 1 },
        { etag: '"1"' },
      ),
      true
    );
  }
  const pointRoute =
    /^\/v1\/routing\/points\/([^/]+)(?:\/(validate|preview-publish|releases))?$/.exec(path);
  if (pointRoute) {
    const [, id, sub] = pointRoute;
    if (!rich || (id !== IDS.point && id !== IDS.point2))
      return (error(response, 404, 'routing_point_not_found', 'Routing point not found'), true);
    if (!sub && method === 'GET')
      return (send(response, 200, point(id), { etag: `"${point(id).draftVersion}"` }), true);
    if (!sub && method === 'PUT') {
      const body = await readBody(request);
      const expected = Number(String(request.headers['if-match'] ?? '"0"').replaceAll('"', ''));
      if (expected === 1)
        return (
          send(response, 409, {
            error: { code: 'routing_point_conflict', message: 'Routing point state changed' },
            current: {
              ...point(id),
              draftVersion: 5,
              draft: { ...draft(), greeting: { en: 'Welcome. Changed by a teammate.' } },
            },
          }),
          true
        );
      return (
        send(
          response,
          200,
          { ...point(id), draft: body.draft, draftVersion: expected + 1, issues: [] },
          { etag: `"${expected + 1}"` },
        ),
        true
      );
    }
    if (sub === 'validate') return (send(response, 200, { issues: publishPreview().issues }), true);
    if (sub === 'preview-publish') return (send(response, 200, publishPreview()), true);
    if (sub === 'releases' && method === 'POST')
      return (
        send(response, 201, {
          ...release(IDS.r3),
          id: 'c4444444-4444-4444-8444-444444444444',
          version: 4,
          digest: 'd'.repeat(64),
          warnings: [],
        }),
        true
      );
    if (sub === 'releases') return (send(response, 200, page(releases())), true);
  }
  const rel = /^\/v1\/routing\/releases\/([^/]+)$/.exec(path);
  if (rel) return (send(response, 200, release(rel[1])), true);

  if (path === '/v1/routing/pools' && method === 'GET')
    return (send(response, 200, page(rich ? pools() : [])), true);
  if (path === '/v1/routing/pools' && method === 'POST') {
    const body = await readBody(request);
    return (
      send(
        response,
        201,
        { ...pools()[0], id: IDS.support, definition: body.definition, version: 1 },
        { etag: '"1"' },
      ),
      true
    );
  }
  if (path === '/v1/routing/pools/explain') {
    const body = await readBody(request);
    const pool = pools().find((p) => p.id === body.poolId) ?? pools()[0];
    const wanted = body.context?.language ?? null;
    const members = pool.definition.members.map((m, i) => {
      const languageOk = !wanted || m.languages.includes(wanted);
      const reasons = [!m.enabled && 'disabled', !languageOk && 'language'].filter(Boolean);
      return {
        memberId: m.id,
        agentId: m.agent.agentId,
        releaseId: IDS.r1,
        priority: m.priority,
        enabled: m.enabled,
        open: true,
        productOk: true,
        skillsOk: true,
        languageOk,
        eligible: reasons.length === 0,
        tier: reasons.length ? null : 0,
        active: i * 3,
        capacity: m.capacity ?? null,
        full: false,
        picked: false,
        reasons,
      };
    });
    const first = members.find((m) => m.eligible);
    if (first) first.picked = true;
    return (
      send(response, 200, {
        poolId: pool.id,
        poolName: pool.definition.name,
        wanted: {
          language: wanted,
          languageMode: body.target?.language ?? 'caller',
          products: body.target?.products?.values ?? null,
          skills: body.target?.skills ?? [],
        },
        languageUsed: wanted,
        members,
        result: first ? 'picked' : 'no_eligible_member',
      }),
      true
    );
  }
  if (path === '/v1/routing/utilisation')
    return (send(response, 200, { pools: pools().map((p) => utilisation(p.id)) }), true);
  const poolRoute = /^\/v1\/routing\/pools\/([^/]+)(?:\/(utilisation))?$/.exec(path);
  if (poolRoute) {
    const found = pools().find((p) => p.id === poolRoute[1]);
    if (!rich || !found)
      return (error(response, 404, 'routing_pool_not_found', 'Pool not found'), true);
    if (poolRoute[2]) return (send(response, 200, utilisation(found.id)), true);
    if (method === 'GET') return (send(response, 200, found, { etag: `"${found.version}"` }), true);
    if (method === 'PUT') {
      const body = await readBody(request);
      return (
        send(
          response,
          200,
          { ...found, definition: body.definition, version: found.version + 1 },
          { etag: `"${found.version + 1}"` },
        ),
        true
      );
    }
    return (response.writeHead(204), response.end(), true);
  }
  if (path === '/v1/routing/audio' && method === 'GET')
    return (send(response, 200, page(rich ? audio() : [])), true);
  if (path === '/v1/routing/audio' && method === 'POST') {
    await readBody(request);
    return (
      send(response, 201, {
        ...audio()[0],
        id: 'd3333333-3333-4333-8333-333333333333',
        name: url.searchParams.get('name') ?? 'New clip',
      }),
      true
    );
  }
  const clip = /^\/v1\/routing\/audio\/([^/]+)(\/content)?$/.exec(path);
  if (clip) {
    if (clip[2]) {
      const wav = Buffer.alloc(44);
      wav.write('RIFF', 0);
      wav.write('WAVE', 8);
      response.writeHead(200, { 'content-type': 'audio/wav', 'x-content-type-options': 'nosniff' });
      return (response.end(wav), true);
    }
    return method === 'DELETE'
      ? (response.writeHead(204), response.end(), true)
      : (send(response, 200, { ...audio().find((a) => a.id === clip[1]), usedBy: [IDS.point] }),
        true);
  }
  if (path === '/v1/routing/simulate' && method === 'POST') {
    const body = await readBody(request);
    return (send(response, 200, simulate(body)), true);
  }
  return false;
}
