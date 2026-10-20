import { describe, expect, it, vi } from 'vitest';
import {
  ROUTING_EVAL_LIMITS,
  RoutingEvalRun,
  RoutingEvalRunSummary,
  type RoutingEvalCase,
} from '@winsendotai/ovo-contracts';
import { SALES_HI_RELEASE } from './routing-fixtures.ts';
import { publishPoint, r4Setup, scorecardFor, scriptedSimulator } from './routing-sim-fixtures.ts';

const viewer = { 'x-role': 'viewer' };
const cases = (count = 3): Pick<RoutingEvalCase, 'id' | 'turns' | 'expect'>[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `case-${index}`,
    turns: [{ kind: 'speech', text: 'sales please' }],
    expect: { status: 'agent' },
  }));

async function ready(options: Parameters<typeof r4Setup>[0] = {}) {
  const simulator = scriptedSimulator();
  const built = await r4Setup({ simulator, ...options });
  const made = await publishPoint(built.call);
  const create = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    built.call(
      'POST',
      '/v1/routing/eval-runs',
      { routingReleaseId: made.release.id, name: 'Nightly', cases: cases(), ...body },
      headers,
    );
  return { ...built, ...made, simulator, create };
}

describe('POST /v1/routing/eval-runs (R4)', () => {
  it('scores the corpus against the release and keeps the run with its scorecard', async () => {
    const { create, simulator, point, release, store } = await ready();
    const response = await create({ assume: { transferEnabled: true } });
    expect(response.statusCode, response.body).toBe(201);
    const run = RoutingEvalRun.parse(response.json());
    expect(run).toMatchObject({
      name: 'Nightly',
      routingReleaseId: release.id,
      routingPointId: point.id,
      releaseVersion: 1,
      engineMode: 'recorded',
      caseCount: 3,
      createdBy: 'operator',
      headline: { passed: 2, total: 3 },
    });
    // The scorecard names the release that was scored.
    expect(run.scorecard.routing).toEqual({
      pointId: point.id,
      routingReleaseId: release.id,
      digest: release.digest,
    });
    expect(run.scorecard.corpus.name).toBe('Nightly');
    expect(run.corpusDigest).toBe(simulator.routingCorpusDigest(simulator.calls.score[0]!.cases));
    const scored = simulator.calls.score[0]!;
    expect(scored).toMatchObject({
      name: 'Nightly',
      engineMode: 'recorded',
      flags: { transferEnabled: true, humanQueueEnabled: false },
      routingReleaseId: release.id,
    });
    expect(scored.snapshot.routingPointId).toBe(point.id);
    expect(scored.router.timezone).toBe('Asia/Kolkata');
    expect(scored.cases.map((found) => found.id)).toEqual(['case-0', 'case-1', 'case-2']);
    // Defaults were applied before scoring.
    expect(scored.cases[0]).toMatchObject({ tags: [], answers: [], call: { variables: {} } });
    const audit = store.audits.find((entry) => entry.action === 'routing.eval_run.create')!;
    expect(audit).toMatchObject({
      resourceType: 'routing_eval_run',
      resourceId: run.id,
      payload: { name: 'Nightly', cases: 3, passed: 2, corpusDigest: run.corpusDigest },
    });
    expect(JSON.stringify(audit)).not.toContain('sales please');
  });

  it('refuses the first invalid case with its index and issues, and writes nothing', async () => {
    const { create, simulator, call } = await ready();
    const bad = [
      ...cases(2),
      { id: 'Bad Id', expect: {} },
      { id: 'later', expect: { status: 'nope' } },
    ];
    const response = await create({ cases: bad });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'routing_eval_invalid' }, index: 2 });
    expect(response.json().issues.length).toBeGreaterThan(0);
    expect(simulator.calls.score).toEqual([]);
    expect((await call('GET', '/v1/routing/eval-runs', undefined, viewer)).json().items).toEqual(
      [],
    );
  });

  it('refuses a malformed request, an unknown release, an empty or oversized corpus', async () => {
    const { create } = await ready();
    const cases501 = Array.from({ length: ROUTING_EVAL_LIMITS.cases + 1 }, (_, i) => ({
      id: `c${i}`,
      expect: { status: 'agent' },
    }));
    for (const body of [
      { name: ' ' },
      { cases: [] },
      { cases: cases501 },
      { extra: true },
      { routingReleaseId: 'nope' },
    ]) {
      const response = await create(body);
      expect(
        [response.statusCode, response.json().error.code],
        JSON.stringify(Object.keys(body)),
      ).toEqual([422, 'routing_eval_invalid']);
    }
    const missing = await create({ routingReleaseId: SALES_HI_RELEASE });
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_release_not_found',
    ]);
  });

  it('is for editors, limited per minute, capped at 1 MiB, and needs the router', async () => {
    const { create, release } = await ready({ simulateRatePerMinute: 1 });
    expect((await create({}, viewer)).statusCode).toBe(403);
    expect((await create()).statusCode).toBe(201);
    const limited = await create();
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'rate_limited']);
    const huge = await ready();
    const filler = { description: 'x'.repeat(250), id: 'a', expect: { status: 'agent' } };
    const body = {
      routingReleaseId: huge.release.id,
      name: 'Big',
      cases: Array.from({ length: 5000 }, () => filler),
    };
    expect((await huge.call('POST', '/v1/routing/eval-runs', body)).statusCode).toBe(413);
    const bare = await r4Setup();
    const unavailable = await bare.call('POST', '/v1/routing/eval-runs', {
      routingReleaseId: release.id,
      name: 'x',
      cases: cases(1),
    });
    expect([unavailable.statusCode, unavailable.json().error.code]).toEqual([
      503,
      'routing_simulator_unavailable',
    ]);
  });

  it('refuses a corpus that takes too long rather than keeping half a scorecard', async () => {
    const never = scriptedSimulator({ scoreRoutingCorpus: () => new Promise(() => undefined) });
    const { create, call } = await ready({ simulator: never });
    // Only the guard's timer is faked: the app's own request handling keeps real timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = create();
      let settled = false;
      void pending.then(() => (settled = true));
      // The guard arms after the request has been read, so step the clock until it answers.
      for (let step = 0; step < 40 && !settled; step += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const response = await pending;
      expect([response.statusCode, response.json().error.code]).toEqual([
        422,
        'routing_eval_too_slow',
      ]);
      expect((await call('GET', '/v1/routing/eval-runs', undefined, viewer)).json().items).toEqual(
        [],
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('eval run list, read and delete (R4)', () => {
  it('lists newest first with summaries, pages by cursor and reads one run whole', async () => {
    const { create, call } = await ready();
    const made: string[] = [];
    for (const name of ['One', 'Two', 'Three']) made.push((await create({ name })).json().id);
    const first = await call('GET', '/v1/routing/eval-runs?limit=2', undefined, viewer);
    expect(first.json().items.map((item: { name: string }) => item.name)).toEqual(['Three', 'Two']);
    for (const item of first.json().items) {
      expect(RoutingEvalRunSummary.safeParse(item).success).toBe(true);
      expect(item).not.toHaveProperty('scorecard');
    }
    expect(first.json().nextCursor).toBe(made[1]);
    const rest = await call(
      'GET',
      `/v1/routing/eval-runs?limit=2&cursor=${first.json().nextCursor}`,
      undefined,
      viewer,
    );
    expect(rest.json().items.map((item: { name: string }) => item.name)).toEqual(['One']);
    const read = await call('GET', `/v1/routing/eval-runs/${made[0]}`, undefined, viewer);
    expect(RoutingEvalRun.parse(read.json()).scorecard.totals.cases).toBe(3);
    expect(read.json().scorecard).toEqual({
      ...scorecardFor(3, 2),
      corpus: expect.anything(),
      routing: expect.anything(),
    });
    const missing = await call(
      'GET',
      `/v1/routing/eval-runs/${SALES_HI_RELEASE}`,
      undefined,
      viewer,
    );
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_eval_run_not_found',
    ]);
    expect((await call('GET', '/v1/routing/eval-runs/nope', undefined, viewer)).statusCode).toBe(
      400,
    );
  });

  it('deletes a run once, as an editor, and audits it', async () => {
    const { create, call, store } = await ready();
    const run = (await create()).json();
    expect(
      (await call('DELETE', `/v1/routing/eval-runs/${run.id}`, undefined, viewer)).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/v1/routing/eval-runs/${run.id}`)).statusCode).toBe(204);
    const again = await call('DELETE', `/v1/routing/eval-runs/${run.id}`);
    expect([again.statusCode, again.json().error.code]).toEqual([
      404,
      'routing_eval_run_not_found',
    ]);
    expect(
      (await call('GET', `/v1/routing/eval-runs/${run.id}`, undefined, viewer)).statusCode,
    ).toBe(404);
    expect((await call('GET', '/v1/routing/eval-runs', undefined, viewer)).json().items).toEqual(
      [],
    );
    expect(store.audits.map((entry) => entry.action)).toContain('routing.eval_run.delete');
  });
});
