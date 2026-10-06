import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignRecord } from '../../lib/operator-api';
import { ConfirmDialogProvider } from '../ui/dialog';
import { callingWindowBody } from './campaign-calling-window';
import { callingHoursLabel } from './campaigns-view';
import { parseDoNotCallNumbers } from './do-not-call-import';
import { SuppressionsView } from './suppressions-view';
import { maskedNumber, TestCallPanel } from './test-call-panel';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

const campaign = {
  id: 'campaign-1',
  name: 'October collections',
  agentReleaseId: 'release-1',
  fromNumber: '+918000000000',
  status: 'running',
  scheduleAt: '2026-10-06T03:30:00Z',
  timezone: 'Asia/Kolkata',
  perNumberAttemptLimit: 1,
  maxAttemptsTotal: 10,
  maxAttemptsPerLocalDay: 10,
  activeCallPolicy: 'continue',
  version: 1,
  callingWindow: {
    start: '08:00',
    end: '19:00',
    days: [1, 2, 3, 4, 5, 6],
    timezone: 'Asia/Kolkata',
  },
} as unknown as CampaignRecord;
const contact = {
  id: 'contact-1',
  sourceRow: 2,
  phoneNumber: '+919812345678',
  externalId: 'LN-77',
  variables: { name: 'Asha', amountDue: '12000' },
  state: 'queued',
};

beforeEach(() => {
  request.mockReset();
});
afterEach(() => cleanup());

describe('test call with a customer', () => {
  it('dials the test number with the chosen contact variables, and checks first on request', async () => {
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/operations/campaigns/campaign-1/contacts?limit=100')
        return { data: { items: [contact], nextCursor: null } };
      if (path === '/calls') {
        const body = JSON.parse(String(init?.body));
        return body.dryRun
          ? {
              data: {
                dryRun: true,
                to: body.to,
                fromNumber: body.fromNumber,
                variables: Object.keys(body.variables),
                callingWindow: null,
                carrierId: 'twilio',
              },
            }
          : { data: { callId: 'call-9', status: 'queued' } };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<TestCallPanel role="admin" campaigns={[campaign]} />);
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'campaign-1' } });
    await screen.findByRole('option', { name: /Row 2 · LN-77 · \+91•••5678/ });
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'contact-1' } });
    fireEvent.change(screen.getByLabelText('Test number to dial'), {
      target: { value: '+919900000001' },
    });
    expect((screen.getByLabelText('Permitted from number') as HTMLInputElement).value).toBe(
      '+918000000000',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check without dialing' }));
    expect(
      await screen.findByText(/would dial \+919900000001 via twilio with 2 variables/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dial test number' }));
    expect(await screen.findByText(/Test call call-9 was accepted/)).toBeTruthy();
    const calls = request.mock.calls.filter(([path]) => path === '/calls');
    const [dry, live] = calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(dry).toMatchObject({
      releaseId: 'release-1',
      to: '+919900000001',
      variables: { name: 'Asha', amountDue: '12000' },
      dryRun: true,
    });
    expect(live).toMatchObject({ to: '+919900000001', dryRun: false });
    // The customer's own number is never dialed.
    expect(JSON.stringify(calls)).not.toContain('+919812345678');
  });

  it('shows the server refusal, such as calling hours, and renders nothing for non-admins', async () => {
    request.mockImplementation(async (path: string) => {
      if (path.endsWith('/contacts?limit=100')) return { data: { items: [] } };
      throw new Error('Calls to this agent are allowed 08:00-19:00 Asia/Kolkata');
    });
    const { unmount } = render(<TestCallPanel role="admin" campaigns={[campaign]} />);
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'campaign-1' } });
    fireEvent.change(screen.getByLabelText('Test number to dial'), {
      target: { value: '+919900000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dial test number' }));
    expect(await screen.findByText(/allowed 08:00-19:00/)).toBeTruthy();
    unmount();
    render(<TestCallPanel role="editor" campaigns={[campaign]} />);
    expect(screen.queryByText("Test call with a customer's data")).toBeNull();
  });

  it('masks all but the last four digits', () => {
    expect(maskedNumber('+919812345678')).toBe('+91•••5678');
  });
});

describe('calling hours and do-not-call helpers', () => {
  it('sends a campaign window only when the campaign sets its own', () => {
    const form = new FormData();
    form.set('callingWindowMode', 'release');
    expect(callingWindowBody(form)).toEqual({});
    form.set('callingWindowMode', 'campaign');
    form.set('callingWindowStart', '09:00');
    form.set('callingWindowEnd', '18:00');
    for (const day of ['1', '2', '3', '4', '5']) form.append('callingWindowDays', day);
    expect(callingWindowBody(form)).toEqual({
      callingWindow: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    });
    for (const day of ['6', '7']) form.append('callingWindowDays', day);
    expect(callingWindowBody(form)).toEqual({ callingWindow: { start: '09:00', end: '18:00' } });
  });

  it('labels a campaign window and a campaign without one', () => {
    expect(callingHoursLabel(campaign)).toBe(
      'Calls 08:00–19:00 Mon,Tue,Wed,Thu,Fri,Sat Asia/Kolkata',
    );
    expect(callingHoursLabel({ ...campaign, callingWindow: null } as CampaignRecord)).toBe(
      'Any hour',
    );
  });

  it('reads numbers from pasted lines or a CSV, skipping headers and duplicates', () => {
    expect(
      parseDoNotCallNumbers('phone,name\n"+919800000001",Asha\n+919800000002\n\n+919800000001,x'),
    ).toEqual(['+919800000001', '+919800000002']);
  });
});

describe('do-not-call list page', () => {
  it('shows each entry source and imports pasted numbers in one request', async () => {
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/operations/suppressions?limit=100')
        return {
          data: {
            items: [
              {
                phoneNumber: '+919800000009',
                reason: 'Caller asked not to be called again',
                source: 'opt_out',
                callId: 'call-77',
                createdAt: '2026-10-06T05:00:00Z',
                updatedAt: '2026-10-06T05:00:00Z',
              },
            ],
          },
        };
      if (path === '/operations/suppressions/import' && init?.method === 'POST')
        return { data: { added: 2, updated: 0 } };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(
      <ConfirmDialogProvider>
        <SuppressionsView role="editor" />
      </ConfirmDialogProvider>,
    );
    expect(await screen.findByText('Caller opted out')).toBeTruthy();
    expect(screen.getByText('call-77')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Numbers, one per line or a CSV'), {
      target: { value: '+919800000001\n+919800000002' },
    });
    fireEvent.change(screen.getByLabelText('Import note'), { target: { value: 'NCPR export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 numbers' }));
    expect(await screen.findByText('2 added, 0 already listed.')).toBeTruthy();
    const [, init] = request.mock.calls.find(
      ([path]) => path === '/operations/suppressions/import',
    )!;
    expect(JSON.parse(String(init.body))).toEqual({
      entries: [
        { phoneNumber: '+919800000001', reason: 'NCPR export' },
        { phoneNumber: '+919800000002', reason: 'NCPR export' },
      ],
    });
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([path]) => path === '/operations/suppressions?limit=100'),
      ).toHaveLength(2),
    );
  });
});
