import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api';
import { releases } from '../../../e2e/fixtures/routing-data.mjs';
import {
  ENABLED_STATUS,
  IDS,
  resetRouting,
  routingApi,
  sampleDraft,
  typedPools,
} from '../routing-test-support';
import { SimulatePanel } from './simulate-panel';

vi.mock('../../../lib/data/routing-api', async (importActual) =>
  (await import('../routing-test-support')).routingApiModule(importActual as never),
);
vi.mock('../../../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn().mockResolvedValue({ data: { config: { timezone: 'Asia/Kolkata' } } }),
  };
});
beforeEach(() => resetRouting());
afterEach(cleanup);

const panel = (props: Partial<Parameters<typeof SimulatePanel>[0]> = {}) =>
  render(
    <SimulatePanel
      pointId={IDS.point}
      pointName="Main line"
      draft={sampleDraft()}
      releases={releases()}
      status={ENABLED_STATUS}
      role="editor"
      pools={typedPools()}
      {...props}
    />,
  );
const turn = async (kind: string, value: string, label: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add a turn' }));
  fireEvent.change(screen.getByLabelText('Turn 1 type'), { target: { value: kind } });
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const run = () => fireEvent.click(screen.getByRole('button', { name: 'Run the simulation' }));

describe('building the request', () => {
  it('sends the working draft, the caller, the keypad turn and the engine modes', async () => {
    panel();
    fireEvent.change(screen.getByLabelText('Calling from'), { target: { value: '+918040000001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a variable' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'segment' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'vip' } });
    fireEvent.change(screen.getByLabelText('Call time'), { target: { value: '2026-10-14T10:30' } });
    await turn('dtmf', '1', 'Turn 1 keys');
    run();
    await waitFor(() => expect(routingApi.simulate).toHaveBeenCalled());
    const body = routingApi.simulate.mock.calls[0]![0];
    expect(body.target).toMatchObject({
      kind: 'draft',
      pointId: IDS.point,
      draft: { name: 'Main line' },
    });
    expect(body.call).toEqual({
      from: '+918040000001',
      variables: { segment: 'vip' },
      at: '2026-10-14T05:00:00.000Z',
    });
    expect(body.turns).toEqual([{ kind: 'dtmf', digits: '1' }]);
    expect(body.engines.mode).toEqual({ decision: 'mock', llm: 'mock', external: 'mock' });
  });
  it('runs a chosen release without the draft', async () => {
    panel();
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: IDS.r3 } });
    await waitFor(() => expect(routingApi.release).toHaveBeenCalledWith(IDS.r3));
    await screen.findByText('intent: Language model');
    run();
    await waitFor(() => expect(routingApi.simulate).toHaveBeenCalled());
    expect(routingApi.simulate.mock.calls[0]![0].target).toEqual({
      kind: 'release',
      routingReleaseId: IDS.r3,
    });
  });
  it('lists an answer row for every model engine and sends a scripted answer', async () => {
    panel();
    expect(screen.getByText('intent: Language model')).toBeTruthy();
    expect(screen.getByText('support_kind: Decision engine')).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText('Answers with branch', { selector: '#ans-intent\\:llm-branch' }),
      { target: { value: 'sales' } },
    );
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: '0.4' } });
    await turn('speech', 'hello', 'Turn 1 words');
    run();
    await waitFor(() => expect(routingApi.simulate).toHaveBeenCalled());
    expect(routingApi.simulate.mock.calls[0]![0].engines.answers).toEqual([
      { node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.4, repeat: false },
    ]);
  });
  it('disables running engines for real with the reason from the status, and for non-admins', () => {
    panel();
    const toggle = screen.getByRole('switch', { name: /real language model/i }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getAllByText('Only admins can run real engines.').length).toBeGreaterThan(0);
    cleanup();
    panel({ role: 'admin' });
    expect(screen.getAllByText('Real model calls are switched off here.').length).toBeGreaterThan(
      0,
    );
    cleanup();
    panel({
      role: 'admin',
      status: {
        ...ENABLED_STATUS,
        simulate: { enabled: true, liveLlm: true, liveExternal: false },
      },
    });
    expect(
      (screen.getByRole('switch', { name: /real language model/i }) as HTMLInputElement).disabled,
    ).toBe(false);
  });
  it('explains an invalid form before calling the server', async () => {
    panel();
    fireEvent.change(screen.getByLabelText('Calling from'), { target: { value: '12345' } });
    run();
    expect(await screen.findByText(/must be international/)).toBeTruthy();
    expect(routingApi.simulate).not.toHaveBeenCalled();
  });
});

describe('reading the result', () => {
  it('shows the outcome KPIs, the path, the trace, the conversation and the pool considered', async () => {
    panel();
    await turn('dtmf', '1', 'Turn 1 keys');
    run();
    expect(await screen.findByText('An agent')).toBeTruthy();
    const path = screen.getByRole('list', { name: 'Route taken' });
    expect(within(path).getByText('intent')).toBeTruthy();
    expect(within(path).getByText(/Agent agent-sales-en/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Engine attempts' })).toBeTruthy();
    expect(screen.getByText('Pressed 1')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Pool Sales' })).toBeTruthy();
    expect(screen.getAllByText('Wrong language').length).toBeGreaterThan(0);
  });
  it('offers Answer as for an unscripted engine and runs again with the answer', async () => {
    panel();
    await turn('speech', 'mujhe naya credit card chahiye', 'Turn 1 words');
    run();
    expect(await screen.findByText(/had no scripted answer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Answer as…' }));
    const drawer = screen.getByRole('dialog', { name: /Answer as llm on intent/ });
    fireEvent.change(within(drawer).getByLabelText('Choose branch'), {
      target: { value: 'sales' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Answer and run again' }));
    await waitFor(() => expect(routingApi.simulate).toHaveBeenCalledTimes(2));
    expect(routingApi.simulate.mock.calls[1]![0].engines.answers[0]).toMatchObject({
      node: 'intent',
      engine: 'llm',
      branch: 'sales',
      confidence: 0.9,
    });
    expect(await screen.findByText('An agent')).toBeTruthy();
  });
  it('shows blockers, an unavailable live engine, rate limiting and failures as their own states', async () => {
    panel();
    routingApi.simulate.mockRejectedValueOnce(
      new ApiError(422, 'routing_simulate_blocked', 'blocked', {
        blockers: [{ message: 'The router agent has no release' }],
      }),
    );
    run();
    expect(
      await screen.findByText(/would block a publish: The router agent has no release/),
    ).toBeTruthy();
    routingApi.simulate.mockRejectedValueOnce(
      new ApiError(409, 'simulate_live_unavailable', 'Real engines are not available'),
    );
    run();
    expect(await screen.findByText('Real engines are not available')).toBeTruthy();
    routingApi.simulate.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'slow'));
    run();
    expect(await screen.findByText(/Too many simulations/)).toBeTruthy();
    routingApi.simulate.mockRejectedValueOnce(new Error('boom'));
    run();
    expect(await screen.findByText('boom')).toBeTruthy();
  });
  it('saves a run as an eval case: copy as JSON and download as JSONL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    panel();
    await turn('dtmf', '1', 'Turn 1 keys');
    run();
    await screen.findByText('Save as an eval case');
    fireEvent.change(screen.getByLabelText('Case id'), { target: { value: 'sales-keypad' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Member' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy as JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const made = JSON.parse(writeText.mock.calls[0]![0]);
    expect(made).toMatchObject({
      id: 'sales-keypad',
      turns: [{ kind: 'dtmf', digits: '1' }],
      expect: { status: 'agent', pool: 'Sales', fallback: 'none' },
    });
    expect(made.expect).not.toHaveProperty('member');
    URL.createObjectURL = vi.fn(() => 'blob:case');
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Download as JSONL' }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
  it('is read only for viewers and says when simulation is off', () => {
    panel({ role: 'viewer' });
    expect(screen.getByText(/Editors can run simulations/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Run the simulation' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    panel({
      status: {
        ...ENABLED_STATUS,
        simulate: { enabled: false, liveLlm: false, liveExternal: false },
      },
    });
    expect(screen.getByText('Route simulation is not enabled here')).toBeTruthy();
  });
});
