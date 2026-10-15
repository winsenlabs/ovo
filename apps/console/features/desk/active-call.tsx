'use client';
import { useEffect, useRef, useState } from 'react';
import { PhoneNumber } from '../../components/ui/display';
import { InlineAlert } from '../../components/ui/feedback-v2';
import { SectionCard } from '../../components/ui/section-card';
import { Select } from '../../components/ui/inputs';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import type { ActiveCallState, useActiveCall } from '../../lib/data/use-active-call';
import { formatClock } from '../../lib/derive/desk';
import { humaniseEnum } from '../../lib/status';
import type { DeskQueueInfo } from '../../lib/types/desk';
import { AudioControls } from './audio-controls';
import { CallTabs } from './call-tabs';
import { WrapUpForm } from './wrap-up-form';

type CallApi = ReturnType<typeof useActiveCall>;

function connectionText(call: ActiveCallState): {
  text: string;
  tone: 'ok' | 'info' | 'warn' | 'danger';
} {
  if (call.phase === 'ended') return { text: 'Call ended', tone: 'warn' };
  if (call.connection === 'reconnecting') return { text: 'Reconnecting…', tone: 'warn' };
  if (call.connection === 'disconnected') return { text: 'Disconnected', tone: 'danger' };
  if (call.connection !== 'connected') return { text: 'Connecting…', tone: 'info' };
  return call.callerPresent
    ? { text: 'Connected', tone: 'ok' }
    : { text: 'Connecting caller…', tone: 'info' };
}

/** Send-back menu: the queue's allowed targets, a confirm, and a stated reason when there are none. */
function SendBack({
  targets,
  onSend,
}: {
  targets: DeskQueueInfo['returnTargets'];
  onSend: (key: string, label: string) => void;
}) {
  const [target, setTarget] = useState('');
  if (!targets.length)
    return (
      <p className="muted">
        <button type="button" className="button" disabled aria-describedby="desk-sendback-why">
          Send back to AI agent
        </button>{' '}
        <small id="desk-sendback-why">This queue has no AI agent to send callers back to.</small>
      </p>
    );
  const label = targets.find((item) => item.key === target)?.label ?? '';
  return (
    <div className="desk-sendback">
      <label htmlFor="desk-sendback-target" className="sr-only">
        Send back to
      </label>
      <Select
        id="desk-sendback-target"
        value={target}
        placeholder="Send back to AI agent…"
        options={targets.map((item) => ({ value: item.key, label: item.label }))}
        onChange={setTarget}
      />
      <button
        type="button"
        className="button"
        disabled={!target}
        onClick={() => onSend(target, label)}
      >
        Send back
      </button>
    </div>
  );
}

/** The call in progress, or just ended and awaiting wrap-up. */
export function ActiveCall({
  call,
  queue,
  api,
  now,
  onHangUp,
  onSendBack,
}: {
  call: ActiveCallState;
  queue: DeskQueueInfo | undefined;
  api: CallApi;
  now: number;
  /** Both end the call for the caller's current party, so the desk confirms them. */
  onHangUp: () => void;
  onSendBack: (key: string, label: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const status = connectionText(call);
  const ended = call.phase === 'ended';
  const number = call.context?.caller.number;
  const targets = queue?.returnTargets ?? call.context?.returnTargets ?? [];
  return (
    <SectionCard
      title="Active call"
      padding="data"
      actions={<StatusBadgeV2 tone={status.tone} label={status.text} />}
    >
      <h3 ref={heading} tabIndex={-1} className="desk-caller">
        {number ? <PhoneNumber value={number} /> : 'Caller'}
        {call.context?.language && <span className="ds-chip">{call.context.language}</span>}
        <span className="mono desk-timer" aria-live="off">
          {formatClock(now - call.startedAt)}
        </span>
      </h3>
      {call.roomError && (
        <InlineAlert tone="danger" onRetry={() => void api.reconnect()}>
          {call.roomError}
        </InlineAlert>
      )}
      {!ended && call.connection === 'reconnecting' && (
        <InlineAlert tone="warn">Reconnecting to the call audio…</InlineAlert>
      )}
      {ended ? (
        <div className="desk-ended">
          <p>This call has ended ({humaniseEnum(call.ended?.reason).toLowerCase()}).</p>
          <WrapUpForm
            queue={queue}
            done={call.ended?.wrapUpDone ?? false}
            onSubmit={api.wrapUp}
            onSkip={() => void api.dismiss()}
          />
          <button
            type="button"
            className="button primary"
            disabled={(queue?.wrapUp.required ?? false) && !call.ended?.wrapUpDone}
            onClick={() => void api.dismiss()}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <AudioControls
            muted={call.muted}
            volume={call.volume}
            levels={api.levels}
            active={call.connection === 'connected'}
            onMute={(muted) => void api.setMuted(muted)}
            onVolume={api.setVolume}
            onInput={(id) => void api.setInputDevice(id)}
            onOutput={(id) => void api.setOutputDevice(id)}
          />
          <div className="desk-call-actions">
            <button type="button" className="button danger" onClick={onHangUp}>
              Hang up
            </button>
            <SendBack targets={targets} onSend={onSendBack} />
          </div>
        </>
      )}
      <CallTabs context={call.context} captions={call.captions} startedAt={call.startedAt} />
    </SectionCard>
  );
}
