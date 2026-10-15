'use client';
import { useState } from 'react';
import { Conversation } from '../../components/ui/conversation';
import { EmptyStateV2 } from '../../components/ui/feedback-v2';
import { IdChip, KeyValueGrid } from '../../components/ui/section-card';
import { Tabs, tabsFrom } from '../../components/ui/tabs';
import { PhoneNumber } from '../../components/ui/display';
import { shortenId } from '../../lib/format';
import { humaniseEnum } from '../../lib/status';
import {
  handoverConversation,
  liveConversation,
  type CaptionLine,
} from '../../lib/derive/captions';
import type { TicketContext } from '../../lib/types/desk';

const TABS = tabsFrom({ transcript: 'Transcript', summary: 'Summary', details: 'Details' });

function Transcript({
  context,
  captions,
  startedAt,
}: {
  context?: TicketContext;
  captions: readonly CaptionLine[];
  startedAt: number;
}) {
  const before = handoverConversation(context?.transcript ?? []);
  return (
    <div className="desk-transcript">
      {before.length > 0 && (
        <>
          <h3 className="desk-divider">Before the transfer</h3>
          <Conversation lines={before} />
        </>
      )}
      <h3 className="desk-divider">On this call</h3>
      {captions.length ? (
        <Conversation lines={liveConversation(captions, startedAt)} liveInterim />
      ) : (
        <EmptyStateV2 title="No captions yet">
          Captions appear here as the caller and you speak, when this queue transcribes calls.
        </EmptyStateV2>
      )}
    </div>
  );
}

function Summary({ context }: { context?: TicketContext }) {
  if (!context) return <p className="muted">Loading the handover…</p>;
  return (
    <div className="desk-summary">
      <p>
        <strong>{context.brief}</strong>
      </p>
      {context.summary ? (
        <>
          <p className="muted">Written by the AI agent that transferred the call</p>
          {/* Caller-derived text: rendered as text, never as markup. */}
          <p className="desk-summary-text">{context.summary}</p>
        </>
      ) : (
        <p className="muted">The transferring agent did not leave a summary.</p>
      )}
      {context.reason && <p className="muted">Reason given: {context.reason}</p>}
    </div>
  );
}

function Details({ context }: { context?: TicketContext }) {
  if (!context) return <p className="muted">Loading the handover…</p>;
  const variables = Object.entries(context.variables);
  return (
    <KeyValueGrid
      items={[
        { label: 'Route', value: context.routePath.map(humaniseEnum).join(' › ') || undefined },
        { label: 'Language', value: context.language },
        { label: 'Intent', value: context.intent ? humaniseEnum(context.intent) : undefined },
        {
          label: 'Caller',
          value: context.caller.number && <PhoneNumber value={context.caller.number} />,
        },
        {
          label: 'Dialled number',
          value: context.caller.calledNumber && <PhoneNumber value={context.caller.calledNumber} />,
        },
        {
          label: 'Variables',
          value: variables.length
            ? variables.map(([key, value]) => `${humaniseEnum(key)}: ${String(value)}`).join(' · ')
            : undefined,
        },
        {
          label: 'Call',
          value: (
            <IdChip
              id={context.callId}
              short={shortenId(context.callId)}
              href={`/calls/${encodeURIComponent(context.callId)}`}
            />
          ),
        },
      ]}
    />
  );
}

/** Transcript, Summary and Details of the active call. */
export function CallTabs({
  context,
  captions,
  startedAt,
}: {
  context?: TicketContext;
  captions: readonly CaptionLine[];
  startedAt: number;
}) {
  const [tab, setTab] = useState('transcript');
  return (
    <div className="desk-tabs">
      <Tabs items={TABS} current={tab} onSelect={setTab} panelId="desk-panel" />
      <div role="tabpanel" id="desk-panel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'transcript' && (
          <Transcript context={context} captions={captions} startedAt={startedAt} />
        )}
        {tab === 'summary' && <Summary context={context} />}
        {tab === 'details' && <Details context={context} />}
      </div>
    </div>
  );
}
