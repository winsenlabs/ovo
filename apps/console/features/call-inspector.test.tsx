import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallInspectorFeature } from './call-inspector';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});

const evidence = { call: { id: 'call-1', status: 'completed' }, events: [] };
const outcome = {
  available: true,
  summary: {
    callId: 'call-1',
    outcome: 'completed',
    endReason: 'decision:intent=goodbye',
    disposition: 'promise_to_pay',
    dispositionSource: 'jev',
    finalNode: 'goodbye',
    statePath: ['identity', 'disclose', 'ptp_tomorrow', 'goodbye'],
    variables: { promised_date: '2026-10-07' },
    tiers: { rule: 1, jev: 2, llm: 1 },
    guardrail: { flagged: 0, blocked: 1 },
    events: 9,
    updatedAt: '2026-10-06T10:00:00.000Z',
  },
  events: [
    {
      sequence: 1,
      at: '2026-10-06T10:00:00.000Z',
      type: 'turn.route',
      payload: {
        turn: 2,
        tier: 'jev',
        node: 'disclose',
        intent: 'promise_to_pay',
        confidence: 0.91,
      },
    },
    {
      sequence: 2,
      at: '2026-10-06T10:00:01.000Z',
      type: 'guardrail',
      payload: {
        turn: 3,
        action: 'blocked',
        findings: [{ kind: 'amount', text: '2,000' }],
        checkUs: 30,
      },
    },
  ],
};

function respond(outcomeResponse: unknown) {
  request.mockImplementation(async (path: string) => {
    if (path === '/calls/call-1/evidence') return { data: evidence };
    if (path === '/calls/call-1/outcome?limit=500') return { data: outcomeResponse };
    if (path === '/calls/call-1/turns') return { data: { callId: 'call-1', turns: [] } };
    if (path === '/calls/call-1/cost') throw new Error('ledger not configured');
    throw new Error(`unexpected ${path}`);
  });
}

describe('call inspector outcome (AGT-8)', () => {
  it('shows the disposition, state path, captured values, decisions and guardrail verdicts', async () => {
    respond(outcome);
    render(<CallInspectorFeature callId="call-1" />);
    expect(await screen.findByText('Final node: goodbye')).toBeTruthy();
    expect(screen.getAllByText('promise_to_pay')).toHaveLength(2); // the disposition and the intent
    const path = screen.getByRole('navigation', { name: 'State path' });
    expect(path.textContent).toBe('identity→ disclose→ ptp_tomorrow→ goodbye');
    expect(screen.getByText('2026-10-07')).toBeTruthy();
    const decisions = screen.getByRole('table', { name: 'Routing decisions' });
    expect(within(decisions).getByText('91%')).toBeTruthy();
    expect(within(decisions).getByText('disclose')).toBeTruthy();
    expect(screen.getByText('Guardrail: 0 flagged · 1 blocked')).toBeTruthy();
    expect(screen.getByText(/Turn 3 · blocked: amount “2,000”/)).toBeTruthy();
  });

  it('says when nothing was recorded, and why', async () => {
    respond({ available: false, summary: null, events: [] });
    render(<CallInspectorFeature callId="call-1" />);
    expect(await screen.findByText('No outcome recorded')).toBeTruthy();
    expect(screen.getByText(/PostgreSQL only/)).toBeTruthy();
  });
});
