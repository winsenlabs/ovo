'use client';
import { AudioPlayer } from '../../../components/ui/audio-player';
import { Conversation } from '../../../components/ui/conversation';
import { SectionCard } from '../../../components/ui/section-card';
import { Timeline } from '../../../components/ui/timeline';

/** Timeline, conversation and the audio player. */
export function MediaSection() {
  return (
    <>
      <SectionCard title="Timeline">
        <Timeline
          events={[
            { id: '1', type: 'call.started', atMs: 0, tone: 'info', summary: 'Call started' },
            {
              id: '2',
              type: 'turn.completed',
              atMs: 1200,
              tone: 'ok',
              summary: 'Turn completed',
              payload: { ok: true },
            },
            {
              id: '3',
              type: 'call.failed',
              atMs: 4300,
              tone: 'danger',
              summary: 'Call failed: timeout',
            },
          ]}
        />
      </SectionCard>

      <SectionCard title="Conversation + audio player">
        <AudioPlayer
          src=""
          durationMs={60000}
          segments={[
            { startMs: 0, endMs: 40000, available: true },
            { startMs: 40000, endMs: 60000, available: false },
          ]}
          markers={[{ atMs: 12000, label: 'Turn 2' }]}
        />
        <Conversation
          lines={[
            {
              id: 'a',
              speaker: 'agent',
              atMs: 0,
              text: 'Hi, this is Sunrise Finance calling about your EMI.',
            },
            { id: 'b', speaker: 'caller', atMs: 4000, text: 'Yes, go ahead.' },
            {
              id: 'c',
              speaker: 'agent',
              atMs: 6000,
              text: 'Generated but not played',
              played: false,
            },
          ]}
        />
      </SectionCard>
    </>
  );
}
