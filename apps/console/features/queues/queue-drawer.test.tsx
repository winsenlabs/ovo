import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { externalRecord, managedRecord, queuesApi, resetQueues } from './queues-test-support';
import { QueueDrawer } from './queue-drawer';

vi.mock('../../lib/data/queues-api', async () => (await import('./queues-test-support')).queuesApiModule());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: vi.fn(async () => ({
    data: { items: [{ id: 'clip-1', name: 'Hold music' }] },
  })),
}));

const onClose = vi.fn();
const onSaved = vi.fn();
const open = (props: Partial<Parameters<typeof QueueDrawer>[0]> = {}) =>
  render(<QueueDrawer open kind="managed" canTest onClose={onClose} onSaved={onSaved} {...props} />);

beforeEach(() => {
  resetQueues();
  onClose.mockReset();
  onSaved.mockReset();
});
afterEach(() => cleanup());

describe('creating an operator desk queue', () => {
  it('posts the definition the form built', async () => {
    queuesApi.create.mockResolvedValue(managedRecord());
    open();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Billing desk' } });
    fireEvent.click(screen.getByRole('radio', { name: /Auto-assign/ }));
    fireEvent.change(screen.getByLabelText('Offer lasts'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Require wrap-up after each call' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    await waitFor(() => expect(queuesApi.create).toHaveBeenCalledTimes(1));
    expect(queuesApi.create.mock.calls[0]![0]).toMatchObject({
      kind: 'managed',
      name: 'Billing desk',
      assignment: 'AUTO_ASSIGN',
      offerSeconds: 30,
      wrapUp: { required: true },
      limits: { maxWaiting: 100 },
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('shows the server’s validation issues beside their fields and in a summary', async () => {
    queuesApi.create.mockRejectedValue(
      new ApiError(422, 'queue_invalid', 'invalid', {
        issues: [
          { path: ['name'], message: 'Name is required' },
          { path: ['offerSeconds'], message: 'Between 5 and 120' },
        ],
      }),
    );
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    expect(await screen.findByText(/2 problems to fix/)).toBeTruthy();
    expect(screen.getByText('Name is required', { selector: 'small' })).toBeTruthy();
    expect(screen.getByText('Between 5 and 120', { selector: 'small' })).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('points at the name when another queue already has it', async () => {
    queuesApi.create.mockRejectedValue(new ApiError(409, 'queue_name_taken', 'taken'));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    expect(await screen.findByText('Another queue already has this name.', { selector: 'small' })).toBeTruthy();
  });

  it('explains a stale edit instead of overwriting', async () => {
    queuesApi.update.mockRejectedValue(new ApiError(409, 'queue_conflict', 'stale'));
    open({ record: managedRecord() });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Someone else changed this queue/)).toBeTruthy();
    expect(queuesApi.update).toHaveBeenCalledWith('q-desk', expect.objectContaining({ name: 'Support desk' }), 3);
  });

  it('builds hold steps and a timeout chain', async () => {
    queuesApi.create.mockResolvedValue(managedRecord());
    open();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Desk' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Custom hold experience' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add hold step' }));
    fireEvent.change(screen.getByLabelText('Hold step 2 type'), { target: { value: 'line' } });
    fireEvent.change(screen.getByLabelText('Hold step 2 line (en)'), { target: { value: 'Thanks for waiting.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add timeout step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    await waitFor(() => expect(queuesApi.create).toHaveBeenCalled());
    const hold = queuesApi.create.mock.calls[0]![0].hold;
    expect(hold.steps[1]).toEqual({ kind: 'line', line: { en: 'Thanks for waiting.' } });
    expect(hold.onTimeout.at(-1)).toMatchObject({ kind: 'end' });
    expect(hold.onTimeout).toHaveLength(4);
  });
});

describe('creating a webhook queue', () => {
  it('requires nothing client-side but sends exactly what was entered', async () => {
    queuesApi.create.mockResolvedValue(externalRecord());
    open({ kind: 'external' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/Endpoint URL/), { target: { value: 'https://acd.example.com/h' } });
    await screen.findByRole('option', { name: 'ACD signing secret' });
    fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'acd-hmac' } });
    const prefixes = screen.getByLabelText('Allowed number prefixes');
    fireEvent.change(prefixes, { target: { value: '+9140' } });
    fireEvent.keyDown(prefixes, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    await waitFor(() => expect(queuesApi.create).toHaveBeenCalled());
    expect(queuesApi.create.mock.calls[0]![0]).toMatchObject({
      kind: 'external',
      webhook: { url: 'https://acd.example.com/h', credentialId: 'acd-hmac', method: 'POST' },
      destination: { allowE164Prefixes: ['+9140'] },
    });
    expect(queuesApi.create.mock.calls[0]![0].webhook.body).toBeUndefined();
  });

  it('shows the destination allow-list error from the server', async () => {
    queuesApi.create.mockRejectedValue(
      new ApiError(422, 'queue_invalid', 'invalid', {
        issues: [
          {
            path: ['destination', 'allowE164Prefixes'],
            code: 'routing_queue_destination_policy_empty',
            message: 'Allow at least one number prefix',
          },
        ],
      }),
    );
    open({ kind: 'external' });
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    expect(await screen.findByText('Allow at least one number prefix', { selector: 'small' })).toBeTruthy();
  });

  it('renders a live preview of the mapped body and surfaces mapping issues', async () => {
    queuesApi.preview.mockResolvedValue({
      body: { callId: 'call-sample', language: 'en' },
      issues: [{ path: ['body', 'ani'], message: 'caller.number is switched off by the context policy' }],
    });
    open({ kind: 'external' });
    fireEvent.click(screen.getByRole('switch', { name: 'Map the fields myself' }));
    expect(await screen.findByText(/"callId": "call-sample"/)).toBeTruthy();
    expect(screen.getByText(/caller.number is switched off/)).toBeTruthy();
    expect(queuesApi.preview).toHaveBeenCalled();
    const options = within(screen.getByLabelText('Call field to insert')).getAllByRole('option').map((o) => o.textContent);
    expect(options.join(' ')).not.toContain('caller.number');
  });

  it('inserts a picked field into the mapping', async () => {
    open({ kind: 'external' });
    fireEvent.click(screen.getByRole('switch', { name: 'Map the fields myself' }));
    fireEvent.change(screen.getByLabelText('Call field to insert'), { target: { value: 'queue.name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Mapping (JSON)') as HTMLTextAreaElement).value).toContain('"name": {'),
    );
  });

  it('blocks a reserved header and adds a valid one', () => {
    open({ kind: 'external' });
    fireEvent.change(screen.getByLabelText('New header name'), { target: { value: 'Authorization' } });
    expect(screen.getByText(/set by OVO and cannot be overridden/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add header' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('New header name'), { target: { value: 'X-Region' } });
    fireEvent.change(screen.getByLabelText('New header value'), { target: { value: 'in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    expect(screen.getByLabelText('Header X-Region')).toBeTruthy();
  });

  it('sends a test webhook for a saved queue and shows the redacted result', async () => {
    queuesApi.testWebhook.mockResolvedValue({
      request: { url: 'https://acd.example.com/ovo/handoff', headers: {}, body: {} },
      attempts: [{ attempt: 1, outcome: 'delivered', status: 200, ms: 40 }],
      answer: { kind: 'queued' },
    });
    open({ record: externalRecord(), kind: 'external' });
    fireEvent.click(screen.getByRole('button', { name: 'Send test webhook' }));
    expect(await screen.findByText('Test result')).toBeTruthy();
    expect(screen.getByText(/Secrets are not shown/)).toBeTruthy();
  });

  it('hides the test button from non-admins and for unsaved queues', () => {
    open({ record: externalRecord(), kind: 'external', canTest: false });
    expect(screen.queryByRole('button', { name: 'Send test webhook' })).toBeNull();
    cleanup();
    open({ kind: 'external' });
    expect(screen.queryByRole('button', { name: 'Send test webhook' })).toBeNull();
  });
});
