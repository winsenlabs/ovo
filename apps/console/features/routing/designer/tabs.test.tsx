import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api';
import { audio, numbers, releases } from '../../../e2e/fixtures/routing-data.mjs';
import {
  DesignerHarness,
  IDS,
  resetRouting,
  routingApi,
  sampleDraft,
} from '../routing-test-support';
import { BindDrawer } from './bind-drawer';
import { HoldTransferTab } from './hold-transfer-tab';
import { LinesTab } from './lines-tab';
import { NumbersTab } from './numbers-tab';
import { PublishDrawer } from './publish-drawer';
import { QueuesTab } from './queues-tab';
import { ReleasesTab } from './releases-tab';

vi.mock('../../../lib/data/routing-api', async (importActual) =>
  (await import('../routing-test-support')).routingApiModule(importActual as never),
);
beforeEach(() => resetRouting());
afterEach(() => cleanup());

const preview = (patch = {}) => ({
  issues: [],
  blockers: [],
  warnings: [],
  canPublish: true,
  nextVersion: 4,
  digest: 'd'.repeat(64),
  previous: { id: IDS.r3, version: 3, digest: 'c'.repeat(64), createdAt: '' },
  unchanged: false,
  changes: [
    {
      area: 'node',
      op: 'changed',
      key: 'node intent',
      path: [],
      summary: 'The question on intent changed',
    },
  ],
  pins: [
    {
      path: ['router'],
      agentId: 'agent-front',
      was: 'latest',
      releaseId: 'f1111111-1111-4111-8111-111111111111',
    },
  ],
  ...patch,
});
const drawer = (props = {}) =>
  render(
    <PublishDrawer
      open
      onClose={vi.fn()}
      pointId={IDS.point}
      draftVersion={4}
      dirty={false}
      onSave={vi.fn().mockResolvedValue(true)}
      saving={false}
      onPublished={vi.fn()}
      onBindNumbers={vi.fn()}
      {...props}
    />,
  );

describe('PublishDrawer', () => {
  it('previews the release: digest, grouped changes and pins, then publishes the saved draft', async () => {
    routingApi.previewPublish.mockResolvedValue(preview());
    routingApi.publish.mockResolvedValue({ id: 'new', version: 4 });
    const onPublished = vi.fn();
    drawer({ onPublished });
    expect(await screen.findByText(/This would create/)).toBeTruthy();
    expect(screen.getByText('The question on intent changed')).toBeTruthy();
    expect(screen.getByText(/agent-front/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Published version 4')).toBeTruthy();
    expect(routingApi.publish).toHaveBeenCalledWith(IDS.point, 4);
    expect(onPublished).toHaveBeenCalled();
  });
  it('lists blockers and disables Publish', async () => {
    routingApi.previewPublish.mockResolvedValue(
      preview({
        canPublish: false,
        blockers: [
          {
            code: 'routing_router_missing',
            severity: 'error',
            path: ['router'],
            message: 'The router agent has no release',
          },
        ],
      }),
    );
    drawer();
    expect(await screen.findByText('The router agent has no release')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/1 problem must be fixed first/)).toBeTruthy();
  });
  it('says nothing changed and disables Publish', async () => {
    routingApi.previewPublish.mockResolvedValue(preview({ unchanged: true, changes: [] }));
    drawer();
    expect(await screen.findByText(/No changes since version 3/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it('asks to save first while there are unsaved edits and previews nothing', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    drawer({ dirty: true, onSave });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalled();
    expect(routingApi.previewPublish).not.toHaveBeenCalled();
  });
  it('shows a failed preview with retry and a conflict while publishing', async () => {
    routingApi.previewPublish
      .mockRejectedValueOnce(new Error('preview down'))
      .mockResolvedValue(preview());
    drawer();
    expect(await screen.findByText('preview down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/This would create/);
    routingApi.publish.mockRejectedValue(new ApiError(409, 'routing_point_conflict', 'changed'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/changed on the server while you were reviewing/)).toBeTruthy();
  });
});

describe('ReleasesTab', () => {
  it('lists releases with numbers pinned and compares two', async () => {
    render(
      <ReleasesTab
        pointId={IDS.point}
        numbers={numbers()}
        canEdit
        refreshKey={0}
        onPublish={vi.fn()}
      />,
    );
    expect(await screen.findByText('v3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row ' + IDS.r3 }));
    expect(screen.getByText(/Select a second release/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row ' + IDS.r1 }));
    expect(await screen.findByText('Version 1 to version 3')).toBeTruthy();
    expect(await screen.findByText(/Added branch intent > support/)).toBeTruthy();
  });
  it('shows the never-published state and hides Publish from viewers', async () => {
    routingApi.releases.mockResolvedValue([]);
    render(
      <ReleasesTab
        pointId={IDS.point}
        numbers={[]}
        canEdit={false}
        refreshKey={0}
        onPublish={vi.fn()}
      />,
    );
    expect(await screen.findByText('Never published')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish…' })).toBeNull();
  });
});

describe('NumbersTab and BindDrawer', () => {
  const tab = (isAdmin: boolean, onChanged = vi.fn()) =>
    render(
      <NumbersTab
        pointId={IDS.point}
        pointName="Main line"
        numbers={numbers()}
        isAdmin={isAdmin}
        refreshKey={0}
        onChanged={onChanged}
      />,
    );
  it('states routing point vs direct agent and flags a number that is behind', async () => {
    tab(true);
    expect(await screen.findAllByText('Routing point')).toHaveLength(2);
    expect(screen.getByText('Behind (latest v3)')).toBeTruthy();
    expect(screen.queryByText(/918040000001/)).toBeNull();
  });
  it('binds a behind number to the latest release as an admin', async () => {
    routingApi.bindNumber.mockResolvedValue({});
    const onChanged = vi.fn();
    tab(true, onChanged);
    fireEvent.click(await screen.findByRole('button', { name: /Bind .*80694 50001.* to latest/ }));
    expect(screen.getByText(/moves the number from version 2 to version 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
    await waitFor(() => expect(routingApi.bindNumber).toHaveBeenCalled());
    expect(routingApi.bindNumber.mock.lastCall![1]).toEqual({ routingReleaseId: IDS.r3 });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText(/is now bound to Main line version 3/)).toBeTruthy();
  });
  it('makes a direct number confirm the consequence before binding', async () => {
    render(
      <BindDrawer
        open
        candidates={[numbers()[2]]}
        releases={releases()}
        pointName="Main line"
        onClose={vi.fn()}
        onBound={vi.fn()}
        initial={numbers()[2]}
      />,
    );
    expect(screen.getByText(/the router greets the caller/)).toBeTruthy();
    const bind = screen.getByRole('button', { name: 'Bind' }) as HTMLButtonElement;
    expect(bind.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(bind.disabled).toBe(false);
  });
  it('shows a conflict reason, and gives viewers no bind actions', async () => {
    routingApi.bindNumber.mockRejectedValue(new ApiError(409, 'inbound_route_conflict', 'changed'));
    render(
      <BindDrawer
        open
        candidates={[numbers()[1]]}
        initial={numbers()[1]}
        releases={releases()}
        pointName="Main line"
        onClose={vi.fn()}
        onBound={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
    expect(await screen.findByText(/changed while you were looking/)).toBeTruthy();
    cleanup();
    tab(false);
    expect(await screen.findByText('Only admins can bind numbers.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bind a number' })).toBeNull();
  });
});

describe('LinesTab', () => {
  it('flags a line missing the default language and a language that is not allowed', () => {
    const draft = sampleDraft();
    draft.nodes[0]!.ask = { hi: 'namaste', fr: 'bonjour' };
    render(
      <DesignerHarness draft={draft}>
        <LinesTab />
      </DesignerHarness>,
    );
    expect(screen.getByText('Missing en')).toBeTruthy();
    expect(screen.getByText('fr not allowed')).toBeTruthy();
  });
  it('edits the greeting and turns idle prompts on', () => {
    let latest = sampleDraft();
    render(
      <DesignerHarness draft={{ ...sampleDraft(), idle: undefined }} onDraft={(d) => (latest = d)}>
        <LinesTab />
      </DesignerHarness>,
    );
    fireEvent.change(screen.getByLabelText('Greeting (en)'), { target: { value: 'Hi' } });
    expect(latest.greeting.en).toBe('Hi');
    fireEvent.click(screen.getByRole('switch', { name: 'Prompt a caller who goes quiet' }));
    expect(latest.idle?.prompts).toHaveLength(1);
  });
  it('is read only for a viewer', () => {
    render(
      <DesignerHarness canEdit={false}>
        <LinesTab />
      </DesignerHarness>,
    );
    expect(
      (
        screen
          .getByLabelText('Greeting (en)')
          .closest('fieldset.rt-readonly') as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);
  });
});

describe('HoldTransferTab', () => {
  it('draws the hold, lists targets and edits one in a drawer', () => {
    let latest = sampleDraft();
    render(
      <DesignerHarness onDraft={(d) => (latest = d)}>
        <HoldTransferTab pointId={IDS.point} />
      </DesignerHarness>,
    );
    expect(screen.getByRole('img', { name: /Hold timeline/ })).toBeTruthy();
    expect(screen.getByRole('row', { name: /sales_desk/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit target sales_desk' }));
    const dialog = screen.getByRole('dialog', { name: 'Transfer target sales_desk' });
    fireEvent.change(within(dialog).getByLabelText('When to use it'), {
      target: { value: 'Buying cards' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save target' }));
    expect(latest.transfer!.targets[1]!.description).toBe('Buying cards');
  });
  it('refuses a duplicate target key and adds a new target', () => {
    let latest = sampleDraft();
    render(
      <DesignerHarness onDraft={(d) => (latest = d)}>
        <HoldTransferTab pointId={IDS.point} />
      </DesignerHarness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add target' }));
    const dialog = screen.getByRole('dialog', { name: 'New transfer target' });
    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'billing' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save target' }));
    expect(within(dialog).getByText('A target called billing already exists.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Key'), { target: { value: 'loans' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save target' }));
    expect(latest.transfer!.targets.map((t) => t.key)).toEqual(['billing', 'sales_desk', 'loans']);
  });
  it('warns that transfers are inert while they are off', () => {
    render(
      <DesignerHarness
        env={{
          status: {
            enabled: true,
            externalEnabled: true,
            transferEnabled: false,
            humanQueueEnabled: true,
          },
        }}
      >
        <HoldTransferTab pointId={IDS.point} />
      </DesignerHarness>,
    );
    expect(screen.getByText(/saved but\s+inert/)).toBeTruthy();
  });
  it('shows a clip in the timeline with its real length', () => {
    expect(audio()[0]!.durationMs).toBe(42_000);
    render(
      <DesignerHarness>
        <HoldTransferTab pointId={IDS.point} />
      </DesignerHarness>,
    );
    return screen
      .findAllByText('Hold music')
      .then((found) => expect(found.length).toBeGreaterThan(0));
  });
});

describe('QueuesTab', () => {
  const queue = {
    id: IDS.queueDesk,
    version: 1,
    definition: { kind: 'managed', name: 'Support desk' },
    stats: { online: 2, waiting: 0, offered: 0, oldestWaitMs: 0, handled24h: 0 },
    usedBy: [],
    updatedAt: '',
  } as never;
  const status = {
    enabled: true,
    webhookEnabled: true,
    managedAvailable: true,
    room: { configured: true },
  };
  it('shows readiness and where each key is used, and renames a key everywhere', () => {
    let latest = sampleDraft();
    render(
      <DesignerHarness onDraft={(d) => (latest = d)} env={{ queues: [queue], queueStatus: status }}>
        <QueuesTab />
      </DesignerHarness>,
    );
    expect(screen.getByText('2 online')).toBeTruthy();
    expect(screen.getByText(/Used in intent > person/)).toBeTruthy();
    const key = screen.getByLabelText('Key');
    fireEvent.change(key, { target: { value: 'floor' } });
    fireEvent.blur(key);
    expect(latest.humanQueues![0]!.key).toBe('floor');
    expect((latest.nodes[0]!.branches[2]!.target as { queueId: string }).queueId).toBe('floor');
  });
  it('says so when queues are off or none are bound, and unbinds', () => {
    let latest = sampleDraft();
    render(
      <DesignerHarness
        onDraft={(d) => (latest = d)}
        env={{
          status: {
            enabled: true,
            externalEnabled: true,
            transferEnabled: true,
            humanQueueEnabled: false,
          },
        }}
      >
        <QueuesTab />
      </DesignerHarness>,
    );
    expect(screen.getByText(/Human queues are not enabled here/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unbind desk' }));
    expect(latest.humanQueues).toBeUndefined();
    expect(screen.getByText('No queues bound')).toBeTruthy();
  });
});
