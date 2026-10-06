import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallInspectorFeature } from './call-inspector';
import { turn } from '../tests/inspector-fixtures';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});

const evidence = {
  call: { id: 'call-1', status: 'completed' },
  events: Array.from({ length: 250 }, (_, index) => ({
    id: `e${index}`,
    type: 'engine.event',
    at: '2026-10-06T10:00:00.000Z',
  })),
  cost: {
    unpriced: ['acme.stt.seconds'],
    currencies: [
      { currency: 'INR', estimatedMinor: '1250', reconciledMinor: '0', lines: 1 },
      { currency: 'USD', estimatedMinor: '7', reconciledMinor: '0', lines: 1 },
    ],
    lines: [
      {
        id: 'u1',
        provider: 'llm',
        quantity: '900',
        unit: 'tokens',
        amountMinor: '7',
        currency: 'USD',
        state: 'estimated',
        priceCardId: 'llm-card',
        priceCardVersion: '1',
      },
    ],
  },
  diagnosis: {
    endReason: 'error:timeout:tts:tts/acme',
    timeout: { stage: 'tts', provider: 'tts/acme' },
    errors: [
      {
        sequence: 9,
        at: '2026-10-06T10:00:05.000Z',
        type: 'speech.failed',
        message: 'tts socket closed',
        turnId: '3',
      },
    ],
    errorsTruncated: false,
    speculation: { decision: { started: 4, reused: 3 }, llm: { started: 0 } },
    guardrail: null,
    evidence: { accepted: 300, dropped: 5, sampled: 40, failed: 0 },
  },
};

function respond(turns: unknown[]) {
  request.mockImplementation(async (path: string) => {
    if (path === '/calls/call-1/evidence') return { data: evidence };
    if (path === '/calls/call-1/outcome?limit=500')
      return { data: { available: false, summary: null, events: [] } };
    if (path === '/calls/call-1/turns') return { data: { callId: 'call-1', turns } };
    if (path === '/calls/call-1/cost')
      return {
        data: { provisional: true, provisionalPriceCards: [{ id: 'llm-card', version: '1' }] },
      };
    throw new Error(`unexpected ${path}`);
  });
}

describe('call inspector diagnosis (OBS-7)', () => {
  it('shows each turn with its route, utterance, reply and stage waterfall', async () => {
    respond([turn(), turn({ turnId: 't2', llmCalls: 1, userText: 'kitna hai?' })]);
    render(<CallInspectorFeature callId="call-1" />);
    const turns = await screen.findByRole('list', { name: 'Turns' });
    const first = within(turns).getByRole('listitem', { name: 'Turn 1' });
    expect(within(first).getByText('Jev → promise_to_pay 91% · 240 ms')).toBeTruthy();
    expect(within(first).getByText('kal de dunga')).toBeTruthy();
    expect(within(first).getByText('Theek hai, kal tak.')).toBeTruthy();
    expect(within(first).getByRole('img').getAttribute('aria-label')).toContain('Decision 240 ms');
    expect(within(turns).getByText('promise_to_pay 91% → LLM ×1')).toBeTruthy();
    expect(screen.getByLabelText('Turn summary').textContent).toContain('First audio p50 700 ms');
  });

  it('names the timeout, the errors, speculation reuse and lost evidence', async () => {
    respond([]);
    render(<CallInspectorFeature callId="call-1" />);
    expect(await screen.findByText(/Timed out in text to speech \(tts\/acme\)/)).toBeTruthy();
    expect(screen.getByText(/tts socket closed/)).toBeTruthy();
    expect(screen.getByText('started 4 · reused 3')).toBeTruthy();
    expect(screen.getByText(/5 evidence events were lost/)).toBeTruthy();
  });

  it('shows cost in every currency with provisional and unpriced warnings', async () => {
    respond([]);
    render(<CallInspectorFeature callId="call-1" />);
    await screen.findByLabelText('Cost totals');
    expect(screen.getByLabelText('Cost totals').textContent).toContain('₹12.50 estimated');
    expect(screen.getByLabelText('Cost totals').textContent).toContain('$0.07 estimated');
    expect(await screen.findByText(/Provisional: priced partly/)).toBeTruthy();
    expect(screen.getByText('Unpriced meters: acme.stt.seconds')).toBeTruthy();
    expect(
      within(screen.getByRole('table', { name: 'Cost lines' })).getByText('$0.07'),
    ).toBeTruthy();
  });

  it('renders a long call a page at a time', async () => {
    respond(Array.from({ length: 300 }, (_, index) => turn({ turnId: `t${index}` })));
    render(<CallInspectorFeature callId="call-1" />);
    const turns = await screen.findByRole('list', { name: 'Turns' });
    expect(within(turns).getAllByRole('listitem')).toHaveLength(40);
    fireEvent.click(screen.getByRole('button', { name: 'Show 40 more of 260 turns' }));
    expect(within(turns).getAllByRole('listitem')).toHaveLength(80);
    expect(screen.getByRole('button', { name: 'Show more of 150 events' })).toBeTruthy();
    expect(document.querySelector('pre')).toBeNull();
  });
});
