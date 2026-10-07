import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCompliance as AgentComplianceSchema } from '@winsendotai/ovo-contracts';
import { ApiError } from '../../lib/api';
import { campaignComplianceBody } from '../operations/campaign-calling-window';
import { lockedUntil, SuppressionsView } from '../operations/suppressions-view';
import {
  categoryFloor,
  ComplianceCategoryFields,
  type ComplianceCategoryBlock,
} from '../studio/compliance-category-fields';
import { ConfirmDialogProvider } from '../ui/dialog';
import { ComplaintsPanel } from './complaints-panel';
import { exportHref } from './compliance-evidence-panel';
import { ComplianceSettingsPanel } from './compliance-settings-panel';
import { dueLabel, type SettingsRecord } from './compliance-types';
import { parseScrubRows } from './consent-records-panel';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

// A block body: a function returned from beforeEach would run as the test's teardown.
beforeEach(() => {
  request.mockReset();
});
// jsdom has no modal dialogs; the confirm dialog only needs open and close.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(() => cleanup());

const record: SettingsRecord = {
  settings: {
    sender: { regulator: 'other' },
    enforcement: {
      series: 'refuse',
      a2pDeclarationRequiredFrom: '2026-11-17',
      abandonedBreaker: 'enforce',
      recoveryCapsAreFloor: true,
      testNumberCaps: 'exempt',
    },
    optOutScope: 'all',
    testNumbers: [],
    blackout: { dates: ['01-26', '08-15', '10-02'], appliesTo: ['promotional', 'rbi_recovery'] },
    complaintSla: { ackHours: 24, resolveDays: 7, representBusinessDays: 5 },
    caps: { service: { attempts: { per24h: 2 } } },
  },
  version: 3,
  updatedAt: null,
  rulePack: { id: 'IN-TCCCPR', version: '2026.10.1' },
  providers: ['manual-upload'],
};

describe('compliance settings', () => {
  it('saves the form over the other settings with the version it read', async () => {
    request.mockResolvedValue({ data: {} });
    const onSaved = vi.fn(async () => undefined);
    render(<ComplianceSettingsPanel record={record} canEdit onSaved={onSaved} />);
    expect(screen.getByText(/No autodialler intimation is on file/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Regulator'), { target: { value: 'rbi' } });
    fireEvent.change(screen.getByLabelText('Intimation submitted'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('Telco (OAP)'), { target: { value: 'Example telco' } });
    fireEvent.change(screen.getByLabelText('Stated objective'), {
      target: { value: 'EMI reminders' },
    });
    fireEvent.change(screen.getByLabelText('Intimation reference'), {
      target: { value: 'OAP/17' },
    });
    fireEvent.change(screen.getByLabelText('Test numbers (one per line)'), {
      target: { value: '+919811100000\n+919811100001' },
    });
    fireEvent.change(screen.getByLabelText('Caps for test numbers'), {
      target: { value: 'enforce' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe('/operations/compliance/settings');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      expectedVersion: 3,
      settings: {
        sender: { regulator: 'rbi' },
        autodialerIntimation: { submittedAt: '2026-09-01', documentRef: 'OAP/17' },
        testNumbers: ['+919811100000', '+919811100001'],
        enforcement: { testNumberCaps: 'enforce', recoveryCapsAreFloor: true },
        caps: { service: { attempts: { per24h: 2 } } },
      },
    });
  });

  it('reloads when someone else saved first', async () => {
    request.mockImplementation(() => {
      throw new ApiError(409, 'compliance_settings_conflict', 'changed');
    });
    const onSaved = vi.fn(async () => undefined);
    render(<ComplianceSettingsPanel record={record} canEdit onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Someone else changed these settings/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('complaints', () => {
  it('shows what is overdue and moves a complaint on', async () => {
    request.mockResolvedValue({ data: {} });
    const onChanged = vi.fn(async () => undefined);
    const received = new Date(Date.now() - 30 * 3_600_000).toISOString();
    render(
      <ComplaintsPanel
        canEdit
        onChanged={onChanged}
        complaints={[
          {
            id: 'complaint-1',
            kind: 'customer',
            phoneNumber: '+919800000001',
            receivedAt: received,
            status: 'open',
            ackDueAt: new Date(Date.parse(received) + 24 * 3_600_000).toISOString(),
            resolveDueAt: new Date(Date.parse(received) + 7 * 24 * 3_600_000).toISOString(),
            overdue: 'ack',
          },
        ]}
      />,
    );
    expect(screen.getByText('1 overdue')).toBeTruthy();
    expect(screen.getByText(/Acknowledgement 6 h overdue/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark acknowledged' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(
      '/operations/compliance/complaints/complaint-1/transition',
      {
        method: 'POST',
        body: JSON.stringify({ status: 'acknowledged' }),
      },
    );
  });
});

describe('do-not-call removal', () => {
  const entries = [
    {
      phoneNumber: '+919800000009',
      reason: 'Caller asked',
      source: 'opt_out',
      scope: 'all',
      lockUntil: new Date(Date.now() + 80 * 86_400_000).toISOString(),
      createdAt: '2026-10-06T05:00:00Z',
      updatedAt: '2026-10-06T05:00:00Z',
    },
    {
      phoneNumber: '+919800000010',
      reason: 'Typo',
      source: 'manual',
      scope: 'all',
      createdAt: '2026-10-06T05:00:00Z',
      updatedAt: '2026-10-06T05:00:00Z',
    },
  ];

  it('needs an admin and a reason, and never offers to remove a locked opt-out', async () => {
    request.mockImplementation(async (path?: string) =>
      path?.startsWith('/operations/suppressions?')
        ? { data: { items: entries } }
        : { data: undefined },
    );
    render(
      <ConfirmDialogProvider>
        <SuppressionsView role="admin" />
      </ConfirmDialogProvider>,
    );
    expect(await screen.findByText(/Locked until/)).toBeTruthy();
    const [locked, manual] = screen.getAllByRole('button', {
      name: 'Remove',
    }) as HTMLButtonElement[];
    expect(locked!.disabled).toBe(true);
    expect(manual!.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason for removal'), {
      target: { value: 'Added by mistake' },
    });
    expect(manual!.disabled).toBe(false);
    expect(locked!.disabled).toBe(true);
    fireEvent.click(manual!);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/operations/suppressions/%2B919800000010?reason=Added%20by%20mistake',
        { method: 'DELETE' },
      ),
    );
  });

  it('knows when a lock has run out', () => {
    expect(lockedUntil({ lockUntil: '2020-01-01T00:00:00Z' })).toBeUndefined();
    expect(lockedUntil({})).toBeUndefined();
  });
});

describe('agent category and helpers', () => {
  it('sets the category and purpose and explains the floor they bring', () => {
    let current: ComplianceCategoryBlock = {};
    function Harness() {
      const [block, setBlock] = useState<ComplianceCategoryBlock>({});
      return (
        <ComplianceCategoryFields
          block={block}
          patch={(next) => {
            current = { ...block, ...next };
            setBlock(current);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText(/no \+91 number is dialed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Call category'), { target: { value: 'service' } });
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'rbi_recovery' } });
    expect(screen.getByText(/08:00–19:00 IST/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/AI line/));
    expect(current.disclosures?.ai?.text).toBe('I am an automated assistant.');
    expect(AgentComplianceSchema.safeParse(current).success).toBe(true);
    expect(categoryFloor({ category: 'promotional' })).toMatch(/140-series/);
  });

  it('builds request bodies and labels', () => {
    const form = new FormData();
    expect(campaignComplianceBody(form)).toEqual({});
    form.set('consentBasis', 'explicit_service_7d');
    expect(campaignComplianceBody(form)).toEqual({
      compliance: { consentBasis: 'explicit_service_7d' },
    });
    expect(
      parseScrubRows('phone,result\n+919800000001,allowed\n"+919800000002",fully_blocked\nbad,x'),
    ).toEqual([
      { phoneNumber: '+919800000001', result: 'allowed' },
      { phoneNumber: '+919800000002', result: 'fully_blocked' },
    ]);
    expect(exportHref('2026-10-01', '2026-10-07')).toBe(
      '/api/v1/operations/compliance/export?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T00%3A00%3A00.000Z',
    );
    expect(dueLabel(new Date(Date.now() + 3 * 86_400_000).toISOString())).toBe('due in 3 d');
  });
});
