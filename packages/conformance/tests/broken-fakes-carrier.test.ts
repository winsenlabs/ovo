import { describe, expect, it } from 'vitest';
import type {
  CarrierCapabilities,
  CarrierControlFactory,
  CarrierIngress,
  MediaCommand,
  Reconciliation,
} from '@winsendotai/ovo-contracts';
import {
  FIXTURE_STATUS_MAP,
  checkCarrier,
  fixtureCarrierControl,
  fixtureCarrierIngress,
  fixtureCarrierKitOptions,
  fixtureStatusOf,
  type CarrierKitOptions,
  type KitFailure,
} from '../src/index.ts';

const messages = (failures: KitFailure[]) => failures.map((f) => f.message).join('\n');

type Env = { net: Parameters<typeof fixtureCarrierControl>[0] };

/** The fixture carrier with one deliberate defect, run through a named subset of the kit. */
function broken(
  patch: (parts: { control: CarrierControlFactory; ingress: CarrierIngress }) => {
    control: CarrierControlFactory;
    ingress: CarrierIngress;
  },
  only: string[],
  options: Partial<CarrierKitOptions> = {},
): Promise<KitFailure[]> {
  return checkCarrier(
    ({ net }: Env) =>
      patch({ control: fixtureCarrierControl(net), ingress: fixtureCarrierIngress() }),
    { ...fixtureCarrierKitOptions(), ...options },
    { only },
  );
}

const withControl = (
  control: CarrierControlFactory,
  overrides: Partial<ReturnType<CarrierControlFactory['create']>>,
  capabilities?: CarrierCapabilities,
): CarrierControlFactory => ({
  capabilities: capabilities ?? control.capabilities,
  create: (binding) => ({ ...control.create(binding), ...overrides }),
});

describe('checkCarrier rejects a control plane that never reaches the carrier', () => {
  it('flags a hangup that reports ended without consuming its REST step (F1)', async () => {
    const failures = await broken(
      ({ control, ingress }) => ({
        control: withControl(control, { hangup: async () => 'ended' as const }),
        ingress,
      }),
      ['REST shapes'],
    );
    expect(messages(failures)).toMatch(/hangup: unconsumed/);
  });

  it('flags a reconcile that answers without its REST step, and one that calls out blind (F7)', async () => {
    const quiet = await broken(
      ({ control, ingress }) => ({
        control: withControl(control, {
          reconcile: async (): Promise<Reconciliation> => ({
            kind: 'ended',
            carrierCallId: 'CA1',
            state: 'completed',
          }),
        }),
        ingress,
      }),
      ['reconcile follows'],
    );
    expect(messages(quiet)).toMatch(/reconcile: unconsumed/);
    const blind = await broken(
      ({ control, ingress }) => ({
        control: withControl(control, {
          reconcile: (query) =>
            control.create({ ...fixtureCarrierKitOptions().binding }).reconcile({
              ...query,
              carrierCallId: query.carrierCallId ?? 'CA1',
            }),
        }),
        ingress,
      }),
      ['reconcile follows'],
    );
    expect(messages(blind)).toMatch(/reconcile without a carrier id still reached the network/);
  });

  it('flags a handoff that confirms without REST and one that accepts an undeclared target (F7)', async () => {
    const failures = await broken(
      ({ control, ingress }) => ({
        control: withControl(control, {
          handoff: async () => ({ kind: 'confirmed', receiptId: 'made-up' }) as const,
        }),
        ingress,
      }),
      ['handoff performs'],
    );
    expect(messages(failures)).toMatch(/handoff 'phone': unconsumed/);
    expect(messages(failures)).toMatch(/handoff to the undeclared 'queue' returned confirmed/);
  });
});

describe('checkCarrier rejects unproven callback authentication and snapshots', () => {
  it('refuses a carrier that supplies no signed per-call requests (F2)', async () => {
    const failures = await broken(({ control, ingress }) => ({ control, ingress }), ['per-call'], {
      requests: undefined,
    });
    expect(messages(failures)).toMatch(/supply options\.requests\.status/);
    expect(messages(failures)).toMatch(/supply options\.requests\.resume/);
  });

  it('refuses an empty status snapshot and one that hides a status it maps (F3)', async () => {
    const empty = await broken(({ control, ingress }) => ({ control, ingress }), ['status map'], {
      statusMap: { map: fixtureStatusOf, expected: {} },
    });
    expect(messages(empty)).toMatch(/statusMap\.expected is empty/);
    const { busy: _busy, ...rest } = FIXTURE_STATUS_MAP;
    const partial = await broken(({ control, ingress }) => ({ control, ingress }), ['status map'], {
      statusMap: { map: fixtureStatusOf, expected: rest },
    });
    expect(messages(partial)).toMatch(/status busy maps to busy but is missing from the snapshot/);
  });
});

describe('checkCarrier rejects ingress routes that skip the host', () => {
  it('flags a resume route that never calls host.resumeStream (F7)', async () => {
    const failures = await broken(
      ({ control, ingress }) => ({
        control,
        ingress: {
          ...ingress,
          routes: ingress.routes.map((route) =>
            route.purpose === 'resume'
              ? {
                  ...route,
                  handle: async () => ({
                    status: 200,
                    contentType: 'application/xml',
                    body: '<Response><Hangup/></Response>',
                  }),
                }
              : route,
          ),
        },
      }),
      ['resume route'],
    );
    expect(messages(failures)).toMatch(/host\.resumeStream was not called for this binding/);
  });

  it('flags a status route that never normalises into host.applyCallEvent (F7)', async () => {
    const failures = await broken(
      ({ control, ingress }) => ({
        control,
        ingress: {
          ...ingress,
          routes: ingress.routes.map((route) =>
            route.purpose === 'status'
              ? {
                  ...route,
                  handle: async () => ({ status: 204, contentType: 'text/plain', body: '' }),
                }
              : route,
          ),
        },
      }),
      ['status route'],
    );
    expect(messages(failures)).toMatch(/status produced 0 call events/);
  });
});

describe('checkCarrier rejects undeclared media framing and untested transcripts', () => {
  it('flags a codec that chunks audio without declaring media.outboundChunk (F7)', async () => {
    const failures = await broken(
      ({ control, ingress }) => ({
        control,
        ingress: {
          ...ingress,
          serializer: {
            ...ingress.serializer,
            createSession(params: Record<string, string>) {
              const session = ingress.serializer.createSession(params);
              return {
                ...session,
                decode: (raw: string) => session.decode(raw),
                flush: () => session.flush(),
                encode: (command: MediaCommand) =>
                  command.type === 'audio'
                    ? [
                        ...session.encode({
                          type: 'audio',
                          payload: command.payload.slice(0, 160),
                        }),
                        ...session.encode({ type: 'audio', payload: command.payload.slice(160) }),
                      ]
                    : session.encode(command),
              };
            },
          },
        },
      }),
      ['outbound audio framing'],
    );
    expect(messages(failures)).toMatch(/without declaring media\.outboundChunk/);
  });

  it('flags an inbound-only transcript that never exercises encode or flush (F6)', async () => {
    const base = fixtureCarrierKitOptions();
    const inboundOnly = base.transcripts!.map((entry) => ({
      ...entry,
      fixture: {
        ...entry.fixture,
        lines: entry.fixture.lines.filter((line) => line.dir === 'in'),
      },
    }));
    const failures = await broken(
      ({ control, ingress }) => ({ control, ingress }),
      ['transcripts exercise'],
      {
        transcripts: inboundOnly,
      },
    );
    expect(messages(failures)).toMatch(/no transcript line encodes a 'audio' command/);
    expect(messages(failures)).toMatch(/flush\(\) is never exercised/);
  });
});
