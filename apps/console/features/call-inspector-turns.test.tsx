import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallInspectorFeature } from './call-inspector';
import { turn } from '../tests/inspector-fixtures';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
vi.mock('../components/shell/session-provider', () => ({
  useSession: () => ({ role: 'admin' }),
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});

const evidence = {
  call: {
    id: 'call-1',
    agentId: 'agt_1',
    kind: 'live',
    status: 'completed',
    createdAt: '2026-10-06T10:00:00.000Z',
    completedAt: '2026-10-06T10:03:48.000Z',
    durationMs: 228000,
  },
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
        unit: 'output_tokens',
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
    if (path === '/agents/agt_1') return { data: { config: { name: 'EMI reminder' } } };
    if (path === '/calls/call-1/outcome?limit=500')
      return { data: { available: false, summary: null, events: [] } };
    if (path === '/calls/call-1/turns') return { data: { turns } };
    if (path === '/calls/call-1/cost')
      return {
        data: { provisional: true, provisionalPriceCards: [{ id: 'llm-card', version: '1' }] },
      };
    throw new Error(`unexpected ${path}`);
  });
}

async function openTab(name: string) {
  await screen.findByRole('heading', { name: 'EMI reminder call' });
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('call inspector latency + diagnosis (OBS-7, W14 relogic)', () => {
  it('charts the waterfall, stage breakdown and first-audio series for the turns', async () => {
    respond([turn(), turn({ turnId: 't2', llmCalls: 1, firstAudioMs: 900 })]);
    render(<CallInspectorFeature callId="call-1" />);
    await openTab('Latency');
    expect(
      await screen.findByRole('img', { name: 'Median latency per stage across turns' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('img', {
        name: 'First audio time per answered turn, with the p50 and p95 reference lines',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Per-turn latency breakdown by stage' })).toBeTruthy();
  });

  it('names the timeout, the errors, speculation reuse and lost evidence in the diagnosis rail', async () => {
    respond([]);
    render(<CallInspectorFeature callId="call-1" />);
    await openTab('Conversation');
    expect(await screen.findByText(/Timed out in text to speech \(tts\/acme\)/)).toBeTruthy();
    expect(screen.getByText(/tts socket closed/)).toBeTruthy();
    expect(screen.getByText('started 4 · reused 3')).toBeTruthy();
    expect(screen.getByText(/5 evidence events were lost/)).toBeTruthy();
  });

  it('shows cost in every currency, humanised, with provisional and unpriced warnings', async () => {
    respond([]);
    render(<CallInspectorFeature callId="call-1" />);
    await openTab('Cost');
    // Once in the header's "Cost" KPI (shared across tabs) and once in the Cost tab's own total.
    expect(await screen.findAllByText('₹12.50')).toHaveLength(2);
    expect(screen.getAllByText('$0.07')).toHaveLength(2); // the tab's USD total and the one cost line
    expect(await screen.findByText(/Provisional: priced partly/)).toBeTruthy();
    expect(screen.getByText('Unpriced meters: acme.stt.seconds')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Cost lines' })).getByText('900 output tokens'),
    ).toBeTruthy();
  });

  it('groups and pages a long event timeline instead of dumping a bare list', async () => {
    respond([]);
    render(<CallInspectorFeature callId="call-1" />);
    await openTab('Events');
    expect(await screen.findByText('250 recorded events')).toBeTruthy();
    expect(screen.getByRole('button', { name: /more/ })).toBeTruthy();
    expect(document.querySelector('pre')).toBeNull();
  });
});
