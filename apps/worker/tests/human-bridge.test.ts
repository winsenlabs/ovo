import { describe, expect, it, vi } from 'vitest';
import { fakeStt, managedQueue } from './human-fixtures.ts';
import { connect, events, harness, onTimeout } from './human-managed-fixture.ts';
import { holdPolicy, transferPolicy } from './transfer-fixtures.ts';

describe('the operator ends the call or sends the caller back', () => {
  it('ends the call on the operator command and reports the segment', async () => {
    const h = harness();
    await connect(h);
    const seq = h.service.command('ticket-1', { kind: 'end_call' });
    await h.clock.advance(300);
    await vi.waitFor(() => expect(h.link.closed).toEqual(['behavior_completed']));
    expect(h.service.acks).toContain(seq);
    expect(h.hangUps).toEqual(['behavior_completed']);
    await h.controller.close('behavior_completed');
    const ended = events(h, 'segment.ended').at(-1)!;
    expect(ended).toMatchObject({ role: 'human', ended: 'operator_end', ticketId: 'ticket-1' });
    expect(
      (ended.usage as Record<string, number>)['ovo.human.operator_seconds'],
    ).toBeGreaterThanOrEqual(0);
    expect(Object.keys(ended.usage as object)).toEqual([
      'ovo.human.operator_seconds',
      'ovo.human.room_seconds',
    ]);
    expect(h.service.releases.at(-1)).toEqual({ id: 'ticket-1', code: 'ended_by_operator' });
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'ended', operator: 'ana' });
    expect(h.rooms.seat().closed).toBe(true);
    expect(h.rooms.deleted).toEqual(['ovo-hq-ticket-1']);
  });

  it('a caller hang-up releases the ticket and closes the seat and the room', async () => {
    const h = harness();
    await connect(h);
    h.link.hangup('caller_hangup');
    await h.controller.close('caller_hangup');
    expect(h.service.releases.at(-1)).toEqual({ id: 'ticket-1', code: 'call_ended' });
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'caller_hangup' });
    expect(h.rooms.seat().closed).toBe(true);
    expect(h.rooms.deleted).toContain('ovo-hq-ticket-1');
    // Closing again changes nothing.
    await h.controller.close('caller_hangup');
    expect(events(h, 'human.completed')).toHaveLength(1);
  });

  it('sends the caller back to an agent: a house-voice line, then the agent answers', async () => {
    const h = harness({
      policy: transferPolicy({
        hold: holdPolicy({ maxSeconds: 60, onTimeout }),
        targets: [
          {
            key: 'billing',
            description: 'Billing',
            destination: {
              kind: 'agent',
              agent: { agentId: 'agent-a', release: { kind: 'pinned', releaseId: 'release-a' } },
            },
          } as never,
        ],
      }),
    });
    await connect(h);
    h.service.command('ticket-1', { kind: 'return_to_agent', target: 'billing' });
    await h.clock.advance(300);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.holds.flatMap((hold) => hold.log).find((line) => line.startsWith('say:'))).toMatch(
      /^say:I'm transferring your call now/,
    );
    expect(h.link.closed).toEqual([]);
    expect(h.service.releases.at(-1)).toEqual({ id: 'ticket-1', code: 'returned' });
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'returned' });
    expect(events(h, 'segment.ended').map((e) => e.ended)).toEqual(['handoff', 'handoff']);
    expect(events(h, 'route.segment').at(-1)).toMatchObject({
      role: 'agent',
      index: 2,
      reason: 'transfer',
    });
  });

  it('keeps the operator on the call when the controller refuses the return', async () => {
    const h = harness({
      policy: transferPolicy({
        hold: holdPolicy({ maxSeconds: 60, onTimeout }),
        targets: [
          {
            key: 'billing',
            description: 'Billing',
            destination: {
              kind: 'agent',
              agent: {
                agentId: 'agent-x',
                release: { kind: 'pinned', releaseId: 'release-unlisted' },
              },
            },
          } as never,
        ],
      }),
    });
    await connect(h);
    h.service.command('ticket-1', { kind: 'return_to_agent', target: 'billing' });
    await h.clock.advance(300);
    expect(h.controller.attached?.role).toBe('human');
    h.service.command('ticket-1', { kind: 'return_to_agent', target: 'refunds' });
    await h.clock.advance(300);
    expect(h.audits.map(([type]) => type)).toContain('human.command.refused');
    expect(h.controller.attached?.role).toBe('human');
    expect(h.service.releases).toEqual([]);
  });

  it('gives an operator who drops out five seconds to come back', async () => {
    const h = harness();
    await connect(h);
    h.rooms.seat().leave('op:ana');
    await h.clock.advance(3_000);
    h.rooms.seat().join('op:ana');
    await h.clock.advance(10_000);
    expect(h.link.closed).toEqual([]);
    h.rooms.seat().leave('op:ana');
    await h.clock.advance(5_500);
    await vi.waitFor(() => expect(h.link.closed).toEqual(['behavior_completed']));
    await h.controller.close('behavior_completed');
    expect(h.service.releases.at(-1)).toEqual({ id: 'ticket-1', code: 'operator_left' });
  });

  it('returns the caller to the default target when the queue says so', async () => {
    const h = harness({
      queues: [managedQueue({ onOperatorLeave: 'return_to_agent', returnDefault: 'billing' })],
      policy: transferPolicy({
        hold: holdPolicy({ maxSeconds: 60, onTimeout }),
        targets: [
          {
            key: 'billing',
            description: 'Billing',
            destination: {
              kind: 'agent',
              agent: { agentId: 'agent-a', release: { kind: 'pinned', releaseId: 'release-a' } },
            },
          } as never,
        ],
      }),
    });
    await connect(h);
    h.rooms.seat().leave('op:ana');
    await h.clock.advance(5_500);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.service.releases.at(-1)).toEqual({ id: 'ticket-1', code: 'operator_left' });
    expect(events(h, 'human.completed')[0]).toMatchObject({ outcome: 'returned' });
  });

  it('ends as the operator leaving when an admin releases the ticket under the call', async () => {
    const h = harness();
    await connect(h);
    h.service.end('ticket-1', 'released', 'operator_left');
    await h.clock.advance(300);
    await vi.waitFor(() => expect(h.link.closed).toEqual(['behavior_completed']));
  });
});

describe('the bridge under pressure', () => {
  it('drops the oldest operator frames when the carrier falls behind, and counts them', async () => {
    const h = harness();
    await connect(h);
    h.link.bufferedBytes = 100_000;
    for (let i = 0; i < 60; i += 1) h.rooms.seat().operatorAudio(new Uint8Array(160).fill(i));
    await h.clock.advance(100);
    expect(h.link.frames).toHaveLength(0);
    h.link.bufferedBytes = 0;
    await h.clock.advance(1_000);
    await vi.waitFor(() => expect(h.link.frames.length).toBeGreaterThan(0));
    // 60 queued into 50: the ten oldest are gone, the newest survive in order.
    expect(h.link.frames[0]![0]).toBe(10);
    expect(h.link.frames.at(-1)![0]).toBe(59);
    await h.controller.close('caller_hangup');
    expect(h.logs.find(([event]) => event === 'human_bridge_closed')?.[1]).toMatchObject({
      droppedOut: 10,
    });
  });
});

describe('captions and the transcript (human queue design 7.5)', () => {
  const heard = (text: string, final = true) =>
    ({
      type: 'transcript',
      segment: { segmentId: 'x', revision: 1, text, stability: final ? 'final' : 'interim' },
    }) as const;

  it('sends captions to the operator only, and the finals to the call transcript', async () => {
    const stt = fakeStt();
    const transcripts: unknown[] = [];
    const h = harness({
      queues: [managedQueue({ ai: { mode: 'transcribe', transcribeOperator: true } })],
      stt: async () => stt.opened,
      transcript: (event, segment) => transcripts.push([segment, event]),
    });
    await connect(h);
    await vi.waitFor(() => expect(stt.sessions).toHaveLength(2));
    h.link.audio(new Uint8Array(160).fill(3));
    stt.sessions[0]!.emit(heard('hello there'));
    stt.sessions[1]!.emit(heard('how can I help', false));
    const captions = h.rooms.seat().data.filter((message) => message.topic === 'ovo.caption');
    expect(
      captions.map((message) => [JSON.parse(message.payload).role, message.identities]),
    ).toEqual([
      ['caller', ['op:ana']],
      ['operator', ['op:ana']],
    ]);
    expect(transcripts).toEqual([
      [
        1,
        expect.objectContaining({ type: 'user.transcript', text: 'hello there', turnId: 's1:hc1' }),
      ],
    ]);
    await vi.waitFor(() => expect(stt.sessions[0]!.frames.length).toBe(1));
  });

  it('opens no STT in out mode', async () => {
    const open = vi.fn();
    const h = harness({ stt: open, transcript: () => undefined });
    await connect(h);
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps the call and its audio when the STT fails', async () => {
    const stt = fakeStt({ failStart: true });
    const h = harness({
      queues: [managedQueue({ ai: { mode: 'transcribe', transcribeOperator: true } })],
      stt: async () => stt.opened,
      transcript: () => undefined,
    });
    await connect(h);
    await vi.waitFor(() =>
      expect(h.audits.map(([type]) => type)).toContain('human.transcribe.failed'),
    );
    h.link.audio(new Uint8Array(160).fill(3));
    expect(h.rooms.seat().sent).toHaveLength(1);
    expect(h.controller.attached?.role).toBe('human');
  });
});
