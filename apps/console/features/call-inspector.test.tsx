import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallInspectorFeature } from './call-inspector';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
vi.mock('../components/shell/session-provider', () => ({
  useSession: () => ({ role: 'admin' }),
}));
// The tab-in-URL sync (minor #12) reads/writes the router, which this render tree has none of.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/calls/call-1',
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});

const evidence = {
  call: {
    id: 'call-1',
    agentId: 'agt_1',
    releaseId: 'rel_1',
    kind: 'live',
    status: 'completed',
    createdAt: '2026-10-06T10:00:00.000Z',
    completedAt: '2026-10-06T10:03:48.000Z',
    durationMs: 228000,
  },
  events: [],
};
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
    route: null,
    segments: [],
    transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
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
      payload: { turn: 3, action: 'blocked', findings: [{ kind: 'amount', text: '2,000' }] },
    },
  ],
};

function respond(outcomeResponse: unknown) {
  request.mockImplementation(async (path: string) => {
    if (path === '/calls/call-1/evidence') return { data: evidence };
    if (path === '/agents/agt_1') return { data: { config: { name: 'EMI reminder' } } };
    if (path === '/calls/call-1/outcome?limit=500') return { data: outcomeResponse };
    if (path === '/calls/call-1/turns') return { data: { turns: [] } };
    if (path === '/calls/call-1/cost') throw new Error('ledger not configured');
    throw new Error(`unexpected ${path}`);
  });
}

describe('call inspector header and outcome tab (AGT-8, W14 relogic)', () => {
  it('shows the agent name, duration and status instead of raw IDs', async () => {
    respond(outcome);
    render(<CallInspectorFeature callId="call-1" />);
    expect(await screen.findByRole('heading', { name: 'EMI reminder call' })).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    // Once in the header meta row, once in the KPI strip.
    expect(screen.getAllByText('3m 48s')).toHaveLength(2);
  });

  it('shows the disposition, state path, captured values, decisions and guardrail verdicts', async () => {
    respond(outcome);
    render(<CallInspectorFeature callId="call-1" />);
    await screen.findByRole('heading', { name: 'EMI reminder call' });
    fireEvent.click(screen.getByRole('tab', { name: 'Outcome & routing' }));
    // The KPI's disposition and the routing table's matching intent.
    expect(await screen.findAllByText('Promise to pay')).toHaveLength(2);
    const path = screen.getByRole('navigation', { name: 'State path' });
    expect(path.textContent).toBe('Identity→ Disclose→ Ptp tomorrow→ Goodbye');
    expect(screen.getByText('2026-10-07')).toBeTruthy();
    const decisions = screen.getByRole('region', { name: 'Routing decisions' });
    expect(within(decisions).getByText('91%')).toBeTruthy();
    expect(within(decisions).getByText('Disclose')).toBeTruthy();
    expect(screen.getByText(/Turn 3 · Blocked: amount "2,000"/)).toBeTruthy();
  });

  it('says when nothing was recorded, and why', async () => {
    respond({ available: false, summary: null, events: [] });
    render(<CallInspectorFeature callId="call-1" />);
    await screen.findByRole('heading', { name: 'EMI reminder call' });
    fireEvent.click(screen.getByRole('tab', { name: 'Outcome & routing' }));
    expect(await screen.findByText('No outcome recorded')).toBeTruthy();
    expect(screen.getByText(/PostgreSQL only/)).toBeTruthy();
  });

  it('shows the recording files tab only for a live call', async () => {
    respond(outcome);
    render(<CallInspectorFeature callId="call-1" />);
    await screen.findByRole('heading', { name: 'EMI reminder call' });
    expect(screen.getByRole('tab', { name: 'Recording files' })).toBeTruthy();
  });
});
