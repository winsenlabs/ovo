import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyAgentConfig, type AgentConfig } from '../../lib/api';
import { CostPolicyEditor } from './cost-policy-editor';

// OPS-14: meter keys were typed by hand as free text; the API now derives them for the draft.
const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});

const config: AgentConfig = {
  ...emptyAgentConfig(),
  costPolicy: {
    budgetId: 'budget',
    reservationPaise: '100',
    maxCallSeconds: 300,
    priceCards: { 'openai.inference.output_tokens': { id: 'old', version: 'v1', fxId: 'usd' } },
  },
};

it('shows the draft’s required meters and fills a reference from a catalog price', async () => {
  request.mockResolvedValue({
    data: {
      draftVersion: 3,
      complete: false,
      provisional: false,
      meters: [
        {
          key: 'openai.inference.output_tokens',
          unit: 'output_tokens',
          label: 'OpenAI inference output tokens',
          slot: 'llm',
          model: 'gpt-6-luna',
          status: 'price_unknown_for_model',
          reference: { id: 'old', version: 'v1' },
          catalog: [{ id: 'openai-gpt-6-luna-output', version: '2026-10-06', provisional: true }],
        },
        {
          key: 'twilio.carrier.audio_seconds',
          unit: 'audio_seconds',
          label: 'Twilio call audio',
          slot: 'carrier',
          status: 'missing',
          catalog: [],
        },
      ],
    },
  });
  const update = vi.fn();
  render(<CostPolicyEditor config={config} update={update} agentId="agent 1" />);
  const table = await screen.findByRole('region', { name: 'Required meters' });
  expect(request).toHaveBeenCalledWith('/agents/agent%201/required-meters');
  expect(within(table).getByText('Card prices another model')).toBeTruthy();
  expect(within(table).getByText('No price card')).toBeTruthy();
  expect(within(table).getByText('No catalog price for this model')).toBeTruthy();
  expect(screen.getByText('Meters need prices')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Use openai-gpt-6-luna-output for openai.inference.output_tokens',
    }),
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      costPolicy: expect.objectContaining({
        priceCards: {
          'openai.inference.output_tokens': {
            id: 'openai-gpt-6-luna-output',
            version: '2026-10-06',
            fxId: 'usd',
          },
        },
      }),
    }),
  );
});

it('does not ask the API without an agent id', () => {
  render(<CostPolicyEditor config={config} update={vi.fn()} />);
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Required meters' })).toBeNull();
  expect(screen.queryByLabelText('Required meter checklist')).toBeNull();
});
