import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkFlow,
  flowListen,
  flowNode,
  FLOW_MAX_PHRASES,
  matchFlowPhrase,
  routeFlowIntent,
  type AgentFlow,
} from '../../packages/plugin-evaluations/src/jev-eval-flow.ts';
import { diffConversationMap } from '../flow-import/conversation-map.ts';
import { CREDITMANTRI_PRESET } from '../flow-import/creditmantri.ts';
import { importPocFlow, type PocFlowModule } from '../flow-import/import-poc-flow.ts';
import { regexPhrases } from '../flow-import/regex-phrases.ts';
import { SPAWN_TIMEOUT_MS } from './gate-helpers.ts';

// The vendored POC module also exports its own router, which is the oracle for the imported flow.
interface PocModule extends PocFlowModule {
  ruleMatch(listen: string, text: string): string | null;
  nextNode(listen: string, intent: string, slots?: Record<string, string>): string | null;
}
const poc = (await import(CREDITMANTRI_PRESET.input)) as PocModule;
const { config: imported, notes } = importPocFlow(poc, CREDITMANTRI_PRESET.options);
const { flow } = imported.decision;
const map = await readFile(CREDITMANTRI_PRESET.map, 'utf8');
const rulesOf = (rule: RegExp | RegExp[] | undefined) =>
  rule === undefined ? [] : Array.isArray(rule) ? rule : [rule];
const pocRules = [
  ...Object.values(poc.LISTENS).flatMap((listen) =>
    Object.values(listen.intents).flatMap((intent) => rulesOf(intent.rule)),
  ),
  ...Object.values(poc.GLOBAL_INTENTS).flatMap((intent) => rulesOf(intent.rule)),
];

describe('regexPhrases', () => {
  it('expands groups, alternation and optional parts', () => {
    expect(regexPhrases(/^(yes|haan)( (ji|please))?$/)).toEqual([
      'yes',
      'yes ji',
      'yes please',
      'haan',
      'haan ji',
      'haan please',
    ]);
    expect(regexPhrases(/^(?:no )?wrong numbers?$/i)).toEqual([
      'wrong number',
      'wrong numbers',
      'no wrong number',
      'no wrong numbers',
    ]);
  });

  it('refuses anything that is not a finite phrase list', () => {
    for (const pattern of [/^ye+s$/, /^y.s$/, /^[yn]o$/, /yes/, /^\w+$/, /^yes|no$/, /^(?=y)yes$/])
      expect(() => regexPhrases(pattern), String(pattern)).toThrow(/Cannot expand/);
  });

  it('matches exactly what every POC rule regex matches', () => {
    expect(pocRules.length).toBeGreaterThan(10);
    for (const rule of pocRules) {
      const phrases = regexPhrases(rule);
      expect(phrases.length).toBeGreaterThan(0);
      for (const phrase of phrases) expect(rule.test(phrase), `${rule} ${phrase}`).toBe(true);
    }
  });
});

describe('importPocFlow on the CreditMantri POC', () => {
  it('matches the committed fixture, so a POC or importer change cannot drift silently', async () => {
    const committed = JSON.parse(await readFile(CREDITMANTRI_PRESET.out, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(imported)));
    expect(checkFlow(committed.decision.flow, committed.variables.required)).toBeTruthy();
  });

  it('routes every rule phrase exactly as the POC router does, in every listen', () => {
    // Transcripts carry apostrophes the POC stripped and OVO's normalisation turns into spaces.
    const probes = new Set<string>(['', 'maybe later', 'Yes!', 'NAHI', 'hmm', 'what?', 'ok bye']);
    for (const text of ["That's all.", "it's me", "Didn't get it", "haven't received", 'Yes, sir'])
      probes.add(text);
    for (const rule of pocRules) for (const phrase of regexPhrases(rule)) probes.add(phrase);
    for (const listen of Object.keys(poc.LISTENS))
      for (const text of probes)
        expect(matchFlowPhrase(flow, listen, text) ?? null, `${listen}: ${text}`).toBe(
          poc.ruleMatch(listen, text),
        );
    expect(matchFlowPhrase(flow, 'wrapup', "That's all.")).toBe('no_more');
  });

  it('turns every next, including the code-valued promise-to-pay one, into the same targets', () => {
    for (const [listenId, listen] of Object.entries(poc.LISTENS)) {
      const answers = [
        {},
        ...Object.entries(listen.slots ?? {}).flatMap(([slot, { options }]) =>
          Object.keys(options).map((option) => ({ [slot]: option })),
        ),
      ];
      for (const intent of [...Object.keys(listen.intents), ...Object.keys(poc.GLOBAL_INTENTS)])
        for (const slots of answers) {
          const target = routeFlowIntent(flow, listenId, intent, slots);
          expect(target?.kind === 'node' ? target.node : null).toBe(
            poc.nextNode(listenId, intent, slots),
          );
        }
    }
    const payment = flowListen(flow, 'payment')!;
    expect(payment.intents.find((intent) => intent.key === 'promise_to_pay')!.next).toMatchObject({
      slot: 'ptp_when',
      cases: { tomorrow: 'ptp_tomorrow', later: 'ptp_later' },
      otherwise: 'ptp_ask',
    });
  });

  it('keeps nodes, dispositions, the identity gate, repeat and clarify', () => {
    expect(flow.start).toBe('greet');
    expect(flowNode(flow, 'disclose')).toEqual({
      id: 'disclose',
      say: ['recording', 'emi_status', 'charges', 'ask_when'],
      listen: 'payment',
      end: false,
      verified: true,
    });
    expect(flowNode(flow, 'ptp_tomorrow')).toMatchObject({
      disposition: 'promise_to_pay:tomorrow',
      listen: 'wrapup',
    });
    expect(flowNode(flow, 'wp_unknown')).toEqual({
      id: 'wp_unknown',
      say: ['wp_unknown'],
      end: true,
      disposition: 'wrong_number',
      verified: false,
    });
    expect(flow.globalIntents.find((intent) => intent.key === 'repeat')).toMatchObject({
      repeat: true,
    });
    expect([flow.threshold, flow.fallback, flow.clarify, flow.repeatPrefix]).toEqual([
      0.55,
      'llm',
      'didnt_catch',
      'repeat_prefix',
    ]);
    const counts = flow.listens.flatMap((l) => l.intents.map((intent) => intent.phrases.length));
    expect(Math.max(...counts)).toBeLessThanOrEqual(FLOW_MAX_PHRASES);
  });

  it('moves the POC silence handling to idle and lists what a flow cannot express', () => {
    expect(imported.idle).toEqual({
      prompts: ['Hello? Can you hear me?'],
      finalLine: "I'm unable to hear you, so I'll call back later. Goodbye.",
    });
    expect(flowNode(flow, 'no_input_end')).toBeUndefined();
    expect(flow.lines.filler_1).toBeUndefined();
    expect(notes).toContain('node pay_now: sends the full SMS; flows have no actions yet');
    expect(notes).toContain('idle: the POC records no_response; an idle ending has no disposition');
  });

  it('inlines config constants and declares every per-call variable as {{name}}', () => {
    expect(flow.lines.intro).toBe("Hello, I'm calling from CreditMantri. My name is Ananya.");
    expect(flow.lines.ask_identity).toBe('Am I speaking with {{full_name}}?');
    expect(imported.variables.required).toContain('date_week');
    expect(imported.variables.properties.full_name).toEqual({ type: 'string' });
    expect(imported.variables.required).not.toContain('agent');
  });
});

describe('diffConversationMap', () => {
  it('agrees with the POC conversation map', () => {
    expect(diffConversationMap(imported, map, CREDITMANTRI_PRESET.options.constants)).toEqual([]);
  });

  it('reports a stale map edge, node marker and clip text', () => {
    const stale = map
      .replace('  busy -- "this_evening" --> cb_evening\n', '')
      .replace('cb_generic<br/><small>G · END</small>', 'cb_generic<br/><small>G</small>')
      .replace('Thank you for your time. Have a good day!', 'Bye.');
    expect(diffConversationMap(imported, stale, CREDITMANTRI_PRESET.options.constants)).toEqual([
      'node missing from map: cb_generic END',
      'node not imported: cb_generic',
      'edge missing from map: busy -this_evening-> cb_evening',
      'clip text differs: goodbye',
    ]);
  });
});

describe('checkFlow', () => {
  const broken = (change: (flow: AgentFlow) => void) => {
    const copy = structuredClone(flow);
    change(copy);
    return () => checkFlow(copy, imported.variables.required);
  };
  const wrapup = (f: AgentFlow) => flowListen(f, 'wrapup')!.intents;

  it('refuses missing targets, duplicate intents, undeclared variables and unreachable nodes', () => {
    expect(broken((f) => (wrapup(f)[0]!.next = 'nowhere'))).toThrow(
      'listen wrapup intent no_more: node nowhere does not exist',
    );
    expect(
      broken((f) =>
        wrapup(f).push({ key: 'abusive', description: 'x', phrases: [], next: 'goodbye' }),
      ),
    ).toThrow('listen wrapup intent abusive is used twice');
    expect(broken((f) => (f.lines.goodbye = 'Bye {{nickname}}'))).toThrow(
      'line goodbye: undeclared variable nickname',
    );
    expect(
      broken((f) => f.nodes.push({ id: 'orphan', say: ['goodbye'], end: true, verified: false })),
    ).toThrow('node orphan: unreachable');
    expect(broken((f) => (flowNode(f, 'goodbye')!.listen = 'wrapup'))).toThrow(
      'node goodbye: needs one of listen and end',
    );
    expect(broken((f) => wrapup(f).push({ ...wrapup(f)[0]!, key: 'other' }))).toThrow(
      'listen wrapup intent other: other is automatic and reserved',
    );
    expect(
      broken((f) => wrapup(f).push({ ...wrapup(f)[0]!, key: 'done', phrases: ['bye'] })),
    ).toThrow('listen wrapup intent done: phrase "bye" also means no_more');
  });

  it('refuses a code-valued next that reads two slots and a global intent with nowhere to go', () => {
    const twoSlots = { ...poc, LISTENS: { ...poc.LISTENS } };
    twoSlots.LISTENS.payment = {
      ...poc.LISTENS.payment!,
      slots: {
        ...poc.LISTENS.payment!.slots,
        mode: { question: 'How?', options: { upi: 'UPI', card: 'Card' } },
      },
      intents: {
        ...poc.LISTENS.payment!.intents,
        pay_now: {
          desc: 'Pay now',
          next: (slots) =>
            slots.mode === 'upi' ? 'pay_now' : slots.ptp_when ? 'ptp_ask' : 'resend',
        },
      },
    };
    expect(() => importPocFlow(twoSlots, CREDITMANTRI_PRESET.options)).toThrow(
      'payment.pay_now: next() depends on more than one slot',
    );
    const lost = { ...poc, GLOBAL_INTENTS: { ...poc.GLOBAL_INTENTS, hold: { desc: 'Hold on' } } };
    expect(() => importPocFlow(lost, CREDITMANTRI_PRESET.options)).toThrow(
      'Global intent hold has no next node',
    );
  });
});

describe('flow:import CLI', () => {
  const cli = (...args: string[]) =>
    spawnSync('node_modules/.bin/tsx', ['scripts/flow-import/cli.ts', ...args], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });

  it('prints the imported flow and fails on a map that disagrees', async () => {
    const args = [
      CREDITMANTRI_PRESET.input,
      '--context',
      'A collections call.',
      '--constant',
      'agent=Ananya',
      '--constant',
      'helpline=1800 123 4567',
    ];
    const printed = cli(...args, '--map', CREDITMANTRI_PRESET.map);
    expect(printed.status, printed.stderr).toBe(0);
    const printedConfig = JSON.parse(printed.stdout);
    expect(printedConfig.decision.flow.context).toBe('A collections call.');
    expect(printedConfig.decision.flow.nodes).toEqual(flow.nodes);
    expect(printed.stderr).toContain('note: node pay_now: sends the full SMS');

    const dir = await mkdtemp(path.join(tmpdir(), 'flow-import-'));
    const stale = path.join(dir, 'conversation-map.md');
    await writeFile(stale, map.replace('Thank you for your time.', 'Thanks.'));
    const refused = cli(...args, '--map', stale);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('clip text differs: goodbye');
    expect(refused.stdout).toBe('');
    await rm(dir, { recursive: true });
  });
});
