// A tiny deterministic router for the fixture API's `POST /v1/routing/simulate`: enough of the
// "Main line" tree to give the console real, varied results (a keypad route, a scripted model
// answer, an unscripted model, a fallback). It is not the product router.
import { IDS, pools } from './routing-data.mjs';

const GREETING = 'Welcome to Sunrise Finance. How can I help you today?';
const ASK = 'Are you calling to buy something new, or about an existing account?';
const SUPPORT_ASK = 'Is it about a payment, or something else?';

const answerFor = (answers, node, engine) =>
  answers.find((a) => a.node === node && a.engine === engine);

function considerPool(poolId, node, turn, language) {
  const pool = pools().find((p) => p.id === poolId);
  const want = language ?? 'en';
  const members = pool.definition.members.map((m, i) => {
    const languageOk = m.languages.includes(want);
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
      active: i * 2,
      capacity: m.capacity ?? null,
      full: false,
      picked: false,
      reasons,
    };
  });
  const pick = members.find((m) => m.eligible);
  if (pick) pick.picked = true;
  return {
    poolId,
    poolName: pool.definition.name,
    turn,
    node,
    wanted: { language: want, languageMode: 'caller', products: null, skills: [] },
    languageUsed: want,
    members,
    result: pick ? 'picked' : 'no_eligible_member',
  };
}

export function simulate(body) {
  const turns = body.turns ?? [];
  const answers = body.engines?.answers ?? [];
  const warnings = [];
  const results = [
    {
      index: 0,
      input: { kind: 'opening' },
      say: `${GREETING} ${ASK}`,
      phase: 'routing',
      virtualMs: 0,
      steps: [],
    },
  ];
  let node = 'intent';
  const path = [];
  let language = 'en';
  let outcome;
  let pools_ = [];
  let misses = 0;
  const node_ = (turn, payload, mocked = false) =>
    results[turn].steps.push({ type: 'route.node', payload: { turn, ...payload }, mocked });
  const finish = (turn, status, extra) => {
    results[turn].phase = 'ended';
    outcome = {
      status,
      completionReason: `route:${status}:${path.join('>')}`,
      node,
      path: [...path],
      language,
      context: {},
      turns: turn,
      routeMs: turn * 3000 + 400,
      line: 'Connecting you now.',
      degraded: null,
      agent: null,
      targetVariables: {},
      human: null,
      callback: null,
      endDisposition: null,
      ...extra,
    };
  };
  const toPool = (turn, poolId, branch) => {
    path.push(node, branch);
    const considered = considerPool(poolId, node, turn, language);
    pools_ = [considered];
    const picked = considered.members.find((m) => m.picked);
    results[turn].steps.push({
      type: 'route.decision',
      payload: { target: 'agent', path, poolId, memberId: picked?.memberId },
    });
    finish(
      turn,
      picked ? 'agent' : 'end',
      picked
        ? {
            agent: {
              agentId: picked.agentId,
              releaseId: picked.releaseId,
              poolId,
              memberId: picked.memberId,
            },
          }
        : { endDisposition: 'no_agent', line: 'Sorry, nobody is free.' },
    );
  };
  for (let i = 0; i < turns.length && !outcome; i += 1) {
    const turn = i + 1;
    const input = turns[i];
    results.push({
      index: turn,
      input,
      say: '',
      phase: 'routing',
      virtualMs: turn * 3000,
      steps: [],
    });
    const text = input.kind === 'speech' ? input.text.toLowerCase() : '';
    if (node === 'intent') {
      if (input.kind === 'dtmf' && input.digits === '1') {
        node_(turn, { node, engine: 'rules', outcome: 'matched', branch: 'sales', confidence: 1 });
        toPool(turn, IDS.sales, 'sales');
      } else if (input.kind === 'dtmf' && input.digits === '2') {
        node_(turn, {
          node,
          engine: 'rules',
          outcome: 'matched',
          branch: 'support',
          confidence: 1,
        });
        path.push(node);
        node = 'support_kind';
        results[turn].say = SUPPORT_ASK;
      } else {
        node_(turn, { node, engine: 'rules', outcome: 'no_match' });
        const answer = answerFor(answers, node, 'llm');
        if (!answer) {
          misses += 1;
          warnings.push({
            code: 'engine_unscripted',
            node,
            engine: 'llm',
            message: `The language model on ${node} had no scripted answer.`,
          });
          node_(
            turn,
            { node, engine: 'llm', outcome: 'no_match', reason: 'unscripted', ms: 0 },
            true,
          );
          if (misses === 1) {
            results[turn].steps.push({
              type: 'route.fallback',
              payload: { turn, node, step: 'reask', result: 'taken', attempt: 1 },
            });
            results[turn].say = ASK;
          } else {
            results[turn].steps.push({
              type: 'route.fallback',
              payload: { turn, node, step: 'default', result: 'taken', attempt: 1 },
            });
            path.push(node, 'default');
            finish(turn, 'agent', {
              agent: { agentId: 'agent-sales-en', releaseId: IDS.r1 },
              degraded: 'fallback',
            });
          }
        } else {
          const low = (answer.confidence ?? 0.9) < 0.6;
          language = answer.language ?? language;
          node_(
            turn,
            {
              node,
              engine: 'llm',
              outcome: low ? 'low_confidence' : 'matched',
              branch: answer.branch,
              confidence: answer.confidence ?? 0.9,
              ms: 0,
            },
            true,
          );
          if (!low && answer.branch === 'sales') toPool(turn, IDS.sales, 'sales');
          else if (!low && answer.branch === 'person') {
            path.push(node, 'person');
            finish(turn, 'human', {
              human: { queueKey: 'desk', queueId: IDS.queueDesk, kind: 'managed', precheck: 'ok' },
            });
          } else if (!low && answer.branch === 'support') {
            path.push(node);
            node = 'support_kind';
            results[turn].say = SUPPORT_ASK;
          } else {
            results[turn].steps.push({
              type: 'route.fallback',
              payload: { turn, node, step: 'reask', result: 'taken', attempt: 1 },
            });
            results[turn].say = ASK;
          }
        }
      }
    } else if (/payment|refund|charged/.test(text)) {
      node_(turn, { node, engine: 'rules', outcome: 'matched', branch: 'billing', confidence: 1 });
      toPool(turn, IDS.support, 'billing');
    } else {
      node_(turn, { node, engine: 'rules', outcome: 'no_match' });
      toPool(turn, IDS.support, 'other');
    }
    if (!outcome && !results[turn].say) results[turn].say = ASK;
  }
  if (!outcome) {
    results.at(-1).phase = 'routing';
    outcome = {
      status: 'undecided',
      completionReason: null,
      node,
      path,
      language: null,
      context: {},
      turns: turns.length,
      routeMs: turns.length * 3000,
      line: '',
      degraded: null,
      agent: null,
      targetVariables: {},
      human: null,
      callback: null,
      endDisposition: null,
    };
    if (turns.length)
      warnings.push({
        code: 'turns_unused',
        message: 'The script ended before the router decided.',
      });
  }
  return {
    schema: 'ovo.route-simulation/1',
    at: body.call?.at ?? '2026-10-14T10:30:00.000Z',
    source:
      body.target?.kind === 'release'
        ? {
            kind: 'release',
            pointId: IDS.point,
            routingReleaseId: body.target.routingReleaseId,
            version: 3,
            digest: 'c'.repeat(64),
          }
        : {
            kind: 'draft',
            pointId: IDS.point,
            routingReleaseId: null,
            version: null,
            digest: 'd'.repeat(64),
          },
    engineModes: { rules: 'real', decision: 'mock', llm: 'mock', external: 'mock' },
    assumed: {
      transferEnabled: body.assume?.transferEnabled ?? true,
      humanQueueEnabled: body.assume?.humanQueueEnabled ?? true,
    },
    turns: results,
    outcome,
    pools: pools_,
    warnings,
    stats: { ms: 4, virtualMs: turns.length * 3000, routerTurns: results.length, liveCalls: 0 },
  };
}
